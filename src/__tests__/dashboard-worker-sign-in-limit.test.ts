// The dashboard routes a path with one trailing slash as the path without it, so
// `/dashboard/sign-in/` and `/dashboard/callback/` count as sign-ins. No database: a refused
// request never opens a client.
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  type SlotlockDashboardWorkerEnv,
  type SlotlockRateLimit,
  createSlotlockDashboardWorker,
} from '../../workers/dashboard/worker.js';

const APP = 'https://app.slotlock.example.com';

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

function environment(
  signIn: SlotlockRateLimit,
  ceiling: SlotlockRateLimit = limiter(),
): SlotlockDashboardWorkerEnv {
  return {
    // No database answers at this address: a request that reached one would fail, not answer 429.
    HYPERDRIVE: { connectionString: 'postgres://nobody:nothing@127.0.0.1:9/none' },
    SLOTLOCK_PUBLIC_URL: APP,
    SLOTLOCK_SERVICE_URL: 'https://slotlock-api.example.com',
    SLOTLOCK_GITHUB_CLIENT_ID: 'Ov23liWorkerTest',
    SLOTLOCK_GITHUB_CLIENT_SECRET: randomBytes(20).toString('hex'),
    SLOTLOCK_SESSION_SECRET: randomBytes(32).toString('hex'),
    SLOTLOCK_DASHBOARD_USERS: '*',
    SLOTLOCK_CLIENT_RATE_LIMIT: limiter(),
    SLOTLOCK_SIGN_IN_RATE_LIMIT: signIn,
    SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT: ceiling,
  };
}

describe('P2: the Worker sign-in limit and a trailing slash', () => {
  const githubAsked: string[] = [];
  const github: typeof fetch = async (input) => {
    githubAsked.push(String(input));
    return Response.json({ access_token: 'gho_fake' });
  };
  const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };

  it('counts /dashboard/sign-in/ and /dashboard/callback/ as sign-ins', async () => {
    const signIn = limiter(0);
    const env = environment(signIn);
    const worker = createSlotlockDashboardWorker({ fetch: github });
    for (const path of ['/dashboard/sign-in/', '/dashboard/callback/?code=c&state=s']) {
      const response = await worker.fetch(new Request(`${APP}${path}`), env, ctx);
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('60');
    }
    expect(signIn.asked).toEqual(['sign-in:unknown', 'sign-in:unknown']);
    expect(githubAsked).toEqual([]);
  });

  it('counts only what the dashboard routes to a sign-in', async () => {
    const signIn = limiter(0);
    const env = environment(signIn);
    const worker = createSlotlockDashboardWorker({ fetch: github });
    // The canary: the paths without the slash are refused by the same limit.
    expect((await worker.fetch(new Request(`${APP}/dashboard/sign-in`), env, ctx)).status).toBe(
      429,
    );
    // Two slashes are not one: the dashboard does not route this to a sign-in.
    const doubled = await worker.fetch(new Request(`${APP}/dashboard/sign-in//`), env, ctx);
    expect(doubled.status).toBe(404);
    expect(signIn.asked).toEqual(['sign-in:unknown']);
  });
});

describe('SEC-12: sign-ins are limited per client, under a higher ceiling for all', () => {
  const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
  const from = (address: string) =>
    new Request(`${APP}/dashboard/sign-in`, { headers: { 'cf-connecting-ip': address } });

  it("does not refuse another client's sign-in once one client has used its own", async () => {
    // One global bucket of 120 a minute against a per-client 60 would let two clients at their
    // limit refuse everyone.
    const signIn = limiter(2);
    const worker = createSlotlockDashboardWorker();
    const env = environment(signIn);
    const statuses: number[] = [];
    for (const address of ['203.0.113.7', '203.0.113.7', '203.0.113.7', '198.51.100.4']) {
      statuses.push((await worker.fetch(from(address), env, ctx)).status);
    }
    expect(statuses).toEqual([302, 302, 429, 302]);
    expect(signIn.asked).toEqual([
      'sign-in:203.0.113.7',
      'sign-in:203.0.113.7',
      'sign-in:203.0.113.7',
      'sign-in:198.51.100.4',
    ]);
  });

  it('counts an IPv6 client as its /64, so addresses rotated inside it buy no new budget (SEC-12)', async () => {
    // 600 sign-ins across one /64 must not use up the ceiling every client shares.
    const signIn = limiter(2);
    const ceiling = limiter(5);
    const client = limiter();
    const env = { ...environment(signIn, ceiling), SLOTLOCK_CLIENT_RATE_LIMIT: client };
    const worker = createSlotlockDashboardWorker();
    const statuses: number[] = [];
    for (let index = 1; index <= 6; index += 1) {
      statuses.push((await worker.fetch(from(`2001:db8:1:2::${index.toString(16)}`), env, ctx)).status);
    }
    // The /64 took two of the ceiling's five, so other clients still sign in.
    for (const address of ['198.51.100.4', '2001:db8:2:3::1']) {
      statuses.push((await worker.fetch(from(address), env, ctx)).status);
    }
    expect(statuses).toEqual([302, 302, 429, 429, 429, 429, 302, 302]);
    const clients = ['2001:db8:1:2::/64', '198.51.100.4', '2001:db8:2:3::/64'];
    const networks = ['2001:db8:1::/48', '198.51.100.4', '2001:db8:2::/48'];
    expect(new Set(signIn.asked)).toEqual(new Set(networks.map((key) => `sign-in:${key}`)));
    expect(new Set(client.asked)).toEqual(new Set(clients.map((key) => `client:${key}`)));
  });

  it("counts an IPv6 client's sign-ins by its /48, so rotating /64s cannot use up the ceiling (SEC-12)", async () => {
    // Each /64 within its own limit, across one /48, must not use up the shared ceiling: a /48 is
    // one site's allocation.
    const signIn = limiter(2);
    const ceiling = limiter(5);
    const client = limiter();
    const env = { ...environment(signIn, ceiling), SLOTLOCK_CLIENT_RATE_LIMIT: client };
    const worker = createSlotlockDashboardWorker();
    const statuses: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      statuses.push((await worker.fetch(from(`2001:db8:1:${index.toString(16)}::1`), env, ctx)).status);
    }
    for (const address of ['198.51.100.4', '2001:db8:2:0::1']) {
      statuses.push((await worker.fetch(from(address), env, ctx)).status);
    }
    expect(statuses).toEqual([302, 302, 429, 429, 429, 429, 429, 429, 302, 302]);
    expect(new Set(signIn.asked)).toEqual(
      new Set(['sign-in:2001:db8:1::/48', 'sign-in:198.51.100.4', 'sign-in:2001:db8:2::/48']),
    );
    expect(client.asked[1]).toBe('client:2001:db8:1:1::/64');
  });

  it('still bounds every client together', async () => {
    const ceiling = limiter(3);
    const worker = createSlotlockDashboardWorker();
    const env = environment(limiter(), ceiling);
    const statuses: number[] = [];
    for (const address of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4']) {
      statuses.push((await worker.fetch(from(address), env, ctx)).status);
    }
    expect(statuses).toEqual([302, 302, 302, 429]);
    expect(new Set(ceiling.asked)).toEqual(new Set(['sign-in']));
  });

  it('without the ceiling binding, keeps one sign-in budget for every client, as before, and says so', async () => {
    // A deployment whose configuration predates the ceiling: the dashboard keeps serving, with the
    // one shared budget it had, rather than answering 503 until the configuration catches up.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const signIn = limiter(2);
      const { SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT: _, ...without } = environment(signIn);
      const worker = createSlotlockDashboardWorker();
      const statuses: number[] = [];
      for (const address of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
        statuses.push(
          (await worker.fetch(from(address), without as SlotlockDashboardWorkerEnv, ctx)).status,
        );
      }
      expect(statuses).toEqual([302, 302, 429]);
      expect(signIn.asked).toEqual(['sign-in', 'sign-in', 'sign-in']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT');
    } finally {
      warn.mockRestore();
    }
  });

  it('still needs the per-client bindings to serve', async () => {
    const { SLOTLOCK_SIGN_IN_RATE_LIMIT: _, ...without } = environment(limiter());
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const unbounded = await createSlotlockDashboardWorker().fetch(
        from('192.0.2.9'),
        without as SlotlockDashboardWorkerEnv,
        ctx,
      );
      expect(unbounded.status).toBe(503);
    } finally {
      error.mockRestore();
    }
  });
});

describe('the Worker with usage metering', () => {
  it('takes SLOTLOCK_USAGE on or off, and refuses anything else', async () => {
    const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const refused = await createSlotlockDashboardWorker().fetch(
        new Request(`${APP}/dashboard`),
        { ...environment(limiter()), SLOTLOCK_USAGE: 'yes' },
        ctx,
      );
      expect(refused.status).toBe(503);
      expect(JSON.stringify(error.mock.calls)).toContain('SLOTLOCK_USAGE must be on or off');
    } finally {
      error.mockRestore();
    }
  });
});

describe('the Worker with Stripe billing', () => {
  const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
  const billed = (extra: Record<string, string> = {}) => ({
    ...environment(limiter()),
    STRIPE_SECRET_KEY: 'rk_test_fake',
    SLOTLOCK_STRIPE_PRICE_MONTHLY: 'price_month',
    SLOTLOCK_STRIPE_PRICE_YEARLY: 'price_year',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_only',
    ...extra,
  });

  it('refuses an unsigned Stripe delivery before reaching the database or the rate limits', async () => {
    const env = billed();
    const response = await createSlotlockDashboardWorker().fetch(
      new Request(`${APP}/stripe/webhook`, { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(response.status).toBe(400);
    expect((env.SLOTLOCK_CLIENT_RATE_LIMIT as ReturnType<typeof limiter>).asked).toEqual([]);
  });

  it('has no webhook without its secret, and refuses the retired free-plan date setting', async () => {
    const { STRIPE_WEBHOOK_SECRET: _secret, ...env } = billed();
    const response = await createSlotlockDashboardWorker().fetch(
      new Request(`${APP}/stripe/webhook`, { method: 'POST', body: '{}' }),
      env,
      ctx,
    );
    expect(response.status).toBe(404);
    // The default plan lives in the database now (slotlock plan default): a Worker still given the
    // date would let its operator believe it applies.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const misconfigured = await createSlotlockDashboardWorker().fetch(
        new Request(`${APP}/dashboard`),
        billed({ SLOTLOCK_FREE_PLAN_FROM: '2026-12-09' }),
        ctx,
      );
      expect(misconfigured.status).toBe(503);
      expect(JSON.stringify(error.mock.calls)).toContain('slotlock plan default');
    } finally {
      error.mockRestore();
    }
  });
});
