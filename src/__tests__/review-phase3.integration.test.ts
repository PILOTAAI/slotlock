// What the adversarial review of teams phase 3 broke, held shut against real PostgreSQL as the
// LOGIN role grantApplicationRole grants: a device signed out stays signed out however many sign-ins
// follow; the serving role cannot back-date an event to have retention take recent ones; and an
// event taken off the chain shows. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLOTLOCK_TENANT_CONTEXT_SETTING } from '../ddl.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { type SlotlockDashboardSessions, createSlotlockDashboardWorkspaces } from '../workspaces.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('sessions and the audit chain, as the review attacked them (real Postgres)', () => {
  const role = `slotlock_r3_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const person = `github:${String(300_000_000 + Math.floor(Math.random() * 99_999_999))}`;
  const tenants: string[] = [person];
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let sessions: SlotlockDashboardSessions;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(application);
    const workspaces = createSlotlockDashboardWorkspaces(application);
    await workspaces.signedIn(person, []);
    sessions = workspaces.sessions as SlotlockDashboardSessions;
  });

  afterAll(async () => {
    for (const ref of tenants) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('keeps a session signed out from another device out, however many sign-ins follow', async () => {
    const expires = new Date(Date.now() + 12 * 3_600_000);
    const stolen = randomBytes(24).toString('base64url');
    await sessions.started(person, stolen, expires, {});
    expect(await sessions.seen(person, stolen)).toBe(true);
    expect(await sessions.end(person, sessions.idOf(stolen))).toBe(true);
    expect(await sessions.seen(person, stolen)).toBe(false);
    // Fifty-one sign-ins later its record has gone: it stays out all the same.
    for (let index = 0; index < 51; index++) await sessions.started(person, randomBytes(24).toString('base64url'), expires, {});
    const [kept] = await admin<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock.dashboard_sessions WHERE sid_sha256 = sha256(convert_to(${stolen}, 'UTF8'))`;
    expect(kept?.count).toBe(0);
    expect(await sessions.seen(person, stolen)).toBe(false);
    // A session never recorded (made up, or another person's) does not pass either.
    expect(await sessions.seen(person, randomBytes(24).toString('base64url'))).toBe(false);
  });

  it("stamps each event's time itself, so the serving role cannot back-date one to have recent ones pruned", async () => {
    const tenantRef = `github:${String(310_000_000 + Math.floor(Math.random() * 9_999_999))}`;
    tenants.push(tenantRef);
    for (let index = 0; index < 5; index++) {
      await store.withTenant(tenantRef, (scope) =>
        scope.recordAuditEvent({ tenantRef, event: { action: 'api_key.created', actorType: 'person', actorRef: tenantRef } }),
      );
    }
    // The serving role writes an event of its own, dated in 2000.
    await application.begin(async (sql) => {
      await sql`SELECT set_config(${SLOTLOCK_TENANT_CONTEXT_SETTING}, ${tenantRef}, true)`;
      await sql`
        INSERT INTO slotlock.audit_events (tenant_ref, occurred_at, action, actor_type, actor_ref)
        VALUES (${tenantRef}, '2000-01-01', 'api_key.created', 'person', ${tenantRef})`;
    });
    const [oldest] = await admin<{ occurred_at: Date }[]>`
      SELECT min(occurred_at) AS occurred_at FROM slotlock.audit_events WHERE tenant_ref = ${tenantRef}`;
    expect((oldest?.occurred_at as Date).getUTCFullYear()).toBeGreaterThan(2020);
    expect(await store.withTenant(tenantRef, (scope) => scope.pruneAuditEvents({ tenantRef }))).toBe(0);
    expect((await store.withTenant(tenantRef, (scope) => scope.verifyAuditChain({ tenantRef }))).brokenAt).toBeNull();
  });

  it('finds an event taken off the chain', async () => {
    const tenantRef = `github:${String(320_000_000 + Math.floor(Math.random() * 9_999_999))}`;
    tenants.push(tenantRef);
    for (let index = 0; index < 5; index++) {
      await store.withTenant(tenantRef, (scope) =>
        scope.recordAuditEvent({ tenantRef, event: { action: 'api_key.created', actorType: 'person', actorRef: tenantRef } }),
      );
    }
    await admin`UPDATE slotlock.audit_events SET chain_index = NULL WHERE tenant_ref = ${tenantRef} AND chain_index >= 4`;
    expect((await store.withTenant(tenantRef, (scope) => scope.verifyAuditChain({ tenantRef }))).brokenAt).not.toBeNull();
  });
});
