// A team's identity provider calls the dashboard's SCIM endpoint from the provider's own addresses,
// which its other customers share: Okta's and Microsoft Entra's provisioning services send every
// tenant's calls from one pool. Counted in the dashboard's per-client budget, one team's sync (or
// someone else's tenant aimed at their own team) would use up the budget another team's
// deprovisioning needs, and share it with people browsing. With SLOTLOCK_SCIM_RATE_LIMIT, SCIM is
// counted there alone. No database: a refused request never opens a client.
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

function environment(client: SlotlockRateLimit, scim?: SlotlockRateLimit): SlotlockDashboardWorkerEnv {
  return {
    // No database answers at this address: a request that reached one would fail, not answer 429.
    HYPERDRIVE: { connectionString: 'postgres://nobody:nothing@127.0.0.1:9/none' },
    SLOTLOCK_PUBLIC_URL: APP,
    SLOTLOCK_SERVICE_URL: 'https://slotlock-api.example.com',
    SLOTLOCK_GITHUB_CLIENT_ID: 'Ov23liWorkerTest',
    SLOTLOCK_GITHUB_CLIENT_SECRET: randomBytes(20).toString('hex'),
    SLOTLOCK_SESSION_SECRET: randomBytes(32).toString('hex'),
    SLOTLOCK_DASHBOARD_USERS: '*',
    SLOTLOCK_DASHBOARD_TEAM_WORKSPACES: 'on',
    SLOTLOCK_VERIFIED_DOMAINS: 'on',
    SLOTLOCK_TEAM_SCIM: 'on',
    SLOTLOCK_CLIENT_RATE_LIMIT: client,
    SLOTLOCK_SIGN_IN_RATE_LIMIT: limiter(),
    SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT: limiter(),
    ...(scim ? { SLOTLOCK_SCIM_RATE_LIMIT: scim } : {}),
  };
}

const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
const PROVIDER = '20.44.10.122';
const scimCall = (team: string, address = PROVIDER) =>
  new Request(`${APP}/dashboard/scim/v2/${team}/Users?startIndex=1`, {
    headers: { 'cf-connecting-ip': address, authorization: 'Bearer not-a-token' },
  });

describe('SCIM is counted apart from the dashboard (SLOTLOCK_SCIM_RATE_LIMIT)', () => {
  it("never spends the dashboard's per-client budget, and is refused only by its own", async () => {
    const client = limiter(0);
    const scim = limiter(0);
    const worker = createSlotlockDashboardWorker();
    const env = environment(client, scim);
    const response = await worker.fetch(scimCall('a1b2c3'), env, ctx);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(scim.asked).toEqual([`scim:${PROVIDER}`]);
    expect(client.asked).toEqual([]);
  });

  it("leaves people's dashboard requests from the same address to the per-client budget", async () => {
    const client = limiter(0);
    const scim = limiter();
    const worker = createSlotlockDashboardWorker();
    const env = environment(client, scim);
    const page = new Request(`${APP}/dashboard/scim`, { headers: { 'cf-connecting-ip': PROVIDER } });
    expect((await worker.fetch(page, env, ctx)).status).toBe(429);
    expect(client.asked).toEqual([`client:${PROVIDER}`]);
    expect(scim.asked).toEqual([]);
  });

  it('counts an IPv6 provider as its /64, as the per-client budget does', async () => {
    const scim = limiter(0);
    const worker = createSlotlockDashboardWorker();
    const env = environment(limiter(), scim);
    await worker.fetch(scimCall('a1b2c3', '2001:db8:5:6::9'), env, ctx);
    expect(scim.asked).toEqual(['scim:2001:db8:5:6::/64']);
  });

  it('without the binding, counts SCIM in the per-client budget, as before, and says so', async () => {
    // A configuration from before the binding keeps serving, with SCIM in the budget it had.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const client = limiter(0);
      const worker = createSlotlockDashboardWorker();
      const response = await worker.fetch(scimCall('a1b2c3'), environment(client), ctx);
      expect(response.status).toBe(429);
      expect(client.asked).toEqual([`client:${PROVIDER}`]);
      expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'SLOTLOCK_SCIM_RATE_LIMIT',
      );
    } finally {
      warn.mockRestore();
    }
  });
});
