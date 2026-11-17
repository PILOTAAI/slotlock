// What staff set on a person's own account (RFC 0006, M11: suspension, flags) holds in every way
// the dashboard reaches that workspace: after a switch, and when a team the cookie still names has
// removed the person, so each request falls back to their own workspace. The database refuses a new
// team too, whatever the dashboard does. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { createSlotlockDashboard, createSlotlockDashboardResources, createSlotlockDashboardState } from '../dashboard.js';
import { createSlotlockStore } from '../store.js';
import { createSlotlockDashboardWorkspaces } from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const ORIGIN = 'https://slotlock.example.com';

class Browser {
  readonly cookies = new Map<string, string>();
  constructor(private readonly dashboard: ReturnType<typeof createSlotlockDashboard>) {}
  private header() { return [...this.cookies].map(([n, v]) => `${n}=${v}`).join('; '); }
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
  async send(action: string, sent: URLSearchParams) {
    return this.keep(await this.dashboard.fetch(new Request(`${ORIGIN}/dashboard${action}`, {
      method: 'POST', headers: { cookie: this.header(), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: sent.toString(),
    })));
  }
  async post(page: string, action: string, fields: Record<string, string>) {
    const fromPage = await (await this.get(page)).text();
    const at = fromPage.indexOf(`action="/dashboard${action}"`);
    if (at < 0) throw new Error(`no form ${action} on ${page}`);
    const rest = fromPage.slice(at, fromPage.indexOf('</form>', at));
    const once = /name="once" value="([^"]+)"/.exec(rest)?.[1];
    const sent = new URLSearchParams({ csrf: /name="csrf" value="([^"]+)"/.exec(rest)?.[1] as string, ...(once ? { once } : {}), ...fields });
    return this.keep(await this.dashboard.fetch(new Request(`${ORIGIN}/dashboard${action}`, {
      method: 'POST', headers: { cookie: this.header(), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: sent.toString(),
    })));
  }
}

describe.skipIf(!url)("staff's settings on a person's own workspace (real Postgres)", () => {
  const role = `slotlock_rv_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const base = 700_000_000 + Math.floor(Math.random() * 90_000_000);
  const people = new Map([['ada', { id: base, login: 'ada', emails: [{ email: 'ada@acme.example', verified: true }] }], ['cy', { id: base + 2, login: 'cy', emails: [{ email: 'cy@acme.example', verified: true }] }]]);
  const ADA = `github:${base}`;
  const CY = `github:${base + 2}`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let dashboard: ReturnType<typeof createSlotlockDashboard>;
  const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = String(input);
    if (target.endsWith('/access_token')) return Response.json({ access_token: `gho_${new URLSearchParams(String(init.body)).get('code')}` });
    const who = people.get(String(new Headers(init.headers).get('authorization')).replace('Bearer gho_', ''));
    if (!who) return new Response('no', { status: 401 });
    if (target.endsWith('/user/emails')) return Response.json(who.emails.map((e) => ({ ...e, primary: false })));
    return Response.json({ id: who.id, login: who.login });
  };
  async function signIn(browser: Browser, code: string, query = '') {
    const start = await browser.get(`/dashboard/sign-in${query}`);
    const location = new URL(start.headers.get('location') ?? '');
    await browser.get(`/dashboard/callback?code=${code}&state=${location.searchParams.get('state')}`);
  }
  let team = '';

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
      github: { clientId: 'Ov23liTeams', clientSecret: 'f'.repeat(40) },
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: '*',
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store),
      state: createSlotlockDashboardState(application),
      workspaces: createSlotlockDashboardWorkspaces(application),
      teamWorkspaces: true,
      assistant: { secret: randomBytes(32).toString('hex'), rate: { perSecond: 100, burst: 100 }, backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] }) },
      fetch: fakeFetch as typeof fetch,
    });
  });
  afterAll(async () => {
    for (const ref of [team, ADA, CY]) if (ref) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    await admin`DELETE FROM slotlock.tenant_suspensions WHERE tenant_ref = ${CY}`.catch(() => undefined);
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("keeps staff's flags and the suspension banner in a removed member's own workspace, and refuses her a new team", async () => {
    const ada = new Browser(dashboard);
    await signIn(ada, 'ada');
    await ada.post('/dashboard/teams', '/teams/create', { name: 'Fleet' });
    team = /<option value="(team:[0-9a-f-]{36})" selected>/.exec(await (await ada.get('/dashboard')).text())?.[1] ?? '';
    expect(team).toMatch(/^team:/);
    const page = await (await ada.post('/dashboard/settings/members', '/members/invite', { email: 'cy@acme.example', role: 'developer' })).text();
    const link = new URL((/<code id="invite-link">([^<]+)<\/code>/.exec(page)?.[1] as string).replaceAll('&amp;', '&'));
    const cy = new Browser(dashboard);
    await cy.get(`${link.pathname}${link.search}`);
    await signIn(cy, 'cy', '?then=%2Finvite&email=1');
    await cy.post('/dashboard/invite', '/invite/accept', {});

    // Staff turn the assistant and team creation off for Cy's own account, and suspend it.
    await admin`INSERT INTO slotlock.feature_flags (flag, tenant_ref, enabled, reason, set_by) VALUES ('assistant', ${CY}, false, 'abuse', 'cli:test'), ('team_workspaces', ${CY}, false, 'abuse', 'cli:test')`;
    await admin`INSERT INTO slotlock.tenant_suspensions (tenant_ref, reason, customer_message, suspended_by) VALUES (${CY}, 'internal', 'Write to abuse@ about this.', 'cli:test')`;

    // Control: Cy in her own workspace, switched there properly.
    await cy.post('/dashboard', '/organization', { organization: '' });
    const own = await (await cy.get('/dashboard')).text();
    expect(own).not.toContain('href="/dashboard/assistant"');
    expect(own).toContain('This account is suspended.');
    expect((await cy.get('/dashboard/assistant')).status).toBe(404);
    expect(await (await cy.get('/dashboard/teams')).text()).not.toContain('action="/dashboard/teams/create"');

    // Back into the team; then Ada removes her.
    await cy.post('/dashboard', '/organization', { organization: team });
    const gone = await ada.post('/dashboard/settings/members', '/members/remove', { person: CY, keys: 'revoke' });
    expect(await gone.text()).toContain('@cy was removed.');

    // Cy's cookie still names the team: her requests fall back to her own workspace.
    const fallback = await (await cy.get('/dashboard')).text();
    expect(fallback).not.toContain(`value="${team}" selected`);
    expect(fallback).not.toContain('href="/dashboard/assistant"');
    expect(fallback).toContain('This account is suspended.');
    expect((await cy.get('/dashboard/assistant')).status).toBe(404);
    const teams = await (await cy.get('/dashboard/teams')).text();
    expect(teams).not.toContain('action="/dashboard/teams/create"');
    expect(teams).toContain('Creating team workspaces is turned off for your account');
    // Sent anyway, by hand, with a form token from the page: refused, and no team made.
    const csrf = /name="csrf" value="([^"]+)"/.exec(teams)?.[1] ?? '';
    const once = /name="once" value="([^"]+)"/.exec(teams)?.[1];
    const made = await cy.send('/teams/create', new URLSearchParams({ csrf, ...(once ? { once } : {}), name: 'Second' }));
    expect(made.status).toBe(403);
    expect(await admin`SELECT 1 FROM slotlock.workspaces WHERE created_by = ${CY}`).toHaveLength(0);
    // The database refuses a new team for her, whatever the dashboard does; once staff lift both,
    // it allows one again.
    const refuse = async () =>
      (await application<{ refusal: string | null }[]>`SELECT refusal FROM slotlock.create_team(${CY}, 'Second', ${`second-${base}`}, NULL)`)[0]?.refusal;
    expect(await refuse()).toBe('not_allowed');
    await admin`DELETE FROM slotlock.tenant_suspensions WHERE tenant_ref = ${CY}`;
    expect(await refuse()).toBe('not_allowed');
    await admin`DELETE FROM slotlock.feature_flags WHERE tenant_ref = ${CY} AND flag = 'team_workspaces'`;
    expect(await refuse()).toBeNull();
    for (const row of await admin`SELECT tenant_ref FROM slotlock.workspaces WHERE created_by = ${CY}`) {
      await admin`SELECT * FROM slotlock.erase_tenant(${row.tenant_ref}::text)`.catch(() => undefined);
    }
  });
});
