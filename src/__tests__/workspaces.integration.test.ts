// Who belongs to which workspace, and as what, as the database keeps it (workspaces.ts) and the
// audit log beside it, as the LOGIN role grantApplicationRole grants: memberships reached only
// through their functions, the audit log only added to and read, each tenant's to itself. Skipped
// without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { createSlotlockDashboardWorkspaces } from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('workspace memberships and the audit log (real Postgres)', () => {
  const role = `slotlock_ws_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const uid = String(700_000_000 + Math.floor(Math.random() * 99_999_999));
  const person = `github:${uid}`;
  const org = String(800_000_000 + Math.floor(Math.random() * 99_999_999));
  const other = String(Number(org) + 1);
  const third = String(Number(org) + 2);
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  /** The store's audit methods, inside the tenant's transaction as every caller runs them. */
  const audit = {
    record: (tenantRef: string, event: Parameters<SlotlockStore['recordAuditEvent']>[0]['event']) =>
      store.withTenant(tenantRef, (tenant) => tenant.recordAuditEvent({ tenantRef, event })),
    list: (tenantRef: string, params: { action?: string } = {}) =>
      store.withTenant(tenantRef, (tenant) => tenant.listAuditEvents({ tenantRef, ...params })),
    prune: (tenantRef: string) => store.withTenant(tenantRef, (tenant) => tenant.pruneAuditEvents({ tenantRef })),
  };

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, {
      max: 4,
      onnotice: () => {},
    });
    store = createSlotlockStore(application);
  });

  afterAll(async () => {
    for (const ref of [person, `github-org:${org}`, `github-org:${other}`, `github-org:${third}`, 'github-org:1', 'github-org:2']) {
      await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    }
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("records a sign-in, and GitHub's organizations as memberships: owners Owner, members Developer", async () => {
    const workspaces = createSlotlockDashboardWorkspaces(application);
    const epoch = await workspaces.signedIn(person, [
      { id: org, role: 'admin' },
      { id: other, role: 'member' },
    ]);
    expect(epoch).toBeGreaterThan(0);
    expect(await workspaces.standing(`github-org:${org}`, person)).toEqual({ role: 'owner', sessionEpoch: epoch });
    expect(await workspaces.standing(`github-org:${other}`, person)).toEqual({ role: 'developer', sessionEpoch: epoch });
    // The test environment has the live workspace's members; one's own workspace is one's own.
    expect((await workspaces.standing(`github-org:${other}~test`, person)).role).toBe('developer');
    expect((await workspaces.standing(person, person)).role).toBe('owner');
    expect((await workspaces.standing(`${person}~test`, person)).role).toBe('owner');
    // Nobody else is a member, and nobody is Owner of another's workspace.
    expect((await workspaces.standing(`github-org:${org}`, 'github:1')).role).toBeNull();
    expect((await workspaces.standing(person, 'github:1')).role).toBeNull();
  });

  it('ends a membership GitHub no longer lists, and never changes a role given in Slotlock', async () => {
    const workspaces = createSlotlockDashboardWorkspaces(application);
    await admin`
      INSERT INTO slotlock.workspace_memberships (tenant_ref, person_ref, role, source)
      VALUES (${`github-org:${third}`}, ${person}, 'viewer', 'created')`;
    await workspaces.signedIn(person, [
      { id: org, role: 'member' },
      { id: third, role: 'admin' },
    ]);
    expect((await workspaces.standing(`github-org:${org}`, person)).role).toBe('developer');
    expect((await workspaces.standing(`github-org:${other}`, person)).role).toBeNull();
    expect((await workspaces.standing(`github-org:${third}`, person)).role).toBe('viewer');
    const [row] = await admin<{ status: string; deactivated: boolean }[]>`
      SELECT status, deactivated_at IS NOT NULL AS deactivated FROM slotlock.workspace_memberships
       WHERE tenant_ref = ${`github-org:${other}`} AND person_ref = ${person}`;
    // Kept, inactive, so being added back restores the role.
    expect(row).toEqual({ status: 'inactive', deactivated: true });
    await workspaces.signedIn(person, [{ id: other, role: 'member' }]);
    expect((await workspaces.standing(`github-org:${other}`, person)).role).toBe('developer');
  });

  it('signs a person out everywhere by drawing a new epoch, and an erased person has none', async () => {
    const workspaces = createSlotlockDashboardWorkspaces(application);
    const before = (await workspaces.standing(person, person)).sessionEpoch;
    expect(before).toBeGreaterThan(0);
    const after = await workspaces.signOutEverywhere(person);
    expect(after).not.toBe(before);
    expect((await workspaces.standing(person, person)).sessionEpoch).toBe(after);
    expect(await workspaces.signedIn(person)).toBe(after);
    // Erased, the person has no epoch, so no session of theirs passes; signing in again draws afresh.
    const someone = `github:${Number(uid) + 7}`;
    const first = await workspaces.signedIn(someone);
    await store.eraseTenant({ tenantRef: someone });
    expect((await workspaces.standing(someone, someone)).sessionEpoch).toBeNull();
    expect((await workspaces.standing('github:9', 'github:9')).sessionEpoch).toBeNull();
    const again = await workspaces.signedIn(someone);
    expect(again).toBeGreaterThan(0);
    expect(again).not.toBe(first);
  });

  it('refuses a malformed person or organization list in the database itself', async () => {
    await expect(application`SELECT slotlock.dashboard_sign_in('evil', NULL)`).rejects.toMatchObject({ code: '22023' });
    await expect(
      application`SELECT slotlock.dashboard_sign_in(${person}, ${JSON.stringify([{ id: org, role: 'owner' }])})`,
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      application`SELECT slotlock.dashboard_sign_in('google:abc', ${JSON.stringify([{ id: org, role: 'admin' }])})`,
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('keeps the serving role off the membership tables: no role is read or written but through the functions', async () => {
    await expect(application`SELECT * FROM slotlock.workspace_memberships`).rejects.toMatchObject({ code: '42501' });
    await expect(
      application`INSERT INTO slotlock.workspace_memberships (tenant_ref, person_ref, role, source)
                  VALUES ('github-org:1', 'github:1', 'owner', 'created')`,
    ).rejects.toMatchObject({ code: '42501' });
    await expect(application`UPDATE slotlock.dashboard_people SET session_epoch = 0`).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps each tenant to its own audit log, which the serving role only adds to and reads', async () => {
    const a = 'github-org:1';
    const b = 'github-org:2';
    await audit.record(a, { action: 'api_key.created', actorType: 'person', actorRef: person, actorRole: 'owner', metadata: { access: 'full' } });
    await audit.record(b, {
      action: 'authz.denied',
      actorType: 'person',
      actorRef: person,
      actorRole: 'developer',
      outcome: 'denied',
      reason: 'needs keys.full',
    });
    const own = await audit.list(a);
    expect(own.map((event) => event.action)).toEqual(['api_key.created']);
    expect(own[0]).toMatchObject({ actorRef: person, actorRole: 'owner', outcome: 'success', metadata: { access: 'full' } });
    expect((await audit.list(b, { action: 'authz.denied' }))[0]?.outcome).toBe('denied');
    // As the serving role, under forced row-level security: another tenant's rows are not there to
    // read, and none of its own can be changed or removed.
    const asTenant = <T>(tenant: string, work: (tx: postgres.TransactionSql) => Promise<T>) =>
      application.begin(async (tx) => {
        await tx`SELECT set_config('slotlock.tenant_ref', ${tenant}, true)`;
        return work(tx);
      });
    expect(await asTenant(a, (tx) => tx`SELECT action FROM slotlock.audit_events WHERE tenant_ref = ${b}`)).toHaveLength(0);
    await expect(
      asTenant(a, (tx) => tx`INSERT INTO slotlock.audit_events (tenant_ref, action, actor_type, actor_ref) VALUES (${b}, 'api_key.created', 'person', ${person})`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asTenant(a, (tx) => tx`UPDATE slotlock.audit_events SET action = 'api_key.revoked'`)).rejects.toMatchObject({ code: '42501' });
    await expect(asTenant(a, (tx) => tx`DELETE FROM slotlock.audit_events`)).rejects.toMatchObject({ code: '42501' });
    await expect(asTenant(a, (tx) => tx`TRUNCATE slotlock.audit_events`)).rejects.toMatchObject({ code: '42501' });
    expect(await audit.list(a)).toHaveLength(1);
  });

  it('prunes only the events past retention, and only the tenant asked', async () => {
    const a = 'github-org:1';
    await admin`
      INSERT INTO slotlock.audit_events (tenant_ref, occurred_at, action, actor_type, actor_ref)
      VALUES (${a}, now() - interval '181 days', 'webhook.created', 'person', ${person}),
             ('github-org:2', now() - interval '181 days', 'webhook.created', 'person', ${person})`;
    expect(await audit.prune(a)).toBe(1);
    expect((await audit.list(a)).map((event) => event.action)).toEqual(['api_key.created']);
    const [left] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock.audit_events WHERE tenant_ref = 'github-org:2' AND action = 'webhook.created'`;
    expect(left?.count).toBe(1);
  });

  it("erases a workspace's members with it, and a person's memberships and sign-ins with them", async () => {
    const workspaces = createSlotlockDashboardWorkspaces(application);
    const someone = `github:${Number(uid) + 1}`;
    await workspaces.signedIn(someone, [{ id: org, role: 'member' }]);
    const erasedOrg = await store.eraseTenant({ tenantRef: `github-org:${org}` });
    expect(erasedOrg.rows.workspace_memberships).toBeGreaterThanOrEqual(2);
    expect((await workspaces.standing(`github-org:${org}`, someone)).role).toBeNull();
    await workspaces.signedIn(someone, [{ id: other, role: 'member' }]);
    const erasedPerson = await store.eraseTenant({ tenantRef: someone });
    expect(erasedPerson.rows.workspace_memberships).toBe(1);
    expect(erasedPerson.rows.dashboard_people).toBe(1);
    expect((await workspaces.standing(`github-org:${other}`, someone)).role).toBeNull();
  });

  it('pins the search path of every SECURITY DEFINER function and grants PUBLIC none of them', async () => {
    const functions = await admin<{ name: string; config: string[] | null; publicly: boolean }[]>`
      SELECT p.oid::regprocedure::text AS name, p.proconfig AS config,
             EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                      WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS publicly
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'slotlock' AND p.prosecdef`;
    expect(functions.length).toBeGreaterThan(20);
    for (const fn of functions) {
      expect(fn.config?.some((setting) => setting.startsWith('search_path=')), fn.name).toBe(true);
      expect(fn.publicly, fn.name).toBe(false);
    }
  });
});
