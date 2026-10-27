// The dashboard Worker's sign-in limits count every request the dashboard routes to a sign-in or its
// callback: per client network (SLOTLOCK_SIGN_IN_RATE_LIMIT), and for every client together under a
// higher ceiling (SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT). The dashboard routes a path with one
// trailing slash as the path without it, so `/dashboard/sign-in/` and `/dashboard/callback/` are
// sign-ins too. No database is needed: a refused request never opens a client.
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
    // The audit: one global bucket of 120 a minute against a per-client limit of 60, so two clients
    // at their limit refused every visitor at that Cloudflare location.
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
    // The verifier's probe: 600 sign-ins from 2001:db8:1:2::1 up to ::258 were each answered 302,
    // used up the ceiling every client shares, and the next visitor was refused.
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
    // The verifier's probe after the /64 fix: sign-ins from 2001:db8:1:0::1, 2001:db8:1:1::1 and
    // on, each /64 within its own limit, used up the ceiling every client shares, and the next
    // visitor was refused. A /48 is one site's allocation, as one IPv4 address is a site behind NAT.
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
    // Every other dashboard request is still counted per /64.
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
