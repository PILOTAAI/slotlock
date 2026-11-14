// Single sign-on through a team's own identity provider, in the dashboard (sso option), as the
// LOGIN role grantApplicationRole grants: an Owner connects and tests a provider and turns it on;
// a colleague signs in through it alone, scoped to the team; the callback refuses another
// connection's state, another issuer, a replay, a wrong nonce and a key the provider does not
// publish; "require single sign-on" turns GitHub sessions away from the team but for a proof or an
// Owner's bypass. GitHub and the provider are fakes. Skipped without DATABASE_URL.
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { createSlotlockDashboard, createSlotlockDashboardResources, createSlotlockDashboardState } from '../dashboard.js';
import { SLOTLOCK_DASHBOARD_FORM_LIMIT } from '../ddl.js';
import { createSlotlockSecretBox } from '../oidc.js';
import { createSlotlockStore } from '../store.js';
import { type SlotlockWorkspaceTeams, createSlotlockDashboardWorkspaces } from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const ORIGIN = 'https://slotlock.example.com';
const ISSUER = 'https://idp.acme-sso-test.com/oauth2/default';

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
  async post(page: string, action: string, fields: Record<string, string>, index = 0) {
    const fromPage = await (await this.get(page)).text();
    let at = -1;
    for (let found = 0; found <= index; found++) at = fromPage.indexOf(`action="/dashboard${action}"`, at + 1);
    expect(at, `the form ${action} on ${page}`).toBeGreaterThan(-1);
    const rest = fromPage.slice(at, fromPage.indexOf('</form>', at));
    const carried = Object.fromEntries([...rest.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, name, value]) => [name, value]));
    return this.send(action, new URLSearchParams({ ...carried, ...fields }));
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

describe.skipIf(!url)('single sign-on in the dashboard (real Postgres)', () => {
  const role = `slotlock_ds_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const base = 950_000_000 + Math.floor(Math.random() * 40_000_000);
  const domain = `acme-${base.toString(36)}.com`;
  const github = new Map<string, { id: number; login: string }>([
    ['ada', { id: base, login: 'ada' }],
    ['bea', { id: base + 1, login: 'bea' }],
  ]);
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const JWKS = { keys: [{ ...signing.publicKey.export({ format: 'jwk' }), kid: 'idp-key', alg: 'RS256', use: 'sig' }] };
  /** What the provider puts in the next ID token, and with which key. */
  let next: { claims: Record<string, unknown>; key: typeof signing.privateKey } = { claims: {}, key: signing.privateKey };
  let lastNonce = '';
  /** Pad the token endpoint's next answers past what the dashboard reads (64 KB). */
  let padTokenAnswer = false;
  const tokenRequests: { authorization: string | null; body: string }[] = [];
  const tenants: string[] = [];
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let current: ReturnType<typeof createSlotlockDashboard>;

  const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = String(input);
    if (target === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/v1/authorize`,
        token_endpoint: `${ISSUER}/v1/token`,
        jwks_uri: `${ISSUER}/v1/keys`,
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (target === `${ISSUER}/v1/keys`) return Response.json(JWKS);
    if (target === `${ISSUER}/v1/token`) {
      tokenRequests.push({ authorization: new Headers(init.headers).get('authorization'), body: String(init.body) });
      const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const signed = `${part({ alg: 'RS256', kid: 'idp-key', typ: 'JWT' })}.${part({
        iss: ISSUER,
        aud: '0oa-acme-client',
        exp: Math.floor(Date.now() / 1000) + 600,
        iat: Math.floor(Date.now() / 1000),
        nonce: lastNonce,
        ...next.claims,
      })}`;
      const idToken = `${signed}.${createSign('RSA-SHA256').update(signed).sign(next.key).toString('base64url')}`;
      return Response.json({ id_token: idToken, ...(padTokenAnswer ? { padding: 'x'.repeat(70_000) } : {}) });
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
  /** Follow a redirect to the provider, sign in there as `claims`, and come back. */
  async function throughProvider(browser: Browser, started: Response, claims: Record<string, unknown>, key = signing.privateKey, tamper?: (query: URLSearchParams, location: URL) => void) {
    expect(started.status).toBe(302);
    const location = new URL(started.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/v1/authorize`);
    lastNonce = location.searchParams.get('nonce') ?? '';
    next = { claims, key };
    const back = new URL(location.searchParams.get('redirect_uri') ?? '');
    const query = new URLSearchParams({ code: randomBytes(8).toString('hex'), state: location.searchParams.get('state') ?? '' });
    tamper?.(query, back);
    return { response: await browser.get(`${back.pathname}?${query}`), location, back };
  }
  const teamOf = async (browser: Browser) => /<option value="(team:[0-9a-f-]{36})" selected>/.exec(await (await browser.get('/dashboard')).text())?.[1];

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
      github: { clientId: 'Ov23liSso', clientSecret: 's'.repeat(40) },
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: '*',
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store),
      state: createSlotlockDashboardState(application),
      workspaces: createSlotlockDashboardWorkspaces(application),
      teamWorkspaces: true,
      domains: { resolvers: [] },
      sso: { secretBox: createSlotlockSecretBox('x'.repeat(40)), fetch: fakeFetch as typeof fetch },
      fetch: fakeFetch as typeof fetch,
    });
  });

  afterAll(async () => {
    for (const ref of tenants) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    const made = await admin<{ person_ref: string }[]>`SELECT DISTINCT person_ref FROM slotlock.sso_identities`.catch(() => []);
    for (const ref of [...[...github.values()].map((who) => `github:${who.id}`), ...made.map((row) => row.person_ref)]) {
      await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    }
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('connects, tests and turns on a provider; signs a colleague in through it alone; requires it with an Owner bypass', async () => {
    const dashboard = () => current;
    const ada = new Browser(() => current);
    await signIn(ada, 'ada');
    expect((await ada.post('/dashboard/teams', '/teams/create', { name: 'Acme Rentals' })).status).toBe(303);
    const team = (await teamOf(ada)) as string;
    tenants.push(team);
    await admin`
      INSERT INTO slotlock.workspace_domains (tenant_ref, domain_ascii, domain_unicode, status, token, verified_at)
      VALUES (${team}, ${domain}, ${domain}, 'verified', ${'b'.repeat(26)}, now())`;

    // The form: one issuer field, named for what the chosen provider takes and hidden for Google
    // Workspace (its issuer is fixed), so never `required`: the server checks it per provider.
    const empty = await (await ada.get('/dashboard/settings/identity')).text();
    const issuerField = /<input id="sso-issuer"[^>]*>/.exec(empty)?.[0] ?? '';
    expect(issuerField).toContain('name="issuer"');
    expect(issuerField).not.toContain('required');
    expect(empty).toContain('<span class="for-issuer">Issuer URL</span><span class="for-entra">Tenant ID</span>');
    const blank = await ada.post('/dashboard/settings/identity', '/identity/sso', { kind: 'okta', issuer: '', client_id: '0oa-acme-client', client_secret: 'acme-secret-value-1234' });
    expect(blank.status).toBe(400);
    expect(await blank.text()).toContain('Enter the issuer URL');

    // Connect: discovered, the secret sealed, the redirect URI shown.
    const saved = await ada.post('/dashboard/settings/identity', '/identity/sso', { kind: 'okta', issuer: ISSUER, client_id: '0oa-acme-client', client_secret: 'acme-secret-value-1234' });
    expect(saved.status).toBe(303);
    const [stored] = await admin<{ id: string; secret_sealed: string; status: string }[]>`SELECT id, secret_sealed, status FROM slotlock.sso_connections WHERE tenant_ref = ${team}`;
    expect(stored?.secret_sealed).not.toContain('acme-secret');
    expect(stored?.status).toBe('draft');
    const page = await (await ada.get('/dashboard/settings/identity')).text();
    expect(page).toContain(`${ORIGIN}/dashboard/sso/callback/${stored?.id}`);
    expect(page).toContain('Not tested');

    // Test: no access changes; the claims are shown; the client secret went by HTTP Basic.
    const tested = await throughProvider(ada, await ada.post('/dashboard/settings/identity', '/identity/sso/test', {}), { sub: 'ada-at-idp', email: `ada@${domain}` });
    expect(tested.response.status).toBe(303);
    expect(tested.location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(tested.back.pathname).toBe(`/dashboard/sso/callback/${stored?.id}`);
    expect(tokenRequests.at(-1)?.authorization).toBe(`Basic ${Buffer.from('0oa-acme-client:acme-secret-value-1234').toString('base64')}`);
    expect(await (await ada.get('/dashboard/settings/identity')).text()).toContain('ada-at-idp');
    expect((await ada.post('/dashboard/settings/identity', '/identity/sso/status', { status: 'active' })).status).toBe(303);

    // A colleague through the provider alone: provisioned as a Viewer, scoped to the team.
    const desk = new Browser(() => current);
    const started = await desk.post(`/dashboard/sso?email=desk@${domain}`, '/sso/start', {});
    const { response } = await throughProvider(desk, started, { sub: 'desk-at-idp', email: `desk@${domain}` });
    expect(response.status).toBe(303);
    const [deskIdentity] = await admin<{ person_ref: string }[]>`SELECT person_ref FROM slotlock.sso_identities WHERE subject = 'desk-at-idp'`;
    expect(deskIdentity?.person_ref).toMatch(/^sso:/);
    expect((await createSlotlockDashboardWorkspaces(application).standing(team, deskIdentity?.person_ref as string, null)).role).toBe('viewer');
    expect((await desk.get('/dashboard')).status).toBe(200);
    expect((await desk.post('/dashboard/teams', '/teams/create', { name: 'Shadow' })).status).toBe(403);

    // The callback refuses: another connection's path, another issuer, a replay, a wrong nonce, a forged key.
    const refusedBy = async (claims: Record<string, unknown>, key = signing.privateKey, tamper?: (query: URLSearchParams, back: URL) => void) => {
      const browser = new Browser(() => current);
      return (await throughProvider(browser, await browser.post(`/dashboard/sso?email=x@${domain}`, '/sso/start', {}), claims, key, tamper)).response.status;
    };
    expect(await refusedBy({ sub: 'x1', email: `x@${domain}` }, signing.privateKey, (_query, back) => {
      back.pathname = `/dashboard/sso/callback/${randomUUID()}`;
    })).toBe(400);
    expect(await refusedBy({ sub: 'x2', email: `x@${domain}` }, signing.privateKey, (query) => query.set('iss', 'https://evil.example/'))).toBe(400);
    expect(await refusedBy({ sub: 'x3', email: `x@${domain}`, nonce: 'replayed-nonce' })).toBe(502);
    expect(await refusedBy({ sub: 'x4', email: `x@${domain}` }, forger.privateKey)).toBe(502);
    const replay = new Browser(() => current);
    const first = await throughProvider(replay, await replay.post(`/dashboard/sso?email=x@${domain}`, '/sso/start', {}), { sub: 'x5', email: `x@${domain}` });
    expect(first.response.status).toBe(303);
    expect((await replay.get(`${first.back.pathname}?code=again&state=${first.location.searchParams.get('state')}`)).status).toBe(400);

    // Require it: Ada proves herself (linking her identity), then turns it on.
    expect((await ada.post('/dashboard/settings/identity', '/identity/sso/require', { on: '1', max_age: '24' })).status).toBe(409);
    const proof = await throughProvider(ada, await ada.post('/dashboard/settings/identity', '/sso/proof', {}), { sub: 'ada-at-idp', email: `ada@${domain}` });
    expect(proof.response.status).toBe(303);
    expect((await ada.post('/dashboard/settings/identity', '/identity/sso/require', { on: '1', max_age: '24' })).status).toBe(303);

    // Bea, a GitHub member, is turned away from the team without a proof, and offered no bypass.
    const teams = createSlotlockDashboardWorkspaces(application).teams as SlotlockWorkspaceTeams;
    const raw = randomBytes(32);
    await teams.invite({ tenantRef: team, inviter: `github:${base}`, to: { github: `github:${base + 1}`, login: 'bea' }, role: 'member', tokenSha256: createHash('sha256').update(raw).digest(), days: 7, dailyLimit: null, memberCap: null });
    await teams.accept({ tokenSha256: createHash('sha256').update(raw).digest(), person: `github:${base + 1}`, emails: [], memberCap: null });
    const bea = new Browser(() => current);
    await signIn(bea, 'bea');
    const turnedAway = await bea.post('/dashboard/teams', '/organization', { organization: team });
    expect(turnedAway.status).toBe(403);
    const away = await turnedAway.text();
    expect(away).toContain('requires single sign-on');
    expect(away).not.toContain('/sso/bypass');

    // Ada in another browser, signed in with GitHub only: offered the bypass, which lets her in for an hour, audited.
    const adaElsewhere = new Browser(() => current);
    await signIn(adaElsewhere, 'ada');
    const offered = await adaElsewhere.post('/dashboard/teams', '/organization', { organization: team });
    expect(await offered.text()).toContain('Use owner bypass');
    const bypass = await adaElsewhere.send(
      '/sso/bypass',
      new URLSearchParams({
        ...Object.fromEntries([...(await (await adaElsewhere.post('/dashboard/teams', '/organization', { organization: team })).text()).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, name, value]) => [name, value])),
      }),
    );
    expect(bypass.status).toBe(303);
    expect(await teamOf(adaElsewhere)).toBe(team);
    const [used] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.audit_events WHERE tenant_ref = ${team} AND action = 'sso.bypass_used'`;
    expect(used?.count).toBe(1);

    // A session signed in through Acme's provider alone acts for Acme only: the address the
    // provider asserts (one Acme never verified) opens no other team's invitation, and no other
    // team is reached from it, though the identity is Ada's.
    const made = await teams.create(`github:${base + 1}`, 'Bigcorp Rentals', `big${base.toString(36)}`, null);
    if (!('tenantRef' in made)) throw new Error(made.refusal);
    tenants.push(made.tenantRef);
    const cfo = `cfo@bigcorp-${base.toString(36)}.com`;
    const invitation = await teams.invite({ tenantRef: made.tenantRef, inviter: `github:${base + 1}`, to: { email: cfo }, role: 'admin', tokenSha256: randomBytes(32), days: 7, dailyLimit: null, memberCap: null });
    const handle = /^[a-z0-9-]+/.exec((await admin<{ handle: string }[]>`SELECT handle FROM slotlock.workspaces WHERE tenant_ref = ${team}`)[0]?.handle ?? '')?.[0] as string;
    const scoped = new Browser(() => current);
    const signedIn = await throughProvider(scoped, await scoped.post(`/dashboard/sso/${handle}`, '/sso/start', {}), { sub: 'ada-at-idp', email: cfo });
    expect(signedIn.response.status).toBe(303);
    expect(await teamOf(scoped)).toBe(team);
    expect(await (await scoped.get('/dashboard/teams')).text()).not.toContain('Bigcorp Rentals');
    // The address the provider asserted, at a domain Acme never verified, names nobody.
    expect(await (await scoped.get('/dashboard/settings/account')).text()).not.toContain(cfo);
    const teamsPage = await (await scoped.get('/dashboard/teams')).text();
    const forged = new URLSearchParams({
      csrf: /name="csrf" value="([^"]+)"/.exec(teamsPage)?.[1] as string,
      once: /name="once" value="([^"]+)"/.exec(teamsPage)?.[1] as string,
      invitation: (invitation as { id: string }).id,
    });
    expect((await scoped.send('/invite/accept', forged)).status).toBe(403);
    expect((await createSlotlockDashboardWorkspaces(application).standing(made.tenantRef, `github:${base}`, null)).role).toBeNull();
    const switched = new URLSearchParams({ csrf: forged.get('csrf') as string, once: /name="once" value="([^"]+)"/.exec(await (await scoped.get('/dashboard/teams')).text())?.[1] as string, organization: '' });
    expect((await scoped.send('/organization', switched)).status).toBe(403);

    // Nor does it see or end the person's other sessions: only its own is listed, and signing out
    // everywhere (or ending another session) is refused.
    const account = await (await scoped.get('/dashboard/settings/account')).text();
    expect(account.match(/<td data-label="Device"/g)?.length).toBe(1);
    expect(account).not.toContain('/sign-out-everywhere');
    const everywhere = new URLSearchParams({ csrf: forged.get('csrf') as string, once: /name="once" value="([^"]+)"/.exec(account)?.[1] as string });
    expect((await scoped.send('/sign-out-everywhere', everywhere)).status).toBe(403);
    expect(await teamOf(adaElsewhere)).toBe(team);

    // Nor does it spend the forms Ada's own sessions may send, in every workspace: it has its own.
    const adaForms = createHash('sha256').update(`slotlock-dashboard-owner.${base}`).digest();
    const [live] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM slotlock.dashboard_tokens
       WHERE owner_hash = ${adaForms} AND kind = 'form' AND expires_at > now()`;
    await admin`
      INSERT INTO slotlock.dashboard_tokens (kind, token_hash, owner_hash, expires_at)
      SELECT 'form', sha256(convert_to(${randomUUID()} || n::text, 'UTF8')), ${adaForms}, now() + interval '1 hour'
        FROM generate_series(1, ${SLOTLOCK_DASHBOARD_FORM_LIMIT - 2 - (live?.n ?? 0)}) AS n`;
    try {
      for (let sent = 0; sent < 2; sent++) {
        expect((await scoped.post('/dashboard', '/environment', { environment: 'live' })).status).toBe(303);
      }
      expect((await adaElsewhere.post('/dashboard', '/environment', { environment: 'live' })).status).toBe(303);
    } finally {
      await admin`DELETE FROM slotlock.dashboard_tokens WHERE owner_hash = ${adaForms}`;
    }

    // A link to a team's single sign-on names the team; only its own page's button goes on to the
    // provider, so another site neither signs someone in to a team they did not choose nor sends
    // them anywhere through this one.
    const linked = await new Browser(() => current).get(`/dashboard/sso/${handle}`);
    expect(linked.status).toBe(200);
    expect(linked.headers.get('location')).toBeNull();
    const confirm = await linked.text();
    expect(confirm).toContain('Sign in to Acme Rentals');
    expect(confirm).toContain('action="/dashboard/sso/start"');
    expect(confirm).toContain(`Continue to ${new URL(ISSUER).host}`);
    const crossSite = await dashboard().fetch(
      new Request(`${ORIGIN}/dashboard/sso/start`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ team: handle }).toString(),
      }),
    );
    expect(crossSite.status).toBe(403);

    // An address the provider itself says is unverified is not trusted: nobody is provisioned by it.
    const unverified = new Browser(() => current);
    const notVerified = await throughProvider(unverified, await unverified.post(`/dashboard/sso?email=u@${domain}`, '/sso/start', {}), {
      sub: 'unverified-at-idp',
      email: `u@${domain}`,
      email_verified: false,
    });
    expect(notVerified.response.status).toBe(403);
    expect(await admin`SELECT 1 FROM slotlock.sso_identities WHERE subject = 'unverified-at-idp'`).toHaveLength(0);

    // A token endpoint answering more than 64 KB is not read to the end: no sign-in.
    padTokenAnswer = true;
    const flooded = new Browser(() => current);
    const flood = await throughProvider(flooded, await flooded.post(`/dashboard/sso?email=f@${domain}`, '/sso/start', {}), { sub: 'flood-at-idp', email: `f@${domain}` });
    padTokenAnswer = false;
    expect(flood.response.status).toBe(502);
    expect(await teamOf(flooded)).toBeUndefined();

    // Turning the connection off ends the sessions it began and the proofs it gave, at once.
    expect(await teamOf(desk)).toBe(team);
    expect((await ada.post('/dashboard/settings/identity', '/identity/sso/status', { status: 'disabled' })).status).toBe(303);
    expect(await teamOf(desk)).toBeUndefined();
    expect(await teamOf(scoped)).toBeUndefined();
    expect(await admin`SELECT 1 FROM slotlock.dashboard_session_sso proof JOIN slotlock.sso_connections linked ON linked.id = proof.connection_id WHERE linked.tenant_ref = ${team}`).toHaveLength(0);

    // Google Workspace: only an account of the team's verified domain, even one already a member
    // (any Google account can pass an "External" OAuth client).
    expect((await ada.post('/dashboard/settings/identity', '/identity/sso/status', { status: 'active' })).status).toBe(303);
    await admin`UPDATE slotlock.sso_connections SET kind = 'google_workspace' WHERE tenant_ref = ${team}`;
    const google = { iss: 'https://accounts.google.com', sub: 'desk-at-idp', email: `desk@${domain}`, email_verified: true };
    const deskAgain = new Browser(() => current);
    const personal = await throughProvider(deskAgain, await deskAgain.post(`/dashboard/sso?email=desk@${domain}`, '/sso/start', {}), google);
    expect(personal.response.status).toBe(403);
    expect(await personal.response.text()).toContain('Google Workspace account at the team’s verified domain');
    const workspace = await throughProvider(deskAgain, await deskAgain.post(`/dashboard/sso?email=desk@${domain}`, '/sso/start', {}), { ...google, hd: domain });
    expect(workspace.response.status).toBe(303);
    expect(await teamOf(deskAgain)).toBe(team);
  });

  // An address or link no team signs in with is a way forward, not a dead end: it says what it read
  // (the domain typed, never whether a team holds it), keeps the address, and offers the other ways.
  it('answers an address no team signs in with by naming its domain, keeping it and offering other ways', async () => {
    const fresh = await new Browser(() => current).get('/dashboard/sso');
    expect(fresh.status).toBe(200);
    const blank = await fresh.text();
    expect(blank).not.toContain('role="alert"');
    expect(blank).toContain('<form class="auth-form" method="get" action="/dashboard/sso">');

    // A second-level public suffix, as the address that showed it had (2026-11-12): no team's domain.
    const other = `nobody-${base.toString(36)}.co.uk`;
    const none = await new Browser(() => current).get(`/dashboard/sso?email=support%40${other}`);
    expect(none.status).toBe(404);
    const said = await none.text();
    expect(said).toContain(`Single sign-on isn’t set up for ${other}. Check the address, or sign in another way below.`);
    expect(said).toContain(`value="support@${other}"`);
    expect(said).toContain('<a class="button wide" href="/dashboard/sign-in">');
    // This dashboard has no Google sign-in, so it offers none.
    expect(said).not.toContain('with=google');
    expect(said).toContain('An Owner verifies the domain and connects the provider in Settings, Identity');

    const unread = await (await new Browser(() => current).get('/dashboard/sso?email=not-an-address')).text();
    expect(unread).toContain('That doesn’t look like an email address.');
    const linked = await (await new Browser(() => current).get('/dashboard/sso/no-such-team')).text();
    expect(linked).toContain('No team signs in with single sign-on at that link.');
    expect(linked).toContain('value=""');
  });
});
