// Hosted plans (plans.ts): a tenant's plan caps its resources, active API keys and webhook
// endpoints, as the LOGIN role grantApplicationRole grants; a tenant with no plan keeps the server's
// limits; erasure removes the plan. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import {
  SLOTLOCK_PLAN_LIMITS,
  enrolSlotlockTenantPlan,
  readSlotlockPlanDefault,
  readSlotlockTenantPlan,
  setSlotlockPlanDefault,
  setSlotlockTenantPlan,
} from '../plans.js';
import { type SlotlockStore, type SlotlockTenantStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('hosted plans (real Postgres, application role)', () => {
  const role = `slotlock_plans_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const free = `plans-free-${randomUUID()}`;
  const unplanned = `plans-none-${randomUUID()}`;
  /** Tenants the later tests make, erased after. */
  const others: string[] = [];
  const another = (name: string) => {
    const ref = `plans-${name}-${randomUUID()}`;
    others.push(ref);
    return ref;
  };
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
    await setSlotlockPlanDefault(admin, null).catch(() => undefined);
    for (const ref of [free, unplanned, ...others]) {
      await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    }
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

  // The default is the deployment's, for every tenant: each test sets it and removes it again.
  it('puts every tenant without a plan on the default once it applies, through every path', async () => {
    const legacy = another('legacy');
    for (let i = 0; i < SLOTLOCK_PLAN_LIMITS.free.resources; i++) await resource(legacy);
    // Only the deployment role sets it.
    await expect(
      setSlotlockPlanDefault(application, { plan: 'free', appliesFrom: new Date() }),
    ).rejects.toMatchObject({ code: 'plan_default_not_permitted' });
    try {
      await setSlotlockPlanDefault(admin, { plan: 'free', appliesFrom: new Date(Date.now() - 1_000) });
      expect(await readSlotlockPlanDefault(application)).toMatchObject({
        plan: 'free',
        limits: SLOTLOCK_PLAN_LIMITS.free,
      });
      // No row of its own, and the store (as slotlock serve writes) refuses the eleventh resource.
      expect(await readSlotlockTenantPlan(application, legacy)).toMatchObject({
        plan: 'free',
        status: 'active',
        stripeSubscription: null,
        limits: SLOTLOCK_PLAN_LIMITS.free,
      });
      await expect(resource(legacy)).rejects.toMatchObject({ code: 'resource_limit_reached', limit: 10 });
      for (let i = 0; i < SLOTLOCK_PLAN_LIMITS.free.webhookEndpoints; i++) await webhook(legacy);
      expect(await webhook(legacy)).toMatchObject({ ok: false, code: 'webhook_limit_reached', limit: 2 });
      for (let i = 0; i < SLOTLOCK_PLAN_LIMITS.free.apiKeys; i++) await key(legacy);
      await expect(key(legacy)).rejects.toMatchObject({ code: 'api_key_limit_reached' });
      // A plan of its own wins over the default.
      await setSlotlockTenantPlan(application, {
        tenantRef: legacy,
        plan: 'developer',
        status: 'active',
        stripeCustomer: 'cus_Legacy1',
        stripeSubscription: 'sub_Legacy1',
      });
      await resource(legacy);
      await setSlotlockTenantPlan(application, { tenantRef: legacy, plan: 'free', status: 'canceled' });
    } finally {
      await setSlotlockPlanDefault(admin, null);
    }
    expect(await readSlotlockPlanDefault(application)).toBeNull();
    expect(await readSlotlockTenantPlan(application, unplanned)).toBeNull();
  });

  it('puts a new tenant on a default not yet in force, and leaves existing tenants until it is', async () => {
    const fresh = another('fresh');
    const keyed = another('keyed');
    const stocked = another('stocked');
    await key(keyed);
    await resource(stocked);
    try {
      await setSlotlockPlanDefault(admin, {
        plan: 'free',
        appliesFrom: new Date(Date.now() + 30 * 86_400_000),
      });
      expect(await readSlotlockTenantPlan(application, fresh)).toBeNull();
      expect(await enrolSlotlockTenantPlan(application, fresh)).toBe(true);
      expect(await enrolSlotlockTenantPlan(application, fresh)).toBe(false);
      expect(await readSlotlockTenantPlan(application, fresh)).toMatchObject({
        plan: 'free',
        limits: SLOTLOCK_PLAN_LIMITS.free,
      });
      // Tenants with a key or anything in their feed were told of the date, and keep their limits.
      expect(await enrolSlotlockTenantPlan(application, keyed)).toBe(false);
      expect(await enrolSlotlockTenantPlan(application, stocked)).toBe(false);
      expect(await readSlotlockTenantPlan(application, keyed)).toBeNull();
      expect(await readSlotlockTenantPlan(application, stocked)).toBeNull();
      // Once the date has passed, the default applies to them, and enrolling writes nothing.
      await setSlotlockPlanDefault(admin, { plan: 'free', appliesFrom: new Date(Date.now() - 1_000) });
      expect(await readSlotlockTenantPlan(application, stocked)).toMatchObject({ plan: 'free' });
      expect(await enrolSlotlockTenantPlan(application, another('late'))).toBe(false);
    } finally {
      await setSlotlockPlanDefault(admin, null);
    }
    // Without a default, enrolling never writes a plan.
    expect(await enrolSlotlockTenantPlan(application, another('none'))).toBe(false);
  });

  it('erases a tenant only once its paid plan is cancelled', async () => {
    const paying = another('paying');
    await resource(paying);
    await setSlotlockTenantPlan(application, {
      tenantRef: paying,
      plan: 'developer',
      status: 'past_due',
      stripeCustomer: 'cus_Paying1',
      stripeSubscription: 'sub_Paying1',
    });
    await expect(store.eraseTenant({ tenantRef: paying })).rejects.toMatchObject({
      code: 'billing_active',
    });
    expect(await as(paying, (scoped) => scoped.countResources({ tenantRef: paying }))).toBe(1);
    // Stripe's webhook moves it to Free when the subscription ends; then erasure runs.
    await setSlotlockTenantPlan(application, { tenantRef: paying, plan: 'free', status: 'canceled' });
    expect((await store.eraseTenant({ tenantRef: paying })).rows).toMatchObject({ tenant_plans: 1 });
    expect(await readSlotlockTenantPlan(application, paying)).toBeNull();
  });

  it('counts archived resources as the limit does', async () => {
    const archiving = another('archiving');
    const first = await resource(archiving);
    await resource(archiving);
    await as(archiving, (scoped) => scoped.archiveResource({ tenantRef: archiving, id: first.id }));
    expect(await as(archiving, (scoped) => scoped.listResources({ tenantRef: archiving }))).toHaveLength(1);
    expect(await as(archiving, (scoped) => scoped.countResources({ tenantRef: archiving }))).toBe(2);
  });
});
