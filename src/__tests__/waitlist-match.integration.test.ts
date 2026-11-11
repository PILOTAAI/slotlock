// Waitlists that match (RFC 0004 B6) against real Postgres: an entry waits for any slot of its
// length within its window, on a resource or a pool, is offered the earliest free one, and ends
// accepted, declined or lapsed, each on the feed with joining and leaving. Skipped without
// DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer } from '../agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];

describe.skipIf(!url)('waitlists that match (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const tenantRef = `waitmatch-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    admin: { subject: 'person-admin', tenantRef, scopes: ['read', 'write', 'admin'] },
  };
  const day = Date.UTC(new Date().getUTCFullYear() + 1, 2, 3);
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
  const feed = async (subject: string) =>
    (
      await sql<{ type: string }[]>`
        SELECT type FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} AND subject = ${subject} ORDER BY id`
    ).map((row) => row.type);
  const entryOf = async (id: string) =>
    ((await call('GET', '/v1/waitlist')).body.entries as Record<string, unknown>[]).find((entry) => entry.id === id);

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql, { defaultAvailabilityRules: ALL_DAY });
    await store.applySchema();
    const agentBackend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => ALL_DAY });
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

  it('offers the earliest slot of the length asked, and says how each offer ends', async () => {
    const van = (await call('POST', '/v1/resources', { external_ref: 'van-1', timezone: 'UTC' })).body.resource as { id: string };
    // Busy 09:00-12:00 and 13:00-17:00: a two-hour slot fits nowhere between 09:00 and 17:00.
    const book = (ref: string, from: number, to: number) =>
      call('PUT', `/v1/reservations/${ref}`, { resource_id: van.id, start: at(from), end: at(to), revision: 1 });
    expect((await book('morning', 9, 12)).status).toBe(200);
    expect((await book('afternoon', 13, 17)).status).toBe(200);
    const join = (holder: string, extra: Record<string, unknown> = {}) =>
      call('POST', '/v1/waitlist', { resource_id: van.id, start: at(9), end: at(17), holder_ref: holder, duration_minutes: 120, ...extra });
    const first = (await join('first')).body.entry as { id: string; status: string; duration_minutes: number };
    const second = (await join('second')).body.entry as { id: string };
    expect(first).toMatchObject({ status: 'waiting', duration_minutes: 120 });
    expect(await feed(first.id)).toEqual(['waitlist.joined']);

    // Cancelling the afternoon frees 12:00-17:00: the first is offered its earliest two hours.
    expect((await call('DELETE', '/v1/reservations/afternoon?revision=2')).status).toBe(200);
    const offered = await entryOf(first.id);
    expect(offered).toMatchObject({ status: 'offered', offered_resource_id: van.id });
    const hold = (await call('GET', `/v1/holds/${offered?.hold_id as string}`)).body.hold as { start: string; end: string };
    expect([hold.start, hold.end]).toEqual([at(12), at(14)]);
    // The second is offered the rest of the afternoon.
    const next = await entryOf(second.id);
    expect(next).toMatchObject({ status: 'offered' });
    const nextHold = (await call('GET', `/v1/holds/${next?.hold_id as string}`)).body.hold as { start: string };
    expect(nextHold.start).toBe(at(14));

    // The first declines: its time goes to no one else waiting; the second accepts by confirming.
    const declined = await call('POST', `/v1/waitlist/${first.id}/decline`, {});
    expect(declined.body.entry).toMatchObject({ status: 'declined', decided_at: expect.any(String) });
    expect((await call('POST', `/v1/waitlist/${first.id}/decline`, {})).body).toMatchObject({ error: { code: 'waitlist_offer_not_found' } });
    expect((await call('POST', `/v1/holds/${next?.hold_id as string}/confirm`, {})).status).toBe(200);
    expect(await entryOf(second.id)).toMatchObject({ status: 'accepted' });
    expect(await feed(first.id)).toEqual(['waitlist.joined', 'waitlist.offered', 'waitlist.declined']);
    expect(await feed(second.id)).toEqual(['waitlist.joined', 'waitlist.offered', 'waitlist.accepted']);

    // An offer let run out lapses; leaving is on the feed.
    const third = (await join('third', { offer_ttl_seconds: 60, duration_minutes: 60 })).body.entry as { id: string };
    await call('POST', '/v1/maintenance', {});
    const lapsing = await entryOf(third.id);
    expect(lapsing).toMatchObject({ status: 'offered' });
    await sql`UPDATE slotlock.reservations SET expires_at = statement_timestamp() - interval '1 second' WHERE id = ${lapsing?.hold_id as string}`;
    await call('POST', '/v1/maintenance', {});
    expect(await entryOf(third.id)).toMatchObject({ status: 'lapsed' });
    expect((await feed(third.id)).slice(-1)).toEqual(['waitlist.lapsed']);
    expect((await call('DELETE', `/v1/waitlist/${third.id}`)).body).toEqual({ left: true });
    expect((await feed(third.id)).at(-1)).toBe('waitlist.left');
  });
});
