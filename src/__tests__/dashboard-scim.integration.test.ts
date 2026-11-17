// SCIM provisioning through the dashboard (scim option), as the LOGIN role grantApplicationRole
// grants: an Owner turns it on, choosing what happens to a deactivated member's API keys, and makes a
// token shown once; the team's directory adds a person at the verified domain, who becomes a member
// on signing in with a Google Workspace account of it (not with a consumer one); a group the Owner
// maps gives a role; deactivation ends the membership at the next request and revokes their keys;
// reactivation needs a new sign-in; a revoked token and SCIM turned off answer 401. An Admin cannot
// reach any of it. GitHub and Google are fakes. Skipped without DATABASE_URL.
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { createSlotlockDashboard, createSlotlockDashboardResources, createSlotlockDashboardState } from '../dashboard.js';
import { createSlotlockStore } from '../store.js';
import { type SlotlockWorkspaceTeams, createSlotlockDashboardWorkspaces } from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const ORIGIN = 'https://slotlock.example.com';
const GOOGLE = { clientId: '1234-scim.apps.googleusercontent.com', clientSecret: `GOCSPX-${'s'.repeat(20)}0123456789` };

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
    const carried = Object.fromEntries([...rest.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, name, value]) => [name, value]));
    return this.send(action, new URLSearchParams({ ...carried, ...fields }));
  }
  /** A form the page does not show, sent with this session's CSRF token from `page`. */
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

describe.skipIf(!url)('SCIM provisioning in the dashboard (real Postgres)', () => {
  const role = `slotlock_dc_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const base = 870_000_000 + Math.floor(Math.random() * 90_000_000);
  const domain = `scim-${base.toString(36)}.com`;
  const github = new Map<string, { id: number; login: string }>([
    ['ada', { id: base, login: 'ada' }],
    ['bea', { id: base + 1, login: 'bea' }],
  ]);
  const googleSubject = `${base}777`;
  const desk = `google:${googleSubject}`;
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const JWKS = { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'scim-key', alg: 'RS256', use: 'sig' }] };
  let googleClaims: { nonce: string; email: string; hd?: string } = { nonce: '', email: '' };
  const tenants: string[] = [];
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let current: ReturnType<typeof createSlotlockDashboard>;

  const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = String(input);
    if (target === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json(JWKS);
    if (target === 'https://oauth2.googleapis.com/token') {
      const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const signed = `${part({ alg: 'RS256', kid: 'scim-key', typ: 'JWT' })}.${part({
        iss: 'https://accounts.google.com',
        aud: GOOGLE.clientId,
        sub: googleSubject,
        email: googleClaims.email,
        email_verified: true,
        ...(googleClaims.hd ? { hd: googleClaims.hd } : {}),
        nonce: googleClaims.nonce,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })}`;
      return Response.json({ id_token: `${signed}.${createSign('RSA-SHA256').update(signed).sign(signing.privateKey).toString('base64url')}` });
    }
    if (target.endsWith('/access_token')) return Response.json({ access_token: `gho_${new URLSearchParams(String(init.body)).get('code')}` });
    const who = github.get(String(new Headers(init.headers).get('authorization')).replace('Bearer gho_', ''));
    if (!who) return new Response('no', { status: 401 });
    if (target.endsWith('/user/emails')) return Response.json([]);
    return Response.json({ id: who.id, login: who.login });
  };

  async function signIn(browser: Browser, code: string) {
    const start = await browser.get('/dashboard/sign-in');
    const location = new URL(start.headers.get('location') ?? '');
    expect((await browser.get(`/dashboard/callback?code=${code}&state=${location.searchParams.get('state')}`)).status).toBe(303);
  }
  async function signInWithGoogle(browser: Browser, email: string, hd?: string) {
    const start = await browser.get('/dashboard/sign-in?with=google');
    const location = new URL(start.headers.get('location') ?? '');
    googleClaims = { nonce: location.searchParams.get('nonce') ?? '', email, ...(hd ? { hd } : {}) };
    expect((await browser.get(`/dashboard/callback?code=g&state=${location.searchParams.get('state')}`)).status).toBe(303);
  }
  const roleIn = async (tenantRef: string, person: string) =>
    (await createSlotlockDashboardWorkspaces(application).standing(tenantRef, person, null)).role;
  const teamOf = async (browser: Browser) => /<option value="(team:[0-9a-f-]{36})" selected>/.exec(await (await browser.get('/dashboard')).text())?.[1];
  /** A request from the team's directory, with its bearer token, through the dashboard. */
  const directory = (token: string, method: string, path: string, body?: unknown) =>
    current.fetch(
      new Request(`${ORIGIN}/dashboard/scim/v2/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/scim+json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const patch = (...Operations: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations });

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
      github: { clientId: 'Ov23liScim', clientSecret: 'c'.repeat(40) },
      google: GOOGLE,
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: '*',
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store),
      state: createSlotlockDashboardState(application),
      workspaces: createSlotlockDashboardWorkspaces(application),
      teamWorkspaces: true,
      domains: { resolvers: [] },
      scim: true,
      fetch: fakeFetch as typeof fetch,
    });
  });

  afterAll(async () => {
    for (const ref of tenants) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    for (const ref of [...[...github.values()].map((who) => `github:${who.id}`), desk]) {
      await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    }
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("turns on with the Owner's key choice; adds, groups, ends and restores a member through the directory", async () => {
    const dashboard = () => current;
    const ada = new Browser(dashboard);
    await signIn(ada, 'ada');
    expect((await ada.post('/dashboard/teams', '/teams/create', { name: 'Scim Rentals' })).status).toBe(303);
    const team = (await teamOf(ada)) as string;
    tenants.push(team);
    const teamId = team.slice('team:'.length);
    await admin`
      INSERT INTO slotlock.workspace_domains (tenant_ref, domain_ascii, domain_unicode, status, token, verified_at)
      VALUES (${team}, ${domain}, ${domain}, 'verified', ${'d'.repeat(26)}, now())`;

    // An Admin reaches none of it.
    const teams = createSlotlockDashboardWorkspaces(application).teams as SlotlockWorkspaceTeams;
    const raw = randomBytes(32);
    await teams.invite({ tenantRef: team, inviter: `github:${base}`, to: { github: `github:${base + 1}`, login: 'bea' }, role: 'admin', tokenSha256: createHash('sha256').update(raw).digest(), days: 7, dailyLimit: null, memberCap: null });
    await teams.accept({ tokenSha256: createHash('sha256').update(raw).digest(), person: `github:${base + 1}`, emails: [], memberCap: null });
    const bea = new Browser(dashboard);
    await signIn(bea, 'bea');
    expect((await bea.forge('/dashboard/teams', '/organization', { organization: team })).status).toBe(303);
    expect((await bea.get('/dashboard/settings/identity')).status).toBe(403);
    expect((await bea.forge('/dashboard/settings/members', '/identity/scim/enable', { keys: 'keep' })).status).toBe(403);

    // The Owner chooses what happens to a deactivated member's keys; there is no default.
    const off = await (await ada.get('/dashboard/settings/identity')).text();
    expect(off).toContain('Turn on SCIM');
    expect(off).not.toMatch(/name="keys" value="(revoke|keep)" (checked|required checked)/);
    expect((await ada.post('/dashboard/settings/identity', '/identity/scim/enable', {})).status).toBe(400);
    expect((await ada.post('/dashboard/settings/identity', '/identity/scim/enable', { keys: 'revoke' })).status).toBe(303);
    const [enabled] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.audit_events WHERE tenant_ref = ${team} AND action = 'scim.enabled'`;
    expect(enabled?.count).toBe(1);

    // A token, shown once; its address.
    const made = await ada.post('/dashboard/settings/identity', '/identity/scim/token', {});
    expect(made.status).toBe(201);
    const shown = await made.text();
    const token = /slk_scim_[0-9a-f]{64}/.exec(shown)?.[0] as string;
    expect(token).toBeDefined();
    expect(shown).toContain(`${ORIGIN}/dashboard/scim/v2/${teamId}`);
    expect(await (await ada.get('/dashboard/settings/identity')).text()).not.toContain(token);

    // The directory adds Desk at the verified domain, through the dashboard's own address.
    const added = await directory(token, 'POST', `${teamId}/Users`, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: `desk@${domain}`,
      active: true,
      emails: [{ primary: true, type: 'work', value: `desk@${domain}` }],
    });
    expect(added.status).toBe(201);
    const { id } = (await added.json()) as { id: string };
    expect(added.headers.get('location')).toBe(`${ORIGIN}/dashboard/scim/v2/${teamId}/Users/${id}`);
    // Not a session's address: a browser's cookie opens nothing there.
    expect((await ada.get(`/dashboard/scim/v2/${teamId}/Users`)).status).toBe(401);

    // A consumer Google account holding the address does not become the directory's user; a Google
    // Workspace account of the domain does, as a Viewer.
    const deskBrowser = new Browser(dashboard);
    await signInWithGoogle(deskBrowser, `desk@${domain}`);
    expect(await roleIn(team, desk)).toBeNull();
    await signInWithGoogle(deskBrowser, `desk@${domain}`, domain);
    expect(await roleIn(team, desk)).toBe('viewer');
    expect((await deskBrowser.forge('/dashboard/teams', '/organization', { organization: team })).status).toBe(303);
    expect(await teamOf(deskBrowser)).toBe(team);

    // A group the Owner maps gives its role.
    const group = await directory(token, 'POST', `${teamId}/Groups`, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      displayName: 'Engineering',
      members: [{ value: id }],
    });
    expect(group.status).toBe(201);
    expect(await (await ada.get('/dashboard/settings/identity')).text()).toContain('Engineering');
    expect((await ada.post('/dashboard/settings/identity', '/identity/scim/group', { role: 'developer' })).status).toBe(303);
    expect(await roleIn(team, desk)).toBe('developer');

    // Deactivated (Entra's string False): out of the team at Desk's next request, Desk's keys
    // revoked as the Owner chose, Desk's own workspace untouched.
    const keys = createSlotlockApiKeyStore(application);
    await keys.create({ tenantRef: team, name: 'desk agent', scopes: ['read', 'write'], createdBy: desk });
    expect((await directory(token, 'PATCH', `${teamId}/Users/${id}`, patch({ op: 'Replace', path: 'active', value: 'False' }))).status).toBe(200);
    expect(await teamOf(deskBrowser)).toBeUndefined();
    expect((await deskBrowser.get('/dashboard')).status).toBe(200);
    expect((await keys.list({ tenantRef: team })).every((key) => key.revokedAt !== null)).toBe(true);
    const [deactivated] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.audit_events WHERE tenant_ref = ${team} AND action = 'scim.user_deactivated'`;
    expect(deactivated?.count).toBe(1);

    // Restored: not for the session from before, but for a new sign-in, with the group's role.
    expect((await directory(token, 'PATCH', `${teamId}/Users/${id}`, patch({ op: 'replace', value: { active: 'True' } }))).status).toBe(200);
    expect((await deskBrowser.forge('/dashboard/teams', '/organization', { organization: team })).status).toBeGreaterThanOrEqual(400);
    expect(await teamOf(deskBrowser)).toBeUndefined();
    const later = new Browser(dashboard);
    await signInWithGoogle(later, `desk@${domain}`, domain);
    expect((await later.forge('/dashboard/teams', '/organization', { organization: team })).status).toBe(303);
    expect(await teamOf(later)).toBe(team);
    const [restored] = await admin<{ role: string }[]>`SELECT role FROM slotlock.workspace_memberships WHERE tenant_ref = ${team} AND person_ref = ${desk}`;
    expect(restored?.role).toBe('developer');

    // A revoked token, and SCIM turned off, open nothing.
    expect((await ada.post('/dashboard/settings/identity', '/identity/scim/token/revoke', {})).status).toBe(303);
    expect((await directory(token, 'GET', `${teamId}/Users`)).status).toBe(401);
    const second = /slk_scim_[0-9a-f]{64}/.exec(await (await ada.post('/dashboard/settings/identity', '/identity/scim/token', {})).text())?.[0] as string;
    expect((await directory(second, 'GET', `${teamId}/Users`)).status).toBe(200);
    expect((await ada.post('/dashboard/settings/identity', '/identity/scim/disable', {})).status).toBe(303);
    expect((await directory(second, 'GET', `${teamId}/Users`)).status).toBe(401);
    expect(await (await ada.get('/dashboard/settings/identity')).text()).toContain('Turn on SCIM');
  });
});
