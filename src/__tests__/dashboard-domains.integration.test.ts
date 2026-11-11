// Verified domains through the dashboard (domains option), as the LOGIN role grantApplicationRole
// grants: an Owner adds a domain, publishes its record and verifies it; the people whose verified
// address is at it find the team and ask to join (or join as a Viewer), and an Owner or Admin
// decides; invitations held to the domain; and the refusals (an Admin at Identity, a Member deciding,
// an unverified Google address, a sign-in older than 15 minutes). GitHub, Google and DNS are fakes.
// Skipped without DATABASE_URL.
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { createSlotlockDashboard, createSlotlockDashboardResources, createSlotlockDashboardState } from '../dashboard.js';
import { type SlotlockDnsResolver, slotlockDomainRecord } from '../domains.js';
import { createSlotlockStore } from '../store.js';
import { type SlotlockWorkspaceTeams, createSlotlockDashboardWorkspaces } from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const ORIGIN = 'https://slotlock.example.com';
const GOOGLE = { clientId: '1234-domains.apps.googleusercontent.com', clientSecret: `GOCSPX-${'d'.repeat(20)}0123456789` };

/** A browser: its cookies, kept as the dashboard sets them. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly dashboard: () => ReturnType<typeof createSlotlockDashboard>) {}
  private header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  private keep(response: Response) {
    for (const set of response.headers.getSetCookie()) {
      const [pair, ...attributes] = set.split('; ');
      const [name, value] = (pair as string).split(/=(.*)/s) as [string, string];
      if (attributes.includes('Max-Age=0') || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
  async get(path: string) {
    return this.keep(await this.dashboard().fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie: this.header() } })));
  }
  async post(page: string, action: string, fields: Record<string, string>) {
    const fromPage = await (await this.get(page)).text();
    const at = fromPage.indexOf(`action="/dashboard${action}"`);
    expect(at, `the form ${action} on ${page}`).toBeGreaterThan(-1);
    const rest = fromPage.slice(at, fromPage.indexOf('</form>', at));
    // Every hidden field the form carries (its CSRF token, single-use value, the id it acts on).
    const carried = Object.fromEntries([...rest.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, name, value]) => [name, value]));
    return this.send(action, new URLSearchParams({ ...carried, ...fields }));
  }
  /** A form the page does not show (another's), sent with this session's CSRF token from `page`. */
  async forge(page: string, action: string, fields: Record<string, string>) {
    const fromPage = await (await this.get(page)).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(fromPage)?.[1] as string;
    const once = /name="once" value="([^"]+)"/.exec(fromPage)?.[1];
    return this.send(action, new URLSearchParams({ csrf, ...(once ? { once } : {}), ...fields }));
  }
  async send(action: string, sent: URLSearchParams) {
    return this.keep(
      await this.dashboard().fetch(
        new Request(`${ORIGIN}/dashboard${action}`, {
          method: 'POST',
          headers: { cookie: this.header(), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
          body: sent.toString(),
        }),
      ),
    );
  }
}

describe.skipIf(!url)('verified domains in the dashboard (real Postgres)', () => {
  const role = `slotlock_dd_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const base = 800_000_000 + Math.floor(Math.random() * 90_000_000);
  const domain = `acme-${base.toString(36)}.com`;
  const github = new Map<string, { id: number; login: string; emails: { email: string; verified: boolean }[] }>([
    ['ada', { id: base, login: 'ada', emails: [{ email: `ada@${domain}`, verified: true }] }],
    ['bea', { id: base + 1, login: 'bea', emails: [] }],
    ['cy', { id: base + 2, login: 'cy', emails: [{ email: `cy@${domain}`, verified: true }, { email: 'cy@gmail.com', verified: true }] }],
    ['dee', { id: base + 3, login: 'dee', emails: [{ email: `dee@${domain}`, verified: false }] }],
    ['eli', { id: base + 4, login: 'eli', emails: [] }],
  ]);
  const googleSubject = `${base}888`;
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const JWKS = { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'domains-key', alg: 'RS256', use: 'sig' }] };
  let googleClaims: { nonce: string; email: string; verified: unknown; hd?: string } = { nonce: '', email: '', verified: true };
  const records = new Map<string, string[]>();
  const resolver = (name: string): SlotlockDnsResolver => ({
    name,
    async txt(host) {
      const found = records.get(host);
      return found ? { status: 'ok', values: found, ad: false, ttl: 60 } : { status: 'nxdomain', ad: false };
    },
  });
  const tenants: string[] = [];
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let clock = Date.now();
  let current: ReturnType<typeof createSlotlockDashboard>;

  const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = String(input);
    if (target === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json(JWKS);
    if (target === 'https://oauth2.googleapis.com/token') {
      const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const signed = `${part({ alg: 'RS256', kid: 'domains-key', typ: 'JWT' })}.${part({
        iss: 'https://accounts.google.com',
        aud: GOOGLE.clientId,
        sub: googleSubject,
        email: googleClaims.email,
        email_verified: googleClaims.verified,
        ...(googleClaims.hd ? { hd: googleClaims.hd } : {}),
        nonce: googleClaims.nonce,
        exp: Math.floor(clock / 1000) + 3600,
      })}`;
      return Response.json({ id_token: `${signed}.${createSign('RSA-SHA256').update(signed).sign(signing.privateKey).toString('base64url')}` });
    }
    if (target.endsWith('/access_token')) return Response.json({ access_token: `gho_${new URLSearchParams(String(init.body)).get('code')}` });
    const who = github.get(String(new Headers(init.headers).get('authorization')).replace('Bearer gho_', ''));
    if (!who) return new Response('no', { status: 401 });
    if (target.endsWith('/user/emails')) return Response.json(who.emails.map((entry) => ({ ...entry, primary: false })));
    return Response.json({ id: who.id, login: who.login });
  };

  async function signIn(browser: Browser, code: string, query = '') {
    const start = await browser.get(`/dashboard/sign-in${query}`);
    const location = new URL(start.headers.get('location') ?? '');
    const callback = await browser.get(`/dashboard/callback?code=${code}&state=${location.searchParams.get('state')}`);
    expect(callback.status).toBe(303);
    return { location, callback };
  }
  async function signInWithGoogle(browser: Browser, email: string, verified: unknown, hd?: string) {
    const start = await browser.get('/dashboard/sign-in?with=google');
    const location = new URL(start.headers.get('location') ?? '');
    googleClaims = { nonce: location.searchParams.get('nonce') ?? '', email, verified, ...(hd ? { hd } : {}) };
    return browser.get(`/dashboard/callback?code=g&state=${location.searchParams.get('state')}`);
  }
  const roleIn = async (tenantRef: string, person: string) =>
    (await createSlotlockDashboardWorkspaces(application).standing(tenantRef, person)).role;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, { max: 6, onnotice: () => {} });
    const store = createSlotlockStore(application);
    current = createSlotlockDashboard({
      publicUrl: ORIGIN,
      github: { clientId: 'Ov23liDomains', clientSecret: 'd'.repeat(40) },
      google: GOOGLE,
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: '*',
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store),
      state: createSlotlockDashboardState(application),
      workspaces: createSlotlockDashboardWorkspaces(application),
      teamWorkspaces: true,
      domains: { resolvers: [resolver('primary'), resolver('secondary')] },
      fetch: fakeFetch as typeof fetch,
      now: () => clock,
    });
  });

  afterAll(async () => {
    for (const ref of tenants) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    for (const ref of [...[...github.values()].map((who) => `github:${who.id}`), `google:${googleSubject}`]) {
      await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    }
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('verifies a domain, lets the people at it ask to join, and holds invitations to it', async () => {
    const dashboard = () => current;
    const ada = new Browser(dashboard);
    await signIn(ada, 'ada');
    const created = await ada.post('/dashboard/teams', '/teams/create', { name: 'Acme Rentals' });
    expect(created.status).toBe(303);
    const team = /<option value="(team:[0-9a-f-]{36})" selected>/.exec(await (await ada.get('/dashboard')).text())?.[1] as string;
    expect(team).toMatch(/^team:/);
    tenants.push(team);

    // Bea is an Admin: no Identity for her, by the page or by a form.
    const teams = createSlotlockDashboardWorkspaces(application).teams as SlotlockWorkspaceTeams;
    const raw = randomBytes(32);
    const digest = createHash('sha256').update(raw).digest();
    await teams.invite({ tenantRef: team, inviter: `github:${base}`, to: { github: `github:${base + 1}`, login: 'bea' }, role: 'admin', tokenSha256: digest, days: 7, dailyLimit: null, memberCap: null });
    expect(await teams.accept({ tokenSha256: digest, person: `github:${base + 1}`, emails: [], memberCap: null })).toEqual({ tenantRef: team });
    const bea = new Browser(dashboard);
    await signIn(bea, 'bea');
    await bea.post('/dashboard/teams', '/organization', { organization: team });
    expect(await (await bea.get('/dashboard/settings/members')).text()).not.toContain('/dashboard/settings/identity');
    expect((await bea.get('/dashboard/settings/identity')).status).toBe(403);
    expect((await bea.forge('/dashboard/settings/members', '/identity/domains', { domain })).status).toBe(403);

    // Ada adds the domain: the page shows the record to publish.
    const settings = await (await ada.get('/dashboard/settings/members')).text();
    expect(settings).toContain('href="/dashboard/settings/identity"');
    for (const [typed, text] of [
      ['gmail.com', 'Anyone can get an address at that domain'],
      ['co.uk', 'Nobody owns all of that domain'],
    ] as const) {
      expect(await (await ada.post('/dashboard/settings/identity', '/identity/domains', { domain: typed })).text()).toContain(text);
    }
    expect((await ada.post('/dashboard/settings/identity', '/identity/domains', { domain: domain.toUpperCase() })).status).toBe(303);
    const pending = await (await ada.get('/dashboard/settings/identity')).text();
    expect(pending).toContain(`_slotlock-challenge.${domain}`);
    const value = /(slotlock-verification=[a-z2-7]{26})/.exec(pending)?.[1] as string;
    expect(value).toBeDefined();
    const notYet = await ada.post('/dashboard/settings/identity', '/identity/domains/verify', {});
    expect(notYet.status).toBe(409);
    expect(await notYet.text()).toContain('The record isn’t there yet.');
    // Published, and a minute later: verified.
    records.set(slotlockDomainRecord(domain, 'x').name, [value]);
    await admin`UPDATE slotlock.workspace_domains SET last_checked_at = now() - interval '2 minutes' WHERE domain_ascii = ${domain}`;
    const verified = await ada.post('/dashboard/settings/identity', '/identity/domains/verify', {});
    expect(verified.status).toBe(200);
    expect(await verified.text()).toContain(`${domain} is verified.`);
    const [event] = await admin<{ action: string; metadata: { domain: string } }[]>`
      SELECT action, metadata FROM slotlock.audit_events WHERE tenant_ref = ${team} AND action = 'domain.verified'`;
    expect(event?.metadata.domain).toBe(domain);

    // Cy signed in with GitHub carries no address until asked; asked, only the one at the team's domain is kept.
    const cy = new Browser(dashboard);
    await signIn(cy, 'cy');
    const before = await (await cy.get('/dashboard/teams')).text();
    expect(before).toContain('/dashboard/sign-in?then=%2Fteams&amp;email=1');
    const { location, callback } = await signIn(cy, 'cy', '?then=%2Fteams&email=1');
    expect(location.searchParams.get('scope')).toContain('user:email');
    expect(callback.headers.get('location')).toBe('/dashboard/teams?checked=1');
    const found = await (await cy.get('/dashboard/teams?checked=1')).text();
    expect(found).toContain('Acme Rentals');
    expect(found).toContain(domain);
    const asked = await cy.post('/dashboard/teams', '/join/request', { team });
    expect(await asked.text()).toContain('Asked to join Acme Rentals. An owner or admin decides.');
    expect(await roleIn(team, `github:${base + 2}`)).toBeNull();

    // Dee's address at the domain is one GitHub did not verify: nothing found.
    const dee = new Browser(dashboard);
    await signIn(dee, 'dee', '?then=%2Fteams&email=1');
    const none = await (await dee.get('/dashboard/teams?checked=1')).text();
    expect(none).toContain('No team has verified the domain of an address GitHub verified for you.');
    expect((await dee.forge('/dashboard/teams', '/join/request', { team })).status).toBe(404);

    // A Member cannot decide; the Admin approves as Developer.
    const members = await (await ada.get('/dashboard/settings/members')).text();
    expect(members).toContain('Asking to join');
    expect(members).toContain('verified once by GitHub, not checked since');
    const requestId = /name="id" value="([0-9a-f-]{36})"><label class="visually-hidden" for="join-role-0"/.exec(members)?.[1] as string;
    expect(requestId).toBeDefined();
    const approved = await bea.send(
      '/members/requests',
      new URLSearchParams({
        csrf: /name="csrf" value="([^"]+)"/.exec(await (await bea.get('/dashboard/settings/members')).text())?.[1] as string,
        once: /name="once" value="([^"]+)"/.exec(await (await bea.get('/dashboard/settings/members')).text())?.[1] as string,
        id: requestId,
        decision: 'approve',
        role: 'developer',
      }),
    );
    expect(approved.status).toBe(303);
    expect(await roleIn(team, `github:${base + 2}`)).toBe('developer');
    expect(await (await ada.get('/dashboard/settings/members')).text()).toContain(`via ${domain}`);

    // Join as Viewer: only a Google Workspace account of the domain joins at once. A consumer Google
    // account that verified the address once (an ex-employee's, say) may only ask.
    expect((await ada.post('/dashboard/settings/identity', '/identity/domains/policy', { policy: 'auto' })).status).toBe(200);
    const desk = new Browser(dashboard);
    await signInWithGoogle(desk, `desk@${domain}`, false);
    expect(await (await desk.get('/dashboard/teams')).text()).not.toContain('Acme Rentals');
    await signInWithGoogle(desk, `desk@${domain}`, true);
    const consumer = await (await desk.get('/dashboard/teams')).text();
    expect(consumer).toContain('Ask to join');
    expect(consumer).not.toContain('Join Acme Rentals');
    await signInWithGoogle(desk, `desk@${domain}`, true, 'elsewhere-domain.org');
    expect(await (await desk.get('/dashboard/teams')).text()).not.toContain('Join Acme Rentals');
    await signInWithGoogle(desk, `desk@${domain}`, true, domain);
    const offered = await (await desk.get('/dashboard/teams')).text();
    expect(offered).toContain('Join Acme Rentals');
    const joined = await desk.post('/dashboard/teams', '/join/request', { team });
    expect(joined.status).toBe(303);
    expect(await roleIn(team, `google:${googleSubject}`)).toBe('viewer');

    // Invitations held to the domain.
    expect((await ada.post('/dashboard/settings/identity', '/identity/invites', { on: '1' })).status).toBe(303);
    const elsewhere = await ada.post('/dashboard/settings/members', '/members/invite', { email: 'x@elsewhere-domain.org', role: 'member' });
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.text()).toContain('Invitations go only to addresses at this team’s verified domains.');
    expect((await ada.post('/dashboard/settings/members', '/members/invite', { email: `front@${domain}`, role: 'member' })).status).toBe(200);

    // Twenty minutes on, changing the team's domains needs a fresh sign-in.
    clock += 20 * 60_000;
    const stale = await ada.post('/dashboard/settings/identity', '/identity/invites', { on: '0' });
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('sign-in');
    clock = Date.now();
  });
});
