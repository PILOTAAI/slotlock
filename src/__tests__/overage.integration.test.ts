// Metered overage for Developer, against real Postgres as the schema owner: each paying Developer
// tenant whose subscription carries the metered price has its operations above its quota sent to
// Stripe once, as Billing Meter events, and is refused only past the overage stop. Skipped without
// DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportSlotlockOverage, slotlockMonthOf } from '../overage.js';
import { readSlotlockTenantQuotas, setSlotlockTenantPlan, setSlotlockTenantPlanOverage } from '../plans.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('metered overage (real Postgres)', () => {
  const paying = `overage-paying-${randomUUID()}`;
  const free = `overage-free-${randomUUID()}`;
  // Pays for Developer, bought before overage was sold: no metered price on its subscription.
  const unmetered = `overage-unmetered-${randomUUID()}`;
  const month = slotlockMonthOf(Date.now());
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(sql);
    await owner.applySchema();
    await owner.applyTenantRls();
    await setSlotlockTenantPlan(sql, {
      tenantRef: paying,
      plan: 'developer',
      status: 'active',
      stripeCustomer: 'cus_Overage1',
      stripeSubscription: 'sub_Overage1',
    });
    await setSlotlockTenantPlanOverage(sql, { tenantRef: paying, stripeSubscription: 'sub_Overage1', metered: true });
    await setSlotlockTenantPlan(sql, {
      tenantRef: unmetered,
      plan: 'developer',
      status: 'active',
      stripeCustomer: 'cus_Overage2',
      stripeSubscription: 'sub_Overage2',
    });
    await setSlotlockTenantPlanOverage(sql, { tenantRef: unmetered, stripeSubscription: 'sub_Overage2', metered: false });
    await setSlotlockTenantPlan(sql, { tenantRef: free, plan: 'free', status: 'active' });
    for (const tenant of [paying, unmetered, free]) {
      await sql`
        INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, key_id, origin, count)
        VALUES (${tenant}, current_date, 'operations', '', 'rest', 600000)`;
    }
  });

  afterAll(async () => {
    for (const tenant of [paying, unmetered, free]) {
      await sql`UPDATE slotlock.tenant_plans SET stripe_subscription = NULL WHERE tenant_ref = ${tenant}`;
      await sql`SELECT * FROM slotlock.erase_tenant(${tenant}::text)`;
    }
    await sql.end();
  });

  it('lets a paying Developer tenant whose subscription carries the metered price past its quota up to the overage stop, and no one else', async () => {
    expect(await readSlotlockTenantQuotas(sql, paying, { overageStopPercent: 300 })).toEqual({
      operations: 500_000,
      bookings: 25_000,
      stopPercent: 300,
    });
    expect(await readSlotlockTenantQuotas(sql, paying)).toMatchObject({ stopPercent: 110 });
    // Paying, but nothing would bill its use past the quota: refused past 110%, as the Terms say.
    expect(await readSlotlockTenantQuotas(sql, unmetered, { overageStopPercent: 300 })).toMatchObject({ stopPercent: 110 });
    expect(await readSlotlockTenantQuotas(sql, free, { overageStopPercent: 300 })).toMatchObject({ stopPercent: 100 });
  });

  it('stops a paying tenant at 110% on a schema from before this release, which cannot say the price is carried', async () => {
    // The dashboard Worker deploys on its own, so it may run against a database not migrated yet.
    const rolledBack = new Error('rolled back');
    const seen = await sql
      .begin(async (tx) => {
        await tx`DROP FUNCTION slotlock.tenant_plan_overage(text)`;
        const quotas = await readSlotlockTenantQuotas(tx, paying, { overageStopPercent: 300 });
        throw Object.assign(rolledBack, { quotas });
      })
      .catch((error: unknown) => (error === rolledBack ? (error as { quotas?: unknown }).quotas : Promise.reject(error)));
    expect(seen).toMatchObject({ stopPercent: 110 });
    expect(await readSlotlockTenantQuotas(sql, paying, { overageStopPercent: 300 })).toMatchObject({ stopPercent: 300 });
  });

  it('sends each operation above the quota once, and again only what is new', async () => {
    const events: URLSearchParams[] = [];
    let fail = false;
    const stripe = {
      secretKey: 'sk_test_overage',
      eventName: 'slotlock_operations',
      fetch: (async (_url: string, init: RequestInit) => {
        if (fail) return new Response('{}', { status: 500 });
        events.push(new URLSearchParams(String(init.body)));
        return Response.json({ object: 'billing.meter_event' });
      }) as typeof fetch,
    };
    const ours = (report: Awaited<ReturnType<typeof reportSlotlockOverage>>) =>
      report.tenants.find((row) => row.tenant === paying);
    const first = await reportSlotlockOverage(sql, { month, stripe });
    expect(ours(first)).toEqual({ tenant: paying, over: 100_000, reported: 100_000, sent: 100_000 });
    expect(first.tenants.some((row) => row.tenant === free)).toBe(false);
    // Its use past the quota is free for it, so none is sent: Stripe would have nothing to bill it at.
    expect(first.tenants.some((row) => row.tenant === unmetered)).toBe(false);
    expect(events.some((form) => form.get('payload[stripe_customer_id]') === 'cus_Overage2')).toBe(false);
    const sent = events.filter((form) => form.get('payload[stripe_customer_id]') === 'cus_Overage1');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.get('event_name')).toBe('slotlock_operations');
    expect(sent[0]?.get('payload[value]')).toBe('100000');
    // Run again: nothing new, nothing sent.
    expect(ours(await reportSlotlockOverage(sql, { month, stripe }))).toMatchObject({ sent: 0 });
    // More use: only the difference. A failure sends nothing and is sent next time.
    await sql`
      INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, key_id, origin, count)
      VALUES (${paying}, current_date, 'operations', '', 'mcp', 2500)`;
    fail = true;
    const failed = await reportSlotlockOverage(sql, { month, stripe });
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect(ours(failed)).toMatchObject({ over: 102_500, reported: 100_000, sent: 0 });
    fail = false;
    expect(ours(await reportSlotlockOverage(sql, { month, stripe }))).toMatchObject({ sent: 2_500, reported: 102_500 });
    expect(events.filter((form) => form.get('payload[stripe_customer_id]') === 'cus_Overage1').map((form) => form.get('payload[value]'))).toEqual([
      '100000',
      '2500',
    ]);
    // Stripe took an event but its answer was lost: the next run sends the same identifier, and
    // Stripe's refusal of a duplicate (its words, read in test mode) counts as sent, not as new.
    await sql`
      INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, key_id, origin, count)
      VALUES (${paying}, current_date, 'operations', '', 'rest', 500)
      ON CONFLICT (tenant_ref, day, metric, key_id, origin) DO UPDATE SET count = slotlock.usage_daily.count + EXCLUDED.count`;
    const taken = new Set<string>();
    const lossy = {
      ...stripe,
      fetch: (async (_url: string, init: RequestInit) => {
        const form = new URLSearchParams(String(init.body));
        const id = form.get('identifier') as string;
        if (taken.has(id)) {
          return Response.json(
            { error: { message: `An event already exists with identifier ${id}.`, type: 'invalid_request_error' } },
            { status: 400 },
          );
        }
        taken.add(id);
        events.push(form);
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    };
    expect(ours(await reportSlotlockOverage(sql, { month, stripe: lossy }))).toMatchObject({ sent: 0, reported: 102_500 });
    expect(ours(await reportSlotlockOverage(sql, { month, stripe: lossy }))).toMatchObject({ sent: 500, reported: 103_000 });
    // Another 400 is still a failure, and a later total sends only what Stripe has not had.
    await sql`
      INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, key_id, origin, count)
      VALUES (${paying}, current_date, 'operations', '', 'dashboard', 100)
      ON CONFLICT (tenant_ref, day, metric, key_id, origin) DO UPDATE SET count = slotlock.usage_daily.count + EXCLUDED.count`;
    const refused = {
      ...stripe,
      fetch: (async () =>
        Response.json({ error: { message: 'No such customer', type: 'invalid_request_error' } }, { status: 400 })) as typeof fetch,
    };
    expect(ours(await reportSlotlockOverage(sql, { month, stripe: refused }))).toMatchObject({ sent: 0, reported: 103_000 });
    expect(ours(await reportSlotlockOverage(sql, { month, stripe }))).toMatchObject({ sent: 100, reported: 103_100 });
    expect(events.filter((form) => form.get('payload[stripe_customer_id]') === 'cus_Overage1').map((form) => form.get('payload[value]'))).toEqual([
      '100000',
      '2500',
      '500',
      '100',
    ]);
    await expect(reportSlotlockOverage(sql, { month: '2026-13', stripe })).rejects.toMatchObject({ code: 'invalid_month' });
  });
});
