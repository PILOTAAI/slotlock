// A team's SCIM 2.0 endpoint (scim-server.ts, workspace-scim.ts, ddl-scim.ts) against real
// PostgreSQL as the LOGIN role grantApplicationRole grants, with the requests Okta and Entra send:
// tokens for one team only; users at verified domains only; deactivation ending one membership at the
// next request and nothing else; reactivation needing a new sign-in; Owners never touched; groups
// giving roles. Skipped without DATABASE_URL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleSlotlockScimRequest } from '../scim-server.js';
import { createSlotlockStore } from '../store.js';
import { type SlotlockWorkspaceScim, createSlotlockWorkspaceScim } from '../workspace-scim.js';
import { type SlotlockWorkspaceTeams, createSlotlockDashboardWorkspaces } from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const ROOT = 'https://slotlock.example.com/dashboard';

describe.skipIf(!url)('the SCIM endpoint (real Postgres)', () => {
  const role = `slotlock_sc_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const base = 960_000_000 + Math.floor(Math.random() * 30_000_000);
  const [ada, bea, cy] = [`github:${base}`, `github:${base + 1}`, `github:${base + 2}`];
  const domain = `scim-${base.toString(36)}.com`;
  const created: string[] = [];
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let scim: SlotlockWorkspaceScim;
  let teams: SlotlockWorkspaceTeams;
  let team = '';
  let token = '';
  const events: { tenantRef: string; action: string; outcome?: string }[] = [];
  const deactivations: { person: string; policy: string }[] = [];

  // What the endpoint answers, as the tests read it.
  type ScimBody = { id: string; active: boolean; totalResults: number; Resources: { id: string }[]; [key: string]: unknown };
  type ScimResponse = Omit<Response, 'json'> & { json(): Promise<ScimBody> };
  const call = (method: string, path: string, body?: unknown, auth = token, contentType = 'application/scim+json') =>
    handleSlotlockScimRequest(
      new Request(`${ROOT}/scim/v2/${path}`, {
        method,
        headers: { authorization: `Bearer ${auth}`, ...(body !== undefined ? { 'content-type': contentType } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      path.split('?')[0] ?? path,
      {
        scim,
        publicRoot: ROOT,
        documentationUri: 'https://slotlock.example.com/docs/scim',
        record: async (tenantRef, event) => {
          events.push({ tenantRef, action: event.action, ...(event.outcome ? { outcome: event.outcome } : {}) });
        },
        deactivated: async (_tenantRef, person, policy) => {
          deactivations.push({ person, policy });
          return 0;
        },
      },
    ) as Promise<ScimResponse>;
  const teamId = () => team.slice('team:'.length);
  const user = (name: string, extra: Record<string, unknown> = {}) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
    externalId: randomUUID(),
    userName: name,
    active: true,
    emails: [{ primary: true, type: 'work', value: name }],
    name: { givenName: 'Given', familyName: 'Family' },
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { employeeNumber: '2' },
    ...extra,
  });
  const patch = (...Operations: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations });
  const standing = (person: string, sid: string | null = null) => createSlotlockDashboardWorkspaces(application).standing(team, person, sid);
  async function session(person: string) {
    const workspaces = createSlotlockDashboardWorkspaces(application);
    const sid = randomBytes(24).toString('base64url');
    await workspaces.sessions?.started(person, sid, new Date(Date.now() + 3_600_000), {});
    return sid;
  }

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, { max: 6, onnotice: () => {} });
    const workspaces = createSlotlockDashboardWorkspaces(application);
    teams = workspaces.teams as SlotlockWorkspaceTeams;
    scim = createSlotlockWorkspaceScim(application);
    for (const person of [ada, bea, cy]) await workspaces.signedIn(person, []);
    const made = await teams.create(ada, 'Acme', `sc${base.toString(36)}`, null);
    if (!('tenantRef' in made)) throw new Error(made.refusal);
    team = made.tenantRef;
    created.push(team);
    await admin`
      INSERT INTO slotlock.workspace_domains (tenant_ref, domain_ascii, domain_unicode, status, token, verified_at)
      VALUES (${team}, ${domain}, ${domain}, 'verified', ${'c'.repeat(26)}, now())`;
  });

  afterAll(async () => {
    for (const ref of created) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    for (const ref of [ada, bea, cy]) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('is turned on by an Owner with a verified domain, with tokens for this team only, stored as hashes', async () => {
    expect(await scim.createToken(team, ada)).toEqual({ refusal: 'not_enabled' });
    expect(await scim.enable(team, ada, 'revoke')).toBeNull();
    const madeToken = await scim.createToken(team, ada);
    if (!('token' in madeToken)) throw new Error(madeToken.refusal);
    token = madeToken.token;
    expect(token).toMatch(/^slk_scim_[0-9a-f]{64}$/);
    const [stored] = await admin<{ token_sha256: Buffer }[]>`SELECT token_sha256 FROM slotlock.scim_tokens WHERE tenant_ref = ${team}`;
    expect(stored?.token_sha256.equals(createHash('sha256').update(token).digest())).toBe(true);
    expect(await scim.createToken(team, ada)).toHaveProperty('token');
    expect(await scim.createToken(team, ada)).toEqual({ refusal: 'token_limit' });
    // Discovery.
    const config = await call('GET', `${teamId()}/ServiceProviderConfig`);
    expect(config.headers.get('content-type')).toContain('application/scim+json');
    expect(await config.json()).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 100 } });
    expect((await (await call('GET', `${teamId()}/Schemas`)).json()).totalResults).toBe(2);
    expect((await (await call('GET', `${teamId()}/ResourceTypes`)).json()).totalResults).toBe(2);
    // No token, a made-up one, another team's.
    expect((await call('GET', `${teamId()}/Users`, undefined, '')).status).toBe(401);
    expect((await call('GET', `${teamId()}/Users`, undefined, `slk_scim_${'0'.repeat(64)}`)).status).toBe(401);
    const other = await teams.create(bea, 'Other', `so${base.toString(36)}`, null);
    if (!('tenantRef' in other)) throw new Error(other.refusal);
    created.push(other.tenantRef);
    const wrong = await call('GET', `${other.tenantRef.slice(5)}/Users`);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ status: '401' });
    expect(events).toContainEqual({ tenantRef: team, action: 'scim.token_refused', outcome: 'denied' });
  });

  it("creates Microsoft's sample user at a verified domain only, once, whatever its case", async () => {
    const name = `Test_User_${base}@${domain}`;
    const createdUser = await call('POST', `${teamId()}/Users`, user(name));
    expect(createdUser.status).toBe(201);
    const body = await createdUser.json();
    expect(body).toMatchObject({ userName: name, active: true, name: { givenName: 'Given' } });
    expect(body).not.toHaveProperty(['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User']);
    expect(createdUser.headers.get('location')).toBe(`${ROOT}/scim/v2/${teamId()}/Users/${body.id}`);
    for (const again of [name, name.toUpperCase()]) {
      const duplicate = await call('POST', `${teamId()}/Users`, user(again));
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ status: '409', scimType: 'uniqueness' });
    }
    expect((await call('POST', `${teamId()}/Users`, user('someone@unverified-example.org'))).status).toBe(400);
    // Found by userName in any case, and nothing for a name not there (200, an empty list).
    const found = await (await call('GET', `${teamId()}/Users?filter=${encodeURIComponent(`userName eq "${name.toUpperCase()}"`)}`)).json();
    expect(found).toMatchObject({ totalResults: 1, Resources: [{ id: body.id }] });
    expect(await (await call('GET', `${teamId()}/Users?filter=${encodeURIComponent('userName eq "nobody@x.com"')}`)).json()).toMatchObject({ totalResults: 0, Resources: [] });
    expect((await call('GET', `${teamId()}/Users?filter=${encodeURIComponent('userName co "x"')}`)).status).toBe(400);
  });

  it('pages in a stable order, with integer totals', async () => {
    for (let index = 0; index < 12; index++) expect((await call('POST', `${teamId()}/Users`, user(`page-${index}@${domain}`))).status).toBe(201);
    const pages = [];
    for (const start of [1, 6, 11]) pages.push(await (await call('GET', `${teamId()}/Users?startIndex=${start}&count=5`)).json());
    expect(pages.map((page) => page.Resources.length)).toEqual([5, 5, 3]);
    expect(pages.every((page) => page.totalResults === 13)).toBe(true);
    const again = await (await call('GET', `${teamId()}/Users?startIndex=6&count=5`)).json();
    expect(again.Resources.map((entry) => entry.id)).toEqual(pages[1]?.Resources.map((entry) => entry.id));
    expect(await (await call('GET', `${teamId()}/Users?count=0`)).json()).toMatchObject({ totalResults: 13, Resources: [] });
  });

  it("deactivates by Entra's string False, ends that membership only, and restores it for new sessions", async () => {
    const name = `bea@${domain}`;
    const { id } = await (await call('POST', `${teamId()}/Users`, user(name))).json();
    // Bea signs in holding the address verified: the directory's user binds to her.
    expect(await scim.bind(bea, [name])).toEqual([team]);
    const before = await session(bea);
    expect((await standing(bea, before)).role).toBe('viewer');
    const epoch = (await standing(bea, before)).sessionEpoch;
    const off = await call('PATCH', `${teamId()}/Users/${id}`, patch({ op: 'Replace', path: 'active', value: 'False' }));
    expect(off.status).toBe(200);
    expect((await off.json()).active).toBe(false);
    expect((await standing(bea, before)).role).toBeNull();
    // Her own workspace, and her epoch, untouched; her keys went as the team chose.
    expect((await createSlotlockDashboardWorkspaces(application).standing(bea, bea, before)).role).toBe('owner');
    expect((await standing(bea, before)).sessionEpoch).toBe(epoch);
    expect(deactivations).toContainEqual({ person: bea, policy: 'revoke' });
    // Still listed, inactive (the validator's GET after disabling).
    expect(await (await call('GET', `${teamId()}/Users/${id}`)).json()).toMatchObject({ active: false });
    // Reactivated with "True": back for a session begun after, not the one from before.
    expect((await call('PATCH', `${teamId()}/Users/${id}`, patch({ op: 'replace', value: { active: 'True' } }))).status).toBe(200);
    expect((await standing(bea, before)).role).toBeNull();
    expect((await standing(bea, await session(bea))).role).toBe('viewer');
  });

  it('never deactivates, deletes or demotes an Owner', async () => {
    const name = `ada@${domain}`;
    const { id } = await (await call('POST', `${teamId()}/Users`, user(name))).json();
    expect(await scim.bind(ada, [name])).toEqual([team]);
    const refused = await call('PATCH', `${teamId()}/Users/${id}`, patch({ op: 'replace', path: 'active', value: false }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ scimType: 'mutability' });
    expect((await call('DELETE', `${teamId()}/Users/${id}`)).status).toBe(400);
    expect((await standing(ada, await session(ada))).role).toBe('owner');
  });

  it('deletes, then makes the same name again with a new id', async () => {
    const name = `gone@${domain}`;
    const { id } = await (await call('POST', `${teamId()}/Users`, user(name))).json();
    expect((await call('DELETE', `${teamId()}/Users/${id}`)).status).toBe(204);
    expect((await call('GET', `${teamId()}/Users/${id}`)).status).toBe(404);
    const again = await (await call('POST', `${teamId()}/Users`, user(name))).json();
    expect(again.id).not.toBe(id);
    // A remove without a path is refused, whatever the case.
    expect(await (await call('PATCH', `${teamId()}/Users/${again.id}`, patch({ op: 'Remove' }))).json()).toMatchObject({ scimType: 'noTarget' });
  });

  it('gives roles by reserved groups, the highest winning, and falls back when a member leaves', async () => {
    const name = `cy@${domain}`;
    const { id } = await (await call('POST', `${teamId()}/Users`, user(name))).json();
    expect(await scim.bind(cy, [name])).toEqual([team]);
    const sid = await session(cy);
    const admins = await (await call('POST', `${teamId()}/Groups`, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'slotlock-role-admin', members: [{ value: id }] })).json();
    expect((await standing(cy, sid)).role).toBe('admin');
    const members = await call('POST', `${teamId()}/Groups`, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'slotlock-role-member', members: [{ value: id }] });
    expect(members.status).toBe(201);
    expect((await standing(cy, sid)).role).toBe('admin');
    expect((await call('POST', `${teamId()}/Groups`, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'SLOTLOCK-ROLE-ADMIN' })).status).toBe(409);
    // Entra without the flag removes Cy from the admins: the member group decides.
    expect((await call('PATCH', `${teamId()}/Groups/${admins.id}`, patch({ op: 'Remove', path: 'members', value: [{ value: id }] }))).status).toBe(200);
    expect((await standing(cy, sid)).role).toBe('member');
    // Okta's rename carries the group's own id; members can be left out of a read.
    expect((await call('PATCH', `${teamId()}/Groups/${admins.id}`, patch({ op: 'replace', value: { id: admins.id, displayName: 'Engineering' } }))).status).toBe(200);
    const read = await (await call('GET', `${teamId()}/Groups/${admins.id}?excludedAttributes=members`)).json();
    expect(read).toMatchObject({ displayName: 'Engineering' });
    expect(read).not.toHaveProperty('members');
    // No group makes an Owner.
    expect(await scim.mapGroup(team, ada, admins.id, 'owner')).toBe('owner_not_mappable');
  });

  it("keeps the tables out of the serving role's reach but for the functions", async () => {
    for (const table of ['scim_tokens', 'scim_users', 'scim_groups', 'scim_group_members']) {
      await expect(application.unsafe(`SELECT * FROM slotlock.${table}`)).rejects.toThrow(/permission denied/);
    }
  });
});
