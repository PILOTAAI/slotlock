// Defects an audit reproduced in the store, each pinned by the scenario that showed it:
// - an event's own occupation could be freed or moved through the external-reservation API;
// - the maintenance roll moved a series' end back to the horizon, deleting what lay past it;
// - a next-available search had no bound on its window;
// - a delayed duplicate of a create was answered as payload drift, not as stale;
// - free/busy called a window complete that began before where a series is stored.
// Skipped without DATABASE_URL.
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maintainSlotlockTenant } from '../maintenance.js';
import {
  SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE,
  type SlotlockStore,
  calendarEventRollingHorizon,
  createSlotlockStore,
} from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const d = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe.skipIf(!url)('store audit fixes (real Postgres)', () => {
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
      await sql`DELETE FROM slotlock.calendar_event_occurrences WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.reservation_tombstones WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.reservations WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref IN ${sql(tenants)}`;
    }
    await sql.end();
  });

  /** A tenant of its own with one UTC resource, so a roll or maintenance pass sees only this test. */
  async function freshTenant() {
    const tenantRef = `audit-${crypto.randomUUID()}`;
    tenants.push(tenantRef);
    const resource = await store.createResource({
      tenantRef,
      externalRef: `vehicle-${crypto.randomUUID()}`,
      timezone: 'UTC',
    });
    return { tenantRef, resourceId: resource.id };
  }

  describe("an event's occupation is not a booking", () => {
    /** A one-off opaque event, with the reference its occupation row carries as the store derives it. */
    async function oneOffEvent(start: Date) {
      const { tenantRef, resourceId } = await freshTenant();
      const end = new Date(start.getTime() + HOUR);
      const put = await store.putCalendarEvent({
        tenantRef,
        externalRef: `handover-${crypto.randomUUID()}`,
        idempotencyKey: `create-${crypto.randomUUID()}`,
        expectedRevision: 0,
        resourceId,
        start,
        end,
        timezone: 'UTC',
        summary: 'Vehicle handover',
      });
      if (!put.ok) throw new Error(`event fixture failed: ${put.code}`);
      const ref = `calendar:${put.eventId}:${createHash('sha256').update(start.toISOString()).digest('hex')}`;
      const [row] = await sql<{ id: string; external_ref: string; source: string }[]>`
        SELECT id, external_ref, source FROM slotlock.reservations
         WHERE calendar_event_id = ${put.eventId}`;
      // The audit computed the reference this way; the store must still derive it so.
      expect(row?.external_ref).toBe(ref);
      return {
        tenantRef,
        resourceId,
        start,
        end,
        put,
        ref,
        rowId: row?.id as string,
        source: row?.source as string,
      };
    }

    async function stillOccupies(event: Awaited<ReturnType<typeof oneOffEvent>>) {
      const freeBusy = await store.getFreeBusy({
        tenantRef: event.tenantRef,
        resourceId: event.resourceId,
        window: {
          start: new Date(event.start.getTime() - DAY),
          end: new Date(event.end.getTime() + DAY),
        },
      });
      expect(freeBusy.busy).toContainEqual({ start: event.start, end: event.end });
      const over = await store.createExternalReservation({
        tenantRef: event.tenantRef,
        externalRef: `booking-${crypto.randomUUID()}`,
        resourceId: event.resourceId,
        start: event.start,
        end: event.end,
        bufferAfterMs: 0,
        revision: 1,
      });
      expect(over).toEqual({ ok: false, code: 'overlap', conflictingReservationId: event.rowId });
    }

    it('cancelling its reference answers as for an unknown booking and frees nothing', async () => {
      const event = await oneOffEvent(d('2027-05-03T09:00:00Z'));
      const cancelled = await store.cancelExternalReservation({
        tenantRef: event.tenantRef,
        externalRef: event.ref,
        revision: 2,
      });
      // Nothing cancelled, and nothing retired: the reference is the event's, not a booking's, so
      // no tombstone is written for it (one was, and nothing ever pruned it).
      expect(cancelled).toEqual({ ok: true, cancelled: false, revision: 2 });
      const [tombstones] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM slotlock.reservation_tombstones
         WHERE tenant_ref = ${event.tenantRef}`;
      expect(tombstones?.count).toBe(0);
      await stillOccupies(event);
      await expect(
        store.getCalendarEvent({
          tenantRef: event.tenantRef,
          externalRef: (await stored(event.put.eventId)).external_ref,
        }),
      ).resolves.toMatchObject({ revision: 1 });
    });

    it('moving its reference is reservation_not_found and leaves the event where it is', async () => {
      const event = await oneOffEvent(d('2027-05-04T09:00:00Z'));
      const moved = await store.rescheduleExternalReservation({
        tenantRef: event.tenantRef,
        externalRef: event.ref,
        resourceId: event.resourceId,
        start: d('2027-05-05T09:00:00Z'),
        end: d('2027-05-05T10:00:00Z'),
        bufferAfterMs: 0,
        revision: 2,
      });
      expect(moved).toEqual({ ok: false, code: 'reservation_not_found' });
      await stillOccupies(event);
    });

    it('creating with its reference and its exact payload does not replay the event as a booking', async () => {
      const event = await oneOffEvent(d('2027-05-06T09:00:00Z'));
      const replay = await store.createExternalReservation({
        tenantRef: event.tenantRef,
        externalRef: event.ref,
        resourceId: event.resourceId,
        start: event.start,
        end: event.end,
        bufferAfterMs: 0,
        revision: 1,
        source: event.source,
      });
      // A new booking over the event's hour, which the event holds.
      expect(replay).toEqual({ ok: false, code: 'overlap', conflictingReservationId: event.rowId });
      await stillOccupies(event);
    });

    it('creating with its reference elsewhere books apart from the event, which can still change', async () => {
      const event = await oneOffEvent(d('2027-05-07T09:00:00Z'));
      const booked = await store.createExternalReservation({
        tenantRef: event.tenantRef,
        externalRef: event.ref,
        resourceId: event.resourceId,
        start: d('2027-05-07T12:00:00Z'),
        end: d('2027-05-07T13:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      });
      expect(booked).toMatchObject({
        ok: true,
        idempotent: false,
        reservation: { externalRef: event.ref, revision: 1 },
      });
      if (!booked.ok) return;
      expect(booked.reservation.id).not.toBe(event.rowId);
      await stillOccupies(event);

      // The event rematerializes beside the booking that shares its occupation's reference.
      const updated = await store.putCalendarEvent({
        tenantRef: event.tenantRef,
        externalRef: (await stored(event.put.eventId)).external_ref,
        idempotencyKey: `update-${crypto.randomUUID()}`,
        expectedRevision: 1,
        resourceId: event.resourceId,
        start: event.start,
        end: event.end,
        timezone: 'UTC',
        summary: 'Vehicle handover, moved desk',
      });
      expect(updated).toMatchObject({ ok: true, revision: 2 });

      // Cancelling the reference cancels the booking, never the event.
      await expect(
        store.cancelExternalReservation({
          tenantRef: event.tenantRef,
          externalRef: event.ref,
          revision: 2,
        }),
      ).resolves.toEqual({ ok: true, cancelled: true, revision: 2 });
      const freeBusy = await store.getFreeBusy({
        tenantRef: event.tenantRef,
        resourceId: event.resourceId,
        window: { start: d('2027-05-07T00:00:00Z'), end: d('2027-05-08T00:00:00Z') },
      });
      expect(freeBusy.busy).toEqual([{ start: event.start, end: event.end }]);
    });

    it('keeps booking references unique in one index that leaves event occupation rows out', async () => {
      const indexes = await sql<{ name: string; definition: string }[]>`
        SELECT indexname AS name, indexdef AS definition FROM pg_indexes
         WHERE schemaname = 'slotlock' AND tablename = 'reservations'
           AND indexname LIKE '%external_ref_key'`;
      expect(indexes).toEqual([
        {
          name: 'slotlock_reservations_booking_external_ref_key',
          definition: expect.stringContaining(
            'WHERE ((tenant_ref IS NOT NULL) AND (external_ref IS NOT NULL) AND (calendar_event_id IS NULL))',
          ),
        },
      ]);
    });

    async function stored(eventId: string) {
      const [row] = await sql<{ external_ref: string }[]>`
        SELECT external_ref FROM slotlock.calendar_events WHERE id = ${eventId}`;
      return row as { external_ref: string };
    }
  });

  describe('the horizon roll never moves a series end backwards', () => {
    /** A weekly Monday 09:00-10:00 UTC series from `first`, stored for `window`. */
    async function weekly(
      tenantRef: string,
      resourceId: string,
      first: Date,
      window: { start: Date; end: Date },
      rrule = 'FREQ=WEEKLY;BYDAY=MO',
    ) {
      const put = await store.putCalendarEvent({
        tenantRef,
        externalRef: `series-${crypto.randomUUID()}`,
        idempotencyKey: `create-${crypto.randomUUID()}`,
        expectedRevision: 0,
        resourceId,
        start: first,
        end: new Date(first.getTime() + HOUR),
        timezone: 'UTC',
        summary: 'Weekly inspection',
        recurrence: { rrule },
        materializationWindow: window,
      });
      if (!put.ok) throw new Error(`series fixture failed: ${put.code}`);
      return put;
    }
    const occurrenceStarts = async (eventId: string) =>
      (
        await sql<{ starts_at: Date }[]>`
          SELECT starts_at FROM slotlock.calendar_event_occurrences
           WHERE event_id = ${eventId} ORDER BY starts_at`
      ).map((row) => row.starts_at.toISOString());
    const materialized = async (eventId: string) => {
      const [row] = await sql<{ start: Date; end: Date }[]>`
        SELECT materialized_starts_at AS start, materialized_ends_at AS end
          FROM slotlock.calendar_events WHERE id = ${eventId}`;
      return row;
    };

    it('leaves a series stored past the horizon end as it is (the audit repro, by the roll)', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const window = { start: d('2027-01-01T00:00:00Z'), end: d('2028-01-01T00:00:00Z') };
      const put = await weekly(tenantRef, resourceId, d('2027-01-04T09:00:00Z'), window);
      expect(put).toMatchObject({ occurrenceCount: 52 });

      // The horizon the roll had on 2026-10-23: 367 days from the day before.
      const horizon = { start: d('2026-10-22T00:00:00Z'), end: d('2027-10-24T00:00:00Z') };
      const rolled = await store.rollCalendarEventHorizon({ tenantRef, window: horizon });
      expect(rolled).toMatchObject({ examined: 0, extended: 0, conflicts: 0, refused: 0 });
      await expect(materialized(put.eventId)).resolves.toEqual(window);
      const starts = await occurrenceStarts(put.eventId);
      expect(starts).toHaveLength(52);
      expect(starts.at(-1)).toBe('2027-12-27T09:00:00.000Z');
      const december = await store.createExternalReservation({
        tenantRef,
        externalRef: `booking-${crypto.randomUUID()}`,
        resourceId,
        start: d('2027-12-27T09:00:00Z'),
        end: d('2027-12-27T10:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      });
      expect(december).toMatchObject({ ok: false, code: 'overlap' });
    });

    it('keeps what lies past the horizon when maintenance runs (the audit repro, by maintenance)', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const horizon = calendarEventRollingHorizon();
      // Stored from ten weeks into the horizon for 365 days: it ends some 68 days past the horizon.
      const start = new Date(horizon.start.getTime() + 70 * DAY);
      const window = { start, end: new Date(start.getTime() + 365 * DAY) };
      const put = await weekly(
        tenantRef,
        resourceId,
        new Date(start.getTime() + 9 * HOUR),
        window,
        'FREQ=WEEKLY',
      );
      if (!put.ok) return;
      const before = await occurrenceStarts(put.eventId);
      const last = d(before.at(-1) as string);
      expect(last.getTime()).toBeGreaterThan(horizon.end.getTime());

      const result = await maintainSlotlockTenant(store, tenantRef);
      expect(result).toMatchObject({ extended: 0, conflicts: 0, refused: 0 });
      await expect(occurrenceStarts(put.eventId)).resolves.toEqual(before);
      await expect(materialized(put.eventId)).resolves.toEqual(window);
      const past = await store.createExternalReservation({
        tenantRef,
        externalRef: `booking-${crypto.randomUUID()}`,
        resourceId,
        start: last,
        end: new Date(last.getTime() + HOUR),
        bufferAfterMs: 0,
        revision: 1,
      });
      expect(past).toMatchObject({ ok: false, code: 'overlap' });
    });

    it('rolls to the horizon start through the stored end when that is later and fits', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const stored = { start: d('2027-01-10T00:00:00Z'), end: d('2027-03-10T00:00:00Z') };
      const put = await weekly(
        tenantRef,
        resourceId,
        d('2027-01-04T09:00:00Z'),
        stored,
        'FREQ=DAILY',
      );
      const horizon = { start: d('2027-01-05T00:00:00Z'), end: d('2027-02-05T00:00:00Z') };
      const rolled = await store.rollCalendarEventHorizon({ tenantRef, window: horizon });
      expect(rolled).toMatchObject({ examined: 1, extended: 1 });
      await expect(materialized(put.eventId)).resolves.toEqual({
        start: horizon.start,
        end: stored.end,
      });
      const starts = await occurrenceStarts(put.eventId);
      // The front the stored window lacked is filled, and nothing after the horizon is lost.
      expect(starts[0]).toBe('2027-01-05T09:00:00.000Z');
      expect(starts.at(-1)).toBe('2027-03-09T09:00:00.000Z');
      expect(starts).toHaveLength(64);
    });

    it('neither rewrites nor counts a series that already covers the horizon', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const stored = { start: d('2027-01-04T00:00:00Z'), end: d('2027-03-01T00:00:00Z') };
      const put = await weekly(
        tenantRef,
        resourceId,
        d('2027-01-04T09:00:00Z'),
        stored,
        'FREQ=DAILY',
      );
      const before = await occurrenceStarts(put.eventId);
      const horizon = { start: d('2027-01-10T00:00:00Z'), end: d('2027-02-01T00:00:00Z') };
      const rolled = await store.rollCalendarEventHorizon({ tenantRef, window: horizon });
      expect(rolled).toMatchObject({ examined: 0, extended: 0 });
      await expect(materialized(put.eventId)).resolves.toEqual(stored);
      await expect(occurrenceStarts(put.eventId)).resolves.toEqual(before);
    });
  });

  describe('next-available searches are bounded like free/busy', () => {
    const rules = [
      {
        rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
        startMinutes: 9 * 60,
        durationMinutes: 60,
      },
    ];

    it('refuses a search window longer than 367 days with invalid_window', async () => {
      const { resourceId } = await freshTenant();
      const start = d('2026-01-01T00:00:00Z');
      await expect(
        store.findNextAvailableFor({
          resourceId,
          rules,
          searchWindow: { start, end: new Date(start.getTime() + 367 * DAY + 1) },
          durationMs: HOUR,
        }),
      ).rejects.toMatchObject({ code: 'invalid_window' });
      const started = performance.now();
      await expect(
        store.findNextAvailableFor({
          resourceId,
          rules: Array.from({ length: 50 }, () => rules[0] as (typeof rules)[number]),
          searchWindow: { start, end: d('2126-01-01T00:00:00Z') },
          durationMs: 2 * HOUR,
        }),
      ).rejects.toMatchObject({ code: 'invalid_window' });
      expect(performance.now() - started).toBeLessThan(1_000);
    });

    it('still searches a window of exactly 367 days', async () => {
      const { resourceId } = await freshTenant();
      const start = d('2026-01-01T00:00:00Z');
      await expect(
        store.findNextAvailableFor({
          resourceId,
          rules,
          searchWindow: { start, end: new Date(start.getTime() + 367 * DAY) },
          durationMs: HOUR,
        }),
      ).resolves.toEqual({ start: d('2026-01-01T09:00:00Z'), end: d('2026-01-01T10:00:00Z') });
    });
  });

  it('answers a delayed create after two moves as stale, like a delayed move', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const externalRef = `booking-${crypto.randomUUID()}`;
    const at = (hour: number, revision: number) => ({
      tenantRef,
      externalRef,
      resourceId,
      start: d(`2027-07-01T${String(hour).padStart(2, '0')}:00:00Z`),
      end: d(`2027-07-01T${String(hour + 1).padStart(2, '0')}:00:00Z`),
      bufferAfterMs: 0,
      revision,
    });
    await expect(store.createExternalReservation(at(9, 1))).resolves.toMatchObject({ ok: true });
    await expect(store.rescheduleExternalReservation(at(10, 2))).resolves.toMatchObject({
      ok: true,
    });
    await expect(store.rescheduleExternalReservation(at(11, 3))).resolves.toMatchObject({
      ok: true,
    });

    await expect(store.createExternalReservation(at(9, 1))).resolves.toEqual({
      ok: false,
      code: 'stale_revision',
    });
    await expect(store.rescheduleExternalReservation(at(10, 2))).resolves.toEqual({
      ok: false,
      code: 'stale_revision',
    });
    await expect(store.rescheduleExternalReservation(at(11, 3))).resolves.toMatchObject({
      ok: true,
      idempotent: true,
    });
    // A different payload at the current revision is still drift.
    await expect(store.rescheduleExternalReservation(at(12, 3))).resolves.toEqual({
      ok: false,
      code: 'idempotency_conflict',
    });
  });

  it('does not call a window complete that begins before where a series is stored', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    // Mondays from 4 January, stored only from February: January's Mondays are not stored.
    const put = await store.putCalendarEvent({
      tenantRef,
      externalRef: `series-${crypto.randomUUID()}`,
      idempotencyKey: `create-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: d('2027-01-04T09:00:00Z'),
      end: d('2027-01-04T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Weekly inspection',
      recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=MO' },
      materializationWindow: { start: d('2027-02-01T00:00:00Z'), end: d('2027-06-01T00:00:00Z') },
    });
    expect(put).toMatchObject({ ok: true });
    const freeBusy = (start: string, end: string) =>
      store.getFreeBusy({ tenantRef, resourceId, window: { start: d(start), end: d(end) } });

    const spanning = await freeBusy('2027-01-01T00:00:00Z', '2027-03-01T00:00:00Z');
    expect(spanning.coverage).toEqual({
      state: 'partial',
      missingSources: [SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE],
    });
    // Nothing of January is stored: not even part of it is known.
    const january = await freeBusy('2027-01-01T00:00:00Z', '2027-01-30T00:00:00Z');
    expect(january.coverage).toEqual({
      state: 'unknown',
      missingSources: [SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE],
    });
    // The canary: inside what is stored, the series is known.
    const march = await freeBusy('2027-03-01T00:00:00Z', '2027-04-01T00:00:00Z');
    expect(march.coverage).toEqual({ state: 'complete', missingSources: [] });
    expect(march.busy).toHaveLength(5);
  });
});
