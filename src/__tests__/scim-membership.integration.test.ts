// What the team's directory (SCIM) may and may not do to membership, against real PostgreSQL as the
// LOGIN role grantApplicationRole grants: it never brings back someone the team removed, by a
// routine sync or by making their address again; it restores only what it ended itself; deleted,
// nothing of the user is kept; binding needs the team to hold the address's domain still, and the
// free plan's member cap; bodies are capped as they stream. Skipped without DATABASE_URL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleSlotlockScimRequest } from '../scim-server.js';
import { createSlotlockStore } from '../store.js';
import { createSlotlockWorkspaceDomains } from '../workspace-domains.js';
import { type SlotlockWorkspaceScim, createSlotlockWorkspaceScim } from '../workspace-scim.js';
import { type SlotlockWorkspaceTeams, createSlotlockDashboardWorkspaces } from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const ROOT = 'https://slotlock.example.com/dashboard';

describe.skipIf(!url)("the directory and a team's members (real Postgres)", () => {
  const role = `slotlock_sm_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const base = 930_000_000 + Math.floor(Math.random() * 30_000_000);
  const [ada, bea, dee, eve, fay, gus] = Array.from({ length: 6 }, (_, index) => `github:${base + index}`) as [string, string, string, string, string, string];
  const zed = `google:sm${base}`;
  const domain = `sm-${base.toString(36)}.com`;
  const oldDomain = `old-${base.toString(36)}.com`;
  const created: string[] = [];
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let scim: SlotlockWorkspaceScim;
  let teams: SlotlockWorkspaceTeams;
  let team = '';
  let token = '';

  type ScimBody = { id: string; active: boolean; totalResults: number; Resources: { id: string }[]; [key: string]: unknown };
  const call = (method: string, path: string, body?: unknown) =>
    handleSlotlockScimRequest(
      new Request(`${ROOT}/scim/v2/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/scim+json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      path.split('?')[0] ?? path,
      { scim, publicRoot: ROOT, documentationUri: 'https://x/docs', deactivated: async () => 0 },
    ) as Promise<Omit<Response, 'json'> & { json(): Promise<ScimBody> }>;
  const teamId = () => team.slice('team:'.length);
  const user = (name: string, active = true) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    externalId: randomUUID(),
    userName: name,
    active,
    emails: [{ primary: true, type: 'work', value: name }],
    name: { givenName: 'Given', familyName: 'Family' },
    displayName: 'Given Family',
  });
  const patch = (...Operations: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations });
  const standing = (person: string, sid: string | null) => createSlotlockDashboardWorkspaces(application).standing(team, person, sid);
  async function session(person: string) {
    const sid = randomBytes(24).toString('base64url');
    await createSlotlockDashboardWorkspaces(application).sessions?.started(person, sid, new Date(Date.now() + 3_600_000), {});
    return sid;
  }
  async function invited(person: string, address: string, as: 'developer' | 'member' | 'owner') {
    const digest = createHash('sha256').update(randomBytes(32)).digest();
    const made = await teams.invite({ tenantRef: team, inviter: ada, to: { email: address }, role: as, tokenSha256: digest, days: 7, dailyLimit: null, memberCap: null });
    if (!('id' in made)) throw new Error(made.refusal);
    expect(await teams.accept({ tokenSha256: digest, person, emails: [address], memberCap: null })).toEqual({ tenantRef: team });
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
    for (const person of [ada, bea, dee, eve, fay, gus]) await workspaces.signedIn(person, []);
    await workspaces.signedIn(zed);
    const made = await teams.create(ada, 'Acme', `sm${base.toString(36)}`, null);
    if (!('tenantRef' in made)) throw new Error(made.refusal);
    team = made.tenantRef;
    created.push(team);
    for (const name of [domain, oldDomain]) {
      await admin`
        INSERT INTO slotlock.workspace_domains (tenant_ref, domain_ascii, domain_unicode, status, token, verified_at)
        VALUES (${team}, ${name}, ${name}, 'verified', ${'c'.repeat(26)}, now())`;
    }
    expect(await scim.enable(team, ada, 'revoke')).toBeNull();
    const madeToken = await scim.createToken(team, ada);
    if (!('token' in madeToken)) throw new Error(madeToken.refusal);
    token = madeToken.token;
  });

  afterAll(async () => {
    for (const ref of created) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    for (const ref of [ada, bea, dee, eve, fay, gus, zed]) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("never brings back someone the team removed: not by a routine sync, nor by making their address again", async () => {
    // Dee, bound to the directory's user, removed by the Owner; the provider then syncs a name.
    const address = `dee@${domain}`;
    const { id } = await (await call('POST', `${teamId()}/Users`, user(address))).json();
    expect(await scim.bind(dee, [address], null)).toEqual([team]);
    expect(await teams.remove(team, ada, dee)).toBeNull();
    expect((await call('PATCH', `${teamId()}/Users/${id}`, patch({ op: 'replace', path: 'displayName', value: 'Dee Renamed' }))).status).toBe(200);
    expect((await standing(dee, await session(dee))).role).toBeNull();
    // Nor when the directory deactivates and then reactivates the user.
    expect((await call('PATCH', `${teamId()}/Users/${id}`, patch({ op: 'replace', path: 'active', value: false }))).status).toBe(200);
    expect((await call('PATCH', `${teamId()}/Users/${id}`, patch({ op: 'replace', path: 'active', value: true }))).status).toBe(200);
    expect((await standing(dee, await session(dee))).role).toBeNull();
    // Eve, invited by her address as a Developer and removed; the directory then makes that address.
    const eveAddress = `eve@${domain}`;
    await invited(eve, eveAddress, 'developer');
    expect(await teams.remove(team, ada, eve)).toBeNull();
    expect((await call('POST', `${teamId()}/Users`, user(eveAddress))).status).toBe(201);
    expect((await standing(eve, await session(eve))).role).toBeNull();
    expect(await scim.bind(eve, [eveAddress], null)).toEqual([]);
    // Someone who left is not brought back either.
    const gusAddress = `gus@${domain}`;
    const gusUser = await (await call('POST', `${teamId()}/Users`, user(gusAddress))).json();
    expect(await scim.bind(gus, [gusAddress], null)).toEqual([team]);
    expect(await teams.remove(team, gus, gus)).toBeNull();
    for (const active of [false, true]) {
      expect((await call('PATCH', `${teamId()}/Users/${gusUser.id}`, patch({ op: 'replace', value: { active } }))).status).toBe(200);
    }
    expect((await standing(gus, await session(gus))).role).toBeNull();
  });

  it('binds a member by the address they joined with, keeps their role, and restores only what it ended', async () => {
    // Fay joined by invitation as a Developer: the directory's user at her address is her, and its
    // groups never change the role she was given.
    const address = `fay@${domain}`;
    await invited(fay, address, 'developer');
    const made = await call('POST', `${teamId()}/Users`, user(address));
    expect(made.status).toBe(201);
    const { id } = await made.json();
    const [bound] = await admin<{ person_ref: string }[]>`SELECT person_ref FROM slotlock.scim_users WHERE id = ${id}::uuid`;
    expect(bound?.person_ref).toBe(fay);
    expect((await call('POST', `${teamId()}/Groups`, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'slotlock-role-viewer', members: [{ value: id }] })).status).toBe(201);
    expect((await standing(fay, await session(fay))).role).toBe('developer');
    // Deactivated by the directory, then reactivated: back, as before, for a new session.
    expect((await call('PATCH', `${teamId()}/Users/${id}`, patch({ op: 'Replace', path: 'active', value: 'False' }))).status).toBe(200);
    const before = await session(fay);
    expect((await standing(fay, before)).role).toBeNull();
    expect((await call('PATCH', `${teamId()}/Users/${id}`, patch({ op: 'Replace', path: 'active', value: 'True' }))).status).toBe(200);
    expect((await standing(fay, before)).role).toBeNull();
    expect((await standing(fay, await session(fay))).role).toBe('developer');
    // Deleted and made again (a rehire): binding at sign-in brings her back, for a new session.
    expect((await call('DELETE', `${teamId()}/Users/${id}`)).status).toBe(204);
    expect((await standing(fay, await session(fay))).role).toBeNull();
    expect((await call('POST', `${teamId()}/Users`, user(address))).status).toBe(201);
    expect(await scim.bind(fay, [address], null)).toEqual([team]);
    expect((await standing(fay, await session(fay))).role).toBe('developer');
  });

  it("keeps nothing of a user the directory deletes, and refuses an Owner's deactivation before keeping anything", async () => {
    const address = `gone@${domain}`;
    const { id } = await (await call('POST', `${teamId()}/Users`, user(address))).json();
    expect((await call('DELETE', `${teamId()}/Users/${id}`)).status).toBe(204);
    expect(await admin`SELECT 1 FROM slotlock.scim_users WHERE id = ${id}::uuid`).toHaveLength(0);
    // An Owner's address, made inactive: refused, and no user kept, so a retry is refused the same way.
    const owner = `boss@${domain}`;
    await invited(bea, owner, 'owner');
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await call('POST', `${teamId()}/Users`, user(owner, false));
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ scimType: 'mutability' });
    }
    expect(await admin`SELECT 1 FROM slotlock.scim_users WHERE tenant_ref = ${team} AND user_name_key = ${owner}`).toHaveLength(0);
  });

  it('binds only at a domain the team still holds, and within the free plan’s member cap', async () => {
    const address = `zed@${oldDomain}`;
    const { id } = await (await call('POST', `${teamId()}/Users`, user(address))).json();
    expect((await call('POST', `${teamId()}/Groups`, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'slotlock-role-admin', members: [{ value: id }] })).status).toBe(201);
    const domains = createSlotlockWorkspaceDomains(application);
    const claim = (await domains.list(team)).find((found) => found.ascii === oldDomain);
    expect(await domains.release(team, ada, claim?.id as string)).toBeNull();
    const other = await teams.create(bea, 'Buyer', `sb${base.toString(36)}`, null);
    if (!('tenantRef' in other)) throw new Error(other.refusal);
    created.push(other.tenantRef);
    await admin`
      INSERT INTO slotlock.workspace_domains (tenant_ref, domain_ascii, domain_unicode, status, token, verified_at)
      VALUES (${other.tenantRef}, ${oldDomain}, ${oldDomain}, 'verified', ${'d'.repeat(26)}, now())`;
    expect(await scim.bind(zed, [address], null)).toEqual([]);
    expect((await standing(zed, await session(zed))).role).toBeNull();
    // At the domain the team holds, a full free team takes nobody more; one with room does.
    const roomy = `room@${domain}`;
    await call('POST', `${teamId()}/Users`, user(roomy));
    const [members] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.workspace_memberships WHERE tenant_ref = ${team} AND status = 'active'`;
    expect(await scim.bind(zed, [roomy], members?.count as number)).toEqual([]);
    expect(await scim.bind(zed, [roomy], (members?.count as number) + 5)).toEqual([team]);
  });

  it('reads a body only up to its cap, and answers odd paging and filters with 200 or 400, never a crash', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= 32 * chunk.byteLength) return controller.close();
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const flooded = await handleSlotlockScimRequest(
      new Request(`${ROOT}/scim/v2/${teamId()}/Users`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
      `${teamId()}/Users`,
      { scim, publicRoot: ROOT, documentationUri: 'https://x/docs' },
    );
    expect(flooded.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(2 * chunk.byteLength);
    const declared = await handleSlotlockScimRequest(
      new Request(`${ROOT}/scim/v2/${teamId()}/Users`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json', 'content-length': String(10 * 1024 * 1024) },
        body: '{}',
      }),
      `${teamId()}/Users`,
      { scim, publicRoot: ROOT, documentationUri: 'https://x/docs' },
    );
    expect(declared.status).toBe(413);
    const far = await call('GET', `${teamId()}/Users?startIndex=99999999999`);
    expect(far.status).toBe(200);
    expect((await far.json()).Resources).toEqual([]);
    expect((await call('GET', `${teamId()}/Users?filter=${encodeURIComponent('userName eq "a\\u0000b"')}`)).status).toBe(400);
  });
});
