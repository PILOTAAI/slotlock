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
  ])('refuses to write a series with %s, promptly', async (_name, rrule) => {
    const externalRef = `never-${crypto.randomUUID()}`;
    const started = performance.now();
    const result = await store.putCalendarEvent(series(externalRef, rrule));
    // One event as it is written is refused within its 50,000 steps: a few hundredths of a second.
    expect(performance.now() - started).toBeLessThan(1_500);
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
    const stuckId = (await store.getCalendarEvent({ tenantRef, externalRef: stuck }))?.id;
    expect(result).toEqual({
      examined: 2,
      extended: 1,
      conflicts: 0,
      conflictEventIds: [],
      refused: 1,
      refusedEventIds: [stuckId],
      hasMore: false,
      next: null,
    });

    await expect(
      store.getCalendarEvent({ tenantRef, externalRef: ordinary }),
    ).resolves.toMatchObject({ materializationWindow: rolled });
    await expect(store.getCalendarEvent({ tenantRef, externalRef: stuck })).resolves.toMatchObject({
      materializationWindow: { start: d('2027-01-01T00:00:00Z'), end: d('2027-01-08T00:00:00Z') },
    });
  });

  it('keeps rolling a stored series it took to write, however its search has grown', async () => {
    // Written within one event's 50,000 steps; then, as a row expanded from 1950 holds it, about
    // 89,000 steps: over what a write may take, within the roll's 500,000.
    const grown = `grown-${crypto.randomUUID()}`;
    const created = await store.putCalendarEvent(series(grown, 'FREQ=DAILY', '13'));
    if (!created.ok) throw new Error('series fixture failed');
    await sql`
      UPDATE slotlock.calendar_events
         SET starts_at = '1950-01-04T13:00:00Z', ends_at = '1950-01-04T13:30:00Z',
             recurrence_rule = 'FREQ=DAILY;BYMONTH=1;BYMONTHDAY=4'
       WHERE tenant_ref = ${tenantRef} AND external_ref = ${grown}`;
    const grownId = (await store.getCalendarEvent({ tenantRef, externalRef: grown }))?.id;
    const rolled = { start: d('2027-01-03T00:00:00Z'), end: d('2027-01-12T00:00:00Z') };
    const result = await store.rollCalendarEventHorizon({ tenantRef, window: rolled, limit: 1000 });
    expect(result.refusedEventIds).not.toContain(grownId);
    await expect(
      store.getCalendarEvent({ tenantRef, externalRef: grown }),
    ).resolves.toMatchObject({ materializationWindow: rolled });

    // The same series is refused as it is written from 1950, and written from 1990.
    const written = (start: string) => ({
      ...series(`regrown-${crypto.randomUUID()}`, 'FREQ=DAILY;BYMONTH=1;BYMONTHDAY=4', '15'),
      start: d(`${start}T15:00:00Z`),
      end: d(`${start}T15:30:00Z`),
    });
    await expect(store.putCalendarEvent(written('1950-01-04'))).resolves.toEqual({
      ok: false,
      code: 'invalid_event',
    });
    await expect(store.putCalendarEvent(written('1990-01-04'))).resolves.toMatchObject({ ok: true });
  });

  it('counts a stored series past the limits as refused, and still rolls', async () => {
    // A daily series begun in 2014 takes more than 4,000 occurrences to reach the window, one every
    // minute from its start has more than 2,000 in it, and one every 36,601 days steps further than
    // a century: the store refuses all three as they are written, so only a row written before, or
    // by another writer, holds them.
    const old = `old-${crypto.randomUUID()}`;
    const minutely = `minutely-${crypto.randomUUID()}`;
    const far = `far-${crypto.randomUUID()}`;
    for (const [externalRef, hour] of [
      [old, '17'],
      [minutely, '19'],
      [far, '21'],
    ] as const) {
      const created = await store.putCalendarEvent(series(externalRef, 'FREQ=DAILY', hour));
      if (!created.ok) throw new Error('series fixture failed');
    }
    await sql`
      UPDATE slotlock.calendar_events
         SET starts_at = '2014-01-06T17:00:00Z', ends_at = '2014-01-06T17:30:00Z'
       WHERE tenant_ref = ${tenantRef} AND external_ref = ${old}`;
    await sql`
      UPDATE slotlock.calendar_events
         SET recurrence_rule = 'FREQ=MINUTELY', starts_at = '2027-01-06T00:00:00Z',
             ends_at = '2027-01-06T00:00:30Z'
       WHERE tenant_ref = ${tenantRef} AND external_ref = ${minutely}`;
    await sql`
      UPDATE slotlock.calendar_events SET recurrence_rule = 'FREQ=DAILY;INTERVAL=36601'
       WHERE tenant_ref = ${tenantRef} AND external_ref = ${far}`;
    const ids = await Promise.all(
      [old, minutely, far].map(
        async (externalRef) => (await store.getCalendarEvent({ tenantRef, externalRef }))?.id,
      ),
    );
    const rolled = { start: d('2027-01-06T00:00:00Z'), end: d('2027-01-14T00:00:00Z') };
    const result = await store.rollCalendarEventHorizon({ tenantRef, window: rolled, limit: 1000 });
    expect(result.refusedEventIds).toEqual(expect.arrayContaining(ids));
  });

  it('still fails a roll over a stored series that is wrong rather than too big', async () => {
    // Only a rule's size is skipped: a series Slotlock cannot read at all surfaces, as before.
    const otherTenant = `budget-tenant-${crypto.randomUUID()}`;
    const resource = await store.createResource({
      externalRef: `budget-resource-${crypto.randomUUID()}`,
      tenantRef: otherTenant,
      timezone: 'UTC',
    });
    try {
      const broken = `broken-${crypto.randomUUID()}`;
      const created = await store.putCalendarEvent({
        ...series(broken, 'FREQ=DAILY'),
        tenantRef: otherTenant,
        resourceId: resource.id,
      });
      if (!created.ok) throw new Error('series fixture failed');
      await sql`
        UPDATE slotlock.calendar_events SET recurrence_rule = 'FREQ=NEVERLY'
         WHERE tenant_ref = ${otherTenant} AND external_ref = ${broken}`;
      await expect(
        store.rollCalendarEventHorizon({
          tenantRef: otherTenant,
          window: { start: d('2027-01-05T00:00:00Z'), end: d('2027-01-12T00:00:00Z') },
        }),
      ).rejects.toThrow();
    } finally {
      await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${otherTenant}`;
      await sql`DELETE FROM slotlock.calendar_event_occurrences WHERE tenant_ref = ${otherTenant}`;
      await sql`DELETE FROM slotlock.calendar_coverage WHERE tenant_ref = ${otherTenant}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${otherTenant}`;
      await sql`DELETE FROM slotlock.reservations WHERE tenant_ref = ${otherTenant}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${otherTenant}`;
    }
  });
});
