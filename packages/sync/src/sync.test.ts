// @slotlock/sync without a network: sealing, OAuth requests, reading each provider's answer, and
// telling the sync's own bookings from the calendar's.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_WINDOW_MS,
  ProviderError,
  beginAuthorization,
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
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.freebusy');
    expect(url.searchParams.get('code_challenge')).not.toBe(read.verifier);
    const write = new URL(beginAuthorization({ ...google, provider: 'microsoft', directory: 'org-1' }, { writeBack: true }).url);
    expect(write.pathname).toBe('/org-1/oauth2/v2.0/authorize');
    expect(write.searchParams.get('scope')).toBe('offline_access Calendars.ReadWrite');
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
