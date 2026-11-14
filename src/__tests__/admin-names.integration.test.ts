// Every console surface that lists an account names it as Accounts does: by its name, else its
// display, else its reference, with initials and the reference on a muted line. The names come with
// each admin function's rows (joined to staff_directory), never a lookup per row: Home's cases,
// Billing's Needs a person, overrides, alerts and Ending, Usage's and Accounts' near quota, the case
// and privacy queues and records, the Staff log, Communications' and System's accounts, and the
// account typeahead. Needs a role that
// creates databases and roles; skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAdmin, createSlotlockAdmin } from '../admin/app.js';
import { createSlotlockStore } from '../store.js';
import { Browser, CONSOLE_KEY, ORIGIN, SoftwarePasskey, createGithubSignInFetch, sha, staffSession } from './helpers/admin-browser.js';

const url = process.env.DATABASE_URL?.trim();
const BASE = 630_000_000 + Math.floor(Math.random() * 1_000_000);
/** A person with a name and a login, and a team workspace with a name. */
const ADA = `github:${BASE}`;
const TEAM = `team:${randomUUID()}`;
const ENDS = new Date(Date.now() + 20 * 86_400_000);

describe.skipIf(!url)('accounts by name on every console surface (real Postgres)', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_names_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const adminRole = `slotlock_admin_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let root: postgres.Sql;
  let superuser: postgres.Sql;
  let adminSql: postgres.Sql;
  let admin: SlotlockAdmin;
  let browser: Browser;
  let caseId = '';
  let requestId = '';

  const text = async (path: string) => {
    const response = await browser.request(path);
    expect(response.status, path).toBe(200);
    return response.text();
  };
  /** The page from one marker to the next. */
  const between = (page: string, from: string, to: string) => {
    const start = page.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    const end = page.indexOf(to, start + from.length);
    return page.slice(start, end === -1 ? undefined : end);
  };
  /**
   * The account cell for Ada (or the team): its name linked to its page, and the rest muted beneath;
   * a team's long reference by its start and end, the whole of it in the title.
   */
  const adaCell = `<a href="/accounts/${encodeURIComponent(ADA)}">Ada Lovelace</a><span class="sub">@ada · ${ADA}</span>`;
  const teamCell = `<a href="/accounts/${encodeURIComponent(TEAM)}">Acme Rentals</a><span class="sub short" title="${TEAM}">${TEAM.slice(0, 13)}…${TEAM.slice(-6)}</span>`;

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
      await tx`SELECT slotlock.staff_console_key(${sha(CONSOLE_KEY)}, 'cli:ops')`;
      await tx`SELECT slotlock.staff_add('github:1001', 'owner', 'cli:ops', ${sha('owner-code')}, ${new Date(Date.now() + 86_400_000)})`;
    });
    adminSql = postgres(Object.assign(new URL(target.href), { username: adminRole, password }).href, { max: 4, onnotice: () => undefined });

    await superuser`INSERT INTO slotlock.dashboard_people (person_ref, display, name) VALUES (${ADA}, '@ada', 'Ada Lovelace')`;
    await superuser`INSERT INTO slotlock.workspaces (tenant_ref, handle, name, created_by) VALUES (${TEAM}, ${`acme-${BASE}`}, 'Acme Rentals', ${ADA})`;
    // Ada's paid plan is set to end; the team is near the quota its override gives.
    await superuser`
      INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints,
                                         stripe_customer, stripe_subscription, ends_at)
      VALUES (${ADA}, 'developer', 'active', 100, 10, 10, 'cus_Names1', 'sub_Names1', ${ENDS})`;
    await superuser`
      INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints)
      VALUES (${TEAM}, 'team', 'active', 500, 50, 25)`;
    await superuser`
      INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, origin, count)
      VALUES (${TEAM}, (now() AT TIME ZONE 'UTC')::date, 'operations', 'rest', 900)`;
    // Ada has used 4% of Developer's operations: the most of anyone's, and nowhere near her quota.
    await superuser`
      INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, origin, count)
      VALUES (${ADA}, (now() AT TIME ZONE 'UTC')::date, 'operations', 'rest', 20000)`;
    await superuser`SELECT slotlock.note_billing_event('payment_failed', ${ADA}, 'in_Names1', ${superuser.json({ amount_due: 1900, currency: 'gbp' })})`;
    // What staff did: a case and a privacy request about Ada, and an override for the team.
    const session = await staffSession(superuser, 'github:1001');
    caseId = String((await superuser<{ id: string }[]>`SELECT slotlock.admin_case_open(${session}, ${ADA}, 'staff', 'Spam bookings', NULL, NULL) AS id`)[0]?.id);
    requestId = String((await superuser<{ id: string }[]>`
      SELECT slotlock.admin_privacy_open(${session}, ${ADA}, 'access', 'account', (now() AT TIME ZONE 'UTC')::date, 'Privacy thread 1') AS id`)[0]?.id);
    await superuser`
      SELECT slotlock.admin_override_create(${session}, ${TEAM}, NULL, 1000, 100, 20, 1000, 100, NULL, ${new Date(Date.now() + 10 * 86_400_000)}, 'Pilot')`;
    // A notice to Ada, a feature turned off for the team, and Ada's maintenance failing.
    await superuser`
      SELECT slotlock.admin_announce(${session}, 'account', NULL, ${ADA}, 'notice', 'Your plan changes on Monday.', NULL, NULL, ${new Date(Date.now() + 5 * 86_400_000)})`;
    await superuser`SELECT slotlock.admin_flag_set(${session}, 'assistant', NULL, ${TEAM}, false, 'Paused for the pilot')`;
    await superuser`INSERT INTO slotlock.maintenance_failures (tenant_ref, error, code, message) VALUES (${ADA}, 'Error', 'XX000', 'Could not extend a series')`;

    admin = createSlotlockAdmin({
      sql: () => adminSql,
      publicUrl: ORIGIN,
      sessionSecret: 'a-test-session-secret-of-forty-characters',
      consoleKey: CONSOLE_KEY,
      github: { clientId: 'client-id', clientSecret: 'client-secret' },
      access: { verify: async (request: Request) => (request.headers.get('cf-access-jwt-assertion') === 'ok' ? { email: 'staff@example.com', sub: 'sub-1' } : null) },
      fetch: createGithubSignInFetch({ 'code-owner': { id: 1001, login: 'octo-owner' } }, {}),
    });
    browser = new Browser(() => admin);
    expect((await browser.signIn('code-owner')).headers.get('location')).toBe('/passkey');
    expect((await browser.createPasskey(new SoftwarePasskey(), { code: 'owner-code' })).status).toBe(200);
  });

  afterAll(async () => {
    await adminSql?.end({ timeout: 5 });
    await superuser?.end();
    await root?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [adminRole, owner]) await root?.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await root?.end();
  });

  it("names the account in Home's cases", async () => {
    const cases = between(await text('/'), 'id="cases-title"', '</section>');
    // Under the case, on one line: a small avatar, the name and the reference.
    expect(cases).toContain(`<span class="ac compact"><span class="avatar avatar-t`);
    expect(cases).toContain(`<a href="/accounts/${encodeURIComponent(ADA)}">Ada Lovelace</a><span class="sub">${ADA}</span>`);
  });

  it("names the accounts in Billing's Needs a person, overrides, alerts and Ending", async () => {
    const billing = await text('/billing');
    expect(between(billing, 'id="alerts-preview"', '</section>')).toContain(adaCell);
    expect(between(billing, 'id="overrides-preview"', '</section>')).toContain(teamCell);
    expect(between(between(billing, 'id="ending"', '</table>'), '<tbody>', '</tbody>')).toContain(adaCell);
    expect(between(between(billing, 'id="alerts"', '</table>'), '<tbody>', '</tbody>')).toContain(adaCell);
    expect(between(between(billing, 'id="overrides"', '</table>'), '<tbody>', '</tbody>')).toContain(teamCell);
    // The forms that pick an alert or an override say whose it is by name too.
    expect(billing).toContain('Payment failed · Ada Lovelace · in_Names1</option>');
    expect(billing).toMatch(/<option value="\d+">Acme Rentals · its own plan until /);
  });

  it('names the accounts near their quotas, on Usage and on Accounts', async () => {
    expect(between(between(await text('/usage'), '>Near quota<', '</table>'), '<tbody>', '</tbody>')).toContain(teamCell);
    expect(between(await text('/accounts?view=near_quota'), '<tbody>', '</tbody>')).toContain(teamCell);
  });

  it('counts as near quota only an account at 80% of a quota or more, on Usage and on Accounts alike', async () => {
    const usage = between(between(await text('/usage'), '>Near quota<', '</table>'), '<tbody>', '</tbody>');
    const accounts = await text('/accounts?view=near_quota');
    // The team at 90% of the operations its override gives; never Ada at 4%, however busy.
    for (const listed of [usage, between(accounts, '<tbody>', '</tbody>')]) {
      expect(listed).toContain(teamCell);
      expect(listed).not.toContain(`href="/accounts/${encodeURIComponent(ADA)}"`);
    }
    expect(accounts).toContain('>Near quota<span class="count">1</span>');
  });

  it('names the account in the case and privacy queues and on their records', async () => {
    const queue = (page: string) => between(page, '<ul class="queue">', '</ul>');
    // In a queue the row is the link, so the account is named without one of its own.
    expect(queue(await text('/cases'))).toContain(`<span>Ada Lovelace</span><span class="sub">${ADA}</span>`);
    expect(queue(await text('/privacy'))).toContain(`<span>Ada Lovelace</span><span class="sub">${ADA}</span>`);
    expect(between(await text(`/cases/${caseId}`), 'class="inspector"', '</aside>')).toContain(adaCell);
    expect(between(await text(`/privacy/${requestId}`), 'class="inspector"', '</aside>')).toContain(adaCell);
  });

  it("names the account in the Staff log's Account column, its filter and an entry", async () => {
    const log = await text('/staff/log');
    const rows = between(log, '<tbody>', '</tbody>');
    expect(rows).toContain(adaCell);
    expect(rows).not.toContain(`class="mono">${ADA}</a>`);
    expect(log).toMatch(new RegExp(`<a class="menu-item" href="[^"]*account=${encodeURIComponent(ADA)}[^"]*">Ada Lovelace</a>`));
    const entry = /href="(\/staff\/log\?entry=\d+)"/.exec(rows.slice(rows.lastIndexOf('<tr', rows.indexOf(adaCell))))?.[1];
    expect(entry).toBeDefined();
    expect(between(await text(entry ?? ''), '<aside class="drawer"', '</aside>')).toContain(adaCell);
  });

  it('names the accounts on Communications and on System', async () => {
    expect(between(await text('/communications'), '<tbody>', '</tbody>')).toContain(adaCell);
    const system = await text('/system');
    expect(between(between(system, 'id="maintenance"', '</table>'), '<tbody>', '</tbody>')).toContain(adaCell);
    const flags = between(system, '>Feature flags<', '</section>');
    expect(between(flags, '<tbody>', '</tbody>')).toContain(teamCell);
    // Its change, in the flags' history, says whose by name too.
    expect(flags).toContain('<span class="sub">Acme Rentals</span>');
  });

  it("names the account in the typeahead as the account cell draws it", async () => {
    const response = await browser.request('/accounts?format=json&q=Lovelace');
    expect(await response.json()).toEqual([{ ref: ADA, label: 'Ada Lovelace', sub: `@ada · ${ADA}`, initials: 'AL', tone: expect.any(Number), kind: 'person' }]);
  });
});
