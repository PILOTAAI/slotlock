// Phase 6 of the admin console (RFC 0006, M9 to M11) end to end against real PostgreSQL: an
// announcement scheduled in the console shows on the customer's dashboard from its start until it is
// ended, a service notice reaches one account and its audit log, a maintenance failure appears on
// Home and the System page and clears when a pass runs, feature flags turn the assistant and team
// creation off for an account or a plan, incidents open, update and close on the status page (and no
// other issue is touched), and the Site page reads Search Console, Bing and Cloudflare once an hour.
// The roles hold in the database. Needs a role that creates databases and roles; skipped without
// DATABASE_URL.
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAdmin, createSlotlockAdmin } from '../admin/app.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { createSlotlockDashboard, createSlotlockDashboardResources, createSlotlockDashboardState } from '../dashboard.js';
import { createSlotlockMaintenanceRecord, startSlotlockMaintenance } from '../maintenance.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { createSlotlockDashboardWorkspaces } from '../workspaces.js';
import { Browser, ORIGIN, SoftwarePasskey, createGithubSignInFetch, sha } from './helpers/admin-browser.js';
import { FAKE_APP_ID, FAKE_INSTALLATION, FAKE_REPOSITORY, createFakeGithubRepo } from './helpers/fake-github-repo.js';

const url = process.env.DATABASE_URL?.trim();
const STAFF: Record<string, { id: number; login: string }> = {
  'code-owner': { id: 1001, login: 'octo-owner' },
  'code-support': { id: 1002, login: 'octo-support' },
  'code-billing': { id: 1003, login: 'octo-billing' },
  'code-editor': { id: 1004, login: 'octo-editor' },
};
const DASHBOARD = 'https://dashboard.slotlock.test';
const SITE = 'https://site.slotlock.test';
const BASE = 610_000_000 + Math.floor(Math.random() * 1_000_000);
/** The customers, by the code their GitHub sign-in returns with: Ada on Developer, Bea on Team. */
const CUSTOMERS = new Map([
  ['ada', { id: BASE, login: 'ada' }],
  ['bea', { id: BASE + 1, login: 'bea' }],
]);
const ADA = `github:${BASE}`;
const BEA = `github:${BASE + 1}`;

/** A customer's browser on the dashboard: cookies kept, forms sent with their token and Origin. */
class Customer {
  readonly cookies = new Map<string, string>();
  constructor(private readonly dashboard: () => ReturnType<typeof createSlotlockDashboard>) {}
  private keep(response: Response) {
    for (const set of response.headers.getSetCookie()) {
      const [pair, ...attributes] = set.split('; ');
      const [name, value] = (pair as string).split(/=(.*)/s) as [string, string];
      if (attributes.includes('Max-Age=0') || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
  private header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  async get(path: string) {
    return this.keep(await this.dashboard().fetch(new Request(`${DASHBOARD}${path}`, { headers: { cookie: this.header() } })));
  }
  async page(path: string) {
    return (await this.get(path)).text();
  }
  async post(page: string, action: string, fields: Record<string, string>) {
    const fromPage = await this.page(page);
    const at = fromPage.indexOf(`action="/dashboard${action}"`);
    expect(at, `the form ${action} on ${page}`).toBeGreaterThan(-1);
    const rest = fromPage.slice(at, fromPage.indexOf('</form>', at));
    const once = /name="once" value="([^"]+)"/.exec(rest)?.[1];
    const sent = new URLSearchParams({ csrf: /name="csrf" value="([^"]+)"/.exec(rest)?.[1] as string, ...(once ? { once } : {}), ...fields });
    return this.keep(await this.dashboard().fetch(new Request(`${DASHBOARD}/dashboard${action}`, {
      method: 'POST',
      headers: { cookie: this.header(), origin: DASHBOARD, 'content-type': 'application/x-www-form-urlencoded' },
      body: sent.toString(),
    })));
  }
  async signIn(code: string) {
    const start = await this.get('/dashboard/sign-in');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    expect((await this.get(`/dashboard/callback?code=${code}&state=${state}`)).status).toBe(303);
  }
}

describe.skipIf(!url)('site, communications and system in the admin console (real Postgres)', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_system_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const adminRole = `slotlock_admin_${suffix}`;
  const appRole = `slotlock_app_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let root: postgres.Sql;
  let superuser: postgres.Sql;
  let adminSql: postgres.Sql;
  let application: postgres.Sql;
  let admin: SlotlockAdmin;
  let bare: SlotlockAdmin;
  let store: SlotlockStore;
  let dashboard: ReturnType<typeof createSlotlockDashboard>;
  const clock = Date.now();
  const staff: Record<'owner' | 'support' | 'billing' | 'editor', Browser> = {} as never;
  const customers: Record<'ada' | 'bea', Customer> = {} as never;
  const repo = createFakeGithubRepo({ 'README.md': '# Slotlock\n' }, { now: () => clock });
  const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const SERVICE_ACCOUNT = JSON.stringify({
    type: 'service_account',
    client_email: 'console@slotlock-test.iam.gserviceaccount.com',
    private_key: google.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  const BING_KEY = 'bingkey0123456789abcdef';
  /** Every request the console made to a provider, "host path". */
  const providerCalls: string[] = [];

  /** Search Console, Bing, Cloudflare and the hosts, as the console reaches them. */
  async function providers(input: string | URL | Request, init?: RequestInit): Promise<Response | null> {
    const target = new URL(String(input instanceof Request ? input.url : input));
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (target.hostname === 'api.github.com' && /^\/(repos|app)\//.test(target.pathname)) return repo.fetch(input, init);
    if (target.hostname === 'oauth2.googleapis.com') {
      providerCalls.push(`${target.hostname}${target.pathname}`);
      const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? '';
      const [header, payload, signature] = assertion.split('.');
      const ok = verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.publicKey, Buffer.from(signature ?? '', 'base64url'));
      const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as { scope?: string; iss?: string };
      if (!ok || claims.scope !== 'https://www.googleapis.com/auth/webmasters.readonly' || claims.iss !== 'console@slotlock-test.iam.gserviceaccount.com') {
        return reply({ error: 'invalid_grant' }, 400);
      }
      return reply({ access_token: 'ya29.fake', expires_in: 3600 });
    }
    if (target.hostname === 'www.googleapis.com') {
      providerCalls.push(`${target.hostname}${target.pathname}`);
      if (new Headers(init?.headers).get('authorization') !== 'Bearer ya29.fake') return reply({ error: 'unauthorized' }, 401);
      expect(target.pathname.startsWith(`/webmasters/v3/sites/${encodeURIComponent('sc-domain:slotlock.pylota.io')}/`)).toBe(true);
      if (target.pathname.endsWith('/sitemaps')) {
        return reply({ sitemap: [{ path: `${SITE}/sitemap-index.xml`, lastDownloaded: '2026-11-10T08:00:00Z', errors: '0', warnings: '1', contents: [{ type: 'web', submitted: '188' }] }] });
      }
      const dimensions = (JSON.parse(String(init?.body)) as { dimensions: string[] }).dimensions;
      if (dimensions.length === 0) return reply({ rows: [{ clicks: 120, impressions: 4000, ctr: 0.03, position: 9.4 }] });
      if (dimensions[0] === 'query') return reply({ rows: [{ keys: ['ai agent calendar'], clicks: 40, impressions: 800, ctr: 0.05, position: 6.1 }] });
      return reply({ rows: [
        { keys: [`${SITE}/blog/why-ai-agents-double-book/`], clicks: 30, impressions: 600, ctr: 0.05, position: 5.2 },
        { keys: [`${SITE}/pricing/`], clicks: 4, impressions: 900, ctr: 0.0044, position: 11.8 },
      ] });
    }
    if (target.hostname === 'ssl.bing.com') {
      providerCalls.push(`${target.hostname}${target.pathname}`);
      if (target.searchParams.get('apikey') !== BING_KEY) return reply({ Message: 'bad key' }, 401);
      const date = `/Date(${clock - 3 * 86_400_000})/`;
      return reply({ d: target.pathname.endsWith('GetQueryStats')
        ? [{ Query: 'booking api for agents', Clicks: 3, Impressions: 50, AvgImpressionPosition: 7, Date: date }]
        : [{ Query: `${SITE}/mcp-server/`, Clicks: 3, Impressions: 50, AvgImpressionPosition: 7, Date: date }] });
    }
    if (target.hostname === 'api.cloudflare.com') {
      providerCalls.push(`${target.hostname}${target.pathname}`);
      const query = String((JSON.parse(String(init?.body)) as { query: string }).query);
      // Referrers refused, as an unknown field would be: the rest of the page still shows.
      if (query.includes('refererHost')) return reply({ data: null, errors: [{ message: 'unknown field refererHost' }] });
      return reply({ data: { viewer: { accounts: [{
        days: [{ count: 70, dimensions: { date: new Date(clock).toISOString().slice(0, 10) } }],
        pages: [{ count: 50, dimensions: { requestPath: '/' } }, { count: 20, dimensions: { requestPath: '/pricing/' } }],
      }] } }, errors: null });
    }
    if (target.hostname === 'api.slotlock.test') return reply({ status: 'ready', version: '0.10.0', checks: ['database'] });
    if (target.hostname === 'dashboard.slotlock.test') return new Response('down', { status: 503 });
    if (target.hostname === 'site.slotlock.test') return new Response('<!doctype html>', { status: 200 });
    return null;
  }

  async function signedIn(code: string, enrollment: string) {
    const browser = new Browser(() => admin);
    expect((await browser.signIn(code)).headers.get('location')).toBe('/passkey');
    expect((await browser.createPasskey(new SoftwarePasskey(), { code: enrollment })).status).toBe(200);
    return browser;
  }
  async function form(browser: Browser, path: string, fields: Record<string, string>, from: string) {
    const page = await (await browser.request(from)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    return browser.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, ...fields }).toString(),
    });
  }
  const text = async (browser: Browser, path: string) => (await browser.request(path)).text();
  const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16);
  const staffLog = async (action: string) =>
    superuser<{ staff_ref: string; account_ref: string | null; target: string | null; reason: string | null; metadata: Record<string, unknown> }[]>`
      SELECT staff_ref, account_ref, target, reason, metadata FROM slotlock.staff_audit_events WHERE action = ${action} ORDER BY chain_index`;

  beforeAll(async () => {
    root = postgres(url as string, { max: 1, onnotice: () => undefined });
    await root.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await root.unsafe(`CREATE ROLE ${adminRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await root.unsafe(`CREATE ROLE ${appRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await root.unsafe(`CREATE DATABASE ${database}`);
    await root.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    superuser = postgres(target.href, { max: 4, onnotice: () => undefined });
    await superuser.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`);
      const ownerStore = createSlotlockStore(tx);
      await ownerStore.applySchema();
      await ownerStore.applyTenantRls();
      await ownerStore.grantAdminRole(adminRole);
      await ownerStore.grantApplicationRole(appRole);
      const expires = new Date(Date.now() + 86_400_000);
      await tx`SELECT slotlock.staff_add('github:1001', 'owner', 'cli:ops', ${sha('owner-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1002', 'support', 'cli:ops', ${sha('support-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1003', 'billing', 'cli:ops', ${sha('billing-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1004', 'editor', 'cli:ops', ${sha('editor-code')}, ${expires})`;
    });
    const as = (role: string) => Object.assign(new URL(target.href), { username: role, password }).href;
    adminSql = postgres(as(adminRole), { max: 4, onnotice: () => undefined });
    application = postgres(as(appRole), { max: 6, onnotice: () => undefined });
    store = createSlotlockStore(application);

    // The customers' plans: Ada pays for Developer, Bea for Team.
    for (const [person, plan] of [[ADA, 'developer'], [BEA, 'team']] as const) {
      await superuser`
        INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints)
        VALUES (${person}, ${plan}, 'active', 100, 100, 10)`;
    }
    // The status page holds the probe's incident, and the repository an issue that is not one; the
    // deploy workflows have run on main.
    repo.openIssue('Hosted Slotlock API is down', ['status']);
    repo.openIssue('The docs search misses a page', ['bug']);
    const run = (name: string, id: number, conclusion: string | null) => ({
      id, name, status: conclusion === null ? 'in_progress' : 'completed', conclusion, event: 'push',
      head_sha: 'a'.repeat(40), html_url: `https://github.com/${FAKE_REPOSITORY}/actions/runs/${id}`, created_at: new Date(clock - id * 60_000).toISOString(),
    });
    repo.runs.set('site.yml', [run('Site', 11, 'success'), run('Site', 12, 'failure')]);
    repo.runs.set('dashboard.yml', [run('Dashboard', 21, null)]);
    repo.runs.set('image.yml', [run('Image', 31, 'success')]);
    repo.runs.set('release.yml', []);

    const options = {
      sql: () => adminSql,
      publicUrl: ORIGIN,
      sessionSecret: 'a-test-session-secret-of-forty-characters',
      github: { clientId: 'client-id', clientSecret: 'client-secret' },
      access: { verify: async (request: Request) => (request.headers.get('cf-access-jwt-assertion') === 'ok' ? { email: 'staff@example.com', sub: 'sub-1' } : null) },
      fetch: createGithubSignInFetch(STAFF, {}, providers),
      now: () => clock,
    };
    admin = createSlotlockAdmin({
      ...options,
      cms: { appId: FAKE_APP_ID, installationId: FAKE_INSTALLATION, privateKey: repo.privateKey, repository: FAKE_REPOSITORY, siteUrl: SITE },
      insights: {
        google: { serviceAccount: SERVICE_ACCOUNT, property: 'sc-domain:slotlock.pylota.io' },
        bing: { key: BING_KEY, site: `${SITE}/` },
        cloudflare: { token: 'cf-token', account: 'a'.repeat(32), siteTag: 'b'.repeat(32) },
      },
      hosts: { api: 'https://api.slotlock.test/healthz', dashboard: 'https://dashboard.slotlock.test/dashboard' },
    });
    // The same console with no provider and no GitHub App: each part says what to set.
    bare = createSlotlockAdmin(options);
    staff.owner = await signedIn('code-owner', 'owner-code');
    staff.support = await signedIn('code-support', 'support-code');
    staff.billing = await signedIn('code-billing', 'billing-code');
    staff.editor = await signedIn('code-editor', 'editor-code');

    // The customers' dashboard, with the assistant and team workspaces on, as Slotlock Cloud runs it.
    dashboard = createSlotlockDashboard({
      publicUrl: DASHBOARD,
      github: { clientId: 'Ov23liSystem', clientSecret: 'f'.repeat(40) },
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: '*',
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store),
      state: createSlotlockDashboardState(application),
      workspaces: createSlotlockDashboardWorkspaces(application),
      teamWorkspaces: true,
      assistant: {
        secret: randomBytes(32).toString('hex'),
        rate: { perSecond: 100, burst: 100 },
        backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] }),
      },
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        const target = String(input);
        if (target.endsWith('/access_token')) return Response.json({ access_token: `gho_${new URLSearchParams(String(init.body)).get('code')}` });
        const who = CUSTOMERS.get(String(new Headers(init.headers).get('authorization')).replace('Bearer gho_', ''));
        return who ? Response.json(who) : new Response('no', { status: 401 });
      }) as typeof fetch,
    });
    customers.ada = new Customer(() => dashboard);
    customers.bea = new Customer(() => dashboard);
    await customers.ada.signIn('ada');
    await customers.bea.signIn('bea');
  });

  afterAll(async () => {
    await application?.end({ timeout: 5 });
    await adminSql?.end({ timeout: 5 });
    await superuser?.end();
    await root?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [adminRole, appRole, owner]) await root?.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await root?.end();
  });

  it('gives the Owner every Phase 6 page, Support the System and Communications pages to read, the Editor the Site page, and Billing none', async () => {
    const home = await text(staff.owner, '/');
    for (const link of ['href="/site"', 'href="/communications"', 'href="/system"']) expect(home).toContain(link);
    for (const path of ['/site', '/communications', '/system']) {
      expect((await staff.owner.request(path)).status, path).toBe(200);
      expect((await staff.billing.request(path)).status, path).toBe(403);
    }
    expect((await staff.support.request('/system')).status).toBe(200);
    const supportComms = await text(staff.support, '/communications');
    expect(supportComms).toContain('Hosted Slotlock API is down');
    expect(supportComms).not.toContain('Write an announcement');
    expect(supportComms).not.toContain('action="/communications/status/update"');
    expect(await text(staff.support, '/system')).not.toContain('action="/system/flags"');
    expect((await staff.support.request('/site')).status).toBe(403);
    expect((await staff.editor.request('/site')).status).toBe(200);
    expect((await staff.editor.request('/system')).status).toBe(403);
    // The database holds the same lines, whatever the console does.
    const tomorrow = new Date(Date.now() + 86_400_000);
    await expect(adminSql`SELECT slotlock.admin_announce('github:1002', 'everyone', NULL, NULL, 'notice', 'Hello', NULL, NULL, ${tomorrow})`).rejects.toMatchObject({ code: '42501' });
    await expect(adminSql`SELECT slotlock.admin_flag_set('github:1002', 'assistant', 'free', NULL, false, 'No')`).rejects.toMatchObject({ code: '42501' });
    await expect(adminSql`SELECT slotlock.admin_status_record('github:1002', 'status.opened', NULL, '{}'::jsonb)`).rejects.toMatchObject({ code: '42501' });
    await expect(adminSql`SELECT slotlock.admin_system('github:1003')`).rejects.toMatchObject({ code: '42501' });
    // A form sent by Support is refused before anything runs.
    expect((await form(staff.support, '/communications', { audience: 'everyone', kind: 'notice', message: 'Hi', ends: minute(Date.now() + 86_400_000) }, '/system')).status).toBe(403);
    // The serving role reads a dashboard's notices and records maintenance, and nothing else of staff.
    await expect(application`SELECT slotlock.admin_flags('github:1001')`).rejects.toMatchObject({ code: '42501' });
    await expect(application`SELECT * FROM slotlock.announcements`).rejects.toMatchObject({ code: '42501' });
  });

  it('shows the dashboard an announcement scheduled in the console from its start, and takes it away when it is ended', async () => {
    const message = 'The API is read-only for ten minutes from 02:00 UTC on Sunday.';
    const scheduled = await form(staff.owner, '/communications', {
      audience: 'everyone', kind: 'maintenance', message, link: 'https://github.com/PILOTAAI/slotlock/issues/7',
      starts: minute(Date.now() + 2 * 3_600_000), ends: minute(Date.now() + 26 * 3_600_000),
    }, '/communications');
    expect(scheduled.headers.get('location')).toBe('/communications?done=announced');
    const page = await text(staff.owner, '/communications?done=announced');
    expect(page).toContain('Announced. It shows above every page');
    expect(page).toContain(message);
    expect(page).toContain('Scheduled');
    // Not yet: it starts in two hours.
    expect(await customers.ada.page('/dashboard')).not.toContain(message);

    // Its start comes: every account's dashboard shows it, on every page, with its link.
    await superuser`UPDATE slotlock.announcements SET starts_at = now() - interval '1 minute' WHERE message = ${message}`;
    for (const who of [customers.ada, customers.bea]) {
      for (const path of ['/dashboard', '/dashboard/keys', '/dashboard/resources']) {
        const shown = await who.page(path);
        expect(shown, path).toContain(`<strong>Planned maintenance.</strong> ${message}`);
        expect(shown).toContain('href="https://github.com/PILOTAAI/slotlock/issues/7" rel="noopener noreferrer"');
      }
    }
    expect(await text(staff.owner, '/communications')).toContain('Showing');

    // One for the Team plan's accounts reaches Bea, not Ada.
    const team = 'Team workspaces get audit log export to S3 next week.';
    expect((await form(staff.owner, '/communications', { audience: 'plan', plan: 'team', kind: 'change', message: team, ends: minute(Date.now() + 86_400_000) }, '/communications')).headers.get('location'))
      .toBe('/communications?done=announced');
    expect(await customers.bea.page('/dashboard')).toContain(`<strong>A change to Slotlock.</strong> ${team}`);
    expect(await customers.ada.page('/dashboard')).not.toContain(team);

    // A service notice to Ada alone, which her audit log records as sent by Slotlock staff.
    const notice = 'Your plan moves to the new Developer limits on 1 December.';
    expect((await form(staff.owner, '/communications', { audience: 'account', account: ADA, kind: 'notice', message: notice, ends: minute(Date.now() + 86_400_000) }, `/communications?account=${encodeURIComponent(ADA)}`)).headers.get('location'))
      .toBe('/communications?done=announced');
    expect(await customers.ada.page('/dashboard')).toContain(`<strong>Notice.</strong> ${notice}`);
    expect(await customers.bea.page('/dashboard')).not.toContain(notice);
    expect(await customers.ada.page('/dashboard/settings/audit')).toContain('sent the account a notice');
    const created = await staffLog('announcement.created');
    expect(created.map((row) => row.account_ref)).toEqual([null, null, ADA]);
    expect(created[2]?.metadata).toMatchObject({ audience: 'account', kind: 'notice' });
    // The account page offers it.
    expect(await text(staff.owner, `/accounts/${encodeURIComponent(ADA)}`)).toContain(`href="/communications?account=${encodeURIComponent(ADA)}"`);

    // Ended now: it leaves every dashboard at once; ending it again changes nothing.
    const [row] = await superuser<{ id: string }[]>`SELECT id FROM slotlock.announcements WHERE message = ${message}`;
    expect((await form(staff.owner, '/communications/end', { announcement: String(row?.id) }, '/communications')).headers.get('location'))
      .toBe('/communications?done=announcement_ended');
    expect(await customers.ada.page('/dashboard')).not.toContain(message);
    expect((await form(staff.owner, '/communications/end', { announcement: String(row?.id) }, '/communications')).headers.get('location'))
      .toBe('/communications?error=announcement_unchanged');
    expect(await text(staff.owner, '/communications?ended=1')).toContain('Ended');

    // What the database refuses, nothing announced: not https, an unknown account, already over.
    const before = (await superuser`SELECT id FROM slotlock.announcements`).length;
    for (const fields of [
      { audience: 'everyone', kind: 'notice', message: 'x', link: 'http://example.com/', ends: minute(Date.now() + 86_400_000) },
      { audience: 'account', account: 'github:1', kind: 'notice', message: 'x', ends: minute(Date.now() + 86_400_000) },
      { audience: 'everyone', kind: 'notice', message: 'x', ends: minute(Date.now() - 60_000) },
      { audience: 'everyone', kind: 'notice', message: 'x', ends: minute(Date.now() + 100 * 86_400_000) },
      { audience: 'everyone', kind: 'advert', message: 'x', ends: minute(Date.now() + 86_400_000) },
    ]) {
      expect((await form(staff.owner, '/communications', fields, '/communications')).headers.get('location')).toBe('/communications?error=announcement_invalid');
    }
    expect(await superuser`SELECT id FROM slotlock.announcements`).toHaveLength(before);
  });

  it('puts a maintenance failure on Home and the System page, without the account’s data, and clears it when a pass runs', async () => {
    expect(await text(staff.owner, '/')).not.toContain('Maintenance is failing');
    // A pass for Ada fails, as a server's scheduler runs it, with a value in its message.
    const failing = Object.assign(Object.create(store) as SlotlockStore, {
      withTenant: async () => {
        throw Object.assign(new Error('Could not extend "Weekly standup with Ada" past 2027-01-01'), { code: 'XX000' });
      },
    });
    const record = createSlotlockMaintenanceRecord(application);
    const broken = startSlotlockMaintenance({ store: failing, sql: application, tenants: [ADA], intervalMs: 3_600_000, record });
    for (let wait = 0; wait < 50 && (await superuser`SELECT 1 FROM slotlock.maintenance_failures`).length === 0; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await broken.close();

    const [failure] = await superuser<{ tenant_ref: string; error: string; code: string; message: string }[]>`SELECT * FROM slotlock.maintenance_failures`;
    expect(failure).toMatchObject({ tenant_ref: ADA, error: 'Error', code: 'XX000', message: 'Could not extend … past 2027-01-01' });
    // The hour it ran in, counted, never naming the account.
    const [round] = await superuser<{ actor: string; attention: boolean; summary: Record<string, number> }[]>`
      SELECT actor, attention, summary FROM slotlock.maintenance_runs WHERE job = 'maintenance'`;
    expect(round).toMatchObject({ actor: 'serve', attention: true, summary: { passes: 0, failed: 1 } });
    expect(JSON.stringify(round)).not.toContain(String(BASE));

    const home = await text(staff.owner, '/');
    expect(home).toContain('<a href="/system#maintenance">Maintenance is failing for 1 account</a>');
    // Billing sees it, without the link to a page it does not open.
    const billingHome = await text(staff.billing, '/');
    expect(billingHome).toContain('Maintenance is failing for 1 account');
    expect(billingHome).not.toContain('href="/system#maintenance"');
    const system = await text(staff.support, '/system');
    expect(system).toContain(`href="/accounts/${encodeURIComponent(ADA)}" class="mono">${ADA}</a>`);
    expect(system).toContain('<code>Error XX000</code>');
    expect(system).toContain('Could not extend … past 2027-01-01');
    expect(system).not.toContain('Weekly standup');

    // The next pass runs: the failure clears, and Home has nothing to say about it.
    const fixed = startSlotlockMaintenance({ store, sql: application, tenants: [ADA], intervalMs: 3_600_000, record });
    for (let wait = 0; wait < 50 && (await superuser`SELECT 1 FROM slotlock.maintenance_failures`).length > 0; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await fixed.close();
    expect(await superuser`SELECT 1 FROM slotlock.maintenance_failures`).toHaveLength(0);
    expect(await text(staff.owner, '/')).not.toContain('Maintenance is failing');
    expect(await text(staff.owner, '/system')).toContain('Every account’s last pass ran.');
    expect(await superuser`SELECT 1 FROM slotlock.maintenance_runs WHERE job = 'maintenance'`).toHaveLength(2);
  });

  it('turns the assistant off for one account and creating teams off for a plan, each in the staff log and the account’s audit log', async () => {
    expect(await customers.ada.page('/dashboard')).toContain('href="/dashboard/assistant"');
    expect((await form(staff.owner, '/system/flags', { flag: 'assistant', account: ADA, enabled: '0', reason: 'Assistant paused while we look into a billing question' }, '/system')).headers.get('location'))
      .toBe('/system?done=flag_set');
    const ada = await customers.ada.page('/dashboard');
    expect(ada).not.toContain('href="/dashboard/assistant"');
    expect((await customers.ada.get('/dashboard/assistant')).status).toBe(404);
    expect(await customers.bea.page('/dashboard')).toContain('href="/dashboard/assistant"');
    expect(await customers.ada.page('/dashboard/settings/audit')).toContain('turned a feature on or off for the account');

    // Creating teams off for the Team plan: Bea's Teams page says so and refuses; Ada's offers it.
    expect((await form(staff.owner, '/system/flags', { flag: 'team_workspaces', plan: 'team', enabled: '0', reason: 'Team creation paused for the migration' }, '/system')).headers.get('location'))
      .toBe('/system?done=flag_set');
    const beaTeams = await customers.bea.page('/dashboard/teams');
    expect(beaTeams).toContain('Creating team workspaces is turned off for your account.');
    expect(beaTeams).not.toContain('action="/dashboard/teams/create"');
    expect(await customers.ada.page('/dashboard/teams')).toContain('action="/dashboard/teams/create"');

    const system = await text(staff.owner, '/system?done=flag_set');
    expect(system).toContain('Flag set.');
    expect(system).toContain('Assistant paused while we look into a billing question');
    expect(system).toContain('as configured → off');
    const set = await staffLog('flag.set');
    expect(set.map((row) => [row.account_ref, row.target, row.metadata.to])).toEqual([[ADA, 'flag:assistant', false], [null, 'flag:team_workspaces', false]]);

    // Removed: the deployment decides again; removing it twice changes nothing.
    const [flag] = await superuser<{ id: string }[]>`SELECT id FROM slotlock.feature_flags WHERE tenant_ref = ${ADA}`;
    expect((await form(staff.owner, '/system/flags/clear', { flag: String(flag?.id), reason: 'Billing question answered' }, '/system')).headers.get('location'))
      .toBe('/system?done=flag_cleared');
    expect(await customers.ada.page('/dashboard')).toContain('href="/dashboard/assistant"');
    expect((await form(staff.owner, '/system/flags/clear', { flag: String(flag?.id), reason: 'Again' }, '/system')).headers.get('location'))
      .toBe('/system?error=flag_unchanged');

    // Neither a plan nor an account, an account's test environment, or no reason: nothing changes.
    for (const fields of [
      { flag: 'assistant', enabled: '0', reason: 'x' },
      { flag: 'assistant', account: `${ADA}~test`, enabled: '0', reason: 'x' },
      { flag: 'assistant', account: ADA, enabled: '0', reason: '' },
      { flag: 'billing', plan: 'free', enabled: '0', reason: 'x' },
    ]) {
      expect((await form(staff.owner, '/system/flags', fields, '/system')).headers.get('location')).toBe('/system?error=flag_invalid');
    }
    expect(await superuser`SELECT 1 FROM slotlock.feature_flags`).toHaveLength(1);
  });

  it('opens, updates and closes incidents on the status page, and touches no other issue', async () => {
    const probe = [...repo.issues.values()].find((issue) => issue.title === 'Hosted Slotlock API is down');
    const bug = [...repo.issues.values()].find((issue) => issue.labels.includes('bug'));
    const page = await text(staff.owner, '/communications');
    expect(page).toContain(`#${probe?.number} Hosted Slotlock API is down`);
    expect(page).not.toContain('The docs search misses a page');

    expect((await form(staff.owner, '/communications/status', { title: 'Slow bookings in Europe', body: 'Booking calls take up to five seconds. We are looking into it.' }, '/communications')).headers.get('location'))
      .toBe('/communications?done=incident_opened');
    const opened = [...repo.issues.values()].find((issue) => issue.title === 'Slow bookings in Europe');
    expect(opened).toMatchObject({ state: 'open', labels: ['status'], body: 'Booking calls take up to five seconds. We are looking into it.' });

    expect((await form(staff.owner, '/communications/status/update', { issue: String(probe?.number), body: 'The database failed over; the API answers again.' }, '/communications')).headers.get('location'))
      .toBe('/communications?done=incident_updated');
    expect(probe?.comments).toEqual(['The database failed over; the API answers again.']);
    expect((await form(staff.owner, '/communications/status/update', { issue: String(opened?.number), body: 'Resolved: latency is back to normal.', close: '1' }, '/communications')).headers.get('location'))
      .toBe('/communications?done=incident_closed');
    expect(opened?.state).toBe('closed');

    // Not an incident, or one already closed: nothing posted.
    for (const issue of [bug, opened]) {
      expect((await form(staff.owner, '/communications/status/update', { issue: String(issue?.number), body: 'Hello' }, '/communications')).headers.get('location'))
        .toBe('/communications?error=incident_unchanged');
    }
    expect(bug?.comments).toEqual([]);
    expect(opened?.comments).toEqual(['Resolved: latency is back to normal.']);
    expect((await form(staff.owner, '/communications/status', { title: '', body: 'x' }, '/communications')).headers.get('location'))
      .toBe('/communications?error=incident_invalid');
    // Each step was recorded before GitHub was asked; a refused one too, and only that it was tried.
    expect((await staffLog('status.opened')).map((row) => row.metadata)).toEqual([{ title: 'Slow bookings in Europe' }]);
    expect((await staffLog('status.updated')).map((row) => row.target)).toEqual([`issue:${probe?.number}`, `issue:${bug?.number}`, `issue:${opened?.number}`]);
    expect((await staffLog('status.closed')).map((row) => row.target)).toEqual([`issue:${opened?.number}`]);
    expect(await text(staff.owner, '/communications')).toContain('Slow bookings in Europe');

    // Without the GitHub App, the page says what it needs and a form changes nothing.
    const owner = new Browser(() => bare);
    owner.jar.clear();
    for (const [name, value] of staff.owner.jar) owner.jar.set(name, value);
    expect(await text(owner, '/communications')).toContain('The status page is not connected.');
  });

  it('shows the site’s search, visits and deploys, reads each provider once an hour, and says what to set for one not connected', async () => {
    // The role test opened the page already: start this hour afresh.
    await superuser`DELETE FROM slotlock.admin_cache WHERE key LIKE 'site:%'`;
    providerCalls.length = 0;
    const site = await text(staff.editor, '/site');
    expect(site).toContain('ai agent calendar');
    expect(site).toContain(`href="${SITE}/blog/why-ai-agents-double-book/"`);
    // Seen 900 times and clicked 4: worth a new title.
    const titles = site.slice(site.indexOf('id="titles"'), site.indexOf('id="posts"'));
    expect(titles).toContain('/pricing/');
    expect(titles).not.toContain('/blog/');
    expect(site.slice(site.indexOf('id="posts"'))).toContain('/blog/why-ai-agents-double-book/');
    expect(site).toContain('booking api for agents');
    expect(site).toContain('Page loads');
    expect(site).toContain('Cloudflare did not give referrers just now.');
    expect(site).toContain('Passed');
    expect(site).toContain('Failed');
    expect(site).toContain('sitemap-index.xml');
    const firstReads = providerCalls.length;
    expect(firstReads).toBeGreaterThan(0);
    // Kept an hour: the next visit reads nothing from the providers.
    await text(staff.owner, '/site');
    expect(providerCalls).toHaveLength(firstReads);
    expect((await superuser<{ key: string }[]>`SELECT key FROM slotlock.admin_cache ORDER BY key`).map((row) => row.key))
      .toEqual(expect.arrayContaining(['site:bing', 'site:deploys', 'site:google', 'site:visits']));

    const owner = new Browser(() => bare);
    for (const [name, value] of staff.owner.jar) owner.jar.set(name, value);
    const unconnected = await text(owner, '/site');
    for (const sentence of ['Search Console is not connected.', 'Bing Webmaster Tools is not connected.', 'Cloudflare Web Analytics is not connected.', 'GitHub is not connected.']) {
      expect(unconnected).toContain(sentence);
    }
  });

  it('shows hosts, deploys, webhooks and configuration on the System page, and never a secret', async () => {
    const app = createSlotlockStoreApplicationBackend(store);
    await app.createWebhook({ principal: { tenantRef: BEA, scopes: ['admin'] }, signal: new AbortController().signal } as never, { url: 'https://hooks.example.com/slotlock' });
    await superuser`UPDATE slotlock.webhook_endpoints SET failing_since = now() - interval '2 hours', attempts = 4 WHERE tenant_ref = ${BEA}`;
    const system = await text(staff.owner, '/system');
    expect(system).toContain('0.10.0');
    const dashboardRow = system.slice(system.indexOf('https://dashboard.slotlock.test/dashboard'));
    expect(dashboardRow.slice(0, 300)).toContain('<span class="pill bad">Down</span><span class="sub">HTTP 503</span>');
    expect(system).toContain('Dashboard and console Workers');
    expect(system).toContain('Running');
    expect(system).toMatch(/<span class="stat-label">Failing<\/span>\s*<strong class="stat-value">1<\/strong>/);
    expect(system).toContain('connected to sc-domain:slotlock.pylota.io');
    expect(system).toContain(`connected to ${FAKE_REPOSITORY}`);
    for (const secret of [BING_KEY, 'cf-token', 'PRIVATE KEY', 'a-test-session-secret-of-forty-characters', 'client-secret', 'hooks.example.com']) {
      expect(system).not.toContain(secret);
    }
    expect((await staffLog('system.viewed')).length).toBeGreaterThan(0);
  });
});
