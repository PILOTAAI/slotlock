// The admin console (src/admin/app.ts, RFC 0006) end to end against real PostgreSQL: Cloudflare
// Access, GitHub sign-in (a fake GitHub), a passkey made and used by a software authenticator, the
// pages each role may open, the forms' origin and token checks, and the staff log each step writes.
// Needs a role that creates databases and roles; skipped without DATABASE_URL.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAdmin, createSlotlockAdmin } from '../admin/app.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim();
const ORIGIN = 'https://admin.slotlock.test';
const RP_ID = 'admin.slotlock.test';
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest();
const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

// ---------- A software passkey: ES256, user verified, attestation "none" ----------
function cborHead(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 256) return [(major << 5) | 24, length];
  return [(major << 5) | 25, length >> 8, length & 0xff];
}
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;
function cbor(value: Cbor): number[] {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return [...cborHead(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...cborHead(2, value.length), ...value];
  const out = cborHead(5, value.size);
  for (const [key, item] of value) out.push(...cbor(key), ...cbor(item));
  return out;
}

class SoftwarePasskey {
  readonly id = randomBytes(32);
  private readonly key: KeyObject;
  private readonly cose: Uint8Array;
  counter = 0;
  constructor(readonly origin = ORIGIN, readonly rpId = RP_ID) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = Uint8Array.from(
      cbor(
        new Map<number, Cbor>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x as string, 'base64url')],
          [-3, Buffer.from(jwk.y as string, 'base64url')],
        ]),
      ),
    );
  }
  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }
  private header(flags: number) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([sha(this.rpId), Buffer.from([flags]), count]);
  }
  create(challenge: string) {
    const length = Buffer.from([this.id.length >> 8, this.id.length & 0xff]);
    const authData = Buffer.concat([this.header(0x45), Buffer.alloc(16), length, this.id, this.cose]);
    const attestation = Uint8Array.from(
      cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])),
    );
    return { id: b64u(this.id), attestationObject: b64u(attestation), clientDataJSON: b64u(this.clientData('webauthn.create', challenge)) };
  }
  get(challenge: string, { advance = true } = {}) {
    if (advance) this.counter += 1;
    const authData = this.header(0x05);
    const clientDataJSON = this.clientData('webauthn.get', challenge);
    const signature = sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), this.key);
    return { id: b64u(this.id), authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) };
  }
}

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
const githubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = String(input instanceof Request ? input.url : input);
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (target === 'https://github.com/login/oauth/access_token') {
    const body = JSON.parse(String(init?.body)) as { code: string; code_verifier?: string; client_secret: string };
    if (body.client_secret !== 'client-secret' || !body.code_verifier) return reply({ error: 'bad_verification_code' });
    return PEOPLE[body.code] ? reply({ access_token: `token-${body.code}` }) : reply({ error: 'bad_verification_code' });
  }
  if (target === 'https://api.github.com/user') {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const person = PEOPLE[auth.replace('Bearer token-', '')];
    return person ? reply(person) : reply({ message: 'Bad credentials' }, 401);
  }
  const byLogin = /^https:\/\/api\.github\.com\/users\/([^/]+)$/.exec(target)?.[1];
  if (byLogin) return PROFILES[byLogin] ? reply(PROFILES[byLogin]) : reply({ message: 'Not Found' }, 404);
  const byId = /^https:\/\/api\.github\.com\/user\/(\d+)$/.exec(target)?.[1];
  if (byId) {
    const found = [...Object.values(PROFILES), ...Object.values(PEOPLE)].find((p) => String(p.id) === byId);
    return found ? reply({ type: 'User', ...found }) : reply({ message: 'Not Found' }, 404);
  }
  return reply({ message: 'unexpected' }, 500);
}) as typeof fetch;

// ---------- A browser: cookies, Access, and our own origin on every POST ----------
class Browser {
  readonly jar = new Map<string, string>();
  constructor(private readonly admin: () => SlotlockAdmin, public access = 'ok') {}
  async request(path: string, init: RequestInit & { origin?: string | null } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.access) headers.set('cf-access-jwt-assertion', this.access);
    if (this.jar.size) headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const method = init.method ?? 'GET';
    if (method === 'POST' && init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
    const response = await this.admin().fetch(new Request(`${ORIGIN}${path}`, { ...init, method, headers, redirect: 'manual' }));
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = (pair ?? '').indexOf('=');
      const name = (pair ?? '').slice(0, index);
      const value = (pair ?? '').slice(index + 1);
      if (/Max-Age=0/.test(line) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }
  json(path: string, body: unknown, extra: Record<string, string> = { 'x-slotlock-admin': '1' }) {
    return this.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  }
  /** GitHub sign-in through to the callback; returns where the console sent the browser next. */
  async signIn(code: string): Promise<Response> {
    const start = await this.request('/sign-in/github');
    expect(start.status).toBe(303);
    const authorize = new URL(start.headers.get('location') ?? '');
    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
    expect(authorize.searchParams.has('scope')).toBe(false);
    const state = authorize.searchParams.get('state') ?? '';
    return this.request(`/callback?${new URLSearchParams({ code, state }).toString()}`);
  }
  async createPasskey(passkey: SoftwarePasskey, extra: Record<string, unknown> = {}) {
    const options = await this.json('/passkey/options', { purpose: 'create' });
    if (options.status !== 200) return options;
    const { challenge } = (await options.json()) as { challenge: string };
    return this.json('/passkey/register', { name: 'Test key', ...passkey.create(challenge), ...extra });
  }
  async usePasskey(passkey: SoftwarePasskey, advance = true) {
    const options = await this.json('/passkey/options', { purpose: 'get' });
    expect(options.status).toBe(200);
    const { challenge } = (await options.json()) as { challenge: string };
    return this.json('/passkey/verify', passkey.get(challenge, { advance }));
  }
}

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
                                         max_webhook_endpoints, stripe_customer)
      VALUES (${PERSON}, 'developer', 'active', 100, 100, 10, 'cus_TEST123')`;
    const today = new Date().toISOString().slice(0, 10);
    await superuser`
      INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, origin, count)
      VALUES (${PERSON}, ${today}, 'operations', 'mcp', 40), (${PERSON}, ${today}, 'bookings', 'mcp', 3)`;

    admin = createSlotlockAdmin({
      sql: () => adminSql,
      publicUrl: ORIGIN,
      sessionSecret: 'a-test-session-secret-of-forty-characters',
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
      createSlotlockAdmin({ sql: () => adminSql, publicUrl: ORIGIN, sessionSecret: 'x'.repeat(40), github: { clientId: 'a', clientSecret: 'b' }, access: null }),
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
    expect(await page.text()).not.toMatch(/<script>|style="/);
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
    expect(text).toContain('Needs attention');
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

    // A login: the database keeps ids only, so the console asks GitHub which id it is.
    const search = await browser.request('/search?q=someone');
    expect(search.status).toBe(303);
    expect(search.headers.get('location')).toBe('/accounts?q=424242&for=someone');
    const found = await (await browser.request(search.headers.get('location') ?? '')).text();
    expect(found).toContain(encodeURIComponent(PERSON));

    const detail = await browser.request(`/accounts/${encodeURIComponent(PERSON)}`);
    expect(detail.status).toBe(200);
    const body = await detail.text();
    expect(body).toContain('slk_AbCd1234');
    expect(body).toContain('https://dashboard.stripe.com/customers/cus_TEST123');
    expect(body).toContain('someone');
    expect(body).not.toContain('secret');
    expect((await browser.request('/accounts/github%3A1')).status).toBe(404);

    const staffLog = await (await browser.request('/staff/log')).text();
    expect(staffLog).toContain('search.github_lookup');
    expect(staffLog).toContain('account.viewed');
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
});
