// Verified domains and joining a team by one (workspace-domains.ts, ddl-identity.ts), as the LOGIN
// role grantApplicationRole grants, with resolvers the test controls: a domain verifies only on its
// own claim's record, stays verified only while the record stays, lapses (and cannot be revived
// with its old token) when it goes, and is held by one team at a time; the people at a verified
// domain may ask to join, or join as a Viewer, and never more without an Owner or Admin.
// Skipped without DATABASE_URL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockDnsResolver, type SlotlockTxtAnswer, slotlockDomainRecord } from '../domains.js';
import { createSlotlockStore } from '../store.js';
import { type SlotlockWorkspaceDomains, runSlotlockDomainChecks } from '../workspace-domains.js';
import { type SlotlockWorkspaceTeams, createSlotlockDashboardWorkspaces } from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

/** A resolver answering from a map the test writes: name → values, or an error. */
function fakeResolver(name: string) {
  const records = new Map<string, string[] | 'servfail'>();
  const resolver: SlotlockDnsResolver = {
    name,
    async txt(host): Promise<SlotlockTxtAnswer> {
      const found = records.get(host);
      if (found === 'servfail') return { status: 'error', reason: 'status 2' };
      if (found === undefined) return { status: 'nxdomain', ad: false };
      return { status: 'ok', values: [...found], ad: false, ttl: 300 };
    },
  };
  return { resolver, records };
}

describe.skipIf(!url)('verified domains and joining by them (real Postgres)', () => {
  const role = `slotlock_vd_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const base = 700_000_000 + Math.floor(Math.random() * 90_000_000);
  const people = Array.from({ length: 12 }, (_, index) => `github:${base + index}`);
  const [ada, bea, cy, dee, eli, fay, gus, hal] = people as [string, string, string, string, string, string, string, string];
  const created: string[] = [];
  const suffix = base.toString(36);
  let domainSeq = 0;
  /** A domain no other run uses. */
  const fresh = () => `acme-${suffix}-${(domainSeq++).toString(36)}.com`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let teams: SlotlockWorkspaceTeams;
  let domains: SlotlockWorkspaceDomains;
  const primary = fakeResolver('primary');
  const secondary = fakeResolver('secondary');
  const both = [primary.resolver, secondary.resolver];
  let handleSeq = 0;

  const team = async (owner: string) => {
    const made = await teams.create(owner, 'Acme rentals', `d${suffix}-${(handleSeq++).toString(36)}`, null);
    if (!('tenantRef' in made)) throw new Error(`create refused: ${made.refusal}`);
    created.push(made.tenantRef);
    return made.tenantRef;
  };
  const addMember = async (tenantRef: string, owner: string, person: string, roleName: 'admin' | 'developer' | 'member' | 'viewer') => {
    const raw = randomBytes(32);
    const digest = createHash('sha256').update(raw).digest();
    const sent = await teams.invite({ tenantRef, inviter: owner, to: { github: person, login: `p${person.slice(7)}` }, role: roleName, tokenSha256: digest, days: 7, dailyLimit: null, memberCap: null });
    expect(sent).toHaveProperty('id');
    expect(await teams.accept({ tokenSha256: digest, person, emails: [], memberCap: null })).toEqual({ tenantRef });
  };
  const publish = (domain: string, token: string, where: 'both' | 'primary' | 'secondary' = 'both') => {
    const { name, value } = slotlockDomainRecord(domain, token);
    for (const target of where === 'both' ? [primary, secondary] : where === 'primary' ? [primary] : [secondary]) {
      const values = target.records.get(name);
      target.records.set(name, [...(Array.isArray(values) ? values : []), value]);
    }
  };
  const unpublish = (domain: string) => {
    const name = slotlockDomainRecord(domain, 'x').name;
    primary.records.delete(name);
    secondary.records.delete(name);
  };
  const claimed = async (tenantRef: string, owner: string, domain: string) => {
    const claim = await domains.claim(tenantRef, owner, domain);
    if (!('id' in claim)) throw new Error(`claim refused: ${claim.refusal}`);
    const listed = (await domains.list(tenantRef)).find((row) => row.id === claim.id);
    if (!listed) throw new Error('claim not listed');
    return listed;
  };
  /** Let a minute pass for "Verify now", and a day for the daily check, by moving the claim's clock back. */
  const age = (id: string, column: 'last_checked_at' | 'missing_since' | 'lapse_after' | 'created_at', by: string) =>
    admin.unsafe(`UPDATE slotlock.workspace_domains SET ${column} = ${column} - interval '${by}' WHERE id = $1`, [id]);
  const verifiedTeam = async (owner: string) => {
    const tenantRef = await team(owner);
    const domain = fresh();
    const claim = await claimed(tenantRef, owner, domain);
    publish(domain, claim.token);
    expect((await domains.verifyNow(tenantRef, owner, claim.id, both)).outcome).toBe('verified');
    return { tenantRef, domain, id: claim.id };
  };

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
    domains = workspaces.domains as SlotlockWorkspaceDomains;
    for (const person of people) await workspaces.signedIn(person, []);
  });

  afterAll(async () => {
    for (const ref of created) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    for (const ref of people) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("claims only real, ownable domains, by the team's Owner, each once", async () => {
    const tenantRef = await team(ada);
    await addMember(tenantRef, ada, bea, 'admin');
    const domain = fresh();
    expect(await domains.claim(tenantRef, bea, domain)).toEqual({ refusal: 'not_allowed' });
    for (const [typed, refusal] of [
      ['gmail.com', 'consumer_domain'],
      ['GMAIL.COM.', 'consumer_domain'],
      ['co.uk', 'public_suffix'],
      ['github.io', 'public_suffix'],
      ['workers.dev', 'public_suffix'],
      ['example..com', 'invalid_domain'],
      ['10.0.0.1', 'invalid_domain'],
      ['localhost', 'invalid_domain'],
      ['someone@acme.com', 'invalid_domain'],
    ] as const) {
      expect(await domains.claim(tenantRef, ada, typed), typed).toEqual({ refusal });
    }
    const claim = await claimed(tenantRef, ada, ` ${domain.toUpperCase()}. `);
    expect(claim).toMatchObject({ ascii: domain, unicode: domain, status: 'pending', expired: false, joinPolicy: 'request' });
    expect(claim.token).toMatch(/^[a-z2-7]{26}$/);
    expect(await domains.claim(tenantRef, ada, domain)).toEqual({ refusal: 'already_claimed' });
    // An internationalised name is keyed by its punycode and shown as typed.
    const idn = await claimed(tenantRef, ada, `bücher-${suffix}.de`);
    expect(idn.ascii).toMatch(/^xn--/);
    expect(idn.unicode).toBe(`bücher-${suffix}.de`);
  });

  it("verifies only on the claim's own token, and one team holds a domain at a time", async () => {
    const a = await team(ada);
    const b = await team(cy);
    const domain = fresh();
    const claimA = await claimed(a, ada, domain);
    const claimB = await claimed(b, cy, domain);
    expect(claimA.token).not.toBe(claimB.token);
    publish(domain, claimA.token);
    expect((await domains.verifyNow(b, cy, claimB.id, both)).outcome).toBe('absent');
    expect((await domains.verifyNow(a, ada, claimA.id, both)).outcome).toBe('verified');
    // B publishes its own record too: the domain is A's, and B learns only that it is taken.
    publish(domain, claimB.token);
    await age(claimB.id, 'last_checked_at', '2 minutes');
    expect((await domains.verifyNow(b, cy, claimB.id, both)).outcome).toBe('domain_taken');
    const c = await team(dee);
    expect(await domains.claim(c, dee, domain)).toEqual({ refusal: 'domain_taken' });
    // A record holding the token inside a longer value, or a suffix of it, is not the record.
    const near = fresh();
    const claimNear = await claimed(a, ada, near);
    const { name, value } = slotlockDomainRecord(near, claimNear.token);
    primary.records.set(name, [`${value}x`, `x${value}`, `v=spf1 include:${value} -all`]);
    secondary.records.set(name, [`${value}x`]);
    expect((await domains.verifyNow(a, ada, claimNear.id, both)).outcome).toBe('absent');
  });

  it('lets exactly one of two teams verify a domain when both check at once', async () => {
    const domain = fresh();
    const pairs = await Promise.all([ada, cy].map(async (owner) => {
      const tenantRef = await team(owner);
      const claim = await claimed(tenantRef, owner, domain);
      publish(domain, claim.token);
      return { tenantRef, owner, claim };
    }));
    const outcomes = await Promise.all(pairs.map(({ tenantRef, owner, claim }) => domains.verifyNow(tenantRef, owner, claim.id, both)));
    expect(outcomes.map((found) => found.outcome).sort()).toEqual(['domain_taken', 'verified']);
  });

  it('stays verified while the record stays, lapses when it goes, and never comes back on the old token', async () => {
    const { tenantRef, domain, id } = await verifiedTeam(ada);
    const token = (await domains.list(tenantRef)).find((row) => row.id === id)?.token as string;
    const daily = async () => {
      await age(id, 'last_checked_at', '1 day 1 minute');
      return (await domains.checkDue(both, 500)).find((found) => found.domainId === id)?.outcome;
    };
    expect(await daily()).toBe('seen');
    // One resolver loses it (the first, whose word verifies): nothing changes while the other has it.
    primary.records.delete(slotlockDomainRecord(domain, token).name);
    expect(await daily()).toBe('unchanged');
    // Both lose it: missing, then a day later lapsing, with a new token.
    unpublish(domain);
    expect(await daily()).toBe('missing');
    expect((await domains.list(tenantRef)).find((row) => row.id === id)?.status).toBe('verified');
    await age(id, 'missing_since', '1 day');
    expect(await daily()).toBe('lapsing');
    const lapsing = (await domains.list(tenantRef)).find((row) => row.id === id);
    expect(lapsing).toMatchObject({ status: 'lapsing' });
    expect(lapsing?.token).not.toBe(token);
    // Whoever holds the domain next republishes the old record from DNS history: it restores nothing.
    publish(domain, token);
    expect(await daily()).toBe('unchanged');
    // The team publishes the new one: verified again.
    publish(domain, lapsing?.token as string);
    expect(await daily()).toBe('restored');
    // Gone again, past the fourteen days: lapsed, and free for another team.
    unpublish(domain);
    expect(await daily()).toBe('missing');
    await age(id, 'missing_since', '1 day');
    expect(await daily()).toBe('lapsing');
    await age(id, 'lapse_after', '15 days');
    expect((await domains.checkDue(both, 500)).find((found) => found.domainId === id)?.outcome).toBe('lapsed');
    expect((await domains.list(tenantRef)).some((row) => row.id === id)).toBe(false);
    const next = await team(cy);
    const claim = await claimed(next, cy, domain);
    publish(domain, claim.token);
    expect((await domains.verifyNow(next, cy, claim.id, both)).outcome).toBe('verified');
  });

  it("records each change the daily check makes in the team's audit log, as Slotlock's", async () => {
    const { tenantRef, domain, id } = await verifiedTeam(ada);
    const recorded: { tenantRef: string; action: string; actorType: string; metadata: unknown }[] = [];
    const record = async (team: string, event: { action: string; actorType: string; metadata?: Record<string, unknown> }) => {
      recorded.push({ tenantRef: team, action: event.action, actorType: event.actorType, metadata: event.metadata });
    };
    const run = async () => {
      await admin`UPDATE slotlock.workspace_domains SET last_checked_at = now() - interval '25 hours' WHERE id = ${id}`;
      await runSlotlockDomainChecks({ domains, resolvers: both, record, limit: 500 });
    };
    await run();
    unpublish(domain);
    await run();
    await run();
    await age(id, 'missing_since', '1 day');
    await run();
    const mine = recorded.filter((event) => event.tenantRef === tenantRef).map((event) => event.action);
    // Seen changes nothing; the first absence and the lapse are recorded once each.
    expect(mine).toEqual(['domain.record_missing', 'domain.lapsing']);
    const lapsing = recorded.find((event) => event.action === 'domain.lapsing');
    expect(lapsing?.actorType).toBe('system');
    expect(lapsing?.metadata).toMatchObject({ domain, resolvers: [{ resolver: 'primary', verdict: 'absent' }, { resolver: 'secondary', verdict: 'absent' }] });
  });

  it('never lapses on resolver errors, however long they last', async () => {
    const { domain, id } = await verifiedTeam(ada);
    const name = slotlockDomainRecord(domain, 'x').name;
    primary.records.set(name, 'servfail');
    secondary.records.set(name, 'servfail');
    for (let day = 0; day < 3; day++) {
      await admin`UPDATE slotlock.workspace_domains SET last_checked_at = now() - interval '25 hours', missing_since = now() - interval '20 days' WHERE id = ${id}`;
      await admin`UPDATE slotlock.workspace_domains SET missing_since = NULL WHERE id = ${id}`;
      expect((await domains.checkDue(both, 500)).find((found) => found.domainId === id)?.outcome).toBe('error');
    }
    const [row] = await admin<{ status: string; error_since: Date | null }[]>`SELECT status, error_since FROM slotlock.workspace_domains WHERE id = ${id}`;
    expect(row?.status).toBe('verified');
    expect(row?.error_since).not.toBeNull();
  });

  it('lets a claim verify for seven days only, then claims it afresh with a new token', async () => {
    const tenantRef = await team(ada);
    const domain = fresh();
    const claim = await claimed(tenantRef, ada, domain);
    await age(claim.id, 'created_at', '8 days');
    publish(domain, claim.token);
    expect((await domains.verifyNow(tenantRef, ada, claim.id, both)).outcome).toBe('expired');
    const again = await claimed(tenantRef, ada, domain);
    expect(again.id).toBe(claim.id);
    expect(again.token).not.toBe(claim.token);
    expect(again.expired).toBe(false);
  });

  it("checks at an Owner's asking at most once a minute, and only for an Owner", async () => {
    const tenantRef = await team(ada);
    await addMember(tenantRef, ada, bea, 'admin');
    const claim = await claimed(tenantRef, ada, fresh());
    expect((await domains.verifyNow(tenantRef, ada, claim.id, both)).outcome).toBe('absent');
    expect((await domains.verifyNow(tenantRef, ada, claim.id, both)).outcome).toBe('too_soon');
    await age(claim.id, 'last_checked_at', '2 minutes');
    expect((await domains.verifyNow(tenantRef, bea, claim.id, both)).outcome).toBe('not_allowed');
    // Another team's claim is not found from this one.
    const other = await team(cy);
    expect((await domains.verifyNow(other, cy, claim.id, both)).outcome).toBe('not_found');
  });

  it('holds invitations to the verified domains when the Owner says so', async () => {
    const tenantRef = await team(ada);
    expect(await domains.restrictInvites(tenantRef, ada, true)).toBe('no_verified_domain');
    const domain = fresh();
    const claim = await claimed(tenantRef, ada, domain);
    publish(domain, claim.token);
    expect((await domains.verifyNow(tenantRef, ada, claim.id, both)).outcome).toBe('verified');
    await addMember(tenantRef, ada, bea, 'admin');
    expect(await domains.restrictInvites(tenantRef, bea, true)).toBe('not_allowed');
    expect(await domains.restrictInvites(tenantRef, ada, true)).toBeNull();
    expect(await domains.invitesRestricted(tenantRef)).toBe(true);
    const sendTo = (to: { email: string } | { github: string; login: string }) =>
      teams.invite({ tenantRef, inviter: ada, to, role: 'member', tokenSha256: randomBytes(32), days: 7, dailyLimit: null, memberCap: null });
    expect(await sendTo({ email: 'x@elsewhere-example.org' })).toEqual({ refusal: 'domain_restricted' });
    expect(await sendTo({ github: cy, login: 'cy' })).toEqual({ refusal: 'domain_restricted' });
    expect(await sendTo({ email: `desk@${domain}` })).toHaveProperty('id');
    // The last verified domain stays while invitations are held to it.
    expect(await domains.release(tenantRef, ada, claim.id)).toBe('restricted');
    expect(await domains.restrictInvites(tenantRef, ada, false)).toBeNull();
    expect(await domains.release(tenantRef, ada, claim.id)).toBeNull();
    expect(await sendTo({ email: 'x@elsewhere-example.org' })).toHaveProperty('id');
  });

  it('lets people at a verified domain ask to join, and an Owner or Admin decide, never above Developer', async () => {
    const { tenantRef, domain } = await verifiedTeam(ada);
    await addMember(tenantRef, ada, bea, 'admin');
    await addMember(tenantRef, ada, cy, 'member');
    const at = [`Dee@${domain.toUpperCase()}`];
    // Discovery: exactly the domain, verified addresses only (the caller passes only those).
    expect(await domains.discoverable(dee, [`dee@sub.${domain}`])).toEqual([]);
    expect(await domains.discoverable(dee, ['dee@gmail.com'])).toEqual([]);
    const [found] = await domains.discoverable(dee, at);
    expect(found).toMatchObject({ tenantRef, joinPolicy: 'request', requested: false, name: 'Acme rentals' });
    expect(await domains.requestToJoin(tenantRef, dee, [`dee@sub.${domain}`], null)).toEqual({ refusal: 'not_found' });
    expect(await domains.requestToJoin(tenantRef, dee, at, null)).toEqual({ outcome: 'requested' });
    expect(await domains.requestToJoin(tenantRef, dee, at, null)).toEqual({ refusal: 'pending' });
    expect((await domains.discoverable(dee, at))[0]?.requested).toBe(true);
    const [request] = await domains.requests(tenantRef);
    expect(request).toMatchObject({ person: dee, email: `dee@${domain}`, domain });
    const id = request?.id as string;
    // A Member cannot decide; nobody approves above Developer; another team cannot see it.
    expect((await domains.decide({ tenantRef, actor: cy, id, decision: 'approve', role: 'viewer', memberCap: null })).refusal).toBe('not_allowed');
    expect((await domains.decide({ tenantRef, actor: ada, id, decision: 'approve', role: 'admin', memberCap: null })).refusal).toBe('role_not_allowed');
    expect((await domains.decide({ tenantRef, actor: ada, id, decision: 'approve', role: 'owner', memberCap: null })).refusal).toBe('role_not_allowed');
    expect((await domains.decide({ tenantRef, actor: ada, id, decision: 'approve', role: 'billing', memberCap: null })).refusal).toBe('role_not_allowed');
    const other = await team(hal);
    expect((await domains.decide({ tenantRef: other, actor: hal, id, decision: 'approve', role: 'viewer', memberCap: null })).refusal).toBe('not_found');
    expect(await domains.decide({ tenantRef, actor: bea, id, decision: 'approve', role: 'developer', memberCap: null })).toEqual({ person: dee, refusal: null });
    expect((await createSlotlockDashboardWorkspaces(application).standing(tenantRef, dee)).role).toBe('developer');
    expect((await domains.domainMembers(tenantRef)).get(dee)).toEqual({ domain, status: 'verified' });
    expect(await domains.discoverable(dee, at)).toEqual([]);
    expect(await domains.requestToJoin(tenantRef, dee, at, null)).toEqual({ refusal: 'already_member' });
    // Declined: no membership.
    expect(await domains.requestToJoin(tenantRef, eli, [`eli@${domain}`], null)).toEqual({ outcome: 'requested' });
    const eliRequest = (await domains.requests(tenantRef)).find((row) => row.person === eli)?.id as string;
    expect(await domains.decide({ tenantRef, actor: ada, id: eliRequest, decision: 'decline', role: null, memberCap: null })).toEqual({ person: eli, refusal: null });
    expect((await createSlotlockDashboardWorkspaces(application).standing(tenantRef, eli)).role).toBeNull();
  });

  it('joins at once as a Viewer where the domain says so, once however many race, and asks again after a removal', async () => {
    const { tenantRef, domain, id } = await verifiedTeam(ada);
    expect(await domains.setJoinPolicy(tenantRef, ada, id, 'auto')).toBeNull();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => domains.requestToJoin(tenantRef, fay, [`fay@${domain}`], null)));
    expect(outcomes.filter((result) => 'outcome' in result && result.outcome === 'joined')).toHaveLength(1);
    expect((await createSlotlockDashboardWorkspaces(application).standing(tenantRef, fay)).role).toBe('viewer');
    // Removed by an Owner, the person cannot rejoin at once: they ask, and wait.
    expect(await teams.remove(tenantRef, ada, fay)).toBeNull();
    expect(await domains.requestToJoin(tenantRef, fay, [`fay@${domain}`], null)).toEqual({ outcome: 'requested' });
    expect((await createSlotlockDashboardWorkspaces(application).standing(tenantRef, fay)).role).toBeNull();
    // At the member cap (here 2: Ada and one more), joining is refused.
    expect(await domains.requestToJoin(tenantRef, gus, [`gus@${domain}`], 2)).toEqual({ outcome: 'joined' });
    expect(await domains.requestToJoin(tenantRef, hal, [`hal@${domain}`], 2)).toEqual({ refusal: 'member_cap' });
    // Off: not discoverable, and the waiting requests are withdrawn.
    expect(await domains.setJoinPolicy(tenantRef, ada, id, 'off')).toBeNull();
    expect(await domains.discoverable(hal, [`hal@${domain}`])).toEqual([]);
    expect(await domains.requests(tenantRef)).toEqual([]);
  });

  it('refuses approval once the domain lapses, and a request past its seven days', async () => {
    const { tenantRef, domain, id } = await verifiedTeam(ada);
    expect(await domains.requestToJoin(tenantRef, bea, [`bea@${domain}`], null)).toEqual({ outcome: 'requested' });
    expect(await domains.requestToJoin(tenantRef, cy, [`cy@${domain}`], null)).toEqual({ outcome: 'requested' });
    const [first, second] = await domains.requests(tenantRef);
    await admin`UPDATE slotlock.workspace_join_requests SET created_at = created_at - interval '8 days', expires_at = expires_at - interval '8 days' WHERE id = ${second?.id as string}`;
    expect((await domains.decide({ tenantRef, actor: ada, id: second?.id as string, decision: 'approve', role: 'viewer', memberCap: null })).refusal).toBe('expired');
    // Lapsing: no discovery, no new request, no approval.
    unpublish(domain);
    await admin`UPDATE slotlock.workspace_domains SET status = 'lapsing', lapse_after = now() + interval '14 days' WHERE id = ${id}`;
    expect(await domains.discoverable(dee, [`dee@${domain}`])).toEqual([]);
    expect(await domains.requestToJoin(tenantRef, dee, [`dee@${domain}`], null)).toEqual({ refusal: 'not_found' });
    expect((await domains.decide({ tenantRef, actor: ada, id: first?.id as string, decision: 'approve', role: 'viewer', memberCap: null })).refusal).toBe('domain_not_verified');
  });

  it('takes domains and requests with an erased team, and a person off them with an erased person', async () => {
    const { tenantRef, domain } = await verifiedTeam(ada);
    expect(await domains.requestToJoin(tenantRef, eli, [`eli@${domain}`], null)).toEqual({ outcome: 'requested' });
    // Eli is erased: their request goes; Ada's claim stays the team's, without her name on it.
    await admin`SELECT * FROM slotlock.erase_tenant(${eli}::text)`;
    expect(await domains.requests(tenantRef)).toEqual([]);
    const erased = await admin<{ erased_table: string; erased_rows: string }[]>`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    expect(Number(erased.find((row) => row.erased_table === 'workspace_domains')?.erased_rows)).toBe(1);
    const [left] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.workspace_domains WHERE domain_ascii = ${domain}`;
    expect(left?.count).toBe(0);
  });

  it('keeps the tables out of the serving role\'s reach but for the functions', async () => {
    for (const table of ['workspace_domains', 'workspace_join_requests']) {
      await expect(application.unsafe(`SELECT * FROM slotlock.${table}`)).rejects.toThrow(/permission denied/);
    }
  });
});
