// The staff console's figures against real PostgreSQL, end to end through its pages: Home and
// Billing count paying plans by one rule (and Stripe's revenue by the same), a plan set to end says
// when on Accounts and the account page, and a refund that left a plan running needs a person.
// Needs a role that creates databases and roles; skipped without DATABASE_URL.
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

describe.skipIf(!url)('billing figures in the admin console (real Postgres)', () => {
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
      INSERT INTO slotlock.dashboard_people (person_ref, display) VALUES
        (${ADA}, '@ada'), (${GRACE}, 'grace@navy.example'), (${NOBODY}, NULL)`;
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
    expect(ending).toContain('14 Dec');
    expect(ending).toContain('£5.00');
    expect(stripeCalls).toEqual(['/v1/subscriptions']);
  });

  it('says when a plan set to end ends, on Accounts and on its page, from what the webhook kept', async () => {
    const before = stripeCalls.length;
    const accounts = await text(staff.owner, '/accounts');
    const row = accounts.slice(accounts.indexOf(`href="/accounts/${encodeURIComponent(ENDING)}"`));
    expect(row.slice(0, row.indexOf('</tr>'))).toContain('Developer · ends 14 Dec');
    // The list asks Stripe nothing.
    expect(stripeCalls.length).toBe(before);
    const page = await text(staff.owner, `/accounts/${encodeURIComponent(ENDING)}`);
    expect(page).toContain('Developer · ends 14 Dec');
    expect(page).toMatch(/<dt>Ends<\/dt><dd>\d{4}-12-14<\/dd>/);
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
  });
});
