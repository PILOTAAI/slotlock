// Single sign-on through a team's own identity provider (workspace-sso.ts, ddl-sso.ts), as the LOGIN
// role grantApplicationRole grants: identities keyed by the provider's subject, never email; a
// provider's email trusted only at the team's verified domain; provisioning, role mapping (never
// Owner), linking only for a signed-in member; sessions through a provider alone scoped to its team;
// "require single sign-on" with an Owner's bypass. Tokens are checked before any of this (oidc.ts).
// Skipped without DATABASE_URL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockStore } from '../store.js';
import type { SlotlockWorkspaceSso } from '../workspace-sso.js';
import { type SlotlockDashboardWorkspaces, type SlotlockWorkspaceTeams, createSlotlockDashboardWorkspaces } from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('single sign-on through a team provider (real Postgres)', () => {
  const role = `slotlock_ss_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const base = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  const people = Array.from({ length: 8 }, (_, index) => `github:${base + index}`);
  const [ada, bea, cy] = people as [string, string, string];
  const created: string[] = [];
  const persons: string[] = [...people];
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let workspaces: SlotlockDashboardWorkspaces;
  let teams: SlotlockWorkspaceTeams;
  let sso: SlotlockWorkspaceSso;
  let seq = 0;
  const ISSUER = 'https://idp.acme-sso.com/oauth2/default';

  /** A team with a verified domain and an active connection; its domain and connection id. */
  async function connectedTeam(owner = ada) {
    const made = await teams.create(owner, 'Acme rentals', `s${base.toString(36)}-${(seq++).toString(36)}`, null);
    if (!('tenantRef' in made)) throw new Error(made.refusal);
    created.push(made.tenantRef);
    const domain = `acme-${base.toString(36)}-${(seq++).toString(36)}.com`;
    await admin`
      INSERT INTO slotlock.workspace_domains (tenant_ref, domain_ascii, domain_unicode, status, token, verified_at)
      VALUES (${made.tenantRef}, ${domain}, ${domain}, 'verified', ${'a'.repeat(26)}, now())`;
    const id = randomUUID();
    const saved = await sso.save({
      tenantRef: made.tenantRef,
      actor: owner,
      id,
      kind: 'okta',
      issuer: ISSUER,
      clientId: '0oa-client',
      secretSealed: 'v1.sealed.secret',
      secretLast4: 'cret',
      authorizationEndpoint: `${ISSUER}/v1/authorize`,
      tokenEndpoint: `${ISSUER}/v1/token`,
      jwksUri: `${ISSUER}/v1/keys`,
      algorithms: ['RS256'],
      issParameter: false,
      entraTenant: null,
    });
    expect(saved).toMatchObject({ id });
    expect(await sso.recordTest(made.tenantRef, owner, id, 1, { sub: 'x' })).toBeNull();
    expect(await sso.setStatus(made.tenantRef, owner, id, 'active')).toBeNull();
    return { tenantRef: made.tenantRef, domain, id };
  }
  const signIn = (id: string, subject: string, extra: Partial<Parameters<SlotlockWorkspaceSso['signIn']>[0]> = {}) =>
    sso.signIn({
      connectionId: id,
      issuer: ISSUER,
      subject,
      entraTid: null,
      entraOid: null,
      email: null,
      emailOk: true,
      groups: [],
      overage: false,
      guest: false,
      sessionPerson: null,
      memberCap: null,
      ...extra,
    });
  /** A session for a person, recorded as the dashboard records one. */
  async function session(person: string) {
    await workspaces.signedIn(person, person.startsWith('github:') ? [] : undefined);
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
    workspaces = createSlotlockDashboardWorkspaces(application);
    teams = workspaces.teams as SlotlockWorkspaceTeams;
    sso = workspaces.sso as SlotlockWorkspaceSso;
    for (const person of people) await workspaces.signedIn(person, []);
  });

  afterAll(async () => {
    for (const ref of created) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    for (const ref of persons) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("saves a connection only for an Owner of a team with a verified domain, and activates it only once tested", async () => {
    const made = await teams.create(ada, 'No domain', `n${base.toString(36)}`, null);
    if (!('tenantRef' in made)) throw new Error(made.refusal);
    created.push(made.tenantRef);
    const params = {
      tenantRef: made.tenantRef,
      actor: ada,
      id: randomUUID(),
      kind: 'okta' as const,
      issuer: ISSUER,
      clientId: 'c',
      secretSealed: 'v1.x.y',
      secretLast4: 'y',
      authorizationEndpoint: `${ISSUER}/a`,
      tokenEndpoint: `${ISSUER}/t`,
      jwksUri: `${ISSUER}/k`,
      algorithms: ['RS256'] as const,
      issParameter: false,
      entraTenant: null,
    };
    expect(await sso.save(params)).toEqual({ refusal: 'no_verified_domain' });
    const { tenantRef, id } = await connectedTeam();
    expect(await sso.setStatus(tenantRef, ada, id, 'disabled')).toBeNull();
    // An Admin cannot change it; a new client returns it to draft, and it activates only once tested again.
    const raw = randomBytes(32);
    await teams.invite({ tenantRef, inviter: ada, to: { github: bea, login: 'bea' }, role: 'admin', tokenSha256: createHash('sha256').update(raw).digest(), days: 7, dailyLimit: null, memberCap: null });
    await teams.accept({ tokenSha256: createHash('sha256').update(raw).digest(), person: bea, emails: [], memberCap: null });
    expect(await sso.save({ ...params, tenantRef, actor: bea, id })).toEqual({ refusal: 'not_allowed' });
    expect(await sso.save({ ...params, tenantRef, id, clientId: 'another', secretSealed: null })).toEqual({ id, enforcementOff: false });
    const draft = await sso.connection(tenantRef);
    expect(draft).toMatchObject({ status: 'draft', configVersion: 2, testedVersion: 1, secretSealed: 'v1.sealed.secret' });
    expect(await sso.setStatus(tenantRef, ada, id, 'active')).toBe('untested');
    expect(await sso.recordTest(tenantRef, ada, id, 1, {})).toBe('stale_config');
    expect(await sso.recordTest(tenantRef, ada, id, 2, { iss: ISSUER })).toBeNull();
    expect(await sso.setStatus(tenantRef, ada, id, 'active')).toBeNull();
  });

  it('keys identities on the subject, never the email: an attacker team cannot reach a victim by asserting their address', async () => {
    // nOAuth: the attacker's team runs its own provider and asserts the victim's verified address.
    const victimTeam = await connectedTeam(bea);
    const attacker = await connectedTeam(cy);
    const victimEmail = `bea@${victimTeam.domain}`;
    const forged = await signIn(attacker.id, 'attacker-subject', { email: victimEmail, emailOk: true });
    // The address is not at a domain the attacker's team verified: untrusted, so no provisioning,
    // and the identity is a new person, never Bea.
    expect(forged).toMatchObject({ refusal: 'not_member', person: null });
    const [bound] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.sso_identities WHERE subject = 'attacker-subject'`;
    expect(bound?.count).toBe(0);
    expect((await workspaces.standing(victimTeam.tenantRef, bea, null)).role).toBe('owner');
    // At the attacker's own verified domain it provisions, into the attacker's team only.
    const own = await signIn(attacker.id, 'someone', { email: `x@${attacker.domain}` });
    expect(own).toMatchObject({ outcome: 'joined', role: 'viewer' });
    persons.push(own.person as string);
    expect((await workspaces.standing(victimTeam.tenantRef, own.person as string, null)).role).toBeNull();
  });

  it('provisions on a trusted email only, never an Owner, honours mappings and pins, and never brings back someone removed', async () => {
    const { tenantRef, domain, id } = await connectedTeam();
    expect(await signIn(id, 'u-untrusted', { email: `a@${domain}`, emailOk: false })).toMatchObject({ refusal: 'not_member' });
    expect(await signIn(id, 'u-guest', { email: `g@${domain}`, guest: true })).toMatchObject({ refusal: 'guest_refused' });
    expect(await sso.setMapping(tenantRef, ada, 'eng-admins', 'owner')).toBe('owner_not_mappable');
    expect(await sso.setMapping(tenantRef, ada, 'eng-admins', 'admin')).toBeNull();
    expect(await sso.setMapping(tenantRef, ada, 'eng', 'member')).toBeNull();
    const first = await signIn(id, 'u-1', { email: `one@${domain}`, groups: ['eng', 'eng-admins'] });
    expect(first).toMatchObject({ outcome: 'joined', role: 'admin' });
    persons.push(first.person as string);
    // The group goes at the provider: the next sign-in falls back to the default role.
    expect(await signIn(id, 'u-1', { email: `one@${domain}`, groups: [] })).toMatchObject({ outcome: 'role_changed', role: 'viewer' });
    // Too many groups to list (Entra's overage): the default role, never a guess.
    expect(await signIn(id, 'u-1', { email: `one@${domain}`, groups: ['eng-admins'], overage: true })).toMatchObject({ outcome: 'signed_in', role: 'viewer' });
    // A role set by hand stays: an Owner's change is never undone by the next sign-in.
    expect(await teams.changeRole(tenantRef, ada, first.person as string, 'developer')).toBeNull();
    expect(await signIn(id, 'u-1', { email: `one@${domain}`, groups: ['eng-admins'] })).toMatchObject({ outcome: 'signed_in', role: 'developer' });
    // Nobody who signs in only through the provider is made an Owner: the Owner a team keeps can
    // always bypass it.
    expect(await teams.changeRole(tenantRef, ada, first.person as string, 'owner')).toBe('sso_owner');
    // Removed: the provider does not bring them back, nor their address under a new subject.
    expect(await teams.remove(tenantRef, ada, first.person as string)).toBeNull();
    expect(await signIn(id, 'u-1', { email: `one@${domain}` })).toMatchObject({ refusal: 'not_member' });
    // Refused, a new identity is not kept: nobody is made, and the subject stays free to link.
    expect(await signIn(id, 'u-1-new', { email: `one@${domain}` })).toMatchObject({ refusal: 'not_member', person: null });
    // Provisioning off: nobody new.
    expect(await sso.setProvisioning(tenantRef, ada, false, 'viewer', 'groups')).toBeNull();
    expect(await signIn(id, 'u-2', { email: `two@${domain}` })).toMatchObject({ refusal: 'not_member', person: null });
    const [kept] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.sso_identities WHERE subject IN ('u-1-new', 'u-2', 'u-untrusted')`;
    expect(kept?.count).toBe(0);
    // A pending invitation to a trusted address is accepted, as invited.
    const raw = randomBytes(32);
    await teams.invite({ tenantRef, inviter: ada, to: { email: `three@${domain}` }, role: 'developer', tokenSha256: createHash('sha256').update(raw).digest(), days: 7, dailyLimit: null, memberCap: null });
    const invited = await signIn(id, 'u-3', { email: `three@${domain}` });
    expect(invited).toMatchObject({ outcome: 'joined', role: 'developer' });
    persons.push(invited.person as string);
    // An Owner's invitation is never accepted through the provider, which makes no Owner; nor by
    // a person who signs in only through it.
    expect(await sso.setProvisioning(tenantRef, ada, true, 'viewer', 'groups')).toBeNull();
    const ownerToken = randomBytes(32);
    await teams.invite({ tenantRef, inviter: ada, to: { email: `boss@${domain}` }, role: 'owner', tokenSha256: createHash('sha256').update(ownerToken).digest(), days: 7, dailyLimit: null, memberCap: null });
    const boss = await signIn(id, 'u-boss', { email: `boss@${domain}` });
    expect(boss).toMatchObject({ outcome: 'joined', role: 'viewer' });
    persons.push(boss.person as string);
    expect(await teams.accept({ tokenSha256: createHash('sha256').update(ownerToken).digest(), person: boss.person as string, emails: [`boss@${domain}`], memberCap: null })).toMatchObject({ refusal: 'not_for_you' });
  });

  it('links an identity only to a signed-in member, never to another person', async () => {
    const { tenantRef, domain, id } = await connectedTeam();
    expect(await signIn(id, 'link-1', { sessionPerson: cy })).toMatchObject({ refusal: 'not_member' });
    // Only an account the provider vouches for at the team's verified domain: no personal account
    // (an untrusted address, another domain, none) keeps a member in.
    expect(await signIn(id, 'link-1', { sessionPerson: ada, email: 'ada@gmail.com', emailOk: false })).toMatchObject({ refusal: 'identity_untrusted' });
    expect(await signIn(id, 'link-1', { sessionPerson: ada, email: 'ada@elsewhere-example.com' })).toMatchObject({ refusal: 'identity_untrusted' });
    expect(await signIn(id, 'link-1', { sessionPerson: ada })).toMatchObject({ refusal: 'identity_untrusted' });
    expect(await signIn(id, 'link-1', { sessionPerson: ada, email: `ada@${domain}` })).toMatchObject({ person: ada, outcome: 'linked', role: 'owner' });
    expect(await signIn(id, 'link-1', { sessionPerson: ada })).toMatchObject({ person: ada, outcome: 'proof' });
    // Through the provider alone, the identity is Ada's.
    expect(await signIn(id, 'link-1')).toMatchObject({ person: ada, outcome: 'signed_in', role: 'owner' });
    // Another member cannot take it.
    const raw = randomBytes(32);
    await teams.invite({ tenantRef, inviter: ada, to: { github: bea, login: 'bea' }, role: 'member', tokenSha256: createHash('sha256').update(raw).digest(), days: 7, dailyLimit: null, memberCap: null });
    await teams.accept({ tokenSha256: createHash('sha256').update(raw).digest(), person: bea, emails: [], memberCap: null });
    expect(await signIn(id, 'link-1', { sessionPerson: bea })).toMatchObject({ refusal: 'identity_taken' });
    // One account a person: linking another replaces the first, which is kept, marked, and signs in as nobody.
    expect(await signIn(id, 'link-2', { sessionPerson: ada, email: `ada2@${domain}` })).toMatchObject({ person: ada, outcome: 'linked' });
    const linkedToAda = await admin<{ subject: string; replaced: boolean }[]>`
      SELECT subject, replaced_at IS NOT NULL AS replaced FROM slotlock.sso_identities WHERE connection_id = ${id} AND person_ref = ${ada} ORDER BY subject`;
    expect(linkedToAda).toEqual([{ subject: 'link-1', replaced: true }, { subject: 'link-2', replaced: false }]);
    expect(await signIn(id, 'link-1')).toMatchObject({ refusal: 'not_member', person: null });
    // A refused first sign-in keeps nothing, so its owner may link it later.
    expect(await sso.setProvisioning(tenantRef, ada, false, 'viewer', 'groups')).toBeNull();
    expect(await signIn(id, 'bea-at-idp', { email: `bea@${domain}` })).toMatchObject({ refusal: 'not_member', person: null });
    expect(await signIn(id, 'bea-at-idp', { sessionPerson: bea, email: `bea@${domain}` })).toMatchObject({ person: bea, outcome: 'linked' });
    // Removed, Bea's address (as her provider sign-ins carried it) provisions nobody under a new subject.
    expect(await sso.setProvisioning(tenantRef, ada, true, 'viewer', 'groups')).toBeNull();
    expect(await teams.remove(tenantRef, ada, bea)).toBeNull();
    expect(await signIn(id, 'bea-new-subject', { email: `bea@${domain}` })).toMatchObject({ refusal: 'not_member', person: null });
  });

  it('scopes a session begun through a provider alone to its team, and holds "require single sign-on"', async () => {
    const { tenantRef, domain, id } = await connectedTeam();
    // Ada's GitHub session: a member of the team and of her own workspace.
    const github = await session(ada);
    expect((await workspaces.standing(tenantRef, ada, github)).role).toBe('owner');
    expect((await workspaces.standing(ada, ada, github)).role).toBe('owner');
    // Ada signs in through the provider alone (her identity linked): scoped to the team.
    expect(await signIn(id, 'scope-ada', { sessionPerson: ada, email: `ada@${domain}` })).toMatchObject({ outcome: 'linked' });
    const scoped = await session(ada);
    expect(await sso.recordProof(scoped, ada, id, true)).toBe(true);
    expect((await workspaces.standing(tenantRef, ada, scoped)).role).toBe('owner');
    expect(await workspaces.standing(ada, ada, scoped)).toMatchObject({ role: null, refusal: 'sso_scope' });
    // A person the provider made has no workspace of their own.
    const member = await signIn(id, 'scope-member', { email: `m@${domain}` });
    persons.push(member.person as string);
    const memberSession = await session(member.person as string);
    expect((await workspaces.standing(member.person as string, member.person as string, memberSession)).role).toBeNull();
    // Requiring single sign-on needs a fresh proof in this session.
    expect(await sso.requireSso(tenantRef, ada, github, true, 24)).toBe('stale_sso_proof');
    expect(await signIn(id, 'scope-ada', { sessionPerson: ada })).toMatchObject({ outcome: 'proof' });
    expect(await sso.recordProof(github, ada, id, false)).toBe(true);
    expect(await sso.requireSso(tenantRef, ada, github, true, 0)).toBe('invalid_max_age');
    expect(await sso.requireSso(tenantRef, ada, github, true, 24)).toBeNull();
    // A member's session without a proof: no role there, their own workspace untouched; without a
    // session given at all, no role either (fails closed).
    expect(await sso.setProvisioning(tenantRef, ada, true, 'member', 'groups')).toBeNull();
    const raw = randomBytes(32);
    await teams.invite({ tenantRef, inviter: ada, to: { github: bea, login: 'bea' }, role: 'member', tokenSha256: createHash('sha256').update(raw).digest(), days: 7, dailyLimit: null, memberCap: null });
    await teams.accept({ tokenSha256: createHash('sha256').update(raw).digest(), person: bea, emails: [], memberCap: null });
    const beaSession = await session(bea);
    expect(await workspaces.standing(tenantRef, bea, beaSession)).toMatchObject({ role: null, refusal: 'sso_required', mayBypass: false });
    expect((await workspaces.standing(bea, bea, beaSession)).role).toBe('owner');
    expect((await workspaces.standing(tenantRef, bea, null)).role).toBeNull();
    // An Owner without a proof may bypass, for an hour, in that session; nobody else may.
    const adaElsewhere = await session(ada);
    expect(await workspaces.standing(tenantRef, ada, adaElsewhere)).toMatchObject({ refusal: 'sso_required', mayBypass: true });
    expect(await sso.bypass(tenantRef, bea, beaSession)).toBe('not_allowed');
    expect(await sso.bypass(tenantRef, ada, adaElsewhere)).toBeNull();
    expect((await workspaces.standing(tenantRef, ada, adaElsewhere)).role).toBe('owner');
    await admin`UPDATE slotlock.sso_bypasses SET granted_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE tenant_ref = ${tenantRef}`;
    expect((await workspaces.standing(tenantRef, ada, adaElsewhere)).role).toBeNull();
    // A proof older than the team allows: no role.
    await admin`UPDATE slotlock.dashboard_session_sso SET authenticated_at = now() - interval '25 hours' WHERE person_ref = ${ada}`;
    expect((await workspaces.standing(tenantRef, ada, github)).role).toBeNull();
    // Changing the issuer turns enforcement off; disabling the connection would too.
    const current = await sso.connection(tenantRef);
    const saved = await sso.save({
      tenantRef,
      actor: ada,
      id,
      kind: 'okta',
      issuer: `${ISSUER}2`,
      clientId: current?.clientId as string,
      secretSealed: null,
      secretLast4: null,
      authorizationEndpoint: current?.authorizationEndpoint as string,
      tokenEndpoint: current?.tokenEndpoint as string,
      jwksUri: current?.jwksUri as string,
      algorithms: ['RS256'],
      issParameter: false,
      entraTenant: null,
    });
    expect(saved).toEqual({ id, enforcementOff: true });
    expect((await workspaces.standing(tenantRef, bea, beaSession)).role).toBe('member');
    // A new configuration ends what the old one vouched for: the scoped session, and every proof.
    expect((await workspaces.standing(tenantRef, ada, scoped)).role).toBeNull();
    const [proofs] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.dashboard_session_sso WHERE connection_id = ${id}`;
    expect(proofs?.count).toBe(0);
    // A session scoped to one team's provider proves nothing to another's.
    const [other, third] = [await connectedTeam(), await connectedTeam()];
    const rescoped = await session(member.person as string);
    expect(await sso.recordProof(rescoped, member.person as string, other.id, true)).toBe(true);
    expect(await sso.recordProof(rescoped, member.person as string, third.id, false)).toBe(false);
  });

  it("ends a provider's sessions and proofs when it is turned off", async () => {
    const { tenantRef, domain, id } = await connectedTeam();
    const joined = await signIn(id, 'off-1', { email: `off@${domain}` });
    persons.push(joined.person as string);
    const sid = await session(joined.person as string);
    expect(await sso.recordProof(sid, joined.person as string, id, true)).toBe(true);
    expect((await workspaces.standing(tenantRef, joined.person as string, sid)).role).toBe('viewer');
    const adaSid = await session(ada);
    expect(await signIn(id, 'off-ada', { sessionPerson: ada, email: `ada@${domain}` })).toMatchObject({ outcome: 'linked' });
    expect(await sso.recordProof(adaSid, ada, id, false)).toBe(true);
    expect(await sso.setStatus(tenantRef, ada, id, 'disabled')).toBeNull();
    expect(await workspaces.standing(tenantRef, joined.person as string, sid)).toMatchObject({ role: null, refusal: 'sso_scope' });
    // Its session has ended, and turned on again, nothing it vouched for comes back.
    expect(await workspaces.sessions?.seen(joined.person as string, sid)).toBe(false);
    expect(await sso.setStatus(tenantRef, ada, id, 'active')).toBeNull();
    const [proofs] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.dashboard_session_sso WHERE connection_id = ${id}`;
    expect(proofs?.count).toBe(0);
    expect(await workspaces.sessions?.seen(joined.person as string, sid)).toBe(false);
    // Ada's GitHub session lives on, without the proof it had.
    expect(await workspaces.sessions?.seen(ada, adaSid)).toBe(true);
  });

  it('keeps a team that requires single sign-on from losing its last way in', async () => {
    const { tenantRef, domain, id } = await connectedTeam();
    // Every Owner signs in through the provider (only by the schema owner's hand: Slotlock never
    // makes one): no deleting it, no disabling it.
    const owner = await signIn(id, 'only-owner', { email: `only@${domain}` });
    persons.push(owner.person as string);
    await admin`UPDATE slotlock.workspace_memberships SET role = 'owner' WHERE tenant_ref = ${tenantRef} AND person_ref = ${owner.person as string}`;
    await admin`UPDATE slotlock.workspace_memberships SET role = 'admin' WHERE tenant_ref = ${tenantRef} AND person_ref = ${ada}`;
    expect(await sso.remove(tenantRef, owner.person as string, id)).toBe('no_breakglass_owner');
    expect(await sso.setStatus(tenantRef, owner.person as string, id, 'disabled')).toBe('no_breakglass_owner');
    // A provider-made person never bypasses.
    const sid = await session(owner.person as string);
    expect(await sso.bypass(tenantRef, owner.person as string, sid)).toBe('not_allowed');
    await admin`UPDATE slotlock.workspace_memberships SET role = 'owner' WHERE tenant_ref = ${tenantRef} AND person_ref = ${ada}`;
    expect(await sso.remove(tenantRef, ada, id)).toBeNull();
    expect(await sso.connection(tenantRef)).toBeNull();
  });

  it('erases a team with its single sign-on, and a person with their identities', async () => {
    const { tenantRef, domain, id } = await connectedTeam();
    const member = await signIn(id, 'erase-me', { email: `e@${domain}` });
    const person = member.person as string;
    persons.push(person);
    const sid = await session(person);
    expect(await sso.recordProof(sid, person, id, true)).toBe(true);
    const erasedPerson = await admin<{ erased_table: string; erased_rows: string }[]>`SELECT * FROM slotlock.erase_tenant(${person}::text)`;
    expect(Number(erasedPerson.find((row) => row.erased_table === 'sso_identities')?.erased_rows)).toBe(1);
    const [proofs] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.dashboard_session_sso WHERE person_ref = ${person}`;
    expect(proofs?.count).toBe(0);
    // Someone else who signed in only through the provider, with their address shown as their name.
    const other = await signIn(id, 'erase-with-team', { email: `w@${domain}` });
    const remaining = other.person as string;
    persons.push(remaining);
    await workspaces.signedIn(remaining);
    await teams.setDisplay(remaining, `w@${domain}`);
    await session(remaining);
    // A co-owner's test sign-in showed their address: erasing them takes it off the connection.
    const tester = people[7] as string;
    const ownerToken = randomBytes(32);
    await teams.invite({ tenantRef, inviter: ada, to: { github: tester, login: 'dee' }, role: 'owner', tokenSha256: createHash('sha256').update(ownerToken).digest(), days: 7, dailyLimit: null, memberCap: null });
    await teams.accept({ tokenSha256: createHash('sha256').update(ownerToken).digest(), person: tester, emails: [], memberCap: null });
    expect(await sso.recordTest(tenantRef, tester, id, 1, { email: `dee@${domain}` })).toBeNull();
    await admin`SELECT * FROM slotlock.erase_tenant(${tester}::text)`;
    const [claims] = await admin<{ last_test_claims: unknown; tested_by: string | null }[]>`SELECT last_test_claims, tested_by FROM slotlock.sso_connections WHERE id = ${id}`;
    expect(claims).toEqual({ last_test_claims: null, tested_by: null });
    const erasedTeam = await admin<{ erased_table: string; erased_rows: string }[]>`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    expect(Number(erasedTeam.find((row) => row.erased_table === 'sso_connections')?.erased_rows)).toBe(1);
    // They can never sign in again to ask: they go with the team.
    expect(Number(erasedTeam.find((row) => row.erased_table === 'sso_people')?.erased_rows)).toBe(1);
    for (const table of ['dashboard_people', 'dashboard_sessions', 'workspace_memberships']) {
      const [left] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM ${admin(`slotlock.${table}`)} WHERE person_ref = ${remaining}`;
      expect(`${table}: ${left?.count}`).toBe(`${table}: 0`);
    }
  });

  it('erases the people who signed in only through a connection when the connection is deleted', async () => {
    const { tenantRef, domain, id } = await connectedTeam();
    const gone = await signIn(id, 'delete-with-connection', { email: `d@${domain}` });
    persons.push(gone.person as string);
    await workspaces.signedIn(gone.person as string);
    expect(await sso.remove(tenantRef, ada, id)).toBeNull();
    const [left] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.dashboard_people WHERE person_ref = ${gone.person as string}`;
    expect(left?.count).toBe(0);
    expect((await workspaces.standing(tenantRef, gone.person as string, null)).role).toBeNull();
  });

  /** A GitHub member of the team, by invitation. */
  async function addByGithub(tenantRef: string, person: string, as: 'admin' | 'member') {
    const raw = randomBytes(32);
    await teams.invite({ tenantRef, inviter: ada, to: { github: person, login: `user${person.slice('github:'.length)}` }, role: as, tokenSha256: createHash('sha256').update(raw).digest(), days: 7, dailyLimit: null, memberCap: null });
    await teams.accept({ tokenSha256: createHash('sha256').update(raw).digest(), person, emails: [], memberCap: null });
  }

  it('brings nobody removed back: not by an invitation sent before, nor under an account they replaced', async () => {
    const { tenantRef, domain, id } = await connectedTeam();
    await addByGithub(tenantRef, bea, 'admin');
    // An invitation to a member's own address, sent while they were a member, goes with the removal.
    const email = `rita@${domain}`;
    const joined = await signIn(id, 'rita-account-1', { email });
    const rita = joined.person as string;
    persons.push(rita);
    await teams.invite({ tenantRef, inviter: bea, to: { email }, role: 'member', tokenSha256: randomBytes(32), days: 7, dailyLimit: null, memberCap: null });
    expect(await teams.remove(tenantRef, ada, rita)).toBeNull();
    expect(await signIn(id, 'rita-account-2', { email })).toMatchObject({ refusal: 'not_member', person: null });
    // An account a member replaced by linking another stays theirs: removed, neither comes back,
    // and while they are a member the replaced one signs in as nobody.
    const cyWork = `cy@${domain}`;
    await addByGithub(tenantRef, cy, 'member');
    expect(await signIn(id, 'cy-work', { email: cyWork, sessionPerson: cy })).toMatchObject({ outcome: 'linked' });
    expect(await signIn(id, 'cy-admin', { email: `cy.admin@${domain}`, sessionPerson: cy })).toMatchObject({ outcome: 'linked' });
    expect(await signIn(id, 'cy-work', { email: cyWork })).toMatchObject({ refusal: 'not_member', person: null });
    // Linking the first again puts it back in place of the second.
    expect(await signIn(id, 'cy-work', { email: cyWork, sessionPerson: cy })).toMatchObject({ outcome: 'proof' });
    expect(await signIn(id, 'cy-work', { email: cyWork })).toMatchObject({ person: cy, outcome: 'signed_in' });
    expect(await signIn(id, 'cy-admin', { email: `cy.admin@${domain}` })).toMatchObject({ refusal: 'not_member' });
    expect(await teams.remove(tenantRef, ada, cy)).toBeNull();
    for (const [subject, address] of [['cy-work', cyWork], ['cy-admin', `cy.admin@${domain}`], ['cy-new', cyWork], ['cy-new-2', `cy.admin@${domain}`]] as const) {
      expect(await signIn(id, subject, { email: address })).toMatchObject({ refusal: 'not_member' });
    }
  });

  it('records no proof once the connection is off, and keeps no one its deletion erased mid sign-in', async () => {
    const { tenantRef, domain, id } = await connectedTeam();
    // A sign-in through the provider, its proof landing after the Owner turned the connection off.
    const joined = await signIn(id, 'late-at-idp', { email: `late@${domain}` });
    const late = joined.person as string;
    persons.push(late);
    expect(await sso.setStatus(tenantRef, ada, id, 'disabled')).toBeNull();
    await workspaces.signedIn(late, undefined);
    const sid = randomBytes(24).toString('base64url');
    await workspaces.sessions?.started(late, sid, new Date(Date.now() + 3_600_000), {});
    expect(await sso.recordProof(sid, late, id, true)).toBe(false);
    expect(await sso.setStatus(tenantRef, ada, id, 'active')).toBeNull();
    // Unscoped, the session of a person the provider made is nobody's.
    expect(await workspaces.standing(tenantRef, late, sid)).toMatchObject({ role: null, refusal: 'sso_scope' });
    // A proof from a configuration changed since is refused too.
    const fresh = randomBytes(24).toString('base64url');
    await workspaces.sessions?.started(late, fresh, new Date(Date.now() + 3_600_000), {});
    expect(await sso.recordProof(fresh, late, id, true, 999)).toBe(false);
    // Deleted while a sign-in finishes: the person it erased is not made again.
    const erin = (await signIn(id, 'erin-at-idp', { email: `erin@${domain}` })).person as string;
    persons.push(erin);
    expect(await sso.remove(tenantRef, ada, id)).toBeNull();
    await expect(workspaces.signedIn(erin, undefined)).rejects.toThrow(/no longer here/);
    await teams.setDisplay(erin, `erin@${domain}`);
    await expect(workspaces.sessions?.started(erin, randomBytes(24).toString('base64url'), new Date(Date.now() + 3_600_000), { ipAddress: '203.0.113.7' })).rejects.toThrow(/no longer here/);
    expect(await admin`SELECT 1 FROM slotlock.dashboard_people WHERE person_ref = ${erin}`).toHaveLength(0);
    expect(await admin`SELECT 1 FROM slotlock.dashboard_sessions WHERE person_ref = ${erin}`).toHaveLength(0);
  });

  it("keeps a linked member's own sessions however often the provider signs in as them, and never bypasses from its sessions", async () => {
    const { tenantRef, domain, id } = await connectedTeam();
    const dee = people[3] as string;
    await addByGithub(tenantRef, dee, 'member');
    const own = await session(dee);
    expect(await signIn(id, 'dee-at-idp', { email: `dee@${domain}`, sessionPerson: dee })).toMatchObject({ outcome: 'linked' });
    for (let index = 0; index < 55; index++) {
      expect((await signIn(id, 'dee-at-idp', { email: `dee@${domain}` })).person).toBe(dee);
      const sid = randomBytes(24).toString('base64url');
      await workspaces.sessions?.started(dee, sid, new Date(Date.now() + 3_600_000), {});
      expect(await sso.recordProof(sid, dee, id, true)).toBe(true);
    }
    expect(await workspaces.sessions?.seen(dee, own)).toBe(true);
    const [kept] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.dashboard_sessions WHERE person_ref = ${dee}`;
    expect(kept?.count).toBe(50);
    // An Owner's session the provider began alone bypasses nothing.
    expect(await signIn(id, 'ada-at-idp', { email: `ada@${domain}`, sessionPerson: ada })).toMatchObject({ outcome: 'linked' });
    const scoped = await session(ada);
    expect(await sso.recordProof(scoped, ada, id, true)).toBe(true);
    expect(await sso.bypass(tenantRef, ada, scoped)).toBe('not_allowed');
  });

  it("keeps a linked member's own sessions through provider sign-ins whose proof is refused, and keeps none of those", async () => {
    const { tenantRef, domain, id } = await connectedTeam();
    const fay = people[4] as string;
    await addByGithub(tenantRef, fay, 'member');
    const own = await session(fay);
    expect(await signIn(id, 'fay-at-idp', { email: `fay@${domain}`, sessionPerson: fay })).toMatchObject({ outcome: 'linked' });
    const later = () => new Date(Date.now() + 3_600_000);
    const sessionsOf = async () =>
      (await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.dashboard_sessions WHERE person_ref = ${fay}`)[0]?.count;
    // Fifty callbacks read the connection, then wait on the provider while the Owner changes it,
    // tests it and turns it on again: each proof is refused, and nothing of theirs is kept.
    const read = (await sso.connectionById(id))?.configVersion as number;
    await admin`UPDATE slotlock.sso_connections SET config_version = config_version + 1, tested_version = config_version + 1 WHERE id = ${id}::uuid`;
    for (let index = 0; index < 50; index++) {
      expect((await signIn(id, 'fay-at-idp', { email: `fay@${domain}` })).person).toBe(fay);
      await workspaces.signedIn(fay, []);
      expect(await sso.startScoped(randomBytes(24).toString('base64url'), fay, id, read, later(), {})).toBe(false);
    }
    expect(await sessionsOf()).toBe(1);
    // One more, proved: scoped to the team from the moment it is recorded, the member's own kept.
    const scoped = randomBytes(24).toString('base64url');
    expect(await sso.startScoped(scoped, fay, id, read + 1, later(), { userAgent: 'Firefox', ipAddress: '203.0.113.9' })).toBe(true);
    expect(await workspaces.sessions?.seen(fay, own)).toBe(true);
    expect(await workspaces.standing(tenantRef, fay, scoped)).toMatchObject({ role: 'member', refusal: null });
    const scopedDigest = createHash('sha256').update(scoped).digest();
    const [kept] = await admin<{ sso_connection_id: string; user_agent: string; proofs: number }[]>`
      SELECT kept.sso_connection_id, kept.user_agent,
             (SELECT count(*)::int FROM slotlock.dashboard_session_sso proof WHERE proof.sid_sha256 = kept.sid_sha256) AS proofs
        FROM slotlock.dashboard_sessions kept WHERE kept.sid_sha256 = ${scopedDigest}`;
    expect(kept).toEqual({ sso_connection_id: id, user_agent: 'Firefox', proofs: 1 });
    // A session id already recorded is not taken over.
    expect(await sso.startScoped(own, fay, id, read + 1, later(), {})).toBe(false);
    expect(await workspaces.standing(tenantRef, fay, own)).toMatchObject({ role: 'member' });

    // Recorded in two steps, as a release before this one does and the dashboard still does on a
    // schema without the one: each refused, then ended. Ended sessions go first of the 50 kept.
    for (let index = 0; index < 50; index++) {
      const sid = randomBytes(24).toString('base64url');
      await workspaces.sessions?.started(fay, sid, later(), {});
      expect(await sso.recordProof(sid, fay, id, true, read)).toBe(false);
      expect(await workspaces.sessions?.end(fay, workspaces.sessions.idOf(sid))).toBe(true);
    }
    await session(fay);
    expect(await workspaces.sessions?.seen(fay, own)).toBe(true);
    expect(await workspaces.sessions?.seen(fay, scoped)).toBe(true);
    expect(await sessionsOf()).toBe(50);
  });

  it("keeps the tables out of the serving role's reach but for the functions", async () => {
    for (const table of ['sso_connections', 'sso_identities', 'sso_role_mappings', 'dashboard_session_sso', 'sso_bypasses']) {
      await expect(application.unsafe(`SELECT * FROM slotlock.${table}`)).rejects.toThrow(/permission denied/);
    }
  });
});
