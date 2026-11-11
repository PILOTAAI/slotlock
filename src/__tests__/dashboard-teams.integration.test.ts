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
    const store = createSlotlockStore(application);
    dashboard = createSlotlockDashboard({
      publicUrl: ORIGIN,
      github: { clientId: 'Ov23liTeams', clientSecret: randomBytes(20).toString('hex') },
      google: GOOGLE,
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: '*',
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store),
      state: createSlotlockDashboardState(application),
      workspaces: createSlotlockDashboardWorkspaces(application),
      teamWorkspaces: true,
      fetch: fakeFetch as typeof fetch,
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
    expect(members).toContain('<h2>Members · 1</h2>');
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
    expect((await workspaces.standing(team, `google:${googleSubject}`)).role).toBe('member');
    // The link is spent for everyone, the scanner included.
    expect(await (await scanner.get('/dashboard/invite')).text()).toContain('This invitation was already used.');
    const roster = await (await ada.get('/dashboard/settings/members')).text();
    expect(roster).toContain('desk@clinic.example');
    expect(roster).toContain('<h2>Members · 2</h2>');
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
    expect((await createSlotlockDashboardWorkspaces(application).standing(team, `github:${base + 1}`)).role).toBe('developer');
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
      expect((await createSlotlockDashboardWorkspaces(application).standing(team, person)).role).toBe(roleName);
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
    expect((await createSlotlockDashboardWorkspaces(application).standing(team, `github:${base + 2}`)).role).toBe('member');
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
    expect((await createSlotlockDashboardWorkspaces(application).standing(south, `github:${base + 4}`)).role).toBe('owner');
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
    expect(await (await ada.get('/dashboard/settings/members')).text()).toContain('You’re the only owner. Make someone else an owner before leaving.');
    expect((await ada.post('/dashboard/settings/members', '/members/role', { person: `github:${base + 2}`, role: 'owner' })).status).toBe(200);
    expect((await createSlotlockDashboardWorkspaces(application).standing(team, `github:${base + 2}`)).role).toBe('owner');
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

  it("serves a team's keys only with team workspaces on", () => {
    expect(slotlockServeAllowsTenant({ allowedUsers: '*', teamWorkspaces: true }, `team:${randomUUID()}~test`)).toBe(true);
    expect(slotlockServeAllowsTenant({ allowedUsers: '*' }, `team:${randomUUID()}`)).toBe(false);
  });
});
