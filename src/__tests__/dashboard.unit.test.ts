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
import type { SlotlockResource } from '../types.js';

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
        const resource = { id: randomUUID(), externalRef, tenantRef, timezone, createdAt: new Date() };
        rows.push(resource as SlotlockResource & { tenantRef: string });
        return resource as unknown as SlotlockResource;
      }),
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
    github: { clientId: 'Ov23liFakeClientId00', clientSecret: 'f'.repeat(20) + '0123456789abcdef0123' },
    sessionSecret: SESSION_SECRET,
    allowedUsers: [String(GITHUB_USER.id)],
    keys: keys.store,
    resources: resources.store,
    availability: [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 540, durationMinutes: 480 }],
    state: createSlotlockMemoryDashboardState(() => now),
    fetch: github.fetch,
    now: () => now,
    ...overrides,
  });
}

const get = (target: ReturnType<typeof dashboard>, path: string, cookie?: string) =>
  target.fetch(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {}));

function post(
  target: ReturnType<typeof dashboard>,
  path: string,
  fields: Record<string, string>,
  cookie: string,
  origin: string | null = ORIGIN,
) {
  const headers: Record<string, string> = {
    cookie,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (origin !== null) headers.origin = origin;
  return target.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(fields).toString(),
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
    expect((await get(dashboard(), '/base/dashboard/style.css?v=old')).headers.get('cache-control')).toBe(
      'no-cache',
    );
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
    expect(oauth?.attributes).toEqual(['Path=/', 'Max-Age=600', 'Secure', 'HttpOnly', 'SameSite=Lax']);
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
    expect(createHash('sha256').update(sent.code_verifier as string).digest('base64url')).toBe(
      location.searchParams.get('code_challenge'),
    );
    expect(user?.url).toBe('https://api.github.com/user');
    expect(Object.fromEntries(new Headers(user?.init.headers))).toMatchObject({
      authorization: 'Bearer gho_fake',
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10',
      'user-agent': 'slotlock-dashboard',
    });

    const page = await (await get(dashboard(), '/base/dashboard', session)).text();
    expect(page).toContain('@octocat');
    expect(page).toContain('Mon, Tue, Wed, Thu, Fri: 09:00–17:00');
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
    expect(signedIn(await (await get(dashboard(), '/base/dashboard', tampered)).text())).toBe(false);

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
    const response = await post(target, '/base/dashboard/sign-out', { csrf: await csrf(target, session) }, session);
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

    const listed = await (await get(target, '/base/dashboard', session)).text();
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

  it.each([
    ['no CSRF token', (token: string) => ({ name: 'x', access: 'read', expires: 'never' }), ORIGIN],
    ['another token', () => ({ csrf: 'x'.repeat(43), name: 'x', access: 'read', expires: 'never' }), ORIGIN],
    ['another origin', (token: string) => ({ csrf: token, name: 'x', access: 'read', expires: 'never' }), 'https://evil.example'],
    ['no origin', (token: string) => ({ csrf: token, name: 'x', access: 'read', expires: 'never' }), null],
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
    const second = await signIn(
      dashboard({ allowedUsers: '*' }),
    );
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
    const html = await (await get(target, '/base/dashboard', session)).text();
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
  });

  it("rotates and revokes keys in the person's tenant only", async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    await post(target, '/base/dashboard/keys', { csrf: token, name: 'A', access: 'read', expires: 'never' }, session);
    const [row] = [...keys.rows.values()];

    const rotated = await post(target, '/base/dashboard/keys/rotate', { csrf: token, id: row?.id as string }, session);
    expect(rotated.status).toBe(200);
    expect(keys.store.rotate).toHaveBeenCalledWith({ tenantRef: 'github:4242', id: row?.id });
    expect(await rotated.text()).toContain(keys.rows.get(row?.id as string)?.key as string);

    const revoked = await post(target, '/base/dashboard/keys/revoke', { csrf: token, id: row?.id as string }, session);
    expect(revoked.status).toBe(303);
    expect(keys.store.revoke).toHaveBeenCalledWith({ tenantRef: 'github:4242', id: row?.id });

    const missing = await post(target, '/base/dashboard/keys/revoke', { csrf: token, id: randomUUID() }, session);
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
    expect(resources.store.add).toHaveBeenCalledWith('github:4242', 'vehicle-42', 'Europe/London');
    expect(await (await get(target, '/base/dashboard', session)).text()).toContain('vehicle-42');

    const zone = await post(
      target,
      '/base/dashboard/resources',
      { csrf: token, reference: 'vehicle-43', timezone: 'Mars/Olympus' },
      session,
    );
    expect(zone.status).toBe(400);
    expect(await zone.text()).toContain('not a time zone');

    for (let index = resources.rows.length; index < SLOTLOCK_DASHBOARD_MAX_RESOURCES; index += 1) {
      resources.rows.push({ id: randomUUID(), externalRef: `r${index}`, tenantRef: 'github:4242', timezone: 'UTC' } as never);
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
    expect(resources.rows.find((row) => row.externalRef === 'vehicle-42')?.timezone).toBe('Europe/Paris');
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
        headers: { cookie: session, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
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
        headers: { cookie: session, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
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
      const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') as string;
      const pending = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
      expect((await get(target, `/base/dashboard/callback?code=c&state=${state}`, pending)).status).toBe(500);
    }
    expect(errors).toHaveLength(9);
    expect(github.fetch).not.toHaveBeenCalled();
    // More failures than the 8 slots, and the next sign-in still gets one.
    const { session } = await signIn(target);
    expect(session).toMatch(/^__Host-slotlock-session=/);
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
        get(target, `/base/dashboard/callback?code=c&state=${state}`, cookie(start, '__Host-slotlock-oauth')?.pair),
      );
    }
    // Without a cap the ninth would wait on GitHub too; with one it is refused at once.
    const ninth = await Promise.race([
      callbacks[8],
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 200)),
    ]);
    expect(ninth instanceof Response ? ninth.status : ninth).toBe(503);
    expect(held).toHaveBeenCalledTimes(8);
    for (let turn = 0; turn < 100 && (release.length > 0 || held.mock.calls.length < 16); turn += 1) {
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
    const html = await (await get(target, '/base/dashboard', session)).text();
    const token = /name="csrf" value="([^"]+)"/.exec(html)?.[1] as string;
    const once = /action="\/base\/dashboard\/keys">\s*<input type="hidden" name="csrf" value="[^"]+">\s*<input type="hidden" name="once" value="([^"]+)">/.exec(html)?.[1];
    expect(once).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    const fields = { csrf: token, once: once as string, name: 'Once', access: 'read', expires: 'never' };
    expect((await post(target, '/base/dashboard/keys', fields, session)).status).toBe(200);
    const again = await post(target, '/base/dashboard/keys', fields, session);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('already sent');
    expect(keys.store.create).toHaveBeenCalledTimes(1);
  });

  it("logs GitHub's error code, and nothing secret, when sign-in fails there", async () => {
    const onError = vi.fn();
    const failing = vi.fn(async () => Response.json({ error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' }));
    const { callback } = await signIn(dashboard({ fetch: failing as unknown as typeof fetch, onError }));
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
