// Pools against real Postgres. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SlotlockAgentInvocationContext } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;

describe.skipIf(!url)('pools (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let backend: ReturnType<typeof createSlotlockStoreAgentBackend>;
  const tenantRef = `pools-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 6, 1, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR).toISOString();
  const context = (operation: string, subject = 'pool-agent'): SlotlockAgentInvocationContext => ({
    principal: { subject, tenantRef },
    operation: operation as SlotlockAgentInvocationContext['operation'],
    signal: new AbortController().signal,
  });
  const book = (pool: string, start: number, end: number, subject?: string, key = `p-${randomUUID()}`) =>
    backend.bookPool?.(context('slotlock_book_pool', subject), {
      pool,
      starts_at: at(start),
      ends_at: at(end),
      timezone: 'UTC',
      idempotency_key: key,
    }) as Promise<{ event: { resource_id: string }; replayed: boolean }>;

  async function members(pool: string, count: number) {
    const ids: string[] = [];
    for (let n = 0; n < count; n++) {
      const resource = await store.createResource({ tenantRef, externalRef: `${pool}-${n}-${randomUUID()}`, timezone: 'UTC' });
      expect(await store.setResourcePool({ tenantRef, id: resource.id, pool })).toMatchObject({ pool });
      ids.push(resource.id);
    }
    return ids.sort();
  }

  beforeAll(async () => {
    sql = postgres(url as string, { max: 10, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    backend = createSlotlockStoreAgentBackend(store, {
      availabilityRules: async () => [{ rrule: 'FREQ=DAILY', startMinutes: 0, durationMinutes: 1440 }],
    });
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it("tries a pool's members in its order: stable, round robin, or least booked first", async () => {
    // Stable, the default: the same first member each time it is free.
    const desks = await members('desk', 3);
    expect((await book('desk', 300, 301)).event.resource_id).toBe(desks[0]);
    expect((await book('desk', 302, 303)).event.resource_id).toBe(desks[0]);
    // Round robin: from the member after the one booked last, round to the start.
    const bikes = await members('ebike', 3);
    expect(await store.setPoolOrder({ tenantRef, pool: 'ebike', order: 'round_robin' })).toBe('round_robin');
    const taken: string[] = [];
    for (let n = 0; n < 4; n += 1) taken.push((await book('ebike', 310 + n * 2, 311 + n * 2)).event.resource_id);
    expect(taken).toEqual([bikes[0], bikes[1], bikes[2], bikes[0]]);
    // Least booked: the member with the fewest bookings made in the last 30 days first, by id among equals.
    const rooms = await members('meeting', 3);
    const reserve = (resourceId: string, start: number) =>
      store.createExternalReservation({
        tenantRef,
        externalRef: `seed-${randomUUID()}`,
        resourceId,
        start: new Date(at(start)),
        end: new Date(at(start + 1)),
        bufferAfterMs: 0,
        revision: 1,
      });
    await reserve(rooms[0] as string, 400);
    await reserve(rooms[0] as string, 402);
    await reserve(rooms[1] as string, 404);
    await store.setPoolOrder({ tenantRef, pool: 'meeting', order: 'least_booked' });
    expect((await book('meeting', 410, 411)).event.resource_id).toBe(rooms[2]);
    // Rooms 1 and 2 now have one each: the lower id goes first.
    expect((await book('meeting', 412, 413)).event.resource_id).toBe(rooms[1]);
    expect((await store.listPools({ tenantRef })).filter(({ pool }) => ['desk', 'ebike', 'meeting'].includes(pool))).toEqual([
      { pool: 'desk', capacity: 3, order: 'stable' },
      { pool: 'ebike', capacity: 3, order: 'round_robin' },
      { pool: 'meeting', capacity: 3, order: 'least_booked' },
    ]);
    await expect(store.setPoolOrder({ tenantRef, pool: 'desk', order: 'random' as never })).rejects.toMatchObject({
      code: 'invalid_pool_order',
    });
  });

  it('sells five vans to six racing bookings exactly five times', async () => {
    const vans = await members('van', 5);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, n) => book('van', 1, 2, `racer-${n}`)),
    );
    const booked = outcomes.filter((outcome) => outcome.status === 'fulfilled') as PromiseFulfilledResult<{
      event: { resource_id: string };
    }>[];
    expect(booked).toHaveLength(5);
    expect(booked.map(({ value }) => value.event.resource_id).sort()).toEqual(vans);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'pool_full', status: 409 });
    expect((await store.listPools({ tenantRef })).find(({ pool }) => pool === 'van')).toEqual({ pool: 'van', capacity: 5, order: 'stable' });
    // The racers queue on each other by design (each waits for the one ahead to commit); on a
    // shared CI runner, under the other suites' load, that takes longer than vitest's 5 s.
  }, 30_000);

  it('takes the first member free and allowed, and replays to the same one', async () => {
    const rooms = await members('room', 3);
    await backend.createEvent(context('slotlock_create_event', 'other'), {
      resource_id: rooms[0],
      starts_at: at(10),
      ends_at: at(11),
      timezone: 'UTC',
      transparency: 'opaque',
      status: 'confirmed',
      idempotency_key: `x-${randomUUID()}`,
    });
    // The second room only takes bookings two days ahead.
    await store.setResourceBookingRules({ tenantRef, id: rooms[1] as string, rules: { maxAdvanceDays: 1 } });
    const key = `room-${randomUUID()}`;
    const first = await book('room', 10, 11, undefined, key);
    expect(first.event.resource_id).toBe(rooms[2]);
    // Meanwhile the first room frees up; the retry still answers the third.
    await sql`DELETE FROM slotlock.calendar_events WHERE resource_id = ${rooms[0] as string} AND tenant_ref = ${tenantRef}`;
    const again = await book('room', 10, 11, undefined, key);
    expect(again).toMatchObject({ replayed: true, event: { resource_id: rooms[2] } });
    await expect(book('nope', 10, 11)).rejects.toMatchObject({ code: 'pool_not_found', status: 404 });
    await expect(store.setResourcePool({ tenantRef, id: rooms[0] as string, pool: 'Not A Pool' })).rejects.toMatchObject({
      code: 'invalid_pool',
    });
  });

  it('lists a pool to agents in booking order, and leaves archived members out of its capacity', async () => {
    const bikes = await members('bike', 3);
    await book('bike', 20, 21);
    const listed = (await backend.listResources(context('slotlock_list_resources'), { limit: 50, pool: 'bike' })) as {
      resources: { id: string; pool: string }[];
    };
    expect(listed.resources.map((resource) => resource.id)).toEqual(bikes);
    expect(listed.resources.every((resource) => resource.pool === 'bike')).toBe(true);
    // Archived members leave the pool's capacity.
    await store.archiveResource({ tenantRef, id: bikes[2] as string });
    expect((await store.listPools({ tenantRef })).find(({ pool }) => pool === 'bike')?.capacity).toBe(2);
  });

  it('says how many members are free across a window, part by part', async () => {
    const pool = `suv-${randomUUID().slice(0, 8)}`;
    await members(pool, 3);
    await book(pool, 10, 14);
    await book(pool, 12, 16);
    const availability = (start: number, end: number) =>
      backend.getPoolAvailability?.(context('slotlock_get_pool_availability'), {
        pool,
        start: at(start),
        end: at(end),
      }) as Promise<Record<string, unknown>>;
    expect(await availability(8, 18)).toEqual({
      pool,
      members: 3,
      intervals: [
        { start: at(8), end: at(10), free: 3 },
        { start: at(10), end: at(12), free: 2 },
        { start: at(12), end: at(14), free: 1 },
        { start: at(14), end: at(16), free: 2 },
        { start: at(16), end: at(18), free: 3 },
      ],
      coverage: { start: at(8), end: at(18), certainty: 'certain', reason: null },
    });
    await book(pool, 12, 13);
    expect((await availability(12, 14)).intervals).toEqual([
      { start: at(12), end: at(13), free: 0 },
      { start: at(13), end: at(14), free: 1 },
    ]);
    await expect(
      backend.getPoolAvailability?.(context('slotlock_get_pool_availability'), {
        pool: 'no-such-pool',
        start: at(8),
        end: at(9),
      }) as Promise<unknown>,
    ).rejects.toMatchObject({ code: 'pool_not_found', status: 404 });
  });

  it("counts a member free only where its booking rules let one book it, and private ones never", async () => {
    const pool = `bus-${randomUUID().slice(0, 8)}`;
    const [open, ahead, nights] = await members(pool, 3);
    // One books at most a day ahead; one only 09:00-17:00 (its own hours, enforced).
    await store.setResourceBookingRules({ tenantRef, id: ahead as string, rules: { maxAdvanceDays: 1 } });
    await store.setResourceAvailability({
      tenantRef,
      id: nights as string,
      rules: [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 9 * 60, durationMinutes: 8 * 60 }],
    });
    await store.setResourceBookingRules({ tenantRef, id: nights as string, rules: { enforceHours: true } });
    const hidden = await store.createResource({ tenantRef, externalRef: `${pool}-private`, timezone: 'UTC', visibility: 'private' });
    await store.setResourcePool({ tenantRef, id: hidden.id, pool });
    const answer = (await backend.getPoolAvailability?.(context('slotlock_get_pool_availability'), {
      pool,
      start: at(6),
      end: at(20),
    })) as { members: number; intervals: { start: string; end: string; free: number }[] };
    // A year ahead: only the open one and, in its hours, the one with hours; never the private one.
    expect(answer.members).toBe(3);
    expect(answer.intervals).toEqual([
      { start: at(6), end: at(9), free: 1 },
      { start: at(9), end: at(17), free: 2 },
      { start: at(17), end: at(20), free: 1 },
    ]);
    // What it counts, a pool booking takes: at 20:00 only the open one, then the class is full.
    expect((await book(pool, 18, 19)).event.resource_id).toBe(open);
    await expect(book(pool, 18, 19)).rejects.toMatchObject({ code: 'pool_full' });
  });

  it('calls a count uncertain when one member\'s coverage is', async () => {
    const pool = `cab-${randomUUID().slice(0, 8)}`;
    await members(pool, 2);
    const strict = createSlotlockStoreAgentBackend(store, {
      availabilityRules: async () => [{ rrule: 'FREQ=DAILY', startMinutes: 0, durationMinutes: 1440 }],
      requiredCoverageSources: async () => ['google:fleet'],
    });
    const answer = (await strict.getPoolAvailability?.(context('slotlock_get_pool_availability'), {
      pool,
      start: at(6),
      end: at(8),
    })) as { coverage: { certainty: string } };
    expect(answer.coverage.certainty).toBe('uncertain');
  });
});
