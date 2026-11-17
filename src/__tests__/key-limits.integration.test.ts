// Keys held below the server's limits (RFC 0004 A5), against real Postgres as the LOGIN role
// grantApplicationRole grants: a key's limits are kept, listed, changed and kept through rotation,
// reach the principal it authenticates as, cap its holds, and send its bookings to a person. A role
// granted before them still authenticates keys, without limits. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invokeSlotlockAgentOperation } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { createSlotlockApiKeyAuthenticator, createSlotlockApiKeyStore } from '../api-keys.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;

describe.skipIf(!url)('key limits (real Postgres, application role)', () => {
  const role = `slotlock_klim_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenantRef = `key-limits-${randomUUID()}`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let van: string;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 3, 1);
  const at = (hour: number) => new Date(base + hour * HOUR).toISOString();

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
    van = (await store.withTenant(tenantRef, (tenant) => tenant.createResource({ tenantRef, externalRef: 'van', timezone: 'UTC' }))).id;
  });

  afterAll(async () => {
    await admin`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  const call = async (key: string, operation: string, input: Record<string, unknown>) => {
    const authenticate = createSlotlockApiKeyAuthenticator(createSlotlockApiKeyStore(application));
    const backend = createSlotlockStoreAgentBackend(store, {
      availabilityRules: async () => [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1440 }],
    });
    return invokeSlotlockAgentOperation({
      operation,
      input,
      request: new Request('https://example.com/mcp', { headers: { authorization: `Bearer ${key}` } }),
      options: { backend, authenticate, authorize: async () => true },
    }) as Promise<{ ok: boolean; code?: string; data?: Record<string, unknown>; details?: Record<string, string> }>;
  };

  it('keeps, lists, changes and rotates a key with its limits, and authenticates it with them', async () => {
    const keys = createSlotlockApiKeyStore(application);
    const made = await keys.create({
      tenantRef,
      name: 'Bounded agent',
      scopes: ['read', 'write'],
      limits: { maxHolds: 1, maxHeldHours: 48, requestsPerMinute: 30 },
    });
    expect(made.apiKey.limits).toEqual({ maxHolds: 1, maxHeldHours: 48, requestsPerMinute: 30 });
    expect((await keys.list({ tenantRef })).find(({ id }) => id === made.apiKey.id)?.limits).toEqual(made.apiKey.limits);
    const principal = await createSlotlockApiKeyAuthenticator(keys)(
      new Request('https://example.com', { headers: { authorization: `Bearer ${made.key}` } }),
    );
    expect(principal?.limits).toEqual({ maxHolds: 1, maxHeldHours: 48, requestsPerMinute: 30 });

    expect(await keys.setLimits({ tenantRef, id: made.apiKey.id, limits: { requiresApproval: true } })).toBe(true);
    const rotated = await keys.rotate({ tenantRef, id: made.apiKey.id });
    expect((await keys.authenticate(rotated?.key as string))?.limits).toEqual({ requiresApproval: true });
    // None at all is the server's again.
    expect(await keys.setLimits({ tenantRef, id: made.apiKey.id, limits: {} })).toBe(true);
    expect((await keys.authenticate(rotated?.key as string))?.limits).toBeUndefined();
    await expect(keys.setLimits({ tenantRef, id: made.apiKey.id, limits: { maxHolds: 0 } })).rejects.toMatchObject({
      code: 'invalid_api_key_limits',
    });
    // Another tenant's key, or a revoked one, is not set.
    expect(await keys.setLimits({ tenantRef: `${tenantRef}-other`, id: made.apiKey.id, limits: { maxHolds: 2 } })).toBe(false);
    await keys.revoke({ tenantRef, id: made.apiKey.id });
    expect(await keys.setLimits({ tenantRef, id: made.apiKey.id, limits: { maxHolds: 2 } })).toBe(false);
  });

  it("caps a key's live holds below the server's", async () => {
    const { key } = await createSlotlockApiKeyStore(application).create({
      tenantRef,
      name: 'One hold',
      scopes: ['read', 'write'],
      limits: { maxHolds: 1 },
    });
    const hold = (start: number) =>
      call(key, 'slotlock_hold_slots', {
        slots: [{ resource_id: van, start: at(start), end: at(start + 1) }],
        ttl_seconds: 300,
        idempotency_key: `h-${randomUUID()}`,
      });
    const first = await hold(9);
    expect((first.data?.holds as unknown[]).length).toBe(1);
    const second = await hold(11);
    expect(second.data?.holds).toEqual([]);
    expect(second.data?.refused).toMatchObject([{ index: 0, code: 'hold_limit_reached' }]);
  });

  it("sends every booking by a key that requires approval to a person", async () => {
    const { key } = await createSlotlockApiKeyStore(application).create({
      tenantRef,
      name: 'Needs approval',
      scopes: ['read', 'write'],
      limits: { requiresApproval: true },
    });
    const asked = await call(key, 'slotlock_create_event', {
      resource_id: van,
      starts_at: at(14),
      ends_at: at(15),
      timezone: 'UTC',
      idempotency_key: `a-${randomUUID()}`,
    });
    expect(asked).toMatchObject({ ok: false, code: 'approval_pending', details: { policy_ref: 'api-key' } });
    // A tenant cannot name a policy of its own after it.
    await expect(
      store.withTenant(tenantRef, (tenant) =>
        tenant.putApprovalPolicy({ tenantRef, ref: 'api-key', name: 'Mine', outcome: 'refuse' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_approval_policy' });
  });

  it('authenticates keys, without limits, for a role granted before them', async () => {
    const keys = createSlotlockApiKeyStore(application);
    const { key, apiKey } = await keys.create({ tenantRef, name: 'Old grant', scopes: ['read'], limits: { maxHolds: 3 } });
    await admin.unsafe(`REVOKE EXECUTE ON FUNCTION slotlock.authenticate_limited_api_key(bytea) FROM ${role}`);
    await admin.unsafe(`REVOKE EXECUTE ON FUNCTION slotlock.list_api_key_limits(text) FROM ${role}`);
    try {
      const fresh = createSlotlockApiKeyStore(application);
      expect(await fresh.authenticate(key)).toMatchObject({ id: apiKey.id, tenantRef, scopes: ['read'] });
      expect((await fresh.authenticate(key))?.limits).toBeUndefined();
      expect((await fresh.list({ tenantRef })).find(({ id }) => id === apiKey.id)?.limits).toBeUndefined();
    } finally {
      await admin.unsafe(`GRANT EXECUTE ON FUNCTION slotlock.authenticate_limited_api_key(bytea) TO ${role}`);
      await admin.unsafe(`GRANT EXECUTE ON FUNCTION slotlock.list_api_key_limits(text) TO ${role}`);
    }
  });
});
