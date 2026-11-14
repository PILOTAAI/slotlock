// The dashboard without a database: GitHub sign-in (state + PKCE), sealed sessions, CSRF and origin
// checks, the key shown once, escaping, and the allowlist. GitHub is a fake `fetch`; keys and
// resources are in-memory stores with the same contracts as the real ones.
import { type SlotlockResourceProfileInput, parseSlotlockResourceProfile } from '../resource-profile.js';
import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { SLOTLOCK_CHANGE_TYPES, type SlotlockChange, type SlotlockWebhookEndpoint } from '../event-feed.js';
import type { SlotlockTenantPlan } from '../plans.js';
import { createSlotlockMemoryDashboardWorkspaces } from '../workspaces.js';
import { slotlockDashboardRequestScope } from '../dashboard-scope.js';
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
        ...(input.resourceScope ? { resourceScope: input.resourceScope } : {}),
        ...(input.limits ? { limits: input.limits } : {}),
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
    setLimits: vi.fn(async ({ tenantRef, id, limits }: { tenantRef: string; id: string; limits: Record<string, unknown> }) => {
      const row = rows.get(id);
      if (!row || row.tenantRef !== tenantRef || row.revokedAt) return false;
      if (Object.keys(limits).length === 0) delete (row as { limits?: unknown }).limits;
      else (row as { limits?: unknown }).limits = limits;
      return true;
    }),
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

  // Without HSTS a browser's first visit to the dashboard, or a typed http:// address, may be
  // answered by anyone on the network before Cloudflare's redirect: a sign-in page of their own.
  it('tells browsers to reach an https dashboard over https only, and a local http one nothing', async () => {
    for (const path of ['/base/dashboard', '/base/dashboard/keys', '/base/dashboard/nowhere']) {
      expect((await get(dashboard(), path)).headers.get('strict-transport-security')).toBe(
        'max-age=31536000',
      );
    }
    const local = dashboard({ publicUrl: 'http://localhost:8080' });
    expect((await get(local, '/dashboard')).headers.get('strict-transport-security')).toBeNull();
  });

  it('offers GitHub sign-in to a visitor, under a policy that runs no inline code', async () => {
    const response = await get(dashboard(), '/base/dashboard');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
    // Settings take the page's width (no 640-pixel column), and fields have a colour of their own,
    // so they stand apart from their card in either theme.
    const styles = await css.clone().text();
    expect(styles).not.toContain('minmax(0, 640px)');
    expect(styles).toMatch(/\.settings-body \{[^}]*max-width: 1080px/);
    expect(styles).toMatch(/--field: #ffffff;[\s\S]*--field: #18181d;/);
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

  it('links and serves the Slotlock mark as its favicon, the same file as the site\'s', async () => {
    const html = await (await get(dashboard(), '/base/dashboard')).text();
    const iconPath = /<link rel="icon" href="(\/base\/dashboard\/favicon\.svg\?v=[A-Za-z0-9_-]{12})" type="image\/svg\+xml">/.exec(
      html,
    )?.[1];
    expect(iconPath).toBeDefined();
    const icon = await get(dashboard(), iconPath as string);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/svg+xml');
    expect(icon.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(icon.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await icon.text()).trim()).toBe(readFileSync(resolve('site/public/favicon.svg'), 'utf8').trim());
  });
});

describe('GitHub sign-in', () => {
  it('names the terms beside the button only when the deployment sets them', async () => {
    const plain = await (await get(dashboard(), '/base/dashboard')).text();
    expect(plain).toContain('Continue with GitHub');
    expect(plain).not.toContain('By continuing you agree');
    const withTerms = await (
      await get(
        dashboard({
          termsUrl: 'https://slotlock.example/terms/',
          privacyUrl: 'https://slotlock.example/privacy/',
        }),
        '/base/dashboard',
      )
    ).text();
    expect(withTerms).toContain(
      'By continuing you agree to the <a href="https://slotlock.example/terms/">Terms of Service</a>. The <a href="https://slotlock.example/privacy/">Privacy notice</a> says what is kept.',
    );
    const termsOnly = await (
      await get(dashboard({ termsUrl: 'https://slotlock.example/terms/' }), '/base/dashboard')
    ).text();
    expect(termsOnly).toContain('<a href="https://slotlock.example/terms/">Terms of Service</a>.</p>');
    expect(termsOnly).not.toContain('Privacy notice');
    expect(() => dashboard({ termsUrl: 'http://slotlock.example/terms/' })).toThrow(/termsUrl must be an https URL/);
    expect(() => dashboard({ privacyUrl: 'https://slotlock.example/"x' })).toThrow(/privacyUrl must be an https URL/);
  });

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

    // Settings is one page a section: the account, the server's hours, the endpoints.
    const sections = await Promise.all(
      ['/settings/account', '/settings/hours', '/settings'].map(async (path) =>
        (await get(dashboard(), `/base/dashboard${path}`, session)).text(),
      ),
    );
    expect(sections[0]).toContain('@octocat');
    expect(sections[1]).toContain('Mon–Fri: 09:00–17:00');
    expect(sections[2]).toContain('https://slotlock.example.com/base/mcp');
    for (const page of sections) expect(page).not.toContain('gho_fake');
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
      origin: 'dashboard',
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

  it("holds a key below the server's limits, from its form and later (RFC 0004 A5)", async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    const made = await post(
      target,
      '/base/dashboard/keys',
      { csrf: token, name: 'Bounded', access: 'read_write', expires: 'never', max_holds: '3', requests_per_minute: '60' },
      session,
    );
    expect(made.status).toBe(200);
    expect(keys.store.create).toHaveBeenLastCalledWith(expect.objectContaining({ limits: { maxHolds: 3, requestsPerMinute: 60 } }));
    const [row] = [...keys.rows.values()];
    expect(await (await get(target, '/base/dashboard/keys', session)).text()).toContain(
      '<span class="meta wrap">At most 3 live holds, 60 requests a minute</span>',
    );
    const saved = await post(
      target,
      '/base/dashboard/keys/limits',
      { csrf: token, id: row?.id as string, max_held_hours: '48', requires_approval: 'on' },
      session,
    );
    expect(saved.status).toBe(303);
    expect(keys.store.setLimits).toHaveBeenLastCalledWith({
      tenantRef: 'github:4242',
      id: row?.id,
      limits: { maxHeldHours: 48, requiresApproval: true },
    });
    const bad = await post(target, '/base/dashboard/keys/limits', { csrf: token, id: row?.id as string, max_holds: '0' }, session);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('Give each limit as a whole number');
    const elsewhere = await post(target, '/base/dashboard/keys/limits', { csrf: token, id: randomUUID(), max_holds: '2' }, session);
    expect(elsewhere.status).toBe(404);
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
    expect(keys.store.rotate).toHaveBeenCalledWith({
      tenantRef: 'github:4242',
      id: row?.id,
      actor: 'github:4242',
      origin: 'dashboard',
    });
    expect(await rotated.text()).toContain(keys.rows.get(row?.id as string)?.key as string);

    const revoked = await post(
      target,
      '/base/dashboard/keys/revoke',
      { csrf: token, id: row?.id as string },
      session,
    );
    expect(revoked.status).toBe(303);
    expect(keys.store.revoke).toHaveBeenCalledWith({
      tenantRef: 'github:4242',
      id: row?.id,
      actor: 'github:4242',
      origin: 'dashboard',
    });

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
  it('makes a resource a part of a whole, shows a whole its parts, and says why one is refused', async () => {
    const setParent = vi.fn(async (_tenantRef: string, id: string, parentId: string | null) => {
      if (parentId === 'busy') throw Object.assign(new Error('busy'), { code: 'composite_busy' });
      const row = resources.rows.find((candidate) => candidate.id === id) as SlotlockResource;
      if (parentId === null) delete row.parentId;
      else Object.assign(row, { parentId, partIndex: 0 });
      return row;
    });
    const target = dashboard({ resources: { ...resources.store, setParent } });
    const { session } = await signIn(target);
    const hall = await resources.store.add('github:4242', 'hall', 'UTC');
    const room = await resources.store.add('github:4242', 'room-1', 'UTC');
    const page = await (await get(target, `/base/dashboard/resources/${room.id}`, session)).text();
    expect(page).toContain('id="composite"');
    expect(page).toContain(`<option value="${hall.id}">hall</option>`);
    const saved = await post(target, '/base/dashboard/resources/parent', { csrf: await csrf(target, session), id: room.id, parent: hall.id }, session);
    expect(saved.status).toBe(303);
    expect(setParent).toHaveBeenCalledWith('github:4242', room.id, hall.id, 'github:4242');
    // The whole lists its parts instead of a choice.
    const whole = await (await get(target, `/base/dashboard/resources/${hall.id}`, session)).text();
    expect(whole).toContain('A whole of 1 part');
    expect(whole).toContain(`href="/base/dashboard/resources/${room.id}"`);
    // Parts are listed in their order, not the order they were added.
    const first = await resources.store.add('github:4242', 'room-0', 'UTC');
    Object.assign(room, { partIndex: 1 });
    Object.assign(resources.rows.find((row) => row.id === first.id) as SlotlockResource, { parentId: hall.id, partIndex: 0 });
    const ordered = await (await get(target, `/base/dashboard/resources/${hall.id}`, session)).text();
    expect(ordered).toMatch(new RegExp(`A whole of 2 parts: <a href="[^"]+${first.id}">room-0</a>, <a href="[^"]+${room.id}">room-1</a>`));
    // Another tenant's resource is not a choice, and a refusal is said in words.
    expect((await post(target, '/base/dashboard/resources/parent', { csrf: await csrf(target, session), id: room.id, parent: randomUUID() }, session)).status).toBe(400);
  });

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
    const settings = await (await get(target, '/base/dashboard/settings/hours', session)).text();
    expect(settings).toContain('Mon–Fri: 09:00–17:00');
    // The server's hours come last: after a resource's own, its location's and the tenant's.
    expect(settings).toContain(`for resources with no hours of their own, their location's or <a href="/base/dashboard/hours">yours</a>`);
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
    expect(page).toContain('Every resource without hours of its own uses these');
    expect(page).toMatch(/name="resource" value="all"/);
    // No resource keeps hours of its own, so there is nothing to keep or clear.
    expect(page).not.toContain('name="override"');
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
    // Stored as the tenant's, which every resource without its own inherits (RFC 0004 B2).
    expect(resources.store.setHours).toHaveBeenCalledWith('github:4242', 'all', [
      { rrule: 'FREQ=WEEKLY;BYDAY=SA', startMinutes: 600, durationMinutes: 240 },
    ], 'github:4242', 'none');
  });

  it("names the resources that keep hours of their own, and clears copies of the tenant's with 'matching'", async () => {
    own('car-plain');
    own('car-copy', [weekdays]);
    own('car-late', [{ rrule: 'FREQ=WEEKLY;BYDAY=SA', startMinutes: 1_200, durationMinutes: 120 }]);
    const target = dashboard();
    const { session } = await signIn(target);
    const page = await (await get(target, '/base/dashboard/hours', session)).text();
    expect(page).toContain('<legend>2 resources keep hours of their own</legend>');
    expect(page).toMatch(/>car-copy<\/a>, <a [^>]*>car-late<\/a>/);
    expect(page).toContain('<input type="radio" name="override" value="none" checked> Keep them');
    expect(page).toContain('href="/base/dashboard/resources?hours=own"');
    const listed = await (await get(target, '/base/dashboard/resources?hours=own', session)).text();
    expect(listed).toContain('2 resources keep hours of their own');
    expect(listed).toContain('car-copy');
    expect(listed).not.toContain('car-plain');
    const saved = await post(
      target,
      '/base/dashboard/hours',
      { csrf: await csrf(target, session), resource: 'all', mode: 'custom', override: 'matching', ...weekFields({ mo_from_1: '09:00', mo_to_1: '17:00' }) },
      session,
    );
    expect(saved.status).toBe(303);
    expect(resources.store.setHours).toHaveBeenLastCalledWith('github:4242', 'all', expect.any(Array), 'github:4242', 'matching');
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

  it('tells a member who is not an owner that an owner changes the plan', async () => {
    const plans = {
      plan: vi.fn(async () => ({
        plan: 'free' as const,
        status: 'active' as const,
        limits: { resources: 10, apiKeys: 10, webhookEndpoints: 2 },
        stripeCustomer: null,
        stripeSubscription: null,
        currentPeriodEnd: null,
      })),
      contact: 'mailto:founder@example.com',
    };
    const target = orgDashboard([{ ...ACME, role: 'member' }], { plans, resources: { ...resources.store, count: vi.fn(async () => 10) } });
    const { session } = await signIn(target);
    const switched = await post(target, '/base/dashboard/organization', { csrf: await csrf(target, session), organization: String(ACME.id) }, session);
    const inOrg = cookie(switched, '__Host-slotlock-session')?.pair as string;
    const html = await (await get(target, '/base/dashboard/plan', inOrg)).text();
    expect(html).toContain('An owner of this organization can change its plan.');
    expect(html).not.toContain('Talk to us about');
    // At a limit, a member is told who can lift it, with nothing to click that would not let them.
    expect(html).toContain('On Free, you have 10 of 10 resources: adding another is refused. An owner of this organization can upgrade.');
    expect(html).not.toContain('>Upgrade</a>');
  });

  it("leaves an organization's plan and billing to its owners", async () => {
    const billing = {
      plan: vi.fn(async () => ({
        plan: 'free' as const,
        status: 'active' as const,
        limits: { resources: 10, apiKeys: 10, webhookEndpoints: 2 },
        stripeCustomer: 'cus_Org1',
        stripeSubscription: null,
        currentPeriodEnd: null,
      })),
      checkout: vi.fn(async () => 'https://checkout.stripe.com/c/pay/cs_1'),
      portal: vi.fn(async () => 'https://billing.stripe.com/p/session/1'),
      prices: { month: '$10', year: '$100' },
      contact: 'mailto:founder@example.com',
      formOrigins: ['https://checkout.stripe.com', 'https://billing.stripe.com'],
    };
    const member = orgDashboard([ACME], { billing });
    const { session } = await signIn(member);
    const page = await (await get(member, '/base/dashboard/plan', session)).text();
    expect(page).not.toContain('Upgrade to Developer');
    expect(page).not.toContain('Manage billing');
    for (const path of ['/base/dashboard/plan/upgrade', '/base/dashboard/plan/manage']) {
      expect((await post(member, path, { csrf: await csrf(member, session) }, session)).status).toBe(403);
    }
    expect(billing.checkout).not.toHaveBeenCalled();
    expect(billing.portal).not.toHaveBeenCalled();

    const owner = orgDashboard([{ ...ACME, role: 'admin' }], { billing });
    const signedIn = (await signIn(owner)).session;
    const ownerPage = await (await get(owner, '/base/dashboard/plan', signedIn)).text();
    // Without Team prices an organization is offered Team by asking, never Developer, whose
    // limits are a person's; and a checkout for it is refused.
    expect(ownerPage).not.toContain('Upgrade to Developer');
    expect(ownerPage).toContain('Talk to us about Team');
    expect(ownerPage).toContain('Manage billing');
    const refused = await post(owner, '/base/dashboard/plan/upgrade', { csrf: await csrf(owner, signedIn), interval: 'month' }, signedIn);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('Team is not on sale here yet');
    expect(billing.checkout).not.toHaveBeenCalled();
  });

  it("offers an organization's owner Team where the deployment sells it, and a person Developer", async () => {
    const billing = {
      plan: vi.fn(async () => null),
      checkout: vi.fn(async () => 'https://checkout.stripe.com/c/pay/cs_1'),
      portal: vi.fn(async () => 'https://billing.stripe.com/p/session/1'),
      prices: { month: '$10', year: '$100' },
      teamPrices: { month: '$40', year: '$400' },
      contact: 'mailto:founder@example.com',
      formOrigins: ['https://checkout.stripe.com', 'https://billing.stripe.com'],
    };
    const on = new Set([String(ACME.id)]);
    const teams = {
      enabled: vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => on.has(id)))),
      enable: vi.fn(async () => true),
      disable: vi.fn(async () => true),
    };
    const target = orgDashboard([{ ...ACME, role: 'admin' }], { organizations: 'enabled', teams, billing });
    const { session } = await signIn(target);
    const personal = await (await get(target, '/base/dashboard/plan', session)).text();
    expect(personal).toContain('Upgrade to Developer');
    expect(personal).toContain('$10 a month');
    const switched = await post(target, '/base/dashboard/organization', { csrf: await csrf(target, session), organization: String(ACME.id) }, session);
    const inOrg = cookie(switched, '__Host-slotlock-session')?.pair as string;
    const page = await (await get(target, '/base/dashboard/plan', inOrg)).text();
    expect(page).toContain('Upgrade to Team');
    expect(page).toContain('$40 a month');
    await post(target, '/base/dashboard/plan/upgrade', { csrf: await csrf(target, inOrg), interval: 'year' }, inOrg);
    expect(billing.checkout).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantRef: `github-org:${ACME.id}`, interval: 'year', plan: 'team' }),
    );
  });

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

  it("refuses to turn an organization off for a GitHub owner whose workspace role in Slotlock is less than Owner", async () => {
    const on = new Set<string>([String(ACME.id)]);
    const teams = {
      enabled: vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => on.has(id)))),
      enable: vi.fn(async (org: { id: string }) => !on.has(org.id) && Boolean(on.add(org.id))),
      disable: vi.fn(async (id: string) => on.delete(id)),
    };
    const workspaces = createSlotlockMemoryDashboardWorkspaces();
    const target = orgDashboard([{ ...ACME, role: 'admin' }], { organizations: 'enabled', teams, workspaces });
    const { session } = await signIn(target);
    workspaces.setRole(`github-org:${ACME.id}`, `github:${GITHUB_USER.id}`, 'viewer');
    const off = await post(
      target,
      '/base/dashboard/teams/disable',
      { csrf: await csrf(target, session), organization: String(ACME.id), confirm: ACME.login },
      session,
    );
    expect(off.status).toBe(403);
    expect(teams.disable).not.toHaveBeenCalled();
  });

  it('lets an owner turn an organization on, its members switch to it, and turning it off end that', async () => {
    const on = new Set<string>();
    const teams = {
      enabled: vi.fn(async (ids: readonly string[]) => new Set(ids.filter((id) => on.has(id)))),
      enable: vi.fn(async (org: { id: string }) => !on.has(org.id) && Boolean(on.add(org.id))),
      disable: vi.fn(async (id: string) => on.delete(id)),
    };
    const target = orgDashboard([{ ...ACME, role: 'admin' }, GLOBEX], { organizations: 'enabled', teams });
    const { start, session } = await signIn(target);
    // Organizations are read at sign-in, and the person starts in their own tenant.
    expect(new URL(start.headers.get('location') ?? '').searchParams.get('scope')).toBe('read:org');
    await post(target, '/base/dashboard/keys', { csrf: await csrf(target, session), name: 'Mine', access: 'read', expires: '30' }, session);
    expect(keys.store.create).toHaveBeenLastCalledWith(expect.objectContaining({ tenantRef: 'github:4242' }));
    const page = await (await get(target, '/base/dashboard/teams', session)).text();
    expect(page).toContain('acme-fleet');
    expect(page).toContain('An owner can turn it on'); // globex: a member only
    // Nobody switches to an organization that is off, and a member cannot turn one on.
    const refused = await post(target, '/base/dashboard/organization', { csrf: await csrf(target, session), organization: String(ACME.id) }, session);
    expect(refused.status).toBe(400);
    expect((await post(target, '/base/dashboard/teams/enable', { csrf: await csrf(target, session), organization: String(GLOBEX.id) }, session)).status).toBe(403);
    expect(teams.enable).not.toHaveBeenCalled();
    // The owner turns it on; then anyone in it can switch to it, and its keys are the organization's.
    // Who owns it was read at sign-in: 16 minutes on, that is too old to turn it on.
    now += 16 * 60_000;
    const stale = await post(target, '/base/dashboard/teams/enable', { csrf: await csrf(target, session), organization: String(ACME.id) }, session);
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('sign out and in again');
    expect(teams.enable).not.toHaveBeenCalled();
    now -= 16 * 60_000;
    const enabled = await post(target, '/base/dashboard/teams/enable', { csrf: await csrf(target, session), organization: String(ACME.id) }, session);
    expect(await enabled.text()).toContain('Slotlock is on for acme-fleet');
    expect(teams.enable).toHaveBeenCalledWith({ id: String(ACME.id), login: 'acme-fleet' }, 'github:4242');
    const switched = await post(target, '/base/dashboard/organization', { csrf: await csrf(target, session), organization: String(ACME.id) }, session);
    expect(switched.status).toBe(303);
    const inOrg = cookie(switched, '__Host-slotlock-session')?.pair as string;
    await post(target, '/base/dashboard/keys', { csrf: await csrf(target, inOrg), name: 'Shared', access: 'read', expires: '30' }, inOrg);
    expect(keys.store.create).toHaveBeenLastCalledWith(expect.objectContaining({ tenantRef: `github-org:${ACME.id}` }));
    // Back to their own, from the workspace menu.
    const home = await post(target, '/base/dashboard/organization', { csrf: await csrf(target, inOrg), organization: '' }, inOrg);
    const personal = cookie(home, '__Host-slotlock-session')?.pair as string;
    await post(target, '/base/dashboard/keys', { csrf: await csrf(target, personal), name: 'Mine again', access: 'read', expires: '30' }, personal);
    expect(keys.store.create).toHaveBeenLastCalledWith(expect.objectContaining({ tenantRef: 'github:4242' }));
    // Turning it off needs its name, and then a session still in it is back in its own tenant.
    expect((await post(target, '/base/dashboard/teams/disable', { csrf: await csrf(target, inOrg), organization: String(ACME.id), confirm: 'acme' }, inOrg)).status).toBe(400);
    const off = await post(target, '/base/dashboard/teams/disable', { csrf: await csrf(target, inOrg), organization: String(ACME.id), confirm: 'acme-fleet' }, inOrg);
    expect(await off.text()).toContain('Slotlock is off for acme-fleet');
    await post(target, '/base/dashboard/keys', { csrf: await csrf(target, inOrg), name: 'After', access: 'read', expires: '30' }, inOrg);
    expect(keys.store.create).toHaveBeenLastCalledWith(expect.objectContaining({ tenantRef: 'github:4242' }));
  });

  it('needs the teams store to serve organizations turned on', () => {
    expect(() => dashboard({ organizations: 'enabled' })).toThrow(/needs the teams store/);
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
      { csrf: token, once: stale, name: 'Acme agent', access: 'read_write', expires: 'never' },
      moved,
    );
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('That page was for another workspace.');
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
    expect(page).toContain('<span class="meta">Created by you</span>');
    expect(page).toContain('<span class="meta">Created by GitHub user 777</span>');
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

  // Roles (workspace-roles.ts): every route needs a capability, checked from the role before
  // anything is spent or changed. Without a membership store, GitHub's owners are Owners and its
  // members Developers.
  it("lets an organization's member create read-write keys, never Full-access ones, and change only their own", async () => {
    const audited: unknown[] = [];
    const target = orgDashboard([ACME], {
      resources: { ...resources.store, audit: { record: async (_tenant: string, event: unknown) => void audited.push(event), list: async () => [] } },
    });
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    const full = await post(target, '/base/dashboard/keys', { csrf: token, name: 'Agent', access: 'full', expires: 'never' }, session);
    expect(full.status).toBe(403);
    expect(await full.text()).toContain('As a Developer in this workspace, you can&#39;t create or change Full-access keys.');
    expect(keys.store.create).not.toHaveBeenCalled();
    expect(audited).toContainEqual(
      expect.objectContaining({ action: 'authz.denied', outcome: 'denied', actorRef: `github:${GITHUB_USER.id}`, actorRole: 'developer' }),
    );
    const ok = await post(target, '/base/dashboard/keys', { csrf: token, name: 'Agent', access: 'read_write', expires: 'never' }, session);
    expect(ok.status).toBe(200);
    expect(audited).toContainEqual(expect.objectContaining({ action: 'api_key.created', metadata: { access: 'read_write', expires: 'never' } }));
    // Someone else's key in the same workspace.
    const theirs = await keys.store.create({ tenantRef: `github-org:${ACME.id}`, name: 'Owner key', scopes: ['read'], createdBy: 'github:1' });
    const revoke = await post(target, '/base/dashboard/keys/revoke', { csrf: token, id: theirs.apiKey.id }, session);
    expect(revoke.status).toBe(403);
    expect(await revoke.text()).toContain('change a key someone else created');
    expect(keys.store.revoke).not.toHaveBeenCalled();
    // PostgreSQL reads a uuid in any case as the same key: an uppercase id is that key too, and a
    // valid id that names no key of the person's is refused as anyone's.
    for (const id of [theirs.apiKey.id.toUpperCase(), randomUUID()]) {
      for (const route of ['/keys/rotate', '/keys/revoke', '/keys/limits']) {
        const refused = await post(target, `/base/dashboard${route}`, { csrf: token, id }, session);
        expect(refused.status, `${route} ${id}`).toBe(403);
      }
    }
    expect(keys.store.rotate).not.toHaveBeenCalled();
    expect(keys.store.revoke).not.toHaveBeenCalled();
    expect(keys.store.setLimits).not.toHaveBeenCalled();
    for (const route of ['/webhooks', '/contacts/forget', '/settings/assistant', '/plan/manage']) {
      const refused = await post(target, `/base/dashboard${route}`, { csrf: token }, session);
      expect(refused.status, route).toBe(403);
    }
  });

  it('asks an owner who signed in more than 15 minutes ago to sign in again, and comes back to the page', async () => {
    const target = dashboard();
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    now += 16 * 60_000;
    const full = await post(target, '/base/dashboard/keys', { csrf: token, name: 'Agent', access: 'full', expires: 'never' }, session);
    expect(full.status).toBe(403);
    const page = await full.text();
    expect(page).toContain('Confirm it’s you');
    expect(page).toContain('href="/base/dashboard/sign-in?then=%2Fkeys"');
    expect(keys.store.create).not.toHaveBeenCalled();
    // What does not need it still works.
    expect((await post(target, '/base/dashboard/keys', { csrf: token, name: 'Agent', access: 'read', expires: 'never' }, session)).status).toBe(200);
    // Signing in again returns to the keys page, with a session that may.
    const again = await get(target, '/base/dashboard/sign-in?then=%2Fkeys');
    const state = new URL(again.headers.get('location') ?? '').searchParams.get('state');
    const back = await get(target, `/base/dashboard/callback?code=fake-code&state=${state}`, cookie(again, '__Host-slotlock-oauth')?.pair);
    expect(back.headers.get('location')).toBe('/base/dashboard/keys');
    const fresh = cookie(back, '__Host-slotlock-session')?.pair as string;
    const made = await post(target, '/base/dashboard/keys', { csrf: await csrf(target, fresh), name: 'Agent', access: 'full', expires: 'never' }, fresh);
    expect(made.status).toBe(200);
    // Only the dashboard's own pages: anything else lands on the overview.
    const elsewhere = await get(target, '/base/dashboard/sign-in?then=https%3A%2F%2Fevil.example');
    const away = await get(
      target,
      `/base/dashboard/callback?code=fake-code&state=${new URL(elsewhere.headers.get('location') ?? '').searchParams.get('state')}`,
      cookie(elsewhere, '__Host-slotlock-oauth')?.pair,
    );
    expect(away.headers.get('location')).toBe('/base/dashboard');
  });

  it('reads the role from the membership store on every request: a change applies at the next one', async () => {
    const workspaces = createSlotlockMemoryDashboardWorkspaces();
    const target = orgDashboard([{ ...ACME, role: 'admin' }], { workspaces });
    const { session } = await signIn(target);
    const person = `github:${GITHUB_USER.id}`;
    // GitHub's owner of the organization is its Owner, recorded at sign-in.
    expect((await workspaces.standing(`github-org:${ACME.id}`, person, null)).role).toBe('owner');
    const token = await csrf(target, session);
    expect((await post(target, '/base/dashboard/keys', { csrf: token, name: 'A', access: 'full', expires: 'never' }, session)).status).toBe(200);
    // An Admin may change anyone's key, but rotating a Full-access one (which shows its new secret)
    // still asks a recent sign-in, whoever made it.
    workspaces.setRole(`github-org:${ACME.id}`, person, 'admin');
    const theirs = await keys.store.create({ tenantRef: `github-org:${ACME.id}`, name: 'Prod', scopes: ['read', 'write', 'admin'], createdBy: 'github:2' });
    now += 16 * 60_000;
    const stale = await post(target, '/base/dashboard/keys/rotate', { csrf: token, id: theirs.apiKey.id }, session);
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('Confirm it’s you');
    expect(keys.store.rotate).not.toHaveBeenCalled();
    now -= 16 * 60_000;
    // Demoted in the database: the same cookie, the next request.
    workspaces.setRole(`github-org:${ACME.id}`, person, 'developer');
    expect((await post(target, '/base/dashboard/keys', { csrf: token, name: 'B', access: 'full', expires: 'never' }, session)).status).toBe(403);
    // Removed: with a fixed list of organizations there is nowhere else to be, so signed out.
    workspaces.remove(`github-org:${ACME.id}`, person);
    const gone = await get(target, '/base/dashboard/keys', session);
    expect(gone.status).toBe(303);
    expect(gone.headers.get('location')).toBe('/base/dashboard');
  });

  it('signs a person out of every session at once', async () => {
    const workspaces = createSlotlockMemoryDashboardWorkspaces();
    const target = dashboard({ workspaces });
    const laptop = (await signIn(target)).session;
    const phone = (await signIn(target)).session;
    expect((await get(target, '/base/dashboard/settings/account', phone)).status).toBe(200);
    const page = await (await get(target, '/base/dashboard/settings/account', laptop)).text();
    expect(page).toContain('action="/base/dashboard/sign-out-everywhere"');
    expect(page).toContain('<span class="row-label">Role</span><div class="row-value">Owner</div>');
    const out = await post(target, '/base/dashboard/sign-out-everywhere', { csrf: await csrf(target, laptop) }, laptop);
    expect(out.status).toBe(303);
    expect((await get(target, '/base/dashboard/keys', phone)).headers.get('location')).toBe('/base/dashboard');
    expect((await get(target, '/base/dashboard/keys', laptop)).headers.get('location')).toBe('/base/dashboard');
    // A new sign-in is a session of the new epoch.
    const next = (await signIn(target)).session;
    expect((await get(target, '/base/dashboard/keys', next)).status).toBe(200);
    // Without the membership store there is no epoch to move on: nothing to offer, or claim.
    const plain = dashboard();
    const own = (await signIn(plain)).session;
    expect(await (await get(plain, '/base/dashboard/settings/account', own)).text()).not.toContain('sign-out-everywhere');
    expect((await post(plain, '/base/dashboard/sign-out-everywhere', { csrf: await csrf(plain, own) }, own)).status).toBe(404);
  });

  it('signs a person out, and out everywhere, once their forms are spent, each form still once', async () => {
    const state = createSlotlockMemoryDashboardState(() => now);
    const workspaces = createSlotlockMemoryDashboardWorkspaces();
    const target = dashboard({ state, workspaces });
    const laptop = (await signIn(target)).session;
    const phone = (await signIn(target)).session;
    for (let index = 0; index < SLOTLOCK_DASHBOARD_FORM_LIMIT; index += 1) {
      await state.use('form', `spent-${index}`, now + 3_600_000, String(GITHUB_USER.id));
    }
    const token = await csrf(target, laptop);
    expect((await post(target, '/base/dashboard/environment', { csrf: token, environment: 'test' }, laptop)).status).toBe(429);
    // Its Origin, CSRF token and single-use value are checked as any form's.
    expect((await post(target, '/base/dashboard/sign-out-everywhere', { csrf: token }, laptop, 'https://evil.example')).status).toBe(403);
    expect((await post(target, '/base/dashboard/sign-out-everywhere', { csrf: 'wrong' }, laptop)).status).toBe(403);
    expect((await post(target, '/base/dashboard/sign-out-everywhere', { csrf: token }, laptop, ORIGIN, 'none')).status).toBe(400);
    const page = await (await get(target, '/base/dashboard/settings/account', laptop)).text();
    const once = /name="once" value="([^"]+)"/.exec(page)?.[1] as string;
    await state.use('form', once, now + 3_600_000, 'used-elsewhere');
    expect((await post(target, '/base/dashboard/sign-out-everywhere', { csrf: token, once }, laptop)).status).toBe(409);
    const out = await post(target, '/base/dashboard/sign-out-everywhere', { csrf: token }, laptop);
    expect(out.status).toBe(303);
    expect((await get(target, '/base/dashboard/keys', phone)).headers.get('location')).toBe('/base/dashboard');
    // Signing out of one session, with a single-use value or without.
    const tablet = (await signIn(target)).session;
    expect((await post(target, '/base/dashboard/sign-out', { csrf: await csrf(target, tablet), once: 'x' }, tablet)).status).toBe(409);
    expect((await post(target, '/base/dashboard/sign-out', { csrf: await csrf(target, tablet) }, tablet)).status).toBe(303);
    const desk = (await signIn(target)).session;
    const fresh = /name="once" value="([^"]+)"/.exec(await (await get(target, '/base/dashboard/keys', desk)).text())?.[1] as string;
    expect((await post(target, '/base/dashboard/sign-out', { csrf: await csrf(target, desk), once: fresh }, desk)).status).toBe(303);
    expect((await get(target, '/base/dashboard/keys', desk)).headers.get('location')).toBe('/base/dashboard');
  });

  it("answers a form sent twice with the page it renders only where the role reads that page", async () => {
    // Without the Teams or Plans stores, their forms fall back to the overview, which Billing does not read.
    const workspaces = createSlotlockMemoryDashboardWorkspaces();
    const target = orgDashboard([ACME], { workspaces });
    const { session } = await signIn(target);
    workspaces.setRole(`github-org:${ACME.id}`, `github:${GITHUB_USER.id}`, 'billing');
    const formPage = await (await get(target, '/base/dashboard/settings/account', session)).text();
    const once = /name="once" value="([^"]+)"/.exec(formPage)?.[1] as string;
    const formToken = /name="csrf" value="([^"]+)"/.exec(formPage)?.[1] as string;
    for (const route of ['/teams/enable', '/plan/upgrade']) {
      await post(target, `/base/dashboard${route}`, { csrf: formToken, once, organization: String(ACME.id) }, session);
      const replayed = await post(target, `/base/dashboard${route}`, { csrf: formToken, once, organization: String(ACME.id) }, session);
      expect(replayed.status, route).toBe(409);
      const text = await replayed.text();
      expect(text, route).not.toContain('<h1>Overview</h1>');
      expect(text, route).toContain('That form was already sent.');
    }
  });

  it('lets a viewer read and change nothing, and sends a billing manager to Usage', async () => {
    const workspaces = createSlotlockMemoryDashboardWorkspaces();
    const plans = { plan: vi.fn(async () => null), contact: 'mailto:founder@example.com' };
    const target = orgDashboard([ACME], { workspaces, plans });
    const { session } = await signIn(target);
    const person = `github:${GITHUB_USER.id}`;
    workspaces.setRole(`github-org:${ACME.id}`, person, 'viewer');
    expect((await get(target, '/base/dashboard/keys', session)).status).toBe(200);
    const token = await csrf(target, session);
    const added = await post(target, '/base/dashboard/resources', { csrf: token, reference: 'van-1', timezone: 'UTC' }, session);
    expect(added.status).toBe(403);
    expect(await added.text()).toContain('As a Viewer in this workspace, you can&#39;t change resources.');
    workspaces.setRole(`github-org:${ACME.id}`, person, 'billing');
    const overview = await get(target, '/base/dashboard', session);
    expect(overview.headers.get('location')).toBe('/base/dashboard/plan');
    const usage = await get(target, '/base/dashboard/plan', session);
    expect(usage.status).toBe(200);
    const nav = /<nav class="nav"[^>]*>([\s\S]*?)<\/nav>/.exec(await usage.text())?.[1] ?? '';
    expect(nav).toContain('/base/dashboard/plan');
    expect(nav).not.toContain('/base/dashboard/keys');
    expect((await get(target, '/base/dashboard/keys', session)).status).toBe(403);
    // A form sent twice is answered before the role is checked: never with a page the role does
    // not read (the keys page lists every key's name).
    await keys.store.create({ tenantRef: `github-org:${ACME.id}`, name: 'SECRET-PARTNER-KEY', scopes: ['read'], createdBy: 'github:1' });
    const formPage = await (await get(target, '/base/dashboard/settings/account', session)).text();
    const once = /name="once" value="([^"]+)"/.exec(formPage)?.[1] as string;
    const formToken = /name="csrf" value="([^"]+)"/.exec(formPage)?.[1] as string;
    const first = await post(target, '/base/dashboard/keys/revoke', { csrf: formToken, once, id: randomUUID() }, session);
    expect(first.status).toBe(403);
    const replayed = await post(target, '/base/dashboard/keys/revoke', { csrf: formToken, once, id: randomUUID() }, session);
    expect(replayed.status).toBe(409);
    expect(await replayed.text()).not.toContain('SECRET-PARTNER-KEY');
  });
});

describe('a member limited to locations and groups (RFC 0004 D1)', () => {
  const ACME_ORG = { id: 4101, login: 'acme' };
  const signInTo = async (workspaces: ReturnType<typeof createSlotlockMemoryDashboardWorkspaces>, scoped: Partial<SlotlockDashboardResources>) => {
    const github = fakeGitHub();
    const orgs = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith('https://api.github.com/user/memberships/orgs')
        ? Response.json([{ state: 'active', role: 'member', organization: ACME_ORG }])
        : github.fetch(input, init),
    );
    const target = dashboard({
      fetch: orgs,
      organizations: [String(ACME_ORG.id)],
      workspaces,
      resources: { ...resources.store, ...scoped },
    });
    const { session } = await signIn(target);
    return { target, session };
  };

  it('reaches only its resources, and nothing that is the whole workspace’s', async () => {
    const workspaces = createSlotlockMemoryDashboardWorkspaces();
    const tenantRef = `github-org:${ACME_ORG.id}`;
    const person = `github:${GITHUB_USER.id}`;
    const audited: { action: string; reason?: string }[] = [];
    // The scope the store would run each transaction with, as each read saw it.
    const seen: unknown[] = [];
    const scoped = {
      keepsToScope: true,
      list: vi.fn(async (tenant: string) => {
        seen.push(slotlockDashboardRequestScope());
        return resources.store.list(tenant);
      }),
      audit: { record: async (_tenant: string, event: { action: string; reason?: string }) => void audited.push(event), list: async () => [] },
    };
    const { target, session } = await signInTo(workspaces, scoped);
    workspaces.setRole(tenantRef, person, 'admin');
    workspaces.limit(tenantRef, person, { locations: ['north'], groups: [] });

    const overview = await get(target, '/base/dashboard', session);
    expect(overview.status).toBe(200);
    const page = await overview.text();
    expect(seen.at(-1)).toEqual({ locations: ['north'], groups: [] });
    // No keys, plan or setup on its overview; no keys, webhooks or usage in its menu.
    expect(page).not.toContain('Active keys');
    const nav = /<nav class="nav"[^>]*>([\s\S]*?)<\/nav>/.exec(page)?.[1] ?? '';
    expect(nav).toContain('/base/dashboard/resources');
    expect(nav).not.toContain('/base/dashboard/keys');
    expect(nav).not.toContain('/base/dashboard/webhooks');
    for (const path of ['/keys', '/webhooks', '/contacts', '/hours', '/closures', '/locations', '/settings/audit', '/settings/privacy']) {
      const refused = await get(target, `/base/dashboard${path}`, session);
      expect(refused.status, path).toBe(403);
      expect(await refused.text(), path).toContain('limited to some locations and groups');
    }
    // Settings shows its account, never the workspace's endpoints or hours.
    const settings = await (await get(target, '/base/dashboard/settings', session)).text();
    expect(settings).not.toContain('/base/dashboard/settings/endpoints"');
    expect((await get(target, '/base/dashboard/settings/endpoints', session)).status).toBe(403);
    // An Admin's forms that reach the whole workspace are refused, and the refusal audited.
    const token = await csrf(target, session);
    for (const route of ['/keys', '/resources', '/hours', '/webhooks', '/members/invite']) {
      expect((await post(target, `/base/dashboard${route}`, { csrf: token, name: 'x' }, session)).status, route).toBe(403);
    }
    expect(keys.store.create).not.toHaveBeenCalled();
    expect(audited).toContainEqual(expect.objectContaining({ action: 'authz.denied', reason: 'limited to locations and groups' }));

    // Given all of it again: the next request reads it, and the scope is gone.
    workspaces.limit(tenantRef, person, null);
    expect((await get(target, '/base/dashboard/keys', session)).status).toBe(200);
    await get(target, '/base/dashboard', session);
    expect(seen.at(-1)).toBeNull();
    // An Owner is never limited.
    workspaces.setRole(tenantRef, person, 'owner');
    workspaces.limit(tenantRef, person, { locations: ['north'], groups: [] });
    expect((await get(target, '/base/dashboard/keys', session)).status).toBe(200);
  });

  it('is never answered about a form with a page that is the whole workspace’s', async () => {
    const workspaces = createSlotlockMemoryDashboardWorkspaces();
    const tenantRef = `github-org:${ACME_ORG.id}`;
    const person = `github:${GITHUB_USER.id}`;
    const contacts = {
      list: vi.fn(async () => [
        {
          ref: 'south-customer-1',
          name: 'Sam Southside',
          email: 'sam.southside@example.test',
          phone: '+15550123',
          whatsapp: null,
          consent: { email: true, sms: true },
          consentAt: {},
          locale: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]),
      forget: vi.fn(async () => ({ deleted: true, bookings: 0 })),
    };
    const endpoint: SlotlockWebhookEndpoint = {
      id: randomUUID(),
      url: 'https://hooks.example.test/south-secret-path',
      eventTypes: null,
      createdAt: new Date(now),
      attempts: 0,
      failingSince: null,
      lastStatus: null,
      lastError: null,
      disabledAt: null,
      disabledReason: null,
    };
    const webhooks = {
      list: vi.fn(async () => [endpoint]),
      create: vi.fn(async () => ({ ok: false as const, code: 'invalid_webhook_url' as const })),
      remove: vi.fn(async () => true),
      enable: vi.fn(async () => null),
    };
    const { target, session } = await signInTo(workspaces, { keepsToScope: true, contacts, webhooks });
    await keys.store.create({ tenantRef, name: 'ADA-SOUTH-INTEGRATION', scopes: ['read'], createdBy: 'github:1' });
    workspaces.setRole(tenantRef, person, 'admin');
    workspaces.limit(tenantRef, person, { locations: ['north'], groups: [] });
    const token = await csrf(target, session);
    // An unusable single-use value is answered before the role is checked: with the notice alone.
    for (const route of ['/contacts/forget', '/keys/revoke', '/webhooks/delete']) {
      const answered = await post(target, `/base/dashboard${route}`, { csrf: token, once: 'x', ref: 'south-customer-1', id: endpoint.id }, session);
      expect(answered.status, route).toBe(409);
      const text = await answered.text();
      expect(text, route).toContain('That form was already sent.');
      for (const secret of ['Sam Southside', 'sam.southside@example.test', '+15550123', 'ADA-SOUTH-INTEGRATION', 'south-secret-path']) {
        expect(text, `${route} ${secret}`).not.toContain(secret);
      }
    }
    expect(contacts.list).not.toHaveBeenCalled();
    expect(webhooks.list).not.toHaveBeenCalled();
    expect(contacts.forget).not.toHaveBeenCalled();
    expect(webhooks.remove).not.toHaveBeenCalled();
    // Given all of it again, the same answer shows the page.
    workspaces.limit(tenantRef, person, null);
    const whole = await post(target, '/base/dashboard/keys/revoke', { csrf: token, once: 'x', id: randomUUID() }, session);
    expect(whole.status).toBe(409);
    expect(await whole.text()).toContain('ADA-SOUTH-INTEGRATION');
  });

  it('reaches only its own account where the resources cannot keep to a scope', async () => {
    const workspaces = createSlotlockMemoryDashboardWorkspaces();
    const tenantRef = `github-org:${ACME_ORG.id}`;
    const person = `github:${GITHUB_USER.id}`;
    const { target, session } = await signInTo(workspaces, {});
    workspaces.setRole(tenantRef, person, 'member');
    workspaces.limit(tenantRef, person, { locations: [], groups: ['vans'] });
    expect((await get(target, '/base/dashboard', session)).status).toBe(403);
    expect((await get(target, '/base/dashboard/resources', session)).status).toBe(403);
    expect((await get(target, '/base/dashboard/settings/account', session)).status).toBe(200);
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
          origin: 'rest',
          keyId: created.apiKey.id,
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
          origin: null,
          keyId: null,
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
    // The activity is sentences: who did what to which resource (by the key's name, not its id), and when.
    expect(html).toMatch(/<strong>Booking agent<\/strong> cancelled a booking on <strong>vehicle-42<\/strong>[\s\S]*<time[^>]*>5 min ago/);
    expect(html).toMatch(/The hold on <strong>a resource<\/strong> expired[\s\S]*<time[^>]*>2 d ago/);
    expect(html).not.toContain(created.apiKey.id);
    expect(html).toContain('<span class="stat-label">Bookings, next 7 days</span>');
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
      origin: 'dashboard' as const,
      keyId: null,
      position: id,
    });
    const { target } = withFeed([], [change('github:4242', 'msg_2'), change('github:777', 'msg_1')]);
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard', session)).text();
    expect(html).toContain('<strong>You</strong> released the hold on <strong>a resource</strong>');
    expect(html).toContain('<strong>GitHub user 777</strong> released the hold on <strong>a resource</strong>');
  });

  it('says every change in words, never by its type, and counts repeats as one line', async () => {
    const change = (type: string, index: number, actor: string | null = 'github:4242') => ({
      id: `msg_${String(index)}`,
      type: type as SlotlockChange['type'],
      resourceId: '11111111-1111-4111-8111-111111111111',
      subject: 's',
      data: type === 'usage.threshold_reached' ? { metric: 'operations', percent: 80 } : {},
      occurredAt: new Date(now - index * 60_000),
      actor,
      origin: 'dashboard' as const,
      keyId: null,
      position: `p${String(index)}`,
    });
    resources.rows.push({
      id: '11111111-1111-4111-8111-111111111111',
      externalRef: 'room-1',
      tenantRef: 'github:4242',
      timezone: 'UTC',
    });
    const every = [...SLOTLOCK_CHANGE_TYPES, 'usage.period_closed'].map((type, index) => change(type, index + 3));
    const { target } = withFeed([], [change('resource.updated', 0), change('resource.updated', 1), change('resource.updated', 2), ...every]);
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard', session)).text();
    const feed = /<ol class="feed">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '';
    for (const type of [...SLOTLOCK_CHANGE_TYPES, 'usage.period_closed']) {
      expect(feed, type).not.toContain(type);
    }
    expect(feed).toContain('<strong>You</strong> edited <strong>room-1</strong> <span class="times">3 times</span>');
    expect(feed).toContain('<strong>You</strong> held <strong>room-1</strong>');
    expect(feed).toContain('<strong>You</strong> created an API key');
    expect(feed).toContain('The hold on <strong>room-1</strong> expired');
    expect(feed).toContain('80% of this month&#39;s operations used');
    // One line per run of repeats, then one per change.
    expect(feed.match(/<li class="event">/g)).toHaveLength(1 + every.length);
  });

  it('says a change it has no words for (a newer server\u2019s) without its type, whatever the type looks like', async () => {
    const foreign = ['RESOURCE-UPDATED', 'resource:updated', 'Resource/Updated', 'constructor', '__proto__', 'toString'];
    resources.rows.push({ id: '11111111-1111-4111-8111-111111111111', externalRef: 'room-1', tenantRef: 'github:4242', timezone: 'UTC' });
    const { target } = withFeed(
      [],
      foreign.map((type, index) => ({
        id: `msg_${String(index)}`,
        type: type as SlotlockChange['type'],
        resourceId: index === 0 ? '11111111-1111-4111-8111-111111111111' : null,
        subject: 's',
        data: {},
        occurredAt: new Date(now - index * 60_000),
        actor: null,
        origin: null,
        keyId: null,
        position: `p${String(index)}`,
      })),
    );
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard', session)).text();
    const feed = /<ol class="feed">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '';
    for (const type of foreign) expect(feed.toLowerCase(), type).not.toContain(type.toLowerCase().replace(/[._:/-]/g, ' ').trim());
    expect(feed).not.toMatch(/proto|tostring|constructor|updated/i);
    expect(feed).toContain('Something changed on <strong>room-1</strong>');
    expect(feed.match(/Something changed/g)).toHaveLength(foreign.length);
  });

  it('puts what needs a person first: approvals waiting, and the plan near its quota', async () => {
    resources.rows.push({ id: '11111111-1111-4111-8111-111111111111', externalRef: 'room-1', tenantRef: 'github:4242', timezone: 'UTC' });
    const approval = (status: 'pending' | 'granted') => ({ id: randomUUID(), status }) as never;
    const store = {
      ...resources.store,
      approvals: { list: vi.fn(async () => [approval('pending'), approval('pending'), approval('granted')]), decide: vi.fn() },
      usage: vi.fn(async () => [{ day: '2026-10-10', metric: 'operations' as const, keyId: '', origin: 'rest', count: 21_000 }]),
    };
    const plan = {
      tenantRef: 'github:4242',
      plan: 'free' as const,
      status: 'active' as const,
      limits: { resources: 10, apiKeys: 10, webhookEndpoints: 2 },
      stripeCustomer: null,
      stripeSubscription: null,
      currentPeriodEnd: null,
    } as unknown as SlotlockTenantPlan;
    const target = dashboard({
      resources: store,
      usage: true,
      quotas: true,
      plans: { plan: async () => plan, contact: 'mailto:sales@example.com' },
    });
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard', session)).text();
    const attention = /<ul class="attention-list"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    expect(attention).toContain('You have used 84% of this month&#39;s operations.');
    // From 80%, the owner is offered the upgrade, not only the page.
    expect(attention).toContain('href="/base/dashboard/plan#upgrade">Upgrade</a>');
    expect(attention).toContain('2 bookings wait for your approval.');
    expect(attention).toContain('href="/base/dashboard/approvals">Review</a>');
    expect(html).toContain('<span class="stat-label">Waiting for approval</span><span class="stat-value">2</span>');
    // The plan beside the activity, with the upgrade while a quota is pressing.
    expect(html).toMatch(/<section class="panel plan-card">[\s\S]*<h2>Free<\/h2>[\s\S]*Operations this month[\s\S]*href="\/base\/dashboard\/plan#upgrade">Upgrade<\/a>/);
    // Not in Test: the plan is Live's.
    const switched = await post(target, '/base/dashboard/environment', { csrf: await csrf(target, session), environment: 'test' }, session);
    const inTest = cookie(switched, '__Host-slotlock-session')?.pair as string;
    expect(await (await get(target, '/base/dashboard', inTest)).text()).not.toContain('plan-card');
  });

  it('walks a new tenant through its first steps, folds them to a line half way, and hides them once done', async () => {
    const empty = withFeed([], []);
    const { session } = await signIn(empty.target);
    const first = await (await get(empty.target, '/base/dashboard', session)).text();
    // Nothing yet: only the way in, with the one next step to take.
    expect(first).toContain('<h2>Get started</h2><span class="meta">0 of 3</span>');
    expect(first).toContain('<a class="button primary" href="/base/dashboard/resources">Add resource</a>');
    expect(first.match(/class="button primary"/g)).toHaveLength(1);
    expect(first).not.toContain('class="stats"');
    expect(first).not.toContain('Upcoming');
    resources.rows.push({ id: '11111111-1111-4111-8111-111111111111', externalRef: 'room-1', tenantRef: 'github:4242', timezone: 'UTC' });
    const key = await keys.store.create({ tenantRef: 'github:4242', name: 'Agent', scopes: ['read'] });
    const half = await (await get(empty.target, '/base/dashboard', session)).text();
    expect(half).toContain('<a class="setup-row" href="/base/dashboard#connect">');
    expect(half).toContain('Get started · 2 of 3 · <strong>Connect an agent</strong>');
    expect(half).toContain('<section class="panel" id="connect"><h2>Connect an agent</h2>');
    expect(half).toContain('claude mcp add --transport http slotlock https://slotlock.example.com/base/mcp');
    expect(half).toContain('No activity yet.');
    // An agent has used the key: every step is done.
    const listed = keys.store.list;
    keys.store.list = vi.fn(async (input: { tenantRef: string }) =>
      (await listed(input)).map((row) => (row.id === key.apiKey.id ? { ...row, lastUsedAt: new Date(now) } : row)),
    );
    try {
      const done = await (await get(empty.target, '/base/dashboard', session)).text();
      expect(done).not.toContain('Get started');
    } finally {
      keys.store.list = listed;
    }
  });

  it('leaves out the agenda and activity for resources without them', async () => {
    resources.rows.push({ id: '11111111-1111-4111-8111-111111111111', externalRef: 'room-1', tenantRef: 'github:4242', timezone: 'UTC' });
    const target = dashboard();
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard', session)).text();
    expect(html).not.toContain('Upcoming');
    expect(html).not.toContain('<h2>Activity</h2>');
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

describe('resource detail and webhooks', () => {
  const OWN = '22222222-2222-4222-8222-222222222222';
  const THEIRS = '33333333-3333-4333-8333-333333333333';

  function full() {
    resources.rows.push(
      { id: OWN, externalRef: 'van-1', tenantRef: 'github:4242', timezone: 'UTC' },
      { id: THEIRS, externalRef: 'van-x', tenantRef: 'github:1', timezone: 'UTC' },
    );
    const endpoints: SlotlockWebhookEndpoint[] = [];
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
    return { target: dashboard({ resources: store }), store, endpoints };
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

  it('offers no locations and groups without a store that keeps them', async () => {
    const { store } = full();
    const target = dashboard({ resources: store });
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    expect(await (await get(target, '/base/dashboard/resources', session)).text()).not.toContain('Locations and groups');
    expect(await (await get(target, `/base/dashboard/resources/${OWN}`, session)).text()).not.toContain('Location and groups');
    expect((await get(target, '/base/dashboard/locations', session)).status).toBe(404);
    for (const path of ['/locations', '/locations/delete', '/groups', '/groups/delete']) {
      expect((await post(target, `/base/dashboard${path}`, { csrf: token, ref: 'x', name: 'X' }, session)).status, path).toBe(404);
    }
    expect((await post(target, '/base/dashboard/resources/place', { csrf: token, id: OWN, location: 'x' }, session)).status).toBe(404);
    // Signed out, the page sends a person to sign in.
    expect((await get(target, '/base/dashboard/locations')).status).toBe(303);
  });

  it("edits a resource's profile, shows its name in place of the reference, and says what it could not keep", async () => {
    const { store } = full();
    const setProfile = vi.fn(async (tenantRef: string, id: string, profile: SlotlockResourceProfileInput) => {
      const row = resources.rows.find((r) => r.id === id && r.tenantRef === tenantRef) as SlotlockResource | undefined;
      if (!row) return null;
      const change = parseSlotlockResourceProfile(profile);
      if (change.name !== undefined) {
        if (change.name === null) delete row.name;
        else row.name = change.name;
      }
      if (change.kind !== undefined) {
        if (change.kind === 'other') delete row.kind;
        else row.kind = change.kind;
      }
      if (change.capacity !== undefined) {
        if (change.capacity === null) delete row.capacity;
        else row.capacity = change.capacity;
      }
      if (change.labels !== undefined) {
        if (change.labels.length === 0) delete row.labels;
        else row.labels = change.labels;
      }
      if (change.description !== undefined) {
        if (change.description === null) delete row.description;
        else row.description = change.description;
      }
      return row;
    });
    const target = dashboard({ resources: { ...store, setProfile } });
    const { session } = await signIn(target);
    const token = await csrf(target, session);
    const saved = await post(
      target,
      '/base/dashboard/resources/profile',
      {
        csrf: token,
        id: OWN,
        name: ' Van 1, white ',
        kind: 'vehicle',
        capacity: '3',
        labels: 'EV, lhr  tow-bar',
        description: 'Long wheelbase.',
      },
      session,
    );
    expect(saved.status).toBe(303);
    expect(setProfile).toHaveBeenLastCalledWith(
      'github:4242',
      OWN,
      {
        name: 'Van 1, white',
        description: 'Long wheelbase.',
        kind: 'vehicle',
        capacity: 3,
        labels: ['ev', 'lhr', 'tow-bar'],
      },
      'github:4242',
    );
    const page = await (await get(target, `/base/dashboard/resources/${OWN}`, session)).text();
    expect(page).toContain('Van 1, white');
    expect(page).toContain('<dt>Reference</dt><dd>van-1</dd><dt>Kind</dt><dd>Vehicle</dd><dt>Capacity</dt><dd>3</dd><dt>Labels</dt><dd>ev, lhr, tow-bar</dd>');
    expect(page).toContain('<option value="vehicle" selected>Vehicle</option>');
    expect(page).toContain('name="labels" value="ev, lhr, tow-bar"');
    // The list shows the name, with the reference beside it.
    const listed = await (await get(target, '/base/dashboard/resources', session)).text();
    expect(listed).toContain('>Van 1, white</a><span class="meta" title="Reference van-1">van-1</span>');
    // Out of bounds: said in a person's words, naming the field.
    const badCapacity = await post(target, '/base/dashboard/resources/profile', { csrf: token, id: OWN, capacity: '0' }, session);
    expect(badCapacity.status).toBe(400);
    expect(await badCapacity.text()).toContain('Capacity is a whole number from 1 to 100,000.');
    const badLabel = await post(target, '/base/dashboard/resources/profile', { csrf: token, id: OWN, labels: 'ok, no!' }, session);
    expect(badLabel.status).toBe(400);
    expect(await badLabel.text()).toContain('Up to 20 labels, each 1 to 64 letters');
    // Empty fields clear it all.
    await post(target, '/base/dashboard/resources/profile', { csrf: token, id: OWN, kind: 'other' }, session);
    expect(setProfile).toHaveBeenLastCalledWith(
      'github:4242',
      OWN,
      { name: null, description: null, kind: 'other', capacity: null, labels: [] },
      'github:4242',
    );
    expect(await (await get(target, '/base/dashboard/resources', session)).text()).toContain('>van-1</a>');
    // Another tenant's resource is not found.
    expect((await post(target, '/base/dashboard/resources/profile', { csrf: token, id: THEIRS, name: 'x' }, session)).status).toBe(404);
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
    // A filter set over the API is shown, in a few words.
    endpoint.filter = { resourceIds: ['0f8b6c1e-2d4a-4c7e-9b1a-3e5f7a9c2d4b'], locations: ['north', 'leeds'] };
    expect(await (await get(target, '/base/dashboard/webhooks', session)).text()).toContain(
      '<span class="meta">Only 1 resource; locations north, leeds</span>',
    );
    delete endpoint.filter;
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

  it('exports the workspace, and finds, downloads and erases one person, on Privacy', async () => {
    const ready = {
      id: '0b6c8d1e-4f2a-4c3b-9d5e-7f8a9b0c1d2e',
      status: 'ready' as const,
      requestedBy: 'github:4242',
      createdAt: new Date(),
      finishedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      parts: 2,
      rows: 3,
      bytes: 120,
      tables: { resources: 2, outbox: 1 },
      error: null,
    };
    const records = {
      contacts: [{ ref: 'cust-1', email: 'ada@example.com' }],
      calendar_event_attendees: [],
      calendar_events: [],
      reservations: [{ external_ref: 'bk-1' }, { external_ref: 'bk-2' }],
      reservation_tombstones: [],
      reservation_conflict_archive: [],
      calendar_event_tombstones: [],
      calendar_event_commands: [],
      waitlist_entries: [],
      approvals: [],
      outbox: [],
    };
    const privacy = {
      createExport: vi.fn(async () => ({ ...ready, status: 'pending' as const })),
      listExports: vi.fn(async () => [ready]),
      exportPart: vi.fn(async (_tenant: string, _id: string, part: number) =>
        part === 1
          ? { ok: true as const, table: 'resources' as const, lines: ['{"external_ref":"van-1"}', '{"external_ref":"van-2"}'] }
          : part === 2
            ? { ok: true as const, table: 'outbox' as const, lines: ['{"type":"resource.created"}'] }
            : { ok: false as const, code: 'export_part_not_found' as const },
      ),
      deleteExport: vi.fn(async () => true),
      exportSubject: vi.fn(async () => ({ records, truncated: false })),
      eraseSubject: vi.fn(async () => ({ erased: { ...Object.fromEntries(Object.keys(records).map((table) => [table, 0])), contacts: 1, reservations: 2 } as never })),
    };
    const audited: { action: string; metadata?: Record<string, unknown> }[] = [];
    const target = dashboard({
      resources: {
        ...resources.store,
        privacy,
        audit: { record: async (_tenant: string, event: { action: string }) => void audited.push(event), list: async () => [] },
      },
    });
    const { session } = await signIn(target);
    const page = await (await get(target, '/base/dashboard/settings/privacy', session)).text();
    expect(page).toContain('Export the workspace');
    // Each is a card: what it is and what it is for, then its rows, then its action.
    expect(page).toContain('<section class="set-card"><header class="panel-head"><h3>Workspace export</h3>');
    expect(page).toContain('<div class="card-foot"><button type="submit" class="primary">Export the workspace</button></div>');
    expect(page).toMatch(/<h3>A person’s data<\/h3>[\s\S]*<label class="row-label" for="person-value">Find by<\/label>/);
    expect(page).toContain(`/base/dashboard/settings/privacy/download?id=${ready.id}`);
    const token = await csrf(target, session);
    // Asked for, built elsewhere.
    expect(await (await post(target, '/base/dashboard/settings/privacy/export', { csrf: token }, session)).text()).toContain('Asked for.');
    expect(privacy.createExport).toHaveBeenCalledWith('github:4242', 'github:4242');
    // Downloaded as JSON lines, a part at a time.
    const file = await get(target, `/base/dashboard/settings/privacy/download?id=${ready.id}`, session);
    expect(file.headers.get('content-disposition')).toMatch(/^attachment; filename="slotlock-export-\d{4}-\d{2}-\d{2}\.ndjson"$/);
    expect((await file.text()).trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { table: 'resources', row: { external_ref: 'van-1' } },
      { table: 'resources', row: { external_ref: 'van-2' } },
      { table: 'outbox', row: { type: 'resource.created' } },
    ]);
    // One person: found, downloaded, and erased only once confirmed.
    const found = await (await post(target, '/base/dashboard/settings/privacy/person', { csrf: token, kind: 'email', value: 'ada@example.com' }, session)).text();
    expect(found).toContain('reservations');
    expect(privacy.exportSubject).toHaveBeenCalledWith('github:4242', { email: 'ada@example.com' });
    const json = await post(target, '/base/dashboard/settings/privacy/person/export', { csrf: token, kind: 'email', value: 'ada@example.com' }, session);
    expect(json.headers.get('content-disposition')).toContain('slotlock-person-');
    expect(JSON.parse(await json.text())).toMatchObject({ records: { contacts: [{ ref: 'cust-1' }] } });
    const unconfirmed = await post(target, '/base/dashboard/settings/privacy/person/erase', { csrf: token, kind: 'email', value: 'ada@example.com' }, session);
    expect(unconfirmed.status).toBe(400);
    expect(privacy.eraseSubject).not.toHaveBeenCalled();
    const erased = await post(target, '/base/dashboard/settings/privacy/person/erase', { csrf: token, kind: 'email', value: 'ada@example.com', confirm: 'yes' }, session);
    expect(await erased.text()).toContain('Erased: 3 rows deleted or changed.');
    expect(privacy.eraseSubject).toHaveBeenCalledWith('github:4242', { email: 'ada@example.com' }, 'github:4242');
    // The audit log has each, never the person.
    expect(audited.map((event) => event.action).filter((action) => action !== 'session.signed_in')).toEqual([
      'export.created',
      'export.downloaded',
      'subject.exported',
      'subject.erased',
    ]);
    expect(JSON.stringify(audited)).not.toContain('ada@example.com');
    // A stale sign-in is asked to sign in again, for the download too.
    now += 16 * 60_000;
    expect(await (await get(target, `/base/dashboard/settings/privacy/download?id=${ready.id}`, session)).text()).toContain('Confirm it’s you');
    expect((await post(target, '/base/dashboard/settings/privacy/person/erase', { csrf: token, kind: 'email', value: 'x@example.com', confirm: 'yes' }, session)).status).toBe(403);
    // Without the adapter there is no section.
    const plain = dashboard();
    expect((await get(plain, '/base/dashboard/settings/privacy', (await signIn(plain)).session)).status).toBe(404);
  });

  it('lists contacts with their consent, and forgets one', async () => {
    const people = [
      {
        ref: 'cust-1',
        name: 'Ada <A>',
        email: 'ada@example.com',
        phone: '+447700900123',
        whatsapp: null,
        consent: { email: true, sms: false },
        consentAt: { email: new Date('2026-11-01T09:00:00Z'), sms: new Date('2026-11-02T09:00:00Z') },
        locale: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const contacts = {
      list: vi.fn(async () => people),
      forget: vi.fn(async (_tenant: string, ref: string) => ({ deleted: ref === 'cust-1', bookings: ref === 'cust-1' ? 2 : 0 })),
    };
    const target = dashboard({ resources: { ...resources.store, contacts } });
    const { session } = await signIn(target);
    const page = await (await get(target, '/base/dashboard/contacts', session)).text();
    expect(page).toContain('Ada &lt;A&gt;');
    expect(page).toContain('SMS: no (2026-11-02)');
    expect(page).toContain('/base/dashboard/contacts/forget');
    const forgotten = await post(target, '/base/dashboard/contacts/forget', { csrf: await csrf(target, session), ref: 'cust-1' }, session);
    expect(await forgotten.text()).toContain('2 bookings no longer name them');
    expect(contacts.forget).toHaveBeenCalledWith('github:4242', 'cust-1', 'github:4242');
    expect((await post(target, '/base/dashboard/contacts/forget', { csrf: await csrf(target, session), ref: 'nobody' }, session)).status).toBe(404);
    expect((await post(target, '/base/dashboard/contacts/forget', { csrf: 'wrong', ref: 'cust-1' }, session)).status).toBe(403);
    // Without a contacts adapter there is no page.
    const plain = dashboard();
    expect((await get(plain, '/base/dashboard/contacts', (await signIn(plain)).session)).status).toBe(404);
  });

  it('has no Waitlist page: agents use waitlists through the API', async () => {
    const { target } = full();
    const { session } = await signIn(target);
    expect((await get(target, '/base/dashboard/waitlist', session)).status).toBe(404);
    const nav = await (await get(target, '/base/dashboard', session)).text();
    expect(nav).not.toContain('Waitlist');
    expect(nav).not.toContain('On the waitlist');
    const left = await post(target, '/base/dashboard/waitlist/leave', { csrf: await csrf(target, session), id: 'x' }, session);
    expect(left.status).toBe(404);
  });

  it('shows Webhooks only for an adapter that has them', async () => {
    const plain = dashboard();
    const first = await signIn(plain);
    const html = await (await get(plain, '/base/dashboard', first.session)).text();
    expect(html).not.toContain('/base/dashboard/webhooks');
    expect((await get(plain, '/base/dashboard/webhooks', first.session)).status).toBe(404);
    const { target } = full();
    const second = await signIn(target);
    const nav = await (await get(target, '/base/dashboard', second.session)).text();
    expect(nav).toContain('<span>Webhooks</span>');
  });
});

describe('the dashboard design', () => {
  /** A tenant with nothing yet, on an adapter that offers every page. */
  function emptyEverything() {
    return dashboard({
      resources: {
        ...resources.store,
        agenda: vi.fn(async () => []),
        recentChanges: vi.fn(async () => []),
        webhooks: {
          list: vi.fn(async () => []),
          create: vi.fn(async () => ({ ok: false as const, code: 'invalid_webhook_url' as const })),
          remove: vi.fn(async () => false),
          enable: vi.fn(async () => null),
        },
      },
    });
  }

  it('renders every page for a brand-new tenant, with landmarks and nothing inline or external', async () => {
    const target = emptyEverything();
    const { session } = await signIn(target);
    const pages = ['', '/resources', '/keys', '/webhooks', '/settings', '/hours'];
    for (const path of pages) {
      const response = await get(target, `/base/dashboard${path}`, session);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-security-policy'), path).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      const html = await response.text();
      expect(html, path).toContain('<a class="skip" href="#main">Skip to content</a>');
      expect(html, path).toContain('<main class="page" id="main">');
      expect(html, path).toContain('<nav class="nav" aria-label="Dashboard">');
      expect(html, path).toContain('<p class="visually-hidden" id="live" aria-live="polite"></p>');
      expect(html, path).toMatch(/<h1>[^<]+<\/h1>/);
      expect(html, path).not.toMatch(/<script(?![^>]*\bsrc=)/);
      expect(html, path).not.toMatch(/\sstyle=|\son[a-z]+=/i);
      // Everything the page loads is the dashboard's own: no font, image or script from elsewhere.
      for (const [, url] of html.matchAll(/\s(?:src|href)="([^"#]*)"/g)) {
        expect(url, `${path}: ${url}`).toMatch(/^\/base\/dashboard(?:[/?]|$)/);
      }
    }
    for (const [path, text] of [
      ['/resources', 'No resources yet.'],
      ['/keys', 'No keys yet.'],
      ['/webhooks', 'No webhooks.'],
    ] as const) {
      const html = await (await get(target, `/base/dashboard${path}`, session)).text();
      expect(html, path).toMatch(new RegExp(`<div class="empty-state"><span class="empty-icon"><svg[^]*?</svg></span><p class="empty">${text}`));
    }
    // The empty states point at the one thing to do next: the form on the same page.
    const keysPage = await (await get(target, '/base/dashboard/keys', session)).text();
    expect(keysPage).toContain('<a class="button" href="#key-name">');
    expect(keysPage).toContain('id="key-name" name="name"');
  });

  it('serves a stylesheet with light and dark themes, reduced motion, and no outside requests', async () => {
    const target = dashboard();
    const html = await (await get(target, '/base/dashboard')).text();
    const cssPath = /href="(\/base\/dashboard\/style\.css\?v=[^"]+)"/.exec(html)?.[1] as string;
    const jsPath = /src="(\/base\/dashboard\/app\.js\?v=[^"]+)"/.exec(html)?.[1] as string;
    const css = await (await get(target, cssPath)).text();
    const js = await (await get(target, jsPath)).text();
    expect(css).toMatch(/:root \{[^}]*--canvas:/);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root \{[^}]*--canvas:/);
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(':focus-visible');
    // No web fonts, images or imports: the policy would refuse them, and the dashboard asks for none.
    expect(css).not.toMatch(/url\(|@import|@font-face|https?:/i);
    expect(js).not.toMatch(/XMLHttpRequest|eval\(|new Function|sendBeacon|WebSocket|EventSource|import\(/);
    // One request: the assistant's reply, from the page's own stream (connect-src 'self' holds it
    // to this origin). The only absolute URLs are the http(s) links a reply may hold.
    expect(js.match(/fetch\(/g)).toHaveLength(1);
    expect(js).toContain("fetch(page.getAttribute('data-stream'), {");
    expect(js.replaceAll('https?:\\/\\/', '')).not.toMatch(/https?:/);
    // Markup it writes is the server's: its own Markdown renderer's, the turn the server rendered, or
    // the Chats list the server rendered.
    // Steps are found by the provider's call id: a map with no prototype, so `__proto__` names none.
    expect(js).toContain('var stepNodes = Object.create(null);');
    expect(js).not.toMatch(/stepNodes = \{\}/);
    const writes = js.split('\n').filter((line) => /innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(line));
    expect(writes.map((line) => line.trim())).toEqual([
      'if (prose) prose.innerHTML = renderMarkdown(proseText);',
      "thread.insertAdjacentHTML('beforeend', e.html || '');",
      'panel.outerHTML = e.chats;',
    ]);
  });

  it('opens a row’s confirmation in place, never floating where the table would clip it', async () => {
    // .table scrolls sideways (overflow-x: auto), which clips both ways: a floating .pop below the
    // last row was cut off, so Revoke on a one-key account opened a button nobody could press.
    const target = dashboard();
    const html = await (await get(target, '/base/dashboard')).text();
    const cssPath = /href="(\/base\/dashboard\/style\.css\?v=[^"]+)"/.exec(html)?.[1] as string;
    const css = await (await get(target, cssPath)).text();
    expect(css).toMatch(/\.table \{[^}]*overflow-x: auto/);
    expect(css).toMatch(/\.table \.pop \{[^}]*position: static/);
    expect(css).not.toMatch(/\.table \.pop \{[^}]*position: (absolute|fixed)/);
  });

  it('lets each page use a wide screen, centred past its cap, instead of stopping at 1200px', async () => {
    const target = dashboard();
    const html = await (await get(target, '/base/dashboard')).text();
    const cssPath = /href="(\/base\/dashboard\/style\.css\?v=[^"]+)"/.exec(html)?.[1] as string;
    const css = await (await get(target, cssPath)).text();
    const page = /\.page \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(Number(/max-width: (\d+)px/.exec(page)?.[1])).toBeGreaterThanOrEqual(1600);
    expect(page).toContain('margin-inline: auto');
  });

  it('keeps long names on one line with the whole value at hand, and dates with their full time', async () => {
    const name = 'Read-only reporting agent for the finance team quarterly reconciliation job';
    await keys.store.create({ tenantRef: 'github:4242', name, scopes: ['read'] });
    const reference = 'phase-b-exit-20261108T142642Z-3444';
    resources.rows.push({
      id: '22222222-2222-4222-8222-222222222222',
      externalRef: reference,
      tenantRef: 'github:4242',
      timezone: 'America/New_York',
    });
    const target = dashboard();
    const { session } = await signIn(target);
    const keysPage = await (await get(target, '/base/dashboard/keys', session)).text();
    expect(keysPage).toContain(`<span class="truncate" title="${name}">${name}</span>`);
    expect(keysPage).toMatch(
      /<time datetime="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z" title="\d{4}-\d\d-\d\d \d\d:\d\d UTC">\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}<\/time>/,
    );
    const resourcesPage = await (await get(target, '/base/dashboard/resources', session)).text();
    expect(resourcesPage).toContain(`title="${reference}">${reference}</a>`);
    expect(resourcesPage).toContain(
      '<code class="muted truncate id" title="22222222-2222-4222-8222-222222222222">',
    );
  });

  it('escapes what it puts in tooltips, as everywhere else', async () => {
    await keys.store.create({ tenantRef: 'github:4242', name: '"><img src=x onerror=alert(1)>', scopes: ['read'] });
    const target = dashboard();
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard/keys', session)).text();
    expect(html).toContain('title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
    expect(html).not.toContain('<img src=x');
  });
});

describe('the plan page', () => {
  function billed(plan: SlotlockTenantPlan | null = null) {
    const calls: Array<{ kind: string; input: unknown }> = [];
    const billing = {
      plan: vi.fn(async (_tenantRef: string) => plan),
      enrol: vi.fn(async (_tenantRef: string) => undefined),
      checkout: vi.fn(async (input: unknown) => {
        calls.push({ kind: 'checkout', input });
        return 'https://checkout.stripe.com/c/pay/cs_test_1';
      }),
      portal: vi.fn(async (input: unknown) => {
        calls.push({ kind: 'portal', input });
        return 'https://billing.stripe.com/p/session/test_1';
      }),
      prices: { month: '$10', year: '$100' },
      contact: 'mailto:founder@example.com',
      formOrigins: ['https://checkout.stripe.com', 'https://billing.stripe.com'],
    };
    return { billing, calls, target: dashboard({ billing }) };
  }
  const developer: SlotlockTenantPlan = {
    plan: 'developer',
    status: 'active',
    limits: { resources: 100, apiKeys: 100, webhookEndpoints: 10 },
    stripeCustomer: 'cus_Test1',
    stripeSubscription: 'sub_Test1',
    currentPeriodEnd: new Date('2026-12-10T12:00:00Z'),
  };

  it('is not there without billing', async () => {
    const { session } = await signIn();
    const html = await (await get(dashboard(), '/base/dashboard', session)).text();
    expect(html).not.toContain('/base/dashboard/plan');
    expect((await get(dashboard(), '/base/dashboard/plan', session)).status).toBe(404);
  });

  it('limits a key to locations or groups on Developer, never on Free, and never with full access', async () => {
    const free: SlotlockTenantPlan = { ...developer, plan: 'free', stripeCustomer: null, stripeSubscription: null, currentPeriodEnd: null };
    const limited = { name: 'North desk', access: 'read_write', expires: '90', limit_location: 'north', limit_group: 'team' };
    const onFree = billed(free);
    const { session } = await signIn(onFree.target);
    const refused = await post(onFree.target, '/base/dashboard/keys', { csrf: await csrf(onFree.target, session), ...limited }, session);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('Keys limited to locations or groups come with the Developer and Team plans.');
    expect(keys.store.create).not.toHaveBeenCalled();
    const onDeveloper = billed(developer);
    const signed = await signIn(onDeveloper.target);
    const token = await csrf(onDeveloper.target, signed.session);
    const full = await post(onDeveloper.target, '/base/dashboard/keys', { csrf: token, ...limited, access: 'full' }, signed.session);
    expect(full.status).toBe(400);
    expect((await post(onDeveloper.target, '/base/dashboard/keys', { csrf: token, ...limited }, signed.session)).status).toBe(200);
    expect(keys.store.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ scopes: ['read', 'write'], resourceScope: { locations: ['north'], groups: ['team'] } }),
    );
    expect(await (await get(onDeveloper.target, '/base/dashboard/keys', signed.session)).text()).toContain(
      '<span class="meta wrap">Only north, group team</span>',
    );
  });

  it('shows a Free tenant its use against the limits, an upgrade and the founder', async () => {
    const free: SlotlockTenantPlan = {
      plan: 'free',
      status: 'active',
      limits: { resources: 10, apiKeys: 10, webhookEndpoints: 2 },
      stripeCustomer: null,
      stripeSubscription: null,
      currentPeriodEnd: null,
    };
    const { target } = billed(free);
    const { session } = await signIn(target);
    const response = await get(target, '/base/dashboard/plan', session);
    expect(response.status).toBe(200);
    // Upgrade and Manage redirect to Stripe, so the policy lets forms go there and nowhere else.
    expect(response.headers.get('content-security-policy')).toContain(
      "form-action 'self' https://checkout.stripe.com https://billing.stripe.com;",
    );
    const html = await response.text();
    expect(html).toContain('href="/base/dashboard/plan"');
    expect(html).toContain('<h1>Usage</h1>');
    expect(html).toContain('<span class="plan-now">Free</span>');
    // Free is marked as the plan in use, Developer offered beside it.
    expect(html).toMatch(/<article class="plan-col current" id="free"[\s\S]*Current plan/);
    expect(html).toContain('<article class="plan-col featured" id="developer"');
    expect(html).toContain('<span class="meta"> of 10</span>');
    expect(html).toContain('action="/base/dashboard/plan/upgrade"');
    expect(html).toContain('Monthly, $10 a month');
    expect(html).toContain('Yearly, $100 a year');
    expect(html).not.toContain('Manage billing');
    expect(html).toContain('href="mailto:founder@example.com">Talk to the founder');
  });

  it('switches to the test environment: its own tenant, never billed, and back to Live', async () => {
    const { target, calls } = billed(null);
    const { session } = await signIn(target);
    expect(await (await get(target, '/base/dashboard', session)).text()).toContain('name="environment" value="live" aria-pressed="true"');
    const refused = await post(target, '/base/dashboard/environment', { csrf: await csrf(target, session), environment: 'staging' }, session);
    expect(refused.status).toBe(400);
    const switched = await post(target, '/base/dashboard/environment', { csrf: await csrf(target, session), environment: 'test' }, session);
    expect(switched.status).toBe(303);
    const test = cookie(switched, '__Host-slotlock-session')?.pair as string;
    const page = await (await get(target, '/base/dashboard', test)).text();
    expect(page).toContain('name="environment" value="test" aria-pressed="true"');
    expect(page).toContain('class="test-banner"');
    await post(
      target,
      '/base/dashboard/keys',
      { csrf: await csrf(target, test), name: 'Test agent', access: 'read', expires: '30' },
      test,
    );
    expect(keys.store.create).toHaveBeenLastCalledWith(expect.objectContaining({ tenantRef: 'github:4242~test' }));
    // Plans and billing are Live's: the Test plan page says so, and changes nothing.
    const plan = await (await get(target, '/base/dashboard/plan', test)).text();
    expect(plan).toContain('never billed');
    expect(plan).not.toContain('This month, in Test'); // this dashboard does not meter
    // With metering, the test environment's own use, read from its own tenant.
    const usage = vi.fn(async () => [{ day: '2026-10-10', metric: 'operations' as const, keyId: '', origin: 'rest', count: 7 }]);
    const metered = dashboard({ usage: true, resources: { ...resources.store, usage }, billing: { plan: async () => null, checkout: vi.fn(), portal: vi.fn(), prices: { month: '$10', year: '$100' }, contact: 'mailto:founder@example.com', formOrigins: ['https://checkout.stripe.com'] } as never });
    const testPage = await (await get(metered, '/base/dashboard/plan', test)).text();
    expect(testPage).toContain('<h2>This month, in Test</h2>');
    expect(usage).toHaveBeenCalledWith('github:4242~test', expect.any(String), expect.any(String));
    expect(plan).not.toContain('action="/base/dashboard/plan/upgrade"');
    for (const path of ['/base/dashboard/plan/upgrade', '/base/dashboard/plan/manage']) {
      expect((await post(target, path, { csrf: await csrf(target, test), interval: 'month' }, test)).status).toBe(400);
    }
    expect(calls).toEqual([]);
    const back = await post(target, '/base/dashboard/environment', { csrf: await csrf(target, test), environment: 'live' }, test);
    const live = cookie(back, '__Host-slotlock-session')?.pair as string;
    expect(await (await get(target, '/base/dashboard', live)).text()).not.toContain('class="test-banner"');
  });

  it('sends Upgrade to a checkout page tagged with the tenant, and back to the plan page', async () => {
    const { target, calls } = billed(null);
    const { session } = await signIn(target);
    const response = await post(target, '/base/dashboard/plan/upgrade', { csrf: await csrf(target, session), interval: 'year' }, session);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(calls).toEqual([
      {
        kind: 'checkout',
        input: {
          tenantRef: `github:${GITHUB_USER.id}`,
          interval: 'year',
          customer: null,
          successUrl: `${DASHBOARD}/plan?checkout=done`,
          cancelUrl: `${DASHBOARD}/plan`,
        },
      },
    ]);
    const back = await (await get(target, '/base/dashboard/plan?checkout=done', session)).text();
    expect(back).toContain('once Stripe confirms the payment');
  });

  it("lands on Usage after signing in from the site's Upgrade, where every plan is offered", async () => {
    const { target } = billed(null);
    const start = await get(target, '/base/dashboard/sign-in?then=%2Fplan');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const callback = await get(target, `/base/dashboard/callback?code=fake-code&state=${state}`, cookie(start, '__Host-slotlock-oauth')?.pair);
    expect(callback.headers.get('location')).toBe('/base/dashboard/plan');
  });

  it("shows the prices Stripe charges over the labels it is configured with, and the labels when Stripe does not answer", async () => {
    const free: SlotlockTenantPlan = { ...developer, plan: 'free', stripeCustomer: null, stripeSubscription: null, currentPeriodEnd: null };
    const { billing } = billed(free);
    const errors: unknown[] = [];
    let answer: 'stripe' | 'refused' = 'stripe';
    const shown = {
      ...billing,
      shownPrices: vi.fn(async () => {
        if (answer === 'refused') throw new Error('The provided key does not have the required permissions');
        return { prices: { month: '£5', year: '£50' } };
      }),
    };
    const target = dashboard({ billing: shown, onError: (error) => void errors.push(error) });
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard/plan', session)).text();
    expect(html).toContain('Monthly, £5 a month');
    expect(html).not.toContain('$10');
    // Refused (a key without Read on Prices): the labels, and the error reported once in ten minutes.
    answer = 'refused';
    for (let i = 0; i < 3; i += 1) {
      expect(await (await get(target, '/base/dashboard/plan', session)).text()).toContain('Monthly, $10 a month');
    }
    expect(errors).toHaveLength(1);
  });

  it('shows a Developer tenant its renewal and Manage billing, which opens the portal', async () => {
    const { target, calls } = billed(developer);
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard/plan', session)).text();
    expect(html).toContain('<span class="plan-now">Developer</span><span class="pill active">Active</span>');
    expect(html).toContain('<span class="summary-label">Renews</span><span class="summary-value">10 Dec 2026</span><span class="summary-note">2026-12-10 12:00 UTC</span>');
    expect(html).toContain('<article class="plan-col current featured" id="developer"');
    expect(html).not.toContain('Upgrade to Developer');
    const manage = await post(target, '/base/dashboard/plan/manage', { csrf: await csrf(target, session) }, session);
    expect(manage.headers.get('location')).toBe('https://billing.stripe.com/p/session/test_1');
    expect(calls).toEqual([
      { kind: 'portal', input: { customer: 'cus_Test1', returnUrl: `${DASHBOARD}/plan`, plan: 'developer' } },
    ]);
    const again = await post(target, '/base/dashboard/plan/upgrade', { csrf: await csrf(target, session) }, session);
    expect(again.status).toBe(409);
  });

  it('says when a plan cancelled at the end of its period ends, not that it renews', async () => {
    const { billing } = billed(developer);
    const errors: unknown[] = [];
    let ends: Date | null | 'refused' = new Date('2026-12-13T23:44:00Z');
    const ending = vi.fn(async () => {
      if (ends === 'refused') throw new Error('Stripe did not answer');
      return ends;
    });
    const target = dashboard({ billing: { ...billing, ending }, onError: (error) => void errors.push(error) });
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard/plan', session)).text();
    expect(ending).toHaveBeenCalledWith(developer.stripeSubscription);
    expect(html).toContain('<span class="plan-now">Developer</span><span class="pill held">Ending</span>');
    expect(html).toContain('<span class="summary-label">Ends</span><span class="summary-value">13 Dec 2026</span><span class="summary-note">2026-12-13 23:44 UTC</span>');
    expect(html).not.toContain('Renews');
    // Renewing again, or Stripe not answering: as before, and the error reported.
    ends = null;
    expect(await (await get(target, '/base/dashboard/plan', session)).text()).toContain('<span class="summary-label">Renews</span>');
    ends = 'refused';
    const fallback = await (await get(target, '/base/dashboard/plan', session)).text();
    expect(fallback).toContain('<span class="pill active">Active</span>');
    expect(fallback).toContain('<span class="summary-label">Renews</span>');
    expect(errors).toHaveLength(1);
  });

  it('warns a tenant whose payment failed, and says so when Stripe does not answer', async () => {
    const { target, billing } = billed({ ...developer, status: 'past_due' });
    const { session } = await signIn(target);
    expect(await (await get(target, '/base/dashboard/plan', session)).text()).toContain(
      'Your last payment failed',
    );
    billing.portal.mockRejectedValueOnce(new Error('down'));
    const failed = await post(target, '/base/dashboard/plan/manage', { csrf: await csrf(target, session) }, session);
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain('Billing did not open');
  });

  it('puts a new tenant on the default plan before it adds what plans limit', async () => {
    const { target, billing } = billed(null);
    const { session } = await signIn(target);
    expect(billing.enrol).not.toHaveBeenCalled();
    await post(target, '/base/dashboard/keys', { csrf: await csrf(target, session), name: 'agent', access: 'read', expires: 'never' }, session);
    expect(billing.enrol).toHaveBeenCalledWith(`github:${GITHUB_USER.id}`);
    // Reading the Plan page writes nothing.
    billing.enrol.mockClear();
    await get(target, '/base/dashboard/plan', session);
    expect(billing.enrol).not.toHaveBeenCalled();
  });

  const free: SlotlockTenantPlan = {
    plan: 'free',
    status: 'active',
    limits: { resources: 10, apiKeys: 10, webhookEndpoints: 2 },
    stripeCustomer: null,
    stripeSubscription: null,
    currentPeriodEnd: null,
  };

  it('counts resources as the plan does, archived ones included, on the Plan and Resources pages', async () => {
    const counted = { ...resources.store, count: vi.fn(async (_tenantRef: string) => 7) };
    const { billing } = billed(free);
    const target = dashboard({ billing, resources: counted });
    const { session } = await signIn(target);
    for (const reference of ['van-1', 'van-2', 'van-3']) {
      await post(target, '/base/dashboard/resources', { csrf: await csrf(target, session), reference, timezone: 'UTC' }, session);
    }
    const plan = await (await get(target, '/base/dashboard/plan', session)).text();
    expect(plan).toContain('7<span class="meta"> of 10</span>');
    const listed = await (await get(target, '/base/dashboard/resources', session)).text();
    expect(listed).toContain('7 of 10 on your plan, 4 of them archived (archived resources count until deleted).');
    expect(listed).not.toContain('of 100');
  });

  it('shows this month’s usage, by key, when the deployment meters it', async () => {
    const tenantRef = `github:${GITHUB_USER.id}`;
    const { apiKey } = await keys.store.create({ tenantRef, name: 'Booking agent', scopes: ['read'] });
    const gone = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const read = vi.fn(async (_tenantRef: string, _from: string, _to: string) => [
      { day: '2026-10-10', metric: 'operations' as const, keyId: apiKey.id, origin: 'mcp', count: 40 },
      { day: '2026-10-10', metric: 'bookings' as const, keyId: apiKey.id, origin: 'mcp', count: 3 },
      { day: '2026-10-09', metric: 'operations' as const, keyId: '', origin: 'dashboard-assistant', count: 5 },
      { day: '2026-10-08', metric: 'holds' as const, keyId: gone, origin: 'rest', count: 2 },
    ]);
    const { billing } = billed(free);
    const metered = dashboard({ billing, usage: true, resources: { ...resources.store, usage: read } });
    const { session } = await signIn(metered);
    const html = await (await get(metered, '/base/dashboard/plan', session)).text();
    // The month so far, by the server's UTC clock.
    expect(read).toHaveBeenCalledWith(tenantRef, '2026-10-01', '2026-10-10');
    expect(html).toContain('<h2>Used by</h2>');
    expect(html).toContain('<span>Operations</span><span class="meter-value">45</span>');
    expect(html).toContain('<span>Bookings</span><span class="meter-value">3</span>');
    expect(html).toContain('<span>Holds</span><span class="meter-value">2</span>');
    expect(html).toContain('Since 2026-10-01, UTC');
    expect(html).toContain('<td data-label="Key">Booking agent</td><td data-label="Operations">40</td>');
    expect(html).toContain('<td data-label="Key">The dashboard and its assistant</td>');
    expect(html).toContain('<td data-label="Key">A deleted key</td>');
    // Not metered: no usage, and the adapter is not asked.
    read.mockClear();
    const unmetered = dashboard({ billing, resources: { ...resources.store, usage: read } });
    const again = await signIn(unmetered);
    expect(await (await get(unmetered, '/base/dashboard/plan', again.session)).text()).not.toContain('<h2>This month</h2>');
    expect(read).not.toHaveBeenCalled();
  });

  it('shows the month’s quotas with SLOTLOCK_QUOTAS=on, and warns from 80% to the stop', async () => {
    let operations = 20_400;
    let bookings = 10;
    const read = vi.fn(async (_tenantRef: string, _from: string, _to: string) => [
      { day: '2026-10-10', metric: 'operations' as const, keyId: '', origin: 'rest', count: operations },
      { day: '2026-10-10', metric: 'bookings' as const, keyId: '', origin: 'rest', count: bookings },
    ]);
    const { billing } = billed(free);
    const target = dashboard({ billing, usage: true, quotas: true, resources: { ...resources.store, usage: read } });
    const { session } = await signIn(target);
    const page = async () => (await get(target, '/base/dashboard/plan', session)).text();
    let html = await page();
    expect(html).toContain(
      '<span>Operations</span><span class="meter-value">20,400<span class="meta"> of 25,000</span>',
    );
    expect(html).toContain('<span class="meter-value">10<span class="meta"> of 1,000</span>');
    expect(html).toContain("You have used 81% of this month&#39;s operations. They start again on 2026-11-01 00:00 UTC.");
    expect(html).toContain('<li>500,000 operations a month</li><li>25,000 bookings a month</li>');
    operations = 25_000;
    bookings = 1_000;
    html = await page();
    expect(html).toContain("This month&#39;s operations are used up: Slotlock refuses every call but reading usage with quota_exceeded until 2026-11-01 00:00 UTC. Upgrade for more.");
    expect(html).toContain("This month&#39;s bookings are used up: Slotlock refuses new bookings and holds with quota_exceeded until 2026-11-01 00:00 UTC.");
    // Developer: past the quota, refused only a tenth further on.
    const developer = billed({ ...free, plan: 'developer', limits: { resources: 100, apiKeys: 100, webhookEndpoints: 10 } });
    const paid = dashboard({ billing: developer.billing, usage: true, quotas: true, resources: { ...resources.store, usage: read } });
    const signed = await signIn(paid);
    operations = 510_000;
    bookings = 0;
    html = await (await get(paid, '/base/dashboard/plan', signed.session)).text();
    expect(html).toContain("You have used this month&#39;s 500,000 operations. Slotlock refuses every call but reading usage past 550,000, until 2026-11-01 00:00 UTC.");
    // Without the setting, no quota is named.
    const plain = dashboard({ billing, usage: true, resources: { ...resources.store, usage: read } });
    const third = await signIn(plain);
    expect(await (await get(plain, '/base/dashboard/plan', third.session)).text()).not.toContain(' of 25,000');
  });

  it("names the plan's limit when an add is refused at it", async () => {
    const capped = {
      ...resources.store,
      add: vi.fn(async () => {
        throw Object.assign(new Error('cap'), { code: 'resource_limit_reached', limit: 10 });
      }),
    };
    const target = dashboard({ billing: billed(free).billing, resources: capped });
    const { session } = await signIn(target);
    const refused = await post(target, '/base/dashboard/resources', { csrf: await csrf(target, session), reference: 'van-11', timezone: 'UTC' }, session);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('You have 10 resources, archived ones included, as many as your plan allows.');
  });

  it('sends a customer who already pays to Manage billing instead of a second Checkout', async () => {
    const { target, billing } = billed({ ...free, plan: 'free', stripeCustomer: 'cus_Twice1' });
    billing.checkout.mockRejectedValueOnce(
      Object.assign(new Error('The customer has a live subscription already'), { code: 'subscription_exists' }),
    );
    const { session } = await signIn(target);
    const refused = await post(target, '/base/dashboard/plan/upgrade', { csrf: await csrf(target, session), interval: 'month' }, session);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('You pay for a subscription already.');
  });

  it('refuses billing that would loosen the policy', () => {
    const { billing } = billed();
    expect(() => dashboard({ billing: { ...billing, formOrigins: ['http://checkout.stripe.com'] } })).toThrow();
    expect(() => dashboard({ billing: { ...billing, formOrigins: ["https://a.com 'unsafe-inline'"] } })).toThrow();
    expect(() => dashboard({ billing: { ...billing, contact: 'javascript:alert(1)' } })).toThrow();
  });
});

describe('Google sign-in', () => {
  const GOOGLE = { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-' + 'g'.repeat(20) + '0123456789' };
  const SUBJECT = '109876543210987654321';
  // Google's signing key, and one that is not Google's.
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const JWKS = { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'google-key-1', alg: 'RS256', use: 'sig' }] };
  /** Google's token endpoint, answering with an ID token whose claims (and signer) a test chooses. */
  function fakeGoogle(claims: (nonce: string) => Record<string, unknown>, signer = signing.privateKey, kid = 'google-key-1') {
    let asked: URLSearchParams | null = null;
    let nonce = '';
    const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json(JWKS);
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        asked = new URLSearchParams(String(init.body));
        const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const signed = `${part({ alg: 'RS256', kid, typ: 'JWT' })}.${part(claims(nonce))}`;
        const signature = createSign('RSA-SHA256').update(signed).sign(signer).toString('base64url');
        return Response.json({ id_token: `${signed}.${signature}`, access_token: 'ya29.fake' });
      }
      return github.fetch(input, init);
    });
    return { fetch, asked: () => asked, setNonce: (value: string) => (nonce = value) };
  }
  const valid = (nonce: string) => ({
    iss: 'https://accounts.google.com',
    aud: GOOGLE.clientId,
    sub: SUBJECT,
    email: 'desk@clinic.example',
    email_verified: true,
    nonce,
    exp: Math.floor(now / 1000) + 3600,
  });
  async function signInWithGoogle(target: ReturnType<typeof dashboard>, fake: ReturnType<typeof fakeGoogle>) {
    const start = await get(target, '/base/dashboard/sign-in?with=google');
    const location = new URL(start.headers.get('location') ?? '');
    fake.setNonce(location.searchParams.get('nonce') ?? '');
    const callback = await get(
      target,
      `/base/dashboard/callback?code=g-code&state=${location.searchParams.get('state')}`,
      cookie(start, '__Host-slotlock-oauth')?.pair,
    );
    return { start, location, callback, session: cookie(callback, '__Host-slotlock-session')?.pair as string };
  }

  it("signs a person in with Google to a tenant of their own, and keeps only the account's id and email", async () => {
    const fake = fakeGoogle(valid);
    const target = dashboard({ google: GOOGLE, allowedUsers: '*', fetch: fake.fetch });
    expect(await (await get(target, '/base/dashboard')).text()).toContain('Continue with Google');
    const { location, callback, session } = await signInWithGoogle(target, fake);
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(location.searchParams.get('scope')).toBe('openid email');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/dashboard/callback`);
    expect(callback.status).toBe(303);
    // The code was exchanged with the verifier PKCE needs.
    expect(fake.asked()?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await (await get(target, '/base/dashboard', session)).text()).toContain('desk@clinic.example');
    await post(target, '/base/dashboard/keys', { csrf: await csrf(target, session), name: 'Desk', access: 'read', expires: '30' }, session);
    expect(keys.store.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantRef: `google:${SUBJECT}`, createdBy: `google:${SUBJECT}` }),
    );
  });

  it('refuses an ID token that is not for this sign-in', async () => {
    for (const change of [
      { aud: 'someone-else.apps.googleusercontent.com' },
      { iss: 'https://evil.example' },
      // Expired past the 60 seconds' skew clocks are allowed (oidc.ts).
      { exp: Math.floor(now / 1000) - 61 },
      { iat: Math.floor(now / 1000) - 3600 },
      { nonce: 'replayed' },
      { sub: 'has spaces' },
    ]) {
      const fake = fakeGoogle((nonce) => ({ ...valid(nonce), ...change }));
      const target = dashboard({ google: GOOGLE, allowedUsers: '*', fetch: fake.fetch });
      const { callback, session } = await signInWithGoogle(target, fake);
      expect(callback.status, JSON.stringify(change)).toBe(502);
      expect(session).toBeUndefined();
    }
    // Signed by someone else, or by a key Google does not publish: refused, whatever it claims.
    for (const fake of [fakeGoogle(valid, forger.privateKey), fakeGoogle(valid, signing.privateKey, 'unknown-key')]) {
      const target = dashboard({ google: GOOGLE, allowedUsers: '*', fetch: fake.fetch });
      const { callback, session } = await signInWithGoogle(target, fake);
      expect(callback.status).toBe(502);
      expect(session).toBeUndefined();
    }
  });

  it('lets in only the Google accounts a list names, and is not offered with GitHub organizations', async () => {
    const fake = fakeGoogle(valid);
    const listed = dashboard({ google: GOOGLE, allowedUsers: [String(GITHUB_USER.id), `google:${SUBJECT}`], fetch: fake.fetch });
    expect((await signInWithGoogle(listed, fake)).callback.status).toBe(303);
    const other = dashboard({ google: GOOGLE, allowedUsers: [String(GITHUB_USER.id), 'google:42'], fetch: fake.fetch });
    expect((await signInWithGoogle(other, fake)).callback.status).toBe(403);
    // A GitHub id that happens to equal the subject lets nobody in with Google.
    const numeric = dashboard({ google: GOOGLE, allowedUsers: [SUBJECT], fetch: fake.fetch });
    expect((await signInWithGoogle(numeric, fake)).callback.status).toBe(403);
    const orgs = dashboard({ google: GOOGLE, allowedUsers: '*', organizations: ['91'], fetch: fake.fetch });
    expect(await (await get(orgs, '/base/dashboard')).text()).not.toContain('Continue with Google');
    expect((await get(orgs, '/base/dashboard/sign-in?with=google')).headers.get('location')).toMatch(/^https:\/\/github\.com\//);
  });
});

describe('usage and plans without Stripe', () => {
  const free: SlotlockTenantPlan = {
    plan: 'free',
    status: 'active',
    limits: { resources: 10, apiKeys: 10, webhookEndpoints: 2 },
    stripeCustomer: null,
    stripeSubscription: null,
    currentPeriodEnd: null,
  };
  const planned = (plan: SlotlockTenantPlan | null, extra: Record<string, unknown> = {}) => ({
    plan: vi.fn(async (_tenantRef: string) => plan),
    enrol: vi.fn(async (_tenantRef: string) => undefined),
    contact: 'mailto:founder@example.com',
    ...extra,
  });

  it('shows Usage with the plan and its limits, and offers the next plan by asking, with no Stripe', async () => {
    const plans = planned(free);
    const target = dashboard({ plans });
    const { session } = await signIn(target);
    const overview = await (await get(target, '/base/dashboard', session)).text();
    expect(overview).toMatch(/<a href="\/base\/dashboard\/plan">(?:(?!<\/a>).)*<span>Usage<\/span><\/a>/s);
    const response = await get(target, '/base/dashboard/plan', session);
    expect(response.status).toBe(200);
    // Nothing redirects to Stripe, so forms still go nowhere but here.
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self';");
    const html = await response.text();
    expect(html).toContain('<span class="plan-now">Free</span>');
    expect(html).toContain('<span>Resources</span><span class="meter-value">0<span class="meta"> of 10</span>');
    expect(html).toContain('This server does not count use yet.');
    expect(html).not.toContain('action="/base/dashboard/plan/upgrade"');
    expect(html).toContain('<a class="button primary" href="mailto:founder@example.com">Talk to us about Developer</a>');
  });

  it('warns before the default plan starts what the workspace has over it, and that nothing is removed', async () => {
    const plans = planned(null, {
      planDefault: vi.fn(async () => ({ plan: 'free', limits: free.limits, appliesFrom: new Date('2026-12-09T00:00:00Z') })),
    });
    const store = { ...resources.store, count: vi.fn(async () => 14) };
    const target = dashboard({ plans, resources: store });
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard/plan', session)).text();
    expect(html).toContain('<span class="plan-now">Free from 9 Dec 2026</span>');
    expect(html).toContain('<p class="plan-hint">Your plan from 9 Dec 2026.</p>');
    expect(html).toContain(
      'From 2026-12-09 00:00 UTC, this workspace is on Free: 10 resources, 10 API keys and 2 webhooks. You have 14 of 10 resources: nothing is removed, but from then, adding another is refused. Upgrade for more.',
    );
    expect(html).toContain('<span>Resources</span><span class="meter-value">14<span class="meta"> of 10</span>');
    expect(html).toContain('<div class="meter bad">');
  });

  it('asks an owner to upgrade at a limit of the plan the workspace is on, on Usage and the overview', async () => {
    let count = 10;
    const store = { ...resources.store, count: vi.fn(async () => count) };
    const target = dashboard({ plans: planned(free), resources: store });
    const { session } = await signIn(target);
    const usage = await (await get(target, '/base/dashboard/plan', session)).text();
    expect(usage).toContain(
      '<li class="attention warn"><span class="attention-text">On Free, you have 10 of 10 resources: adding another is refused. Upgrade for more.</span><a class="attention-action" href="#upgrade">Upgrade</a></li>',
    );
    expect(usage).toContain('<section class="plans" id="upgrade"');
    const overview = await (await get(target, '/base/dashboard', session)).text();
    const attention = /<ul class="attention-list"[^>]*>([\s\S]*?)<\/ul>/.exec(overview)?.[1] ?? '';
    expect(attention).toContain('On Free, you have 10 of 10 resources');
    expect(attention).toContain('href="/base/dashboard/plan#upgrade">Upgrade</a>');
    expect(overview).toMatch(/<section class="panel plan-card">[\s\S]*href="\/base\/dashboard\/plan#upgrade">Upgrade<\/a><\/section>/);
    // Past it (a plan that allows less than the workspace has): nothing is removed.
    count = 12;
    expect(await (await get(target, '/base/dashboard/plan', session)).text()).toContain(
      '<li class="attention bad"><span class="attention-text">On Free, you have 12 of 10 resources: nothing is removed, but adding another is refused. Upgrade for more.',
    );
    // Below it: nothing to do, and no upgrade pressed on the overview.
    count = 9;
    expect(await (await get(target, '/base/dashboard/plan', session)).text()).not.toContain('adding another is refused');
    expect(await (await get(target, '/base/dashboard', session)).text()).not.toMatch(/plan-card[\s\S]*>Upgrade<\/a>/);
  });

  it('offers no upgrade where none is sold or arranged, nor to a workspace that pays', async () => {
    const store = { ...resources.store, count: vi.fn(async () => 100) };
    const unsold = dashboard({ plans: planned(free, { contact: undefined }), resources: store });
    const first = await signIn(unsold);
    const plain = await (await get(unsold, '/base/dashboard/plan', first.session)).text();
    expect(plain).toContain('On Free, you have 100 of 10 resources: nothing is removed, but adding another is refused.</span></li>');
    expect(plain).not.toContain('Upgrade for more');
    const paying = { ...free, plan: 'developer' as const, limits: { resources: 100, apiKeys: 100, webhookEndpoints: 10 } };
    const paid = dashboard({ plans: planned(paying), resources: store });
    const second = await signIn(paid);
    const html = await (await get(paid, '/base/dashboard/plan', second.session)).text();
    expect(html).toContain('On Developer, you have 100 of 100 resources: adding another is refused.</span></li>');
    expect(html).not.toContain('Upgrade for more');
  });

  it('warns before the default plan starts what the workspace has at its limits, and offers the upgrade', async () => {
    const plans = planned(null, {
      planDefault: vi.fn(async () => ({ plan: 'free', limits: free.limits, appliesFrom: new Date('2026-12-09T00:00:00Z') })),
    });
    const store = { ...resources.store, count: vi.fn(async () => 10) };
    const target = dashboard({ plans, resources: store });
    const { session } = await signIn(target);
    const html = await (await get(target, '/base/dashboard/plan', session)).text();
    expect(html).toContain(
      'From 2026-12-09 00:00 UTC, this workspace is on Free: 10 resources, 10 API keys and 2 webhooks. You have 10 of 10 resources: from then, adding another is refused. Upgrade for more.</span><a class="attention-action" href="#upgrade">Upgrade</a>',
    );
  });

  it('links a refusal at a plan limit to the upgrade for an owner, and to Usage for a workspace that pays', async () => {
    const refusing = {
      ...resources.store,
      add: vi.fn(async () => {
        throw Object.assign(new Error('cap'), { code: 'resource_limit_reached', limit: 10 });
      }),
      webhooks: {
        list: vi.fn(async () => []),
        create: vi.fn(async () => ({ ok: false as const, code: 'webhook_limit_reached' as const, limit: 2 })),
        remove: vi.fn(async () => false),
      },
    };
    const cappedKeys = {
      ...keys.store,
      create: vi.fn(async () => {
        throw Object.assign(new Error('cap'), { code: 'api_key_limit_reached' });
      }),
    };
    const free10 = dashboard({ plans: planned(free), resources: refusing as never, keys: cappedKeys });
    const { session } = await signIn(free10);
    const resource = await post(free10, '/base/dashboard/resources', { csrf: await csrf(free10, session), reference: 'van-11', timezone: 'UTC' }, session);
    expect(resource.status).toBe(409);
    expect(await resource.text()).toContain(
      'You have 10 resources, archived ones included, as many as your plan allows. Delete one, or <a href="/base/dashboard/plan#upgrade">upgrade</a>.',
    );
    const key = await post(free10, '/base/dashboard/keys', { csrf: await csrf(free10, session), name: 'agent', access: 'read', expires: 'never' }, session);
    expect(key.status).toBe(409);
    expect(await key.text()).toContain(
      'You have as many active keys as your plan allows. Revoke one first, or <a href="/base/dashboard/plan#upgrade">upgrade</a>.',
    );
    const hook = await post(free10, '/base/dashboard/webhooks', { csrf: await csrf(free10, session), url: 'https://example.com/hook' }, session);
    expect(hook.status).toBe(409);
    expect(await hook.text()).toContain(
      'You have 2 webhooks, as many as your plan allows. Delete one first, or <a href="/base/dashboard/plan#upgrade">upgrade</a>.',
    );
    // A workspace that pays has no upgrade here: Usage says what it has.
    const paying = { ...free, plan: 'developer' as const, limits: { resources: 100, apiKeys: 100, webhookEndpoints: 10 } };
    const paid = dashboard({ plans: planned(paying), resources: refusing as never, keys: cappedKeys });
    const second = await signIn(paid);
    const refused = await post(paid, '/base/dashboard/resources', { csrf: await csrf(paid, second.session), reference: 'van-11', timezone: 'UTC' }, second.session);
    expect(await refused.text()).toContain('Delete one, or see <a href="/base/dashboard/plan">Usage</a>.');
  });

  it('puts a new tenant on the default plan before its first key, with no Stripe', async () => {
    const plans = planned(null);
    const target = dashboard({ plans });
    const { session } = await signIn(target);
    await post(target, '/base/dashboard/keys', { csrf: await csrf(target, session), name: 'Agent', access: 'read', expires: '30' }, session);
    expect(plans.enrol).toHaveBeenCalledWith('github:4242');
  });

  it('refuses a plan contact that is not https or mailto', () => {
    expect(() => dashboard({ plans: planned(free, { contact: 'javascript:alert(1)' }) })).toThrow(/https or mailto/);
  });
});
