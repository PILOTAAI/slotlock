// Test environments (RFC 0003 G9), against real Postgres as the serving role: `<tenant>~test` is a
// tenant of its own whose keys start slk_test_, on its live tenant's plan without billing,
// suspended with it and erased with it. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyAuthenticator, createSlotlockApiKeyStore, slotlockApiKeyDigest } from '../api-keys.js';
import { enrolSlotlockTenantPlan, readSlotlockTenantPlan, readSlotlockTenantQuotas, setSlotlockTenantPlan } from '../plans.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('test environments (real Postgres)', () => {
  const role = `slotlock_testenv_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const password = randomBytes(24).toString('hex');
  const live = `testenv-${randomUUID()}`;
  const test = `${live}~test`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;

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
  });

  afterAll(async () => {
    await admin`DELETE FROM slotlock.tenant_suspensions WHERE tenant_ref IN (${live}, ${test})`;
    await admin`UPDATE slotlock.tenant_plans SET stripe_subscription = NULL WHERE tenant_ref = ${live}`;
    await admin`SELECT * FROM slotlock.erase_tenant(${live}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('gives a test environment slk_test_ keys that act in it, and nowhere else', async () => {
    const keys = createSlotlockApiKeyStore(application);
    const made = await keys.create({ tenantRef: test, name: 'Test agent', scopes: ['read', 'write'] });
    expect(made.key).toMatch(/^slk_test_[0-9A-Za-z]{46}$/);
    expect(made.apiKey.prefix).toMatch(/^slk_test_[0-9A-Za-z]{8}$/);
    const liveKey = await keys.create({ tenantRef: live, name: 'Live agent', scopes: ['read'] });
    expect(liveKey.key).toMatch(/^slk_[0-9A-Za-z]{46}$/);
    const authenticate = createSlotlockApiKeyAuthenticator(keys);
    const bearer = (key: string) => new Request('https://example.com', { headers: { authorization: `Bearer ${key}` } });
    expect(await authenticate(bearer(made.key))).toMatchObject({ tenantRef: test });
    expect(await authenticate(bearer(liveKey.key))).toMatchObject({ tenantRef: live });
    const rotated = await keys.rotate({ tenantRef: test, id: made.apiKey.id });
    expect(rotated?.key).toMatch(/^slk_test_/);
    // The database holds the rule itself: a live prefix in a test tenant, or the reverse, is refused.
    for (const [tenantRef, prefix] of [
      [test, 'slk_AAAAAAAA'],
      [live, 'slk_test_AAAAAAAA'],
    ] as const) {
      await expect(
        application`SELECT * FROM slotlock.create_api_key(${tenantRef}::text, 'x'::text, ${prefix}::text,
          ${slotlockApiKeyDigest(randomUUID())}::bytea, ARRAY['read']::text[], NULL::timestamptz, NULL::text)`,
        tenantRef,
      ).rejects.toMatchObject({ code: '23514' });
    }
    // Their data are apart: each sees only its own resources.
    const store = createSlotlockStore(application);
    await store.withTenant(test, (scoped) => scoped.createResource({ tenantRef: test, externalRef: 'trial-room', timezone: 'UTC' }));
    expect(await store.withTenant(live, (scoped) => scoped.listResources({ tenantRef: live, limit: 10 }))).toEqual([]);
    expect(
      (await store.withTenant(test, (scoped) => scoped.listResources({ tenantRef: test, limit: 10 }))).map((found) => found.externalRef),
    ).toEqual(['trial-room']);
  });

  it("is on its live tenant's plan and quotas, without its billing", async () => {
    // Enrolling the test environment enrols the live tenant: there is one plan, the live one's.
    expect(await enrolSlotlockTenantPlan(application, test)).toBe(false);
    await setSlotlockTenantPlan(admin, {
      tenantRef: live,
      plan: 'developer',
      status: 'active',
      stripeCustomer: 'cus_TestEnv1',
      stripeSubscription: 'sub_TestEnv1',
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    expect(await readSlotlockTenantPlan(application, test)).toMatchObject({
      plan: 'developer',
      limits: { resources: 100, apiKeys: 100, webhookEndpoints: 10 },
      stripeCustomer: null,
      stripeSubscription: null,
      currentPeriodEnd: null,
    });
    expect(await readSlotlockTenantPlan(application, live)).toMatchObject({ stripeSubscription: 'sub_TestEnv1' });
    expect(await readSlotlockTenantQuotas(application, test)).toEqual(await readSlotlockTenantQuotas(application, live));
    expect(
      (await admin`SELECT count(*)::int AS n FROM slotlock.tenant_plans WHERE tenant_ref = ${test}`)[0],
    ).toEqual({ n: 0 });
  });

  it('is suspended with its live tenant, and erased with it', async () => {
    const owner = createSlotlockStore(admin);
    const store = createSlotlockStore(application);
    await owner.suspendTenant({ tenantRef: live, reason: 'review' });
    expect(await store.isTenantSuspended({ tenantRef: test })).toBe(true);
    await owner.unsuspendTenant({ tenantRef: live });
    expect(await store.isTenantSuspended({ tenantRef: test })).toBe(false);
    // Its own suspension stays its own.
    await owner.suspendTenant({ tenantRef: test, reason: 'trial abuse' });
    expect(await store.isTenantSuspended({ tenantRef: live })).toBe(false);
    await owner.unsuspendTenant({ tenantRef: test });

    const keys = createSlotlockApiKeyStore(application);
    expect((await keys.list({ tenantRef: live })).length).toBeGreaterThan(0);
    // Erasing the live tenant (its subscription cancelled first) takes the test environment too.
    await admin`UPDATE slotlock.tenant_plans SET stripe_subscription = NULL WHERE tenant_ref = ${live}`;
    const erased = await store.eraseTenant({ tenantRef: live });
    expect(erased.rows['test.resources']).toBe(1);
    expect(erased.rows['test.api_keys']).toBe(1);
    expect(await keys.list({ tenantRef: test })).toEqual([]);
    expect(await keys.list({ tenantRef: live })).toEqual([]);
  });
});
