// The dashboard as a Cloudflare Worker (workers/dashboard/worker.ts), run as its fetch handler
// against real Postgres, connected as a LOGIN role without BYPASSRLS, as Hyperdrive would connect.
// GitHub is a fake `fetch`. Each request opens its own client and hands its closing to waitUntil,
// one dashboard serves every request (so its sign-in limit holds across them), and the page points
// agents at the server's own origin. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { createSlotlockStore } from '../store.js';
import {
  type SlotlockDashboardWorkerEnv,
  type SlotlockRateLimit,
  createSlotlockDashboardWorker,
} from '../../workers/dashboard/worker.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const APP = 'https://app.slotlock.example.com';
const SERVICE = 'https://slotlock-api.example.com';

/** A rate limiting binding that allows `allowed` calls per key, and records every key it is asked. */
function limiter(allowed = Number.POSITIVE_INFINITY): SlotlockRateLimit & { asked: string[] } {
  const counts = new Map<string, number>();
  const asked: string[] = [];
  return {
    asked,
    async limit({ key }) {
      asked.push(key);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= allowed };
    },
  };
}

describe.skipIf(!url)('the dashboard Worker (real Postgres)', () => {
  const role = `slotlock_worker_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const githubId = 800_000 + Math.floor(Math.random() * 99_999);
  const tenantRef = `github:${githubId}`;
  let admin: ReturnType<typeof postgres>;
  let env: SlotlockDashboardWorkerEnv;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    env = {
      HYPERDRIVE: {
        connectionString: Object.assign(new URL(url as string), { username: role, password }).href,
      },
      SLOTLOCK_PUBLIC_URL: APP,
      SLOTLOCK_SERVICE_URL: SERVICE,
      SLOTLOCK_GITHUB_CLIENT_ID: 'Ov23liWorkerTest',
      SLOTLOCK_GITHUB_CLIENT_SECRET: randomBytes(20).toString('hex'),
      SLOTLOCK_SESSION_SECRET: randomBytes(32).toString('hex'),
      SLOTLOCK_DASHBOARD_USERS: '*',
      SLOTLOCK_CLIENT_RATE_LIMIT: limiter(),
      SLOTLOCK_SIGN_IN_RATE_LIMIT: limiter(),
      SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT: limiter(),
    };
  });

  afterAll(async () => {
    await Promise.allSettled(pending);
    await admin`DELETE FROM slotlock.api_keys WHERE tenant_ref = ${tenantRef}`;
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  // GitHub, behind fetch as Cloudflare Workers implement it: they refuse `redirect: 'error'` with a
  // TypeError (workerd, wrangler 4.149.0, checked 2026-10-17).
  const github: typeof fetch = async (input, init) => {
    if (init?.redirect === 'error') {
      throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    }
    return String(input).endsWith('/access_token')
      ? Response.json({ access_token: 'gho_fake' })
      : Response.json({ id: githubId, login: 'fleet-owner' });
  };

  it('sends the root to the dashboard and anything else away', async () => {
    const worker = createSlotlockDashboardWorker({ fetch: github });
    const root = await worker.fetch(new Request(`${APP}/`), env, ctx);
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe(`${APP}/dashboard`);
    const elsewhere = await worker.fetch(new Request(`${APP}/mcp`), env, ctx);
    expect(elsewhere.status).toBe(404);
  });

  it('signs a person in, issues a key for their tenant, and points agents at the server', async () => {
    const worker = createSlotlockDashboardWorker({ fetch: github });
    const get = (path: string, cookie?: string) =>
      worker.fetch(new Request(`${APP}${path}`, cookie ? { headers: { cookie } } : {}), env, ctx);
    const start = await get('/dashboard/sign-in');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const signIn = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
    const callback = await get(`/dashboard/callback?code=c&state=${state}`, signIn);
    const session = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-slotlock-session='))
      ?.split('; ')[0] as string;
    expect(session).toBeDefined();

    const page = await (await get('/dashboard', session)).text();
    expect(page).toContain(`<code>${SERVICE}/mcp</code>`);
    expect(page).toContain(`<code>${SERVICE}/a2a</code>`);
    expect(page).not.toContain(`${APP}/mcp`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] as string;
    const once = /name="once" value="([^"]+)"/.exec(page)?.[1] as string;
    const created = await worker.fetch(
      new Request(`${APP}/dashboard/keys`, {
        method: 'POST',
        headers: {
          cookie: session,
          origin: APP,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          csrf,
          once,
          name: 'Fleet agent',
          access: 'read_write',
          expires: '90',
        }).toString(),
      }),
      env,
      ctx,
    );
    expect(created.status).toBe(200);
    const shown = await created.text();
    const key = /id="key" readonly value="(slk_[0-9A-Za-z]{46})"/.exec(shown)?.[1] as string;
    expect(key).toBeDefined();
    expect(shown).toContain(`claude mcp add --transport http slotlock ${SERVICE}/mcp`);
    await expect(createSlotlockApiKeyStore(admin).authenticate(key)).resolves.toMatchObject({
      tenantRef,
      scopes: ['read', 'write'],
    });
  });

  it('refuses a GitHub answer that redirects, rather than following it', async () => {
    const asked: string[] = [];
    const redirecting: typeof fetch = async (input, init) => {
      asked.push(String(input));
      expect(init?.redirect).toBe('manual');
      return new Response(null, {
        status: 302,
        headers: { location: 'https://elsewhere.example' },
      });
    };
    const worker = createSlotlockDashboardWorker({ fetch: redirecting });
    const start = await worker.fetch(new Request(`${APP}/dashboard/sign-in`), env, ctx);
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const cookie = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
    const callback = await worker.fetch(
      new Request(`${APP}/dashboard/callback?code=c&state=${state}`, { headers: { cookie } }),
      env,
      ctx,
    );
    expect(callback.status).toBe(502);
    expect(
      callback.headers.getSetCookie().some((value) => value.includes('slotlock-session')),
    ).toBe(false);
    expect(asked).toEqual(['https://github.com/login/oauth/access_token']);
  });

  it('holds its limit on sign-ins in flight across requests, as one server would', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = 0;
    let eightReached: () => void = () => {};
    const eight = new Promise<void>((resolve) => {
      eightReached = resolve;
    });
    const slowGithub: typeof fetch = async (input, init) => {
      reached += 1;
      if (reached === 8) eightReached();
      await held;
      return github(input, init);
    };
    const worker = createSlotlockDashboardWorker({ fetch: slowGithub });
    const callbacks = await Promise.all(
      Array.from({ length: 9 }, async () => {
        const start = await worker.fetch(new Request(`${APP}/dashboard/sign-in`), env, ctx);
        const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
        const cookie = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
        return new Request(`${APP}/dashboard/callback?code=c&state=${state}`, {
          headers: { cookie },
        });
      }),
    );
    const inFlight = callbacks.slice(0, 8).map((request) => worker.fetch(request, env, ctx));
    // The eight are waiting on GitHub when the ninth arrives.
    await eight;
    const ninth = await worker.fetch(callbacks[8] as Request, env, ctx);
    expect(ninth.status).toBe(503);
    release();
    const finished = await Promise.all(inFlight);
    expect(finished.map((response) => response.status)).toEqual(Array(8).fill(303));
  });

  it('refuses a client over its limit before it opens a database client or asks GitHub', async () => {
    const asked: string[] = [];
    const counting: typeof fetch = async (input, init) => {
      asked.push(String(input));
      return github(input, init);
    };
    const client = limiter(2);
    // No database answers at this address: a request that reached one would fail, not answer 429.
    const unreachable = {
      ...env,
      HYPERDRIVE: { connectionString: 'postgres://nobody:nothing@127.0.0.1:9/none' },
      SLOTLOCK_CLIENT_RATE_LIMIT: client,
    };
    const worker = createSlotlockDashboardWorker({ fetch: counting });
    const from = (address: string, path: string) =>
      worker.fetch(
        new Request(`${APP}${path}`, { headers: { 'cf-connecting-ip': address } }),
        unreachable,
        ctx,
      );
    expect((await from('203.0.113.7', '/dashboard/sign-in')).status).toBe(302);
    expect((await from('203.0.113.7', '/dashboard/sign-in')).status).toBe(302);
    const refused = await from('203.0.113.7', '/dashboard/callback?code=c&state=s');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(asked).toEqual([]);
    // Another address has its own count.
    expect((await from('198.51.100.4', '/dashboard/sign-in')).status).toBe(302);
    expect(client.asked).toEqual([
      'client:203.0.113.7',
      'client:203.0.113.7',
      'client:203.0.113.7',
      'client:198.51.100.4',
    ]);
  });

  it('bounds sign-ins from every client together, wherever they come from', async () => {
    const signIn = limiter(2);
    const worker = createSlotlockDashboardWorker({ fetch: github });
    const limited = { ...env, SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT: signIn };
    const statuses: number[] = [];
    for (const address of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
      const response = await worker.fetch(
        new Request(`${APP}/dashboard/sign-in`, { headers: { 'cf-connecting-ip': address } }),
        limited,
        ctx,
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([302, 302, 429]);
    // The dashboard's other pages are not sign-ins.
    const page = await worker.fetch(new Request(`${APP}/dashboard`), limited, ctx);
    expect(page.status).toBe(200);
    expect(signIn.asked).toEqual(['sign-in', 'sign-in', 'sign-in']);
  });

  it('does not serve without its rate limits', async () => {
    const { SLOTLOCK_SIGN_IN_RATE_LIMIT: _, ...unlimited } = env;
    const worker = createSlotlockDashboardWorker({ fetch: github });
    const response = await worker.fetch(
      new Request(`${APP}/dashboard/sign-in`),
      unlimited as SlotlockDashboardWorkerEnv,
      ctx,
    );
    expect(response.status).toBe(503);
  });

  it('closes every client it opens', async () => {
    await Promise.all(pending);
    const [open] = await admin<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_stat_activity WHERE usename = ${role}`;
    expect(open?.count).toBe('0');
  });

  it('answers 503 without naming a secret when it is not configured', async () => {
    const { SLOTLOCK_SESSION_SECRET: _, ...missing } = env;
    const worker = createSlotlockDashboardWorker({ fetch: github });
    const response = await worker.fetch(
      new Request(`${APP}/dashboard`),
      { ...missing, SLOTLOCK_GITHUB_CLIENT_SECRET: 'short' } as SlotlockDashboardWorkerEnv,
      ctx,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('short');
  });
});
