// Holds across resources (RFC 0004 B7) against real Postgres: a set held all or nothing under one
// group and one time to live, booked from its holds by slotlock_book_together, and the application
// API's bundle and pool bookings. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type SlotlockAgentPrincipal,
  createSlotlockAgentServer,
  invokeSlotlockAgentOperation,
} from '../agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];

describe.skipIf(!url)('holds across resources (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  let agentBackend: ReturnType<typeof createSlotlockStoreAgentBackend>;
  const tenantRef = `together-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    admin: { subject: 'person-admin', tenantRef, scopes: ['read', 'write', 'admin'] },
  };
  const day = Date.UTC(new Date().getUTCFullYear() + 1, 4, 5);
  const at = (hour: number) => new Date(day + hour * HOUR).toISOString();
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: 'Bearer admin', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const agent = (operation: string, input: Record<string, unknown>, subject = 'agent-a') =>
    invokeSlotlockAgentOperation({
      operation: operation as never,
      input,
      request: new Request(BASE),
      options: {
        backend: agentBackend,
        authenticate: async () => ({ subject, tenantRef, scopes: ['read', 'write'] }),
        authorize: async () => true,
      },
    }) as Promise<{ ok: boolean; code?: string; details?: Record<string, unknown>; data?: Record<string, unknown> }>;
  const resource = async (ref: string, pool?: string) => {
    const created = (await call('POST', '/v1/resources', { external_ref: ref, timezone: 'UTC' })).body.resource as { id: string };
    if (pool) await call('PUT', `/v1/resources/${created.id}/pool`, { pool });
    return created.id;
  };

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql, { defaultAvailabilityRules: ALL_DAY });
    await store.applySchema();
    agentBackend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => ALL_DAY });
    server = createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      backend: agentBackend,
      authenticate: async (request) => principals[request.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
      application: {
        backend: createSlotlockStoreApplicationBackend(store, { agentBackend }),
        authorize: async ({ principal }) => principal.scopes?.includes('admin') === true,
      },
    });
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('holds a set all or nothing with one time to live, and books it from its holds', async () => {
    const car = await resource('car-1');
    const driver = await resource('driver-1');
    const busy = await resource('driver-2');
    expect((await call('PUT', '/v1/reservations/taken', { resource_id: busy, start: at(9), end: at(17), revision: 1 })).status).toBe(200);

    // A taken member: nothing is held, and the refusal names it.
    const refused = await agent('slotlock_hold_together', {
      resource_ids: [car, busy],
      start: at(9),
      end: at(17),
      idempotency_key: 'set-refused',
    });
    expect(refused).toMatchObject({ ok: false, code: 'overlap', details: { resource_id: busy } });
    const [counted] = await sql<{ held: number }[]>`
      SELECT count(*)::int AS held FROM slotlock.reservations WHERE resource_id = ${car} AND status = 'held'`;
    expect(counted?.held).toBe(0);

    const set = await agent('slotlock_hold_together', {
      resource_ids: [driver, car],
      start: at(9),
      end: at(17),
      ttl_seconds: 300,
      idempotency_key: 'set-1',
    });
    expect(set.ok).toBe(true);
    const holds = set.data?.holds as { hold_id: string; resource_id: string; expires_at: string }[];
    expect(holds.map((hold) => hold.resource_id)).toEqual([car, driver].sort());
    expect(new Set(holds.map((hold) => hold.expires_at)).size).toBe(1);
    expect(set.data?.expires_at).toBe(holds[0]?.expires_at);
    // Another agent cannot take either while held.
    expect(
      await agent('slotlock_create_event', { resource_id: car, starts_at: at(10), ends_at: at(11), timezone: 'UTC', idempotency_key: 'k' }, 'agent-b'),
    ).toMatchObject({ ok: false, code: 'overlap' });
    // A retry answers the same set.
    expect((await agent('slotlock_hold_together', { resource_ids: [car, driver], start: at(9), end: at(17), ttl_seconds: 300, idempotency_key: 'set-1' })).data?.group_id).toBe(
      set.data?.group_id,
    );

    const booked = await agent('slotlock_book_together', {
      resource_ids: [car, driver],
      starts_at: at(9),
      ends_at: at(17),
      timezone: 'UTC',
      hold_group_id: set.data?.group_id,
      idempotency_key: 'book-set-1',
    });
    expect(booked.ok).toBe(true);
    expect((booked.data?.events as unknown[]).length).toBe(2);
    const [remaining] = await sql<{ left: number }[]>`
      SELECT count(*)::int AS left FROM slotlock.reservations WHERE hold_group_id = ${set.data?.group_id as string} AND status = 'held'`;
    expect(remaining?.left).toBe(0);
  });

  it('books bundles and pool members through the application API', async () => {
    const room = await resource('room-1');
    const projector = await resource('projector-1');
    const bundle = await call('POST', '/v1/tenant/bundles', {
      resource_ids: [room, projector],
      starts_at: at(9),
      ends_at: at(10),
      timezone: 'UTC',
      idempotency_key: 'bundle-1',
    });
    expect(bundle.status).toBe(200);
    expect((bundle.body.events as { resource_id: string }[]).map((event) => event.resource_id).sort()).toEqual([room, projector].sort());
    const again = await call('POST', '/v1/tenant/bundles', {
      resource_ids: [room, projector],
      starts_at: at(9),
      ends_at: at(10),
      timezone: 'UTC',
      idempotency_key: 'bundle-1',
    });
    expect(again.body.replayed).toBe(true);

    const vans = [await resource('van-a', 'vans'), await resource('van-b', 'vans')];
    const first = await call('POST', '/v1/tenant/pool-bookings', { pool: 'vans', starts_at: at(9), ends_at: at(10), timezone: 'UTC', idempotency_key: 'p1' });
    const second = await call('POST', '/v1/tenant/pool-bookings', { pool: 'vans', starts_at: at(9), ends_at: at(10), timezone: 'UTC', idempotency_key: 'p2' });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(
      [(first.body.event as { resource_id: string }).resource_id, (second.body.event as { resource_id: string }).resource_id].sort(),
    ).toEqual([...vans].sort());
    const full = await call('POST', '/v1/tenant/pool-bookings', { pool: 'vans', starts_at: at(9), ends_at: at(10), timezone: 'UTC', idempotency_key: 'p3' });
    expect(full).toMatchObject({ status: 409, body: { error: { code: 'pool_full' } } });
  });
});
