// The audit log's chain (slotlock.chain_audit_event, verify_audit_chain), as the LOGIN role
// grantApplicationRole grants: each event numbered and hashed over the one before it, in the order
// written however many write at once; a change made outside Slotlock found where it was made; and
// retention removing only the start of the chain. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('the audit chain (real Postgres)', () => {
  const role = `slotlock_ac_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenants: string[] = [];
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenant = () => {
    const ref = `github:${String(400_000_000 + Math.floor(Math.random() * 99_999_999))}`;
    tenants.push(ref);
    return ref;
  };
  const record = (tenantRef: string, action = 'api_key.created') =>
    store.withTenant(tenantRef, (scope) =>
      scope.recordAuditEvent({ tenantRef, event: { action, actorType: 'person', actorRef: tenantRef, metadata: { n: 1 } } }),
    );
  const verify = (tenantRef: string) => store.withTenant(tenantRef, (scope) => scope.verifyAuditChain({ tenantRef }));
  const chain = (tenantRef: string) =>
    admin<{ chain_index: string; prev_hash: Buffer | null; hash: Buffer }[]>`
      SELECT chain_index, prev_hash, hash FROM slotlock.audit_events WHERE tenant_ref = ${tenantRef} ORDER BY chain_index`;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(application);
  });

  afterAll(async () => {
    for (const ref of tenants) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`.catch(() => undefined);
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('numbers and links every event in the order written, even when 20 are written at once', async () => {
    const tenantRef = tenant();
    await Promise.all(Array.from({ length: 20 }, () => record(tenantRef)));
    const rows = await chain(tenantRef);
    expect(rows.map((row) => Number(row.chain_index))).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(rows[0]?.prev_hash).toBeNull();
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index]?.prev_hash?.equals(rows[index - 1]?.hash as Buffer), `link ${index + 1}`).toBe(true);
    }
    expect(await verify(tenantRef)).toEqual({ checked: 20, brokenAt: null });
    // Each tenant has its own chain.
    const other = tenant();
    await record(other);
    expect((await chain(other)).map((row) => Number(row.chain_index))).toEqual([1]);
    // The event as listed carries its place and hash.
    const [latest] = await store.withTenant(tenantRef, (scope) => scope.listAuditEvents({ tenantRef, limit: 1 }));
    expect(latest?.chainIndex).toBe(20);
    expect(latest?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('finds an event changed, or removed, outside Slotlock', async () => {
    const changed = tenant();
    for (let index = 0; index < 5; index++) await record(changed);
    await admin`UPDATE slotlock.audit_events SET metadata = '{"n":2}' WHERE tenant_ref = ${changed} AND chain_index = 3`;
    expect(await verify(changed)).toEqual({ checked: 2, brokenAt: 3 });

    const removed = tenant();
    for (let index = 0; index < 5; index++) await record(removed);
    await admin`DELETE FROM slotlock.audit_events WHERE tenant_ref = ${removed} AND chain_index = 2`;
    expect(await verify(removed)).toEqual({ checked: 1, brokenAt: 3 });

    // Rehashing the changed event alone does not hide it: the next one no longer links to it.
    const rehashed = tenant();
    for (let index = 0; index < 4; index++) await record(rehashed);
    await admin`
      UPDATE slotlock.audit_events changed SET metadata = '{"n":3}',
             hash = sha256(coalesce(changed.prev_hash, ''::bytea)
                           || convert_to(slotlock.audit_event_text((SELECT e FROM slotlock.audit_events e WHERE e.id = changed.id)), 'UTF8'))
       WHERE tenant_ref = ${rehashed} AND chain_index = 2`;
    const found = await verify(rehashed);
    expect(found.brokenAt).not.toBeNull();
    expect(found.brokenAt).toBeLessThanOrEqual(3);
  });

  it('prunes only the start of the chain, so what is kept still verifies', async () => {
    const tenantRef = tenant();
    for (let index = 0; index < 6; index++) await record(tenantRef);
    // The first three are past retention; the fourth was written later but stamped earlier still.
    await admin`
      UPDATE slotlock.audit_events SET occurred_at = now() - interval '200 days'
       WHERE tenant_ref = ${tenantRef} AND chain_index IN (1, 2, 4)`;
    // Moving occurred_at breaks those hashes; what matters is what is left after pruning.
    expect(await store.withTenant(tenantRef, (scope) => scope.pruneAuditEvents({ tenantRef }))).toBe(4);
    expect((await chain(tenantRef)).map((row) => Number(row.chain_index))).toEqual([5, 6]);
    expect(await verify(tenantRef)).toEqual({ checked: 2, brokenAt: null });
  });
});
