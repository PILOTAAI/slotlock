// @slotlock/sync without a network: sealing, OAuth requests, reading each provider's answer, and
// telling the sync's own bookings from the calendar's.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_WINDOW_MS,
  ProviderError,
  backoffMs,
  beginAuthorization,
  createMemorySyncStore,
  createSyncHttpHandler,
  createSyncer,
  readMicrosoftCalendarBusy,
  retryAfterMs,
  exchangeCode,
  googleWriter,
  open,
  parseSealKeys,
  readGoogleBusy,
  readIcsBusy,
  readMicrosoftBusy,
  seal,
  windowParts,
  withoutOwn,
} from './index.js';

const key = () => randomBytes(32).toString('base64');
const at = (iso: string) => new Date(iso);
type Call = { url: string; init: RequestInit };
const fakeFetch = (answer: (call: Call) => Response) => {
  const calls: Call[] = [];
  const send = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { send, calls };
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('seal', () => {
  it('opens what it sealed for the same context only, and with an older key', () => {
    const old = parseSealKeys(`k0:${key()}`);
    const sealed = seal(old, 'refresh-token', 'connection:a');
    expect(sealed.startsWith('v1.k0.')).toBe(true);
    expect(open(old, sealed, 'connection:a')).toBe('refresh-token');
    expect(() => open(old, sealed, 'connection:b')).toThrow();
    const rotated = parseSealKeys(`k1:${key()},k0:${old.keys.get('k0')?.toString('base64')}`);
    expect(open(rotated, sealed, 'connection:a')).toBe('refresh-token');
    expect(seal(rotated, 'x', 'c').startsWith('v1.k1.')).toBe(true);
    expect(() => parseSealKeys('k0:c2hvcnQ=')).toThrow();
    expect(() => open(old, `${sealed.slice(0, -2)}AA`, 'connection:a')).toThrow();
  });
});

describe('OAuth', () => {
  const google = { provider: 'google' as const, clientId: 'client', clientSecret: 'secret', redirectUri: 'https://app.example/cb' };

  it('asks with PKCE and a state, and for events only to write back', () => {
    const read = beginAuthorization(google, { writeBack: false });
    const url = new URL(read.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(read.state);
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.freebusy',
    );
    expect(url.searchParams.get('code_challenge')).not.toBe(read.verifier);
    const write = new URL(beginAuthorization({ ...google, provider: 'microsoft', directory: 'org-1' }, { writeBack: true }).url);
    expect(write.pathname).toBe('/org-1/oauth2/v2.0/authorize');
    expect(write.searchParams.get('scope')).toBe('offline_access User.Read Calendars.ReadWrite');
  });

  it('exchanges the code with its verifier', async () => {
    const { send, calls } = fakeFetch(() => json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' }));
    const tokens = await exchangeCode(google, { code: 'c', verifier: 'v' }, send);
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' });
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v', client_secret: 'secret' });
    const refused = fakeFetch(() => json({ error: 'invalid_grant' }, 400));
    await expect(exchangeCode(google, { code: 'c', verifier: 'v' }, refused.send)).rejects.toMatchObject({ code: 'invalid_grant' });
  });
});

describe('reading busy time', () => {
  const window = { start: at('2027-03-01T00:00:00Z'), end: at('2027-03-02T00:00:00Z') };

  it("reads Google's freeBusy, and its errors", async () => {
    const { send, calls } = fakeFetch(() =>
      json({ calendars: { primary: { busy: [{ start: '2027-03-01T09:00:00Z', end: '2027-03-01T10:00:00Z' }] } } }),
    );
    expect(await readGoogleBusy({ accessToken: 't', calendarId: 'primary', window, fetch: send })).toEqual([
      { start: at('2027-03-01T09:00:00Z'), end: at('2027-03-01T10:00:00Z') },
    ]);
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer t' });
    const missing = fakeFetch(() => json({ calendars: { primary: { errors: [{ reason: 'notFound' }] } } }));
    await expect(readGoogleBusy({ accessToken: 't', calendarId: 'primary', window, fetch: missing.send })).rejects.toThrow('notFound');
    const expired = fakeFetch(() => json({ error: { code: 401, message: 'Invalid Credentials' } }, 401));
    await expect(readGoogleBusy({ accessToken: 't', calendarId: 'primary', window, fetch: expired.send })).rejects.toBeInstanceOf(ProviderError);
  });

  it("reads Microsoft's schedule: busy, tentative and away are busy, working elsewhere is not", async () => {
    const { send } = fakeFetch(() =>
      json({
        value: [
          {
            scheduleItems: [
              { status: 'busy', start: { dateTime: '2027-03-01T09:00:00.0000000' }, end: { dateTime: '2027-03-01T10:00:00.0000000' } },
              { status: 'workingElsewhere', start: { dateTime: '2027-03-01T11:00:00.0000000' }, end: { dateTime: '2027-03-01T12:00:00.0000000' } },
              { status: 'oof', start: { dateTime: '2027-03-01T13:00:00.0000000' }, end: { dateTime: '2027-03-01T14:00:00.0000000' } },
            ],
          },
        ],
      }),
    );
    expect(await readMicrosoftBusy({ accessToken: 't', schedule: 'fleet@example.com', window, fetch: send })).toEqual([
      { start: at('2027-03-01T09:00:00Z'), end: at('2027-03-01T10:00:00Z') },
      { start: at('2027-03-01T13:00:00Z'), end: at('2027-03-01T14:00:00Z') },
    ]);
  });

  it('reads a long window in parts', () => {
    const parts = windowParts({ start: at('2027-01-01T00:00:00Z'), end: new Date(Date.parse('2027-01-01T00:00:00Z') + PROVIDER_WINDOW_MS * 2.5) });
    expect(parts).toHaveLength(3);
    expect(parts[1]?.start).toEqual(parts[0]?.end);
  });

  it('reads an iCalendar URL, refusing http and a feed with a series it cannot read', async () => {
    const { send } = fakeFetch(() => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200 }));
    const parse = () => ({
      changes: [
        { start: at('2027-03-01T09:00:00Z'), end: at('2027-03-01T10:00:00Z'), busy: true, deleted: false },
        { start: at('2027-03-01T11:00:00Z'), end: at('2027-03-01T12:00:00Z'), busy: false, deleted: false },
      ],
      refused: [],
    });
    expect(await readIcsBusy({ url: 'webcal://cal.example/a.ics', window, parse, fetch: send })).toHaveLength(1);
    await expect(readIcsBusy({ url: 'http://cal.example/a.ics', window, parse, fetch: send })).rejects.toThrow('https');
    await expect(readIcsBusy({ url: 'https://cal.example/a.ics', window, parse: () => ({ changes: [], refused: [{}] }), fetch: send })).rejects.toThrow(
      'could not be read',
    );
  });
});

describe('writing back', () => {
  it("names Google's event after the booking, so a retried insert makes no second one", async () => {
    let inserts = 0;
    const { send, calls } = fakeFetch((call) => {
      if (call.init.method === 'POST') return json({}, ++inserts === 1 ? 200 : 409);
      return json({});
    });
    const writer = googleWriter(async () => 'token', send);
    const interval = { start: at('2027-03-01T09:00:00Z'), end: at('2027-03-01T10:00:00Z') };
    const first = await writer.create({ calendarId: 'primary', interval, title: 'Busy', bookingKey: 'reservation:1' });
    const again = await writer.create({ calendarId: 'primary', interval, title: 'Busy', bookingKey: 'reservation:1' });
    expect(again).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // The retry finds it there and puts it at this time.
    expect(calls.map((call) => call.init.method)).toEqual(['POST', 'POST', 'PATCH']);
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty('description');
  });

  it("subtracts only the sync's own bookings from what the calendar says", () => {
    const busy = [{ start: at('2027-03-01T09:00:00Z'), end: at('2027-03-01T12:00:00Z') }];
    expect(withoutOwn(busy, [{ start: at('2027-03-01T10:00:00Z'), end: at('2027-03-01T11:00:00Z') }])).toEqual([
      { start: at('2027-03-01T09:00:00Z'), end: at('2027-03-01T10:00:00Z') },
      { start: at('2027-03-01T11:00:00Z'), end: at('2027-03-01T12:00:00Z') },
    ]);
    expect(withoutOwn(busy, [{ start: at('2027-03-01T08:00:00Z'), end: at('2027-03-01T13:00:00Z') }])).toEqual([]);
  });
});

describe("Microsoft calendars and providers' limits", () => {
  const window = { start: at('2027-03-01T00:00:00Z'), end: at('2027-03-02T00:00:00Z') };

  it("reads one of the account's calendars, every page, times only", async () => {
    const { send, calls } = fakeFetch((call) =>
      call.url.includes('skiptoken')
        ? json({ value: [{ showAs: 'oof', isCancelled: false, start: { dateTime: '2027-03-01T13:00:00.0000000' }, end: { dateTime: '2027-03-01T14:00:00.0000000' } }] })
        : json({
            value: [
              { showAs: 'busy', isCancelled: false, start: { dateTime: '2027-03-01T09:00:00.0000000' }, end: { dateTime: '2027-03-01T10:00:00.0000000' } },
              { showAs: 'busy', isCancelled: true, start: { dateTime: '2027-03-01T10:00:00.0000000' }, end: { dateTime: '2027-03-01T11:00:00.0000000' } },
              { showAs: 'free', isCancelled: false, start: { dateTime: '2027-03-01T11:00:00.0000000' }, end: { dateTime: '2027-03-01T12:00:00.0000000' } },
            ],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendar/calendarView?$skiptoken=2',
          }),
    );
    expect(await readMicrosoftCalendarBusy({ accessToken: 't', calendarId: 'primary', window, fetch: send })).toEqual([
      { start: at('2027-03-01T09:00:00Z'), end: at('2027-03-01T10:00:00Z') },
      { start: at('2027-03-01T13:00:00Z'), end: at('2027-03-01T14:00:00Z') },
    ]);
    expect(calls[0]?.url).toContain('/me/calendar/calendarView?');
    expect(calls[0]?.url).toContain('%24select=start%2Cend%2CshowAs%2CisCancelled');
    // A next link elsewhere than Graph is not followed.
    const elsewhere = fakeFetch(() => json({ value: [], '@odata.nextLink': 'https://evil.example/steal' }));
    await readMicrosoftCalendarBusy({ accessToken: 't', calendarId: 'AAMk1', window, fetch: elsewhere.send });
    expect(elsewhere.calls).toHaveLength(1);
    expect(elsewhere.calls[0]?.url).toContain('/me/calendars/AAMk1/calendarView?');
    await expect(readMicrosoftBusy({ accessToken: 't', schedule: 'me', window, fetch: elsewhere.send })).rejects.toThrow('mailbox address');
  });

  it('waits as long as a provider asks, and backs off on its own otherwise', async () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs(new Date(Date.now() + 30_000).toUTCString())).toBeGreaterThan(20_000);
    expect(retryAfterMs('soon')).toBeNull();
    const slow = fakeFetch(() => new Response('{}', { status: 429, headers: { 'retry-after': '90' } }));
    await expect(readGoogleBusy({ accessToken: 't', calendarId: 'primary', window, fetch: slow.send })).rejects.toMatchObject({ retryAfterMs: 90_000 });
    expect([1, 2, 3, 20].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 6 * 60 * 60 * 1_000]);
  });
});

describe('the HTTP surface', () => {
  const keys = parseSealKeys(`k1:${key()}`);
  const setup = () => {
    const store = createMemorySyncStore();
    const { send } = fakeFetch(() => json({}));
    const syncer = createSyncer({
      store,
      keys,
      slotlockUrl: 'http://slotlock.test',
      clients: { google: { provider: 'google', clientId: 'id', clientSecret: 'secret', redirectUri: 'https://sync.example/oauth/callback' } },
      fetch: send,
    });
    const handler = createSyncHttpHandler({ syncer, store, adminToken: 'a'.repeat(40), linkSecret: 'l'.repeat(40), publicUrl: 'https://sync.example' });
    const call = (method: string, path: string, body?: unknown, token = 'a'.repeat(40)) =>
      handler(
        new Request(`https://sync.example${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    return { store, handler, call };
  };

  it("keeps the operator's routes behind its token", async () => {
    const { call } = setup();
    expect((await call('PUT', '/v1/tenants/fleet', { api_key: 'slk_0123456789abcdef' }, 'wrong')).status).toBe(401);
    expect((await call('PUT', '/v1/tenants/fleet', { api_key: 'slk_0123456789abcdef' })).status).toBe(200);
    expect((await call('POST', '/v1/tenants/nobody/connect-links', { provider: 'google', write_back: true })).status).toBe(404);
    expect(() => createSyncHttpHandler({ syncer: {} as never, store: {} as never, adminToken: 'short', linkSecret: 'l'.repeat(40), publicUrl: 'https://x' })).toThrow();
  });

  it('sends a person with a signed link to the provider, and refuses a changed or old link', async () => {
    const { call, handler, store } = setup();
    await call('PUT', '/v1/tenants/fleet', { api_key: 'slk_0123456789abcdef' });
    const link = (await (await call('POST', '/v1/tenants/fleet/connect-links', { provider: 'google', write_back: false })).json()) as { url: string };
    const followed = await handler(new Request(link.url));
    expect(followed.status).toBe(302);
    const provider = new URL(followed.headers.get('location') as string);
    expect(provider.origin).toBe('https://accounts.google.com');
    expect(provider.searchParams.get('redirect_uri')).toBe('https://sync.example/oauth/callback');
    // The state is kept as a digest, used once.
    const state = provider.searchParams.get('state') as string;
    expect(await store.takeOAuthState(state, new Date())).toBeNull();
    // A link is followed once: opened again (forwarded, or found in a history), it is refused.
    expect((await handler(new Request(link.url))).status).toBe(400);
    // The flow is finished only in the browser that began it: without its cookie, or with
    // another's, the callback is refused, and the state is spent.
    const again = (await (await call('POST', '/v1/tenants/fleet/connect-links', { provider: 'google', write_back: false })).json()) as { url: string };
    const begun = await handler(new Request(again.url));
    const theirs = new URL(begun.headers.get('location') as string).searchParams.get('state') as string;
    const elsewhere = await handler(new Request(`https://sync.example/oauth/callback?state=${theirs}&code=c`));
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).toContain('Open the link in this browser');
    expect(
      (await handler(new Request(`https://sync.example/oauth/callback?state=${theirs}&code=c`, { headers: { cookie: 'slotlock_sync_flow=another' } })))
        .status,
    ).toBe(400);
    expect(begun.headers.get('set-cookie')).toContain('; Secure');
    const tampered = link.url.replace(/link=([^.]+)\./, (_, payload: string) => `link=${payload.slice(0, -2)}AA.`);
    expect((await handler(new Request(tampered))).status).toBe(400);
    const page = await handler(new Request('https://sync.example/oauth/callback?state=unknown&code=c'));
    expect(page.status).toBe(400);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const forged = await handler(
      new Request(`https://sync.example/connections/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/choose`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'expires=9999999999999&token=x&calendar_0=primary&resource_0=r',
      }),
    );
    expect(forged.status).toBe(400);
  });
});

describe('the syncer, where a calendar or a connection fails', () => {
  const keys = parseSealKeys(`k1:${key()}`);
  const sealedFor = (tenantRef: string, id: string) => `connection:${JSON.stringify([tenantRef, id])}`;
  const tokens = (expiresAt: string) => JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt, scope: '' });
  const mapping = (id: string, connectionId: string, calendarId: string, tenantRef = 'fleet') => ({
    id, tenantRef, connectionId, calendarId, resourceId: 'van-1', source: `google:${calendarId}`,
    revision: 0, lastSyncedAt: null, lastError: null, retryAt: null, failures: 0,
  });
  const make = (answer: (call: { url: string; init: RequestInit }) => Response | Promise<Response>) => {
    const store = createMemorySyncStore();
    const calls: string[] = [];
    const send = (async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${String(url)}`);
      return answer({ url: String(url), init });
    }) as typeof fetch;
    const syncer = createSyncer({
      store,
      keys,
      slotlockUrl: 'http://slotlock.test',
      clients: { google: { provider: 'google', clientId: 'id', clientSecret: 'secret', redirectUri: 'https://sync.example/oauth/callback' } },
      fetch: send,
    });
    return { store, syncer, calls };
  };
  const connect = async (store: ReturnType<typeof createMemorySyncStore>, id: string, tenantRef = 'fleet', expiresAt = '2999-01-01T00:00:00Z') =>
    store.putConnection({ id, tenantRef, provider: 'google', account: `${id}@example.com`, writeBack: true, sealed: seal(keys, tokens(expiresAt), sealedFor(tenantRef, id)) });
  const booked = {
    id: 'chg-1', type: 'reservation.created', subject: 'bk-1', time: '2027-01-01T00:00:00Z',
    data: { id: 'bk-1', reference: 'bk-1', resource_id: 'van-1', start: '2027-03-01T09:00:00Z', end: '2027-03-01T10:00:00Z' },
  };

  it("writes a booking to every calendar it can, one that refuses for good being that mapping's failure alone", async () => {
    let held = 403;
    const { store, syncer } = make(({ url }) => {
      if (url.includes(encodeURIComponent('holidays'))) return json({ error: {} }, held);
      return json({ id: 'evt' });
    });
    await syncer.putTenant({ tenantRef: 'fleet', apiKey: 'slk_0123456789abcdef' });
    await connect(store, 'c1');
    await store.putMapping(mapping('m-holidays', 'c1', 'holidays'));
    await store.putMapping(mapping('m-main', 'c1', 'main'));
    const failed = new Set<string>();
    // Read only (403): the other calendar is written, and the change is done with.
    expect(await syncer.writeBack('fleet', booked, failed)).toBe(1);
    expect([...failed]).toEqual(['m-holidays']);
    expect(await store.getWriteBack('m-main', 'reservation:bk-1')).not.toBeNull();
    // One that may answer later (503) stops the read there, to be tried again.
    held = 503;
    await expect(syncer.writeBack('fleet', { ...booked, data: { ...booked.data, id: 'bk-2', reference: 'bk-2' } })).rejects.toThrow('503');
  });

  it('keeps a connection disconnected while its token was refreshed gone, and reads only its own tenant\'s', async () => {
    const { store, syncer, calls } = make(({ url }) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        // Disconnected while the refresh was under way.
        void store.deleteConnection('c-gone');
        return json({ access_token: 'fresh', refresh_token: 'rt2', expires_in: 3600, scope: '' });
      }
      return json({});
    });
    await syncer.putTenant({ tenantRef: 'fleet', apiKey: 'slk_0123456789abcdef' });
    await syncer.putTenant({ tenantRef: 'other', apiKey: 'slk_fedcba9876543210' });
    await connect(store, 'c-gone', 'fleet', '2000-01-01T00:00:00Z');
    await store.putMapping(mapping('m-gone', 'c-gone', 'main'));
    expect(await syncer.syncMapping('m-gone', true)).toMatchObject({ ok: false });
    expect(await store.getConnection('c-gone')).toBeNull();
    // A mapping of another tenant pointing at this tenant's connection reads nothing of it.
    await connect(store, 'c-fleet');
    await store.putMapping(mapping('m-other', 'c-fleet', 'main', 'other'));
    calls.length = 0;
    expect(await syncer.syncMapping('m-other', true)).toMatchObject({ ok: false, error: 'connection_not_found' });
    expect(calls.filter((call) => call.includes('googleapis.com'))).toEqual([]);
    // Tokens sealed for one tenant do not open as another's, though the row says so.
    const sealed = (await store.getConnection('c-fleet'))?.sealed as string;
    expect(() => open(keys, sealed, sealedFor('other', 'c-fleet'))).toThrow();
  });

  it('reads an iCalendar URL only through the guarded fetch, and with a parser that answers later', async () => {
    const parse = async () => ({ changes: [], refused: [] });
    expect(() => createSyncer({ store: createMemorySyncStore(), keys, slotlockUrl: 'http://slotlock.test', parseICalendar: parse })).toThrow(
      'icsFetch is needed',
    );
    const { send } = fakeFetch(() => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'));
    const busy = await readIcsBusy({
      url: 'https://cal.example/feed.ics',
      window: { start: at('2027-01-01T00:00:00Z'), end: at('2027-02-01T00:00:00Z') },
      parse: async () => ({ changes: [{ start: at('2027-01-02T09:00:00Z'), end: at('2027-01-02T10:00:00Z'), busy: true, deleted: false }], refused: [] }),
      fetch: send,
    });
    expect(busy).toEqual([{ start: at('2027-01-02T09:00:00Z'), end: at('2027-01-02T10:00:00Z') }]);
  });
});

describe('withoutTrailingSlashes', () => {
  it('drops every trailing slash and nothing else, in time linear in the value', async () => {
    const { withoutTrailingSlashes } = await import('./slotlock-api.js');
    expect(withoutTrailingSlashes('https://slotlock.example.com///')).toBe('https://slotlock.example.com');
    expect(withoutTrailingSlashes('https://slotlock.example.com/api')).toBe('https://slotlock.example.com/api');
    expect(withoutTrailingSlashes('///')).toBe('');
    // Many slashes not at the end: what made /\/+$/ quadratic.
    const crafted = `${'/'.repeat(200_000)}x`;
    const started = performance.now();
    expect(withoutTrailingSlashes(crafted)).toBe(crafted);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
