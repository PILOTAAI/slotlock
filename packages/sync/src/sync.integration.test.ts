// @slotlock/sync against a real Slotlock (in process, on real Postgres) and a fake Google: a
// connected calendar's busy time reaches the resource, a booking is written back and not read back
// as someone else's time, and a booking's event moved in the calendar is reported, never applied.
// Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer } from '../../../src/agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../../../src/agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../../../src/store.js';
import { createMemorySyncStore, createSyncer, parseSealKeys } from './index.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];

describe.skipIf(!url)('@slotlock/sync with Slotlock (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const tenantRef = `sync-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    'admin-key': { subject: 'api_key:sync', tenantRef, scopes: ['read', 'write', 'admin'] },
  };
  // Whole hours from the next one, so the sync's window (from now) covers them.
  const base = Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR;
  const at = (hour: number) => new Date(base + hour * HOUR);
  // The fake Google: one calendar's events, by id.
  const google = new Map<string, { start: string; end: string }>([['theirs', { start: at(2).toISOString(), end: at(3).toISOString() }]]);
  const googleFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (input === 'https://oauth2.googleapis.com/token') return json({ access_token: 'google-token', refresh_token: 'refresh', expires_in: 3600 });
    if (input === 'https://www.googleapis.com/calendar/v3/freeBusy') {
      return json({ calendars: { primary: { busy: [...google.values()].sort((a, b) => a.start.localeCompare(b.start)) } } });
    }
    const event = /\/calendars\/primary\/events(?:\/([^/]+))?$/.exec(input);
    if (event) {
      const body = init.body ? (JSON.parse(String(init.body)) as { id?: string; start?: { dateTime: string }; end?: { dateTime: string } }) : {};
      const id = event[1] ?? body.id ?? randomUUID();
      if (init.method === 'DELETE') return new Response(null, { status: google.delete(id) ? 204 : 404 });
      if (init.method === 'POST' && google.has(id)) return json({ error: { code: 409 } }, 409);
      google.set(id, { start: body.start?.dateTime ?? '', end: body.end?.dateTime ?? '' });
      return json({ id });
    }
    return json({ error: 'unexpected' }, 500);
  };
  const send = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    return target.startsWith(BASE) ? server.fetch(new Request(target, init)) : googleFetch(target, init);
  }) as typeof fetch;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: 'Bearer admin-key', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

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

  it('reads busy time in, writes bookings back, and reports what the calendar changed', async () => {
    const van = ((await call('POST', '/v1/resources', { external_ref: 'van-sync', timezone: 'UTC' })).body.resource as { id: string }).id;
    const syncer = createSyncer({
      store: createMemorySyncStore(),
      keys: parseSealKeys(`k1:${randomBytes(32).toString('base64')}`),
      slotlockUrl: BASE,
      clients: { google: { provider: 'google', clientId: 'id', clientSecret: 'secret', redirectUri: 'https://app.example/cb' } },
      fetch: send,
      windowDays: 7,
      now: () => new Date(base - HOUR),
    });
    await syncer.putTenant({ tenantRef, apiKey: 'admin-key' });
    const connection = await syncer.finishConnection({
      tenantRef,
      provider: 'google',
      account: 'fleet@example.com',
      code: 'code',
      verifier: 'verifier',
      writeBack: true,
    });
    expect(connection.sealed).not.toContain('google-token');
    const mapping = await syncer.mapCalendar({ connectionId: connection.id, calendarId: 'primary', resourceId: van });

    // Their time reaches Slotlock: a booking over it is refused.
    expect(await syncer.syncMapping(mapping)).toMatchObject({ ok: true, busy: 1, conflicts: 0 });
    expect((await call('PUT', '/v1/reservations/over', { resource_id: van, start: at(2).toISOString(), end: at(3).toISOString(), revision: 1 })).body).toMatchObject({
      error: { code: 'overlap' },
    });

    // A booking is written back, and not read back as someone else's.
    expect((await call('PUT', '/v1/reservations/bk-1', { resource_id: van, start: at(5).toISOString(), end: at(6).toISOString(), revision: 1 })).status).toBe(200);
    expect(await syncer.writeBackChanges()).toEqual({ written: 1, failed: [] });
    expect(google.size).toBe(2);
    expect(await syncer.syncMapping(mapping)).toMatchObject({ ok: true, busy: 1, conflicts: 0, drifted: [] });

    // Moved with Slotlock: moved in the calendar.
    expect((await call('PUT', '/v1/reservations/bk-1', { resource_id: van, start: at(7).toISOString(), end: at(8).toISOString(), revision: 2 })).status).toBe(200);
    expect((await syncer.writeBackChanges()).written).toBe(1);
    expect([...google.values()].some((event) => event.start === at(7).toISOString())).toBe(true);

    // Moved in the calendar instead: reported as the source's failure, and the time it moved to,
    // over another booking, comes back as a conflict. The booking stays where Slotlock has it.
    expect((await call('PUT', '/v1/reservations/bk-2', { resource_id: van, start: at(10).toISOString(), end: at(11).toISOString(), revision: 1 })).status).toBe(200);
    await syncer.writeBackChanges();
    const ours = [...google.entries()].find(([, event]) => event.start === at(7).toISOString());
    google.set(ours?.[0] as string, { start: at(10).toISOString(), end: at(11).toISOString() });
    const drifted = await syncer.syncMapping(mapping);
    expect(drifted).toMatchObject({ ok: true, conflicts: 0 });
    expect((drifted as { drifted: string[] }).drifted).toHaveLength(1);
    const coverage = (await call('GET', `/v1/resources/${van}/coverage`)).body.sources as { last_error: string | null }[];
    expect(coverage[0]?.last_error).toContain('Changed in the calendar');
    expect((await call('GET', '/v1/reservations/bk-1')).body.reservation).toMatchObject({ start: at(7).toISOString() });

    // Cancelled in Slotlock: gone from the calendar.
    expect((await call('DELETE', '/v1/reservations/bk-2?revision=2')).status).toBe(200);
    await syncer.writeBackChanges();
    expect([...google.values()].filter((event) => event.start === at(10).toISOString())).toHaveLength(1);
  });
});

