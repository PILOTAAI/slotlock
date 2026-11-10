// Monthly quotas (quotas.ts) against real Postgres, as the LOGIN role grantApplicationRole grants:
// the month's operations and bookings as a quota counts them (rolled up or not yet), each notice
// noted once and put in the tenant's feed, the notices kept from the serving role and erased with
// the tenant, and a check over the real functions refusing past the plan's stop. Skipped without
// DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { SLOTLOCK_PLAN_QUOTAS, readSlotlockTenantQuotas, setSlotlockTenantPlan } from '../plans.js';
import {
  createSlotlockQuotas,
  noteSlotlockQuotaThreshold,
  readSlotlockQuotaUse,
  slotlockQuotaPeriod,
} from '../quotas.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { recordSlotlockUsage, slotlockUsageDay } from '../usage.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;

describe.skipIf(!url)('monthly quotas (real Postgres, application role)', () => {
  const role = `slotlock_quota_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenants: string[] = [];
  const tenant = (name: string) => {
    const ref = `quota-${name}-${randomUUID()}`;
    tenants.push(ref);
    return ref;
  };
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const month = () => slotlockQuotaPeriod(Date.now()).periodStart;
  /** The tenant's first changes, oldest first. */
  const feed = async (tenantRef: string) => {
    const page = await store.withTenant(tenantRef, (scoped) => scoped.listChanges({ tenantRef, limit: 10 }));
    if (!page.ok) throw new Error(page.code);
    return page.changes;
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
    for (const ref of tenants) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  const keyed = async (tenantRef: string) =>
    (await createSlotlockApiKeyStore(application).create({ tenantRef, name: 'agent', scopes: ['read', 'write'] }))
      .apiKey.id;
  const operations = (tenantRef: string, count: number) =>
    recordSlotlockUsage(application, randomUUID(), [
      { tenantRef, day: slotlockUsageDay(Date.now()), metric: 'operations', keyId: '', origin: 'rest', count },
    ]);

  /** A confirmed hold and a reservation through `origin`: two bookings, and a hold. */
  async function book(tenantRef: string, origin: 'mcp' | 'maintenance', offsetHours: number) {
    const start = (hours: number) => new Date(Date.now() + 48 * HOUR + (offsetHours + hours) * HOUR);
    await store.withTenant(
      tenantRef,
      async (scoped) => {
        const resource =
          (await scoped.listResources({ tenantRef }))[0] ??
          (await scoped.createResource({ tenantRef, externalRef: 'room-1', timezone: 'UTC' }));
        const held = await scoped.acquireHold({
          tenantRef,
          resourceId: resource.id,
          start: start(0),
          end: start(1),
          ttlMs: 600_000,
        });
        if (!held.ok) throw new Error(held.code);
        expect((await scoped.confirmHold(held.hold.id, { tenantRef })).ok).toBe(true);
        const booked = await scoped.createExternalReservation({
          tenantRef,
          externalRef: `booking-${offsetHours}`,
          resourceId: resource.id,
          start: start(2),
          end: start(3),
          bufferAfterMs: 0,
          revision: 1,
        });
        expect(booked.ok).toBe(true);
      },
      { isolation: 'read committed', origin },
    );
  }

  it('counts the month’s operations, and its bookings whether rolled up yet or not, once', async () => {
    const acme = tenant('count');
    await keyed(acme);
    await operations(acme, 40);
    await operations(acme, 2);
    await book(acme, 'mcp', 0);
    // Maintenance's own changes are not the tenant's use.
    await book(acme, 'maintenance', 10);
    // Not rolled up yet: counted from the feed.
    expect(await readSlotlockQuotaUse(application, acme, month())).toEqual({ operations: 42, bookings: 2 });
    await store.withTenant(acme, (scoped) => scoped.rollUpUsage({ tenantRef: acme }));
    expect(await readSlotlockQuotaUse(application, acme, month())).toEqual({ operations: 42, bookings: 2 });
    // Half rolled up: the rest is still counted, and nothing twice.
    await book(acme, 'mcp', 20);
    expect(await readSlotlockQuotaUse(application, acme, month())).toEqual({ operations: 42, bookings: 4 });
    await store.withTenant(acme, (scoped) => scoped.rollUpUsage({ tenantRef: acme }));
    expect(await readSlotlockQuotaUse(application, acme, month())).toEqual({ operations: 42, bookings: 4 });
    // Another tenant counts nothing of it.
    expect(await readSlotlockQuotaUse(application, tenant('none'), month())).toEqual({ operations: 0, bookings: 0 });
  });

  it('refuses a month that is not this one’s or last', async () => {
    const acme = tenant('range');
    for (const day of ['2020-01-01', '2999-01-01']) {
      await expect(readSlotlockQuotaUse(application, acme, day), day).rejects.toMatchObject({ code: '22023' });
    }
  });

  it('notes a share of a quota once, in the tenant’s feed, and only for a tenant that exists', async () => {
    const acme = tenant('notice');
    await keyed(acme);
    const notice = {
      tenantRef: acme,
      metric: 'operations' as const,
      percent: 80 as const,
      used: 20_001,
      quota: 25_000,
      periodStart: month(),
    };
    expect(await noteSlotlockQuotaThreshold(application, notice)).toBe(true);
    // Another server saw the same count pass the same share.
    expect(await noteSlotlockQuotaThreshold(application, { ...notice, used: 20_050 })).toBe(false);
    expect(await noteSlotlockQuotaThreshold(application, { ...notice, percent: 100, used: 25_000 })).toBe(true);
    const reached = (await feed(acme)).filter((change) => change.type === 'usage.threshold_reached');
    const next = new Date(`${month()}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    expect(reached.map((change) => change.data)).toEqual([
      {
        metric: 'operations',
        percent: 80,
        used: 20_001,
        quota: 25_000,
        period_start: month(),
        resets_at: next.toISOString().replace('.000Z', 'Z'),
      },
      expect.objectContaining({ percent: 100, used: 25_000 }),
    ]);
    // No key and no feed: never was, or erased.
    expect(await noteSlotlockQuotaThreshold(application, { ...notice, tenantRef: `quota-gone-${randomUUID()}` })).toBe(
      false,
    );
    for (const bad of [{ percent: 50 }, { metric: 'holds' }, { periodStart: '2026-11-02' }, { quota: 0 }]) {
      await expect(
        noteSlotlockQuotaThreshold(application, { ...notice, ...bad } as never),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: '22023' });
    }
    await expect(application`SELECT * FROM slotlock.usage_notices`).rejects.toMatchObject({ code: '42501' });
    const erased = await store.eraseTenant({ tenantRef: acme });
    expect(erased.rows).toMatchObject({ usage_notices: 2 });
    // Erased, it is noted again only once it exists again.
    expect(await noteSlotlockQuotaThreshold(application, notice)).toBe(false);
  });

  it('refuses a Free tenant past its operations, over the real functions', async () => {
    const acme = tenant('stop');
    await keyed(acme);
    await setSlotlockTenantPlan(application, { tenantRef: acme, plan: 'free', status: 'active' });
    const quotas = createSlotlockQuotas({
      plan: (tenantRef) => readSlotlockTenantQuotas(application, tenantRef),
      used: (tenantRef, fromDay) => readSlotlockQuotaUse(application, tenantRef, fromDay),
      notice: (notice) => noteSlotlockQuotaThreshold(application, notice),
    });
    await operations(acme, 24_999);
    expect(await quotas.check({ tenantRef: acme, operation: 'slotlock_list_resources' })).toMatchObject({
      ok: true,
      standings: [{ metric: 'operations', used: 24_999, stop: 25_000 }, { metric: 'bookings', used: 0 }],
    });
    const later = createSlotlockQuotas({
      plan: async () => SLOTLOCK_PLAN_QUOTAS.free,
      used: (tenantRef, fromDay) => readSlotlockQuotaUse(application, tenantRef, fromDay),
    });
    await operations(acme, 1);
    expect(await later.check({ tenantRef: acme, operation: 'slotlock_list_resources' })).toMatchObject({
      ok: false,
      exceeded: { metric: 'operations', used: 25_000 },
    });
    // The 80% notice the first check sent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await feed(acme)).map((change) => change.type)).toContain('usage.threshold_reached');
  });
});
