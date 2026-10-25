// Recurring events against the rolling horizon: a write's refusal names the row that blocks it, a
// write never lands where a series on the same resource is not stored, the roll never lets stuck
// series starve a healthy one, and a full 367-day window can be proven complete. Each test uses a
// tenant of its own, so a roll or maintenance pass sees only its rows. Skipped without DATABASE_URL.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maintainSlotlockTenant } from '../maintenance.js';
import {
  type SlotlockStore,
  calendarEventRollingHorizon,
  createSlotlockStore,
} from '../store.js';

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
      // The verifier's repro: one series that ended long ago refused every write ending past the
      // horizon on its resource, a lease included.
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
  });
});
