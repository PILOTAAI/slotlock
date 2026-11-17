// The change history as an audit log (RFC 0004 D2), as the LOGIN role grantApplicationRole grants:
// the serving role adds changes and reads them but never changes or deletes one; pruning goes
// through slotlock.prune_changes and keeps each plan's days (30 Free, 90 Developer, 400 Team); the
// workspace audit log keeps 180 days, or Team's 400; and the one edit the history allows, taking a
// person out, writes nothing but an erased- name. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLOTLOCK_TENANT_CONTEXT_SETTING } from '../ddl.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const DAY = 86_400_000;

describe.skipIf(!url)('the change history (real Postgres)', () => {
  const role = `slotlock_hr_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenants: string[] = [];
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenant = () => {
    const ref = `history-${randomUUID()}`;
    tenants.push(ref);
    return ref;
  };
  /** As the serving role, in the tenant's context. */
  const asTenant = <T>(tenantRef: string, run: (tx: postgres.TransactionSql) => Promise<T>) =>
    application.begin(async (tx) => {
      await tx`SELECT set_config(${SLOTLOCK_TENANT_CONTEXT_SETTING}, ${tenantRef}, true)`;
      return run(tx);
    }) as Promise<T>;
  /** Changes written oldest first, one each this many days ago. */
  const changes = async (tenantRef: string, ages: number[]) => {
    for (const age of ages) {
      await admin`
        INSERT INTO slotlock.outbox (tenant_ref, type, subject, data, occurred_at)
        VALUES (${tenantRef}, 'reservation.created', ${`age-${age}`}, '{}'::jsonb, ${new Date(Date.now() - age * DAY)})`;
    }
  };
  const kept = async (tenantRef: string) =>
    (await admin<{ subject: string }[]>`SELECT subject FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} ORDER BY id`).map(
      (row) => row.subject,
    );
  const plan = (tenantRef: string, name: string, status = 'active') =>
    admin`SELECT slotlock.set_tenant_plan(${tenantRef}::text, ${name}::text, ${status}::text, 500, 100, 25, NULL, NULL, NULL)`;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(application);
  });

  afterAll(async () => {
    for (const ref of tenants) {
      await admin`DELETE FROM slotlock.tenant_plans WHERE tenant_ref = ${ref}`;
      await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    }
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('lets the serving role add and read changes, never change or delete one', async () => {
    const tenantRef = tenant();
    await asTenant(tenantRef, (tx) => tx`
      INSERT INTO slotlock.outbox (tenant_ref, type, subject, data) VALUES (${tenantRef}, 'reservation.created', 'mine', '{}'::jsonb)`);
    expect(await asTenant(tenantRef, (tx) => tx`SELECT subject FROM slotlock.outbox WHERE tenant_ref = ${tenantRef}`)).toHaveLength(1);
    for (const edit of [
      (tx: postgres.TransactionSql) => tx`UPDATE slotlock.outbox SET data = '{"changed":true}'::jsonb WHERE tenant_ref = ${tenantRef}`,
      (tx: postgres.TransactionSql) => tx`DELETE FROM slotlock.outbox WHERE tenant_ref = ${tenantRef}`,
      (tx: postgres.TransactionSql) => tx`TRUNCATE slotlock.outbox`,
    ]) {
      await expect(asTenant(tenantRef, edit)).rejects.toMatchObject({ code: '42501' });
    }
    expect(await kept(tenantRef)).toEqual(['mine']);
  });

  it("prunes through slotlock.prune_changes, keeping the store's days or the plan's if longer", async () => {
    const cases: [string | null, string, string[]][] = [
      [null, 'active', ['age-10']],
      ['free', 'active', ['age-10']],
      ['developer', 'active', ['age-60', 'age-10']],
      ['team', 'active', ['age-200', 'age-60', 'age-10']],
      // A cancelled plan keeps Free's.
      ['team', 'canceled', ['age-10']],
    ];
    for (const [name, status, expected] of cases) {
      const tenantRef = tenant();
      if (name) await plan(tenantRef, name, status);
      await changes(tenantRef, [500, 200, 60, 10]);
      const pruned = await store.withTenant(tenantRef, (scope) => scope.pruneChanges({ tenantRef, limit: 1_000 }));
      expect({ name, status, kept: await kept(tenantRef) }).toEqual({ name, status, kept: expected });
      expect(pruned).toBe(4 - expected.length);
    }
    // A serving role cannot ask for less than the plan keeps, or for no history at all.
    const team = tenant();
    await plan(team, 'team');
    await changes(team, [200, 10]);
    expect(await asTenant(team, (tx) => tx`SELECT slotlock.prune_changes(${team}::text, 1000, 1) AS pruned`)).toEqual([{ pruned: 0 }]);
    await expect(asTenant(team, (tx) => tx`SELECT slotlock.prune_changes(${team}::text, 1000, 0)`)).rejects.toMatchObject({
      code: '22023',
    });
    // Only the tenant the caller acts in.
    const other = tenant();
    await changes(other, [500]);
    await expect(asTenant(team, (tx) => tx`SELECT slotlock.prune_changes(${other}::text, 1000, 1)`)).rejects.toMatchObject({
      code: '42501',
    });
    expect(await kept(other)).toEqual(['age-500']);
  });

  it('keeps the workspace audit log 180 days, or 400 on Team', async () => {
    for (const [name, expected] of [
      ['free', 1],
      ['team', 2],
    ] as const) {
      const tenantRef = tenant();
      await plan(tenantRef, name);
      for (let index = 0; index < 2; index++) {
        await store.withTenant(tenantRef, (scope) =>
          scope.recordAuditEvent({ tenantRef, event: { action: 'api_key.created', actorType: 'person', actorRef: 'github:1' } }),
        );
      }
      await admin`UPDATE slotlock.audit_events SET occurred_at = now() - interval '200 days'
                   WHERE tenant_ref = ${tenantRef} AND chain_index = 1`;
      await store.withTenant(tenantRef, (scope) => scope.pruneAuditEvents({ tenantRef }));
      const [left] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM slotlock.audit_events WHERE tenant_ref = ${tenantRef}`;
      expect({ name, left: left?.n }).toEqual({ name, left: expected });
    }
  });

  it('takes a person out of the history, writing nothing but an erased- name', async () => {
    const tenantRef = tenant();
    await admin`
      INSERT INTO slotlock.outbox (tenant_ref, type, subject, data)
      VALUES (${tenantRef}, 'waitlist.joined', 'entry', '{"holder_ref":"holder-ada","pool":"vans"}'::jsonb)`;
    const erase = (replacement: string) =>
      asTenant(tenantRef, (tx) => tx`SELECT slotlock.erase_subject_changes(${tenantRef}::text, 'holder', 'holder-ada', ${replacement}::text) AS changed`);
    for (const refused of ['Someone else', 'erased-', `erased-${'g'.repeat(32)}`]) {
      await expect(erase(refused)).rejects.toMatchObject({ code: '22023' });
    }
    const name = `erased-${randomBytes(16).toString('hex')}`;
    // Only the tenant the caller acts in.
    const other = tenant();
    await expect(
      asTenant(other, (tx) => tx`SELECT slotlock.erase_subject_changes(${tenantRef}::text, 'holder', 'holder-ada', ${name}::text)`),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await erase(name)).toEqual([{ changed: 1 }]);
    const [change] = await admin<{ data: Record<string, unknown> }[]>`SELECT data FROM slotlock.outbox WHERE tenant_ref = ${tenantRef}`;
    expect(change?.data).toEqual({ holder_ref: name, pool: 'vans' });
  });
});
