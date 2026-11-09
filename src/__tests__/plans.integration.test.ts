// Hosted plans (plans.ts): a tenant's plan caps its resources, active API keys and webhook
// endpoints, as the LOGIN role grantApplicationRole grants; a tenant with no plan keeps the server's
// limits; erasure removes the plan. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { SLOTLOCK_PLAN_LIMITS, readSlotlockTenantPlan, setSlotlockTenantPlan } from '../plans.js';
import { type SlotlockStore, type SlotlockTenantStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('hosted plans (real Postgres, application role)', () => {
  const role = `slotlock_plans_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const free = `plans-free-${randomUUID()}`;
  const unplanned = `plans-none-${randomUUID()}`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;

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
    for (const ref of [free, unplanned]) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  const as = <T>(tenantRef: string, run: (scoped: SlotlockTenantStore) => Promise<T>) =>
    store.withTenant(tenantRef, run, { isolation: 'read committed' });
  const resource = (tenantRef: string) =>
    as(tenantRef, (scoped) =>
      scoped.createResource({ tenantRef, externalRef: `van-${randomUUID()}`, timezone: 'UTC' }),
    );
  const webhook = (tenantRef: string) =>
    as(tenantRef, (scoped) =>
      scoped.createWebhookEndpoint({ tenantRef, url: `https://example.com/hooks/${randomUUID()}` }),
    );
  const key = (tenantRef: string) =>
    createSlotlockApiKeyStore(application).create({ tenantRef, name: 'agent', scopes: ['read'] });

  it('holds a Free tenant to the Free limits, and lifts them on Developer', async () => {
    await setSlotlockTenantPlan(application, { tenantRef: free, plan: 'free', status: 'active' });
    expect(await readSlotlockTenantPlan(application, free)).toMatchObject({
      plan: 'free',
      status: 'active',
      limits: SLOTLOCK_PLAN_LIMITS.free,
      stripeCustomer: null,
    });

    for (let i = 0; i < SLOTLOCK_PLAN_LIMITS.free.resources; i++) await resource(free);
    await expect(resource(free)).rejects.toMatchObject({
      code: 'resource_limit_reached',
      limit: SLOTLOCK_PLAN_LIMITS.free.resources,
    });

    for (let i = 0; i < SLOTLOCK_PLAN_LIMITS.free.webhookEndpoints; i++) {
      expect(await webhook(free)).toMatchObject({ ok: true });
    }
    expect(await webhook(free)).toEqual({
      ok: false,
      code: 'webhook_limit_reached',
      limit: SLOTLOCK_PLAN_LIMITS.free.webhookEndpoints,
    });

    for (let i = 0; i < SLOTLOCK_PLAN_LIMITS.free.apiKeys; i++) await key(free);
    await expect(key(free)).rejects.toMatchObject({ code: 'api_key_limit_reached' });

    await setSlotlockTenantPlan(application, {
      tenantRef: free,
      plan: 'developer',
      status: 'active',
      stripeCustomer: 'cus_Test123',
      stripeSubscription: 'sub_Test123',
      currentPeriodEnd: new Date('2027-01-01T00:00:00Z'),
    });
    await resource(free);
    expect(await webhook(free)).toMatchObject({ ok: true });
    await key(free);
    expect(await readSlotlockTenantPlan(application, free)).toMatchObject({
      plan: 'developer',
      limits: SLOTLOCK_PLAN_LIMITS.developer,
      stripeCustomer: 'cus_Test123',
      stripeSubscription: 'sub_Test123',
    });

    // Cancelled: back to Free, the customer kept for a later checkout. Nothing is deleted.
    await setSlotlockTenantPlan(application, { tenantRef: free, plan: 'free', status: 'canceled' });
    expect(await readSlotlockTenantPlan(application, free)).toMatchObject({
      plan: 'free',
      status: 'canceled',
      stripeCustomer: 'cus_Test123',
      stripeSubscription: null,
    });
    await expect(resource(free)).rejects.toMatchObject({ code: 'resource_limit_reached' });
  });

  it('leaves a tenant with no plan on the server limits', async () => {
    expect(await readSlotlockTenantPlan(application, unplanned)).toBeNull();
    for (let i = 0; i <= SLOTLOCK_PLAN_LIMITS.free.resources; i++) await resource(unplanned);
    for (let i = 0; i <= SLOTLOCK_PLAN_LIMITS.free.webhookEndpoints; i++) {
      expect(await webhook(unplanned)).toMatchObject({ ok: true });
    }
  });

  it('keeps the plan table out of the serving role, and erases the plan with the tenant', async () => {
    await expect(application`SELECT * FROM slotlock.tenant_plans`).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      setSlotlockTenantPlan(application, {
        tenantRef: free,
        plan: 'developer',
        status: 'active',
        stripeCustomer: 'not-a-customer',
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await admin`SELECT * FROM slotlock.erase_tenant(${free}::text)`;
    expect(await readSlotlockTenantPlan(application, free)).toBeNull();
  });
});
