// The sandbox (RFC 0004 A6) against real Postgres as the LOGIN role grantApplicationRole grants:
// a test environment seeded with each scenario, raced, moved forward and emptied, its keys kept,
// and a live tenant refused at every step. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invokeSlotlockAgentOperation } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import {
  SLOTLOCK_SANDBOX_SCENARIOS,
  fastForwardSlotlockSandbox,
  raceSlotlockSandbox,
  resetSlotlockSandbox,
  seedSlotlockSandbox,
} from '../sandbox.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('the sandbox (real Postgres, application role)', () => {
  const role = `slotlock_sbx_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const live = `sandbox-${randomUUID()}`;
  const test = `${live}~test`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const backend = () =>
    createSlotlockStoreAgentBackend(store, {
      availabilityRules: async () => [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1440 }],
    });

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, {
      max: 20,
      onnotice: () => {},
    });
    store = createSlotlockStore(application);
  });

  afterAll(async () => {
    for (const tenant of [test, live]) await admin`SELECT * FROM slotlock.erase_tenant(${tenant}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('refuses a live tenant at every step', async () => {
    await expect(seedSlotlockSandbox(store, live, 'clinic')).rejects.toMatchObject({ code: 'sandbox_test_only' });
    await expect(resetSlotlockSandbox(store, live)).rejects.toMatchObject({ code: 'sandbox_test_only' });
    await expect(fastForwardSlotlockSandbox(store, live, 60)).rejects.toMatchObject({ code: 'sandbox_test_only' });
    // The database refuses too, whatever the caller: a live tenant, or one it does not act in.
    await expect(
      store.withTenant(live, () => application`SELECT * FROM slotlock.reset_test_tenant(${live}::text)`),
    ).rejects.toThrow(/only a test environment/);
    await expect(
      store.withTenant(live, () => application`SELECT * FROM slotlock.reset_test_tenant(${test}::text)`),
    ).rejects.toThrow(/only the tenant the caller acts in/);
  });

  it('seeds each scenario, refuses seeding over one, and empties it again with its keys kept', async () => {
    const keys = createSlotlockApiKeyStore(application);
    const key = await keys.create({ tenantRef: test, name: 'Sandbox agent', scopes: ['read', 'write'] });
    for (const scenario of SLOTLOCK_SANDBOX_SCENARIOS) {
      const seeded = await seedSlotlockSandbox(store, test, scenario);
      expect(seeded.resources).toBeGreaterThan(3);
      expect(seeded.bookings).toBe(3);
      const resources = await store.withTenant(test, (tenant) => tenant.listResources({ tenantRef: test, limit: 100 }));
      expect(resources).toHaveLength(seeded.resources);
      expect(resources.every((resource) => resource.availabilityRules !== undefined && resource.name)).toBe(true);
      await expect(seedSlotlockSandbox(store, test, scenario)).rejects.toMatchObject({ code: 'sandbox_not_empty' });
      const reset = await resetSlotlockSandbox(store, test);
      expect(reset.resources).toBe(seeded.resources);
      expect(reset.reservations).toBeGreaterThanOrEqual(3);
      expect(await store.withTenant(test, (tenant) => tenant.countResources({ tenantRef: test }))).toBe(0);
      expect(await store.withTenant(test, (tenant) => tenant.listLocations({ tenantRef: test }))).toEqual([]);
    }
    // The key outlives every reset.
    expect((await keys.authenticate(key.key))?.tenantRef).toBe(test);
  });

  it('races agents for one slot: one books it, the rest are refused with alternatives', async () => {
    await seedSlotlockSandbox(store, test, 'car-rental');
    const [car] = await store.withTenant(test, (tenant) => tenant.listResources({ tenantRef: test, limit: 100 }));
    const start = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 2, 3, 10));
    const result = await raceSlotlockSandbox({
      backend: backend(),
      tenantRef: test,
      resourceId: car?.id as string,
      start,
      end: new Date(start.getTime() + 3_600_000),
      agents: 40,
    });
    expect(result).toMatchObject({ agents: 40, booked: 1, refused: { overlap: 39 }, withAlternatives: 39, serverErrors: 0 });
    await expect(
      raceSlotlockSandbox({ backend: backend(), tenantRef: live, resourceId: car?.id as string, start, end: start }),
    ).rejects.toMatchObject({ code: 'sandbox_test_only' });
    await resetSlotlockSandbox(store, test);
  });

  it('moves waiting forward: holds and approvals that would lapse lapse now, and maintenance reaps them', async () => {
    await seedSlotlockSandbox(store, test, 'desks');
    const [desk] = await store.withTenant(test, (tenant) => tenant.listResources({ tenantRef: test, limit: 100 }));
    const start = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 4, 5, 10));
    const held = await invokeSlotlockAgentOperation({
      operation: 'slotlock_hold_slots',
      input: {
        slots: [{ resource_id: desk?.id, start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString() }],
        ttl_seconds: 600,
        idempotency_key: `ff-${randomUUID()}`,
      },
      request: new Request('https://example.com'),
      options: {
        backend: backend(),
        authenticate: async () => ({ subject: 'sandbox-agent', tenantRef: test, scopes: ['read', 'write'] }),
        authorize: async () => true,
      },
    });
    expect(held.ok).toBe(true);
    // Five minutes is not enough for a ten-minute hold; fifteen is.
    expect((await fastForwardSlotlockSandbox(store, test, 5)).holds).toBe(0);
    const forward = await fastForwardSlotlockSandbox(store, test, 15);
    expect(forward.holds).toBe(1);
    const left = await store.withTenant(test, (tenant) => tenant.listHolds({ tenantRef: test, resourceId: desk?.id as string }));
    expect(left).toEqual([]);
    await resetSlotlockSandbox(store, test);
  });
});
