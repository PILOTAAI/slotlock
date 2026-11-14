// The staff console's figures and names against real PostgreSQL, end to end through its pages:
// Home and Billing count paying plans by one rule (and Stripe's revenue by the same), a plan set to
// end says when on Accounts and the account page, a refund that left a plan running needs a person,
// people are shown by the name and display their provider gave (with initials, never a style
// attribute), and staff by the login they last signed in with, without asking GitHub; the Staff log
// names who, says what in words, hides views unless asked, and filters. Needs a role that creates
// databases and roles; skipped without DATABASE_URL.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAdmin, createSlotlockAdmin } from '../admin/app.js';
import { createSlotlockStore } from '../store.js';
import { Browser, CONSOLE_KEY, ORIGIN, SoftwarePasskey, createGithubSignInFetch, sha } from './helpers/admin-browser.js';

const url = process.env.DATABASE_URL?.trim();
const STAFF: Record<string, { id: number; login: string }> = {
  'code-owner': { id: 1001, login: 'octo-owner' },
  'code-billing': { id: 1003, login: 'octo-billing' },
};
const BASE = 620_000_000 + Math.floor(Math.random() * 1_000_000);
/** People as they signed in to the dashboard: a name and display, a display only, neither. */
const ADA = `github:${BASE}`;
const GRACE = `google:${BASE}1`;
const NOBODY = `github:${BASE + 2}`;
/** Plans in each standing: paying, past due, set to end, in a trial, cancelled, a partner's. */
const PAYING = `github:${BASE + 10}`;
const PAST_DUE = `github:${BASE + 11}`;
const ENDING = `github:${BASE + 12}`;
const TRIAL = `github:${BASE + 13}`;
const CANCELLED = `github:${BASE + 14}`;
const thisYear = new Date().getUTCFullYear();
const ENDS = new Date(Date.UTC(thisYear, 11, 14));

describe.skipIf(!url)('figures and names in the admin console (real Postgres)', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_figures_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const adminRole = `slotlock_admin_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let root: postgres.Sql;
  let superuser: postgres.Sql;
  let adminSql: postgres.Sql;
  let admin: SlotlockAdmin;
  const staff: Record<'owner' | 'billing', Browser> = {} as never;
  /** Every request the console made to GitHub's API, and to Stripe's. */
  const github: string[] = [];
  const stripeCalls: string[] = [];
  const month = (date: number) => Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), date) / 1000);
  const item = (amount: number) => ({ price: { unit_amount: amount, currency: 'gbp', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } }, quantity: 1, current_period_end: ENDS.getTime() / 1000 });
  /** Stripe's subscriptions for the same accounts, and one of another product's. */
  const SUBSCRIPTIONS = [
    { id: 'sub_Pay', status: 'active', created: month(1), metadata: { tenant_ref: PAYING }, items: { data: [item(500)] } },
    { id: 'sub_Due', status: 'past_due', created: 1, metadata: { tenant_ref: PAST_DUE }, items: { data: [item(1500)] } },
    { id: 'sub_End', status: 'active', created: 1, cancel_at_period_end: true, canceled_at: month(2), metadata: { tenant_ref: ENDING }, items: { data: [item(500)] } },
    { id: 'sub_Try', status: 'trialing', created: month(1), metadata: { tenant_ref: TRIAL }, items: { data: [item(500)] } },
    { id: 'sub_Old', status: 'canceled', created: 1, canceled_at: month(1), ended_at: month(1), metadata: { tenant_ref: CANCELLED }, items: { data: [item(500)] } },
    { id: 'sub_Else', status: 'active', created: month(1), metadata: {}, items: { data: [item(9900)] } },
    { id: 'sub_Lost', status: 'incomplete_expired', created: month(1), metadata: { tenant_ref: CANCELLED }, items: { data: [item(500)] } },
  ];

  async function fakes(input: string | URL | Request, init?: RequestInit): Promise<Response | null> {
    const target = new URL(String(input instanceof Request ? input.url : input));
    if (target.hostname === 'api.github.com') github.push(target.pathname);
    if (target.hostname === 'api.stripe.com') {
      stripeCalls.push(target.pathname);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer rk_test_admin');
      return Response.json({ data: SUBSCRIPTIONS, has_more: false });
    }
    return null;
  }

  async function signedIn(code: string, enrollment: string) {
    const browser = new Browser(() => admin);
    expect((await browser.signIn(code)).headers.get('location')).toBe('/passkey');
    expect((await browser.createPasskey(new SoftwarePasskey(), { code: enrollment })).status).toBe(200);
    return browser;
  }
  const text = async (browser: Browser, path: string) => {
    const response = await browser.request(path);
    expect(response.status, path).toBe(200);
    return response.text();
  };
  /** A stat tile's value and note, by its label. */
  const tile = (page: string, label: string) => {
    const at = page.indexOf(`<span class="stat-label">${label}</span>`);
    expect(at, label).toBeGreaterThan(-1);
    const rest = page.slice(at, page.indexOf('</li>', at));
    return {
      value: /<strong class="stat-value">([^<]*)<\/strong>/.exec(rest)?.[1],
      note: /<span class="stat-note">([^<]*)<\/span>/.exec(rest)?.[1] ?? null,
    };
  };

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
      const ownerStore = createSlotlockStore(tx);
      await ownerStore.applySchema();
      await ownerStore.applyTenantRls();
      await ownerStore.grantAdminRole(adminRole);
      const expires = new Date(Date.now() + 86_400_000);
      await tx`SELECT slotlock.staff_console_key(${sha(CONSOLE_KEY)}, 'cli:ops')`;
      await tx`SELECT slotlock.staff_add('github:1001', 'owner', 'cli:ops', ${sha('owner-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1003', 'billing', 'cli:ops', ${sha('billing-code')}, ${expires})`;
    });
    adminSql = postgres(Object.assign(new URL(target.href), { username: adminRole, password }).href, { max: 4, onnotice: () => undefined });

    // People, as the dashboard keeps them at sign-in (dashboard-teams.integration covers that).
    await superuser`
      INSERT INTO slotlock.dashboard_people (person_ref, display, name) VALUES
        (${ADA}, '@ada', 'Ada Lovelace'), (${GRACE}, 'grace@navy.example', NULL), (${NOBODY}, NULL, NULL)`;
    const plan = (tenant: string, name: string, status: string, subscription: string | null, extra: { ends?: Date; trialing?: boolean; source?: string } = {}) => superuser`
      INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints,
                                         stripe_customer, stripe_subscription, ends_at, trialing, source, partner_id,
                                         quota_operations, quota_bookings, quota_stop_percent)
      VALUES (${tenant}, ${name}, ${status}, 100, 100, 10, ${subscription ? 'cus_Figures1' : null}, ${subscription},
              ${extra.ends ?? null}, ${extra.trialing ?? false}, ${extra.source ?? 'direct'},
              ${extra.source === 'partner' ? 'acme' : null}, ${extra.source === 'partner' ? 1000 : null},
              ${extra.source === 'partner' ? 100 : null}, ${extra.source === 'partner' ? 100 : null})`;
    await plan(PAYING, 'developer', 'active', 'sub_Pay');
    await plan(ADA, 'team', 'active', 'sub_Ada');
    await plan(PAST_DUE, 'team', 'past_due', 'sub_Due');
    await plan(ENDING, 'developer', 'active', 'sub_End', { ends: ENDS });
    await plan(TRIAL, 'developer', 'active', 'sub_Try', { trialing: true });
    await plan(CANCELLED, 'free', 'canceled', null);
    // Not Pylota's sale, nor one that pays: none of them counts as paying.
    await plan(`${PAYING}~test`, 'developer', 'active', null);
    await plan(`partner:acme:${BASE}`, 'gold', 'active', null, { source: 'partner' });
    await plan(`github:${BASE + 15}`, 'developer', 'active', null);

    admin = createSlotlockAdmin({
      sql: () => adminSql,
      publicUrl: ORIGIN,
      sessionSecret: 'a-test-session-secret-of-forty-characters',
      consoleKey: CONSOLE_KEY,
      github: { clientId: 'client-id', clientSecret: 'client-secret' },
      access: { verify: async (request: Request) => (request.headers.get('cf-access-jwt-assertion') === 'ok' ? { email: 'staff@example.com', sub: 'sub-1' } : null) },
      fetch: createGithubSignInFetch(STAFF, { someone: { id: BASE + 2, login: 'someone', type: 'User' } }, fakes),
      stripeKey: 'rk_test_admin',
    });
    staff.owner = await signedIn('code-owner', 'owner-code');
    staff.billing = await signedIn('code-billing', 'billing-code');
    github.length = 0;
  });

  afterAll(async () => {
    await adminSql?.end({ timeout: 5 });
    await superuser?.end();
    await root?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [adminRole, owner]) await root?.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await root?.end();
  });

  it('counts paying plans by one rule on Home and Billing, and Stripe by the same', async () => {
    const home = await text(staff.owner, '/');
    // Paying, past due included; never the one set to end, the trial, Free, a partner's or a test's.
    expect(tile(home, 'Paying')).toEqual({ value: '3', note: '1 in a trial, 1 ending' });
    const billing = await text(staff.owner, '/billing');
    expect(tile(billing, 'Paying')).toEqual({ value: '3', note: '1 Developer, 2 Team' });
    expect(tile(billing, 'Past due')).toMatchObject({ value: '1' });
    expect(tile(billing, 'In a trial')).toMatchObject({ value: '1' });
    // Stripe's revenue, by the same rule: £5 + £15, Slotlock's only (not another product's £99).
    expect(tile(billing, 'Monthly recurring revenue')).toEqual({ value: '£20.00', note: '2 paying subscriptions in Stripe' });
    expect(tile(billing, 'Ending')).toEqual({ value: '1', note: '£5.00 a month' });
    // New: bought this month and paid for, never an abandoned checkout or a trial. Cancelled: ended.
    expect(tile(billing, 'New this month')).toMatchObject({ value: '1' });
    expect(tile(billing, 'Cancelled this month')).toMatchObject({ value: '1' });
    // Each plan set to end, and when.
    const ending = billing.slice(billing.indexOf('id="ending"'));
    expect(ending).toContain(`href="/accounts/${encodeURIComponent(ENDING)}"`);
    expect(ending).toContain(`${thisYear}-12-14`);
    expect(ending).toContain('£5.00');
    expect(stripeCalls).toEqual(['/v1/subscriptions']);
  });

  it("lists on Accounts' Paying and Past due views the plans Home and Billing count, by the same rule", async () => {
    /** The accounts a list's rows link to, sorted. */
    const listed = (page: string) => {
      const rows = page.slice(page.indexOf('<tbody>'), page.indexOf('</tbody>'));
      return [...new Set([...rows.matchAll(/href="\/accounts\/([^"/?#]+)"/g)].map((match) => decodeURIComponent(match[1] ?? '')))].sort();
    };
    const viewCount = (page: string, label: string) => new RegExp(`>${label}<span class="count">([^<]*)</span>`).exec(page)?.[1];
    const home = await text(staff.owner, '/');
    const billing = await text(staff.owner, '/billing');
    const paying = await text(staff.owner, '/accounts?view=paying');
    // Past due included; never the plan set to end, the trial, a plan with no subscription, a
    // partner's or a test environment's.
    expect(listed(paying)).toEqual([ADA, PAST_DUE, PAYING].sort());
    expect(viewCount(paying, 'Paying')).toBe('3');
    expect(paying).toContain('1–3 of 3');
    expect(tile(home, 'Paying').value).toBe('3');
    expect(tile(billing, 'Paying').value).toBe('3');
    const pastDue = await text(staff.owner, '/accounts?view=past_due');
    expect(listed(pastDue)).toEqual([PAST_DUE]);
    expect(viewCount(pastDue, 'Past due')).toBe('1');
    expect(tile(billing, 'Past due').value).toBe('1');
  });

  it('says when a plan set to end ends, on Accounts and on its page, from what the webhook kept', async () => {
    const before = stripeCalls.length;
    const accounts = await text(staff.owner, '/accounts');
    const row = accounts.slice(accounts.indexOf(`href="/accounts/${encodeURIComponent(ENDING)}"`));
    expect(row.slice(0, row.indexOf('</tr>'))).toContain(`Developer · ends ${thisYear}-12-14`);
    // The list asks Stripe nothing.
    expect(stripeCalls.length).toBe(before);
    const page = await text(staff.owner, `/accounts/${encodeURIComponent(ENDING)}`);
    expect(page).toContain(`Developer · ends ${thisYear}-12-14`);
    expect(page).toContain(`<dt>Ends</dt><dd>${thisYear}-12-14</dd>`);
  });

  it('shows every date to staff one way, 2026-11-14 (and 09:21 after it for a time), on every page', async () => {
    /** What a person reads: no script, style or tags (an SVG point's title included). */
    const visible = (page: string) => page.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
    const other = new RegExp(`\\b\\d{1,2} ${MONTH}\\b|\\b${MONTH} \\d{1,2}\\b|\\b${MONTH} \\d{4}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b`);
    for (const path of ['/', '/accounts', `/accounts/${encodeURIComponent(ENDING)}`, '/billing', '/usage', '/cases', '/privacy', '/site', '/communications', '/system', '/staff', '/staff/log']) {
      expect(other.exec(visible(await text(staff.owner, path)))?.[0] ?? null, path).toBeNull();
    }
  });

  it('puts a refund that left a plan running under Needs a person', async () => {
    await superuser`SELECT slotlock.note_billing_event('refunded_plan_active', ${PAYING}, 'ch_Refund1',
      ${superuser.json({ amount: 500, amount_refunded: 500, currency: 'gbp', refunded: true, subscription: 'sub_Pay' })})`;
    const billing = await text(staff.billing, '/billing');
    const alerts = billing.slice(billing.indexOf('id="alerts"'), billing.indexOf('id="overrides"'));
    expect(alerts).toContain('Refunded, plan still active');
    expect(alerts).toContain('£5.00 of £5.00 refunded');
    expect(alerts).toContain('https://dashboard.stripe.com/payments/ch_Refund1');
    expect(await text(staff.billing, '/')).toContain('1 billing alert');
    // Part of a payment refunded says only that: the plan may well be meant to carry on.
    await superuser`SELECT slotlock.note_billing_event('refunded_plan_active', ${PAYING}, 'ch_Refund2',
      ${superuser.json({ amount: 500, amount_refunded: 200, currency: 'gbp', refunded: false, subscription: 'sub_Pay' })})`;
    const partly = await text(staff.billing, '/billing');
    const table = partly.slice(partly.indexOf('<table', partly.indexOf('id="alerts"')));
    const row = table.slice(table.lastIndexOf('<tr', table.indexOf('ch_Refund2')), table.indexOf('</tr>', table.indexOf('ch_Refund2')));
    expect(row).toContain('Partly refunded<span class="sub">£2.00 of £5.00 refunded</span>');
    expect(row).not.toContain('end the plan');
    // All of it refunded on a plan set to end: when it ends, so a person can end it sooner.
    await superuser`SELECT slotlock.note_billing_event('refunded_plan_active', ${ENDING}, 'ch_Refund3',
      ${superuser.json({ amount: 500, amount_refunded: 500, currency: 'gbp', refunded: true, subscription: 'sub_End', ends_at: ENDS.toISOString() })})`;
    const ending = await text(staff.billing, '/billing');
    const endingTable = ending.slice(ending.indexOf('<table', ending.indexOf('id="alerts"')));
    const endingRow = endingTable.slice(endingTable.lastIndexOf('<tr', endingTable.indexOf('ch_Refund3')), endingTable.indexOf('</tr>', endingTable.indexOf('ch_Refund3')));
    expect(endingRow).toContain(`Refunded in full, plan ends ${thisYear}-12-14<span class="sub">£5.00 of £5.00 refunded: end it now, or say why not</span>`);
  });

  it("shows people by their provider's name, else display, else reference, with initials and no style attribute", async () => {
    const accounts = await text(staff.owner, '/accounts');
    const rowOf = (ref: string) => {
      const at = accounts.indexOf(`href="/accounts/${encodeURIComponent(ref)}"`);
      expect(at, ref).toBeGreaterThan(-1);
      const start = accounts.lastIndexOf('<tr>', at);
      return accounts.slice(start, accounts.indexOf('</tr>', at));
    };
    expect(rowOf(ADA)).toMatch(/<span class="avatar avatar-t\d" aria-hidden="true">AL<\/span>/);
    expect(rowOf(ADA)).toContain('>Ada Lovelace</a>');
    expect(rowOf(ADA)).toContain(`@ada · ${ADA}`);
    expect(rowOf(GRACE)).toContain('>grace@navy.example</a>');
    expect(rowOf(GRACE)).toMatch(/avatar-t\d" aria-hidden="true">G</);
    expect(rowOf(NOBODY)).toContain(`>${NOBODY}</a>`);
    // The same account, the same colour, every time.
    expect(/avatar-t(\d)/.exec(rowOf(ADA))?.[1]).toBe(/avatar-t(\d)/.exec(await text(staff.owner, `/accounts/${encodeURIComponent(ADA)}`))?.[1]);
    expect(accounts.toLowerCase()).not.toContain(' style=');
    const css = await (await staff.owner.request('/admin.css')).text();
    for (let tone = 0; tone < 8; tone += 1) expect(css).toContain(`.avatar-t${tone}{`);
    const page = await text(staff.owner, `/accounts/${encodeURIComponent(ADA)}`);
    expect(page).toContain('<span class="here">Ada Lovelace</span></h1>');
    expect(page).toContain(`@ada · ${ADA}`);
    // Names come from the database: GitHub is never asked.
    expect(github).toEqual([]);
  });

  it('finds people by name and by display, and asks GitHub only for a login the database does not hold', async () => {
    for (const query of ['lovelace', '@ada', 'ADA', 'navy.example']) {
      const search = await staff.owner.request(`/search?${new URLSearchParams({ q: query }).toString()}`);
      const found = await text(staff.owner, search.headers.get('location') ?? '');
      expect(found, query).toContain(`href="/accounts/${encodeURIComponent(query.includes('navy') ? GRACE : ADA)}"`);
    }
    expect(github).toEqual([]);
    // An @ alone names no one.
    expect(await text(staff.owner, '/accounts?q=%40')).toContain('No account matches that search.');
    // A login no one signed in with since names were kept: GitHub says which id it is.
    const search = await staff.owner.request('/search?q=someone');
    const found = await text(staff.owner, search.headers.get('location') ?? '');
    expect(found).toContain(`href="/accounts/${encodeURIComponent(NOBODY)}"`);
    expect(found).toContain(`GitHub account <strong>someone</strong> is id <code>${BASE + 2}</code>`);
    expect(github).toEqual(['/users/someone']);
    // Recorded, but the login only as a keyed digest (staff_search_record), as a search by name is.
    const [lookup] = await superuser<{ target: string | null; metadata: Record<string, string> }[]>`
      SELECT target, metadata FROM slotlock.staff_audit_events WHERE action = 'search.github_lookup' ORDER BY chain_index DESC LIMIT 1`;
    expect(lookup).toEqual({ target: null, metadata: { query_digest: expect.stringMatching(/^[0-9a-f]{64}$/), query_kind: 'text' } });
    const searched = await superuser<{ metadata: Record<string, string> }[]>`
      SELECT metadata FROM slotlock.staff_audit_events WHERE action IN ('accounts.searched', 'search.github_lookup')`;
    expect(JSON.stringify(searched)).not.toMatch(/someone|lovelace|navy/i);
  });

  it('names staff by the login they last signed in with, and the command line as such', async () => {
    expect(await superuser`SELECT staff_ref, login FROM slotlock.staff_members ORDER BY staff_ref`).toEqual([
      { staff_ref: 'github:1001', login: 'octo-owner' },
      { staff_ref: 'github:1003', login: 'octo-billing' },
    ]);
    const page = await text(staff.owner, '/staff');
    const row = page.slice(page.indexOf('octo-billing'));
    expect(row.slice(0, row.indexOf('</tr>'))).toContain('Command line');
    // A login GitHub would never give is not kept.
    const token = (await adminSql<{ opened: { session: string } }[]>`SELECT slotlock.admin_sign_in('github:1003', ${CONSOLE_KEY}) AS opened`)[0]?.opened.session;
    expect((await adminSql<{ kept: boolean }[]>`SELECT slotlock.admin_staff_login(${token ?? ''}, '<b>x</b>') AS kept`)[0]?.kept).toBe(false);
    expect((await superuser<{ login: string }[]>`SELECT login FROM slotlock.staff_members WHERE staff_ref = 'github:1003'`)[0]?.login).toBe('octo-billing');
    expect(github).toEqual(['/users/someone']);
  });

  it('shows the staff log by login and in words, hides views unless asked, and filters', async () => {
    await superuser`SELECT slotlock.staff_operator_record('cli:node', 'account.suspended', ${PAYING}, 'Chargeback')`;
    const listed = async () => (await superuser`SELECT 1 FROM slotlock.staff_audit_events WHERE action = 'staff.list_viewed'`).length;
    const listedBefore = await listed();
    const log = await text(staff.owner, '/staff/log');
    // Its filter's member list is read without a record of its own: reading the log is not one.
    expect(await listed()).toBe(listedBefore);
    expect(log).toMatch(/<a class="menu-item" href="[^"]*who=github%3A1003[^"]*">octo-billing<\/a>/);
    // Only Staff log is the current page in the sidebar, not Staff as well.
    expect(log).toContain('<a href="/staff/log" aria-current="page">');
    expect(log).not.toMatch(/<a href="\/staff" aria-current/);
    const rows = log.slice(log.indexOf('<tbody>'), log.indexOf('</tbody>'));
    expect(rows).toContain('octo-owner');
    expect(rows).toContain('Command line');
    expect(rows).toContain('<span title="account.suspended">Suspended an account</span>');
    expect(rows).toContain('<span title="staff.signed_in">Signed in</span>');
    // Views are recorded, but only shown when asked.
    expect(rows).not.toContain('title="home.viewed"');
    expect(rows).not.toContain('title="accounts.searched"');
    const withViews = await text(staff.owner, '/staff/log?views=1');
    expect(withViews).toContain('<span title="home.viewed">Opened Home</span>');
    expect(withViews).toContain('title="account.viewed"');
    // The hash chain is still checked.
    expect(log).toMatch(/The newest \d+ entries check out/);

    const filtered = async (query: Record<string, string>) => {
      const page = await text(staff.owner, `/staff/log?${new URLSearchParams(query).toString()}`);
      return [...page.slice(page.indexOf('<tbody>'), page.indexOf('</tbody>')).matchAll(/<span title="([a-z_.]+)">/g)].map((match) => match[1]);
    };
    // Every deployment-role command, whichever user ran it.
    expect(new Set(await filtered({ who: 'cli' }))).toEqual(new Set(['staff.console_key_set', 'staff.added', 'account.suspended']));
    expect(await filtered({ who: 'cli:node' })).toEqual(['account.suspended']);
    expect(new Set(await filtered({ who: 'github:1003' }))).toEqual(new Set(['staff.signed_in', 'staff.passkey_added']));
    expect(await filtered({ action: 'account.suspended' })).toEqual(['account.suspended']);
    // Opening an account records only views of it: none shown unless asked.
    expect(await filtered({ account: ADA })).toEqual([]);
    const viewed = await filtered({ account: ADA, views: '1' });
    expect(viewed).toContain('account.viewed');
    expect(viewed.every((action) => /\.([a-z_]+_)?(viewed|listed)$/.test(action as string))).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect((await filtered({ from: today, to: today })).length).toBeGreaterThan(0);
    expect(await filtered({ to: '2000-01-01' })).toEqual([]);
    // A filter that is not one is left out, never passed on.
    expect((await staff.owner.request("/staff/log?who=x'%3B--&action=%3Cscript%3E&from=nope")).status).toBe(200);
    // Older pages keep the filters.
    expect(withViews).toMatch(/href="\/staff\/log\?views=1&amp;before=\d+">Older<\/a>/);
  });
});
