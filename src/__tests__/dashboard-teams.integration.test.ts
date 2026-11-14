// Team workspaces through the dashboard (teamWorkspaces), as the LOGIN role grantApplicationRole
// grants: creating one, inviting by email, the link that consumes nothing until its person joins,
// GitHub and Google people joining by the address they verified, roles, removal and leaving, and
// the refusals (a role above one's own, another team's people, another team's form). GitHub and
// Google are fakes. Skipped without DATABASE_URL.
import { createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { createSlotlockDashboard, createSlotlockDashboardResources, createSlotlockDashboardState } from '../dashboard.js';
import { slotlockServeAllowsTenant } from '../self-host.js';
import { createSlotlockStore } from '../store.js';
import { createSlotlockDashboardWorkspaces } from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const ORIGIN = 'https://slotlock.example.com';
const GOOGLE = { clientId: '1234-teams.apps.googleusercontent.com', clientSecret: `GOCSPX-${'t'.repeat(20)}0123456789` };

/** A browser: its cookies, kept as the dashboard sets them. */
class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly dashboard: ReturnType<typeof createSlotlockDashboard>) {}
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
    return this.keep(await this.dashboard.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie: this.header() } })));
  }
  /** Sends the form at `action` on `page` (its CSRF token and single-use value), with `fields`. */
  async post(page: string, action: string, fields: Record<string, string>) {
    const fromPage = await (await this.get(page)).text();
    const at = fromPage.indexOf(`action="/dashboard${action}"`);
    expect(at, `the form ${action} on ${page}`).toBeGreaterThan(-1);
    const rest = fromPage.slice(at, fromPage.indexOf('</form>', at));
    const once = /name="once" value="([^"]+)"/.exec(rest)?.[1];
    const sent = new URLSearchParams({
      csrf: /name="csrf" value="([^"]+)"/.exec(rest)?.[1] as string,
      ...(once ? { once } : {}),
      ...fields,
    });
    return this.send(action, sent);
  }
  async send(action: string, sent: URLSearchParams) {
    return this.keep(
      await this.dashboard.fetch(
        new Request(`${ORIGIN}/dashboard${action}`, {
          method: 'POST',
          headers: { cookie: this.header(), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
          body: sent.toString(),
        }),
      ),
    );
  }
}

describe.skipIf(!url)('team workspaces in the dashboard (real Postgres)', () => {
  const role = `slotlock_dt_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const base = 500_000_000 + Math.floor(Math.random() * 90_000_000);
  /** GitHub's people, by the code their sign-in returns with. */
  const github = new Map<string, { id: number; login: string; emails: { email: string; verified: boolean }[] }>([
    ['ada', { id: base, login: 'ada', emails: [{ email: 'ada@acme.example', verified: true }] }],
    ['bea', { id: base + 1, login: 'bea', emails: [{ email: 'bea@acme.example', verified: true }, { email: 'b@old.example', verified: false }] }],
    ['cy', { id: base + 2, login: 'cy', emails: [{ email: 'cy@acme.example', verified: true }] }],
    ['dee', { id: base + 3, login: 'dee', emails: [{ email: 'dee@elsewhere.example', verified: true }] }],
    ['eli', { id: base + 4, login: 'eli', emails: [] }],
    ['fay', { id: base + 5, login: 'fay', emails: [] }],
    ['gus', { id: base + 6, login: 'gus', emails: [] }],
    ['hal', { id: base + 7, login: 'hal', emails: [] }],
    ['ivy', { id: base + 8, login: 'ivy', emails: [] }],
    ['kim', { id: base + 9, login: 'kim', emails: [] }],
    ['lou', { id: base + 10, login: 'lou', emails: [] }],
  ]);
  const googleSubject = `${base}777`;
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const JWKS = { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'teams-key', alg: 'RS256', use: 'sig' }] };
  let googleClaims: { nonce: string; email: string; verified: unknown } = { nonce: '', email: '', verified: true };
  const tenants: string[] = [];
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let dashboard: ReturnType<typeof createSlotlockDashboard>;

  const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = String(input);
    if (target === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json(JWKS);
    if (target === 'https://oauth2.googleapis.com/token') {
      const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const signed = `${part({ alg: 'RS256', kid: 'teams-key', typ: 'JWT' })}.${part({
        iss: 'https://accounts.google.com',
        aud: GOOGLE.clientId,
        sub: googleSubject,
        email: googleClaims.email,
        email_verified: googleClaims.verified,
        nonce: googleClaims.nonce,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })}`;
      const signature = createSign('RSA-SHA256').update(signed).sign(signing.privateKey).toString('base64url');
      return Response.json({ id_token: `${signed}.${signature}` });
    }
    if (target.endsWith('/access_token')) {
      return Response.json({ access_token: `gho_${new URLSearchParams(String(init.body)).get('code')}` });
    }
    const who = github.get(String(new Headers(init.headers).get('authorization')).replace('Bearer gho_', ''));
    if (!who) return new Response('no', { status: 401 });
    if (target.endsWith('/user/emails')) return Response.json(who.emails.map((entry) => ({ ...entry, primary: false })));
    return Response.json({ id: who.id, login: who.login });
  };

  /** Signs the browser in with GitHub as `code`'s person, asking for `query` as the link would. */
  async function signIn(browser: Browser, code: string, query = '') {
    const start = await browser.get(`/dashboard/sign-in${query}`);
    const location = new URL(start.headers.get('location') ?? '');
    const callback = await browser.get(`/dashboard/callback?code=${code}&state=${location.searchParams.get('state')}`);
    expect(callback.status).toBe(303);
    return { location, callback };
  }
  async function signInWithGoogle(browser: Browser, email: string, verified: unknown, query = '') {
    const start = await browser.get(`/dashboard/sign-in?with=google${query}`);
    const location = new URL(start.headers.get('location') ?? '');
    googleClaims = { nonce: location.searchParams.get('nonce') ?? '', email, verified };
    return browser.get(`/dashboard/callback?code=g&state=${location.searchParams.get('state')}`);
  }
  /** The link the members page showed once, after an invitation. */
  const linkOf = async (response: Response) => {
    const page = await response.text();
    const link = /<code id="invite-link">([^<]+)<\/code>/.exec(page)?.[1];
    expect(link, 'the invitation link').toBeDefined();
    // The token rides in the query, which request logs leave out, never in the path.
    const parsed = new URL((link as string).replaceAll('&amp;', '&'));
    expect(parsed.pathname).toBe('/dashboard/invite');
    expect(parsed.searchParams.get('t')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    return `${parsed.pathname}${parsed.search}`;
  };
  const teamOf = async (browser: Browser) => {
    const page = await (await browser.get('/dashboard/teams')).text();
    return /<option value="(team:[0-9a-f-]{36})" selected>/.exec(await (await browser.get('/dashboard')).text())?.[1] ?? page;
  };

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, { max: 6, onnotice: () => {} });
    dashboard = build();
  });

  /** The dashboard with team workspaces on, as `serve` builds it, and anything a test adds. */
  const secret = randomBytes(32).toString('hex');
  function build(extra: Partial<Parameters<typeof createSlotlockDashboard>[0]> = {}) {
    const store = createSlotlockStore(application);
    return createSlotlockDashboard({
      publicUrl: ORIGIN,
      github: { clientId: 'Ov23liTeams', clientSecret: 'f'.repeat(40) },
      google: GOOGLE,
      sessionSecret: secret,
      allowedUsers: '*',
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store),
      state: createSlotlockDashboardState(application),
      workspaces: createSlotlockDashboardWorkspaces(application),
      teamWorkspaces: true,
      fetch: fakeFetch as typeof fetch,
      ...extra,
    });
  }

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

  it('lets a Google-only person invited by email join, by a link that consumes nothing until then', async () => {
    const ada = new Browser(dashboard);
    await signIn(ada, 'ada');
    const created = await ada.post('/dashboard/teams', '/teams/create', { name: 'Acme Rentals' });
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toBe('/dashboard/settings/members');
    const team = await teamOf(ada);
    expect(team).toMatch(/^team:/);
    tenants.push(team);
    const members = await (await ada.get('/dashboard/settings/members')).text();
    expect(members).toContain('<h3 class="list-head">People<span class="count">1</span></h3>');
    // People are a list with the page's width, as every Settings section is, not a table in a form's
    // column that scrolls sideways.
    expect(members).toContain('<div class="settings">');
    expect(members).not.toContain('<table');
    expect(members).toContain('@ada');

    const invited = await ada.post('/dashboard/settings/members', '/members/invite', { email: 'Desk@Clinic.example', role: 'member' });
    expect(invited.status).toBe(200);
    const link = await linkOf(invited);
    // The link is shown once: the page again shows the invitation, not its link.
    const again = await (await ada.get('/dashboard/settings/members')).text();
    expect(again).toContain('desk@clinic.example');
    expect(again).not.toContain(link);

    // Opened twice, as a link scanner and then the person: nothing is consumed.
    const scanner = new Browser(dashboard);
    expect((await scanner.get(link)).status).toBe(303);
    const desk = new Browser(dashboard);
    const opened = await desk.get(link);
    expect(opened.status).toBe(303);
    expect(opened.headers.get('location')).toBe('/dashboard/invite');
    expect(opened.headers.get('referrer-policy')).toBe('no-referrer');
    const preview = await (await desk.get('/dashboard/invite')).text();
    expect(preview).toContain('Join Acme Rentals');
    expect(preview).toContain('d•••@clinic.example');
    expect(preview).not.toContain('desk@clinic.example');
    // One card, as signing in is: the team, role and who invited, then the ways in at full width
    // (in a table cell's right-aligned actions they sat off centre, 2026-11-12).
    expect(preview).toContain('<section class="sign-in invite">');
    expect(preview).toContain('<dl class="invite-facts"><div><dt>Team</dt><dd>Acme Rentals</dd></div><div><dt>Role</dt><dd>Member</dd></div><div><dt>Invited by</dt><dd>@ada</dd></div>');
    expect(preview).toContain('<a class="button primary wide" href="/dashboard/sign-in?then=%2Finvite&amp;email=1">');
    expect(preview).toContain('<a class="button wide" href="/dashboard/sign-in?with=google&amp;then=%2Finvite">');
    expect(preview).not.toContain('class="actions"');
    expect(await (await scanner.get('/dashboard/invite')).text()).toContain('Join Acme Rentals');

    // Google, with the address unverified: not this person's to accept.
    const unverified = await signInWithGoogle(desk, 'desk@clinic.example', false, '&then=%2Finvite');
    expect(unverified.headers.get('location')).toBe('/dashboard/invite');
    expect(await (await desk.get('/dashboard/invite')).text()).toContain('you’re signed in as Google account');
    const refused = await desk.post('/dashboard/invite', '/sign-out', {});
    expect(refused.status).toBe(303);

    // Verified ("true" as Google sometimes sends it): joins, and works in the team at once.
    await signInWithGoogle(desk, 'desk@clinic.example', 'true', '&then=%2Finvite');
    const ready = await (await desk.get('/dashboard/invite')).text();
    expect(ready).toContain('Join as desk@clinic.example');
    const joined = await desk.post('/dashboard/invite', '/invite/accept', {});
    expect(joined.status).toBe(303);
    expect(desk.cookies.has('__Host-slotlock-invite')).toBe(false);
    expect(await teamOf(desk)).toBe(team);
    const workspaces = createSlotlockDashboardWorkspaces(application);
    expect((await workspaces.standing(team, `google:${googleSubject}`, null)).role).toBe('member');
    // The link is spent for everyone, the scanner included.
    expect(await (await scanner.get('/dashboard/invite')).text()).toContain('<h1>This invitation was already used</h1>');
    const roster = await (await ada.get('/dashboard/settings/members')).text();
    expect(roster).toContain('desk@clinic.example');
    expect(roster).toContain('<h3 class="list-head">People<span class="count">2</span></h3>');
  });

  it('lets a GitHub person join by the address GitHub verified, and never by one it did not', async () => {
    const ada = new Browser(dashboard);
    await signIn(ada, 'ada');
    await ada.post('/dashboard/teams', '/teams/create', { name: 'Depot' });
    const team = await teamOf(ada);
    tenants.push(team);
    const link = await linkOf(await ada.post('/dashboard/settings/members', '/members/invite', { email: 'bea@acme.example', role: 'developer' }));

    // Dee holds the link but not the address: GitHub is asked, and says no.
    const dee = new Browser(dashboard);
    await dee.get(link);
    const { location } = await signIn(dee, 'dee', '?then=%2Finvite&email=1');
    expect(location.searchParams.get('scope')).toBe('user:email');
    expect(await (await dee.get('/dashboard/invite?checked=1')).text()).toContain('None of the addresses GitHub verified for @dee is it.');
    const sent = new URLSearchParams();
    const page = await (await dee.get('/dashboard/teams')).text();
    sent.set('csrf', /name="csrf" value="([^"]+)"/.exec(page)?.[1] as string);
    sent.set('once', /name="once" value="([^"]+)"/.exec(page)?.[1] as string);
    const stolen = await dee.send('/invite/accept', sent);
    expect(stolen.status).toBe(403);
    expect(await stolen.text()).toContain('This invitation is for another account.');

    // Bea: asked for her addresses on the way in, and joins as a Developer.
    const bea = new Browser(dashboard);
    await bea.get(link);
    const unsigned = await (await bea.get('/dashboard/invite')).text();
    expect(unsigned).toContain('/dashboard/sign-in?then=%2Finvite&amp;email=1');
    await signIn(bea, 'bea', '?then=%2Finvite&email=1');
    expect(bea.cookies.get('__Host-slotlock-session')).toBeDefined();
    expect((await bea.post('/dashboard/invite', '/invite/accept', {})).status).toBe(303);
    expect((await createSlotlockDashboardWorkspaces(application).standing(team, `github:${base + 1}`, null)).role).toBe('developer');
  });

  it("refuses a role above one's own, and records each refusal", async () => {
    const ada = new Browser(dashboard);
    await signIn(ada, 'ada');
    await ada.post('/dashboard/teams', '/teams/create', { name: 'Ceilings' });
    const team = await teamOf(ada);
    tenants.push(team);
    for (const [code, person, roleName] of [['cy', `github:${base + 2}`, 'member'], ['bea', `github:${base + 1}`, 'admin']] as const) {
      const link = await linkOf(await ada.post('/dashboard/settings/members', '/members/invite', { email: `${code}@acme.example`, role: roleName }));
      const browser = new Browser(dashboard);
      await browser.get(link);
      await signIn(browser, code, '?then=%2Finvite&email=1');
      expect((await browser.post('/dashboard/invite', '/invite/accept', {})).status).toBe(303);
      expect((await createSlotlockDashboardWorkspaces(application).standing(team, person, null)).role).toBe(roleName);
    }
    // A Member sends the invitation form (it is not shown them) asking for an Owner.
    const cy = new Browser(dashboard);
    await signIn(cy, 'cy');
    await cy.post('/dashboard/teams', '/organization', { organization: team });
    expect(await (await cy.get('/dashboard/settings/members')).text()).not.toContain('action="/dashboard/members/invite"');
    const page = await (await cy.get('/dashboard/settings/members')).text();
    const form = () =>
      new URLSearchParams({
        csrf: /name="csrf" value="([^"]+)"/.exec(page)?.[1] as string,
        once: /name="once" value="([^"]+)"/.exec(page.slice(page.indexOf('/members/leave')))?.[1] as string,
        email: 'x@acme.example',
        role: 'owner',
      });
    const member = await cy.send('/members/invite', form());
    expect(member.status).toBe(403);
    expect(await member.text()).toContain('As a Member in this workspace, you can&#39;t manage members.');
    // An Admin asks for a Billing manager, and to make the Member an Owner.
    const bea = new Browser(dashboard);
    await signIn(bea, 'bea');
    await bea.post('/dashboard/teams', '/organization', { organization: team });
    const billing = await bea.post('/dashboard/settings/members', '/members/invite', { email: 'y@acme.example', role: 'billing' });
    expect(billing.status).toBe(403);
    expect(await billing.text()).toContain('you can&#39;t change the plan or billing');
    const owner = await bea.post('/dashboard/settings/members', '/members/role', { person: `github:${base + 2}`, role: 'owner' });
    expect(owner.status).toBe(403);
    const denied = await admin<{ action: string; reason: string }[]>`
      SELECT action, reason FROM slotlock.audit_events WHERE tenant_ref = ${team} AND outcome = 'denied' ORDER BY occurred_at`;
    expect(denied.map((row) => row.reason)).toEqual(['needs members.manage', 'needs billing.manage', 'needs workspace.own']);
    // Nothing was made: no invitation to either address, and Cy is still a Member.
    expect(await (await ada.get('/dashboard/settings/members')).text()).not.toContain('y@acme.example');
    expect((await createSlotlockDashboardWorkspaces(application).standing(team, `github:${base + 2}`, null)).role).toBe('member');
  });

  it("keeps each team's people and forms to itself", async () => {
    const ada = new Browser(dashboard);
    await signIn(ada, 'ada');
    await ada.post('/dashboard/teams', '/teams/create', { name: 'North' });
    const north = await teamOf(ada);
    tenants.push(north);
    const eli = new Browser(dashboard);
    await signIn(eli, 'eli');
    await eli.post('/dashboard/teams', '/teams/create', { name: 'South' });
    const south = await teamOf(eli);
    tenants.push(south);
    // Ada, Owner of North, removes South's Owner: no such member here.
    const northPage = await (await ada.get('/dashboard/settings/members')).text();
    const invite = northPage.slice(northPage.indexOf('action="/dashboard/members/invite"'));
    const removed = await ada.send(
      '/members/remove',
      new URLSearchParams({
        csrf: /name="csrf" value="([^"]+)"/.exec(invite)?.[1] as string,
        once: /name="once" value="([^"]+)"/.exec(invite)?.[1] as string,
        person: `github:${base + 4}`,
        keys: 'revoke',
      }),
    );
    expect(removed.status).toBe(404);
    expect((await createSlotlockDashboardWorkspaces(application).standing(south, `github:${base + 4}`, null)).role).toBe('owner');
    // Switching to a team she is not in is refused.
    const switched = await ada.post('/dashboard/teams', '/organization', { organization: south });
    expect(switched.status).toBe(400);
    // A form from her personal workspace's page, sent once she is in North, is another workspace's.
    await ada.post('/dashboard/teams', '/organization', { organization: '' });
    const personal = await (await ada.get('/dashboard/teams')).text();
    await ada.post('/dashboard/teams', '/organization', { organization: north });
    const replayed = await ada.send(
      '/members/invite',
      new URLSearchParams({
        csrf: /name="csrf" value="([^"]+)"/.exec(personal)?.[1] as string,
        once: /name="once" value="([^"]+)"/.exec(personal)?.[1] as string,
        email: 'z@acme.example',
        role: 'member',
      }),
    );
    expect(replayed.status).toBe(409);
    expect(await replayed.text()).toContain('That page was for another workspace.');
  });

  it('removes a member at their next request, with the keys they made, and keeps an owner when one leaves', async () => {
    const ada = new Browser(dashboard);
    await signIn(ada, 'ada');
    await ada.post('/dashboard/teams', '/teams/create', { name: 'Fleet' });
    const team = await teamOf(ada);
    tenants.push(team);
    const link = await linkOf(await ada.post('/dashboard/settings/members', '/members/invite', { email: 'cy@acme.example', role: 'developer' }));
    const cy = new Browser(dashboard);
    await cy.get(link);
    await signIn(cy, 'cy', '?then=%2Finvite&email=1');
    await cy.post('/dashboard/invite', '/invite/accept', {});
    expect(await teamOf(cy)).toBe(team);
    expect((await cy.post('/dashboard/keys', '/keys', { name: 'Cy agent', access: 'read_write', expires: '30' })).status).toBe(200);
    const keys = createSlotlockApiKeyStore(application);
    expect((await keys.list({ tenantRef: team })).filter((key) => key.revokedAt === null)).toHaveLength(1);

    // The only Owner may not leave; once Cy is an Owner too, she may, and Cy is left the Owner.
    expect(await (await ada.get('/dashboard/settings/members')).text()).toContain('The only owner, so can’t leave');
    expect((await ada.post('/dashboard/settings/members', '/members/role', { person: `github:${base + 2}`, role: 'owner' })).status).toBe(200);
    expect((await createSlotlockDashboardWorkspaces(application).standing(team, `github:${base + 2}`, null)).role).toBe('owner');
    const left = await ada.post('/dashboard/settings/members', '/members/leave', {});
    expect(left.status).toBe(303);
    expect(await teamOf(ada)).not.toBe(team);

    // Cy invites Ada back as an Admin, then removes her, revoking what she made.
    const back = await linkOf(await cy.post('/dashboard/settings/members', '/members/invite', { email: 'ada@acme.example', role: 'admin' }));
    await ada.get(back);
    await signIn(ada, 'ada', '?then=%2Finvite&email=1');
    await ada.post('/dashboard/invite', '/invite/accept', {});
    expect((await ada.post('/dashboard/keys', '/keys', { name: 'Ada agent', access: 'read', expires: '30' })).status).toBe(200);
    const gone = await cy.post('/dashboard/settings/members', '/members/remove', { person: `github:${base}`, keys: 'revoke' });
    expect(gone.status).toBe(200);
    expect(await gone.text()).toContain('@ada was removed, and 1 key they created revoked.');
    const kept = (await keys.list({ tenantRef: team })).filter((key) => key.revokedAt === null);
    expect(kept.map((key) => key.name)).toEqual(['Cy agent']);
    // Her next request is in her own workspace, not the team's.
    const next = await ada.get('/dashboard/settings/members');
    expect(next.status).toBe(404);
    expect(await teamOf(ada)).not.toBe(team);
  });

  it('limits a member to a location: its resources and nothing of the whole team, and the keys they made go (RFC 0004 D1)', async () => {
    const ada = new Browser(dashboard);
    await signIn(ada, 'ada');
    await ada.post('/dashboard/teams', '/teams/create', { name: 'Depots' });
    const team = await teamOf(ada);
    tenants.push(team);
    const link = await linkOf(await ada.post('/dashboard/settings/members', '/members/invite', { email: 'cy@acme.example', role: 'admin' }));
    const cy = new Browser(dashboard);
    await cy.get(link);
    await signIn(cy, 'cy', '?then=%2Finvite&email=1');
    await cy.post('/dashboard/invite', '/invite/accept', {});
    expect(await teamOf(cy)).toBe(team);
    expect((await cy.post('/dashboard/keys', '/keys', { name: 'Cy agent', access: 'read_write', expires: '30' })).status).toBe(200);
    const store = createSlotlockStore(application);
    const south = await store.withTenant(team, async (tenant) => {
      await tenant.putLocation({ tenantRef: team, ref: 'north', name: 'North' });
      await tenant.putLocation({ tenantRef: team, ref: 'south', name: 'South' });
      await tenant.createResource({ tenantRef: team, externalRef: 'van-north', timezone: 'UTC', location: 'north' });
      return tenant.createResource({ tenantRef: team, externalRef: 'van-south', timezone: 'UTC', location: 'south' });
    });
    const cyRef = `github:${base + 2}`;

    // An Owner limits Cy to North; the keys Cy made reached all of it, so they go.
    const limited = await ada.post('/dashboard/settings/members', '/members/scope', { person: cyRef, access: 'limited', locations: 'north', keys: 'revoke' });
    expect(limited.status).toBe(200);
    const said = await limited.text();
    expect(said).toContain('@cy now reaches only the resources at those locations and in those groups, and 1 key they created was revoked.');
    expect(said).toContain(' · Reaches Locations north');
    const keys = createSlotlockApiKeyStore(application);
    expect((await keys.list({ tenantRef: team })).filter((key) => key.revokedAt === null)).toEqual([]);
    // A location the team does not have, or none, is refused.
    expect((await ada.post('/dashboard/settings/members', '/members/scope', { person: cyRef, access: 'limited', locations: 'west' })).status).toBe(400);
    expect((await ada.post('/dashboard/settings/members', '/members/scope', { person: cyRef, access: 'limited' })).status).toBe(400);

    // Cy's next request: North's van, never South's, and nothing that is the whole team's.
    const listed = await (await cy.get('/dashboard/resources')).text();
    expect(listed).toContain('van-north');
    expect(listed).not.toContain('van-south');
    expect((await cy.get(`/dashboard/resources/${south.id}`)).status).toBe(404);
    expect((await cy.get('/dashboard/keys')).status).toBe(403);
    expect((await cy.get('/dashboard/settings/audit')).status).toBe(403);
    // Cy's Members page shows the team's people, and no form to change them.
    const members = await (await cy.get('/dashboard/settings/members')).text();
    expect(members).not.toContain('action="/dashboard/members/scope"');
    expect(members).not.toContain('action="/dashboard/members/invite"');

    // Given all of it again.
    expect((await ada.post('/dashboard/settings/members', '/members/scope', { person: cyRef, access: 'all' })).status).toBe(200);
    expect(await (await cy.get('/dashboard/resources')).text()).toContain('van-south');
    expect((await cy.get('/dashboard/keys')).status).toBe(200);
    const changes = await admin<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM slotlock.audit_events
       WHERE tenant_ref = ${team} AND action = 'member.scope_changed' ORDER BY occurred_at, id`;
    expect(changes.map((change) => change.metadata)).toEqual([
      { locations: ['north'], groups: [], keys: 'revoked', revoked: 1 },
      { reaches: 'all' },
    ]);
  });

  it("shows an Owner the team's audit log, filtered and a page at a time, and nobody below Admin", async () => {
    const ada = new Browser(dashboard);
    await signIn(ada, 'ada');
    await ada.post('/dashboard/teams', '/teams/create', { name: 'Audited' });
    const team = await teamOf(ada);
    tenants.push(team);
    const link = await linkOf(await ada.post('/dashboard/settings/members', '/members/invite', { email: 'cy@acme.example', role: 'member' }));
    const cy = new Browser(dashboard);
    await cy.get(link);
    await signIn(cy, 'cy', '?then=%2Finvite&email=1');
    await cy.post('/dashboard/invite', '/invite/accept', {});
    const log = await (await ada.get('/dashboard/settings/audit')).text();
    expect(log).toContain('created the team');
    expect(log).toContain('invited someone');
    expect(log).toContain('@cy');
    expect(log).toContain('joined');
    const filtered = await (await ada.get('/dashboard/settings/audit?action=member.invited')).text();
    const what = (page: string) => [...page.matchAll(/<td data-label="What">([^<]+)/g)].map(([, text]) => text);
    expect(new Set(what(filtered))).toEqual(new Set(['invited someone']));
    expect(what(log)).toContain('created the team');
    // A Member may not read it, and is told why; the page is not in their settings.
    const refused = await cy.get('/dashboard/settings/audit');
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('can&#39;t read the audit log');
    expect(await (await cy.get('/dashboard/settings/account')).text()).not.toContain('/dashboard/settings/audit');
    // Fifty a page, the next by its cursor: 60 more events make two pages and one row over.
    for (let index = 0; index < 60; index++) {
      await admin`
        INSERT INTO slotlock.audit_events (tenant_ref, action, actor_type, actor_ref, outcome)
        VALUES (${team}, 'api_key.created', 'person', ${`github:${base}`}, 'success')`;
    }
    const first = await (await ada.get('/dashboard/settings/audit')).text();
    const older = /<a href="(\/dashboard\/settings\/audit\?before=[^"]+)">Older<\/a>/.exec(first)?.[1];
    expect(older, 'the Older link').toBeDefined();
    expect([...first.matchAll(/<td data-label="When">/g)]).toHaveLength(50);
    const second = await (await ada.get((older as string).replaceAll('&amp;', '&'))).text();
    expect(second).toContain('created the team');
    expect(second).toContain('Newest');
  });

  it("lists where a person is signed in, and signs one device out from another", async () => {
    const laptop = new Browser(dashboard);
    const phone = new Browser(dashboard);
    await signIn(laptop, 'fay');
    await signIn(phone, 'fay');
    const account = await (await laptop.get('/dashboard/settings/account')).text();
    expect([...account.matchAll(/<td data-label="Device"/g)]).toHaveLength(2);
    expect(account).toContain('This device');
    const other = [...account.matchAll(/name="id" value="([0-9a-f]{64})"/g)].map(([, id]) => id);
    expect(other).toHaveLength(1);
    const ended = await laptop.post('/dashboard/settings/account', '/sessions/end', { id: other[0] as string });
    expect(ended.status).toBe(200);
    expect(await ended.text()).toContain('Signed out of that device.');
    // The phone's next request is signed out; the laptop goes on.
    expect(await (await phone.get('/dashboard')).text()).toContain('Continue with GitHub');
    expect((await laptop.get('/dashboard/settings/account')).status).toBe(200);
    // Its own session it ends with Sign out, not here.
    const own = (await (await laptop.get('/dashboard/settings/account')).text()).includes('name="id"');
    expect(own).toBe(false);
    // Sign out everywhere ends them all, this one too.
    await signIn(phone, 'fay');
    await laptop.post('/dashboard/settings/account', '/sign-out-everywhere', {});
    expect(await (await phone.get('/dashboard')).text()).toContain('Continue with GitHub');
    const rows = await admin<{ open: number }[]>`
      SELECT count(*)::int AS open FROM slotlock.dashboard_sessions WHERE person_ref = ${`github:${base + 5}`} AND ended_at IS NULL`;
    expect(rows[0]?.open).toBe(0);
  });

  it('offers a team Team, opened by its Owner, and emails invitations where a sender is set', async () => {
    const checkouts: unknown[] = [];
    const sent: unknown[] = [];
    const billed = build({
      billing: {
        plan: async () => null,
        enrol: async () => undefined,
        checkout: async (input) => {
          checkouts.push(input);
          return 'https://checkout.stripe.com/c/pay/cs_test_team';
        },
        portal: async () => 'https://billing.stripe.com/p/session/test',
        prices: { month: '$10', year: '$100' },
        teamPrices: { month: '$40', year: '$400' },
        contact: 'mailto:founder@example.com',
        formOrigins: ['https://checkout.stripe.com', 'https://billing.stripe.com'],
      },
      invitations: {
        send: async (invitation) => {
          sent.push(invitation);
        },
      },
    });
    // Fay has no team yet: where plans apply, each person creates one on Free.
    const ada = new Browser(billed);
    await signIn(ada, 'fay');
    await ada.post('/dashboard/teams', '/teams/create', { name: 'Paying' });
    const team = await teamOf(ada);
    tenants.push(team);
    expect(await (await ada.get('/dashboard/plan')).text()).toContain('$40');
    // A name that would carry an address into the invitations sent is refused.
    for (const name of ['Claim at evil.example', 'Visit https://x.io', 'Mail me@x.io', 'www.x co']) {
      const refusedName = await ada.post('/dashboard/teams', '/teams/create', { name });
      expect(refusedName.status, name).toBe(400);
      expect(await refusedName.text()).toContain('can&#39;t hold a web or email address');
    }
    // A second free team is refused, with what to do.
    const second = await ada.post('/dashboard/teams', '/teams/create', { name: 'Again' });
    expect(second.status).toBe(403);
    expect(await second.text()).toContain('Each person may create 1 team on the Free plan.');
    const upgraded = await ada.post('/dashboard/plan', '/plan/upgrade', { interval: 'month' });
    expect(upgraded.status).toBe(303);
    expect(checkouts).toEqual([expect.objectContaining({ tenantRef: team, plan: 'team', interval: 'month' })]);
    // On Free a team holds 3 people: the Owner and two invitations, then Upgrade.
    const invited = await ada.post('/dashboard/settings/members', '/members/invite', { email: 'Desk@Clinic.example', role: 'member' });
    expect(await invited.text()).toContain('Invitation sent to desk@clinic.example.');
    expect(sent).toEqual([
      expect.objectContaining({ to: 'desk@clinic.example', workspace: 'Paying', inviter: '@fay', role: 'Member', link: expect.stringMatching(/\/dashboard\/invite\?t=/) }),
    ]);
    await ada.post('/dashboard/settings/members', '/members/invite', { email: 'two@clinic.example', role: 'member' });
    const full = await (await ada.get('/dashboard/settings/members')).text();
    expect(full).toContain('<strong>3 of 3 people</strong> on the Free plan, open invitations included. Upgrade to invite more.');
    expect(full).not.toContain('action="/dashboard/members/invite"');
  });

  it('holds a team on Developer to 3 people, as on Free: only Team lifts the limit', async () => {
    let plan: 'team' | 'developer' = 'developer';
    const planned = build({
      plans: {
        plan: async () => ({
          plan,
          status: 'active',
          limits: { resources: 100, apiKeys: 100, webhookEndpoints: 10 },
          stripeCustomer: null,
          stripeSubscription: null,
          currentPeriodEnd: null,
        }),
      },
    });
    const hal = new Browser(planned);
    await signIn(hal, 'hal');
    await hal.post('/dashboard/teams', '/teams/create', { name: 'On Developer' });
    tenants.push(await teamOf(hal));
    for (const email of ['one@clinic.example', 'two@clinic.example']) {
      await hal.post('/dashboard/settings/members', '/members/invite', { email, role: 'member' });
    }
    const full = await (await hal.get('/dashboard/settings/members')).text();
    expect(full).toContain('<strong>3 of 3 people</strong>');
    expect(full).not.toContain('action="/dashboard/members/invite"');
    plan = 'team';
    expect(await (await hal.get('/dashboard/settings/members')).text()).toContain('action="/dashboard/members/invite"');
  });

  it('takes a person from their own Usage page to Team for a team they bill for, at the prices Stripe charges', async () => {
    const checkouts: Array<{ tenantRef: string; plan?: string; interval: string }> = [];
    const billed = build({
      plans: {
        plan: async () => ({
          plan: 'free',
          status: 'active',
          limits: { resources: 10, apiKeys: 10, webhookEndpoints: 2 },
          stripeCustomer: null,
          stripeSubscription: null,
          currentPeriodEnd: null,
        }),
      },
      billing: {
        plan: async () => null,
        checkout: async (input) => {
          checkouts.push(input);
          return 'https://checkout.stripe.com/c/pay/cs_test_team';
        },
        portal: async () => 'https://billing.stripe.com/p/session/test',
        // Stale labels, as a deployment might still set them: the page shows Stripe's amounts.
        prices: { month: '$10', year: '$100' },
        teamPrices: { month: '$40', year: '$400' },
        shownPrices: async () => ({ prices: { month: '£5', year: '£50' }, teamPrices: { month: '£15', year: '£150' } }),
        contact: 'mailto:founder@example.com',
        formOrigins: ['https://checkout.stripe.com', 'https://billing.stripe.com'],
      },
    });
    // With no team yet, Team is a team workspace to make.
    const kim = new Browser(billed);
    await signIn(kim, 'kim');
    const before = await (await kim.get('/dashboard/plan')).text();
    expect(before).toContain('<a class="button primary" href="/dashboard/teams#team-name">Create a team workspace</a>');
    expect(before).toContain('Monthly, £5 a month');
    expect(before).toContain('<span class="price-amount">£15</span>');
    expect(before).not.toContain('$10');

    await kim.post('/dashboard/teams', '/teams/create', { name: 'Kim Rentals' });
    const team = await teamOf(kim);
    tenants.push(team);
    await kim.post('/dashboard', '/organization', { organization: '' });
    // Their own workspace now offers Team for the team they own, one step away.
    const personal = await (await kim.get('/dashboard/plan')).text();
    expect(personal).toContain('Upgrade to Developer');
    expect(personal).toContain(`<input type="hidden" name="organization" value="${team}"><input type="hidden" name="then" value="/plan"><button class="primary" type="submit">Upgrade Kim Rentals</button>`);

    // The step lands on the team's Usage page, where Team is bought; nowhere else is a landing.
    const moved = await kim.post('/dashboard/plan', '/organization', { organization: team, then: '/plan' });
    expect(moved.headers.get('location')).toBe('/dashboard/plan');
    const teamPage = await (await kim.get('/dashboard/plan')).text();
    expect(teamPage).toContain('Monthly, £15 a month');
    expect(teamPage).toContain('Upgrade to Team');
    expect(teamPage).not.toContain('Upgrade to Developer');
    expect(teamPage).toContain('<input type="hidden" name="organization" value=""><input type="hidden" name="then" value="/plan"><button type="submit">Go to your workspace</button>');
    const bought = await kim.post('/dashboard/plan', '/plan/upgrade', { interval: 'year' });
    expect(bought.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_team');
    expect(checkouts).toEqual([expect.objectContaining({ tenantRef: team, plan: 'team', interval: 'year' })]);
    const elsewhere = await kim.post('/dashboard/plan', '/organization', { organization: '', then: 'https://evil.example/' });
    expect(elsewhere.headers.get('location')).toBe('/dashboard');
  });

  it('exports the audit log on Team, as CSV a spreadsheet will not run and as JSON with its chain', async () => {
    let plan: 'team' | 'free' = 'free';
    const planned = build({
      plans: {
        plan: async () => ({
          plan,
          status: 'active',
          limits: { resources: 500, apiKeys: 100, webhookEndpoints: 25 },
          stripeCustomer: null,
          stripeSubscription: null,
          currentPeriodEnd: null,
        }),
      },
    });
    const gus = new Browser(planned);
    await signIn(gus, 'gus');
    await gus.post('/dashboard/teams', '/teams/create', { name: 'Exported' });
    const team = await teamOf(gus);
    tenants.push(team);
    await admin`
      INSERT INTO slotlock.audit_events (tenant_ref, action, actor_type, actor_ref, outcome, reason)
      VALUES (${team}, 'authz.denied', 'person', ${`github:${base + 6}`}, 'denied', '=HYPERLINK("https://evil.example")')`;
    const refused = await gus.get('/dashboard/settings/audit/export?format=csv');
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('Exports come with the Team plan.');
    plan = 'team';
    const csv = await gus.get('/dashboard/settings/audit/export?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.headers.get('content-disposition')).toMatch(/^attachment; filename="slotlock-audit-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (await csv.text()).split('\r\n');
    expect(lines[0]).toBe('occurred_at,action,outcome,actor_type,actor_ref,actor_role,target_type,target_ref,reason,ip_address,user_agent,metadata,chain_index,hash');
    const denied = lines.find((line) => line.includes('"authz.denied"')) as string;
    expect(denied).toContain(`"'=HYPERLINK(""https://evil.example"")"`);
    // Whitespace before a formula is no way round it.
    await admin`
      INSERT INTO slotlock.audit_events (tenant_ref, action, actor_type, actor_ref, outcome, reason)
      VALUES (${team}, 'authz.denied', 'person', ${`github:${base + 6}`}, 'denied', ' =1+1')`;
    expect(await (await gus.get('/dashboard/settings/audit/export?format=csv')).text()).toContain(`"' =1+1"`);
    expect(lines.some((line) => line.includes('"workspace.created"'))).toBe(true);
    const json = (await (await gus.get('/dashboard/settings/audit/export?format=json&action=workspace.created')).json()) as {
      action: string;
      chain_index: string;
      hash: string;
      metadata: unknown;
    }[];
    expect(json.map((event) => event.action)).toEqual(['workspace.created']);
    expect(json[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    // The export is itself recorded, and the log checks out.
    expect(await (await gus.get('/dashboard/settings/audit?action=audit.exported')).text()).toContain('exported the audit log');
    expect(await (await gus.get('/dashboard/settings/audit?verify=1')).text()).toContain('The log is unbroken');
  });

  it('deletes a team after an Owner types its handle, tells every member, and lets an Owner keep it', async () => {
    const hal = new Browser(dashboard);
    await signIn(hal, 'hal');
    await hal.post('/dashboard/teams', '/teams/create', { name: 'Short Lived' });
    const team = await teamOf(hal);
    tenants.push(team);
    const page = await (await hal.get('/dashboard/settings/team')).text();
    expect(page).toContain('1 member, 0 resources');
    expect(page).toContain('Type short-lived to confirm');
    // A danger card: what goes, the handle typed in a row, and the action in its red foot.
    expect(page).toContain('<section class="set-card danger"><header class="panel-head"><h3>Delete team</h3>');
    expect(page).toContain('<label class="row-label" for="confirm-handle">Type short-lived to confirm</label>');
    const wrong = await hal.post('/dashboard/settings/team', '/teams/delete', { confirm: 'short' });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('Type the team&#39;s handle to confirm.');
    const asked = await hal.post('/dashboard/settings/team', '/teams/delete', { confirm: 'short-lived' });
    expect(asked.status).toBe(303);
    const banner = await (await hal.get('/dashboard')).text();
    expect(banner).toContain('This team is deleted on');
    expect(banner).toContain('its keys are refused.');
    // Being deleted, it takes no plan: kept first.
    const checkouts: unknown[] = [];
    const billed = build({
      billing: {
        plan: async () => null,
        enrol: async () => undefined,
        checkout: async (input) => {
          checkouts.push(input);
          return 'https://checkout.stripe.com/c/pay/cs_test_deleting';
        },
        portal: async () => 'https://billing.stripe.com/p/session/test',
        prices: { month: '$10', year: '$100' },
        teamPrices: { month: '$40', year: '$400' },
        contact: 'mailto:founder@example.com',
        formOrigins: ['https://checkout.stripe.com', 'https://billing.stripe.com'],
      },
    });
    const paying = new Browser(billed);
    for (const [name, value] of hal.cookies) paying.cookies.set(name, value);
    const upgrade = await paying.post('/dashboard/plan', '/plan/upgrade', { interval: 'month' });
    expect(upgrade.status).toBe(409);
    expect(await upgrade.text()).toContain('This team is being deleted.');
    expect(checkouts).toEqual([]);
    expect(await createSlotlockDashboardWorkspaces(application).teams?.isActive(team)).toBe(false);
    expect((await hal.post('/dashboard/settings/team', '/teams/restore', {})).status).toBe(303);
    expect(await (await hal.get('/dashboard')).text()).not.toContain('This team is deleted on');
    expect(await createSlotlockDashboardWorkspaces(application).teams?.isActive(team)).toBe(true);
    const audited = await (await hal.get('/dashboard/settings/audit')).text();
    expect(audited).toContain('asked for the team to be deleted');
    expect(audited).toContain('kept the team');
  });

  it('counts a team being deleted against the Free limit, so keeping it never makes a second free team', async () => {
    const lou = new Browser(build({ plans: { plan: async () => null } }));
    await signIn(lou, 'lou');
    await lou.post('/dashboard/teams', '/teams/create', { name: 'First Try' });
    const first = await teamOf(lou);
    tenants.push(first);
    expect((await lou.post('/dashboard/settings/team', '/teams/delete', { confirm: 'first-try' })).status).toBe(303);
    // Until it goes, any Owner can keep it: it is still the one free team its creator may hold.
    const second = await lou.post('/dashboard/teams', '/teams/create', { name: 'Second Try' });
    expect(second.status).toBe(403);
    expect(await second.text()).toContain(
      'Each person may create 1 team on the Free plan. A team being deleted counts until it goes.',
    );
    expect((await lou.post('/dashboard/settings/team', '/teams/restore', {})).status).toBe(303);
    const person = `github:${String(github.get('lou')?.id)}`;
    expect(await admin`SELECT tenant_ref, status FROM slotlock.workspaces WHERE created_by = ${person}`).toEqual([
      { tenant_ref: first, status: 'active' },
    ]);
  });

  it("serves a team's keys only with team workspaces on", () => {
    expect(slotlockServeAllowsTenant({ allowedUsers: '*', teamWorkspaces: true }, `team:${randomUUID()}~test`)).toBe(true);
    expect(slotlockServeAllowsTenant({ allowedUsers: '*' }, `team:${randomUUID()}`)).toBe(false);
  });
  it('tells a suspended person why on every page, and shows what staff did in their audit log', async () => {
    const ivy = new Browser(dashboard);
    await signIn(ivy, 'ivy');
    const person = `github:${String(github.get('ivy')?.id)}`;
    tenants.push(person);
    // As the admin console does it (RFC 0006): a suspension with a message, and the record in the
    // person's own audit log, by a support member.
    await admin`SELECT slotlock.staff_add('github:41', 'support', 'cli:test', NULL, NULL)`;
    await admin`
      INSERT INTO slotlock.tenant_suspensions (tenant_ref, reason, customer_message, suspended_by)
      VALUES (${person}, 'internal: matches abuse case 7', 'Write to abuse@pylota.io to discuss this.', 'github:41')`;
    await admin`SELECT slotlock.staff_customer_audit('github:41', ${person}, 'staff.account_suspended', NULL, NULL, 'Card testing reported')`;

    const page = await (await ivy.get('/dashboard')).text();
    expect(page).toContain('This account is suspended.');
    expect(page).toContain('Write to abuse@pylota.io to discuss this.');
    // The internal reason is staff's, never the customer's page.
    expect(page).not.toContain('abuse case 7');
    const audit = await (await ivy.get('/dashboard/settings/audit')).text();
    expect(audit).toContain('Slotlock staff (Support)');
    expect(audit).toContain('suspended the account');
    expect(audit).toContain('Card testing reported');

    await admin`DELETE FROM slotlock.tenant_suspensions WHERE tenant_ref = ${person}`;
    expect(await (await ivy.get('/dashboard')).text()).not.toContain('This account is suspended.');
  });
});
