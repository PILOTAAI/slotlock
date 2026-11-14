// Every page of the admin console in a real browser (Chromium, through Playwright), with fixture data
// in real PostgreSQL: at 390, 1440 and 1920 pixels wide, in the dark and the light theme. Each page
// must load under the console's own CSP with nothing refused, render in Inter, scroll no wider than a
// phone's screen, and pass axe-core with no serious or critical violation, and no moderate one about
// landmarks. The screenshots go to
// SLOTLOCK_ADMIN_SHOTS (a temporary directory otherwise), and the owner's review set (Home to the
// staff log at 1440 and 1920, dark, at twice the pixels) beside them as <page>-<width>-dark@2x.png.
//
// Needs DATABASE_URL and Playwright with its Chromium (require('playwright')); skipped without
// either. Playwright is not a dependency of this repository: CI runs this file where it is installed.
import { generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAdmin, createSlotlockAdmin } from '../admin/app.js';
import { createSlotlockStore } from '../store.js';
import { Browser, CONSOLE_KEY, ORIGIN, SoftwarePasskey, createGithubSignInFetch, sha } from './helpers/admin-browser.js';
import { FAKE_APP_ID, FAKE_INSTALLATION, FAKE_REPOSITORY, createFakeGithubRepo } from './helpers/fake-github-repo.js';

const url = process.env.DATABASE_URL?.trim();
const require_ = createRequire(import.meta.url);

// What this file uses of Playwright, so it compiles without Playwright's types.
interface PwRoute {
  request(): { url(): string; method(): string };
  fulfill(response: { status: number; headers: Record<string, string>; body: Buffer }): Promise<void>;
}
interface PwPage {
  route(match: string, handler: (route: PwRoute) => Promise<void>): Promise<void>;
  goto(target: string, options?: { waitUntil?: string }): Promise<unknown>;
  evaluate<T>(script: string | (() => T | Promise<T>)): Promise<T>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  close(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  addInitScript(script: { content: string }): Promise<void>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(options: { viewport: { width: number; height: number }; colorScheme: 'dark' | 'light'; deviceScaleFactor: number; reducedMotion?: 'reduce' }): Promise<PwContext>;
  close(): Promise<void>;
}
let chromium: { launch(): Promise<PwBrowser> } | null = null;
try {
  chromium = (require_('playwright') as { chromium: { launch(): Promise<PwBrowser> } }).chromium;
} catch {
  chromium = null;
}

const SHOTS = process.env.SLOTLOCK_ADMIN_SHOTS?.trim() || join(tmpdir(), 'slotlock-admin-shots');
const SITE = 'https://site.slotlock.test';
const STAFF: Record<string, { id: number; login: string }> = {
  'code-owner': { id: 1001, login: 'mara-okafor' },
  'code-support': { id: 1002, login: 'jonas-berg' },
  'code-billing': { id: 1003, login: 'priya-nair' },
  'code-editor': { id: 1004, login: 'lea-moreau' },
};
const BASE = 720_000_000 + Math.floor(Math.random() * 1_000_000);
const PEOPLE = [
  { id: BASE, login: 'ada-lovelace' },
  { id: BASE + 1, login: 'grace-hopper' },
  { id: BASE + 2, login: 'katherine-j' },
  { id: BASE + 3, login: 'alan-t' },
  { id: BASE + 4, login: 'edsger-d' },
];
const ADA = `github:${BASE}`;
const GRACE = `github:${BASE + 1}`;
const TEAMS = [
  { ref: `team:${randomUUID()}`, handle: `northwind-${BASE}`, name: 'Northwind Rentals' },
  { ref: `team:${randomUUID()}`, handle: `riverside-${BASE}`, name: 'Riverside Clinic' },
  { ref: `team:${randomUUID()}`, handle: `harbour-${BASE}`, name: 'Harbour Yoga Studio' },
];

describe.skipIf(!url || !chromium)('the admin console in a browser: every page, three widths, two themes (real Postgres)', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_visual_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const adminRole = `slotlock_admin_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let root: postgres.Sql;
  let superuser: postgres.Sql;
  let adminSql: postgres.Sql;
  let admin: SlotlockAdmin;
  let browser: PwBrowser | null = null;
  const clock = Date.now();
  const staff = new Browser(() => admin);
  const repo = createFakeGithubRepo({
    'site/content/blog/why-ai-agents-double-book.md': readFileSync('site/content/blog/why-ai-agents-double-book.md', 'utf8'),
    'site/content/blog/holds-keep-a-slot-while-a-person-decides.md': readFileSync('site/content/blog/holds-keep-a-slot-while-a-person-decides.md', 'utf8'),
    'site/content/blog/introducing-slotlock.md': readFileSync('site/content/blog/introducing-slotlock.md', 'utf8'),
    'site/src/data/authors.json': readFileSync('site/src/data/authors.json', 'utf8'),
    'site/public/_redirects': readFileSync('site/public/_redirects', 'utf8'),
  }, { now: () => clock });
  const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const SERVICE_ACCOUNT = JSON.stringify({
    type: 'service_account',
    client_email: 'console@slotlock-test.iam.gserviceaccount.com',
    private_key: google.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  const BING_KEY = 'bingkey0123456789abcdef';
  const day = (back: number) => new Date(clock - back * 86_400_000).toISOString().slice(0, 10);
  /** A gentle weekly wave, so the charts have a shape. */
  const wave = (back: number, scale: number, seed: number) =>
    Math.max(0, Math.round(scale * (1 + 0.35 * Math.sin((back + seed) / 2.2) + 0.2 * Math.cos((back * seed) / 5)) * (1 - back / 400)));

  async function providers(input: string | URL | Request, init?: RequestInit): Promise<Response | null> {
    const target = new URL(String(input instanceof Request ? input.url : input));
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (target.hostname === 'api.github.com' && (/^\/(repos|app)\//.test(target.pathname) || target.pathname === '/graphql')) return repo.fetch(input, init);
    if (target.hostname === 'oauth2.googleapis.com') {
      const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? '';
      const [header, payload, signature] = assertion.split('.');
      const ok = verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.publicKey, Buffer.from(signature ?? '', 'base64url'));
      return ok ? reply({ access_token: 'ya29.fake', expires_in: 3600 }) : reply({ error: 'invalid_grant' }, 400);
    }
    if (target.hostname === 'www.googleapis.com') {
      if (target.pathname.endsWith('/sitemaps')) {
        return reply({ sitemap: [{ path: `${SITE}/sitemap-index.xml`, lastDownloaded: new Date(clock - 86_400_000).toISOString(), errors: '0', warnings: '1', contents: [{ type: 'web', submitted: '188' }] }] });
      }
      const dimensions = (JSON.parse(String(init?.body)) as { dimensions: string[] }).dimensions;
      if (dimensions.length === 0) return reply({ rows: [{ clicks: 1840, impressions: 61200, ctr: 0.03, position: 9.4 }] });
      if (dimensions[0] === 'query') {
        return reply({ rows: [
          ['ai agent calendar', 240, 4800, 6.1], ['booking api', 180, 5200, 8.3], ['prevent double booking', 150, 2100, 4.2],
          ['mcp calendar server', 120, 1900, 5.5], ['postgres exclusion constraint', 96, 3400, 7.9], ['hold a slot api', 64, 900, 3.1],
        ].map(([key, clicks, impressions, position]) => ({ keys: [key], clicks, impressions, ctr: Number(clicks) / Number(impressions), position })) });
      }
      return reply({ rows: [
        [`${SITE}/blog/why-ai-agents-double-book/`, 620, 12100, 5.2], [`${SITE}/`, 410, 9800, 6.0], [`${SITE}/docs/quickstart/`, 220, 6400, 7.1],
        [`${SITE}/pricing/`, 8, 1900, 11.8], [`${SITE}/blog/holds-keep-a-slot-while-a-person-decides/`, 140, 3100, 6.4],
      ].map(([key, clicks, impressions, position]) => ({ keys: [key], clicks, impressions, ctr: Number(clicks) / Number(impressions), position })) });
    }
    if (target.hostname === 'ssl.bing.com') {
      const date = `/Date(${clock - 3 * 86_400_000})/`;
      return reply({ d: target.pathname.endsWith('GetQueryStats')
        ? [{ Query: 'booking api for agents', Clicks: 31, Impressions: 540, AvgImpressionPosition: 7, Date: date }, { Query: 'slotlock', Clicks: 22, Impressions: 120, AvgImpressionPosition: 1.2, Date: date }]
        : [{ Query: `${SITE}/mcp-server/`, Clicks: 18, Impressions: 300, AvgImpressionPosition: 7, Date: date }] });
    }
    if (target.hostname === 'api.cloudflare.com') {
      const query = String((JSON.parse(String(init?.body)) as { query: string }).query);
      if (query.includes('refererHost')) {
        return reply({ data: { viewer: { accounts: [{ referrers: [
          { count: 420, dimensions: { refererHost: 'news.ycombinator.com' } }, { count: 180, dimensions: { refererHost: 'github.com' } },
          { count: 90, dimensions: { refererHost: 'www.google.com' } },
        ] }] } }, errors: null });
      }
      return reply({ data: { viewer: { accounts: [{
        days: Array.from({ length: 28 }, (_, index) => ({ count: wave(27 - index, 900, 3), dimensions: { date: day(27 - index) } })),
        pages: [{ count: 9200, dimensions: { requestPath: '/' } }, { count: 4100, dimensions: { requestPath: '/docs/quickstart/' } }, { count: 2600, dimensions: { requestPath: '/pricing/' } }],
      }] } }, errors: null });
    }
    if (target.hostname === 'api.stripe.com') {
      const month = Math.floor(Date.UTC(new Date(clock).getUTCFullYear(), new Date(clock).getUTCMonth(), 2) / 1000);
      const price = (amount: number, interval: string) => ({ unit_amount: amount, currency: 'eur', recurring: { interval, interval_count: 1, usage_type: 'licensed' } });
      if (target.pathname === '/v1/invoices') {
        return reply({ has_more: false, data: [
          { id: 'in_1Paid', number: 'SL-0042', status: 'paid', amount_due: 4900, amount_paid: 4900, currency: 'eur', created: month },
          { id: 'in_1Open', number: 'SL-0043', status: 'open', amount_due: 4900, amount_paid: 0, currency: 'eur', created: month + 86_400 },
        ] });
      }
      return reply({ has_more: false, data: [
        // Slotlock's, as Checkout tags them: paying, one set to end, one in a trial, one past due, one ended.
        ...Array.from({ length: 14 }, (_, index) => ({ id: `sub_d${index}`, status: 'active', created: month - index * 2_000_000, current_period_end: month + 2_000_000, cancel_at_period_end: index === 3, metadata: { tenant_ref: index === 3 ? (TEAMS[1]?.ref ?? '') : `github:${BASE + 10 + index}` }, items: { data: [{ price: price(1900, 'month'), quantity: 1 }] } })),
        ...Array.from({ length: 5 }, (_, index) => ({ id: `sub_t${index}`, status: index === 4 ? 'past_due' : index === 3 ? 'trialing' : 'active', created: month - index * 3_000_000, current_period_end: month + 2_000_000, metadata: { tenant_ref: `github:${BASE + 30 + index}` }, items: { data: [{ price: price(4900, 'month'), quantity: 1 }] } })),
        { id: 'sub_c1', status: 'canceled', created: 1, canceled_at: month, ended_at: month, metadata: { tenant_ref: `github:${BASE + 40}` }, items: { data: [{ price: price(1900, 'month') }] } },
      ] });
    }
    if (target.hostname === 'api.slotlock.test') return reply({ status: 'ready', version: '0.11.0', checks: ['database'] });
    if (target.hostname === 'dashboard.slotlock.test') return new Response('<!doctype html>', { status: 200 });
    if (target.hostname === 'site.slotlock.test') {
      if (target.pathname === '/sitemap-0.xml') return new Response(`<urlset>${['/', '/pricing/', '/docs/quickstart/', '/mcp-server/', '/docs/security/'].map((path) => `<url><loc>${SITE}${path}</loc></url>`).join('')}</urlset>`);
      if (target.pathname === '/facts.json') return new Response('{}');
      return new Response('<!doctype html>', { status: 200 });
    }
    return null;
  }

  /** A form on a console page, sent as the browser would: its token, and the console's Origin. */
  async function send(path: string, fields: Record<string, string>, from = '/') {
    const page = await (await staff.request(from)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    const response = await staff.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...fields }).toString(),
    });
    expect(response.status, path).toBe(303);
    expect(response.headers.get('location') ?? '', path).not.toContain('error=');
    return response.headers.get('location') ?? '';
  }

  beforeAll(async () => {
    root = postgres(url as string, { max: 1, onnotice: () => undefined });
    await root.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await root.unsafe(`CREATE ROLE ${adminRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await root.unsafe(`CREATE DATABASE ${database}`);
    await root.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    superuser = postgres(target.href, { max: 4, onnotice: () => undefined });
    await superuser.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`);
      const store = createSlotlockStore(tx);
      await store.applySchema();
      await store.applyTenantRls();
      await store.grantAdminRole(adminRole);
      const expires = new Date(clock + 86_400_000);
      await tx`SELECT slotlock.staff_console_key(${sha(CONSOLE_KEY)}, 'cli:ops')`;
      await tx`SELECT slotlock.staff_add('github:1001', 'owner', 'cli:ops', ${sha('owner-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1002', 'support', 'cli:ops', ${sha('support-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1003', 'billing', 'cli:ops', ${sha('billing-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1004', 'editor', 'cli:ops', ${sha('editor-code')}, ${expires})`;
    });
    adminSql = postgres(Object.assign(new URL(target.href), { username: adminRole, password }).href, { max: 4, onnotice: () => undefined });

    // The accounts: five people and three teams, on every plan, one past due, with 90 days of use.
    // People as their provider named them at their last sign-in: most with a name, one with a login only.
    const NAMES = ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson', 'Alan Turing', null];
    for (const [index, person] of PEOPLE.entries()) {
      await superuser`INSERT INTO slotlock.dashboard_people (person_ref, created_at, name, display) VALUES (${`github:${person.id}`}, ${new Date(clock - (index * 9 + 2) * 86_400_000)}, ${NAMES[index] ?? null}, ${`@${person.login}`})`;
    }
    for (const [index, team] of TEAMS.entries()) {
      await superuser`INSERT INTO slotlock.workspaces (tenant_ref, handle, name, created_by, created_at) VALUES (${team.ref}, ${team.handle}, ${team.name}, ${ADA}, ${new Date(clock - (index * 13 + 5) * 86_400_000)})`;
    }
    const plans: [string, string, string, string | null][] = [
      [ADA, 'developer', 'active', 'cus_AdaLovelace01'], [GRACE, 'team', 'active', 'cus_GraceHopper02'], [`github:${BASE + 2}`, 'developer', 'past_due', 'cus_Katherine03'],
      [TEAMS[0]?.ref ?? '', 'team', 'active', 'cus_Northwind04'], [TEAMS[1]?.ref ?? '', 'developer', 'active', 'cus_Riverside05'],
    ];
    for (const [ref, plan, status, customer] of plans) {
      // Riverside Clinic's Developer plan is set to end at its period's end.
      await superuser`
        INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints, stripe_customer, stripe_subscription, current_period_end)
        VALUES (${ref}, ${plan}, ${status}, ${plan === 'team' ? 500 : 100}, ${plan === 'team' ? 50 : 10}, ${plan === 'team' ? 25 : 10}, ${customer}, ${customer ? `sub_${customer.slice(4)}` : null}, ${new Date(clock + 20 * 86_400_000)})`;
      if (ref === TEAMS[1]?.ref) await superuser`UPDATE slotlock.tenant_plans SET ends_at = ${new Date(clock + 20 * 86_400_000)} WHERE tenant_ref = ${ref}`;
    }
    const usage: { tenant: string; day: string; metric: string; origin: string; count: number }[] = [];
    const users = [[ADA, 1400], [GRACE, 2600], [`github:${BASE + 2}`, 300], [TEAMS[0]?.ref ?? '', 4200], [TEAMS[1]?.ref ?? '', 800]] as const;
    for (let back = 0; back < 95; back += 1) {
      users.forEach(([tenant, scale], seed) => {
        for (const [origin, share] of [['mcp', 0.5], ['rest', 0.3], ['dashboard', 0.12], ['application', 0.08]] as const) {
          const operations = wave(back, scale * share, seed + 1);
          usage.push({ tenant, day: day(back), metric: 'operations', origin, count: operations });
          usage.push({ tenant, day: day(back), metric: 'bookings', origin, count: Math.round(operations / 18) });
          usage.push({ tenant, day: day(back), metric: 'holds', origin, count: Math.round(operations / 30) });
          usage.push({ tenant, day: day(back), metric: 'webhook_deliveries', origin, count: Math.round(operations / 9) });
        }
      });
    }
    const counted = usage.filter((row) => row.count > 0);
    await superuser`
      INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, origin, count)
      SELECT * FROM unnest(${counted.map((row) => row.tenant)}::text[], ${counted.map((row) => row.day)}::date[], ${counted.map((row) => row.metric)}::text[], ${counted.map((row) => row.origin)}::text[], ${counted.map((row) => row.count)}::bigint[])`;
    for (const [name, prefix, scopes, used] of [['booking-agent', 'slk_AbCd1234', ['read', 'write'], 2], ['reporting', 'slk_EfGh5678', ['read'], 30], ['old-zapier', 'slk_IjKl9012', ['read', 'write'], null]] as const) {
      await superuser`
        INSERT INTO slotlock.api_keys (tenant_ref, name, prefix, secret_hash, scopes, last_used_at, revoked_at)
        VALUES (${ADA}, ${name}, ${prefix}, ${sha(`${name}-secret`)}, ${scopes as unknown as string[]}, ${used === null ? null : new Date(clock - used * 3_600_000)}, ${used === null ? new Date(clock - 5 * 86_400_000) : null})`;
    }
    for (const _ of [0, 1]) {
      await superuser`SELECT slotlock.dashboard_session_started(${ADA}, ${randomBytes(32)}, ${new Date(clock + 3_600_000 * 8)}, 'Firefox', '192.0.2.1')`;
    }
    await superuser`
      INSERT INTO slotlock.billing_alerts (kind, tenant_ref, stripe_ref, detail)
      VALUES ('payment_failed', ${`github:${BASE + 2}`}, 'in_1FailedA', '{"amount_due": 1900, "currency": "eur", "attempt_count": 2}'::jsonb),
             ('duplicate_subscription', ${GRACE}, 'sub_1Second', '{"first": "sub_GraceHopper02"}'::jsonb),
             ('refunded_plan_active', ${ADA}, 'ch_1PartRefund', '{"amount": 1900, "amount_refunded": 500, "currency": "eur", "refunded": false}'::jsonb)`;
    for (let hour = 7; hour >= 0; hour -= 1) {
      const finished = new Date(clock - hour * 3_600_000);
      await superuser`
        INSERT INTO slotlock.maintenance_runs (job, actor, started_at, finished_at, attention, summary)
        VALUES ('maintenance', 'serve', ${new Date(finished.getTime() - 40_000)}, ${finished}, ${hour === 2}, ${superuser.json({ passes: 8, failed: hour === 2 ? 1 : 0, extended: 3 + hour, pruned: 12, noShows: 1, approvalsExpired: 0 })})`;
    }
    await superuser`
      INSERT INTO slotlock.maintenance_runs (job, actor, started_at, finished_at, attention, summary)
      VALUES ('billing_daily', 'cli:ops', ${new Date(clock - 7_200_000)}, ${new Date(clock - 7_100_000)}, false, ${superuser.json({ lines: ['partner months closed: 0', 'overage reported: 2'] })})`;
    await superuser`
      INSERT INTO slotlock.maintenance_failures (tenant_ref, first_failed_at, last_failed_at, failures, error, code, message)
      VALUES (${TEAMS[1]?.ref ?? ''}, ${new Date(clock - 5 * 3_600_000)}, ${new Date(clock - 3_600_000)}, 4, 'Error', 'XX000', 'Could not extend the recurring series')`;
    // The status page's incident, and the deploy workflows' last runs on main.
    repo.openIssue('Slow bookings in Europe', ['status']);
    const run = (name: string, id: number, conclusion: string | null) => ({
      id, name, status: conclusion === null ? 'in_progress' : 'completed', conclusion, event: 'push',
      head_sha: `${id}`.padEnd(40, 'a'), html_url: `https://github.com/${FAKE_REPOSITORY}/actions/runs/${id}`, created_at: new Date(clock - id * 60_000).toISOString(),
    });
    repo.runs.set('site.yml', [run('Site', 11, 'success'), run('Site', 12, 'success'), run('Site', 13, 'failure')]);
    repo.runs.set('dashboard.yml', [run('Dashboard', 21, null), run('Dashboard', 22, 'success')]);
    repo.runs.set('image.yml', [run('Image', 31, 'success')]);
    repo.runs.set('release.yml', [run('Release', 41, 'success')]);

    const profiles = Object.fromEntries(PEOPLE.map((person) => [person.login, { ...person, type: 'User' }]));
    admin = createSlotlockAdmin({
      sql: () => adminSql,
      publicUrl: ORIGIN,
      sessionSecret: 'a-test-session-secret-of-forty-characters', consoleKey: CONSOLE_KEY,
      github: { clientId: 'client-id', clientSecret: 'client-secret' },
      access: { verify: async (request: Request) => (request.headers.get('cf-access-jwt-assertion') === 'ok' ? { email: 'staff@example.com', sub: 'sub-1' } : null) },
      fetch: createGithubSignInFetch(STAFF, profiles, providers),
      now: () => clock,
      stripeKey: 'rk_test_admin',
      cms: { appId: FAKE_APP_ID, installationId: FAKE_INSTALLATION, privateKey: repo.privateKey, repository: FAKE_REPOSITORY, siteUrl: SITE, previewHost: 'slotlock-site-preview.example.workers.dev' },
      insights: {
        google: { serviceAccount: SERVICE_ACCOUNT, property: 'sc-domain:slotlock.pylota.io' },
        bing: { key: BING_KEY, site: `${SITE}/` },
        cloudflare: { token: 'cf-token', account: 'a'.repeat(32), siteTag: 'b'.repeat(32) },
      },
      hosts: { api: 'https://api.slotlock.test/healthz', dashboard: 'https://dashboard.slotlock.test/dashboard' },
    });
    // The other staff sign in once, so the staff list has passkeys and last-seen times.
    for (const [code, enrollment] of [['code-support', 'support-code'], ['code-billing', 'billing-code']] as const) {
      const other = new Browser(() => admin);
      await other.signIn(code);
      await other.createPasskey(new SoftwarePasskey(), { code: enrollment });
    }
    expect((await staff.signIn('code-owner')).headers.get('location')).toBe('/passkey');
    expect((await staff.createPasskey(new SoftwarePasskey(), { code: 'owner-code' })).status).toBe(200);

    // What staff did, through the console's own forms: a note, a case, a privacy request, an override,
    // announcements, a feature flag, a suspension and a draft post.
    const adaPath = `/accounts/${encodeURIComponent(ADA)}`;
    await send(`${adaPath}/notes`, { note: 'Called about moving to Team in December. Wants SSO first.' }, adaPath);
    await send('/cases', { account: `github:${BASE + 3}`, source: 'report', summary: 'Card testing through the booking API', section: '2.3 Fraud', evidence: 'Report from a card issuer.\nRequest ids: 7f3a, 81c2, 9d04.' }, '/cases');
    await send('/cases', { account: '', source: 'staff', summary: 'Spam bookings from one IP range', section: '', evidence: '' }, '/cases');
    await send('/privacy', { account: ADA, kind: 'access', concerns: 'account', received: day(24), reference: 'Privacy thread 2026-10-21' }, '/privacy');
    await send('/privacy', { account: GRACE, kind: 'erasure', concerns: 'account', received: day(3), reference: 'Privacy thread 2026-11-11' }, '/privacy');
    await send(`/accounts/${encodeURIComponent(TEAMS[1]?.ref ?? '')}/overrides`, { back: `/accounts/${encodeURIComponent(TEAMS[1]?.ref ?? '')}`, kind: 'plan', plan: 'team', ends: day(-30), reason: 'Pilot for the Team plan' }, `/accounts/${encodeURIComponent(TEAMS[1]?.ref ?? '')}`);
    const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16);
    await send('/communications', { audience: 'everyone', kind: 'maintenance', plan: '', account: '', message: 'Database maintenance on Sunday from 02:00 to 02:30 UTC: writes may pause for a minute.', link: 'https://status.slotlock.test/', starts: '', ends: minute(clock + 3 * 86_400_000) }, '/communications');
    await send('/communications', { audience: 'plan', kind: 'change', plan: 'team', account: '', message: 'SSO for Team workspaces arrives on 1 December.', link: '', starts: minute(clock + 2 * 86_400_000), ends: minute(clock + 20 * 86_400_000) }, '/communications');
    await send('/system/flags', { flag: 'assistant', plan: 'free', account: '', enabled: '0', reason: 'Assistant paused on Free while we review costs' }, '/system');
    await send(`/accounts/${encodeURIComponent(`github:${BASE + 3}`)}/suspend`, { reason: 'Card testing reported to abuse@', message: 'Write to abuse@pylota.io to discuss this.', case: '1' }, `/accounts/${encodeURIComponent(`github:${BASE + 3}`)}`);
    const editorPage = await (await staff.request('/content/new')).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(editorPage)?.[1] ?? '';
    const saved = await staff.request('/content/new', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrf, head: '', slug: 'booking-rules-for-agents', intent: 'save', title: 'Booking rules your agent can read before it books',
        seoTitle: '', description: 'Lead time, buffers and daily caps as data an agent reads first, so it proposes only slots the business would accept.',
        date: day(0), updated: '', publishAt: '', author: Object.keys(JSON.parse(readFileSync('site/src/data/authors.json', 'utf8')) as Record<string, unknown>)[0] ?? '',
        tags: 'agents, booking rules', eyebrow: 'Guide', imageAlt: 'A calendar with buffers drawn around each booking', related: 'Booking rules | /docs/booking-rules/',
        body: '## Rules an agent can read\n\nAn agent that books on its own needs the rules before it proposes a time: lead time, buffers and caps.\n\n- **Lead time**: how soon a booking may start.\n- **Buffers**: the gap kept around each booking.\n\n```json\n{ "leadTimeMinutes": 120, "bufferMinutes": 15 }\n```\n',
      }).toString(),
    });
    expect(saved.status).toBe(303);

    mkdirSync(SHOTS, { recursive: true });
    try {
      browser = await (chromium as { launch(): Promise<PwBrowser> }).launch();
    } catch (error) {
      console.warn('Chromium did not start; the browser checks are skipped:', (error as Error).message);
      browser = null;
    }
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await adminSql?.end({ timeout: 5 });
    await superuser?.end();
    await root?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [adminRole, owner]) await root?.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await root?.end();
  });

  /** A page that answers every request from the console, with the signed-in member's cookies. */
  async function open(width: number, theme: 'dark' | 'light', scale: number, as: Browser = staff) {
    const context = await (browser as PwBrowser).newContext({ viewport: { width, height: width >= 1920 ? 1080 : width >= 1440 ? 900 : 844 }, colorScheme: theme, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    // Before any of the page's own scripts: count what the CSP refuses.
    await context.addInitScript({ content: "window.__refused = []; document.addEventListener('securitypolicyviolation', (event) => window.__refused.push(event.violatedDirective + ' ' + event.blockedURI));" });
    const tab = await context.newPage();
    await tab.route('**/*', async (route) => {
      const asked = new URL(route.request().url());
      if (asked.origin !== ORIGIN) {
        await route.fulfill({ status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('') });
        return;
      }
      const response = await as.request(`${asked.pathname}${asked.search}`, { method: route.request().method() });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') headers[name] = value;
      });
      await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
    });
    return { context, tab };
  }

  const AXE = chromium ? readFileSync(require_.resolve('axe-core/axe.min.js'), 'utf8') : '';
  type Check = { violations: { id: string; impact: string | null; nodes: { target: string[] }[] }[]; refused: string[]; overflow: number; inter: boolean; chartGap: number | null };
  async function check(tab: PwPage): Promise<Check> {
    await tab.evaluate(AXE);
    // In the page, as a string: this repository compiles without the DOM's types.
    const result = await tab.evaluate<Check>(`(async () => {
      const axe = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
      return {
        violations: axe.violations.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.slice(0, 3).map((node) => ({ target: node.target })) })),
        refused: window.__refused,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        inter: document.fonts.check('13px Inter'),
        // Home's New accounts chart, and the space before the figures under it.
        chartGap: (() => {
          const chart = document.querySelector('[aria-labelledby="new-title"] svg.spark');
          const below = chart && chart.closest('section').querySelector('.kv');
          return chart && below ? below.getBoundingClientRect().top - chart.getBoundingClientRect().bottom : null;
        })(),
      };
    })()`);
    return result as Check;
  }

  const ada = `/accounts/${encodeURIComponent(ADA)}`;
  const PAGES: { name: string; path: string; review?: boolean }[] = [
    { name: 'home', path: '/', review: true },
    { name: 'accounts', path: '/accounts', review: true },
    { name: 'account', path: ada, review: true },
    { name: 'account-keys', path: `${ada}#keys` },
    { name: 'billing', path: '/billing', review: true },
    { name: 'billing-alerts', path: '/billing#alerts' },
    { name: 'usage', path: '/usage', review: true },
    { name: 'cases', path: '/cases' },
    { name: 'case', path: '/cases/1' },
    { name: 'privacy', path: '/privacy' },
    { name: 'privacy-request', path: '/privacy/1' },
    { name: 'content', path: '/content', review: true },
    { name: 'post', path: '/content/booking-rules-for-agents' },
    { name: 'site', path: '/site' },
    { name: 'communications', path: '/communications', review: true },
    { name: 'status-page', path: '/communications#status' },
    { name: 'system', path: '/system', review: true },
    { name: 'flag-drawer', path: '/system?panel=flag#flags' },
    { name: 'staff', path: '/staff', review: true },
    { name: 'staff-log', path: '/staff/log', review: true },
    { name: 'staff-log-entry', path: '/staff/log?entry=1' },
    { name: 'not-found', path: '/nowhere' },
  ];

  /**
   * The axe findings that fail the run: any serious or critical one, and a moderate one about
   * landmarks (two banners, or two regions of one kind with no name to tell them apart), which a
   * screen reader's list of landmarks would show.
   */
  const counts = (violation: Check['violations'][number]) =>
    violation.impact === 'serious' || violation.impact === 'critical' || (violation.impact === 'moderate' && /^landmark-/.test(violation.id));

  it('renders every page under the CSP, in Inter, without a serious, critical or landmark axe violation or a sideways scroll', async (context) => {
    if (!browser) context.skip();
    const problems: string[] = [];
    for (const width of [390, 1440, 1920]) {
      for (const theme of ['dark', 'light'] as const) {
        const { context: browserContext, tab } = await open(width, theme, 1);
        for (const item of PAGES) {
          await tab.goto(`${ORIGIN}${item.path}`, { waitUntil: 'load' });
          await tab.evaluate('document.fonts.ready.then(() => true)');
          const found = await check(tab);
          const where = `${item.name} at ${width} ${theme}`;
          for (const violation of found.violations.filter(counts)) {
            problems.push(`${where}: ${violation.id} (${violation.impact}) ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
          }
          if (found.refused.length) problems.push(`${where}: the CSP refused ${found.refused.join(', ')}`);
          if (found.overflow > 0) problems.push(`${where}: ${found.overflow}px wider than the screen`);
          if (!found.inter) problems.push(`${where}: Inter did not load`);
          if (found.chartGap !== null && found.chartGap < 12) problems.push(`${where}: the New accounts chart is ${found.chartGap}px from the figures under it`);
          await tab.screenshot({ path: join(SHOTS, 'all', `${item.name}-${width}-${theme}.png`), fullPage: width < 760 });
        }
        await browserContext.close();
      }
    }
    // The sign-in page, before any session.
    const { context: signedOut, tab } = await open(390, 'dark', 1, new Browser(() => admin));
    await tab.goto(`${ORIGIN}/sign-in`, { waitUntil: 'load' });
    const signIn = await check(tab);
    for (const violation of signIn.violations.filter(counts)) problems.push(`sign-in: ${violation.id}`);
    await tab.screenshot({ path: join(SHOTS, 'all', 'sign-in-390-dark.png') });
    await signedOut.close();
    expect(problems).toEqual([]);
  }, 900_000);

  it('saves the owner’s review set: ten pages at 1440 and 1920 wide, dark, at twice the pixels', async (context) => {
    if (!browser) context.skip();
    for (const width of [1440, 1920]) {
      const { context: browserContext, tab } = await open(width, 'dark', 2);
      for (const item of PAGES.filter((entry) => entry.review)) {
        await tab.goto(`${ORIGIN}${item.path}`, { waitUntil: 'load' });
        await tab.evaluate('document.fonts.ready.then(() => true)');
        await tab.screenshot({ path: join(SHOTS, `${item.name}-${width}-dark@2x.png`) });
      }
      await browserContext.close();
    }
  }, 300_000);
});
