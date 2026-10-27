// Pools against real Postgres: a class of interchangeable resources sells out exactly at its number
// of members, whatever the race; a booking takes the first member free and allowed, names it, and
// replays to the same one; agents list a pool's members in that order. Skipped without DATABASE_URL.
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
    expect((await store.listPools({ tenantRef })).find(({ pool }) => pool === 'van')).toEqual({ pool: 'van', capacity: 5 });
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
});
