// Privacy requests in the admin console (RFC 0006, M7, Phase 5) end to end against real PostgreSQL:
// a request is logged without the requester's address, verified by a key the account holder names
// with the word staff sent, answered with an export that opens and holds every table it promises, or
// with an erasure in an order that cannot change (Stripe first, a second Owner, erase, a receipt)
// that leaves a receipt and no data. Each step is in the staff log, and the roles hold in the
// database. Records past their six years go. Needs a role that creates databases and roles;
// skipped without DATABASE_URL.
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAdmin, createSlotlockAdmin } from '../admin/app.js';
import { createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { maintainSlotlockTenant } from '../maintenance.js';
import { SLOTLOCK_PRIVACY_EXPORT_DAYS } from '../staff-ddl.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { SLOTLOCK_TENANT_EXPORT_TABLES } from '../types.js';
import { Browser, ORIGIN, SoftwarePasskey, createGithubSignInFetch, sha } from './helpers/admin-browser.js';

const url = process.env.DATABASE_URL?.trim();
const PEOPLE: Record<string, { id: number; login: string }> = {
  'code-owner': { id: 1001, login: 'octo-owner' },
  'code-support': { id: 1002, login: 'octo-support' },
  'code-billing': { id: 1003, login: 'octo-billing' },
  'code-owner-2': { id: 1005, login: 'octo-owner-two' },
};
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];
const HOUR = 3_600_000;

describe.skipIf(!url)('privacy requests in the admin console (real Postgres)', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_privacy_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const adminRole = `slotlock_admin_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let root: postgres.Sql;
  let superuser: postgres.Sql;
  let adminSql: postgres.Sql;
  let admin: SlotlockAdmin;
  let store: SlotlockStore;
  const clock = Date.now();
  const browsers: Record<'owner' | 'owner2' | 'support' | 'billing', Browser> = {} as never;
  const ACCOUNT = 'github:424242';
  const OTHER = 'github:434343';

  const context = (tenantRef: string) =>
    ({ principal: { tenantRef, scopes: ['admin'] }, signal: new AbortController().signal }) as never;
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
  const today = () => new Date(clock).toISOString().slice(0, 10);
  async function logRequest(browser: Browser, fields: Record<string, string>) {
    const made = await form(browser, '/privacy', { account: ACCOUNT, kind: 'access', concerns: 'account', received: today(), reference: 'Privacy mailbox: Your data, please', ...fields }, '/privacy');
    const location = made.headers.get('location') ?? '';
    return { location, id: /^\/privacy\/(\d+)\?done=privacy_opened$/.exec(location)?.[1] ?? '' };
  }
  const requestRow = async (id: string) =>
    (await superuser<Record<string, unknown>[]>`SELECT * FROM slotlock.privacy_requests WHERE id = ${id}::bigint`)[0] ?? {};
  const log = async (staff: string) =>
    (await superuser<{ action: string }[]>`
      SELECT action FROM slotlock.staff_audit_events WHERE staff_ref = ${staff} AND action LIKE 'privacy.%' ORDER BY chain_index`).map((row) => row.action);
  /** A key named with the request's word, made by the account holder after the request. */
  async function prove(id: string, createdBy = ACCOUNT, account = ACCOUNT) {
    const word = String((await requestRow(id)).verification_word);
    return createSlotlockApiKeyStore(superuser).create({ tenantRef: account, name: word, scopes: ['read'], createdBy });
  }
  /** Rows the account has in each table with a tenant column. */
  async function rowsByTable(account: string) {
    const tables = await superuser<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'slotlock' AND column_name = 'tenant_ref'
         AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema = 'slotlock' AND table_type = 'BASE TABLE')`;
    const counts: Record<string, number> = {};
    for (const { table_name } of tables) {
      const [row] = await superuser.unsafe<{ count: string }[]>(`SELECT count(*) FROM slotlock.${table_name} WHERE tenant_ref = $1`, [account]);
      counts[table_name] = Number(row?.count ?? 0);
    }
    return counts;
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
      const ownerStore = createSlotlockStore(tx);
      await ownerStore.applySchema();
      await ownerStore.applyTenantRls();
      await ownerStore.grantAdminRole(adminRole);
      const expires = new Date(Date.now() + 86_400_000);
      await tx`SELECT slotlock.staff_add('github:1001', 'owner', 'cli:ops', ${sha('owner-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1002', 'support', 'cli:ops', ${sha('support-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1003', 'billing', 'cli:ops', ${sha('billing-code')}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1005', 'owner', 'cli:ops', ${sha('owner-two-code')}, ${expires})`;
    });
    const asAdmin = new URL(target.href);
    asAdmin.username = adminRole;
    asAdmin.password = password;
    adminSql = postgres(asAdmin.href, { max: 4, onnotice: () => undefined });
    store = createSlotlockStore(superuser, { defaultAvailabilityRules: ALL_DAY });

    // The account: a person paying for Developer, with calendars, a contact, a booking, a webhook and
    // a key; its test environment; and another account, which nothing here touches.
    for (const person of [ACCOUNT, OTHER]) await superuser`INSERT INTO slotlock.dashboard_people (person_ref) VALUES (${person})`;
    await superuser`
      INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints,
                                         stripe_customer, stripe_subscription)
      VALUES (${ACCOUNT}, 'developer', 'active', 100, 100, 10, 'cus_PRIVACY1', 'sub_PRIVACY1')`;
    const app = createSlotlockStoreApplicationBackend(store);
    const day = Date.UTC(new Date(clock).getUTCFullYear() + 1, 4, 5);
    for (const account of [ACCOUNT, `${ACCOUNT}~test`, OTHER]) {
      const { resource } = (await app.createResource(context(account), { external_ref: 'van', timezone: 'UTC' })) as { resource: { id: string } };
      await app.putContact(context(account), { contact_ref: 'customer-1', email: 'ada@example.com' });
      await app.putReservation(context(account), {
        reservation_ref: 'booking-1', resource_id: resource.id, start: new Date(day + 9 * HOUR).toISOString(),
        end: new Date(day + 10 * HOUR).toISOString(), revision: 1, contact_ref: 'customer-1', buffer_after_minutes: 0,
      });
      await app.createWebhook(context(account), { url: 'https://hooks.example.com/slotlock' });
      await createSlotlockApiKeyStore(superuser).create({ tenantRef: account, name: 'booking agent', scopes: ['read', 'write'], createdBy: ACCOUNT });
    }
    await superuser`
      INSERT INTO slotlock.account_notes (account_ref, staff_ref, body) VALUES (${ACCOUNT}, 'github:1002', 'Asked about invoices.')`;
    await superuser`
      INSERT INTO slotlock.abuse_cases (account_ref, source, summary, opened_by) VALUES (${ACCOUNT}, 'report', 'Spam bookings', 'github:1002')`;
    await superuser`
      INSERT INTO slotlock.admin_cache (key, value, expires_at)
      VALUES ('account:stripe:cus_PRIVACY1', '{"subscriptions": []}', now() + interval '1 hour')`;

    admin = createSlotlockAdmin({
      sql: () => adminSql,
      publicUrl: ORIGIN,
      sessionSecret: 'a-test-session-secret-of-forty-characters',
      github: { clientId: 'client-id', clientSecret: 'client-secret' },
      access: { verify: async (request) => (request.headers.get('cf-access-jwt-assertion') === 'ok' ? { email: 'staff@example.com', sub: 'sub-1' } : null) },
      fetch: createGithubSignInFetch(PEOPLE, {}),
      now: () => clock,
    });
    browsers.owner = await signedIn('code-owner', 'owner-code');
    browsers.owner2 = await signedIn('code-owner-2', 'owner-two-code');
    browsers.support = await signedIn('code-support', 'support-code');
    browsers.billing = await signedIn('code-billing', 'billing-code');
  });

  afterAll(async () => {
    await adminSql?.end({ timeout: 5 });
    await superuser?.end();
    await root?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [adminRole, owner]) await root?.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await root?.end();
  });

  it('gives Owners and Support the queue, and Billing nothing', async () => {
    const queue = await browsers.support.request('/privacy');
    expect(queue.status).toBe(200);
    expect(await queue.text()).toContain('No open requests.');
    expect((await browsers.billing.request('/privacy')).status).toBe(403);
    expect(await (await browsers.billing.request('/')).text()).not.toContain('href="/privacy"');
    await expect(adminSql`SELECT slotlock.admin_privacy_open('github:1003', ${ACCOUNT}, 'access', 'account', current_date, 'x')`).rejects.toMatchObject({ code: '42501' });
  });

  it('logs a request without the person’s address, and refuses one it cannot keep', async () => {
    const withAddress = await form(browsers.support, '/privacy', { account: ACCOUNT, kind: 'access', concerns: 'account', received: today(), reference: 'From ada@example.com' }, '/privacy');
    expect(withAddress.headers.get('location')).toBe('/privacy?error=privacy_invalid');
    const tomorrow = new Date(clock + 86_400_000).toISOString().slice(0, 10);
    expect((await form(browsers.support, '/privacy', { account: ACCOUNT, kind: 'access', concerns: 'account', received: tomorrow, reference: 'Thread 1' }, '/privacy')).headers.get('location'))
      .toBe('/privacy?error=privacy_invalid');
    expect((await form(browsers.support, '/privacy', { account: 'github:999999', kind: 'access', concerns: 'account', received: today(), reference: 'Thread 1' }, '/privacy')).headers.get('location'))
      .toBe('/privacy?error=privacy_invalid');
    expect(await superuser`SELECT 1 FROM slotlock.privacy_requests`).toHaveLength(0);

    const { id } = await logRequest(browsers.support, {});
    const row = await requestRow(id);
    expect(row).toMatchObject({ account_ref: ACCOUNT, kind: 'access', concerns: 'account', status: 'open' });
    expect(String(row.verification_word)).toMatch(/^slotlock-[0-9a-f]{10}$/);
    // Due a month after it arrived.
    const due = new Date(`${today()}T00:00:00Z`);
    due.setUTCMonth(due.getUTCMonth() + 1);
    expect((row.due_on as Date).toISOString().slice(0, 10)).toBe(due.toISOString().slice(0, 10));
    const page = await (await browsers.support.request(`/privacy/${id}`)).text();
    expect(page).toContain(String(row.verification_word));
    expect(page).toContain('Check for the key');
  });

  it('answers a verified access request with an export that opens and holds every table it promises', async () => {
    const { id } = await logRequest(browsers.support, { reference: 'Thread 2: a copy of my data' });
    // Not before it is verified, nor by a key made before the request, or by someone else.
    expect((await form(browsers.support, `/privacy/${id}/export`, {}, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?error=privacy_needs_verifying`);
    expect((await form(browsers.support, `/privacy/${id}/verify`, {}, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?error=privacy_not_verified`);
    await prove(id, OTHER);
    expect((await form(browsers.support, `/privacy/${id}/verify`, {}, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?error=privacy_not_verified`);
    const key = await prove(id);
    expect((await form(browsers.support, `/privacy/${id}/verify`, {}, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?done=privacy_verified`);
    expect(await requestRow(id)).toMatchObject({ verified_by: 'github:1002', verified_key: key.key.slice(0, 12) });

    expect((await form(browsers.support, `/privacy/${id}/export`, {}, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?done=privacy_export_started`);
    const [made] = await superuser<{ id: string; status: string; requested_by: string; expires_at: Date }[]>`
      SELECT id, status, requested_by, expires_at FROM slotlock.tenant_exports WHERE tenant_ref = ${ACCOUNT}`;
    expect(made).toMatchObject({ status: 'pending', requested_by: `privacy:${id}` });
    // The account sees that staff asked for it (E8).
    const [audited] = await superuser<{ actor_ref: string; target_ref: string }[]>`
      SELECT actor_ref, target_ref FROM slotlock.audit_events WHERE tenant_ref = ${ACCOUNT} AND action = 'export.created'`;
    expect(audited).toEqual({ actor_ref: 'slotlock-staff:support', target_ref: made?.id });
    // A second while it is being built is refused.
    const { id: second } = await logRequest(browsers.owner, { kind: 'export', reference: 'Thread 3: my data to move' });
    await prove(second);
    await form(browsers.owner, `/privacy/${second}/verify`, {}, `/privacy/${second}`);
    expect((await form(browsers.owner, `/privacy/${second}/export`, {}, `/privacy/${second}`)).headers.get('location')).toBe(`/privacy/${second}?error=privacy_export_busy`);
    expect((await requestRow(second)).export_id).toBeNull();

    // The hourly maintenance builds it once it has waited, and keeps it a week, not a day.
    await superuser`UPDATE slotlock.tenant_exports SET created_at = now() - interval '5 minutes' WHERE id = ${made?.id ?? ''}::uuid`;
    await maintainSlotlockTenant(store, ACCOUNT);
    const [built] = await superuser<{ status: string; finished_at: Date; expires_at: Date; tables: Record<string, number>; parts: number }[]>`
      SELECT status, finished_at, expires_at, tables, parts FROM slotlock.tenant_exports WHERE id = ${made?.id ?? ''}::uuid`;
    expect(built?.status).toBe('ready');
    expect((built?.expires_at.getTime() ?? 0) - (built?.finished_at.getTime() ?? 0)).toBe(SLOTLOCK_PRIVACY_EXPORT_DAYS * 86_400_000);

    // It opens: every part reads, and it holds every table it promises, as many rows as the account has.
    const read: Record<string, unknown[]> = {};
    for (let part = 1; part <= (built?.parts ?? 0); part++) {
      const got = await store.withTenant(ACCOUNT, (tenant) => tenant.getTenantExportPart({ tenantRef: ACCOUNT, exportId: made?.id ?? '', part }));
      if (!got.ok) throw new Error(got.code);
      read[got.table] = [...(read[got.table] ?? []), ...got.lines.map((line) => JSON.parse(line) as unknown)];
    }
    const kept = await rowsByTable(ACCOUNT);
    for (const table of SLOTLOCK_TENANT_EXPORT_TABLES) {
      expect(read[table]?.length ?? 0, table).toBe(kept[table] ?? 0);
    }
    for (const table of ['resources', 'contacts', 'reservations', 'webhook_endpoints', 'api_keys', 'outbox', 'audit_events']) {
      expect(read[table]?.length ?? 0, table).toBeGreaterThan(0);
    }
    expect(built?.tables).toEqual(Object.fromEntries(Object.entries(read).map(([table, rows]) => [table, rows.length])));
    // No secrets, and nothing of another account.
    expect(JSON.stringify(read)).not.toContain('secret_hash');
    expect(JSON.stringify(read)).not.toContain('"tenant_ref"');

    // Staff see its counts, never its rows; then they close it.
    const page = await (await browsers.support.request(`/privacy/${id}`)).text();
    expect(page).toContain('Ready');
    expect(page).toContain('<code>reservations</code>');
    expect(page).not.toContain('ada@example.com');
    expect((await form(browsers.support, `/privacy/${id}/close`, { status: 'done', outcome: 'Export on their Privacy page; told them by reply.' }, `/privacy/${id}`)).headers.get('location'))
      .toBe(`/privacy/${id}?done=privacy_closed`);
    expect(await log('github:1002')).toEqual(expect.arrayContaining(['privacy.opened', 'privacy.verification_failed', 'privacy.verified', 'privacy.export_started', 'privacy.closed']));
  });

  it('passes a request about an account’s customer on to the account holder', async () => {
    const { id } = await logRequest(browsers.support, { kind: 'erasure', concerns: 'customer', reference: 'Thread 4: a customer of the account' });
    const page = await (await browsers.support.request(`/privacy/${id}`)).text();
    expect(page).toContain('Pass it on to the account holder');
    expect(page).not.toContain('Check for the key');
    expect((await form(browsers.support, `/privacy/${id}/close`, { status: 'done', outcome: 'x' }, `/privacy/${id}`)).status).toBe(303);
    expect((await requestRow(id)).status).toBe('done');
    const { id: other } = await logRequest(browsers.support, { kind: 'erasure', reference: 'Thread 5' });
    expect((await form(browsers.support, `/privacy/${other}/close`, { status: 'done', outcome: 'x' }, `/privacy/${other}`)).headers.get('location')).toBe(`/privacy/${other}?error=privacy_invalid`);
    expect((await form(browsers.support, `/privacy/${other}/close`, { status: 'passed_on', outcome: 'x' }, `/privacy/${other}`)).headers.get('location')).toBe(`/privacy/${other}?error=privacy_invalid`);
    expect((await form(browsers.support, `/privacy/${other}/close`, { status: 'withdrawn', outcome: 'They wrote back to withdraw it.' }, `/privacy/${other}`)).headers.get('location')).toBe(`/privacy/${other}?done=privacy_closed`);
  });

  it('erases in an order that cannot change, and leaves a receipt and no data', async () => {
    const { id } = await logRequest(browsers.owner, { kind: 'erasure', reference: 'Thread 6: erase my account' });
    // Support logs and verifies, but neither asks nor approves an erasure.
    await prove(id);
    expect((await form(browsers.support, `/privacy/${id}/verify`, {}, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?done=privacy_verified`);
    expect((await form(browsers.support, `/privacy/${id}/erasure/ask`, {}, `/privacy/${id}`)).status).toBe(403);
    await expect(adminSql`SELECT slotlock.admin_privacy_erasure_ask('github:1002', ${id}::bigint)`).rejects.toMatchObject({ code: '42501' });
    // 1. Stripe first: nothing is asked for, approved or erased while it still charges the account.
    expect((await form(browsers.owner, `/privacy/${id}/erasure/ask`, {}, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?error=privacy_subscription_live`);
    expect((await form(browsers.owner, `/privacy/${id}/erase`, { confirm: 'yes' }, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?error=privacy_not_approved`);
    expect(await (await browsers.owner.request(`/privacy/${id}`)).text()).toContain('Open the customer in Stripe');
    const before = await rowsByTable(ACCOUNT);
    expect(before.resources).toBe(1);
    // Stripe's webhook records the cancellation.
    await superuser`UPDATE slotlock.tenant_plans SET plan = 'free', status = 'canceled', stripe_subscription = NULL WHERE tenant_ref = ${ACCOUNT}`;
    // 2. A second Owner approves; the one who asked cannot.
    expect((await form(browsers.owner, `/privacy/${id}/erase`, { confirm: 'yes' }, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?error=privacy_not_approved`);
    expect((await form(browsers.owner, `/privacy/${id}/erasure/ask`, {}, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?done=privacy_erasure_asked`);
    expect((await form(browsers.owner, `/privacy/${id}/erasure/approve`, {}, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?error=privacy_erasure_own`);
    expect((await form(browsers.owner2, `/privacy/${id}/erasure/approve`, {}, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?done=privacy_erasure_approved`);
    // A subscription taken out again in between stops the erasure itself.
    await superuser`UPDATE slotlock.tenant_plans SET stripe_subscription = 'sub_AGAIN' WHERE tenant_ref = ${ACCOUNT}`;
    expect((await form(browsers.owner, `/privacy/${id}/erase`, { confirm: 'yes' }, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?error=privacy_subscription_live`);
    await superuser`UPDATE slotlock.tenant_plans SET stripe_subscription = NULL WHERE tenant_ref = ${ACCOUNT}`;
    // 3. Erase, with its confirmation.
    expect((await form(browsers.owner, `/privacy/${id}/erase`, {}, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?error=invalid`);
    const otherBefore = await rowsByTable(OTHER);
    expect((await form(browsers.owner, `/privacy/${id}/erase`, { confirm: 'yes' }, `/privacy/${id}`)).headers.get('location')).toBe(`/privacy/${id}?done=privacy_erased`);

    // No data: every table with a tenant column holds nothing of the account or its test
    // environment, but the suspension record (none here); the other account is untouched.
    for (const account of [ACCOUNT, `${ACCOUNT}~test`]) {
      const after = await rowsByTable(account);
      for (const [table, rows] of Object.entries(after)) expect(rows, `${account} ${table}`).toBe(0);
    }
    expect(await rowsByTable(OTHER)).toEqual(otherBefore);
    expect(await superuser`SELECT 1 FROM slotlock.dashboard_people WHERE person_ref = ${ACCOUNT}`).toHaveLength(0);
    expect(await superuser`SELECT 1 FROM slotlock.account_notes WHERE account_ref = ${ACCOUNT}`).toHaveLength(0);
    expect(await superuser`SELECT account_ref FROM slotlock.abuse_cases`).toEqual([{ account_ref: null }]);
    expect(await superuser`SELECT 1 FROM slotlock.admin_cache WHERE key = 'account:stripe:cus_PRIVACY1'`).toHaveLength(0);
    // Nor do the privacy requests name it any more.
    expect(await superuser`SELECT 1 FROM slotlock.privacy_requests WHERE account_ref = ${ACCOUNT}`).toHaveLength(0);
    expect(await requestRow(id)).toMatchObject({ status: 'done', outcome: 'Erased', account_ref: null });

    // A receipt: the request, the account's digest, how many rows, who asked, approved and erased.
    const [salt] = await superuser<{ salt: string }[]>`SELECT salt FROM slotlock.privacy_keys`;
    const digest = createHash('sha256').update(`${salt?.salt}:${ACCOUNT}`).digest('hex');
    const receipts = await superuser<Record<string, unknown>[]>`SELECT * FROM slotlock.privacy_erasure_receipts`;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ request_id: id, account_digest: digest, asked_by: 'github:1001', approved_by: 'github:1005', erased_by: 'github:1001' });
    expect(Number(receipts[0]?.rows_erased)).toBeGreaterThan(10);
    expect(JSON.stringify(receipts)).not.toContain('424242');
    const page = await (await browsers.owner.request(`/privacy/${id}`)).text();
    expect(page).toContain('Erased');
    expect(page).toContain(`digest ${digest.slice(0, 16)}`);
    // Asked about later, the receipt is found by the account's reference, which is not recorded.
    const found = await (await browsers.support.request(`/privacy/receipts?account=${encodeURIComponent(ACCOUNT)}`)).text();
    expect(found).toContain(`/privacy/${id}`);
    expect(await (await browsers.support.request(`/privacy/receipts?account=${encodeURIComponent(OTHER)}`)).text()).toContain('No receipt');
    expect(await log('github:1001')).toEqual(expect.arrayContaining(['privacy.erasure_asked', 'privacy.erasure_approval_refused', 'privacy.erasure_refused', 'privacy.erased']));
    expect(await log('github:1005')).toContain('privacy.erasure_approved');
  });

  it('puts requests due within a week on Home', async () => {
    const received = new Date(clock - 26 * 86_400_000).toISOString().slice(0, 10);
    await form(browsers.owner, '/privacy', { account: OTHER, kind: 'correction', concerns: 'account', received, reference: 'Thread 7: wrong name' }, '/privacy');
    const home = await (await browsers.owner.request('/')).text();
    expect(home).toMatch(/1 privacy request is due within a week or overdue/);
  });

  it('keeps the staff log, closed cases and closed requests six years, then lets them go', async () => {
    await superuser`
      INSERT INTO slotlock.staff_audit_events (staff_ref, action, occurred_at, metadata)
      VALUES ('github:1001', 'home.viewed', now() - interval '7 years', '{}')`;
    await superuser`
      INSERT INTO slotlock.abuse_cases (source, summary, opened_by, status, closed_by, closed_at)
      VALUES ('staff', 'An old case', 'github:1001', 'closed', 'github:1001', now() - interval '7 years')`;
    const [kept] = await superuser<{ id: string }[]>`
      INSERT INTO slotlock.abuse_cases (source, summary, opened_by, status, closed_by, closed_at)
      VALUES ('staff', 'A recent case', 'github:1001', 'closed', 'github:1001', now() - interval '1 year') RETURNING id`;
    // A recent event cannot be removed, by anyone.
    await expect(superuser`DELETE FROM slotlock.staff_audit_events WHERE occurred_at > now() - interval '1 day'`).rejects.toMatchObject({ code: '42501' });
    // The next staff action takes what is past its time.
    await adminSql`SELECT slotlock.admin_home('github:1001')`;
    expect(await superuser`SELECT 1 FROM slotlock.staff_audit_events WHERE occurred_at < now() - interval '6 years'`).toHaveLength(0);
    expect((await superuser<{ summary: string }[]>`SELECT summary FROM slotlock.abuse_cases WHERE status = 'closed'`).map((row) => row.summary)).toEqual(['A recent case']);
    expect(kept?.id).toBeDefined();
  });
});
