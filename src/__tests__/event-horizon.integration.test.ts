// Recurring events against the rolling horizon: a write's refusal names the row that blocks it, a
// write never lands where a series on the same resource is not stored, the roll never lets stuck
// series starve a healthy one, and a full 367-day window can be proven complete. Each test uses a
// tenant of its own, so a roll or maintenance pass sees only its rows. Skipped without DATABASE_URL.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maintainSlotlockTenant } from '../maintenance.js';
import {
  SLOTLOCK_INTERNAL_EVENT_OWNER_REF,
  type SlotlockStore,
  calendarEventRollingHorizon,
  createSlotlockStore,
  legacyPutCommandHash,
} from '../store.js';
import { normalizeCalendarEventContent } from '../sync.js';
import type { CalendarHorizonRollCursor } from '../types.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const d = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe.skipIf(!url)('recurring events and the rolling horizon (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenants: string[] = [];

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    if (tenants.length > 0) {
      await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.reservation_tombstones WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref IN ${sql(tenants)}`;
    }
    await sql.end();
  });

  async function freshTenant() {
    const tenantRef = `horizon-${crypto.randomUUID()}`;
    tenants.push(tenantRef);
    const resource = await store.createResource({
      tenantRef,
      externalRef: `vehicle-${crypto.randomUUID()}`,
      timezone: 'UTC',
    });
    return { tenantRef, resourceId: resource.id };
  }

  it('a refused series update names the booking in the way, not its own old occurrence', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const externalRef = `standup-${crypto.randomUUID()}`;
    const series = {
      tenantRef,
      externalRef,
      resourceId,
      timezone: 'UTC',
      summary: 'Weekly check',
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=4' },
      materializationWindow: { start: d('2027-05-03T00:00:00Z'), end: d('2027-06-03T00:00:00Z') },
    };
    const put = await store.putCalendarEvent({
      ...series,
      idempotencyKey: `create-${crypto.randomUUID()}`,
      expectedRevision: 0,
      start: d('2027-05-03T09:00:00Z'),
      end: d('2027-05-03T10:00:00Z'),
    });
    expect(put.ok).toBe(true);
    const booking = await store.createExternalReservation({
      tenantRef,
      externalRef: `booking-${crypto.randomUUID()}`,
      resourceId,
      start: d('2027-05-17T10:00:00Z'),
      end: d('2027-05-17T10:30:00Z'),
      bufferAfterMs: 0,
      revision: 1,
    });
    if (!booking.ok) throw new Error(booking.code);
    const moved = await store.putCalendarEvent({
      ...series,
      idempotencyKey: `move-${crypto.randomUUID()}`,
      expectedRevision: 1,
      start: d('2027-05-03T09:30:00Z'),
      end: d('2027-05-03T10:30:00Z'),
    });
    expect(moved).toEqual({
      ok: false,
      code: 'overlap',
      conflictingReservationId: booking.reservation.id,
    });
  });

  it('replays a recurring create retried after UTC midnight, when the horizon has moved a day', async () => {
    // The agent backend writes a series over calendarEventRollingHorizon(), which starts at the
    // current UTC midnight. The window was in the command's hash, so a retry with the same key and
    // arguments the next day was refused as idempotency_conflict instead of replayed.
    const { tenantRef, resourceId } = await freshTenant();
    const today = calendarEventRollingHorizon(new Date('2027-05-03T23:59:00Z'));
    const tomorrow = calendarEventRollingHorizon(new Date('2027-05-04T00:01:00Z'));
    expect(tomorrow.start.getTime() - today.start.getTime()).toBe(DAY);
    const command = {
      tenantRef,
      externalRef: `weekly-${crypto.randomUUID()}`,
      idempotencyKey: `create-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: d('2027-05-05T09:00:00Z'),
      end: d('2027-05-05T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Weekly service',
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=10' },
    };
    const first = await store.putCalendarEvent({ ...command, materializationWindow: today });
    if (!first.ok) throw new Error(first.code);
    const retried = await store.putCalendarEvent({ ...command, materializationWindow: tomorrow });
    expect(retried).toMatchObject({ ok: true, idempotent: true, revision: first.revision });
    if (!retried.ok) throw new Error(retried.code);
    expect(retried.eventId).toBe(first.eventId);
    // A different request under the same key is still refused.
    const changed = await store.putCalendarEvent({
      ...command,
      summary: 'Another service',
      materializationWindow: tomorrow,
    });
    expect(changed).toEqual({ ok: false, code: 'idempotency_conflict' });
  });

  it('still replays a one-off event stored by 0.3.0, with the window in its hash', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const command = {
      tenantRef,
      externalRef: `booking-${crypto.randomUUID()}`,
      idempotencyKey: `create-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: d('2027-05-06T09:00:00Z'),
      end: d('2027-05-06T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Pickup',
    };
    const first = await store.putCalendarEvent(command);
    if (!first.ok) throw new Error(first.code);
    // As 0.3.0 stored it: the one-off's window is its own span.
    const legacy = legacyPutCommandHash({
      command,
      ownerRef: SLOTLOCK_INTERNAL_EVENT_OWNER_REF,
      event: normalizeCalendarEventContent(command),
      window: { start: command.start, end: command.end },
    });
    await sql`UPDATE slotlock.calendar_event_commands SET payload_hash = ${legacy}
              WHERE tenant_ref = ${tenantRef} AND idempotency_key = ${command.idempotencyKey}`;
    await expect(store.putCalendarEvent(command)).resolves.toMatchObject({
      ok: true,
      idempotent: true,
      eventId: first.eventId,
    });
  });

  it('proves a full 367-day window from now complete once a series is rolled to the horizon', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const horizon = calendarEventRollingHorizon();
    const start = new Date(horizon.start.getTime() + DAY + 9 * HOUR);
    const put = await store.putCalendarEvent({
      tenantRef,
      externalRef: `weekly-${crypto.randomUUID()}`,
      idempotencyKey: `create-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start,
      end: new Date(start.getTime() + HOUR),
      timezone: 'UTC',
      summary: 'Weekly service',
      recurrence: { rrule: 'FREQ=WEEKLY' },
      materializationWindow: horizon,
    });
    expect(put.ok).toBe(true);
    await maintainSlotlockTenant(store, tenantRef);
    // The audit's repro: [now, now + 367 days) was partial, so a search of the advertised maximum
    // found no certain slot.
    const now = new Date();
    const freeBusy = await store.getFreeBusy({
      tenantRef,
      resourceId,
      window: { start: now, end: new Date(now.getTime() + 367 * DAY) },
    });
    expect(freeBusy.coverage).toEqual({ state: 'complete', missingSources: [] });
    // At the latest moment of the UTC day too.
    const lastMoment = new Date(horizon.start.getTime() + 2 * DAY - 1);
    const atDayEnd = await store.getFreeBusy({
      tenantRef,
      resourceId,
      window: { start: lastMoment, end: new Date(lastMoment.getTime() + 367 * DAY) },
    });
    expect(atDayEnd.coverage.state).toBe('complete');
  });

  /** A daily 09:00-10:00 UTC series on the resource, stored for `window`. */
  async function dailySeries(tenantRef: string, resourceId: string, window: { start: Date; end: Date }) {
    const start = new Date(window.start.getTime() + 9 * HOUR);
    const put = await store.putCalendarEvent({
      tenantRef,
      externalRef: `daily-${crypto.randomUUID()}`,
      idempotencyKey: `create-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start,
      end: new Date(start.getTime() + HOUR),
      timezone: 'UTC',
      summary: 'Daily inspection',
      recurrence: { rrule: 'FREQ=DAILY' },
      materializationWindow: window,
    });
    if (!put.ok) throw new Error(`series fixture failed: ${put.code}`);
    return put.eventId;
  }

  async function storedWindow(eventId: string) {
    const [row] = await sql<{ start: Date; end: Date }[]>`
      SELECT materialized_starts_at AS start, materialized_ends_at AS end
        FROM slotlock.calendar_events WHERE id = ${eventId}`;
    return row;
  }

  describe('a write never lands where a series on its resource is not stored', () => {
    it('refuses a booking, a hold or an event past the horizon on a resource with a series', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const horizon = calendarEventRollingHorizon();
      await dailySeries(tenantRef, resourceId, horizon);
      // The audit's repro: the series' 09:00 occurrence three days past where it is stored.
      const past = new Date(horizon.end.getTime() + 3 * DAY + 9 * HOUR);
      const window = { start: past, end: new Date(past.getTime() + HOUR) };
      await expect(
        store.createExternalReservation({
          tenantRef,
          externalRef: `booking-${crypto.randomUUID()}`,
          resourceId,
          ...window,
          bufferAfterMs: 0,
          revision: 1,
        }),
      ).resolves.toEqual({ ok: false, code: 'recurrence_not_materialized' });
      await expect(
        store.acquireHold({ resourceId, ...window, ttlMs: 60_000 }),
      ).resolves.toEqual({ ok: false, code: 'recurrence_not_materialized' });
      await expect(store.createReservation({ resourceId, ...window })).resolves.toEqual({
        ok: false,
        code: 'recurrence_not_materialized',
      });
      await expect(
        store.putCalendarEvent({
          tenantRef,
          externalRef: `handover-${crypto.randomUUID()}`,
          idempotencyKey: `create-${crypto.randomUUID()}`,
          expectedRevision: 0,
          resourceId,
          ...window,
          timezone: 'UTC',
          summary: 'Handover',
        }),
      ).resolves.toEqual({ ok: false, code: 'recurrence_not_materialized' });
      // A move of a booking onto that time is refused too, and leaves the booking where it was.
      const ref = `booking-${crypto.randomUUID()}`;
      const booked = await store.createExternalReservation({
        tenantRef,
        externalRef: ref,
        resourceId,
        start: new Date(horizon.start.getTime() + 2 * DAY + 12 * HOUR),
        end: new Date(horizon.start.getTime() + 2 * DAY + 13 * HOUR),
        bufferAfterMs: 0,
        revision: 1,
      });
      expect(booked.ok).toBe(true);
      await expect(
        store.rescheduleExternalReservation({
          tenantRef,
          externalRef: ref,
          resourceId,
          ...window,
          bufferAfterMs: 0,
          revision: 2,
        }),
      ).resolves.toEqual({ ok: false, code: 'recurrence_not_materialized' });
      // A resource with no series books that far ahead as before.
      const other = await store.createResource({
        tenantRef,
        externalRef: `vehicle-${crypto.randomUUID()}`,
        timezone: 'UTC',
      });
      await expect(
        store.createExternalReservation({
          tenantRef,
          externalRef: `booking-${crypto.randomUUID()}`,
          resourceId: other.id,
          ...window,
          bufferAfterMs: 0,
          revision: 1,
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('lets an event past the horizon be renamed, but not moved, once a series reaches past it', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const horizon = calendarEventRollingHorizon();
      const past = new Date(horizon.end.getTime() + 3 * DAY + 12 * HOUR);
      const handover = {
        tenantRef,
        externalRef: `handover-${crypto.randomUUID()}`,
        resourceId,
        timezone: 'UTC',
      };
      // Booked before the series existed, so nothing refused it.
      const made = await store.putCalendarEvent({
        ...handover,
        idempotencyKey: `create-${crypto.randomUUID()}`,
        expectedRevision: 0,
        start: past,
        end: new Date(past.getTime() + HOUR),
        summary: 'Handover',
      });
      expect(made).toMatchObject({ ok: true, revision: 1 });
      await dailySeries(tenantRef, resourceId, horizon);
      // The rename occupies no time the event did not hold already.
      await expect(
        store.putCalendarEvent({
          ...handover,
          idempotencyKey: `rename-${crypto.randomUUID()}`,
          expectedRevision: 1,
          start: past,
          end: new Date(past.getTime() + HOUR),
          summary: 'Handover, keys at the desk',
        }),
      ).resolves.toMatchObject({ ok: true, revision: 2 });
      await expect(
        store.putCalendarEvent({
          ...handover,
          idempotencyKey: `move-${crypto.randomUUID()}`,
          expectedRevision: 2,
          start: new Date(past.getTime() - 3 * HOUR),
          end: new Date(past.getTime() - 2 * HOUR),
          summary: 'Handover, keys at the desk',
        }),
      ).resolves.toEqual({ ok: false, code: 'recurrence_not_materialized' });
    });

    it('lets a long write past the horizon through when every series on the resource has ended before it', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const horizon = calendarEventRollingHorizon();
      const earlier = new Date(horizon.start.getTime() - 300 * DAY + 9 * HOUR);
      const until = (date: Date) => `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
      const series = (
        rrule: string,
        start: Date,
        exceptions?: { recurrenceId: Date; start: Date; end: Date }[],
      ) =>
        store.putCalendarEvent({
          tenantRef,
          externalRef: `rota-${crypto.randomUUID()}`,
          idempotencyKey: `create-${crypto.randomUUID()}`,
          expectedRevision: 0,
          resourceId,
          start,
          end: new Date(start.getTime() + HOUR),
          timezone: 'UTC',
          summary: 'Old rota',
          recurrence: { rrule, ...(exceptions ? { exceptions } : {}) },
          materializationWindow: horizon,
        });
      // Before, one series that ended long ago refused every write ending past the horizon on its
      // resource, a lease included.
      expect((await series('FREQ=DAILY;COUNT=3', earlier)).ok).toBe(true);
      expect(
        (
          await series(
            `FREQ=WEEKLY;UNTIL=${until(new Date(earlier.getTime() + 20 * DAY))}`,
            new Date(earlier.getTime() + 2 * HOUR),
          )
        ).ok,
      ).toBe(true);
      const leaseStart = new Date(horizon.start.getTime() + 30 * DAY);
      const lease = {
        tenantRef,
        resourceId,
        start: leaseStart,
        end: new Date(leaseStart.getTime() + 730 * DAY),
        bufferAfterMs: 0,
        revision: 1,
      };
      await expect(
        store.createExternalReservation({ ...lease, externalRef: `lease-${crypto.randomUUID()}` }),
      ).resolves.toMatchObject({ ok: true });

      // A finished series whose occurrence was moved past the horizon, into a lease, still refuses
      // it, as does one whose COUNT runs past it.
      const moved = await freshTenant();
      const movedTo = new Date(horizon.end.getTime() + 40 * DAY + 9 * HOUR);
      expect(
        (
          await store.putCalendarEvent({
            tenantRef: moved.tenantRef,
            externalRef: `rota-${crypto.randomUUID()}`,
            idempotencyKey: `create-${crypto.randomUUID()}`,
            expectedRevision: 0,
            resourceId: moved.resourceId,
            start: earlier,
            end: new Date(earlier.getTime() + HOUR),
            timezone: 'UTC',
            summary: 'Moved rota',
            recurrence: {
              rrule: 'FREQ=DAILY;COUNT=3',
              exceptions: [
                {
                  recurrenceId: new Date(earlier.getTime() + DAY),
                  start: movedTo,
                  end: new Date(movedTo.getTime() + HOUR),
                },
              ],
            },
            materializationWindow: horizon,
          })
        ).ok,
      ).toBe(true);
      await expect(
        store.createExternalReservation({
          ...lease,
          tenantRef: moved.tenantRef,
          resourceId: moved.resourceId,
          externalRef: `lease-${crypto.randomUUID()}`,
        }),
      ).resolves.toEqual({ ok: false, code: 'recurrence_not_materialized' });
      const counted = await freshTenant();
      expect(
        (
          await store.putCalendarEvent({
            tenantRef: counted.tenantRef,
            externalRef: `rota-${crypto.randomUUID()}`,
            idempotencyKey: `create-${crypto.randomUUID()}`,
            expectedRevision: 0,
            resourceId: counted.resourceId,
            start: earlier,
            end: new Date(earlier.getTime() + HOUR),
            timezone: 'UTC',
            summary: 'Long rota',
            recurrence: { rrule: 'FREQ=WEEKLY;COUNT=200' },
            materializationWindow: horizon,
          })
        ).ok,
      ).toBe(true);
      await expect(
        store.createExternalReservation({
          ...lease,
          tenantRef: counted.tenantRef,
          resourceId: counted.resourceId,
          start: new Date(horizon.end.getTime() + DAY),
          end: new Date(horizon.end.getTime() + 60 * DAY),
          externalRef: `lease-${crypto.randomUUID()}`,
        }),
      ).resolves.toEqual({ ok: false, code: 'recurrence_not_materialized' });
    });

    it('works out when a series stored before 0.3 ends before a long write, and refuses one that goes on', async () => {
      const horizon = calendarEventRollingHorizon();
      const earlier = new Date(horizon.start.getTime() - 300 * DAY + 9 * HOUR);
      const leaseStart = new Date(horizon.start.getTime() + 30 * DAY);
      const stored = async (rrule: string) => {
        const { tenantRef, resourceId } = await freshTenant();
        const put = await store.putCalendarEvent({
          tenantRef,
          externalRef: `rota-${crypto.randomUUID()}`,
          idempotencyKey: `create-${crypto.randomUUID()}`,
          expectedRevision: 0,
          resourceId,
          start: earlier,
          end: new Date(earlier.getTime() + HOUR),
          timezone: 'UTC',
          summary: 'Old rota',
          recurrence: { rrule },
          materializationWindow: horizon,
        });
        if (!put.ok) throw new Error(put.code);
        // As 0.2 left it: stored to the horizon, with no end worked out.
        await sql`
          UPDATE slotlock.calendar_events SET recurrence_ends_by = NULL
           WHERE id = ${put.eventId} AND tenant_ref = ${tenantRef}`;
        const lease = await store.createExternalReservation({
          tenantRef,
          externalRef: `lease-${crypto.randomUUID()}`,
          resourceId,
          start: leaseStart,
          end: new Date(leaseStart.getTime() + 730 * DAY),
          bufferAfterMs: 0,
          revision: 1,
        });
        const [row] = await sql<{ ends_by: string | null }[]>`
          SELECT recurrence_ends_by::text AS ends_by FROM slotlock.calendar_events
           WHERE id = ${put.eventId}`;
        return { lease, endsBy: row?.ends_by ?? null };
      };
      // Before, it counted as going on until its next roll, and refused the lease.
      const ended = await stored('FREQ=DAILY;COUNT=3');
      expect(ended.lease).toMatchObject({ ok: true });
      expect(ended.endsBy).not.toBeNull();
      const goesOn = await stored('FREQ=WEEKLY');
      expect(goesOn.lease).toEqual({ ok: false, code: 'recurrence_not_materialized' });
      expect(goesOn.endsBy).toBe('infinity');
    });

    it('lets a long write through just after a series it reaches ends, once every occurrence is stored', async () => {
      const horizon = calendarEventRollingHorizon();
      const until = (date: Date) => `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
      const twoDays = async (stored: { start: Date; end: Date }) => {
        const { tenantRef, resourceId } = await freshTenant();
        const first = new Date(horizon.start.getTime() + 2 * DAY + 9 * HOUR);
        const put = await store.putCalendarEvent({
          tenantRef,
          externalRef: `rota-${crypto.randomUUID()}`,
          idempotencyKey: `create-${crypto.randomUUID()}`,
          expectedRevision: 0,
          resourceId,
          start: first,
          end: new Date(first.getTime() + HOUR),
          timezone: 'UTC',
          summary: 'Two-day rota',
          recurrence: { rrule: `FREQ=DAILY;UNTIL=${until(new Date(first.getTime() + DAY))}` },
          materializationWindow: stored,
        });
        if (!put.ok) throw new Error(put.code);
        const lastEnd = new Date(first.getTime() + DAY + HOUR);
        const lease = (start: Date) =>
          store.createExternalReservation({
            tenantRef,
            externalRef: `lease-${crypto.randomUUID()}`,
            resourceId,
            start,
            end: new Date(start.getTime() + 400 * DAY),
            bufferAfterMs: 0,
            revision: 1,
          });
        return { eventId: put.eventId, lastEnd, lease };
      };
      // Stored to the horizon. Before, a lease starting within three days of UNTIL was refused,
      // though nothing of the series is left to store.
      const rolled = await twoDays(horizon);
      await expect(rolled.lease(new Date(rolled.lastEnd.getTime() + HOUR))).resolves.toMatchObject({
        ok: true,
      });
      // One overlapping the last occurrence meets it.
      const overlapping = await twoDays(horizon);
      await expect(
        overlapping.lease(new Date(overlapping.lastEnd.getTime() - 30 * 60_000)),
      ).resolves.toMatchObject({ ok: false, code: 'overlap' });
      // Stored for its first day only, as if maintenance had stopped: it is caught up first.
      const behind = await twoDays({
        start: horizon.start,
        end: new Date(horizon.start.getTime() + 3 * DAY),
      });
      await expect(
        behind.lease(new Date(behind.lastEnd.getTime() - 30 * 60_000)),
      ).resolves.toMatchObject({ ok: false, code: 'overlap' });
      await expect(behind.lease(new Date(behind.lastEnd.getTime() + HOUR))).resolves.toMatchObject({
        ok: true,
      });
      expect(await storedWindow(behind.eventId)).toEqual(horizon);
    });

    it('extends a series not yet rolled that far before it books, so the overlap is caught', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const horizon = calendarEventRollingHorizon();
      // Stored for the horizon's first 30 days only, as if maintenance had stopped.
      const eventId = await dailySeries(tenantRef, resourceId, {
        start: horizon.start,
        end: new Date(horizon.start.getTime() + 30 * DAY),
      });
      const day = new Date(horizon.start.getTime() + 60 * DAY);
      const onOccurrence = await store.createExternalReservation({
        tenantRef,
        externalRef: `booking-${crypto.randomUUID()}`,
        resourceId,
        start: new Date(day.getTime() + 9 * HOUR + 30 * 60_000),
        end: new Date(day.getTime() + 10 * HOUR + 30 * 60_000),
        bufferAfterMs: 0,
        revision: 1,
      });
      expect(onOccurrence).toMatchObject({ ok: false, code: 'overlap' });
      if (onOccurrence.ok || onOccurrence.code !== 'overlap') return;
      const [blocker] = await sql<{ calendar_event_id: string | null }[]>`
        SELECT calendar_event_id FROM slotlock.reservations
         WHERE id = ${onOccurrence.conflictingReservationId as string}`;
      expect(blocker?.calendar_event_id).toBe(eventId);
      // Beside the occurrence it books, and the series is now stored to the horizon.
      const beside = await store.createExternalReservation({
        tenantRef,
        externalRef: `booking-${crypto.randomUUID()}`,
        resourceId,
        start: new Date(day.getTime() + 11 * HOUR),
        end: new Date(day.getTime() + 12 * HOUR),
        bufferAfterMs: 0,
        revision: 1,
      });
      expect(beside.ok).toBe(true);
      expect(await storedWindow(eventId)).toEqual(horizon);
    });

    it('racing writes past a stale series end extend it once and never overlap it or each other', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const horizon = calendarEventRollingHorizon();
      const eventId = await dailySeries(tenantRef, resourceId, {
        start: horizon.start,
        end: new Date(horizon.start.getTime() + 10 * DAY),
      });
      const day = new Date(horizon.start.getTime() + 40 * DAY);
      // Twelve writers over eight hour-long slots two hours apart from 08:30: the first meets the
      // 09:00 occurrence, and four slots have two writers each.
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, (_, index) => {
          const start = new Date(day.getTime() + (8.5 + 2 * (index % 8)) * HOUR);
          return store.createExternalReservation({
            tenantRef,
            externalRef: `racer-${index}-${crypto.randomUUID()}`,
            resourceId,
            start,
            end: new Date(start.getTime() + HOUR),
            bufferAfterMs: 0,
            revision: 1,
          });
        }),
      );
      expect(outcomes.every((outcome) => outcome.ok || outcome.code === 'overlap')).toBe(true);
      expect(await storedWindow(eventId)).toEqual(horizon);
      const [overlaps] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
          FROM slotlock.reservations a
          JOIN slotlock.reservations b
            ON a.resource_id = b.resource_id AND a.id < b.id
           AND tstzrange(a.starts_at, a.occupied_ends_at, '[)') && tstzrange(b.starts_at, b.occupied_ends_at, '[)')
         WHERE a.resource_id = ${resourceId}`;
      expect(overlaps?.count).toBe(0);
      // Each slot booked once: the 08:30 one (which meets 09:00) never.
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(7);
    });
  });

  describe('the roll names what blocks it and lets no blocked series starve a healthy one', () => {
    /**
     * Series a roll cannot extend, each on a resource of its own: stored 30 days, with a booking
     * written as an earlier release let it be, on its occurrence 60 days in.
     */
    async function stuckSeries(tenantRef: string, count: number) {
      const horizon = calendarEventRollingHorizon();
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        const resource = await store.createResource({
          tenantRef,
          externalRef: `stuck-${index}-${crypto.randomUUID()}`,
          timezone: 'UTC',
        });
        const start = new Date(horizon.start.getTime() + 9 * HOUR);
        const put = await store.putCalendarEvent({
          tenantRef,
          externalRef: `monthly-${crypto.randomUUID()}`,
          idempotencyKey: `create-${crypto.randomUUID()}`,
          expectedRevision: 0,
          resourceId: resource.id,
          start,
          end: new Date(start.getTime() + HOUR),
          timezone: 'UTC',
          summary: 'Monthly service',
          recurrence: { rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15' },
          materializationWindow: {
            start: horizon.start,
            end: new Date(horizon.start.getTime() + 30 * DAY),
          },
        });
        if (!put.ok) throw new Error(`series fixture failed: ${put.code}`);
        await sql`
          INSERT INTO slotlock.reservations (
            resource_id, tenant_ref, external_ref, starts_at, ends_at
          )
          SELECT ${resource.id}, ${tenantRef}, ${`legacy-${crypto.randomUUID()}`},
                 day + interval '9 hours', day + interval '10 hours'
            FROM (SELECT date_trunc('month', ${horizon.start}::timestamptz AT TIME ZONE 'UTC')
                           AT TIME ZONE 'UTC' + interval '3 months' AS day) first_of_month`;
        ids.push(put.eventId);
      }
      return ids;
    }

    it('rolls a series across a spring-forward that names one instant twice, and the rest with it', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const horizon = calendarEventRollingHorizon();
      // The next spring-forward in New York the roll reaches: 02:00 and 02:30 become 03:00 and
      // 03:30, which the rule names again.
      const springForward = [d('2027-03-14T07:00:00Z'), d('2028-03-12T07:00:00Z'), d('2029-03-11T07:00:00Z')].find(
        (at) => at.getTime() > horizon.start.getTime() + 2 * DAY,
      ) as Date;
      const night = await store.createResource({
        tenantRef,
        externalRef: `night-${crypto.randomUUID()}`,
        timezone: 'America/New_York',
      });
      const start = new Date(horizon.start.getTime() + 7 * HOUR);
      const put = await store.putCalendarEvent({
        tenantRef,
        externalRef: `night-check-${crypto.randomUUID()}`,
        idempotencyKey: `create-${crypto.randomUUID()}`,
        expectedRevision: 0,
        resourceId: night.id,
        start,
        end: new Date(start.getTime() + 15 * 60_000),
        timezone: 'America/New_York',
        summary: 'Night check',
        transparency: 'transparent',
        recurrence: { rrule: 'FREQ=DAILY;BYHOUR=2,3;BYMINUTE=0,30' },
        materializationWindow: { start: horizon.start, end: new Date(springForward.getTime() - DAY) },
      });
      if (!put.ok) throw new Error(`series fixture failed: ${put.code}`);
      const healthy = await dailySeries(tenantRef, resourceId, {
        start: horizon.start,
        end: new Date(horizon.start.getTime() + 31 * DAY),
      });
      const parking = await store.createResource({
        tenantRef,
        externalRef: `parking-${crypto.randomUUID()}`,
        timezone: 'UTC',
      });
      const hold = await store.acquireHold({
        tenantRef,
        resourceId: parking.id,
        start: new Date(horizon.start.getTime() + 2 * DAY),
        end: new Date(horizon.start.getTime() + 2 * DAY + HOUR),
        ttlMs: 50,
      });
      expect(hold.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // Before, the second 07:00Z hit the occurrences' primary key and every pass threw.
      const pass = await maintainSlotlockTenant(store, tenantRef);
      expect(pass).toMatchObject({ extended: 2, conflicts: 0, refused: 0 });
      expect(await storedWindow(put.eventId)).toEqual(horizon);
      expect(await storedWindow(healthy)).toEqual(horizon);
      const [ids] = await sql<{ instants: number; distinct: number }[]>`
        SELECT count(*)::int AS instants, count(DISTINCT starts_at)::int AS "distinct"
          FROM slotlock.calendar_event_occurrences WHERE event_id = ${put.eventId}`;
      expect(ids?.instants).toBe(ids?.distinct);
      const [held] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM slotlock.reservations
         WHERE resource_id = ${parking.id} AND status = 'held'`;
      expect(held?.count).toBe(0);
    }, 60_000);

    it('puts back a series that fails for any reason and rolls the rest', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const horizon = calendarEventRollingHorizon();
      const window = { start: horizon.start, end: new Date(horizon.start.getTime() + 30 * DAY) };
      const broken = await dailySeries(tenantRef, resourceId, window);
      const other = await store.createResource({
        tenantRef,
        externalRef: `vehicle-${crypto.randomUUID()}`,
        timezone: 'UTC',
      });
      const healthy = await dailySeries(tenantRef, other.id, {
        start: horizon.start,
        end: new Date(horizon.start.getTime() + 31 * DAY),
      });
      // A row no Slotlock would write, as a corrupted or hand-edited one would be.
      await sql`UPDATE slotlock.calendar_events SET recurrence_rule = 'FREQ=FORTNIGHTLY' WHERE id = ${broken}`;
      const roll = await store.withTenant(tenantRef, (tenant) =>
        tenant.rollCalendarEventHorizon({ tenantRef, window: horizon }),
      );
      expect(roll).toMatchObject({ examined: 2, extended: 1, refused: 1, refusedEventIds: [broken] });
      expect(await storedWindow(healthy)).toEqual(horizon);
      expect(await storedWindow(broken)).toEqual(window);
      const [row] = await sql<{ retry: Date | null }[]>`
        SELECT roll_retry_at AS retry FROM slotlock.calendar_events WHERE id = ${broken}`;
      expect(row?.retry).toBeInstanceOf(Date);
    }, 60_000);

    it('names the series a booking blocks, so it can be found and fixed', async () => {
      const { tenantRef } = await freshTenant();
      const [stuck] = await stuckSeries(tenantRef, 1);
      const roll = await store.rollCalendarEventHorizon({
        tenantRef,
        window: calendarEventRollingHorizon(),
      });
      expect(roll).toMatchObject({ examined: 1, extended: 0, conflicts: 1, conflictEventIds: [stuck] });
    });

    it('puts a series it cannot extend behind the others, so the next pass reaches a healthy one', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      await stuckSeries(tenantRef, 101);
      const horizon = calendarEventRollingHorizon();
      // Stored one day longer than the stuck ones: last in the roll's order.
      const healthy = await dailySeries(tenantRef, resourceId, {
        start: horizon.start,
        end: new Date(horizon.start.getTime() + 31 * DAY),
      });
      // One batch of 100 per pass: the first meets 100 stuck series.
      const first = await maintainSlotlockTenant(store, tenantRef, { batches: 1 });
      expect(first).toMatchObject({ extended: 0, conflicts: 100, capped: true });
      // Before, every pass met the same 100 again and the healthy series never rolled.
      const second = await maintainSlotlockTenant(store, tenantRef, { batches: 1 });
      expect(second).toMatchObject({ extended: 1, conflicts: 1 });
      expect(await storedWindow(healthy)).toEqual(horizon);
    }, 60_000);

    it('reaches every series it has not put back before one it has, however many it has put back', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      await stuckSeries(tenantRef, 3);
      const horizon = calendarEventRollingHorizon();
      const healthy = await dailySeries(tenantRef, resourceId, {
        start: horizon.start,
        end: new Date(horizon.start.getTime() + 31 * DAY),
      });
      const roll = (extra: { limit?: number; after?: CalendarHorizonRollCursor } = {}) =>
        store.rollCalendarEventHorizon({ tenantRef, window: horizon, ...extra });
      // Two passes of one series each put two of the three stuck ones back.
      const first = await roll({ limit: 1 });
      const second = await roll({ limit: 1 });
      const putBack = [...first.conflictEventIds, ...second.conflictEventIds];
      expect(putBack).toHaveLength(2);
      // An hour on, both are due again, in the order they were put back.
      await sql`
        UPDATE slotlock.calendar_events
           SET roll_retry_at = roll_retry_at - interval '1 hour 1 second'
         WHERE tenant_ref = ${tenantRef} AND roll_retry_at IS NOT NULL`;
      // Before, they were first in the roll's order again, and the next two passes met only them:
      // with more stuck series than two passes cover, the healthy one never rolled.
      const third = await roll({ limit: 2 });
      expect(third).toMatchObject({ examined: 2, extended: 1, conflicts: 1 });
      expect(putBack).not.toContain(third.conflictEventIds[0]);
      expect(await storedWindow(healthy)).toEqual(horizon);
      // Then the ones put back, longest waiting first, a page at a time.
      const fourth = await roll({ limit: 1 });
      expect(fourth).toMatchObject({ examined: 1, conflictEventIds: [putBack[0]], hasMore: true });
      expect(fourth.next?.rollRetryAt).toBeInstanceOf(Date);
      const fifth = await roll({ limit: 1, ...(fourth.next ? { after: fourth.next } : {}) });
      expect(fifth).toMatchObject({ examined: 1, conflictEventIds: [putBack[1]], hasMore: false });
    }, 60_000);
  });
});
