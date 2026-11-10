// Zone rule changes reach everything (RFC 0004 B9) against real Postgres: a series' occurrences and
// reservations that carry their wall time are re-checked by followZoneRules, reported once or
// moved, and a move in the way is reported as a conflict. A rule change is simulated by moving the
// stored wall time, which is what new tzdata does to the instant a wall time names. Skipped without
// DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;

describe.skipIf(!url)('zone rule changes (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantRef = `zones-${randomUUID()}`;
  const day = Date.UTC(new Date().getUTCFullYear() + 1, 6, 6);
  const at = (hour: number) => new Date(day + hour * HOUR);
  const reserve = (resourceId: string, ref: string, start: number, localStart?: string) =>
    store.withTenant(tenantRef, (tenant) =>
      tenant.createExternalReservation({
        tenantRef,
        externalRef: ref,
        resourceId,
        start: at(start),
        end: at(start + 1),
        bufferAfterMs: 0,
        revision: 1,
        ...(localStart ? { localStart } : {}),
      }),
    );
  const changes = async (subject: string) =>
    (
      await sql<{ type: string; actor: string | null }[]>`
        SELECT type, actor FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} AND subject = ${subject} ORDER BY id`
    ).map((row) => [row.type, row.actor]);
  const follow = (move: boolean) => store.withTenant(tenantRef, (tenant) => tenant.followZoneRules({ tenantRef, move }));
  // What new tzdata would do: the wall time stored now names an instant an hour later.
  const shiftRules = (table: 'reservations' | 'calendar_event_occurrences', where: ReturnType<typeof sql>) =>
    sql`UPDATE slotlock.${sql(table)} SET wall_starts_at = wall_starts_at + interval '1 hour' WHERE ${where}`;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('reports a reservation whose wall time moved once, and moves it when asked', async () => {
    const room = await store.withTenant(tenantRef, (tenant) =>
      tenant.createResource({ tenantRef, externalRef: 'room-1', timezone: 'UTC' }),
    );
    const dateOf = (hour: number) => at(hour).toISOString().slice(0, 16);
    expect(await reserve(room.id, 'bad', 9, dateOf(10))).toEqual({ ok: false, code: 'invalid_local_start' });
    expect(await reserve(room.id, 'bk-report', 9, dateOf(9))).toMatchObject({ ok: true });
    expect(await reserve(room.id, 'bk-move', 12, dateOf(12))).toMatchObject({ ok: true });
    expect(await reserve(room.id, 'bk-stuck', 15, dateOf(15))).toMatchObject({ ok: true });
    expect(await reserve(room.id, 'bk-blocker', 16)).toMatchObject({ ok: true });
    // Without a wall time, nothing to follow.
    expect(await reserve(room.id, 'bk-instant', 19)).toMatchObject({ ok: true });

    await shiftRules('reservations', sql`external_ref = 'bk-report'`);
    expect(await follow(false)).toMatchObject({ shifted: 1, moved: 0 });
    expect(await follow(false)).toMatchObject({ shifted: 0 });
    expect((await changes('bk-report')).at(-1)).toEqual(['reservation.timezone_shifted', 'slotlock:tzdata']);

    await shiftRules('reservations', sql`external_ref IN ('bk-move', 'bk-stuck')`);
    expect(await follow(true)).toMatchObject({ shifted: 2, moved: 1, conflicts: 1 });
    const moved = await store.withTenant(tenantRef, (tenant) => tenant.getReservation({ tenantRef, externalRef: 'bk-move' }));
    expect(moved).toMatchObject({ start: at(13), end: at(14), revision: 2 });
    expect((await changes('bk-move')).slice(-2)).toEqual([
      ['reservation.updated', 'slotlock:tzdata'],
      ['reservation.rescheduled', 'slotlock:tzdata'],
    ]);
    expect((await changes('bk-stuck')).at(-1)).toEqual(['reservation.timezone_conflict', 'slotlock:tzdata']);
  });

  it("re-checks a series' occurrences to come and reports each once", async () => {
    const desk = await store.withTenant(tenantRef, (tenant) =>
      tenant.createResource({ tenantRef, externalRef: 'desk-1', timezone: 'Europe/London' }),
    );
    const put = await store.withTenant(tenantRef, (tenant) =>
      tenant.putCalendarEvent({
        tenantRef,
        externalRef: 'standup',
        resourceId: desk.id,
        expectedRevision: 0,
        idempotencyKey: 'standup-1',
        start: at(9),
        end: at(9.5),
        timezone: 'Europe/London',
        summary: 'Stand-up',
        recurrence: { rrule: 'FREQ=DAILY;COUNT=3' },
        materializationWindow: { start: at(0), end: at(24 * 5) },
      }),
    );
    expect(put.ok).toBe(true);
    const eventId = (put as { eventId: string }).eventId;
    const [first] = await sql<{ recurrence_id: string }[]>`
      SELECT recurrence_id FROM slotlock.calendar_event_occurrences WHERE event_id = ${eventId} ORDER BY starts_at LIMIT 1`;
    await shiftRules('calendar_event_occurrences', sql`event_id = ${eventId} AND recurrence_id = ${first?.recurrence_id as string}`);
    expect(await follow(false)).toMatchObject({ shifted: 1 });
    expect(await follow(false)).toMatchObject({ shifted: 0 });
    const [reported] = await sql<{ data: Record<string, unknown> }[]>`
      SELECT data FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} AND subject = ${eventId}
         AND type = 'event.timezone_shifted'`;
    expect(reported?.data).toMatchObject({ recurrence_id: first?.recurrence_id, zone_start: new Date(at(9).getTime() + HOUR).toISOString() });
  });
});
