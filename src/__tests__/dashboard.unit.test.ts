// The dashboard without a database: GitHub sign-in (state + PKCE), sealed sessions, CSRF and origin
// checks, the key shown once, escaping, and the allowlist. GitHub is a fake `fetch`; keys and
// resources are in-memory stores with the same contracts as the real ones.
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CreateSlotlockApiKeyInput,
  type SlotlockApiKey,
  type SlotlockApiKeyStore,
  generateSlotlockApiKey,
} from '../api-keys.js';
import {
  SLOTLOCK_DASHBOARD_MAX_RESOURCES,
  type SlotlockDashboardResources,
  type SlotlockDashboardState,
  createSlotlockDashboard,
  createSlotlockMemoryDashboardState,
} from '../dashboard.js';
import { SLOTLOCK_DASHBOARD_FORM_LIMIT } from '../ddl.js';
import type { SlotlockChange, SlotlockWebhookEndpoint } from '../event-feed.js';
import type { SlotlockWaitlistEntry } from '../store.js';
import type { SlotlockAgendaEntry, SlotlockResource, WeeklyAvailabilityRule } from '../types.js';

const PUBLIC_URL = 'https://slotlock.example.com/base';
const ORIGIN = 'https://slotlock.example.com';
const DASHBOARD = `${PUBLIC_URL}/dashboard`;
const SESSION_SECRET = '7f3c9a1e5b2d8f604a9c1e7b3d5f2a8c6e0b4d9f1a3c5e7b9d2f4a6c8e0b1d3f';
const GITHUB_USER = { id: 4242, login: 'octocat' };

function memoryKeys() {
  const rows = new Map<string, SlotlockApiKey & { key: string }>();
  const issue = (apiKey: Omit<SlotlockApiKey, 'prefix'>) => {
    const { key, prefix } = generateSlotlockApiKey();
    const row = { ...apiKey, prefix, key };
    rows.set(apiKey.id, row);
    const { key: _key, ...listed } = row;
    return { key, apiKey: listed };
  };
  const strip = ({ key: _key, ...listed }: SlotlockApiKey & { key: string }) => listed;
  const store = {
    create: vi.fn(async (input: CreateSlotlockApiKeyInput) => {
      if (input.name.trim() === '' || input.name.length > 100) {
        throw Object.assign(new Error('bad name'), { code: 'invalid_api_key_name' });
      }
      return issue({
        id: randomUUID(),
        tenantRef: input.tenantRef,
        name: input.name.trim(),
        scopes: [...input.scopes],
        createdBy: input.createdBy ?? null,
        createdAt: new Date(),
        expiresAt: input.expiresAt ?? null,
        lastUsedAt: null,
        revokedAt: null,
      });
    }),
    list: vi.fn(async ({ tenantRef }: { tenantRef: string }) =>
      [...rows.values()].filter((row) => row.tenantRef === tenantRef).map(strip),
    ),
    rotate: vi.fn(async ({ tenantRef, id }: { tenantRef: string; id: string }) => {
      const row = rows.get(id);
      if (!row || row.tenantRef !== tenantRef || row.revokedAt) return null;
      const { key: _old, prefix: _prefix, ...rest } = row;
      return issue(rest);
    }),
    revoke: vi.fn(async ({ tenantRef, id }: { tenantRef: string; id: string }) => {
      const row = rows.get(id);
      if (!row || row.tenantRef !== tenantRef) return null;
      row.revokedAt ??= new Date();
      return strip(row);
    }),
    authenticate: vi.fn(async () => null),
    erase: vi.fn(async () => 0),
  } satisfies SlotlockApiKeyStore;
  return { store, rows };
}

function memoryResources() {
  const rows: Array<SlotlockResource & { tenantRef: string }> = [];
  return {
    rows,
    store: {
      list: vi.fn(async (tenantRef: string) => rows.filter((row) => row.tenantRef === tenantRef)),
      add: vi.fn(async (tenantRef: string, externalRef: string, timezone: string) => {
        if (timezone === 'Mars/Olympus') {
          throw Object.assign(new Error('bad zone'), { code: 'invalid_timezone' });
        }
        const owned = rows.filter((row) => row.tenantRef === tenantRef);
        const existing = owned.find((row) => row.externalRef === externalRef);
        if (existing) {
          existing.timezone = timezone;
          return existing as unknown as SlotlockResource;
        }
        // The real adapter holds the cap in the database (dashboard-state.integration.test.ts).
        if (owned.length >= SLOTLOCK_DASHBOARD_MAX_RESOURCES) {
          throw Object.assign(new Error('cap'), { code: 'resource_limit_reached' });
        }
        const resource = {
          id: randomUUID(),
          externalRef,
          tenantRef,
          timezone,
          createdAt: new Date(),
        };
        rows.push(resource as SlotlockResource & { tenantRef: string });
        return resource as unknown as SlotlockResource;
      }),
      // Like the store: only the tenant's own resources change, and the count says how many did.
      setHours: vi.fn(
        async (
          tenantRef: string,
          target: { id: string } | 'all',
          rules: WeeklyAvailabilityRule[] | null,
        ) => {
          const changed = rows.filter(
            (row) => row.tenantRef === tenantRef && (target === 'all' || row.id === target.id),
          );
          for (const row of changed) {
            if (rules === null) delete row.availabilityRules;
            else row.availabilityRules = rules.map((rule) => ({ ...rule }));
          }
          return changed.length;
        },
      ),
    } satisfies SlotlockDashboardResources,
  };
}

/** GitHub's token and user endpoints, recording what the dashboard sent. */
function fakeGitHub(user: { id: unknown; login: unknown } = GITHUB_USER) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === 'https://github.com/login/oauth/access_token') {
      return Response.json({ access_token: 'gho_fake', token_type: 'bearer', scope: '' });
    }
    if (url === 'https://api.github.com/user') return Response.json(user);
    return new Response('not found', { status: 404 });
  });
  return { fetch, calls };
}

let now = Date.UTC(2026, 9, 10, 12);
let keys: ReturnType<typeof memoryKeys>;
let resources: ReturnType<typeof memoryResources>;
let github: ReturnType<typeof fakeGitHub>;

function dashboard(overrides: Partial<Parameters<typeof createSlotlockDashboard>[0]> = {}) {
  return createSlotlockDashboard({
    publicUrl: PUBLIC_URL,
    github: {
      clientId: 'Ov23liFakeClientId00',
      clientSecret: 'f'.repeat(20) + '0123456789abcdef0123',
    },
    sessionSecret: SESSION_SECRET,
    allowedUsers: [String(GITHUB_USER.id)],
    keys: keys.store,
    resources: resources.store,
    availability: [
      { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 540, durationMinutes: 480 },
    ],
    state: createSlotlockMemoryDashboardState(() => now),
    fetch: github.fetch,
    now: () => now,
    ...overrides,
  });
}

const get = (target: ReturnType<typeof dashboard>, path: string, cookie?: string) =>
  target.fetch(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {}));

/**
 * Every form but sign-out carries a single-use value: one is taken from a fresh dashboard page
 * unless the fields give their own, or `once` is 'none' to send the form without it.
 */
async function post(
  target: ReturnType<typeof dashboard>,
  path: string,
  fields: Record<string, string>,
  cookie: string,
  origin: string | null = ORIGIN,
  once: 'fresh' | 'none' = 'fresh',
) {
  const sent = { ...fields };
  if (once === 'fresh' && !('once' in sent) && !path.endsWith('/sign-out') && cookie) {
    const page = await (await get(target, '/base/dashboard/keys', cookie)).text();
    const value = /name="once" value="([^"]+)"/.exec(page)?.[1];
    if (value !== undefined) sent.once = value;
  }
  const headers: Record<string, string> = {
    cookie,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (origin !== null) headers.origin = origin;
  return target.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(sent).toString(),
    }),
  );
}

/** `name=value` of a Set-Cookie header, and its attributes. */
function cookie(response: Response, name: string) {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!header) return undefined;
  const [pair, ...attributes] = header.split('; ');
  return { pair: pair as string, attributes };
}

async function signIn(target = dashboard()) {
  const start = await get(target, '/base/dashboard/sign-in');
  const location = new URL(start.headers.get('location') ?? '');
  const oauth = cookie(start, '__Host-slotlock-oauth');
  const callback = await get(
    target,
    `/base/dashboard/callback?code=fake-code&state=${location.searchParams.get('state')}`,
    oauth?.pair,
  );
  const session = cookie(callback, '__Host-slotlock-session');
  return { start, location, oauth, callback, session: session?.pair as string };
}

/** The CSRF token a signed-in page puts in its forms. */
async function csrf(target: ReturnType<typeof dashboard>, session: string) {
  const html = await (await get(target, '/base/dashboard', session)).text();
  return /name="csrf" value="([^"]+)"/.exec(html)?.[1] as string;
}

beforeEach(() => {
  now = Date.UTC(2026, 9, 10, 12);
  keys = memoryKeys();
  resources = memoryResources();
  github = fakeGitHub();
});

describe('dashboard routes and headers', () => {
  it('handles only its own paths under the public URL', () => {
    const target = dashboard();
    for (const path of ['/base/dashboard', '/base/dashboard/', '/base/dashboard/keys']) {
      expect(target.handles(new Request(`${ORIGIN}${path}`)), path).toBe(true);
    }
    for (const path of ['/base/mcp', '/dashboard', '/base/dashboards', '/base']) {
      expect(target.handles(new Request(`${ORIGIN}${path}`)), path).toBe(false);
    }
  });

  it('offers GitHub sign-in to a visitor, under a policy that runs no inline code', async () => {
    const response = await get(dashboard(), '/base/dashboard');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // A browser sends `Origin: null` with form POSTs under `no-referrer`, and the origin check
    // refuses that; `same-origin` keeps the referrer from every other site all the same.
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    const html = await response.text();
    expect(html).toContain('<meta name="referrer" content="same-origin">');
    expect(html).toContain('href="/base/dashboard/sign-in"');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/i);
  });

  it('serves its stylesheet and script under content-versioned URLs', async () => {
    const html = await (await get(dashboard(), '/base/dashboard')).text();
    const cssPath = /href="(\/base\/dashboard\/style\.css\?v=[A-Za-z0-9_-]{12})"/.exec(html)?.[1];
    const jsPath = /src="(\/base\/dashboard\/app\.js\?v=[A-Za-z0-9_-]{12})"/.exec(html)?.[1];
    const css = await get(dashboard(), cssPath as string);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(css.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const script = await get(dashboard(), jsPath as string);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    // An unversioned or stale URL is revalidated rather than cached.
    expect(
      (await get(dashboard(), '/base/dashboard/style.css?v=old')).headers.get('cache-control'),
    ).toBe('no-cache');
    expect((await get(dashboard(), '/base/dashboard/nothing')).status).toBe(404);
  });
});

describe('GitHub sign-in', () => {
  it('sends the person to GitHub with state and an S256 challenge, and seals both in a cookie', async () => {
    const { start, location, oauth } = await signIn();
    expect(start.status).toBe(302);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    const params = Object.fromEntries(location.searchParams);
    expect(params).toEqual({
      client_id: 'Ov23liFakeClientId00',
      redirect_uri: `${DASHBOARD}/callback`,
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
    });
    expect(oauth?.attributes).toEqual([
      'Path=/',
      'Max-Age=600',
      'Secure',
      'HttpOnly',
      'SameSite=Lax',
    ]);
    expect(oauth?.pair).not.toContain(params.state);
  });

  it('exchanges the code with its verifier, reads the user once and starts a session', async () => {
    const { location, callback, session } = await signIn();
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/base/dashboard');
    expect(cookie(callback, '__Host-slotlock-session')?.attributes).toEqual([
      'Path=/',
      'Max-Age=43200',
      'Secure',
      'HttpOnly',
      'SameSite=Lax',
    ]);
    expect(cookie(callback, '__Host-slotlock-oauth')?.attributes).toContain('Max-Age=0');

    const [token, user] = github.calls;
    expect(token?.url).toBe('https://github.com/login/oauth/access_token');
    expect(token?.init.method).toBe('POST');
    expect(new Headers(token?.init.headers).get('accept')).toBe('application/json');
    const sent = Object.fromEntries(new URLSearchParams(String(token?.init.body)));
    expect(sent).toMatchObject({
      client_id: 'Ov23liFakeClientId00',
      code: 'fake-code',
      redirect_uri: `${DASHBOARD}/callback`,
    });
    expect(
      createHash('sha256')
        .update(sent.code_verifier as string)
        .digest('base64url'),
    ).toBe(location.searchParams.get('code_challenge'));
    expect(user?.url).toBe('https://api.github.com/user');
    expect(Object.fromEntries(new Headers(user?.init.headers))).toMatchObject({
      authorization: 'Bearer gho_fake',
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10',
      'user-agent': 'slotlock-dashboard',
    });

    const page = await (await get(dashboard(), '/base/dashboard/settings', session)).text();
    expect(page).toContain('@octocat');
    expect(page).toContain('Mon–Fri: 09:00–17:00');
    expect(page).toContain('https://slotlock.example.com/base/mcp');
    expect(page).not.toContain('gho_fake');
  });

  it.each([
    ['a state that does not match', (state: string) => `code=c&state=${state}x`, true],
    ['no sign-in cookie', (state: string) => `code=c&state=${state}`, false],
    ['no code', (state: string) => `state=${state}`, true],
    ['GitHub reporting a refusal', (state: string) => `error=access_denied&state=${state}`, true],
  ])('refuses a callback with %s and starts no session', async (_case, query, withCookie) => {
    const target = dashboard();
    const start = await get(target, '/base/dashboard/sign-in');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') as string;
    const response = await get(
      target,
      `/base/dashboard/callback?${query(state)}`,
      withCookie ? cookie(start, '__Host-slotlock-oauth')?.pair : undefined,
    );
    expect(response.status).toBe(400);
    expect(cookie(response, '__Host-slotlock-session')).toBeUndefined();
    expect(github.fetch).not.toHaveBeenCalled();
    expect(await response.text()).toContain('href="/base/dashboard/sign-in"');
  });

  it('refuses a sign-in started more than ten minutes ago', async () => {
    const target = dashboard();
    const start = await get(target, '/base/dashboard/sign-in');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    now += 10 * 60_000 + 1;
    const response = await get(
      target,
      `/base/dashboard/callback?code=c&state=${state}`,
      cookie(start, '__Host-slotlock-oauth')?.pair,
    );
    expect(response.status).toBe(400);
    expect(github.fetch).not.toHaveBeenCalled();
  });

  it('refuses a GitHub account the server does not allow', async () => {
    github = fakeGitHub({ id: 9999, login: 'stranger' });
    const { callback, session } = await signIn();
    expect(callback.status).toBe(403);
    expect(session).toBeUndefined();
    expect(await callback.text()).toContain('@stranger');
  });

  it('lets anyone sign in when the server allows every account', async () => {
    github = fakeGitHub({ id: 9999, login: 'stranger' });
    const { callback } = await signIn(dashboard({ allowedUsers: '*' }));
    expect(callback.status).toBe(303);
  });

  it.each([
    ['a user that is not an object', 'nobody'],
    ['an id that is not a positive integer', { id: '4242', login: 'octocat' }],
    ['a login GitHub would not issue', { id: 4242, login: '<script>' }],
  ])('refuses %s from GitHub', async (_case, user) => {
    github = fakeGitHub(user as { id: unknown; login: unknown });
    const { callback, session } = await signIn();
    expect(callback.status).toBe(502);
    expect(session).toBeUndefined();
  });
});

describe('sessions', () => {
  it('signs out a tampered, expired or no-longer-allowed session', async () => {
    const { session } = await signIn();
    const signedIn = (html: string) => html.includes('@octocat');
    expect(signedIn(await (await get(dashboard(), '/base/dashboard', session)).text())).toBe(true);

    const tampered = session.replace(/.$/, (last) => (last === 'A' ? 'B' : 'A'));
    expect(signedIn(await (await get(dashboard(), '/base/dashboard', tampered)).text())).toBe(
      false,
    );

    const otherSecret = dashboard({ sessionSecret: SESSION_SECRET.replace(/^7/, '8') });
    expect(signedIn(await (await get(otherSecret, '/base/dashboard', session)).text())).toBe(false);

    const removed = dashboard({ allowedUsers: ['1'] });
    expect(signedIn(await (await get(removed, '/base/dashboard', session)).text())).toBe(false);

    now += 12 * 3_600_000 + 1;
    expect(signedIn(await (await get(dashboard(), '/base/dashboard', session)).text())).toBe(false);
  });

  // A 32-byte MAC is 43 base64url characters carrying 258 bits, so its last character has two
  // spare bits a decoder drops. Only the exact encoding the server made may count.
  it('signs out a cookie whose MAC differs only in its spare bits', async () => {
    const { session } = await signIn();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(session.at(-1) as string);
    for (const flip of [1, 2, 3]) {
      const altered = `${session.slice(0, -1)}${alphabet[last ^ flip]}`;
      const html = await (await get(dashboard(), '/base/dashboard', altered)).text();
      expect(html, altered.slice(-6)).not.toContain('@octocat');
    }
  });

  it('allows nobody when the allowlist is a string other than *', async () => {
    const { session } = await signIn();
    const loose = dashboard({ allowedUsers: '4242' as unknown as readonly string[] });
    expect(await (await get(loose, '/base/dashboard', session)).text()).not.toContain('@octocat');
  });

  it('signs out on request', async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const response = await post(
      target,
      '/base/dashboard/sign-out',
      { csrf: await csrf(target, session) },
      session,
    );
    expect(response.status).toBe(303);
    expect(cookie(response, '__Host-slotlock-session')?.attributes).toContain('Max-Age=0');
  });
});

describe('API keys in the dashboard', () => {
  it("creates a key in the person's tenant and shows it once", async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const response = await post(
      target,
      '/base/dashboard/keys',
      { csrf: await csrf(target, session), name: 'Booking agent', access: 'read', expires: '30' },
      session,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(keys.store.create).toHaveBeenCalledWith({
      tenantRef: 'github:4242',
      name: 'Booking agent',
      scopes: ['read'],
      createdBy: 'github:4242',
      expiresAt: new Date(now + 30 * 86_400_000),
    });
    const html = await response.text();
    const [row] = [...keys.rows.values()];
    expect(html.split(row?.key as string)).toHaveLength(3); // the field and the client command
    expect(html).toContain('will not be shown again');

    const listed = await (await get(target, '/base/dashboard/keys', session)).text();
    expect(listed).toContain(row?.prefix as string);
    expect(listed).not.toContain(row?.key as string);
  });

  it('creates read-and-write keys that never expire by default choices', async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    await post(
      target,
      '/base/dashboard/keys',
      { csrf: await csrf(target, session), name: 'Writer', access: 'read_write', expires: 'never' },
      session,
    );
    expect(keys.store.create).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['read', 'write'] }),
    );
    expect(keys.store.create.mock.calls[0]?.[0]).not.toHaveProperty('expiresAt');
  });

  it('creates a full key, which the application API takes, and lists it as Full', async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const form = await (await get(target, '/base/dashboard/keys', session)).text();
    expect(form).toContain('<option value="full">Full, with the application API</option>');
    await post(
      target,
      '/base/dashboard/keys',
      { csrf: await csrf(target, session), name: 'Booking site', access: 'full', expires: '365' },
      session,
    );
    expect(keys.store.create).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['read', 'write', 'admin'] }),
    );
    const listed = await (await get(target, '/base/dashboard/keys', session)).text();
    expect(listed).toContain('<td data-label="Access">Full</td>');
  });

  it.each([
    ['no CSRF token', (token: string) => ({ name: 'x', access: 'read', expires: 'never' }), ORIGIN],
    [
      'another token',
      () => ({ csrf: 'x'.repeat(43), name: 'x', access: 'read', expires: 'never' }),
      ORIGIN,
    ],
    [
      'another origin',
      (token: string) => ({ csrf: token, name: 'x', access: 'read', expires: 'never' }),
      'https://evil.example',
    ],
    [
      'no origin',
      (token: string) => ({ csrf: token, name: 'x', access: 'read', expires: 'never' }),
      null,
    ],
  ] as const)('refuses a POST with %s', async (_case, fields, origin) => {
    const target = dashboard();
    const { session } = await signIn(target);
    const response = await post(
      target,
      '/base/dashboard/keys',
      fields(await csrf(target, session)) as Record<string, string>,
      session,
      origin,
    );
    expect(response.status).toBe(403);
    expect(keys.store.create).not.toHaveBeenCalled();
  });

  it("refuses one person's CSRF token in another person's session", async () => {
    const target = dashboard({ allowedUsers: '*' });
    const first = await signIn(target);
    github = fakeGitHub({ id: 7, login: 'other' });
    const second = await signIn(dashboard({ allowedUsers: '*' }));
    const response = await post(
      dashboard({ allowedUsers: '*' }),
      '/base/dashboard/keys',
      { csrf: await csrf(target, first.session), name: 'x', access: 'read', expires: 'never' },
      second.session,
    );
    expect(response.status).toBe(403);
  });

  it.each([
    ['an unknown access level', { access: 'admin', expires: 'never' }],
    ['an unknown expiry', { access: 'read', expires: '7' }],
  ])('refuses %s without creating anything', async (_case, fields) => {
    const target = dashboard();
    const { session } = await signIn(target);
    const response = await post(
      target,
      '/base/dashboard/keys',
      { csrf: await csrf(target, session), name: 'x', ...fields },
      session,
    );
    expect(response.status).toBe(400);
    expect(keys.store.create).not.toHaveBeenCalled();
  });

  it('shows the store refusing a name as a message on the page', async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const response = await post(
      target,
      '/base/dashboard/keys',
      { csrf: await csrf(target, session), name: '   ', access: 'read', expires: 'never' },
      session,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Give the key a name');
  });

  it('escapes what it renders', async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    await post(
      target,
      '/base/dashboard/keys',
      { csrf: token, name: '<img src=x onerror=alert(1)>', access: 'read', expires: 'never' },
      session,
    );
    const html = await (await get(target, '/base/dashboard/keys', session)).text();
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });

  it("rotates and revokes keys in the person's tenant only", async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    await post(
      target,
      '/base/dashboard/keys',
      { csrf: token, name: 'A', access: 'read', expires: 'never' },
      session,
    );
    const [row] = [...keys.rows.values()];

    const rotated = await post(
      target,
      '/base/dashboard/keys/rotate',
      { csrf: token, id: row?.id as string },
      session,
    );
    expect(rotated.status).toBe(200);
    expect(keys.store.rotate).toHaveBeenCalledWith({ tenantRef: 'github:4242', id: row?.id });
    expect(await rotated.text()).toContain(keys.rows.get(row?.id as string)?.key as string);

    const revoked = await post(
      target,
      '/base/dashboard/keys/revoke',
      { csrf: token, id: row?.id as string },
      session,
    );
    expect(revoked.status).toBe(303);
    expect(keys.store.revoke).toHaveBeenCalledWith({ tenantRef: 'github:4242', id: row?.id });

    const missing = await post(
      target,
      '/base/dashboard/keys/revoke',
      { csrf: token, id: randomUUID() },
      session,
    );
    expect(missing.status).toBe(404);
  });

  it('sends a signed-out POST back to the sign-in page', async () => {
    const response = await post(dashboard(), '/base/dashboard/keys', { name: 'x' }, '');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/base/dashboard');
    expect(keys.store.create).not.toHaveBeenCalled();
  });
});

describe('resources in the dashboard', () => {
  it("adds resources to the person's tenant, up to the cap", async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    const added = await post(
      target,
      '/base/dashboard/resources',
      { csrf: token, reference: 'vehicle-42', timezone: 'Europe/London' },
      session,
    );
    expect(added.status).toBe(303);
    expect(resources.store.add).toHaveBeenCalledWith('github:4242', 'vehicle-42', 'Europe/London', 'github:4242');
    expect(await (await get(target, '/base/dashboard/resources', session)).text()).toContain('vehicle-42');

    const zone = await post(
      target,
      '/base/dashboard/resources',
      { csrf: token, reference: 'vehicle-43', timezone: 'Mars/Olympus' },
      session,
    );
    expect(zone.status).toBe(400);
    expect(await zone.text()).toContain('not a time zone');

    for (let index = resources.rows.length; index < SLOTLOCK_DASHBOARD_MAX_RESOURCES; index += 1) {
      resources.rows.push({
        id: randomUUID(),
        externalRef: `r${index}`,
        tenantRef: 'github:4242',
        timezone: 'UTC',
      } as never);
    }
    const capped = await post(
      target,
      '/base/dashboard/resources',
      { csrf: token, reference: 'one-more', timezone: 'UTC' },
      session,
    );
    expect(capped.status).toBe(409);
    expect(await capped.text()).toContain('as many as the dashboard allows');
    expect(resources.rows.filter((row) => row.tenantRef === 'github:4242')).toHaveLength(
      SLOTLOCK_DASHBOARD_MAX_RESOURCES,
    );

    // At the cap, a reference the person already has is re-zoned, not refused.
    const rezoned = await post(
      target,
      '/base/dashboard/resources',
      { csrf: token, reference: 'vehicle-42', timezone: 'Europe/Paris' },
      session,
    );
    expect(rezoned.status).toBe(303);
    expect(resources.rows.find((row) => row.externalRef === 'vehicle-42')?.timezone).toBe(
      'Europe/Paris',
    );
  });
});

describe('bookable hours in the dashboard', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';
  const weekdays = {
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    startMinutes: 540,
    durationMinutes: 480,
  };

  function own(externalRef: string, availabilityRules?: WeeklyAvailabilityRule[]) {
    const row = {
      id: randomUUID(),
      externalRef,
      tenantRef: 'github:4242',
      timezone: 'Europe/London',
      ...(availabilityRules ? { availabilityRules } : {}),
    };
    resources.rows.push(row);
    return row;
  }

  /** The editor's fields: every window empty unless given, e.g. { mo_from_1: '09:00' }. */
  function weekFields(fields: Record<string, string>) {
    const all: Record<string, string> = {};
    for (const day of ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su']) {
      for (const n of [1, 2]) {
        all[`${day}_from_${n}`] = '';
        all[`${day}_to_${n}`] = '';
      }
    }
    return { ...all, ...fields };
  }

  it("shows each resource's hours and links to its editor", async () => {
    const plain = own('car-plain');
    const closed = own('car-closed', []);
    const custom = own('car-custom', [weekdays]);
    const target = dashboard();
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard/resources', session)).text();
    expect(html).toContain('Server&#39;s hours');
    expect(html).toContain('Closed');
    expect(html).toContain('Mon–Fri 09:00–17:00');
    for (const resource of [plain, closed, custom]) {
      expect(html).toContain(`href="/base/dashboard/hours?resource=${resource.id}"`);
    }
    expect(html).toContain('href="/base/dashboard/hours"');
  });

  it('summarises hours by day, overnight as next day, never in fractions of an hour', async () => {
    own('car-shift', [
      { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 480, durationMinutes: 240 },
      { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 780, durationMinutes: 300 },
      { rrule: 'FREQ=WEEKLY;BYDAY=SA', startMinutes: 1_320, durationMinutes: 600 },
      { rrule: 'FREQ=WEEKLY;BYDAY=SU', startMinutes: 0, durationMinutes: 1_440 },
    ]);
    // Not a week of windows (INTERVAL), so each rule is summarised on its own.
    own('car-odd', [
      { rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE', startMinutes: 1_380, durationMinutes: 80 },
      { rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=FR', startMinutes: 540, durationMinutes: 3_030 },
    ]);
    const target = dashboard();
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard/resources', session)).text();
    expect(html).toContain(
      'Mon–Fri 08:00–12:00, 13:00–18:00; Sat 22:00–08:00 next day; Sun all day',
    );
    expect(html).toContain('Mon, Wed 23:00–00:20 next day; Fri from 09:00 for 2 d 2 h 30 min');
    const settings = await (await get(target, '/base/dashboard/settings', session)).text();
    expect(settings).toContain('Mon–Fri: 09:00–17:00');
    expect(html).not.toMatch(/\d\.\d+ h/);
  });

  it("edits one resource's hours as a week of windows, overnight included", async () => {
    const car = own('car-1', [weekdays]);
    const target = dashboard();
    const { session } = await signIn(target);
    const page = await get(target, `/base/dashboard/hours?resource=${car.id}`, session);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('car-1');
    expect(html).toContain('Europe/London');
    expect(html).toMatch(/name="mo_from_1" value="09:00"/);
    expect(html).toMatch(/name="fr_to_1" value="17:00"/);
    expect(html).toMatch(/name="sa_from_1" value=""/);
    expect(html).toMatch(/value="custom" checked/);
    expect(html).toMatch(/name="once" value="[^"]+"/);

    const token = await csrf(target, session);
    const saved = await post(
      target,
      '/base/dashboard/hours',
      {
        csrf: token,
        resource: car.id,
        mode: 'custom',
        ...weekFields({
          mo_from_1: '08:00',
          mo_to_1: '12:00',
          mo_from_2: '13:00',
          mo_to_2: '17:30',
          fr_from_1: '22:00',
          fr_to_1: '06:00',
          su_from_1: '00:00',
          su_to_1: '00:00',
        }),
      },
      session,
    );
    expect(saved.status).toBe(303);
    expect(resources.store.setHours).toHaveBeenCalledWith('github:4242', { id: car.id }, [
      { rrule: 'FREQ=WEEKLY;BYDAY=SU', startMinutes: 0, durationMinutes: 1_440 },
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 480, durationMinutes: 240 },
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 780, durationMinutes: 270 },
      { rrule: 'FREQ=WEEKLY;BYDAY=FR', startMinutes: 1_320, durationMinutes: 480 },
    ], 'github:4242');
  });

  it("hands a resource back to the server's hours, or closes it", async () => {
    const car = own('car-2', [weekdays]);
    const target = dashboard();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    for (const [mode, rules] of [
      ['server', null],
      ['closed', []],
    ] as const) {
      const saved = await post(
        target,
        '/base/dashboard/hours',
        {
          csrf: token,
          resource: car.id,
          mode,
          ...weekFields({ mo_from_1: '09:00', mo_to_1: '17:00' }),
        },
        session,
      );
      expect(saved.status).toBe(303);
      expect(resources.store.setHours).toHaveBeenLastCalledWith(
        'github:4242',
        { id: car.id },
        rules,
        'github:4242',
      );
    }
    const html = await (
      await get(target, `/base/dashboard/hours?resource=${car.id}`, session)
    ).text();
    expect(html).toMatch(/value="closed" checked/);
  });

  it('sets the same hours on every resource at once', async () => {
    own('car-a');
    own('car-b');
    const target = dashboard();
    const { session } = await signIn(target);
    const page = await (await get(target, '/base/dashboard/hours', session)).text();
    expect(page).toContain('every resource');
    expect(page).toMatch(/name="resource" value="all"/);
    const token = await csrf(target, session);
    const saved = await post(
      target,
      '/base/dashboard/hours',
      {
        csrf: token,
        resource: 'all',
        mode: 'custom',
        ...weekFields({ sa_from_1: '10:00', sa_to_1: '14:00' }),
      },
      session,
    );
    expect(saved.status).toBe(303);
    expect(resources.store.setHours).toHaveBeenCalledWith('github:4242', 'all', [
      { rrule: 'FREQ=WEEKLY;BYDAY=SA', startMinutes: 600, durationMinutes: 240 },
    ], 'github:4242');
  });

  it.each([
    [
      'overlapping windows',
      { tu_from_1: '09:00', tu_to_1: '13:00', tu_from_2: '12:00', tu_to_2: '17:00' },
      "Tuesday's two windows overlap",
    ],
    ['half a window', { we_from_1: '09:00' }, 'Give Wednesday'],
    ['a time that is not one', { th_from_1: '25:00', th_to_1: '26:00' }, 'Thursday'],
    ['custom hours with no window', {}, 'Add a window'],
  ])('refuses %s, says why, and keeps what was typed', async (_case, fields, message) => {
    const car = own('car-3');
    const target = dashboard();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    const refused = await post(
      target,
      '/base/dashboard/hours',
      { csrf: token, resource: car.id, mode: 'custom', ...weekFields(fields) },
      session,
    );
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain(message.replaceAll("'", '&#39;'));
    for (const [name, value] of Object.entries(fields)) {
      expect(html).toContain(`name="${name}" value="${value}"`);
    }
    expect(resources.store.setHours).not.toHaveBeenCalled();
  });

  it("does not show or change another tenant's resource, or an id that is not one", async () => {
    resources.rows.push({
      id: OTHER,
      externalRef: 'theirs',
      tenantRef: 'github:7',
      timezone: 'UTC',
      availabilityRules: [weekdays],
    });
    const target = dashboard();
    const { session } = await signIn(target);
    for (const id of [OTHER, 'not-a-uuid']) {
      expect((await get(target, `/base/dashboard/hours?resource=${id}`, session)).status).toBe(404);
    }
    const token = await csrf(target, session);
    for (const id of [OTHER, 'not-a-uuid']) {
      const sent = await post(
        target,
        '/base/dashboard/hours',
        { csrf: token, resource: id, mode: 'closed', ...weekFields({}) },
        session,
      );
      expect(sent.status).toBe(404);
    }
    expect(resources.rows.find(({ id }) => id === OTHER)?.availabilityRules).toEqual([weekdays]);
  });

  it('shows hours the week cannot express as they are, and replaces them only when saved', async () => {
    const until = {
      rrule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20271231T000000Z',
      startMinutes: 540,
      durationMinutes: 60,
    };
    const car = own('car-4', [until]);
    const target = dashboard();
    const { session } = await signIn(target);
    const html = await (
      await get(target, `/base/dashboard/hours?resource=${car.id}`, session)
    ).text();
    expect(html).toContain('set outside the dashboard');
    expect(html).toContain('FREQ=WEEKLY;BYDAY=MO;UNTIL=20271231T000000Z');
    expect(html).toMatch(/name="mo_from_1" value=""/);
    expect(resources.store.setHours).not.toHaveBeenCalled();
  });

  it('needs a signed-in session, a CSRF token, and runs a sent form once', async () => {
    const car = own('car-5');
    const target = dashboard();
    expect((await get(target, '/base/dashboard/hours')).headers.get('location')).toBe(
      '/base/dashboard',
    );
    const { session } = await signIn(target);
    const forged = await post(
      target,
      '/base/dashboard/hours',
      { csrf: 'x', resource: car.id, mode: 'closed' },
      session,
    );
    expect(forged.status).toBe(403);
    const html = await (
      await get(target, `/base/dashboard/hours?resource=${car.id}`, session)
    ).text();
    const token = /name="csrf" value="([^"]+)"/.exec(html)?.[1] as string;
    const once = /name="once" value="([^"]+)"/.exec(html)?.[1] as string;
    const fields = { csrf: token, once, resource: car.id, mode: 'closed', ...weekFields({}) };
    expect((await post(target, '/base/dashboard/hours', fields, session)).status).toBe(303);
    expect((await post(target, '/base/dashboard/hours', fields, session)).status).toBe(409);
    expect(resources.store.setHours).toHaveBeenCalledOnce();
  });

  it('refuses a form sent without its single-use value, on every route but sign-out', async () => {
    const car = own('car-6');
    const target = dashboard();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    const forms: Array<[string, Record<string, string>]> = [
      ['/keys', { name: 'Bare', access: 'read', expires: 'never' }],
      ['/keys/rotate', { id: randomUUID() }],
      ['/keys/revoke', { id: randomUUID() }],
      ['/resources', { reference: 'bare-van', timezone: 'UTC' }],
      ['/hours', { resource: car.id, mode: 'closed', ...weekFields({}) }],
      ['/hours', { resource: 'all', mode: 'closed', ...weekFields({}) }],
    ];
    for (const [route, fields] of forms) {
      const sent = await post(
        target,
        `/base/dashboard${route}`,
        { csrf: token, ...fields },
        session,
        ORIGIN,
        'none',
      );
      expect(sent.status, route).toBe(400);
    }
    expect(keys.store.create).not.toHaveBeenCalled();
    expect(keys.store.rotate).not.toHaveBeenCalled();
    expect(keys.store.revoke).not.toHaveBeenCalled();
    expect(resources.store.add).not.toHaveBeenCalled();
    expect(resources.store.setHours).not.toHaveBeenCalled();
    // Signing out always works, single-use value or not.
    const out = await post(
      target,
      '/base/dashboard/sign-out',
      { csrf: token },
      session,
      ORIGIN,
      'none',
    );
    expect(out.status).toBe(303);
  });
});

describe('the in-memory dashboard state', () => {
  it('follows the shared rules by its own clock: expiry, a day at most, an owner and a cap per form', async () => {
    let clock = Date.UTC(2026, 9, 10, 12);
    const state = createSlotlockMemoryDashboardState(() => clock);
    expect(await state.use('sign_in', 'a', clock + 60_000)).toBe(true);
    expect(await state.use('sign_in', 'a', clock + 60_000)).toBe(false);
    expect(await state.use('sign_in', 'b', clock)).toBe(false);
    expect(await state.use('sign_in', 'c', clock + 25 * 3_600_000)).toBe(false);
    await expect(state.use('form', 'd', clock + 60_000)).rejects.toThrow('name their owner');
    for (let index = 0; index < SLOTLOCK_DASHBOARD_FORM_LIMIT; index += 1) {
      expect(await state.use('form', `f${index}`, clock + 60_000, '4242')).toBe(true);
    }
    await expect(state.use('form', 'over', clock + 60_000, '4242')).rejects.toMatchObject({
      code: 'dashboard_form_limit',
    });
    expect(await state.use('form', 'other-person', clock + 60_000, '7')).toBe(true);
    clock += 61_000;
    expect(await state.use('form', 'after-expiry', clock + 60_000, '4242')).toBe(true);

    expect(await state.sessionEnded('s', clock + 60_000)).toBe(false);
    expect(await state.sessionEnded('s', clock)).toBe(true);
    expect(await state.sessionEnded('s', clock + 25 * 3_600_000)).toBe(true);
    await state.endSession('s', clock + 60_000);
    expect(await state.sessionEnded('s', clock + 60_000)).toBe(true);
  });
});

describe('limits found in review', () => {
  it('refuses a form body over 8 KB, declared or streamed, before reading it', async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    const big = `csrf=${token}&name=${'x'.repeat(9_000)}&access=read&expires=never`;
    const declared = await target.fetch(
      new Request(`${ORIGIN}/base/dashboard/keys`, {
        method: 'POST',
        headers: {
          cookie: session,
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: big,
      }),
    );
    expect(declared.status).toBe(413);
    // A declared length over the cap is refused before a byte is read, whatever arrives.
    const announced = await target.fetch(
      new Request(`${ORIGIN}/base/dashboard/keys`, {
        method: 'POST',
        headers: {
          cookie: session,
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': '1000000',
        },
        body: `csrf=${token}&name=small&access=read&expires=never`,
      }),
    );
    expect(announced.status).toBe(413);

    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(1_024)));
      },
    });
    const streamed = await target.fetch(
      new Request(`${ORIGIN}/base/dashboard/keys`, {
        method: 'POST',
        headers: {
          cookie: session,
          origin: ORIGIN,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: endless,
        duplex: 'half',
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect(pulled).toBeLessThan(20);
    expect(keys.store.create).not.toHaveBeenCalled();
  });

  it('asks the shared state before GitHub, and stops a sign-in it has seen', async () => {
    const seen: SlotlockDashboardState = {
      use: vi.fn(async () => false),
      endSession: vi.fn(async () => undefined),
      sessionEnded: vi.fn(async () => false),
    };
    const target = dashboard({ state: seen });
    const start = await get(target, '/base/dashboard/sign-in');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') as string;
    const pending = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
    const callback = await get(target, `/base/dashboard/callback?code=c&state=${state}`, pending);
    expect(callback.status).toBe(400);
    expect(seen.use).toHaveBeenCalledWith('sign_in', state, expect.any(Number));
    expect(github.fetch).not.toHaveBeenCalled();
  });

  it('frees the sign-in slot when the shared state fails', async () => {
    let failures = 9;
    const flaky: SlotlockDashboardState = {
      ...createSlotlockMemoryDashboardState(() => now),
      use: vi.fn(async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('database unavailable');
        }
        return true;
      }),
    };
    const errors: unknown[] = [];
    const target = dashboard({ state: flaky, onError: (error) => errors.push(error) });
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const start = await get(target, '/base/dashboard/sign-in');
      const state = new URL(start.headers.get('location') ?? '').searchParams.get(
        'state',
      ) as string;
      const pending = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
      expect(
        (await get(target, `/base/dashboard/callback?code=c&state=${state}`, pending)).status,
      ).toBe(500);
    }
    expect(errors).toHaveLength(9);
    expect(github.fetch).not.toHaveBeenCalled();
    // More failures than the 8 slots, and the next sign-in still gets one.
    const { session } = await signIn(target);
    expect(session).toMatch(/^__Host-slotlock-session=/);
  });

  it('holds at most two sign-ins in flight per client, so one client cannot take every slot (SEC-12)', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached = 0;
    const slow = fakeGitHub();
    const target = dashboard({
      clientAddress: (request) => request.headers.get('x-test-client') ?? undefined,
      fetch: async (input, init) => {
        reached += 1;
        await held;
        return slow.fetch(input, init);
      },
    });
    const callback = async (client: string) => {
      const start = await get(target, '/base/dashboard/sign-in');
      const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
      const pending = cookie(start, '__Host-slotlock-oauth')?.pair as string;
      return target.fetch(
        new Request(`${ORIGIN}/base/dashboard/callback?code=c&state=${state}`, {
          headers: { cookie: pending, 'x-test-client': client },
        }),
      );
    };
    const first = [callback('203.0.113.7'), callback('203.0.113.7')];
    while (reached < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    // A third from the same client is answered at once rather than joining GitHub's queue; another
    // client still gets a slot.
    const thirdCall = callback('203.0.113.7');
    const third = await Promise.race([
      thirdCall.then((response) => response.status),
      new Promise((resolve) => setTimeout(() => resolve('still waiting on GitHub'), 200)),
    ]);
    expect(third).toBe(503);
    const other = callback('198.51.100.4');
    while (reached < 3) await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    expect((await Promise.all([...first, other])).map((response) => response.status)).toEqual([
      303, 303, 303,
    ]);
    await thirdCall;
    // Once its sign-ins finish, the client may sign in again.
    expect((await callback('203.0.113.7')).status).toBe(303);
  });

  it('finishes each sign-in once', async () => {
    const target = dashboard();
    const start = await get(target, '/base/dashboard/sign-in');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const pending = cookie(start, '__Host-slotlock-oauth')?.pair;
    const first = await get(target, `/base/dashboard/callback?code=c&state=${state}`, pending);
    expect(first.status).toBe(303);
    const replay = await get(target, `/base/dashboard/callback?code=c&state=${state}`, pending);
    expect(replay.status).toBe(400);
    expect(github.calls.filter(({ url }) => url.endsWith('/access_token'))).toHaveLength(1);
  });

  it('runs at most eight GitHub exchanges at once', async () => {
    const release: Array<() => void> = [];
    const held = vi.fn(
      (input: string | URL | Request) =>
        new Promise<Response>((resolve) => {
          release.push(() =>
            resolve(
              String(input).endsWith('/access_token')
                ? Response.json({ access_token: 'gho_fake' })
                : Response.json(GITHUB_USER),
            ),
          );
        }),
    );
    const target = dashboard({ fetch: held as unknown as typeof fetch });
    const callbacks = [];
    for (let index = 0; index < 9; index += 1) {
      const start = await get(target, '/base/dashboard/sign-in');
      const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
      callbacks.push(
        get(
          target,
          `/base/dashboard/callback?code=c&state=${state}`,
          cookie(start, '__Host-slotlock-oauth')?.pair,
        ),
      );
    }
    // Without a cap the ninth would wait on GitHub too; with one it is refused at once.
    const ninth = await Promise.race([
      callbacks[8],
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 200)),
    ]);
    expect(ninth instanceof Response ? ninth.status : ninth).toBe(503);
    expect(held).toHaveBeenCalledTimes(8);
    for (
      let turn = 0;
      turn < 100 && (release.length > 0 || held.mock.calls.length < 16);
      turn += 1
    ) {
      release.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const finished = await Promise.all(callbacks.slice(0, 8));
    expect(finished.every(({ status }) => status === 303)).toBe(true);
  });

  it('keeps a signed-out session signed out, even if the cookie comes back', async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    await post(target, '/base/dashboard/sign-out', { csrf: token }, session);
    expect(await (await get(target, '/base/dashboard', session)).text()).not.toContain('@octocat');
    const reused = await post(
      target,
      '/base/dashboard/keys',
      { csrf: token, name: 'x', access: 'read', expires: 'never' },
      session,
    );
    expect(reused.status).toBe(303);
    expect(keys.store.create).not.toHaveBeenCalled();
  });

  it('does not run a form twice when the browser sends it again', async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard/keys', session)).text();
    const token = /name="csrf" value="([^"]+)"/.exec(html)?.[1] as string;
    const once =
      /action="\/base\/dashboard\/keys">\s*<input type="hidden" name="csrf" value="[^"]+">\s*<input type="hidden" name="once" value="([^"]+)">/.exec(
        html,
      )?.[1];
    expect(once).toMatch(/^[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/);
    const fields = {
      csrf: token,
      once: once as string,
      name: 'Once',
      access: 'read',
      expires: 'never',
    };
    expect((await post(target, '/base/dashboard/keys', fields, session)).status).toBe(200);
    const again = await post(target, '/base/dashboard/keys', fields, session);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('already sent');
    expect(keys.store.create).toHaveBeenCalledTimes(1);
  });

  it("logs GitHub's error code, and nothing secret, when sign-in fails there", async () => {
    const onError = vi.fn();
    const failing = vi.fn(async () =>
      Response.json({
        error: 'incorrect_client_credentials',
        error_description: 'The client_id and/or client_secret passed are incorrect.',
      }),
    );
    const { callback } = await signIn(
      dashboard({ fetch: failing as unknown as typeof fetch, onError }),
    );
    expect(callback.status).toBe(502);
    expect(onError).toHaveBeenCalledTimes(1);
    const message = String((onError.mock.calls[0]?.[0] as Error).message);
    expect(message).toContain('incorrect_client_credentials');
    expect(message).not.toMatch(/fffff|fake-code|gho_/);
  });

  it('signs in a GitHub login with an underscore, as managed accounts have', async () => {
    github = fakeGitHub({ id: 4242, login: 'jane_acme' });
    const { callback } = await signIn();
    expect(callback.status).toBe(303);
  });
});

describe('organizations', () => {
  const ACME = { id: 91, login: 'acme-fleet' };
  const GLOBEX = { id: 92, login: 'globex' };
  const ELSEWHERE = { id: 93, login: 'elsewhere' };
  const MEMBERSHIPS = 'https://api.github.com/user/memberships/orgs?state=active&per_page=100';

  /** GitHub with the user's active org memberships, as GET /user/memberships/orgs lists them. */
  function githubWithOrgs(
    orgs: { id: number; login: string; role?: string }[],
    membershipsStatus = 200,
  ) {
    const base = fakeGitHub();
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (url === MEMBERSHIPS) {
        base.calls.push({ url, init });
        if (membershipsStatus !== 200) return new Response('nope', { status: membershipsStatus });
        return Response.json([
          ...orgs.map(({ role = 'member', ...organization }) => ({
            state: 'active',
            role,
            organization,
          })),
          // GitHub lists only what state=active asks for; a pending one must still never count.
          { state: 'pending', role: 'member', organization: ELSEWHERE },
        ]);
      }
      return base.fetch(input, init);
    });
    return { fetch, calls: base.calls };
  }

  const orgDashboard = (
    orgs: { id: number; login: string; role?: string }[],
    overrides: Partial<Parameters<typeof createSlotlockDashboard>[0]> = {},
  ) => {
    github = githubWithOrgs(orgs);
    return dashboard({
      fetch: github.fetch,
      organizations: [String(ACME.id), String(GLOBEX.id), String(ELSEWHERE.id)],
      ...overrides,
    });
  };

  it('asks GitHub for read:org only when the server serves organizations', async () => {
    expect((await signIn(dashboard())).location.searchParams.has('scope')).toBe(false);
    expect((await signIn(orgDashboard([ACME]))).location.searchParams.get('scope')).toBe('read:org');
  });

  it("puts a member's keys in the organization's tenant, recording who made each", async () => {
    const target = orgDashboard([ACME]);
    const { session } = await signIn(target);
    const page = await (await get(target, '/base/dashboard/keys', session)).text();
    expect(page).toContain('acme-fleet');
    await post(
      target,
      '/base/dashboard/keys',
      { csrf: await csrf(target, session), name: 'Fleet agent', access: 'read', expires: '30' },
      session,
    );
    expect(keys.store.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantRef: 'github-org:91', createdBy: 'github:4242' }),
    );
    // The membership was read with the person's own token.
    const asked = github.calls.find(({ url }) => url === MEMBERSHIPS);
    expect(new Headers(asked?.init.headers).get('authorization')).toBe('Bearer gho_fake');
  });

  it('refuses someone in none of the served organizations, or whose memberships cannot be read', async () => {
    const outsider = await signIn(orgDashboard([{ id: 77, login: 'unrelated' }]));
    expect(outsider.callback.status).toBe(403);
    expect(outsider.session).toBeUndefined();
    expect(await outsider.callback.text()).toContain('not a member of an organization');

    github = githubWithOrgs([ACME], 500);
    const failed = await signIn(
      dashboard({ fetch: github.fetch, organizations: [String(ACME.id)] }),
    );
    expect(failed.callback.status).toBe(502);
    expect(failed.session).toBeUndefined();
  });

  it('lets a member of two served organizations switch, and only between them', async () => {
    const target = orgDashboard([ACME, GLOBEX]);
    const { session } = await signIn(target);
    const page = await (await get(target, '/base/dashboard', session)).text();
    expect(page).toContain('globex');
    const token = await csrf(target, session);

    const switched = await post(target, '/base/dashboard/organization', { csrf: token, organization: String(GLOBEX.id) }, session);
    expect(switched.status).toBe(303);
    const moved = cookie(switched, '__Host-slotlock-session')?.pair as string;
    await post(
      target,
      '/base/dashboard/keys',
      { csrf: await csrf(target, moved), name: 'Globex agent', access: 'read', expires: '30' },
      moved,
    );
    expect(keys.store.create).toHaveBeenLastCalledWith(expect.objectContaining({ tenantRef: 'github-org:92' }));

    // An organization the server serves but the person is not in, or one it does not serve.
    for (const organization of [String(ELSEWHERE.id), '55', 'x']) {
      const refused = await post(target, '/base/dashboard/organization', { csrf: await csrf(target, moved), organization }, moved);
      expect(refused.status).toBe(400);
      expect(cookie(refused, '__Host-slotlock-session')).toBeUndefined();
    }
  });

  it('counts owners and members, never billing managers', async () => {
    const billing = await signIn(orgDashboard([{ ...ACME, role: 'billing_manager' }]));
    expect(billing.callback.status).toBe(403);
    expect(billing.session).toBeUndefined();
    const owner = await signIn(orgDashboard([{ ...ACME, role: 'admin' }]));
    expect(owner.callback.status).toBe(303);
  });

  it('refuses a form from a page of the organization the person switched away from', async () => {
    const target = orgDashboard([ACME, GLOBEX]);
    const { session } = await signIn(target);
    // Opened while acting for acme-fleet: the create-key form's single-use value.
    const acmePage = await (await get(target, '/base/dashboard/keys', session)).text();
    const stale = /action="\/base\/dashboard\/keys">\s*<input type="hidden" name="csrf" value="[^"]+">\s*<input type="hidden" name="once" value="([^"]+)"/.exec(acmePage)?.[1] as string;
    expect(stale).toBeDefined();
    const token = await csrf(target, session);
    const switched = await post(target, '/base/dashboard/organization', { csrf: token, organization: String(GLOBEX.id) }, session);
    const moved = cookie(switched, '__Host-slotlock-session')?.pair as string;
    const refused = await post(
      target,
      '/base/dashboard/keys',
      { csrf: token, once: stale, name: 'Acme agent', access: 'full', expires: 'never' },
      moved,
    );
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('another organization');
    expect(keys.store.create).not.toHaveBeenCalled();
  });

  it('names who made each key, and the organization a new key is for', async () => {
    const target = orgDashboard([ACME]);
    const { session } = await signIn(target);
    const created = await post(
      target,
      '/base/dashboard/keys',
      { csrf: await csrf(target, session), name: 'Fleet agent', access: 'read', expires: '30' },
      session,
    );
    expect(await created.text()).toContain('For the organization <strong>acme-fleet</strong>');
    const [row] = [...keys.rows.values()];
    keys.rows.set('other', { ...(row as NonNullable<typeof row>), id: randomUUID(), createdBy: 'github:777' });
    const page = await (await get(target, '/base/dashboard/keys', session)).text();
    expect(page).toContain('<td data-label="Created by">You</td>');
    expect(page).toContain('<td data-label="Created by">GitHub user 777</td>');
  });

  it('offers only organizations the server still serves', async () => {
    const { session } = await signIn(orgDashboard([ACME, GLOBEX]));
    const narrowed = dashboard({ fetch: github.fetch, organizations: [String(ACME.id)] });
    const page = await (await get(narrowed, '/base/dashboard', session)).text();
    expect(page).not.toContain('globex');
    const refused = await post(
      narrowed,
      '/base/dashboard/organization',
      { csrf: await csrf(narrowed, session), organization: String(GLOBEX.id) },
      session,
    );
    expect(refused.status).toBe(400);
  });

  it("signs out a session whose organization the server no longer serves", async () => {
    const { session } = await signIn(orgDashboard([ACME, GLOBEX]));
    const narrowed = dashboard({ fetch: github.fetch, organizations: [String(GLOBEX.id)] });
    const page = await get(narrowed, '/base/dashboard', session);
    expect(await page.text()).toContain('Continue with GitHub');
  });
});

describe('the overview', () => {
  const at = (iso: string) => new Date(iso);

  function withFeed(agenda: SlotlockAgendaEntry[], changes: SlotlockChange[]) {
    const store = {
      ...resources.store,
      agenda: vi.fn(async () => agenda),
      recentChanges: vi.fn(async () => changes),
    };
    return { target: dashboard({ resources: store }), store };
  }

  it("shows the tenant's coming week by day and what its agents did, from the store alone", async () => {
    resources.rows.push({
      id: '11111111-1111-4111-8111-111111111111',
      externalRef: 'vehicle-42',
      tenantRef: 'github:4242',
      timezone: 'Europe/London',
    });
    const created = await keys.store.create({
      tenantRef: 'github:4242',
      name: 'Booking agent',
      scopes: ['read', 'write'],
    });
    const resourceId = '11111111-1111-4111-8111-111111111111';
    const { target, store } = withFeed(
      [
        {
          id: randomUUID(),
          resourceId,
          start: at('2026-10-10T14:00:00Z'),
          end: at('2026-10-10T16:00:00Z'),
          kind: 'booking',
          reference: 'rental-<7>',
          summary: null,
          expiresAt: null,
          source: 'agent',
        },
        {
          id: randomUUID(),
          resourceId,
          start: at('2026-10-11T09:00:00Z'),
          end: at('2026-10-11T10:00:00Z'),
          kind: 'hold',
          reference: null,
          summary: null,
          expiresAt: at('2026-10-10T12:15:00Z'),
          source: null,
        },
      ],
      [
        {
          id: 'msg_2',
          type: 'reservation.cancelled',
          resourceId,
          subject: 'rental-6',
          data: {},
          occurredAt: at('2026-10-10T11:55:00Z'),
          actor: `api_key:${created.apiKey.id}`,
          position: 'p2',
        },
        {
          id: 'msg_1',
          type: 'hold.expired',
          resourceId: null,
          subject: 'h',
          data: {},
          occurredAt: at('2026-10-08T12:00:00Z'),
          actor: null,
          position: 'p1',
        },
      ],
    );
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard', session)).text();
    expect(store.agenda).toHaveBeenCalledWith(
      'github:4242',
      { start: new Date(now), end: new Date(now + 7 * 86_400_000) },
      expect.any(Number),
    );
    expect(store.recentChanges).toHaveBeenCalledWith('github:4242', expect.any(Number));
    // Times in the resource's own zone (BST, UTC+1), grouped under Today and Tomorrow.
    expect(html).toMatch(/<h3 class="day">Today<\/h3>[\s\S]*15:00[\s\S]*vehicle-42<\/span><span class="meta">rental-&lt;7&gt; · agent/);
    expect(html).toMatch(/<h3 class="day">Tomorrow<\/h3>[\s\S]*10:00[\s\S]*Held until 13:15/);
    expect(html).toContain('<span class="stat-value">1</span>');
    // The activity names the key, not its id, and says when.
    expect(html).toMatch(/Booking cancelled <span class="on">on<\/span> vehicle-42[\s\S]*Booking agent · <time[^>]*>5 min ago/);
    expect(html).toMatch(/Hold expired<\/span><span class="meta">Slotlock · <time[^>]*>2 d ago/);
    expect(html).not.toContain(created.apiKey.id);
  });

  it('names the people who changed things from the dashboard', async () => {
    const change = (actor: string, id: string) => ({
      id,
      type: 'hold.released' as const,
      resourceId: null,
      subject: 'h',
      data: {},
      occurredAt: new Date(now - 60_000),
      actor,
      position: id,
    });
    const { target } = withFeed([], [change('github:4242', 'msg_2'), change('github:777', 'msg_1')]);
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard', session)).text();
    expect(html).toMatch(/Hold released<\/span><span class="meta">You · /);
    expect(html).toMatch(/Hold released<\/span><span class="meta">GitHub user 777 · /);
  });

  it('walks a new tenant through its first steps, and hides them once done', async () => {
    const empty = withFeed([], []);
    const { session } = await signIn(empty.target);
    const first = await (await get(empty.target, '/base/dashboard', session)).text();
    expect(first).toContain('Get started');
    expect(first).toContain('Nothing booked in the next 7 days.');
    expect(first).toContain('No activity yet.');
    expect(first).toContain('href="/base/dashboard/resources">Add what your agents book</a>');
  });

  it('leaves out the agenda and activity for resources without them', async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard', session)).text();
    expect(html).not.toContain('Upcoming');
    expect(html).not.toContain('Agent activity');
    expect(html).toContain('Active keys');
  });

  it('marks the current page in the navigation, and sends a visitor to sign in', async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    for (const [path, label] of [
      ['', 'Overview'],
      ['/resources', 'Resources'],
      ['/keys', 'API keys'],
      ['/settings', 'Settings'],
    ] as const) {
      const html = await (await get(target, `/base/dashboard${path}`, session)).text();
      expect(html).toContain(`<a href="/base/dashboard${path}" aria-current="page">`);
      expect(html).toContain(`<span>${label}</span>`);
      if (path !== '') {
        const visitor = await get(target, `/base/dashboard${path}`);
        expect(visitor.status).toBe(303);
        expect(visitor.headers.get('location')).toBe('/base/dashboard');
      }
    }
  });

  it('takes the deployment its name, and refuses one that is not a name', async () => {
    const target = dashboard({ name: 'Acme Fleet Calendar' });
    expect(await (await get(target, '/base/dashboard')).text()).toContain(
      '<title>Sign in · Acme Fleet Calendar</title>',
    );
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard', session)).text();
    expect(html).toContain('<span class="name">Acme Fleet Calendar</span>');
    for (const name of ['', ' padded', '<b>x</b>', 'x'.repeat(61), 'line\nbreak', 'Acme\u202eteeLF', 'zero\u200bwidth', 'c1\u0085']) {
      expect(() => dashboard({ name })).toThrow(/dashboard name/);
    }
  });
});

describe('resource detail, webhooks and the waitlist', () => {
  const OWN = '22222222-2222-4222-8222-222222222222';
  const THEIRS = '33333333-3333-4333-8333-333333333333';

  function full() {
    resources.rows.push(
      { id: OWN, externalRef: 'van-1', tenantRef: 'github:4242', timezone: 'UTC' },
      { id: THEIRS, externalRef: 'van-x', tenantRef: 'github:1', timezone: 'UTC' },
    );
    const endpoints: SlotlockWebhookEndpoint[] = [];
    const entries: SlotlockWaitlistEntry[] = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        resourceId: OWN,
        pool: null,
        start: new Date(now + 3_600_000),
        end: new Date(now + 7_200_000),
        holderRef: 'customer-<9>',
        offerTtlMs: 600_000,
        status: 'waiting',
        holdId: null,
        offeredResourceId: null,
        offeredAt: null,
        createdAt: new Date(now - 600_000),
      },
    ];
    const store = {
      ...resources.store,
      setRules: vi.fn(async (tenantRef: string, id: string, rules: unknown) => {
        if ((rules as { minNoticeMinutes?: number } | null)?.minNoticeMinutes === 7) {
          throw Object.assign(new Error('Slotlock booking rule minNoticeMinutes is odd'), { code: 'invalid_booking_rules' });
        }
        if ((rules as { minNoticeMinutes?: number } | null)?.minNoticeMinutes === 8) {
          throw Object.assign(new Error('suspended'), { code: 'tenant_suspended' });
        }
        const row = resources.rows.find((r) => r.id === id && r.tenantRef === tenantRef);
        if (!row) return null;
        if (rules === null) delete (row as SlotlockResource).bookingRules;
        else (row as SlotlockResource).bookingRules = rules as never;
        return row;
      }),
      setPool: vi.fn(async (tenantRef: string, id: string, pool: string | null) => {
        if (pool === 'bad pool!') throw Object.assign(new Error('bad'), { code: 'invalid_pool' });
        const row = resources.rows.find((r) => r.id === id && r.tenantRef === tenantRef);
        if (!row) return null;
        if (pool === null) delete (row as SlotlockResource).pool;
        else (row as SlotlockResource).pool = pool;
        return row;
      }),
      waitlist: {
        list: vi.fn(async (tenantRef: string) => (tenantRef === 'github:4242' ? entries : [])),
        leave: vi.fn(async (tenantRef: string, id: string) => {
          const index = entries.findIndex((entry) => entry.id === id);
          if (tenantRef !== 'github:4242' || index < 0) return false;
          entries.splice(index, 1);
          return true;
        }),
      },
      webhooks: {
        list: vi.fn(async () => endpoints),
        create: vi.fn(async (_tenantRef: string, url: string, eventTypes: readonly string[] | undefined) => {
          if (!url.startsWith('https://')) return { ok: false as const, code: 'invalid_webhook_url' as const };
          const endpoint: SlotlockWebhookEndpoint = {
            id: randomUUID(),
            url,
            eventTypes: eventTypes ? ([...eventTypes] as never) : null,
            createdAt: new Date(now),
            attempts: 0,
            failingSince: null,
            lastStatus: null,
            lastError: null,
            disabledAt: null,
            disabledReason: null,
          };
          endpoints.push(endpoint);
          return { ok: true as const, endpoint, secret: 'whsec_c2VjcmV0LXZhbHVl' };
        }),
        remove: vi.fn(async (_tenantRef: string, id: string) => {
          const index = endpoints.findIndex((endpoint) => endpoint.id === id);
          if (index < 0) return false;
          endpoints.splice(index, 1);
          return true;
        }),
        enable: vi.fn(async (_tenantRef: string, id: string) => {
          const endpoint = endpoints.find((candidate) => candidate.id === id);
          if (!endpoint) return null;
          endpoint.disabledAt = null;
          return endpoint;
        }),
      },
    };
    return { target: dashboard({ resources: store }), store, endpoints, entries };
  }

  it("shows a resource's rules and pool, saves them, and refuses another tenant's", async () => {
    const { target, store } = full();
    const { session } = await signIn(target);
    const page = await get(target, `/base/dashboard/resources/${OWN}`, session);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<h1>van-1</h1>');
    expect((await get(target, `/base/dashboard/resources/${THEIRS}`, session)).status).toBe(404);
    expect((await get(target, `/base/dashboard/resources/${OWN}`)).status).toBe(303);

    const token = await csrf(target, session);
    const saved = await post(
      target,
      '/base/dashboard/resources/rules',
      { csrf: token, id: OWN, min_notice_minutes: '60', slot_step_minutes: '15', max_advance_days: '', turnaround_minutes: '', check_in_minutes: '20', enforce_hours: '1', require_certain: '1' },
      session,
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(`/base/dashboard/resources/${OWN}`);
    expect(store.setRules).toHaveBeenLastCalledWith(
      'github:4242',
      OWN,
      { minNoticeMinutes: 60, slotStepMinutes: 15, checkInMinutes: 20, enforceHours: true, requireCertain: true },
      'github:4242',
    );
    const shown = await (await get(target, `/base/dashboard/resources/${OWN}`, session)).text();
    expect(shown).toContain('name="min_notice_minutes" value="60"');
    expect(shown).toMatch(/name="enforce_hours" value="1" checked/);
    expect(shown).toMatch(/name="require_certain" value="1" checked/);

    // Empty fields clear every rule; a value the store refuses says why.
    await post(target, '/base/dashboard/resources/rules', { csrf: token, id: OWN }, session);
    expect(store.setRules).toHaveBeenLastCalledWith('github:4242', OWN, null, 'github:4242');
    // Out of a rule's bounds: said in the form's words, before the store is asked.
    const calls = store.setRules.mock.calls.length;
    const refused = await post(target, '/base/dashboard/resources/rules', { csrf: token, id: OWN, slot_step_minutes: '0' }, session);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('Start step is a whole number from 1 to 1,440');
    expect(store.setRules.mock.calls.length).toBe(calls);
    expect(await (await get(target, `/base/dashboard/resources/${OWN}`, session)).text()).toContain('min="1" max="1440" name="slot_step_minutes"');
    const kept = await post(target, '/base/dashboard/resources/rules', { csrf: token, id: OWN, min_notice_minutes: '7' }, session);
    expect(kept.status).toBe(400);
    expect(await kept.text()).toContain('not ones Slotlock can keep');
    const suspended = await post(target, '/base/dashboard/resources/rules', { csrf: token, id: OWN, min_notice_minutes: '8' }, session);
    expect(suspended.status).toBe(403);
    expect(await suspended.text()).toContain('suspended');
    const notNumber = await post(target, '/base/dashboard/resources/rules', { csrf: token, id: OWN, slot_step_minutes: '1.5' }, session);
    expect(notNumber.status).toBe(400);
    const foreign = await post(target, '/base/dashboard/resources/rules', { csrf: token, id: THEIRS, min_notice_minutes: '5' }, session);
    expect(foreign.status).toBe(404);
    expect(store.setRules).not.toHaveBeenCalledWith(expect.anything(), THEIRS, expect.anything());

    expect((await post(target, '/base/dashboard/resources/pool', { csrf: token, id: OWN, pool: 'vans' }, session)).status).toBe(303);
    expect(store.setPool).toHaveBeenLastCalledWith('github:4242', OWN, 'vans', 'github:4242');
    expect(await (await get(target, '/base/dashboard/resources', session)).text()).toContain('Pool vans');
    expect((await post(target, '/base/dashboard/resources/pool', { csrf: token, id: OWN, pool: 'bad pool!' }, session)).status).toBe(400);
    await post(target, '/base/dashboard/resources/pool', { csrf: token, id: OWN, pool: '' }, session);
    expect(store.setPool).toHaveBeenLastCalledWith('github:4242', OWN, null, 'github:4242');
  });

  it('shows which booking rules a resource takes from the pool and tenant defaults, and saves the new ones', async () => {
    const { target, store } = full();
    const ruleDefaults = vi.fn(async () => ({
      tenant: { minNoticeMinutes: 120, bufferBeforeMinutes: 5 },
      pools: { van: { bufferBeforeMinutes: 15, enforceHours: true } },
    }));
    const withDefaults = dashboard({ resources: { ...store, ruleDefaults } });
    const row = resources.rows.find((candidate) => candidate.id === OWN) as SlotlockResource;
    row.pool = 'van';
    row.bookingRules = { turnaroundMinutes: 10 };
    const { session } = await signIn(withDefaults);
    const page = await (await get(withDefaults, `/base/dashboard/resources/${OWN}`, session)).text();
    expect(ruleDefaults).toHaveBeenCalledWith('github:4242');
    // An empty field shows the value it inherits; the note says from where, the pool's winning.
    expect(page).toContain('name="min_notice_minutes" value="" placeholder="120"');
    expect(page).toContain('name="buffer_before_minutes" value="" placeholder="15"');
    expect(page).toContain('name="turnaround_minutes" value="10">');
    expect(page).toContain(
      'Inherited: Minimum notice 120 (every resource); Buffer before 15 (pool van); Only inside bookable hours (pool van).',
    );
    // An inherited on-or-off rule is a choice of its default, on or off, so it can be turned off here.
    expect(page).toContain(
      '<select name="enforce_hours"><option value="" selected>As its default (on, pool van)</option><option value="1">On</option><option value="0">Off</option></select>',
    );
    expect(page).toContain('name="require_certain" value="1"> Only in time');
    const token0 = await csrf(withDefaults, session);
    await post(withDefaults, '/base/dashboard/resources/rules', { csrf: token0, id: OWN, enforce_hours: '0' }, session);
    expect(store.setRules).toHaveBeenLastCalledWith('github:4242', OWN, { enforceHours: false }, 'github:4242');
    const off = await (await get(withDefaults, `/base/dashboard/resources/${OWN}`, session)).text();
    expect(off).toContain('<option value="0" selected>Off</option>');
    row.bookingRules = { turnaroundMinutes: 10 };
    // Without the defaults, what applies beyond its own is said to come from defaults.
    delete row.bookingRules;
    row.effectiveBookingRules = { minNoticeMinutes: 30 };
    const plain = await (await get(target, `/base/dashboard/resources/${OWN}`, session)).text();
    expect(plain).toContain('Inherited: Minimum notice 30 (defaults).');

    const token = await csrf(withDefaults, session);
    const saved = await post(
      withDefaults,
      '/base/dashboard/resources/rules',
      { csrf: token, id: OWN, slot_step_minutes: '30', step_offset_minutes: '15', buffer_before_minutes: '20' },
      session,
    );
    expect(saved.status).toBe(303);
    expect(store.setRules).toHaveBeenLastCalledWith(
      'github:4242',
      OWN,
      { slotStepMinutes: 30, stepOffsetMinutes: 15, bufferBeforeMinutes: 20 },
      'github:4242',
    );
  });

  it('adds a webhook showing its secret once, lists its health, and deletes or enables it', async () => {
    const { target, store, endpoints } = full();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    const added = await post(
      target,
      '/base/dashboard/webhooks',
      { csrf: token, url: 'https://hooks.example.com/in', event_type: 'reservation.created' },
      session,
    );
    expect(added.status).toBe(200);
    expect(await added.text()).toContain('value="whsec_c2VjcmV0LXZhbHVl"');
    expect(store.webhooks.create).toHaveBeenCalledWith('github:4242', 'https://hooks.example.com/in', ['reservation.created'], 'github:4242');
    const listed = await (await get(target, '/base/dashboard/webhooks', session)).text();
    expect(listed).not.toContain('whsec_');
    expect(listed).toContain('Delivering');

    const endpoint = endpoints[0] as SlotlockWebhookEndpoint;
    Object.assign(endpoint, { failingSince: new Date(now - 3_600_000), attempts: 4, lastStatus: 503 });
    expect(await (await get(target, '/base/dashboard/webhooks', session)).text()).toMatch(/Failing[\s\S]*4 attempts, last HTTP 503/);
    Object.assign(endpoint, { disabledAt: new Date(now), disabledReason: 'Failing for a day' });
    const disabled = await (await get(target, '/base/dashboard/webhooks', session)).text();
    expect(disabled).toContain('action="/base/dashboard/webhooks/enable"');
    expect((await post(target, '/base/dashboard/webhooks/enable', { csrf: token, id: endpoint.id }, session)).status).toBe(303);
    expect(endpoint.disabledAt).toBeNull();

    const bad = await post(target, '/base/dashboard/webhooks', { csrf: token, url: 'http://x.example.com' }, session);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Give an https URL');
    expect((await post(target, '/base/dashboard/webhooks/delete', { csrf: token, id: endpoint.id }, session)).status).toBe(303);
    expect(endpoints).toHaveLength(0);
    expect((await post(target, '/base/dashboard/webhooks/delete', { csrf: token, id: endpoint.id }, session)).status).toBe(404);
  });

  it('lists the waitlist and removes an entry', async () => {
    const { target, store, entries } = full();
    const { session } = await signIn(target);
    const page = await (await get(target, '/base/dashboard/waitlist', session)).text();
    expect(page).toContain('customer-&lt;9&gt;');
    expect(page).toMatch(/Today 13:00–14:00<\/td>\s*<td data-label="For">van-1/);
    const id = entries[0]?.id as string;
    const removed = await post(target, '/base/dashboard/waitlist/leave', { csrf: await csrf(target, session), id }, session);
    expect(removed.status).toBe(303);
    expect(store.waitlist.leave).toHaveBeenCalledWith('github:4242', id, 'github:4242');
    expect(entries).toHaveLength(0);
    expect((await post(target, '/base/dashboard/waitlist/leave', { csrf: await csrf(target, session), id }, session)).status).toBe(404);
  });

  it('shows Waitlist and Webhooks only for an adapter that has them', async () => {
    const plain = dashboard();
    const first = await signIn(plain);
    const html = await (await get(plain, '/base/dashboard', first.session)).text();
    expect(html).not.toContain('/base/dashboard/webhooks');
    expect((await get(plain, '/base/dashboard/webhooks', first.session)).status).toBe(404);
    const { target } = full();
    const second = await signIn(target);
    const nav = await (await get(target, '/base/dashboard', second.session)).text();
    expect(nav).toContain('<span>Webhooks</span>');
    expect(nav).toContain('<span>Waitlist</span>');
  });
});
