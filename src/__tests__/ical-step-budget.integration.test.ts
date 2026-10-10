// The store expands a recurring event when it is written and again each time maintenance rolls its
// horizon. A rule that never occurs held the whole process at either point; now the write is refused
// and the roll skips that series, keeping its old coverage, and rolls the rest.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const d = (iso: string) => new Date(iso);

describe.skipIf(!url)('the expansion budget in the store (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let tenantRef: string;
  let resourceId: string;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    tenantRef = `budget-tenant-${crypto.randomUUID()}`;
    resourceId = (
      await store.createResource({
        externalRef: `budget-resource-${crypto.randomUUID()}`,
        tenantRef,
        timezone: 'UTC',
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

  const series = (externalRef: string, rrule: string, hour = '09') => ({
    tenantRef,
    externalRef,
    idempotencyKey: `command-${crypto.randomUUID()}`,
    expectedRevision: 0,
    resourceId,
    // A Monday.
    start: d(`2027-01-04T${hour}:00:00Z`),
    end: d(`2027-01-04T${hour}:30:00Z`),
    timezone: 'UTC',
    summary: 'Vehicle check',
    recurrence: { rrule },
    materializationWindow: { start: d('2027-01-01T00:00:00Z'), end: d('2027-01-08T00:00:00Z') },
  });

  it.each([
    ['one that never occurs', 'FREQ=DAILY;INTERVAL=7;BYDAY=TU'],
    ['one whose steps are few but slow', 'FREQ=DAILY;INTERVAL=36600;BYMONTH=2;BYMONTHDAY=29'],
    ['a step longer than a century', 'FREQ=WEEKLY;INTERVAL=20871;BYMONTH=2'],
  ])('refuses to write a series with %s, within a second', async (_name, rrule) => {
    const externalRef = `never-${crypto.randomUUID()}`;
    const started = performance.now();
    const result = await store.putCalendarEvent(series(externalRef, rrule));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result).toEqual({ ok: false, code: 'invalid_event' });
    await expect(store.getCalendarEvent({ tenantRef, externalRef })).resolves.toBeNull();
  });

  it('rolls the rest of the horizon past a stored series that never occurs again', async () => {
    const ordinary = `ordinary-${crypto.randomUUID()}`;
    const stuck = `stuck-${crypto.randomUUID()}`;
    for (const [externalRef, hour] of [
      [ordinary, '09'],
      [stuck, '11'],
    ] as const) {
      const created = await store.putCalendarEvent(series(externalRef, 'FREQ=DAILY', hour));
      if (!created.ok) throw new Error('series fixture failed');
    }
    // As a row written before the budget, or by another writer, could hold it.
    await sql`
      UPDATE slotlock.calendar_events
         SET recurrence_rule = 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'
       WHERE tenant_ref = ${tenantRef} AND external_ref = ${stuck}`;

    const rolled = { start: d('2027-01-05T00:00:00Z'), end: d('2027-01-12T00:00:00Z') };
    const started = performance.now();
    const result = await store.rollCalendarEventHorizon({ tenantRef, window: rolled });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result).toEqual({ examined: 2, extended: 1, conflicts: 0, refused: 1, hasMore: false });

    await expect(
      store.getCalendarEvent({ tenantRef, externalRef: ordinary }),
    ).resolves.toMatchObject({ materializationWindow: rolled });
    await expect(store.getCalendarEvent({ tenantRef, externalRef: stuck })).resolves.toMatchObject({
      materializationWindow: { start: d('2027-01-01T00:00:00Z'), end: d('2027-01-08T00:00:00Z') },
    });
  });
});
