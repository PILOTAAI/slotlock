// Team workspaces, their invitations and members (workspaces.ts teams), as the LOGIN role
// grantApplicationRole grants: every change through a SECURITY DEFINER function that checks the
// actor's role and ceiling, binds an invitation to whom it was for, keeps an Owner, and holds when
// two changes race. Skipped without DATABASE_URL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockStore } from '../store.js';
import {
  type SlotlockWorkspaceTeams,
  createSlotlockDashboardWorkspaces,
  createSlotlockWorkspaceCheck,
} from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

const token = () => {
  const raw = randomBytes(32);
  return { raw, digest: createHash('sha256').update(raw).digest() };
};

describe.skipIf(!url)('team workspaces, invitations and members (real Postgres)', () => {
  const role = `slotlock_tm_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const base = 600_000_000 + Math.floor(Math.random() * 90_000_000);
  const people = Array.from({ length: 15 }, (_, index) => `github:${base + index}`);
  const [ada, bea, cy, dee, eli, fay, gus, hal, ivy, jo, kim, lou, max, ned, ola] = people as [
    string, string, string, string, string, string, string, string, string, string, string, string,
    string, string, string,
  ];
  const googler = `google:t${randomUUID().replaceAll('-', '')}`;
  const created: string[] = [];
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let teams: SlotlockWorkspaceTeams;
  const store = () => createSlotlockStore(application);
  let handleSeq = 0;
  const handle = () => `t${base.toString(36)}-${(handleSeq++).toString(36)}`;

  const team = async (owner: string, cap: number | null = null) => {
    const made = await teams.create(owner, 'Acme rentals', handle(), cap);
    if (!('tenantRef' in made)) throw new Error(`create refused: ${made.refusal}`);
    created.push(made.tenantRef);
    return made.tenantRef;
  };
  const invite = (tenantRef: string, inviter: string, to: { email: string } | { github: string; login: string }, roleName: Parameters<SlotlockWorkspaceTeams['invite']>[0]['role'], extra: { memberCap?: number | null; dailyLimit?: number | null } = {}) => {
    const sent = token();
    return teams
      .invite({ tenantRef, inviter, to, role: roleName, tokenSha256: sent.digest, days: 7, dailyLimit: extra.dailyLimit ?? null, memberCap: extra.memberCap ?? null })
      .then((result) => ({ result, digest: sent.digest }));
  };
  const join = async (tenantRef: string, inviter: string, person: string, roleName: Parameters<SlotlockWorkspaceTeams['invite']>[0]['role']) => {
    const { result, digest } = await invite(tenantRef, inviter, { github: person, login: `p${person.slice(7)}` }, roleName);
    expect(result).toHaveProperty('id');
    expect(await teams.accept({ tokenSha256: digest, person, emails: [], memberCap: null })).toEqual({ tenantRef });
  };
  const roleIn = async (tenantRef: string, person: string) =>
    (await createSlotlockDashboardWorkspaces(application).standing(tenantRef, person, null)).role;

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
    for (const person of people) await workspaces.signedIn(person, []);
    await workspaces.signedIn(googler);
    await teams.setDisplay(ada, 'ada');
  });

  afterAll(async () => {
    for (const ref of created) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    for (const ref of [...people, googler]) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('creates a team workspace with its creator its Owner, and refuses a bad or taken handle', async () => {
    const tenantRef = await team(ada);
    expect(tenantRef).toMatch(/^team:[0-9a-f-]{36}$/);
    expect(await roleIn(tenantRef, ada)).toBe('owner');
    expect(await roleIn(`${tenantRef}~test`, ada)).toBe('owner');
    expect(await roleIn(tenantRef, bea)).toBeNull();
    const info = await teams.info(tenantRef);
    expect(info?.name).toBe('Acme rentals');
    expect((await teams.workspacesOf(ada)).map((ws) => ws.tenantRef)).toContain(tenantRef);
    expect(await teams.members(tenantRef)).toEqual([expect.objectContaining({ person: ada, role: 'owner', source: 'created', display: 'ada' })]);

    expect(await teams.create(ada, 'X', 'Bad Handle', null)).toEqual({ refusal: 'invalid_handle' });
    expect(await teams.create(ada, 'X', '-dash', null)).toEqual({ refusal: 'invalid_handle' });
    expect(await teams.create(ada, '   ', handle(), null)).toEqual({ refusal: 'invalid_name' });
    expect(await teams.create(ada, 'a\u0007b', handle(), null)).toEqual({ refusal: 'invalid_name' });
    expect(await teams.create(bea, 'Other', info?.handle as string, null)).toEqual({ refusal: 'handle_taken' });
    await expect(teams.create('github:0', 'X', handle(), null)).rejects.toThrow();
  });

  it('lets a person create as many free team workspaces as the cap, even all at once', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => teams.create(lou, 'Race', handle(), 1)));
    const made = results.filter((result): result is { tenantRef: string } => 'tenantRef' in result);
    for (const result of made) created.push(result.tenantRef);
    expect(made).toHaveLength(1);
    expect(results.filter((result) => 'refusal' in result && result.refusal === 'team_limit')).toHaveLength(4);
    // On Developer (an override, say) it still counts: only Team lifts a team workspace's limits.
    await admin`
      INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints)
      VALUES (${made[0]?.tenantRef as string}, 'developer', 'active', 100, 100, 10)`;
    expect(await teams.create(lou, 'Second', handle(), 1)).toEqual({ refusal: 'team_limit' });
    // On Team it no longer counts against the free cap.
    await admin`UPDATE slotlock.tenant_plans SET plan = 'team' WHERE tenant_ref = ${made[0]?.tenantRef as string}`;
    const second = await teams.create(lou, 'Second', handle(), 1);
    expect(second).toHaveProperty('tenantRef');
    if ('tenantRef' in second) created.push(second.tenantRef);
    expect(await teams.create(lou, 'Third', handle(), 1)).toEqual({ refusal: 'team_limit' });
  });

  it('gives an invitation only to the GitHub account or the verified email it was sent to', async () => {
    const tenantRef = await team(ada);
    const byEmail = await invite(tenantRef, ada, { email: '  Bea@Example.COM ' }, 'developer');
    expect(byEmail.result).toHaveProperty('id');
    const preview = await teams.preview(byEmail.digest);
    expect(preview).toMatchObject({ tenantRef, workspaceName: 'Acme rentals', inviterDisplay: 'ada', role: 'developer', email: 'bea@example.com', state: 'pending' });
    // Someone holding the link but not the email: refused, and the invitation still stands.
    expect(await teams.accept({ tokenSha256: byEmail.digest, person: cy, emails: ['cy@example.com'], memberCap: null })).toEqual({ refusal: 'not_for_you' });
    expect(await teams.accept({ tokenSha256: byEmail.digest, person: cy, emails: [], memberCap: null })).toEqual({ refusal: 'not_for_you' });
    expect(await teams.accept({ tokenSha256: byEmail.digest, person: bea, emails: ['BEA@example.com'], memberCap: null })).toEqual({ tenantRef });
    expect(await roleIn(tenantRef, bea)).toBe('developer');
    expect((await teams.preview(byEmail.digest))?.state).toBe('accepted');
    expect(await teams.accept({ tokenSha256: byEmail.digest, person: bea, emails: ['bea@example.com'], memberCap: null })).toEqual({ refusal: 'accepted' });

    const byGithub = await invite(tenantRef, ada, { github: cy, login: 'cy' }, 'viewer');
    expect(await teams.accept({ tokenSha256: byGithub.digest, person: dee, emails: [], memberCap: null })).toEqual({ refusal: 'not_for_you' });
    expect(await teams.accept({ tokenSha256: byGithub.digest, person: googler, emails: [], memberCap: null })).toEqual({ refusal: 'not_for_you' });
    expect(await teams.accept({ tokenSha256: byGithub.digest, person: cy, emails: [], memberCap: null })).toEqual({ tenantRef });
    expect(await roleIn(tenantRef, cy)).toBe('viewer');

    // A Google account with the verified email joins too; a wrong token or id finds nothing.
    const toGoogle = await invite(tenantRef, ada, { email: 'g@example.com' }, 'member');
    expect(await teams.pendingFor(googler, ['g@example.com'])).toEqual([expect.objectContaining({ tenantRef, role: 'member', inviterDisplay: 'ada' })]);
    expect(await teams.pendingFor(dee, ['g@example.com'])).toHaveLength(1);
    expect(await teams.pendingFor(dee, [])).toEqual([]);
    expect(await teams.accept({ tokenSha256: token().digest, person: googler, emails: ['g@example.com'], memberCap: null })).toEqual({ refusal: 'not_found' });
    const id = (toGoogle.result as { id: string }).id;
    expect(await teams.accept({ id, person: googler, emails: ['g@example.com'], memberCap: null })).toEqual({ tenantRef });
    expect(await teams.pendingFor(googler, ['g@example.com'])).toEqual([]);
  });

  it('makes exactly one member when the same invitation is accepted twice at once', async () => {
    const tenantRef = await team(ada);
    const sent = await invite(tenantRef, ada, { email: 'shared@example.com' }, 'member');
    const results = await Promise.all(
      [dee, eli, fay, gus].map((person) => teams.accept({ tokenSha256: sent.digest, person, emails: ['shared@example.com'], memberCap: null })),
    );
    expect(results.filter((result) => 'tenantRef' in result)).toHaveLength(1);
    expect(results.filter((result) => 'refusal' in result && result.refusal === 'accepted')).toHaveLength(3);
    expect((await teams.members(tenantRef)).map((member) => member.role).sort()).toEqual(['member', 'owner']);
  });

  it('never lets anyone give, change or remove a role above their own', async () => {
    const tenantRef = await team(ada);
    await join(tenantRef, ada, bea, 'admin');
    await join(tenantRef, ada, cy, 'developer');
    // An Admin invites up to Admin, never Owner or Billing; a Developer invites nobody.
    expect((await invite(tenantRef, bea, { email: 'x@example.com' }, 'owner')).result).toEqual({ refusal: 'not_allowed' });
    expect((await invite(tenantRef, bea, { email: 'x@example.com' }, 'billing')).result).toEqual({ refusal: 'not_allowed' });
    expect((await invite(tenantRef, bea, { email: 'x@example.com' }, 'admin')).result).toHaveProperty('id');
    expect((await invite(tenantRef, cy, { email: 'y@example.com' }, 'viewer')).result).toEqual({ refusal: 'not_allowed' });
    expect((await invite(tenantRef, hal, { email: 'y@example.com' }, 'viewer')).result).toEqual({ refusal: 'not_allowed' });
    // An Admin can't touch the Owner, nor make anyone Owner; a Developer changes nobody.
    expect(await teams.changeRole(tenantRef, bea, ada, 'viewer')).toBe('not_allowed');
    expect(await teams.changeRole(tenantRef, bea, cy, 'owner')).toBe('not_allowed');
    expect(await teams.remove(tenantRef, bea, ada)).toBe('not_allowed');
    expect(await teams.changeRole(tenantRef, cy, cy, 'admin')).toBe('not_allowed');
    expect(await teams.remove(tenantRef, cy, bea)).toBe('not_allowed');
    expect(await teams.changeRole(tenantRef, bea, cy, 'member')).toBeNull();
    expect(await roleIn(tenantRef, cy)).toBe('member');
    expect(await teams.changeRole(tenantRef, bea, hal, 'member')).toBe('not_found');
  });

  it('limits a member to locations and groups: by an Owner or an Admin not limited, never an Owner (RFC 0004 D1)', async () => {
    const tenantRef = await team(ada);
    await join(tenantRef, ada, bea, 'admin');
    await join(tenantRef, ada, cy, 'member');
    await join(tenantRef, ada, dee, 'admin');
    const workspaces = createSlotlockDashboardWorkspaces(application);
    const scopeOf = (person: string, tenant = tenantRef) => (workspaces.scope as NonNullable<typeof workspaces.scope>)(tenant, person);
    const north = { locations: ['north'], groups: [] };
    expect(await teams.setScope(tenantRef, bea, cy, north)).toBeNull();
    // The test environment is the same member's: limited alike.
    expect(await scopeOf(cy)).toEqual(north);
    expect(await scopeOf(cy, `${tenantRef}~test`)).toEqual(north);
    expect([...(await teams.scopes(tenantRef))]).toEqual([[cy, north]]);
    // Never an Owner; a limited Admin limits no one, nor does a Member; nor a stranger, or of one.
    expect(await teams.setScope(tenantRef, bea, ada, north)).toBe('owner');
    expect(await teams.setScope(tenantRef, bea, dee, { locations: [], groups: ['vans'] })).toBeNull();
    expect(await teams.setScope(tenantRef, dee, cy, null)).toBe('not_allowed');
    expect(await teams.setScope(tenantRef, cy, bea, north)).toBe('not_allowed');
    expect(await teams.setScope(tenantRef, hal, cy, null)).toBe('not_allowed');
    expect(await teams.setScope(tenantRef, bea, hal, north)).toBe('not_found');
    // Made an Owner, they reach all of it, and their limit is gone: made an Admin again, they
    // still reach all of it.
    expect(await teams.changeRole(tenantRef, ada, dee, 'owner')).toBeNull();
    expect(await scopeOf(dee)).toBeNull();
    expect([...(await teams.scopes(tenantRef))].map(([person]) => person)).toEqual([cy]);
    expect(await teams.changeRole(tenantRef, ada, dee, 'admin')).toBeNull();
    expect(await scopeOf(dee)).toBeNull();
    const [kept] = await admin<{ resource_scope: unknown }[]>`
      SELECT resource_scope FROM slotlock.workspace_memberships WHERE tenant_ref = ${tenantRef} AND person_ref = ${dee}`;
    expect(kept?.resource_scope).toBeNull();
    // Given all of it again.
    expect(await teams.setScope(tenantRef, ada, cy, null)).toBeNull();
    expect(await scopeOf(cy)).toBeNull();
    // A scope names at least one location or group, each a reference, in the store and the database.
    await expect(teams.setScope(tenantRef, ada, cy, { locations: [], groups: [] })).rejects.toThrow();
    const tooMany = JSON.stringify({ locations: Array.from({ length: 21 }, (_, index) => `l${String(index)}`), groups: [] });
    for (const bad of ['{"locations": []}', '{"locations": [], "groups": []}', '{"locations": ["North"], "groups": []}', '{"locations": [7], "groups": []}', '[]', tooMany]) {
      await expect(
        application`SELECT slotlock.set_member_scope(${tenantRef}::text, ${ada}::text, ${cy}::text, ${bad}::jsonb)`,
        bad,
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('withdraws an invitation whose inviter may no longer give its role', async () => {
    const tenantRef = await team(ada);
    await join(tenantRef, ada, bea, 'admin');
    const sent = await invite(tenantRef, bea, { github: eli, login: 'eli' }, 'admin');
    expect(await teams.changeRole(tenantRef, ada, bea, 'developer')).toBeNull();
    expect(await teams.accept({ tokenSha256: sent.digest, person: eli, emails: [], memberCap: null })).toEqual({ refusal: 'revoked' });
    expect(await roleIn(tenantRef, eli)).toBeNull();
    // Removing someone revokes the invitations they sent.
    await join(tenantRef, ada, cy, 'admin');
    const fromCy = await invite(tenantRef, cy, { github: fay, login: 'fay' }, 'member');
    expect(await teams.remove(tenantRef, ada, cy)).toBeNull();
    expect((await teams.preview(fromCy.digest))?.state).toBe('revoked');
    expect(await roleIn(tenantRef, cy)).toBeNull();
    expect((await teams.workspacesOf(cy)).map((ws) => ws.tenantRef)).not.toContain(tenantRef);
  });

  it('always keeps an Owner, even when two Owners demote each other at once', async () => {
    const tenantRef = await team(ada);
    expect(await teams.changeRole(tenantRef, ada, ada, 'admin')).toBe('last_owner');
    expect(await teams.remove(tenantRef, ada, ada)).toBe('last_owner');
    await join(tenantRef, ada, bea, 'owner');
    const [first, second] = await Promise.all([
      teams.changeRole(tenantRef, ada, bea, 'admin'),
      teams.changeRole(tenantRef, bea, ada, 'admin'),
    ]);
    expect([first, second].filter((refusal) => refusal === null)).toHaveLength(1);
    const owners = (await teams.members(tenantRef)).filter((member) => member.role === 'owner');
    expect(owners).toHaveLength(1);
    // The remaining Owner can't leave; once another is made Owner, they can.
    const owner = owners[0]?.person as string;
    const other = owner === ada ? bea : ada;
    expect(await teams.remove(tenantRef, owner, owner)).toBe('last_owner');
    // The demoted Admin can't promote themselves back.
    expect(await teams.changeRole(tenantRef, other, other, 'owner')).toBe('not_allowed');
    expect(await teams.changeRole(tenantRef, owner, other, 'owner')).toBeNull();
    expect(await teams.remove(tenantRef, owner, owner)).toBeNull();
    expect(await roleIn(tenantRef, owner)).toBeNull();
  });

  it('holds a workspace to its member cap, counting pending invitations', async () => {
    const tenantRef = await team(ada);
    const cap = { memberCap: 3 };
    const first = await invite(tenantRef, ada, { email: 'one@example.com' }, 'member', cap);
    expect(first.result).toHaveProperty('id');
    expect((await invite(tenantRef, ada, { email: 'two@example.com' }, 'member', cap)).result).toHaveProperty('id');
    expect((await invite(tenantRef, ada, { email: 'three@example.com' }, 'member', cap)).result).toEqual({ refusal: 'member_cap' });
    // Sending to the same address again replaces the old invitation, which then no longer works.
    const again = await invite(tenantRef, ada, { email: 'one@example.com' }, 'viewer', cap);
    expect(again.result).toHaveProperty('id');
    expect((await teams.preview(first.digest))?.state).toBe('revoked');
    expect((await teams.invitations(tenantRef)).map((sent) => sent.email).sort()).toEqual(['one@example.com', 'two@example.com']);
    // Accepting is held to the cap of members too.
    await admin`
      INSERT INTO slotlock.workspace_memberships (tenant_ref, person_ref, role, source)
      VALUES (${tenantRef}, ${kim}, 'member', 'created'), (${tenantRef}, ${jo}, 'member', 'created')`;
    expect(await teams.accept({ tokenSha256: again.digest, person: ivy, emails: ['one@example.com'], memberCap: 3 })).toEqual({ refusal: 'member_cap' });
    expect((await teams.preview(again.digest))?.state).toBe('pending');
  });

  it('holds sending to the daily limit, and a re-sent invitation drops its old token', async () => {
    // Lou has sent no invitations elsewhere: the limit counts the team's and the inviter's.
    const tenantRef = await team(lou);
    const limit = { dailyLimit: 2 };
    const first = await invite(tenantRef, lou, { email: 'a@example.com' }, 'member', limit);
    expect((await invite(tenantRef, lou, { email: 'b@example.com' }, 'member', limit)).result).toHaveProperty('id');
    expect((await invite(tenantRef, lou, { email: 'c@example.com' }, 'member', limit)).result).toEqual({ refusal: 'invitation_limit' });
    const id = (first.result as { id: string }).id;
    const fresh = token();
    expect(await teams.resend(tenantRef, lou, id, fresh.digest, 7, 2, null)).toBe('invitation_limit');
    expect(await teams.resend(tenantRef, lou, id, fresh.digest, 7, null, null)).toBeNull();
    // The old link is withdrawn, as when the same address is invited again.
    expect((await teams.preview(first.digest))?.state).toBe('revoked');
    expect(await teams.accept({ tokenSha256: first.digest, person: bea, emails: ['a@example.com'], memberCap: null })).toEqual({ refusal: 'revoked' });
    expect(await teams.accept({ tokenSha256: fresh.digest, person: bea, emails: ['a@example.com'], memberCap: null })).toEqual({ tenantRef });
  });

  it('counts each re-send as a send, so re-sending one invitation cannot pass the daily limit', async () => {
    // Re-sending made a new link, and so a new email, on the same row: the limit, which counts the
    // day's sends, never saw it, and anyone could send one address an email a request.
    const tenantRef = await team(max);
    const limit = { dailyLimit: 3 };
    const first = await invite(tenantRef, max, { email: `loop-${base}@example.com` }, 'member', limit);
    const id = (first.result as { id: string }).id;
    const resent: Array<string | null> = [];
    let current = id;
    for (let index = 0; index < 3; index += 1) {
      resent.push(await teams.resend(tenantRef, max, current, token().digest, 7, 3, null));
      current = (await teams.invitations(tenantRef))[0]?.id ?? '';
    }
    expect(resent).toEqual([null, null, 'invitation_limit']);
    // One invitation is open, whatever was re-sent.
    expect((await teams.invitations(tenantRef)).map((open) => open.email)).toEqual([`loop-${base}@example.com`]);
    expect((await invite(tenantRef, max, { email: `other-${base}@example.com` }, 'member', limit)).result).toEqual({ refusal: 'invitation_limit' });
  });

  it('sends one address at most five invitations a day, from every team together', async () => {
    // Open sign-up: many accounts, each within its own limits, could otherwise flood one inbox.
    const target = `inbox-${base}@example.com`;
    const limit = { dailyLimit: 50 };
    const ours = await team(ned);
    const theirs = await team(ola);
    const sent: unknown[] = [];
    for (const [tenantRef, inviter] of [[ours, ned], [theirs, ola], [ours, ned], [theirs, ola], [ours, ned]] as const) {
      sent.push((await invite(tenantRef, inviter, { email: target }, 'member', limit)).result);
    }
    expect(sent.every((result) => typeof (result as { id?: string }).id === 'string')).toBe(true);
    expect((await invite(theirs, ola, { email: target }, 'member', limit)).result).toEqual({ refusal: 'recipient_limit' });
    const open = (await teams.invitations(ours))[0]?.id ?? '';
    expect(await teams.resend(ours, ned, open, token().digest, 7, 50, null)).toBe('recipient_limit');
    // Another address is not held to it, and a deployment without limits is not either.
    expect((await invite(theirs, ola, { email: `someone-${base}@example.com` }, 'member', limit)).result).toHaveProperty('id');
    expect((await invite(theirs, ola, { email: target }, 'member', { dailyLimit: null })).result).toHaveProperty('id');
  });

  it("refuses an expired invitation, and prunes finished ones a month on", async () => {
    const tenantRef = await team(ada);
    const sent = await invite(tenantRef, ada, { email: 'late@example.com' }, 'member');
    const id = (sent.result as { id: string }).id;
    await admin`
      UPDATE slotlock.workspace_invitations
         SET created_at = now() - interval '40 days', sent_at = now() - interval '40 days', expires_at = now() - interval '33 days'
       WHERE id = ${id}::uuid`;
    expect((await teams.preview(sent.digest))?.state).toBe('expired');
    expect(await teams.accept({ tokenSha256: sent.digest, person: bea, emails: ['late@example.com'], memberCap: null })).toEqual({ refusal: 'expired' });
    expect(await teams.prune()).toBeGreaterThanOrEqual(1);
    expect(await teams.preview(sent.digest)).toBeNull();
  });

  it("keeps each workspace's invitations and members to itself", async () => {
    const mine = await team(ada);
    const theirs = await team(bea);
    const sent = await invite(theirs, bea, { email: 'z@example.com' }, 'member');
    const id = (sent.result as { id: string }).id;
    // Ada, Owner of hers, reaching into Bea's with Bea's invitation and people.
    expect(await teams.revoke(mine, ada, id)).toBe(false);
    expect(await teams.revoke(theirs, ada, id)).toBe(false);
    expect(await teams.resend(mine, ada, id, token().digest, 7, null, null)).toBe('not_found');
    expect(await teams.resend(theirs, ada, id, token().digest, 7, null, null)).toBe('not_allowed');
    expect(await teams.changeRole(theirs, ada, bea, 'viewer')).toBe('not_allowed');
    expect(await teams.remove(theirs, ada, bea)).toBe('not_found');
    expect((await invite(theirs, ada, { email: 'w@example.com' }, 'member')).result).toEqual({ refusal: 'not_allowed' });
    expect(await teams.invitations(mine)).toEqual([]);
    expect((await teams.preview(sent.digest))?.state).toBe('pending');
    expect(await teams.revoke(theirs, bea, id)).toBe(true);
    expect((await teams.preview(sent.digest))?.state).toBe('revoked');
  });

  it("lets an Admin revoke only the invitations whose role they could give", async () => {
    const tenantRef = await team(ada);
    await join(tenantRef, ada, bea, 'admin');
    const toOwner = await invite(tenantRef, ada, { email: 'boss@example.com' }, 'owner');
    const toBilling = await invite(tenantRef, ada, { email: 'books@example.com' }, 'billing');
    const toMember = await invite(tenantRef, ada, { email: 'desk@example.com' }, 'member');
    expect(await teams.revoke(tenantRef, bea, (toOwner.result as { id: string }).id)).toBe(false);
    expect(await teams.revoke(tenantRef, bea, (toBilling.result as { id: string }).id)).toBe(false);
    expect((await teams.preview(toOwner.digest))?.state).toBe('pending');
    expect(await teams.revoke(tenantRef, bea, (toMember.result as { id: string }).id)).toBe(true);
    expect(await teams.revoke(tenantRef, ada, (toOwner.result as { id: string }).id)).toBe(true);
  });

  it('holds sending again to the member cap, and each inviter to the daily limit across their teams', async () => {
    const tenantRef = await team(gus);
    const cap = { memberCap: 3 };
    await invite(tenantRef, gus, { email: 'x@example.com' }, 'member', cap);
    const lapsed = await invite(tenantRef, gus, { email: 'y@example.com' }, 'member', cap);
    const id = (lapsed.result as { id: string }).id;
    await admin`UPDATE slotlock.workspace_invitations SET expires_at = now() - interval '1 hour', created_at = now() - interval '8 days' WHERE id = ${id}::uuid`;
    expect((await invite(tenantRef, gus, { email: 'z@example.com' }, 'member', cap)).result).toHaveProperty('id');
    // y's lapsed invitation would make four: sending it again is refused.
    expect(await teams.resend(tenantRef, gus, id, token().digest, 7, null, 3)).toBe('member_cap');
    expect((await teams.preview(lapsed.digest))?.state).toBe('expired');
    expect(await teams.resend(tenantRef, gus, id, token().digest, 7, null, null)).toBeNull();

    // One person across two teams: the daily limit is theirs as well as each team's.
    const other = await team(gus);
    const limit = { dailyLimit: 6 };
    for (const n of [1, 2]) expect((await invite(other, gus, { email: `o${n}@example.com` }, 'member', limit)).result).toHaveProperty('id');
    // gus has sent 6 today: 2 here, and 4 in the first team, where sending y again counted.
    expect((await invite(other, gus, { email: 'o3@example.com' }, 'member', limit)).result).toEqual({ refusal: 'invitation_limit' });
  });

  it('keeps an Owner when an Owner is erased while another leaves', async () => {
    const tenantRef = await team(ivy);
    await join(tenantRef, ivy, jo, 'owner');
    await join(tenantRef, ivy, kim, 'owner');
    expect(await teams.remove(tenantRef, ivy, ivy)).toBeNull();
    // Jo's erasure holds its transaction open; Kim leaves meanwhile.
    const held = postgres(url as string, { max: 1, onnotice: () => {} });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const erasing = held.begin(async (sql) => {
      await sql`SELECT * FROM slotlock.erase_tenant(${jo}::text)`;
      await gate;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const leaving = teams.remove(tenantRef, kim, kim);
    const early = await Promise.race([leaving, new Promise((resolve) => setTimeout(() => resolve('waiting'), 500))]);
    expect(early).toBe('waiting');
    release();
    await erasing;
    await held.end();
    expect(await leaving).toBe('last_owner');
    expect((await teams.members(tenantRef)).filter((member) => member.role === 'owner').map((member) => member.person)).toEqual([kim]);
  });

  it('deletes a team seven days after an Owner asks, stops its keys at once, and lets any Owner keep it', async () => {
    const tenantRef = await team(ada);
    await join(tenantRef, ada, bea, 'owner');
    await join(tenantRef, ada, cy, 'admin');
    const handle = (await teams.info(tenantRef))?.handle as string;
    expect(await teams.scheduleDeletion(tenantRef, cy, handle)).toBe('not_allowed');
    expect(await teams.scheduleDeletion(tenantRef, ada, 'not-the-handle')).toBe('confirm');
    // A team still paying for a plan is not deleted until that is cancelled.
    await admin`
      INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints, stripe_customer, stripe_subscription)
      VALUES (${tenantRef}, 'team', 'active', 500, 100, 25, 'cus_Teamdel1', 'sub_Teamdel1')`;
    expect(await teams.scheduleDeletion(tenantRef, ada, handle)).toBe('subscription_live');
    // Cancelled in Stripe, the webhook puts it back on Free without a subscription.
    await admin`UPDATE slotlock.tenant_plans SET plan = 'free', status = 'canceled', stripe_subscription = NULL WHERE tenant_ref = ${tenantRef}`;
    expect(await teams.scheduleDeletion(tenantRef, ada, handle)).toBeNull();
    expect(await teams.isActive(tenantRef)).toBe(false);
    expect(await teams.deleteAfter(tenantRef)).toBeInstanceOf(Date);
    // Still listed for its people (an Owner keeps it from there), but nobody joins or changes meanwhile.
    expect((await teams.workspacesOf(bea)).map((ws) => ws.tenantRef)).toContain(tenantRef);
    expect((await invite(tenantRef, ada, { email: 'late@example.com' }, 'member')).result).toEqual({ refusal: 'not_found' });
    expect(await teams.cancelDeletion(tenantRef, cy)).toBe('not_allowed');
    expect(await teams.cancelDeletion(tenantRef, bea)).toBeNull();
    expect(await teams.isActive(tenantRef)).toBe(true);
    expect(await teams.deleteAfter(tenantRef)).toBeNull();
    // Asked again, and due: the sweep erases it, live and test, with its people.
    expect(await teams.scheduleDeletion(tenantRef, bea, handle)).toBeNull();
    const notDue = await store().sweepDashboardRecords();
    expect(await teams.info(tenantRef)).not.toBeNull();
    expect(notDue).toBeGreaterThanOrEqual(0);
    await admin`UPDATE slotlock.workspaces SET delete_after = now() - interval '1 minute' WHERE tenant_ref = ${tenantRef}`;
    await store().sweepDashboardRecords();
    expect(await teams.info(tenantRef)).toBeNull();
    expect(await teams.members(tenantRef)).toEqual([]);
    expect(await roleIn(tenantRef, ada)).toBeNull();
    const [plan] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.tenant_plans WHERE tenant_ref = ${tenantRef}`;
    expect(plan?.count).toBe(0);
  });

  it('never erases a team an Owner kept while the sweep was erasing another', async () => {
    const first = await team(ada);
    const second = await team(ada);
    for (const tenantRef of [first, second]) {
      expect(await teams.scheduleDeletion(tenantRef, ada, (await teams.info(tenantRef))?.handle as string)).toBeNull();
    }
    await admin`UPDATE slotlock.workspaces SET delete_after = now() - interval '2 minutes' WHERE tenant_ref = ${first}`;
    await admin`UPDATE slotlock.workspaces SET delete_after = now() - interval '1 minute' WHERE tenant_ref = ${second}`;
    // A slow erasure of the first, stood in for by its tenant's lock held elsewhere.
    const held = postgres(url as string, { max: 1, onnotice: () => {} });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = held.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`slotlock:tenant:${first}~test`}, 0))`;
      await gate;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sweeping = store().sweepDashboardRecords();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Kept while the sweep waits on the first: committed, and told so.
    expect(await teams.cancelDeletion(second, ada)).toBeNull();
    release();
    await blocking;
    await held.end();
    await sweeping;
    expect(await teams.info(first)).toBeNull();
    expect(await teams.info(second)).not.toBeNull();
    expect(await teams.isActive(second)).toBe(true);
  });

  it('is not held up by teams that cannot be erased yet', async () => {
    // Twenty-one due teams that took a subscription after asking, and one plain one due last.
    const stuck: string[] = [];
    for (let index = 0; index < 21; index++) {
      const tenantRef = await team(kim);
      stuck.push(tenantRef);
      expect(await teams.scheduleDeletion(tenantRef, kim, (await teams.info(tenantRef))?.handle as string)).toBeNull();
      await admin`
        INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints, stripe_customer, stripe_subscription)
        VALUES (${tenantRef}, 'team', 'active', 500, 100, 25, ${`cus_Stuck${String(index)}`}, ${`sub_Stuck${String(index)}`})`;
    }
    const plain = await team(kim);
    expect(await teams.scheduleDeletion(plain, kim, (await teams.info(plain))?.handle as string)).toBeNull();
    await admin`UPDATE slotlock.workspaces SET delete_after = now() - interval '1 hour' WHERE tenant_ref = ANY(${stuck})`;
    await admin`UPDATE slotlock.workspaces SET delete_after = now() - interval '1 minute' WHERE tenant_ref = ${plain}`;
    await store().sweepDashboardRecords();
    expect(await teams.info(plain)).toBeNull();
    // The ones with a subscription stay, being deleted, for when it is cancelled.
    expect(await teams.info(stuck[0] as string)).not.toBeNull();
    for (const tenantRef of stuck) await admin`UPDATE slotlock.tenant_plans SET stripe_subscription = NULL WHERE tenant_ref = ${tenantRef}`;
  });

  it("keeps team tables to their functions: the serving role can't read or write them", async () => {
    for (const table of ['workspaces', 'workspace_invitations']) {
      await expect(application.unsafe(`SELECT 1 FROM slotlock.${table} LIMIT 1`)).rejects.toMatchObject({ code: '42501' });
      await expect(application.unsafe(`DELETE FROM slotlock.${table}`)).rejects.toMatchObject({ code: '42501' });
    }
  });

  it("serves a team workspace's keys only while it exists", async () => {
    const tenantRef = await team(ada);
    let now = 0;
    const check = createSlotlockWorkspaceCheck(application, { ttlMs: 1000, now: () => now });
    expect(await check(tenantRef)).toBe(true);
    expect(await check(`${tenantRef}~test`)).toBe(true);
    expect(await check(`team:${randomUUID()}`)).toBe(false);
    expect(await check('github-org:1')).toBe(false);
    await admin`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    expect(await check(tenantRef)).toBe(true);
    now += 1001;
    expect(await check(tenantRef)).toBe(false);
    expect(await roleIn(tenantRef, ada)).toBeNull();
  });

  it('holds its invariants through random invites, joins, role changes and removals across two teams', async () => {
    // A seeded generator, so a failure replays: never zero Owners, never a role above the giver's,
    // never a member of one team acting in the other.
    let seed = 20_261_111;
    const next = (below: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % below;
    };
    const cast = [ada, bea, cy, dee, eli, fay];
    const roles = ['owner', 'admin', 'developer', 'member', 'viewer', 'billing'] as const;
    const teamsMade = [await team(ada), await team(bea)];
    const may: Record<string, readonly string[]> = {
      owner: roles,
      admin: ['admin', 'developer', 'member', 'viewer'],
    };
    for (let step = 0; step < 120; step++) {
      const tenantRef = teamsMade[next(2)] as string;
      const actor = cast[next(cast.length)] as string;
      const person = cast[next(cast.length)] as string;
      const roleName = roles[next(roles.length)] as (typeof roles)[number];
      const before = await teams.members(tenantRef);
      const actorRole = before.find((member) => member.person === actor)?.role;
      const targetRole = before.find((member) => member.person === person)?.role;
      const op = next(4);
      if (op === 0) {
        const sent = await invite(tenantRef, actor, { github: person, login: 'p' }, roleName);
        const allowed = actorRole !== undefined && (may[actorRole] ?? []).includes(roleName);
        if ('id' in sent.result) {
          expect(allowed, `step ${step}: ${actorRole} invited ${roleName}`).toBe(true);
          await teams.accept({ tokenSha256: sent.digest, person, emails: [], memberCap: null });
        } else if (targetRole === undefined) {
          expect(allowed, `step ${step}: refused ${sent.result.refusal}`).toBe(false);
        }
      } else if (op === 1) {
        const refusal = await teams.changeRole(tenantRef, actor, person, roleName);
        if (refusal === null) {
          expect(actorRole && (may[actorRole] ?? []).includes(roleName) && (may[actorRole] ?? []).includes(targetRole as string), `step ${step}`).toBeTruthy();
        }
      } else {
        const refusal = await teams.remove(tenantRef, actor, person);
        if (refusal === null && actor !== person) {
          expect(actorRole && (may[actorRole] ?? []).includes(targetRole as string), `step ${step}`).toBeTruthy();
        }
      }
      for (const checked of teamsMade) {
        const members = await teams.members(checked);
        expect(members.filter((member) => member.role === 'owner').length, `step ${step}: owners of ${checked}`).toBeGreaterThan(0);
        for (const member of members) expect(await roleIn(checked, member.person)).toBe(member.role);
      }
      // Whoever is not a member of a team has no role in it.
      for (const someone of cast) {
        for (const checked of teamsMade) {
          const listed = (await teams.members(checked)).some((member) => member.person === someone);
          if (!listed) expect(await roleIn(checked, someone)).toBeNull();
        }
      }
    }
  });

  it("won't erase a person who is a team's only Owner, and erases a team with its people and invitations", async () => {
    const tenantRef = await team(hal);
    await join(tenantRef, hal, ivy, 'member');
    const sent = await invite(tenantRef, hal, { email: 'gone@example.com' }, 'member');
    await expect(admin`SELECT * FROM slotlock.erase_tenant(${hal}::text)`).rejects.toMatchObject({ code: '55006', hint: 'sole_owner' });
    // A member is erased freely: their membership goes, the workspace stays.
    await admin`SELECT * FROM slotlock.erase_tenant(${ivy}::text)`;
    expect((await teams.members(tenantRef)).map((member) => member.person)).toEqual([hal]);
    // With another Owner, the creator can be erased, and is no longer named its creator.
    await join(tenantRef, hal, jo, 'owner');
    await admin`SELECT * FROM slotlock.erase_tenant(${hal}::text)`;
    const [kept] = await admin<{ created_by: string | null }[]>`SELECT created_by FROM slotlock.workspaces WHERE tenant_ref = ${tenantRef}`;
    expect(kept?.created_by).toBeNull();
    expect((await teams.preview(sent.digest))).toBeNull();
    await admin`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    expect(await teams.info(tenantRef)).toBeNull();
    expect(await teams.members(tenantRef)).toEqual([]);
    expect((await teams.workspacesOf(jo)).map((ws) => ws.tenantRef)).not.toContain(tenantRef);
  });
});
