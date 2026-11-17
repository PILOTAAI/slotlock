// @slotlock/sync against a real Slotlock (in process, on real Postgres) and a fake Google, through
// its HTTP surface: a person connects with a signed link and chooses a calendar for a resource; the
// calendar's busy time reaches the resource; bookings are written back and not read back as someone
// else's; a booking moved in the calendar is reported on Slotlock's feed once and never applied; an
// expired feed cursor is recovered by reconciling; disconnecting removes what was written, retires
// the source and revokes the token. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer } from '../../../src/agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../../../src/agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../../../src/store.js';
import { createPostgresSyncStore, createSyncHttpHandler, createSyncer, parseSealKeys } from './index.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const SYNC = 'https://sync.example';
const HOUR = 3_600_000;
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];
const ADMIN = 'o'.repeat(40);

describe.skipIf(!url)('@slotlock/sync with Slotlock (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const tenantRef = `sync-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    'admin-key-0123456789': { subject: 'api_key:sync', tenantRef, scopes: ['read', 'write', 'admin'] },
  };
  // Whole hours from tomorrow, so the sync's window (from now) covers them.
  const base = Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR;
  const at = (hour: number) => new Date(base + hour * HOUR);
  // The fake Google: one calendar's events by id, the tokens revoked, and Slotlock's feed answering
  // 410 for a cursor said to have expired.
  const google = new Map<string, { start: string; end: string; status?: string }>([
    ['theirs', { start: at(2).toISOString(), end: at(3).toISOString() }],
  ]);
  const revoked: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  // What the person allowed on Google's consent page (granular consent lets them untick one).
  let granted = [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.freebusy',
    'https://www.googleapis.com/auth/calendar.events',
  ];
  const googleFetch = async (target: string, init: RequestInit = {}): Promise<Response> => {
    if (target === 'https://oauth2.googleapis.com/token') {
      return json({ access_token: 'google-token', refresh_token: 'refresh', expires_in: 3600, scope: granted.join(' ') });
    }
    if (target === 'https://oauth2.googleapis.com/revoke') {
      revoked.push(new URLSearchParams(String(init.body)).get('token') as string);
      return json({});
    }
    if (target.startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList')) {
      return json({ items: [{ id: 'fleet@example.com', summary: 'Fleet', primary: true, accessRole: 'owner' }] });
    }
    if (target === 'https://www.googleapis.com/calendar/v3/freeBusy') {
      const live = [...google.values()].filter((event) => event.status !== 'cancelled');
      return json({ calendars: { 'fleet@example.com': { busy: live.map(({ start, end }) => ({ start, end })).sort((a, b) => a.start.localeCompare(b.start)) } } });
    }
    const event = /\/calendars\/fleet%40example\.com\/events(?:\/([^/?]+))?/.exec(target);
    if (event) {
      const body = init.body ? (JSON.parse(String(init.body)) as { id?: string; start?: { dateTime: string }; end?: { dateTime: string } }) : {};
      const id = event[1] ? decodeURIComponent(event[1]) : (body.id ?? randomUUID());
      if (init.method === 'DELETE') return new Response(null, { status: google.delete(id) ? 204 : 404 });
      if (!init.method || init.method === 'GET') {
        const found = google.get(id);
        return found ? json({ status: found.status ?? 'confirmed', start: { dateTime: found.start }, end: { dateTime: found.end } }) : json({}, 404);
      }
      if (init.method === 'POST' && google.has(id)) return json({ error: { code: 409 } }, 409);
      google.set(id, { start: body.start?.dateTime ?? google.get(id)?.start ?? '', end: body.end?.dateTime ?? google.get(id)?.end ?? '' });
      return json({ id });
    }
    return json({ error: 'unexpected' }, 500);
  };
  const send = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('cursor=expired-cursor')) return json({ error: { code: 'cursor_expired' } }, 410);
    return target.startsWith(BASE) ? server.fetch(new Request(target, init)) : googleFetch(target, init);
  }) as typeof fetch;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: 'Bearer admin-key-0123456789', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const conflicts = async () =>
    sql<{ data: Record<string, unknown> }[]>`
      SELECT data FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} AND type = 'coverage.conflict' ORDER BY id`;

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
    await sql`DELETE FROM slotlock_sync.tenants WHERE tenant_ref = ${tenantRef}`;
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('connects through its pages, keeps calendars and bookings in step, and reports what the calendar changed', async () => {
    const van = ((await call('POST', '/v1/resources', { external_ref: 'van-sync', timezone: 'UTC', name: 'Van 7' })).body.resource as { id: string }).id;
    const syncStore = createPostgresSyncStore(sql);
    await syncStore.applySchema();
    const syncer = createSyncer({
      store: syncStore,
      keys: parseSealKeys(`k1:${randomBytes(32).toString('base64')}`),
      slotlockUrl: BASE,
      clients: { google: { provider: 'google', clientId: 'id', clientSecret: 'secret', redirectUri: `${SYNC}/oauth/callback` } },
      fetch: send,
      windowDays: 7,
      now: () => new Date(base - HOUR),
    });
    const http = createSyncHttpHandler({ syncer, store: syncStore, adminToken: ADMIN, linkSecret: 'l'.repeat(40), publicUrl: SYNC, now: () => new Date(base - HOUR) });
    const operator = (method: string, path: string, body?: unknown) =>
      http(
        new Request(`${SYNC}${path}`, {
          method,
          headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );

    // The operator keeps the tenant's key and makes a link; the person follows it, comes back, and
    // chooses the calendar for the van.
    expect((await operator('PUT', `/v1/tenants/${tenantRef}`, { api_key: 'admin-key-0123456789' })).status).toBe(200);
    // A person who unticked writing events connects nothing to a link that writes bookings back.
    const unticked = (await (await operator('POST', `/v1/tenants/${tenantRef}/connect-links`, { provider: 'google', write_back: true })).json()) as { url: string };
    const tried = await http(new Request(unticked.url));
    granted = granted.filter((scope) => !scope.endsWith('calendar.events'));
    const refused = await http(
      new Request(`${SYNC}/oauth/callback?state=${new URL(tried.headers.get('location') as string).searchParams.get('state')}&code=c`, {
        headers: { cookie: (tried.headers.get('set-cookie') ?? '').split(';')[0] as string },
      }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('allow each calendar permission');
    granted = [...granted, 'https://www.googleapis.com/auth/calendar.events'];
    const link = (await (await operator('POST', `/v1/tenants/${tenantRef}/connect-links`, { provider: 'google', write_back: true })).json()) as { url: string };
    const followed = await http(new Request(link.url));
    const toGoogle = new URL(followed.headers.get('location') as string);
    // The browser that followed the link holds the flow's cookie, sent back only to the callback.
    const cookie = (followed.headers.get('set-cookie') ?? '').split(';')[0] as string;
    expect(followed.headers.get('set-cookie')).toMatch(/^slotlock_sync_flow=[\w-]{43}; Path=\/oauth\/callback; Max-Age=600; HttpOnly; SameSite=Lax/);
    const back = (url: string, headers: Record<string, string> = { cookie }) => http(new Request(url, { headers }));
    const callback = await back(`${SYNC}/oauth/callback?state=${toGoogle.searchParams.get('state')}&code=the-code`);
    const form = await callback.text();
    expect(callback.status).toBe(200);
    expect(form).toContain('Fleet (main calendar)');
    expect(form).toContain('Van 7');
    expect(form).not.toContain('google-token');
    // The state is used once.
    expect((await back(`${SYNC}/oauth/callback?state=${toGoogle.searchParams.get('state')}&code=the-code`)).status).toBe(400);
    const action = /action="([^"]+)"/.exec(form)?.[1] as string;
    const fields = Object.fromEntries([...form.matchAll(/name="(expires|token)" value="([^"]+)"/g)].map((match) => [match[1], match[2]]));
    const saved = await http(
      new Request(action.replaceAll('&amp;', '&'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...fields, calendar_0: 'fleet@example.com', resource_0: van }).toString(),
      }),
    );
    expect(await saved.text()).toContain('Fleet → Van 7');
    const listed = (await (await operator('GET', `/v1/tenants/${tenantRef}/connections`)).json()) as {
      connections: { id: string; account: string; mappings: { id: string }[] }[];
    };
    const [connection] = listed.connections;
    expect(connection).toMatchObject({ account: 'fleet@example.com' });
    const mappingId = connection?.mappings[0]?.id as string;

    // Their time reaches Slotlock: a booking over it is refused.
    expect(await syncer.syncMapping(mappingId)).toMatchObject({ ok: true, busy: 1, conflicts: 0 });
    expect((await call('PUT', '/v1/reservations/over', { resource_id: van, start: at(2).toISOString(), end: at(3).toISOString(), revision: 1 })).body).toMatchObject({
      error: { code: 'overlap' },
    });

    // A booking is written back, and not read back as someone else's.
    expect((await call('PUT', '/v1/reservations/bk-1', { resource_id: van, start: at(5).toISOString(), end: at(6).toISOString(), revision: 1 })).status).toBe(200);
    expect(await syncer.writeBackChanges()).toMatchObject({ written: 1, failed: [] });
    expect(google.size).toBe(2);
    expect(await syncer.syncMapping(mappingId)).toMatchObject({ ok: true, busy: 1, conflicts: 0, drifted: [] });

    // Moved in the calendar: on Slotlock's feed once, with where the calendar has it; the booking stays.
    const [ours] = [...google.entries()].filter(([id]) => id !== 'theirs');
    google.set(ours?.[0] as string, { start: at(8).toISOString(), end: at(9).toISOString() });
    expect((await syncer.syncMapping(mappingId)) as { drifted: string[] }).toMatchObject({ ok: true });
    await syncer.syncMapping(mappingId);
    const reported = await conflicts();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.data).toMatchObject({ reason: 'changed_in_calendar', reference: 'bk-1' });
    expect(Date.parse(reported[0]?.data.calendar_start as string)).toBe(at(8).getTime());
    expect((await call('GET', '/v1/reservations/bk-1')).body.reservation).toMatchObject({ start: at(5).toISOString() });
    // Removed there too: reported again, as removed.
    google.delete(ours?.[0] as string);
    await syncer.syncMapping(mappingId);
    expect((await conflicts()).map((row) => row.data.reason)).toEqual(['changed_in_calendar', 'removed_from_calendar']);

    // The feed's cursor expired while the sync was away: reconciled from the bookings as they are,
    // the removed one written again, and one booked meanwhile written too.
    expect((await call('PUT', '/v1/reservations/bk-2', { resource_id: van, start: at(10).toISOString(), end: at(11).toISOString(), revision: 1 })).status).toBe(200);
    await syncStore.setCursor(tenantRef, 'expired-cursor');
    expect(await syncer.writeBackChanges()).toMatchObject({ reconciled: [tenantRef], failed: [] });
    const times = () => [...google.values()].map((event) => event.start).sort();
    expect(times()).toEqual([at(2), at(5), at(10)].map((date) => date.toISOString()));

    // Disconnected: what it wrote is taken off the calendar, the source retired, the token revoked.
    const removed = (await (await operator('DELETE', `/v1/connections/${connection?.id}`)).json()) as { removed: number; sources: number };
    expect(removed).toMatchObject({ removed: 2, sources: 1 });
    expect(times()).toEqual([at(2).toISOString()]);
    expect((await call('GET', `/v1/resources/${van}/coverage`)).body.sources).toEqual([]);
    expect(revoked).toEqual(['refresh']);
  });
});
