// The admin console (src/admin/app.ts, RFC 0006) end to end against real PostgreSQL: Cloudflare
// Access, GitHub sign-in (a fake GitHub), a passkey made and used by a software authenticator, the
// pages each role may open, the forms' origin and token checks, and the staff log each step writes.
// Needs a role that creates databases and roles; skipped without DATABASE_URL.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAdmin, createSlotlockAdmin } from '../admin/app.js';
import { createSlotlockStore } from '../store.js';
import { Browser, CONSOLE_KEY, ORIGIN, SoftwarePasskey, b64u, createGithubSignInFetch, sha, staffSession } from './helpers/admin-browser.js';

const url = process.env.DATABASE_URL?.trim();

// ---------- A fake GitHub ----------
const PEOPLE: Record<string, { id: number; login: string }> = {
  'code-owner': { id: 1001, login: 'octo-owner' },
  'code-support': { id: 1002, login: 'octo-support' },
  'code-viewer': { id: 1003, login: 'octo-viewer' },
  'code-stranger': { id: 9999, login: 'octo-stranger' },
};
const PROFILES: Record<string, { id: number; login: string; type: string }> = {
  someone: { id: 424242, login: 'someone', type: 'User' },
};
const githubFetch = createGithubSignInFetch(PEOPLE, PROFILES);

describe.skipIf(!url)('admin console (real Postgres)', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_console_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const serving = `slotlock_app_${suffix}`;
  const adminRole = `slotlock_admin_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let root: postgres.Sql;
  let superuser: postgres.Sql;
  let adminSql: postgres.Sql;
  let admin: SlotlockAdmin;
  let clock = Date.now();

  const OWNER_CODE = 'owner-enrollment-code';
  const SUPPORT_CODE = 'support-enrollment-code';
  const VIEWER_CODE = 'viewer-enrollment-code';
  const PERSON = 'github:424242';
  const ownerKey = new SoftwarePasskey();
  const browsers = { owner: () => new Browser(() => admin) };

  async function asOwner<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return (await superuser.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`);
      return work(tx);
    })) as T;
  }
  const log = async (staff: string) =>
    (await superuser<{ action: string; account_ref: string | null }[]>`
      SELECT action, account_ref FROM slotlock.staff_audit_events WHERE staff_ref = ${staff} ORDER BY chain_index`).map(
      (row) => row.action,
    );

  /** A member signed in all the way: GitHub, then a new passkey with their code. */
  async function fullySignedIn(code: string, enrollment: string, passkey = new SoftwarePasskey()) {
    const browser = browsers.owner();
    const callback = await browser.signIn(code);
    expect(callback.headers.get('location')).toBe('/passkey');
    const created = await browser.createPasskey(passkey, { code: enrollment });
    expect(created.status).toBe(200);
    return { browser, passkey };
  }

  beforeAll(async () => {
    root = postgres(url as string, { max: 1, onnotice: () => undefined });
    await root.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await root.unsafe(`CREATE ROLE ${serving} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await root.unsafe(`CREATE ROLE ${adminRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await root.unsafe(`CREATE DATABASE ${database}`);
    await root.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    superuser = postgres(target.href, { max: 2, onnotice: () => undefined });
    await asOwner(async (tx) => {
      const store = createSlotlockStore(tx);
      await store.applySchema();
      await store.applyTenantRls();
      await store.grantApplicationRole(serving);
      await store.grantAdminRole(adminRole);
    });
    const asAdmin = new URL(target.href);
    asAdmin.username = adminRole;
    asAdmin.password = password;
    adminSql = postgres(asAdmin.href, { max: 4, onnotice: () => undefined });

    await asOwner(async (tx) => {
      const expires = new Date(Date.now() + 86_400_000);
      await tx`SELECT slotlock.staff_console_key(${sha(CONSOLE_KEY)}, 'cli:ops')`;
      await tx`SELECT slotlock.staff_add('github:1001', 'owner', 'cli:ops', ${sha(OWNER_CODE)}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1002', 'support', 'cli:ops', ${sha(SUPPORT_CODE)}, ${expires})`;
      await tx`SELECT slotlock.staff_add('github:1003', 'viewer', 'cli:ops', ${sha(VIEWER_CODE)}, ${expires})`;
    });
    await superuser`INSERT INTO slotlock.dashboard_people (person_ref) VALUES (${PERSON})`;
    await superuser`
      INSERT INTO slotlock.api_keys (tenant_ref, name, prefix, secret_hash, scopes)
      VALUES (${PERSON}, 'booking-agent', 'slk_AbCd1234', ${sha('secret')}, ARRAY['read', 'write'])`;
    await superuser`
      INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys,
                                         max_webhook_endpoints, stripe_customer, stripe_subscription)
      VALUES (${PERSON}, 'developer', 'active', 100, 100, 10, 'cus_TEST123', 'sub_TEST123')`;
    const today = new Date().toISOString().slice(0, 10);
    await superuser`
      INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, origin, count)
      VALUES (${PERSON}, ${today}, 'operations', 'mcp', 40), (${PERSON}, ${today}, 'bookings', 'mcp', 3)`;

    admin = createSlotlockAdmin({
      sql: () => adminSql,
      publicUrl: ORIGIN,
      sessionSecret: 'a-test-session-secret-of-forty-characters', consoleKey: CONSOLE_KEY,
      github: { clientId: 'client-id', clientSecret: 'client-secret' },
      access: { verify: async (request) => (request.headers.get('cf-access-jwt-assertion') === 'ok' ? { email: 'staff@example.com', sub: 'sub-1' } : null) },
      fetch: githubFetch,
      now: () => clock,
    });
  });

  afterAll(async () => {
    await adminSql?.end({ timeout: 5 });
    await superuser?.end();
    await root?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [serving, adminRole, owner]) await root?.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await root?.end();
  });

  it('refuses every request without Cloudflare Access, but serves its own static files', async () => {
    const browser = new Browser(() => admin, '');
    expect((await browser.request('/')).status).toBe(403);
    expect((await browser.request('/sign-in')).status).toBe(403);
    const css = await browser.request('/admin.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(() =>
      createSlotlockAdmin({ sql: () => adminSql, publicUrl: ORIGIN, sessionSecret: 'x'.repeat(40), consoleKey: CONSOLE_KEY, github: { clientId: 'a', clientSecret: 'b' }, access: null }),
    ).toThrow(/Cloudflare Access/);
  });

  it('sends a browser with no session to sign in, with headers that keep the console private', async () => {
    const browser = browsers.owner();
    const home = await browser.request('/');
    expect(home.status).toBe(303);
    expect(home.headers.get('location')).toBe('/sign-in');
    const page = await browser.request('/sign-in');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('strict-transport-security')).toContain('max-age=');
    // No inline script or style: every script is a file of the console's own, and no element has a
    // style attribute.
    const markup = (await page.text()).toLowerCase();
    expect(markup.split('<script').length).toBe(markup.split('<script src="/').length);
    expect(markup).not.toContain(' style=');
  });

  it('refuses a GitHub callback whose state is not the one it sent', async () => {
    const browser = browsers.owner();
    await browser.request('/sign-in/github');
    const response = await browser.request('/callback?code=code-owner&state=forged');
    expect(response.status).toBe(400);
    expect(browser.jar.has('__Host-slotlock-admin')).toBe(false);
  });

  it('turns away a GitHub account that is not staff, and records the attempt', async () => {
    const browser = browsers.owner();
    const response = await browser.signIn('code-stranger');
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('not on the Slotlock staff');
    expect(browser.jar.has('__Host-slotlock-admin')).toBe(false);
    expect(await log('github:9999')).toEqual(['staff.sign_in_refused']);
  });

  it('signs an Owner in with GitHub, then a new passkey made with their one-time code', async () => {
    const browser = browsers.owner();
    const callback = await browser.signIn('code-owner');
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/passkey');
    const cookie = callback.headers.getSetCookie().find((line) => line.startsWith('__Host-slotlock-admin='));
    expect(cookie).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=900$/);

    // GitHub alone opens no page with data.
    const early = await browser.request('/accounts');
    expect(early.headers.get('location')).toBe('/passkey?next=%2Faccounts');
    const passkeyPage = await browser.request('/passkey');
    expect(await passkeyPage.text()).toContain('One-time code');
    // Signing in with a passkey that does not exist yet is refused.
    expect((await browser.json('/passkey/options', { purpose: 'get' })).status).toBe(409);

    // A wrong code is refused by the database; the right one makes the passkey and is spent.
    expect((await browser.createPasskey(new SoftwarePasskey(), { code: 'wrong' })).status).toBe(403);
    const created = await browser.createPasskey(ownerKey, { code: OWNER_CODE });
    expect(created.status).toBe(200);
    const fullCookie = created.headers.getSetCookie().find((line) => line.startsWith('__Host-slotlock-admin='));
    expect(fullCookie).toMatch(/Max-Age=28800$/);

    const home = await browser.request('/');
    expect(home.status).toBe(200);
    const text = await home.text();
    expect(text).toContain('octo-owner');
    expect(text).toContain('Needs a person');
    expect(text).toContain('href="/staff/log"');
    expect(await log('github:1001')).toEqual(
      expect.arrayContaining(['staff.signed_in', 'staff.passkey_added', 'home.viewed']),
    );
  });

  it('signs the Owner in again with the passkey, and refuses a counter that did not advance', async () => {
    const browser = browsers.owner();
    await browser.signIn('code-owner');
    const page = await (await browser.request('/passkey')).text();
    expect(page).toContain('Use passkey');
    expect(page).not.toContain('One-time code');
    // The code is spent: a second first passkey is refused.
    expect((await browser.createPasskey(new SoftwarePasskey(), { code: OWNER_CODE })).status).toBe(403);

    // Once the passkey has counted, a count that does not go up is a copy: refused.
    expect((await browser.usePasskey(ownerKey)).status).toBe(200);
    const again = browsers.owner();
    await again.signIn('code-owner');
    expect((await again.usePasskey(ownerKey, false)).status).toBe(403);
    expect(await log('github:1001')).toContain('staff.passkey_refused');
    // A passkey from another site (another origin and RP ID) is refused before the database.
    const elsewhere = new SoftwarePasskey('https://evil.example', 'evil.example');
    const options = await again.json('/passkey/options', { purpose: 'get' });
    const { challenge } = (await options.json()) as { challenge: string };
    const forged = { ...elsewhere.get(challenge), id: b64u(ownerKey.id) };
    expect((await again.json('/passkey/verify', forged)).status).toBe(403);

    const verified = await again.usePasskey(ownerKey);
    expect(verified.status).toBe(200);
    expect((await again.request('/')).status).toBe(200);
    // A challenge is good once.
    expect((await again.json('/passkey/verify', ownerKey.get('A'.repeat(43)))).status).toBe(400);
  });

  it('lets the Owner find an account by key prefix, by GitHub login and by Stripe customer', async () => {
    const browser = browsers.owner();
    await browser.signIn('code-owner');
    expect((await browser.usePasskey(ownerKey)).status).toBe(200);

    const byPrefix = await (await browser.request('/accounts?q=slk_AbCd1234')).text();
    expect(byPrefix).toContain(`href="/accounts/${encodeURIComponent(PERSON)}"`);
    const byCustomer = await (await browser.request('/accounts?q=cus_TEST123')).text();
    expect(byCustomer).toContain(encodeURIComponent(PERSON));

    // A login no one has signed in with since logins were kept: the console asks GitHub which id
    // it is (admin-data.integration covers finding one the database holds).
    const search = await browser.request('/search?q=someone');
    expect(search.status).toBe(303);
    expect(search.headers.get('location')).toBe('/accounts?q=someone');
    const found = await (await browser.request(search.headers.get('location') ?? '')).text();
    expect(found).toContain(encodeURIComponent(PERSON));
    expect(found).toContain('GitHub account <strong>someone</strong> is id <code>424242</code>');

    const detail = await browser.request(`/accounts/${encodeURIComponent(PERSON)}`);
    expect(detail.status).toBe(200);
    const body = await detail.text();
    expect(body).toContain('slk_AbCd1234');
    expect(body).toContain('https://dashboard.stripe.com/customers/cus_TEST123');
    expect(body).not.toContain('secret');
    expect((await browser.request('/accounts/github%3A1')).status).toBe(404);

    // Views and searches are in the log, shown when asked.
    const staffLog = await (await browser.request('/staff/log?views=1')).text();
    expect(staffLog).toContain('title="search.github_lookup"');
    expect(staffLog).toContain('title="account.viewed"');
    const actions = await log('github:1001');
    expect(actions).toEqual(expect.arrayContaining(['accounts.searched', 'search.github_lookup', 'account.viewed', 'account.keys_viewed']));
  });

  it('opens to each role only its pages, and records a page refused', async () => {
    const { browser: viewer } = await fullySignedIn('code-viewer', VIEWER_CODE);
    expect((await viewer.request('/')).status).toBe(200);
    const home = await (await viewer.request('/')).text();
    expect(home).not.toContain('href="/accounts"');
    expect((await viewer.request('/accounts')).status).toBe(403);
    expect((await viewer.request(`/accounts/${encodeURIComponent(PERSON)}`)).status).toBe(403);
    expect(await log('github:1003')).toContain('page.refused');

    const { browser: support } = await fullySignedIn('code-support', SUPPORT_CODE);
    expect((await support.request('/accounts')).status).toBe(200);
    expect((await support.request('/staff')).status).toBe(403);
    expect((await support.request('/staff/log')).status).toBe(403);
    expect((await support.request('/nowhere')).status).toBe(404);
  });

  it('takes a POST only from its own pages: same origin, the session token, our header', async () => {
    const browser = browsers.owner();
    await browser.signIn('code-owner');
    expect((await browser.usePasskey(ownerKey)).status).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await browser.request('/')).text())?.[1] ?? '';
    expect(csrf).not.toBe('');

    const form = (token: string) => new URLSearchParams({ csrf: token });
    expect((await browser.request('/sign-out', { method: 'POST', body: form(csrf), origin: 'https://evil.example' })).status).toBe(403);
    expect((await browser.request('/sign-out', { method: 'POST', body: form(csrf), origin: null })).status).toBe(403);
    expect((await browser.request('/sign-out', { method: 'POST', body: form('forged') })).status).toBe(403);
    // JSON without the console's header (which a cross-site form cannot send) is refused.
    expect((await browser.json('/passkey/options', { purpose: 'get' }, {})).status).toBe(400);

    const out = await browser.request('/sign-out', { method: 'POST', body: form(csrf) });
    expect(out.status).toBe(303);
    expect(browser.jar.has('__Host-slotlock-admin')).toBe(false);
    expect(await log('github:1001')).toContain('staff.signed_out');
  });

  // ---------- Phase 2: support actions ----------

  /** The form token on a page the browser can open. */
  const tokenOn = async (browser: Browser, path: string) =>
    /name="csrf" value="([^"]+)"/.exec(await (await browser.request(path)).text())?.[1] ?? '';
  const send = (browser: Browser, path: string, fields: Record<string, string>) =>
    browser.request(path, { method: 'POST', body: new URLSearchParams(fields) });
  const customerAudit = async (tenant: string) =>
    superuser<{ action: string; actor_type: string; actor_ref: string; target_ref: string | null; reason: string | null }[]>`
      SELECT action, actor_type, actor_ref, target_ref, reason FROM slotlock.audit_events
       WHERE tenant_ref = ${tenant} ORDER BY chain_index`;
  const accountPath = `/accounts/${encodeURIComponent(PERSON)}`;

  it('lets support suspend an account, with a reason the customer sees and a message for their dashboard', async () => {
    await asOwner((tx) => tx`SELECT slotlock.staff_reset('github:1002', 'cli:ops', ${sha('support-2')}, ${new Date(Date.now() + 86_400_000)})`);
    const { browser: support } = await fullySignedIn('code-support', 'support-2');
    const page = await (await support.request(accountPath)).text();
    expect(page).toContain('Danger zone');
    expect(page).toContain(`action="${accountPath}/suspend"`);
    const csrf = (/name="csrf" value="([^"]+)"/.exec(page)?.[1]) ?? '';

    // No reason: refused by the database, nothing changes.
    const empty = await send(support, `${accountPath}/suspend`, { csrf, reason: '', message: '' });
    expect(empty.headers.get('location')).toBe(`${accountPath}?error=invalid`);
    // No form token: refused before anything runs.
    expect((await send(support, `${accountPath}/suspend`, { reason: 'Card testing' })).status).toBe(403);

    const done = await send(support, `${accountPath}/suspend`, {
      csrf,
      reason: 'Card testing reported to abuse@',
      message: 'Write to abuse@pylota.io to discuss this.',
    });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe(`${accountPath}?done=suspended`);
    const [held] = await superuser<{ reason: string; customer_message: string; suspended_by: string }[]>`
      SELECT reason, customer_message, suspended_by FROM slotlock.tenant_suspensions WHERE tenant_ref = ${PERSON}`;
    expect(held).toEqual({
      reason: 'Card testing reported to abuse@',
      customer_message: 'Write to abuse@pylota.io to discuss this.',
      suspended_by: 'github:1002',
    });
    // In the staff log, and in the customer's own audit log as Slotlock staff (Support).
    expect(await log('github:1002')).toContain('account.suspended');
    expect((await customerAudit(PERSON)).at(-1)).toEqual({
      action: 'staff.account_suspended',
      actor_type: 'system',
      actor_ref: 'slotlock-staff:support',
      target_ref: null,
      reason: 'Card testing reported to abuse@',
    });
    // The customer's dashboard reads the notice through the serving role's function.
    const [notice] = await superuser<{ message: string }[]>`SELECT message FROM slotlock.tenant_suspension_notice(${PERSON})`;
    expect(notice?.message).toBe('Write to abuse@pylota.io to discuss this.');

    const after = await (await support.request(`${accountPath}?done=suspended`)).text();
    expect(after).toContain('Suspended. From its next request it changes nothing');
    expect(after).toContain('The customer sees: “Write to abuse@pylota.io to discuss this.”');
    expect(after).toContain(`action="${accountPath}/unsuspend"`);
    // Suspending again changes nothing.
    expect((await send(support, `${accountPath}/suspend`, { csrf, reason: 'Again' })).headers.get('location')).toBe(
      `${accountPath}?error=already_suspended`,
    );

    const lifted = await send(support, `${accountPath}/unsuspend`, { csrf, reason: 'Cleared after review' });
    expect(lifted.headers.get('location')).toBe(`${accountPath}?done=unsuspended`);
    expect(await superuser`SELECT 1 FROM slotlock.tenant_suspensions WHERE tenant_ref = ${PERSON}`).toHaveLength(0);
    expect((await customerAudit(PERSON)).at(-1)).toMatchObject({ action: 'staff.account_unsuspended', reason: 'Cleared after review' });
  });

  it('asks for the passkey again before an action when the last one is over 15 minutes old', async () => {
    const browser = browsers.owner();
    await browser.signIn('code-owner');
    expect((await browser.usePasskey(ownerKey)).status).toBe(200);
    const csrf = await tokenOn(browser, accountPath);
    // Pages stay open (the idle limit is 30 minutes), but changing an account needs a fresh passkey.
    clock += 10 * 60 * 1000;
    expect((await browser.request(accountPath)).status).toBe(200);
    clock += 6 * 60 * 1000;
    const stale = await send(browser, `${accountPath}/notes`, { csrf, note: 'Called about the invoice.' });
    expect(stale.status).toBe(303);
    expect(stale.headers.get('location')).toBe(`/passkey?${new URLSearchParams({ next: accountPath, fresh: '1' }).toString()}`);
    expect(await superuser`SELECT 1 FROM slotlock.account_notes WHERE account_ref = ${PERSON}`).toHaveLength(0);
    expect(await (await browser.request(stale.headers.get('location') ?? '')).text()).toContain('Changing an account needs your passkey');
    expect((await browser.usePasskey(ownerKey)).status).toBe(200);
    const noted = await send(browser, `${accountPath}/notes`, { csrf, note: 'Called about the invoice.\nSee case 3.' });
    expect(noted.headers.get('location')).toBe(`${accountPath}?done=note_added`);
    const page = await (await browser.request(accountPath)).text();
    expect(page).toContain('Called about the invoice.\nSee case 3.');
    expect(page).toContain('octo-owner');
    // The log records that a note was added, never what it says.
    const [entry] = await superuser<{ target: string; metadata: unknown; reason: string | null }[]>`
      SELECT target, metadata, reason FROM slotlock.staff_audit_events WHERE action = 'account.note_added'`;
    expect(entry?.target).toMatch(/^note:\d+$/);
    expect(JSON.stringify(entry)).not.toContain('invoice');
  });

  it('revokes a key and ends dashboard sessions, each recorded for staff and for the customer', async () => {
    const browser = browsers.owner();
    await browser.signIn('code-owner');
    expect((await browser.usePasskey(ownerKey)).status).toBe(200);
    const csrf = await tokenOn(browser, accountPath);
    const [key] = await superuser<{ id: string }[]>`SELECT id FROM slotlock.api_keys WHERE tenant_ref = ${PERSON}`;
    const revoked = await send(browser, `${accountPath}/keys/revoke`, { csrf, key: key?.id ?? '', reason: 'Leaked in a public repository' });
    expect(revoked.headers.get('location')).toBe(`${accountPath}?done=key_revoked`);
    const [state] = await superuser<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM slotlock.api_keys WHERE id = ${key?.id ?? ''}`;
    expect(state?.revoked_at).toBeInstanceOf(Date);
    expect((await customerAudit(PERSON)).at(-1)).toMatchObject({
      action: 'staff.key_revoked', actor_ref: 'slotlock-staff:owner', target_ref: key?.id, reason: 'Leaked in a public repository',
    });
    expect((await send(browser, `${accountPath}/keys/revoke`, { csrf, key: key?.id ?? '', reason: 'Again' })).headers.get('location')).toBe(
      `${accountPath}?error=key_unchanged`,
    );

    // Two dashboard sessions of the person: one ended, then all.
    const sids = [randomBytes(32), randomBytes(32)];
    for (const sid of sids) {
      await superuser`SELECT slotlock.dashboard_session_started(${PERSON}, ${sid}, ${new Date(Date.now() + 3_600_000)}, 'Firefox', '192.0.2.1')`;
    }
    const page = await (await browser.request(accountPath)).text();
    const handle = sids[0]?.subarray(0, 8).toString('hex') ?? '';
    expect(page).toContain(`value="${handle}"`);
    // Staff see when, never where from or which browser.
    expect(page).not.toContain('192.0.2.1');
    expect(page).not.toContain('Firefox');
    const one = await send(browser, `${accountPath}/sessions/end`, { csrf, session: handle, reason: 'Asked to by the customer' });
    expect(one.headers.get('location')).toBe(`${accountPath}?done=sessions_ended`);
    const alive = async () =>
      (await superuser<{ n: number }[]>`SELECT count(*)::int AS n FROM slotlock.dashboard_sessions WHERE person_ref = ${PERSON} AND ended_at IS NULL`)[0]?.n;
    expect(await alive()).toBe(1);
    expect((await send(browser, `${accountPath}/sessions/end`, { csrf, session: handle, reason: 'Again' })).headers.get('location')).toBe(
      `${accountPath}?error=session_gone`,
    );
    const [before] = await superuser<{ epoch: number }[]>`SELECT session_epoch AS epoch FROM slotlock.dashboard_people WHERE person_ref = ${PERSON}`;
    const all = await send(browser, `${accountPath}/sessions/end`, { csrf, session: 'all', reason: 'Account takeover suspected' });
    expect(all.headers.get('location')).toBe(`${accountPath}?done=sessions_ended`);
    expect(await alive()).toBe(0);
    const [afterEpoch] = await superuser<{ epoch: number }[]>`SELECT session_epoch AS epoch FROM slotlock.dashboard_people WHERE person_ref = ${PERSON}`;
    expect(afterEpoch?.epoch).not.toBe(before?.epoch);
    expect((await customerAudit(PERSON)).at(-1)).toMatchObject({ action: 'staff.sessions_ended', target_ref: 'all' });
    // A team or an organization has no sessions of its own: refused.
    expect((await send(browser, '/accounts/team%3Anone/sessions/end', { csrf, session: 'all', reason: 'x' })).headers.get('location')).toBe(
      '/accounts/team%3Anone?error=invalid',
    );
  });

  it('opens, links, works and closes an abuse case, with its history from the staff log', async () => {
    const browser = browsers.owner();
    await browser.signIn('code-owner');
    expect((await browser.usePasskey(ownerKey)).status).toBe(200);
    const csrf = await tokenOn(browser, '/cases');
    const opened = await send(browser, '/cases', {
      csrf, account: PERSON, source: 'report', summary: 'Card testing through the booking API', section: '2.3 Fraud',
      evidence: 'Report from a card issuer.\nRequest ids: 1, 2, 3.',
    });
    expect(opened.status).toBe(303);
    const location = opened.headers.get('location') ?? '';
    expect(location).toMatch(/^\/cases\/\d+\?done=case_opened$/);
    const id = /^\/cases\/(\d+)/.exec(location)?.[1] ?? '';

    // Suspending from the account page, linked to the case, records it on the case.
    const page = await (await browser.request(accountPath)).text();
    expect(page).toContain(`<option value="${id}">#${id} Card testing through the booking API</option>`);
    await send(browser, `${accountPath}/suspend`, { csrf, reason: 'Card testing', case: id });
    const shown = await (await browser.request(`/cases/${id}`)).text();
    expect(shown).toContain('Report from a card issuer.\nRequest ids: 1, 2, 3.');
    expect(shown).toContain('account.suspended');
    expect(shown).toContain('case.opened');
    expect(shown).toMatch(/<dt>Done<\/dt><dd>Suspended<\/dd>/);

    const closed = await send(browser, `/cases/${id}`, { csrf, status: 'closed', action: 'suspended', outcome: 'Suspended; the card issuer was told.' });
    expect(closed.headers.get('location')).toBe(`/cases/${id}?done=case_updated`);
    const [row] = await superuser<{ status: string; closed_by: string; outcome: string }[]>`
      SELECT status, closed_by, outcome FROM slotlock.abuse_cases WHERE id = ${id}`;
    expect(row).toEqual({ status: 'closed', closed_by: 'github:1001', outcome: 'Suspended; the card issuer was told.' });
    expect(await (await browser.request('/cases')).text()).not.toContain(`/cases/${id}"`);
    expect(await (await browser.request('/cases?status=closed')).text()).toContain(`/cases/${id}"`);
    expect(await (await browser.request('/')).text()).not.toContain('open case');
    // A made-up status is refused, and an unknown case is not found.
    expect((await send(browser, `/cases/${id}`, { csrf, status: 'deleted', action: 'none' })).headers.get('location')).toBe(
      `/cases/${id}?error=invalid`,
    );
    expect((await browser.request('/cases/999999')).status).toBe(404);
    await asOwner((tx) => tx`DELETE FROM slotlock.tenant_suspensions WHERE tenant_ref = ${PERSON}`);
  });

  it('keeps actions to the roles that may take them, and the passkey step to this console', async () => {
    await asOwner((tx) => tx`SELECT slotlock.staff_add('github:1004', 'billing', 'cli:ops', ${sha('billing-code')}, ${new Date(Date.now() + 86_400_000)})`);
    PEOPLE['code-billing'] = { id: 1004, login: 'octo-billing' };
    const { browser: billing } = await fullySignedIn('code-billing', 'billing-code');
    const page = await (await billing.request(accountPath)).text();
    expect(page).not.toContain('Danger zone');
    expect(page).not.toContain('/notes"');
    expect(page).not.toContain('/keys/revoke"');
    expect((await billing.request('/cases')).status).toBe(403);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? '';
    expect((await send(billing, `${accountPath}/suspend`, { csrf, reason: 'No' })).status).toBe(403);
    expect((await send(billing, `${accountPath}/notes`, { csrf, note: 'No' })).status).toBe(403);
    expect(await log('github:1004')).toContain('page.refused');
    // The database holds the same line, whatever the console sends.
    await expect(adminSql`SELECT slotlock.admin_suspend('github:1004', ${PERSON}, 'No', NULL, NULL)`).rejects.toMatchObject({ code: '42501' });
    // A form body that is not a form is refused.
    expect((await billing.request(`${accountPath}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
    // After the passkey, the browser goes back to a page of this console, never another site.
    for (const next of ['//evil.example/', '/\\evil.example', 'https://evil.example/']) {
      const passkey = await (await billing.request(`/passkey?${new URLSearchParams({ next }).toString()}`)).text();
      expect(passkey).toContain('data-next="/"');
    }
  });

  // ---------- Phase 3: billing and usage ----------

  /** A new member of the given role, signed in all the way. */
  async function newStaff(id: number, role: string) {
    const code = `code-${role}-${id}`;
    PEOPLE[code] = { id, login: `octo-${role}-${id}` };
    await asOwner((tx) => tx`SELECT slotlock.staff_add(${`github:${id}`}, ${role}, 'cli:ops', ${sha(`enrol-${id}`)}, ${new Date(Date.now() + 86_400_000)})`);
    return fullySignedIn(code, `enrol-${id}`);
  }
  const effective = async () =>
    (await superuser<{ plan: string; status: string; max_resources: number; max_api_keys: number; max_webhook_endpoints: number }[]>`
      SELECT plan, status, max_resources, max_api_keys, max_webhook_endpoints FROM slotlock.tenant_plan(${PERSON})`)[0];
  const isoDay = (days: number) => new Date(clock + days * 86_400_000).toISOString().slice(0, 10);

  it('gives an account a plan until a date: in force at once, gone when it ends, seen by the customer', async () => {
    const { browser: billing } = await newStaff(1006, 'billing');
    const csrf = await tokenOn(billing, accountPath);
    expect(await effective()).toMatchObject({ plan: 'developer', max_resources: 100 });
    const given = await send(billing, `${accountPath}/overrides`, {
      csrf, back: accountPath, kind: 'plan', plan: 'team', ends: isoDay(30), reason: 'Pilot for the Team plan',
    });
    expect(given.headers.get('location')).toBe(`${accountPath}?done=override_given`);
    // Wherever limits are read, at once.
    expect(await effective()).toEqual({ plan: 'team', status: 'active', max_resources: 500, max_api_keys: 100, max_webhook_endpoints: 25 });
    expect((await customerAudit(PERSON)).at(-1)).toMatchObject({
      action: 'staff.plan_overridden', actor_ref: 'slotlock-staff:billing', reason: 'Pilot for the Team plan',
    });
    const page = await (await billing.request(accountPath)).text();
    expect(page).toContain('An override is in force until');
    expect(page).toContain('Pilot for the Team plan');

    // Raised limits and quotas replace it (one in force at a time) and reach the quotas too.
    await send(billing, `${accountPath}/overrides`, {
      csrf, back: accountPath, kind: 'limits', resources: '250', keys: '50', webhooks: '20', operations: '900000', bookings: '40000', stop: '110',
      ends: isoDay(14), reason: 'Launch week',
    });
    expect(await effective()).toMatchObject({ plan: 'developer', max_resources: 250, max_api_keys: 50, max_webhook_endpoints: 20 });
    expect((await superuser`SELECT operations::int, bookings::int, stop_percent FROM slotlock.tenant_plan_quotas(${PERSON})`)[0]).toEqual({
      operations: 900000, bookings: 40000, stop_percent: 110,
    });
    // It ends on its date, and the account is back on its own plan: no job needed.
    await superuser`UPDATE slotlock.tenant_plan_overrides SET starts_at = now() - interval '2 days', ends_at = now() - interval '1 second' WHERE tenant_ref = ${PERSON} AND ended_at IS NULL`;
    expect(await effective()).toMatchObject({ plan: 'developer', max_resources: 100 });
    // Only whole numbers, a date ahead, and a reason.
    expect((await send(billing, `${accountPath}/overrides`, { csrf, back: accountPath, kind: 'limits', resources: 'lots', keys: '1', webhooks: '1', ends: isoDay(5), reason: 'x' })).headers.get('location')).toBe(
      `${accountPath}?error=invalid`,
    );
    // Over 90 days is not Billing's to give.
    expect((await send(billing, `${accountPath}/overrides`, { csrf, back: accountPath, kind: 'plan', plan: 'team', ends: isoDay(120), reason: 'Annual pilot' })).headers.get('location')).toBe(
      `${accountPath}?error=override_needs_owner`,
    );
    const billingSession = await staffSession(superuser, 'github:1006');
    await expect(adminSql`SELECT slotlock.admin_override_create(${billingSession}, ${PERSON}, 'team', 500, 100, 25, NULL, NULL, NULL, now() + interval '120 days', 'Annual')`).rejects.toMatchObject({ code: '22023' });
  });

  it('needs a second Owner for an override longer than 90 days', async () => {
    const owner = browsers.owner();
    await owner.signIn('code-owner');
    expect((await owner.usePasskey(ownerKey)).status).toBe(200);
    const csrf = await tokenOn(owner, accountPath);
    const asked = await send(owner, `${accountPath}/overrides`, { csrf, back: accountPath, kind: 'plan', plan: 'team', ends: isoDay(180), reason: 'Annual pilot agreed' });
    expect(asked.headers.get('location')).toBe(`${accountPath}?done=override_requested`);
    expect(await effective()).toMatchObject({ plan: 'developer' });
    const [pending] = await superuser<{ id: string }[]>`SELECT id FROM slotlock.tenant_plan_overrides WHERE tenant_ref = ${PERSON} AND approved_at IS NULL AND ended_at IS NULL`;
    // Its asker cannot approve it.
    expect((await send(owner, '/overrides/approve', { csrf, back: '/billing', override: pending?.id ?? '' })).headers.get('location')).toBe('/billing?error=override_own');
    expect(await effective()).toMatchObject({ plan: 'developer' });
    expect(await (await owner.request('/')).text()).toContain('1 override waits for a second Owner');

    const { browser: second } = await newStaff(1007, 'owner');
    const billingPage = await (await second.request('/billing')).text();
    expect(billingPage).toContain('Approve an override');
    const csrf2 = await tokenOn(second, '/billing');
    expect((await send(second, '/overrides/approve', { csrf: csrf2, back: accountPath, override: pending?.id ?? '' })).headers.get('location')).toBe(
      `${accountPath}?done=override_approved`,
    );
    expect(await effective()).toMatchObject({ plan: 'team', max_resources: 500 });
    expect(await log('github:1007')).toContain('override.approved');
    // Ended early, with a reason the customer sees.
    expect((await send(second, '/overrides/end', { csrf: csrf2, back: '/billing', override: pending?.id ?? '', reason: 'Pilot cancelled' })).headers.get('location')).toBe(
      '/billing?done=override_ended',
    );
    expect(await effective()).toMatchObject({ plan: 'developer' });
    expect((await customerAudit(PERSON)).at(-1)).toMatchObject({ action: 'staff.plan_override_ended', reason: 'Pilot cancelled' });
  });

  it('shows a failed payment on Home at once, links it to Stripe, and lets Billing resolve it', async () => {
    const invoice = `in_${randomBytes(6).toString('hex')}`;
    // As the Stripe webhook records it (billing.integration covers the webhook itself).
    await superuser`SELECT slotlock.note_billing_event('payment_failed', ${PERSON}, ${invoice}, ${superuser.json({ amount_due: 1900, currency: 'eur', attempt_count: 1 })})`;
    const { browser: billing } = await newStaff(1008, 'billing');
    const home = await (await billing.request('/')).text();
    expect(home).toContain('1 billing alert');
    const page = await (await billing.request('/billing')).text();
    expect(page).toContain(`https://dashboard.stripe.com/invoices/${invoice}`);
    expect(page).toContain('€19.00, attempt 1');
    const [alert] = await superuser<{ id: string }[]>`SELECT id FROM slotlock.billing_alerts WHERE stripe_ref = ${invoice}`;
    const csrf = await tokenOn(billing, '/billing');
    expect((await send(billing, '/billing/alerts/resolve', { csrf, back: '/billing', alert: alert?.id ?? '', reason: 'Customer updated their card' })).headers.get('location')).toBe(
      '/billing?done=alert_resolved',
    );
    expect(await (await billing.request('/')).text()).not.toContain('billing alert');
    expect(await log('github:1008')).toContain('billing.alert_resolved');
  });

  it('reads revenue from Stripe once an hour, and shows usage by surface', async () => {
    const calls: string[] = [];
    const stripeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const target = String(input instanceof Request ? input.url : input);
      if (!target.startsWith('https://api.stripe.com/')) return githubFetch(input, init);
      calls.push(target);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer rk_test_admin');
      const month = Math.floor(Date.UTC(new Date(clock).getUTCFullYear(), new Date(clock).getUTCMonth(), 2) / 1000);
      const price = (amount: number, interval: string, usage = 'licensed') => ({ unit_amount: amount, currency: 'eur', recurring: { interval, interval_count: 1, usage_type: usage } });
      return new Response(JSON.stringify({
        has_more: false,
        // Each tagged with its account, as Checkout tags Slotlock's (another product's is not counted).
        data: [
          { id: 'sub_m', status: 'active', created: month, metadata: { tenant_ref: PERSON }, items: { data: [{ price: price(1900, 'month'), quantity: 1 }, { price: price(1, 'month', 'metered') }] } },
          { id: 'sub_y', status: 'past_due', created: 1, metadata: { tenant_ref: 'github:1' }, items: { data: [{ price: price(19000, 'year'), quantity: 1 }] } },
          { id: 'sub_c', status: 'canceled', created: 1, canceled_at: month, ended_at: month, metadata: { tenant_ref: 'github:2' }, items: { data: [{ price: price(1900, 'month') }] } },
          { id: 'sub_x', status: 'active', created: month, metadata: {}, items: { data: [{ price: price(9900, 'month'), quantity: 1 }] } },
        ],
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const withStripe = createSlotlockAdmin({
      sql: () => adminSql, publicUrl: ORIGIN, sessionSecret: 'a-test-session-secret-of-forty-characters', consoleKey: CONSOLE_KEY,
      github: { clientId: 'client-id', clientSecret: 'client-secret' },
      access: { verify: async (request) => (request.headers.get('cf-access-jwt-assertion') === 'ok' ? { email: 'staff@example.com', sub: 'sub-1' } : null) },
      fetch: stripeFetch, now: () => clock, stripeKey: 'rk_test_admin',
    });
    const browser = new Browser(() => withStripe);
    await browser.signIn('code-owner');
    expect((await browser.usePasskey(ownerKey)).status).toBe(200);
    const first = await (await browser.request('/billing')).text();
    // €19 a month, plus €190 a year (€15.83 a month); the metered overage price has no fixed amount.
    expect(first).toContain('€34.83');
    expect(first).toContain('2 paying subscriptions in Stripe');
    expect(first).toMatch(/Cancelled this month<\/span>\s*<strong class="stat-value">1</);
    expect(first).toMatch(/New this month<\/span>\s*<strong class="stat-value">1</);
    // The second page is from the hour's cache: the same numbers, no second read of Stripe.
    expect(await (await browser.request('/billing')).text()).toContain('€34.83');
    expect(calls).toHaveLength(1);
    const [kept] = await superuser<{ type: string }[]>`SELECT jsonb_typeof(value) AS type FROM slotlock.admin_cache WHERE key = 'revenue:slotlock'`;
    expect(kept?.type).toBe('object');

    const usage = await (await browser.request('/usage')).text();
    expect(usage).toContain('<code>mcp</code>');
    // 40 of Developer's 500,000 operations is not near its quota.
    expect(usage).not.toContain(`href="${accountPath}"`);
    expect(usage).toContain('No account is at 80% of a quota this month.');
  });

  it('opens Billing to a Viewer to read, and nothing else of it', async () => {
    await asOwner((tx) => tx`SELECT slotlock.staff_reset('github:1003', 'cli:ops', ${sha('viewer-2')}, ${new Date(Date.now() + 86_400_000)})`);
    const { browser: viewer } = await fullySignedIn('code-viewer', 'viewer-2');
    const page = await viewer.request('/billing');
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).not.toContain('Resolve an alert');
    expect(text).not.toContain('End or withdraw an override');
    expect(text).not.toContain(`href="${accountPath}"`);
    expect((await viewer.request('/usage')).status).toBe(403);
    const csrf = /name="csrf" value="([^"]+)"/.exec(text)?.[1] ?? '';
    expect((await send(viewer, '/overrides/end', { csrf, back: '/billing', override: '1', reason: 'x' })).status).toBe(403);
  });

  it('refuses a session cookie that was changed, that sat idle, or whose member was removed', async () => {
    const browser = browsers.owner();
    await browser.signIn('code-owner');
    expect((await browser.usePasskey(ownerKey)).status).toBe(200);
    const sealed = browser.jar.get('__Host-slotlock-admin') ?? '';
    const [body, mac] = sealed.split('.');
    const payload = JSON.parse(Buffer.from(body ?? '', 'base64url').toString()) as Record<string, unknown>;
    browser.jar.set('__Host-slotlock-admin', `${Buffer.from(JSON.stringify({ ...payload, r: 'owner', s: 'github:1002' })).toString('base64url')}.${mac}`);
    expect((await browser.request('/')).headers.get('location')).toBe('/sign-in');

    browser.jar.set('__Host-slotlock-admin', sealed);
    expect((await browser.request('/')).status).toBe(200);
    clock += 31 * 60 * 1000;
    expect((await browser.request('/')).headers.get('location')).toBe('/sign-in');

    // A member removed after signing in is refused by the database on the next page.
    // Support made their passkey earlier; a reset (as `slotlock staff reset` does) issues a new code.
    await asOwner((tx) => tx`SELECT slotlock.staff_reset('github:1002', 'cli:ops', ${sha('again')}, ${new Date(Date.now() + 86_400_000)})`);
    const { browser: support } = await fullySignedIn('code-support', 'again');
    expect((await support.request('/accounts')).status).toBe(200);
    await asOwner((tx) => tx`SELECT slotlock.staff_remove('github:1002', 'cli:ops')`);
    const after = await support.request('/accounts');
    expect(after.status).toBe(303);
    expect(after.headers.get('location')).toBe('/sign-in');
  });

  it('ends a session everywhere on sign-out or a reset, uses each passkey challenge once, and keeps a full session from a link that restarts sign-in', async () => {
    const { browser, passkey } = await newStaff(1020, 'support');
    const copy = new Browser(() => admin);
    for (const [name, value] of browser.jar) copy.jar.set(name, value);
    expect((await copy.request('/')).status).toBe(200);
    // A link from another site that restarts sign-in sends a signed-in member home, as they were.
    expect((await browser.request('/sign-in/github')).headers.get('location')).toBe('/');
    expect((await browser.request('/')).status).toBe(200);
    // Signing out ends the session in the database: a copy of its cookie opens nothing after.
    const csrf = /name="csrf" value="([^"]+)"/.exec(await (await browser.request('/')).text())?.[1] ?? '';
    await browser.request('/sign-out', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }).toString() });
    expect((await copy.request('/')).headers.get('location')).toBe('/sign-in');

    // A passkey sign-in, captured with its challenge cookie, cannot be used again: not on its own
    // session, not on another session of the same member. (This passkey keeps no counter.)
    const first = new Browser(() => admin);
    expect((await first.signIn('code-support-1020')).headers.get('location')).toBe('/passkey');
    const other = new Browser(() => admin);
    await other.signIn('code-support-1020');
    const options = await first.json('/passkey/options', { purpose: 'get' });
    const { challenge } = (await options.json()) as { challenge: string };
    const challengeCookie = first.jar.get('__Host-slotlock-admin-passkey') ?? '';
    const assertion = passkey.get(challenge, { advance: false });
    expect((await first.json('/passkey/verify', assertion)).status).toBe(200);
    first.jar.set('__Host-slotlock-admin-passkey', challengeCookie);
    expect((await first.json('/passkey/verify', assertion)).status).toBe(403);
    other.jar.set('__Host-slotlock-admin-passkey', challengeCookie);
    expect((await other.json('/passkey/verify', assertion)).status).toBe(403);
    expect((await other.request('/')).headers.get('location')).toMatch(/^\/passkey/);

    // A reset, as `slotlock staff reset` makes one after a lost device, ends the member's sessions.
    expect((await first.request('/accounts')).status).toBe(200);
    await asOwner((tx) => tx`SELECT slotlock.staff_reset('github:1020', 'cli:ops', ${sha('lost')}, ${new Date(Date.now() + 86_400_000)})`);
    expect((await first.request('/accounts')).headers.get('location')).toBe('/sign-in');
  });

  it('serves its typefaces for good, finds accounts by view, by name for a form, and as CSV, and opens a staff log entry', async () => {
    const browser = browsers.owner();
    await browser.signIn('code-owner');
    expect((await browser.usePasskey(ownerKey)).status).toBe(200);
    // The fonts: same-origin files at a path that names their hash, which the CSP allows and nothing else.
    const page = await browser.request('/');
    expect(page.headers.get('content-security-policy')).toContain("font-src 'self'");
    const font = /href="(\/fonts\/inter-[0-9a-f]{12}\.woff2)"/.exec(await page.text())?.[1] ?? '';
    const served = await new Browser(() => admin, '').request(font);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('font/woff2');
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect((await new Browser(() => admin, '').request('/fonts/inter-000000000000.woff2')).status).toBe(403);
    // Views the database filters, and views the console filters.
    expect(await (await browser.request('/accounts?view=paying')).text()).toContain(`href="/accounts/${encodeURIComponent(PERSON)}"`);
    expect(await (await browser.request('/accounts?view=suspended')).text()).not.toContain(`href="/accounts/${encodeURIComponent(PERSON)}"`);
    expect(await (await browser.request('/accounts?kind=team')).text()).not.toContain(`href="/accounts/${encodeURIComponent(PERSON)}"`);
    // A form's typeahead: the reference, and the name to show for it.
    const found = await browser.request('/accounts?format=json&q=424242');
    expect(found.headers.get('content-type')).toContain('application/json');
    // No name or display kept for this person yet: the reference.
    // A bare reference: no initials (the list shows a person instead), and nothing more to say.
    expect(await found.json()).toEqual([{ ref: PERSON, label: PERSON, sub: null, initials: null, tone: expect.any(Number), kind: 'person' }]);
    // Export: the rows on the screen, as CSV, a cell that would start a formula quoted as text.
    const exported = await browser.request('/accounts?view=paying&format=csv');
    expect(exported.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(exported.headers.get('content-disposition')).toBe('attachment; filename="accounts.csv"');
    const lines = (await exported.text()).split('\r\n');
    expect(lines[0]).toBe('account,name,kind,plan,plan_status,suspended,operations_month,bookings_month,last_active,created');
    expect(lines.some((line) => line.startsWith(`${PERSON},`))).toBe(true);
    // The staff log: filtered, exported, and an entry opened in a drawer with the chain beside it.
    const mine = await (await browser.request(`/staff/log?${new URLSearchParams({ who: 'github:1001', action: 'accounts.searched', views: '1' }).toString()}`)).text();
    expect(mine).toContain('title="accounts.searched"');
    expect(mine).not.toContain('title="staff.signed_out"');
    const csv = await (await browser.request('/staff/log?format=csv&views=1')).text();
    expect(csv.split('\r\n')[0]).toBe('chain_index,occurred_at,staff,action,account,target,reason');
    expect(csv).toContain('accounts.searched');
    const entry = await (await browser.request('/staff/log?entry=1')).text();
    expect(entry).toContain('role="dialog"');
    // One banner, the top bar: a drawer's head is no second one. Each search is named apart.
    expect(entry.match(/<header class="top">|<header(?! class="(?:section|chart)-head")[ >]/g)).toEqual(['<header class="top">']);
    const accountsPage = await (await browser.request('/accounts')).text();
    expect([...accountsPage.matchAll(/role="search"(?: aria-label="([^"]*)")?/g)].map((match) => match[1] ?? null)).toEqual(['Find an account', 'Search accounts']);
    expect(entry).toContain('Hash chain');
  });

  it('shows no notice or label that a link from elsewhere names, only what its own action did', async () => {
    const browser = browsers.owner();
    await browser.signIn('code-owner');
    expect((await browser.usePasskey(ownerKey)).status).toBe(200);
    // A login the link chose, for an id that is someone else's: not shown.
    const labelled = await (await browser.request(`/accounts?${new URLSearchParams({ q: '424242', for: 'someone-else' }).toString()}`)).text();
    expect(labelled).not.toContain('someone-else');
    // A notice the link names, with no action behind it: not shown.
    for (const path of [`/accounts/${encodeURIComponent(PERSON)}?done=suspended`, '/privacy?error=privacy_invalid']) {
      const page = await (await browser.request(path)).text();
      expect(page, path).not.toContain('class="notice');
    }
  });
});
