// The store keeps, beside each recurring series, a cursor where its last expansion stopped, and the
// roll and later writes resume from it. A daily series written fifteen years ago keeps rolling (from
// its start, the search outgrew the limits after about eleven), and a write to it still works.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { zonedDateTimeToUtc } from '../timezone.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const DAY = 24 * 60 * 60 * 1000;
const d = (iso: string) => new Date(iso);
const london = (date: string, time: string) =>
  zonedDateTimeToUtc(
    {
      year: Number(date.slice(0, 4)),
      month: Number(date.slice(5, 7)),
      day: Number(date.slice(8, 10)),
      hour: Number(time.slice(0, 2)),
      minute: Number(time.slice(3, 5)),
      second: 0,
    },
    'Europe/London',
  );
const windowFrom = (start: Date, days = 367) => ({
  start,
  end: new Date(start.getTime() + days * DAY),
});
const FIRST = d('2011-02-28T00:00:00Z');
const yearWindow = (year: number) => windowFrom(new Date(FIRST.getTime() + year * 365 * DAY));

describe.skipIf(!url)('a stored series resumed from its cursor (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let tenantRef: string;
  let resourceId: string;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    // Twice: the schema is applied on every start.
    await store.applySchema();
    tenantRef = `cursor-tenant-${crypto.randomUUID()}`;
    resourceId = (
      await store.createResource({
        externalRef: `cursor-resource-${crypto.randomUUID()}`,
        tenantRef,
        timezone: 'Europe/London',
      })
    ).id;
  });

  afterAll(async () => {
    await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.calendar_event_occurrences WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.calendar_coverage WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.reservations WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
    await sql.end();
  });

  const handover = (externalRef: string, fields: Record<string, unknown> = {}) => ({
    tenantRef,
    externalRef,
    idempotencyKey: `command-${crypto.randomUUID()}`,
    expectedRevision: 0,
    resourceId,
    start: london('2011-03-01', '09:00'),
    end: london('2011-03-01', '10:00'),
    timezone: 'Europe/London',
    summary: 'Morning handover',
    recurrence: { rrule: 'FREQ=DAILY' } as {
      rrule: string;
      exceptions?: { recurrenceId: Date; cancelled?: boolean }[];
    },
    materializationWindow: yearWindow(0),
    ...fields,
  });
  const stored = async (externalRef: string) => {
    const [row] = await sql<{ id: string; recurrence_cursor: { position: number } | null }[]>`
      SELECT id, recurrence_cursor FROM slotlock.calendar_events
       WHERE tenant_ref = ${tenantRef} AND external_ref = ${externalRef}`;
    return row;
  };
  const occurrences = async (eventId: string) =>
    (
      await sql<{ starts_at: Date }[]>`
        SELECT starts_at FROM slotlock.calendar_event_occurrences
         WHERE event_id = ${eventId} ORDER BY starts_at`
    ).map((row) => row.starts_at);

  const longRunning = `daily-since-2011-${crypto.randomUUID()}`;

  it('rolls a daily series written fifteen years ago, year by year, to today', { timeout: 120_000 }, async () => {
    const written = await store.putCalendarEvent(handover(longRunning));
    expect(written).toMatchObject({ ok: true });
    for (let year = 1; year <= 15; year++) {
      const result = await store.rollCalendarEventHorizon({ tenantRef, window: yearWindow(year) });
      expect(result, `year ${year}`).toMatchObject({ extended: 1, refused: 0, conflicts: 0 });
      // The cursor stands before the window: on the occurrence the next roll resumes after.
      const row = await stored(longRunning);
      expect(row?.recurrence_cursor?.position, `year ${year}`).toBeLessThan(
        yearWindow(year).start.getTime(),
      );
      expect(row?.recurrence_cursor?.position, `year ${year}`).toBeGreaterThan(
        yearWindow(year).start.getTime() - 3 * DAY,
      );
    }
    const row = await stored(longRunning);
    const starts = await occurrences(row?.id as string);
    expect(starts).toHaveLength(367);
    for (const start of starts) {
      expect(start).toEqual(london(start.toISOString().slice(0, 10), '09:00'));
    }
    expect(starts[0]?.getTime()).toBeGreaterThanOrEqual(yearWindow(15).start.getTime());
  });

  it('writes a change to it from the cursor its last roll left', async () => {
    const before = await store.getCalendarEvent({ tenantRef, externalRef: longRunning });
    const cancelled = london('2026-06-01', '09:00');
    const result = await store.putCalendarEvent(
      handover(longRunning, {
        expectedRevision: before?.revision,
        recurrence: {
          rrule: 'FREQ=DAILY',
          exceptions: [{ recurrenceId: cancelled, cancelled: true }],
        },
        materializationWindow: yearWindow(15),
      }),
    );
    expect(result).toMatchObject({ ok: true });
    const starts = await occurrences((await stored(longRunning))?.id as string);
    expect(starts).toHaveLength(366);
    expect(starts).not.toContainEqual(cancelled);
    // And it still leaves a cursor for the next roll.
    expect((await stored(longRunning))?.recurrence_cursor).not.toBeNull();
  });

  it('refuses a change to its rule that it cannot search from the start, and keeps it as it was', async () => {
    const before = await store.getCalendarEvent({ tenantRef, externalRef: longRunning });
    const cursor = (await stored(longRunning))?.recurrence_cursor;
    const result = await store.putCalendarEvent(
      handover(longRunning, {
        expectedRevision: before?.revision,
        recurrence: { rrule: 'FREQ=DAILY;BYHOUR=9,17' },
        materializationWindow: yearWindow(15),
      }),
    );
    expect(result).toEqual({ ok: false, code: 'invalid_event' });
    await expect(
      store.getCalendarEvent({ tenantRef, externalRef: longRunning }),
    ).resolves.toMatchObject({ revision: before?.revision, recurrence: { rrule: 'FREQ=DAILY' } });
    expect((await stored(longRunning))?.recurrence_cursor).toEqual(cursor);
  });

  it('keeps no cursor for a one-off event', async () => {
    const oneOff = `one-off-${crypto.randomUUID()}`;
    const result = await store.putCalendarEvent({
      ...handover(oneOff),
      recurrence: undefined,
      start: d('2026-11-02T13:00:00Z'),
      end: d('2026-11-02T14:00:00Z'),
      materializationWindow: undefined,
    } as unknown as Parameters<SlotlockStore['putCalendarEvent']>[0]);
    expect(result).toMatchObject({ ok: true });
    expect((await stored(oneOff))?.recurrence_cursor).toBeNull();
  });
});

describe.skipIf(!url)(
  'paging the roll past the masters a batch leaves behind (real Postgres)',
  () => {
    let sql: ReturnType<typeof postgres>;
    let store: SlotlockStore;
    let tenantRef: string;
    let resourceId: string;

    beforeAll(async () => {
      sql = postgres(url as string, { max: 4, onnotice: () => {} });
      store = createSlotlockStore(sql);
      await store.applySchema();
      tenantRef = `paging-tenant-${crypto.randomUUID()}`;
      resourceId = (
        await store.createResource({
          externalRef: `paging-resource-${crypto.randomUUID()}`,
          tenantRef,
          timezone: 'UTC',
        })
      ).id;
    });

    afterAll(async () => {
      await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.calendar_event_occurrences WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
      await sql.end();
    });

    it('examines the masters after the last batch, not the same refused ones again', async () => {
      const series = (externalRef: string, hour: string, windowStart: string) => ({
        tenantRef,
        externalRef,
        idempotencyKey: `command-${crypto.randomUUID()}`,
        expectedRevision: 0,
        resourceId,
        start: d(`2027-01-04T${hour}:00:00Z`),
        end: d(`2027-01-04T${hour}:30:00Z`),
        timezone: 'UTC',
        summary: 'Vehicle check',
        recurrence: { rrule: 'FREQ=DAILY' },
        materializationWindow: { start: d(windowStart), end: d('2027-01-08T00:00:00Z') },
      });
      // Two series that will be refused, first in the roll's order (their coverage ends earliest),
      // and one ordinary series after them.
      const stuck = [`stuck-a-${crypto.randomUUID()}`, `stuck-b-${crypto.randomUUID()}`];
      const ordinary = `ordinary-${crypto.randomUUID()}`;
      for (const [externalRef, hour] of [
        [stuck[0], '07'],
        [stuck[1], '08'],
        [ordinary, '09'],
      ] as const) {
        const created = await store.putCalendarEvent(
          series(externalRef as string, hour, '2027-01-01T00:00:00Z'),
        );
        if (!created.ok) throw new Error('series fixture failed');
      }
      await sql`
      UPDATE slotlock.calendar_events
         SET recurrence_rule = 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30',
             materialized_ends_at = '2027-01-07T00:00:00Z'
       WHERE tenant_ref = ${tenantRef} AND external_ref IN ${sql(stuck)}`;

      const window = { start: d('2027-01-05T00:00:00Z'), end: d('2027-01-12T00:00:00Z') };
      const first = await store.rollCalendarEventHorizon({ tenantRef, window, limit: 2 });
      expect(first).toMatchObject({ examined: 2, extended: 0, refused: 2, hasMore: true });
      expect(first.next).not.toBeNull();

      // Without `after`, the next batch is the same two refused series.
      const again = await store.rollCalendarEventHorizon({ tenantRef, window, limit: 2 });
      expect(again).toMatchObject({ examined: 2, refused: 2 });

      const second = await store.rollCalendarEventHorizon({
        tenantRef,
        window,
        limit: 2,
        ...(first.next ? { after: first.next } : {}),
      });
      expect(second).toMatchObject({
        examined: 1,
        extended: 1,
        refused: 0,
        hasMore: false,
        next: null,
      });
      await expect(
        store.getCalendarEvent({ tenantRef, externalRef: ordinary }),
      ).resolves.toMatchObject({ materializationWindow: window });
    });

    it('refuses an `after` that is not a batch’s `next`', async () => {
      const window = { start: d('2027-01-05T00:00:00Z'), end: d('2027-01-12T00:00:00Z') };
      await expect(
        store.rollCalendarEventHorizon({
          tenantRef,
          window,
          after: { materializedEndsAt: d('2027-01-07T00:00:00Z'), eventId: "x' OR 1=1" },
        }),
      ).rejects.toMatchObject({ code: 'invalid_cursor' });
    });
  },
);
