// The dashboard Worker's global sign-in limit (SLOTLOCK_SIGN_IN_RATE_LIMIT) counts every request the
// dashboard routes to a sign-in or its callback. The dashboard routes a path with one trailing
// slash as the path without it, so `/dashboard/sign-in/` and `/dashboard/callback/` are sign-ins
// too. No database is needed: a refused request never opens a client.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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

function environment(signIn: SlotlockRateLimit): SlotlockDashboardWorkerEnv {
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
    expect(signIn.asked).toEqual(['sign-in', 'sign-in']);
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
    expect(signIn.asked).toEqual(['sign-in']);
  });
});
