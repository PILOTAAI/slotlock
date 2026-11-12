// What the admin console reads about the website (RFC 0006, M9): Bing's weekly rows summed for the
// period, a Search Console key that does not read failing only its part, Cloudflare's referrers
// apart from the rest, the pages worth a new title, and the Worker's settings for each provider.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSlotlockAdminInsights, slotlockLowClickPages } from '../admin/insights.js';
import { insightsOf } from '../../workers/admin/worker.js';

const NOW = Date.UTC(2026, 10, 12, 12);
const DAY = 86_400_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the Site page’s providers', () => {
  it('sums Bing’s weekly rows of the last 28 days by query and page, weighting position by impressions', async () => {
    const asked: string[] = [];
    const insights = createSlotlockAdminInsights({
      bing: { key: 'bingkey0123456789', site: 'https://example.com/' },
      now: () => NOW,
      fetch: (async (input: string | URL | Request) => {
        const target = new URL(String(input));
        asked.push(`${target.pathname} ${target.searchParams.get('siteUrl')} ${target.searchParams.get('apikey')}`);
        const row = (key: string, clicks: number, impressions: number, position: number, daysAgo: number) =>
          ({ Query: key, Clicks: clicks, Impressions: impressions, AvgImpressionPosition: position, Date: `/Date(${NOW - daysAgo * DAY}-0800)/` });
        return json({ d: target.pathname.endsWith('GetQueryStats')
          ? [row('agent calendar', 2, 10, 4, 3), row('agent calendar', 1, 30, 8, 10), row('old query', 50, 500, 1, 90)]
          : [row('https://example.com/', 3, 40, 7, 3)] });
      }) as typeof fetch,
    });
    expect(insights.google).toBeNull();
    expect(insights.visits).toBeNull();
    const report = await (insights.bing as () => Promise<Awaited<ReturnType<NonNullable<typeof insights.bing>>>>)();
    expect(asked).toEqual([
      '/webmaster/api.svc/json/GetQueryStats https://example.com/ bingkey0123456789',
      '/webmaster/api.svc/json/GetPageStats https://example.com/ bingkey0123456789',
    ]);
    expect(report.queries).toEqual([{ key: 'agent calendar', clicks: 3, impressions: 40, ctr: 3 / 40, position: 7 }]);
    expect(report).toMatchObject({ from: '2026-10-16', to: '2026-11-12', clicks: 3, impressions: 40 });
  });

  it('fails only Search Console’s part for a key that is not one, and never echoes a provider’s text', async () => {
    const insights = createSlotlockAdminInsights({ google: { serviceAccount: 'not json', property: 'sc-domain:example.com' }, now: () => NOW });
    await expect((insights.google as () => Promise<unknown>)()).rejects.toMatchObject({ code: 'google_key' });
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const refused = createSlotlockAdminInsights({
      google: {
        serviceAccount: JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }),
        property: 'sc-domain:example.com',
      },
      now: () => NOW,
      fetch: (async () => new Response('secret-echo: the assertion was ey...', { status: 400 })) as typeof fetch,
    });
    const error = await (refused.google as () => Promise<unknown>)().catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ code: 'google_400' });
    expect(String((error as Error).message)).not.toContain('secret-echo');
  });

  it('keeps Cloudflare’s page loads when its referrers are refused', async () => {
    const insights = createSlotlockAdminInsights({
      cloudflare: { token: 't', account: 'a'.repeat(32), siteTag: 'b'.repeat(32) },
      now: () => NOW,
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
        expect(variables).toEqual({ account: 'a'.repeat(32), site: 'b'.repeat(32), from: '2026-10-16', to: '2026-11-12' });
        if (query.includes('refererHost')) return json({ data: null, errors: [{ message: 'no' }] });
        return json({ data: { viewer: { accounts: [{
          days: [{ count: 3, dimensions: { date: '2026-11-11' } }, { count: 4, dimensions: { date: '2026-11-12' } }],
          pages: [{ count: 7, dimensions: { requestPath: '/' } }],
        }] } } });
      }) as typeof fetch,
    });
    const report = await (insights.visits as () => Promise<{ pageLoads: number; referrers: unknown; pages: unknown }>)();
    expect(report).toMatchObject({ pageLoads: 7, referrers: null, pages: [{ path: '/', count: 7 }] });
  });

  it('finds the pages seen often and clicked rarely, the most seen first', () => {
    const row = (key: string, clicks: number, impressions: number) => ({ key, clicks, impressions, ctr: clicks / impressions, position: 5 });
    expect(slotlockLowClickPages([row('/a', 1, 99), row('/b', 1, 100), row('/c', 30, 1000), row('/d', 5, 900)]).map((page) => page.key))
      .toEqual(['/d', '/b']);
  });
});

describe('the admin Worker’s provider settings', () => {
  it('turns each provider on only with all of its settings well formed, and keeps hosts to https', () => {
    expect(insightsOf({ HYPERDRIVE: { connectionString: '' } })).toEqual({ hosts: {} });
    const all = insightsOf({
      HYPERDRIVE: { connectionString: '' },
      SLOTLOCK_ADMIN_SEARCH_CONSOLE_KEY: '{"client_email":"a"}',
      SLOTLOCK_ADMIN_SEARCH_CONSOLE_PROPERTY: 'sc-domain:slotlock.pylota.io',
      SLOTLOCK_ADMIN_BING_KEY: 'abcdef0123456789',
      SLOTLOCK_ADMIN_BING_SITE: 'https://slotlock.pylota.io/',
      SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN: 'token',
      SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT: 'a'.repeat(32),
      SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE: 'b'.repeat(32),
      SLOTLOCK_ADMIN_API_HEALTH_URL: 'https://api.example.com/healthz',
      SLOTLOCK_ADMIN_DASHBOARD_URL: 'http://dashboard.example.com/',
    });
    expect(Object.keys(all.insights ?? {}).sort()).toEqual(['bing', 'cloudflare', 'google']);
    expect(all.hosts).toEqual({ api: 'https://api.example.com/healthz' });
    const malformed = insightsOf({
      HYPERDRIVE: { connectionString: '' },
      SLOTLOCK_ADMIN_SEARCH_CONSOLE_KEY: '{}',
      SLOTLOCK_ADMIN_SEARCH_CONSOLE_PROPERTY: 'slotlock.pylota.io',
      SLOTLOCK_ADMIN_BING_KEY: 'short',
      SLOTLOCK_ADMIN_BING_SITE: 'https://slotlock.pylota.io/',
      SLOTLOCK_ADMIN_CLOUDFLARE_TOKEN: 'token',
      SLOTLOCK_ADMIN_CLOUDFLARE_ACCOUNT: 'not-an-id',
      SLOTLOCK_ADMIN_WEB_ANALYTICS_SITE: 'b'.repeat(32),
    });
    expect(malformed.insights).toBeUndefined();
  });
});
