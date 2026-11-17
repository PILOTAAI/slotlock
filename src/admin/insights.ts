// What the admin console reads about the website (RFC 0006, M9 and 4.6), each provider read-only and
// optional: Google Search Console (a service account added to the property as a restricted user),
// Bing Webmaster Tools (an API key) and Cloudflare Web Analytics (an API token that reads account
// analytics). Every report covers the last 28 days and holds counts only, never a visitor. The
// caller keeps each an hour in Postgres (slotlock.admin_cache).

/** A query or a page as a search engine counts it over the period. */
export interface SlotlockSearchRow {
  key: string;
  clicks: number;
  impressions: number;
  /** Clicks over impressions, 0 to 1. */
  ctr: number;
  /** Average position in results, 1 the top; 0 when the engine gave none. */
  position: number;
}

/** A search engine's last 28 days for the site. */
export interface SlotlockSearchReport {
  from: string;
  to: string;
  clicks: number;
  impressions: number;
  queries: SlotlockSearchRow[];
  pages: SlotlockSearchRow[];
  /** Search Console's sitemaps: what it last read of each, and its errors and warnings. */
  sitemaps: { path: string; submitted: number; lastDownloaded: string | null; errors: number; warnings: number }[];
  readAt: number;
}

/** Cloudflare Web Analytics' last 28 days: page loads by day, the top pages and referrers. */
export interface SlotlockVisitReport {
  from: string;
  to: string;
  pageLoads: number;
  days: { day: string; count: number }[];
  pages: { path: string; count: number }[];
  /** Null when Cloudflare would not give referrers; the rest still shows. */
  referrers: { host: string; count: number }[] | null;
  readAt: number;
}

export interface SlotlockAdminInsightsOptions {
  /**
   * Search Console: a Google service account's JSON key (client_email, private_key) and the
   * property, `sc-domain:example.com` or `https://example.com/`.
   */
  google?: { serviceAccount: string; property: string };
  /** Bing Webmaster Tools: its API key and the site as Bing has it, `https://example.com/`. */
  bing?: { key: string; site: string };
  /** Cloudflare Web Analytics: a token with Account Analytics Read, the account id and the site tag. */
  cloudflare?: { token: string; account: string; siteTag: string };
  fetch?: typeof fetch;
  now?: () => number;
}

export interface SlotlockAdminInsights {
  /** Null for a provider not configured. */
  google: (() => Promise<SlotlockSearchReport>) | null;
  bing: (() => Promise<SlotlockSearchReport>) | null;
  visits: (() => Promise<SlotlockVisitReport>) | null;
}

/** A provider's refusal: which provider and its HTTP status, never its text (it can echo a key). */
export class SlotlockInsightsError extends Error {
  override name = 'SlotlockInsightsError';
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

const DAYS = 28;
const DAY_MS = 86_400_000;
const encoder = new TextEncoder();

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0);

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** A PKCS#8 private key from its PEM, as Google's service account keys are. */
function pkcs8Of(pem: string): Uint8Array<ArrayBuffer> {
  // A key pasted into a secret store sometimes arrives with literal \n for its line ends.
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/.exec(pem.replace(/\\n/g, '\n'));
  if (!match) throw new SlotlockInsightsError('The Search Console key is not a PKCS#8 private key', 'google_key');
  const bytes = Buffer.from((match[1] as string).replace(/\s+/g, ''), 'base64');
  const der = new Uint8Array(bytes.length);
  der.set(bytes);
  return der;
}

/** Rows a search engine gave, the busiest first: clicks, then impressions. */
const busiest = (rows: SlotlockSearchRow[], limit: number) =>
  rows.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.key.localeCompare(b.key)).slice(0, limit);

export function createSlotlockAdminInsights(options: SlotlockAdminInsightsOptions): SlotlockAdminInsights {
  const fetcher = options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const period = () => {
    const to = now();
    return { from: isoDay(to - (DAYS - 1) * DAY_MS), to: isoDay(to) };
  };
  const send = async (provider: string, url: string, init: RequestInit): Promise<unknown> => {
    const response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new SlotlockInsightsError(`${provider} answered ${response.status}`, `${provider}_${response.status}`);
    return response.json();
  };

  // ---------- Google Search Console ----------
  let google: SlotlockAdminInsights['google'] = null;
  // A key that does not read as one fails Search Console's part of the page, never the console.
  let account: { client_email?: unknown; private_key?: unknown } = {};
  try {
    account = options.google ? (JSON.parse(options.google.serviceAccount) as typeof account) : {};
  } catch {
    account = {};
  }
  if (options.google && (typeof account.client_email !== 'string' || typeof account.private_key !== 'string')) {
    google = async () => {
      throw new SlotlockInsightsError('The Search Console key is not a service account JSON key', 'google_key');
    };
  } else if (options.google) {
    const { property } = options.google;
    const email = account.client_email as string;
    const privateKey = account.private_key as string;
    let signing: Promise<CryptoKey> | null = null;
    let token: { value: string; until: number } | null = null;
    const accessToken = async () => {
      if (token && token.until > now()) return token.value;
      signing ??= globalThis.crypto.subtle.importKey('pkcs8', pkcs8Of(privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
      const seconds = Math.floor(now() / 1000);
      const part = (value: object) => base64url(encoder.encode(JSON.stringify(value)));
      const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
        iss: email,
        scope: 'https://www.googleapis.com/auth/webmasters.readonly',
        aud: 'https://oauth2.googleapis.com/token',
        iat: seconds - 30,
        exp: seconds + 3000,
      })}`;
      const signature = new Uint8Array(await globalThis.crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signing, encoder.encode(unsigned)));
      const body = (await send('google', 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${unsigned}.${base64url(signature)}`,
        }).toString(),
      })) as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== 'string') throw new SlotlockInsightsError('Google gave no access token', 'google_token');
      token = { value: body.access_token, until: now() + Math.max(60, number(body.expires_in) - 120) * 1000 };
      return token.value;
    };
    const site = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}`;
    const query = async (bearer: string, dimensions: string[], rowLimit: number, from: string, to: string) => {
      const body = (await send('google', `${site}/searchAnalytics/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: from, endDate: to, dimensions, rowLimit }),
      })) as { rows?: { keys?: unknown[]; clicks?: unknown; impressions?: unknown; ctr?: unknown; position?: unknown }[] };
      return (body.rows ?? []).map((row) => ({
        key: String(row.keys?.[0] ?? ''),
        clicks: number(row.clicks),
        impressions: number(row.impressions),
        ctr: number(row.ctr),
        position: number(row.position),
      }));
    };
    google = async () => {
      const { from, to } = period();
      // One token for the four reads, asked for before any starts.
      const bearer = await accessToken();
      const [totals, queries, pages, sitemaps] = await Promise.all([
        query(bearer, [], 1, from, to),
        query(bearer, ['query'], 25, from, to),
        query(bearer, ['page'], 200, from, to),
        send('google', `${site}/sitemaps`, { headers: { Authorization: `Bearer ${bearer}` } }).catch(() => ({})),
      ]);
      const listed = ((sitemaps as { sitemap?: unknown[] }).sitemap ?? []) as {
        path?: unknown; lastDownloaded?: unknown; errors?: unknown; warnings?: unknown; contents?: { submitted?: unknown }[];
      }[];
      return {
        from,
        to,
        clicks: totals[0]?.clicks ?? 0,
        impressions: totals[0]?.impressions ?? 0,
        queries: busiest(queries, 25),
        pages: busiest(pages, 200),
        sitemaps: listed.slice(0, 10).map((entry) => ({
          path: String(entry.path ?? ''),
          submitted: (entry.contents ?? []).reduce((sum, item) => sum + number(item.submitted), 0),
          lastDownloaded: typeof entry.lastDownloaded === 'string' ? entry.lastDownloaded : null,
          errors: number(entry.errors),
          warnings: number(entry.warnings),
        })),
        readAt: now(),
      };
    };
  }

  // ---------- Bing Webmaster Tools ----------
  let bing: SlotlockAdminInsights['bing'] = null;
  if (options.bing) {
    const { key, site } = options.bing;
    const method = async (name: 'GetQueryStats' | 'GetPageStats') => {
      const url = `https://ssl.bing.com/webmaster/api.svc/json/${name}?${new URLSearchParams({ siteUrl: site, apikey: key }).toString()}`;
      const body = (await send('bing', url, { headers: { Accept: 'application/json' } })) as { d?: unknown };
      return (Array.isArray(body.d) ? body.d : []) as {
        Query?: unknown; Clicks?: unknown; Impressions?: unknown; AvgImpressionPosition?: unknown; Date?: unknown;
      }[];
    };
    /** Bing's rows are by week: those of the period, summed by query or page. */
    const sum = (rows: Awaited<ReturnType<typeof method>>, since: number) => {
      const by = new Map<string, { clicks: number; impressions: number; weighted: number }>();
      for (const row of rows) {
        const at = /\/Date\((-?\d+)/.exec(String(row.Date ?? ''))?.[1];
        if (at !== undefined && Number(at) < since) continue;
        const keyOf = String(row.Query ?? '');
        if (!keyOf) continue;
        const kept = by.get(keyOf) ?? { clicks: 0, impressions: 0, weighted: 0 };
        const impressions = number(row.Impressions);
        kept.clicks += number(row.Clicks);
        kept.impressions += impressions;
        kept.weighted += number(row.AvgImpressionPosition) * impressions;
        by.set(keyOf, kept);
      }
      return [...by].map(([keyOf, kept]) => ({
        key: keyOf,
        clicks: kept.clicks,
        impressions: kept.impressions,
        ctr: kept.impressions > 0 ? kept.clicks / kept.impressions : 0,
        position: kept.impressions > 0 ? kept.weighted / kept.impressions : 0,
      }));
    };
    bing = async () => {
      const { from, to } = period();
      const since = Date.parse(`${from}T00:00:00Z`) - 7 * DAY_MS;
      const [queries, pages] = await Promise.all([method('GetQueryStats'), method('GetPageStats')]);
      const byQuery = sum(queries, since);
      const byPage = sum(pages, since);
      return {
        from,
        to,
        clicks: byPage.reduce((total, row) => total + row.clicks, 0),
        impressions: byPage.reduce((total, row) => total + row.impressions, 0),
        queries: busiest(byQuery, 25),
        pages: busiest(byPage, 200),
        sitemaps: [],
        readAt: now(),
      };
    };
  }

  // ---------- Cloudflare Web Analytics ----------
  let visits: SlotlockAdminInsights['visits'] = null;
  if (options.cloudflare) {
    const { token, account, siteTag } = options.cloudflare;
    const graphql = async (query: string, variables: Record<string, string>) => {
      const body = (await send('cloudflare', 'https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      })) as { data?: { viewer?: { accounts?: Record<string, unknown>[] } } | null; errors?: unknown[] | null };
      if (body.errors && body.errors.length > 0) throw new SlotlockInsightsError('Cloudflare refused the query', 'cloudflare_query');
      return body.data?.viewer?.accounts?.[0] ?? {};
    };
    const groups = (value: unknown) =>
      (Array.isArray(value) ? value : []) as { count?: unknown; dimensions?: Record<string, unknown> }[];
    visits = async () => {
      const { from, to } = period();
      const variables = { account, site: siteTag, from, to };
      const filter = '{ siteTag: $site, date_geq: $from, date_leq: $to }';
      const head = 'query ($account: string!, $site: string!, $from: Date!, $to: Date!) { viewer { accounts(filter: { accountTag: $account }) {';
      const [main, referred] = await Promise.all([
        graphql(`${head}
          days: rumPageloadEventsAdaptiveGroups(limit: 40, filter: ${filter}, orderBy: [date_ASC]) { count dimensions { date } }
          pages: rumPageloadEventsAdaptiveGroups(limit: 15, filter: ${filter}, orderBy: [count_DESC]) { count dimensions { requestPath } }
        } } }`, variables),
        // Asked apart, so a refusal of this one leaves the rest.
        graphql(`${head}
          referrers: rumPageloadEventsAdaptiveGroups(limit: 15, filter: ${filter}, orderBy: [count_DESC]) { count dimensions { refererHost } }
        } } }`, variables).catch(() => null),
      ]);
      const days = groups(main.days).map((row) => ({ day: String(row.dimensions?.date ?? ''), count: number(row.count) }));
      return {
        from,
        to,
        pageLoads: days.reduce((total, row) => total + row.count, 0),
        days,
        pages: groups(main.pages).map((row) => ({ path: String(row.dimensions?.requestPath ?? ''), count: number(row.count) })),
        referrers: referred
          ? groups(referred.referrers)
              .map((row) => ({ host: String(row.dimensions?.refererHost ?? ''), count: number(row.count) }))
              .filter((row) => row.host !== '')
          : null,
        readAt: now(),
      };
    };
  }

  return { google, bing, visits };
}

/**
 * Pages worth a new title (RFC 0005, Phase 5): seen often in results and rarely clicked, at
 * least `minimum` impressions and a click-through rate under 2%, the most seen first.
 */
export function slotlockLowClickPages(pages: readonly SlotlockSearchRow[], minimum = 100): SlotlockSearchRow[] {
  return pages
    .filter((page) => page.impressions >= minimum && page.ctr < 0.02)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20);
}
