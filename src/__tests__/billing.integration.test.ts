// Stripe billing (billing.ts): Checkout and portal requests as Stripe documents them, signed
// webhooks only, and a webhook setting the tenant's plan from the subscription Stripe holds, never
// from the event. Real Postgres for the plan; a fake Stripe. Skipped without DATABASE_URL.
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type SlotlockStripeSubscription,
  createSlotlockStripe,
  handleSlotlockStripeWebhook,
  slotlockPlanOfSubscription,
  verifySlotlockStripeSignature,
} from '../billing.js';
import { readSlotlockTenantPlan } from '../plans.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const SECRET = 'whsec_test_only_not_a_real_secret';
const NOW = Date.UTC(2026, 10, 9, 12);

function sign(body: string, at = NOW, secret = SECRET) {
  const t = Math.floor(at / 1000);
  const v1 = createHmac('sha256', secret).update(`${String(t)}.${body}`).digest('hex');
  return `t=${String(t)},v1=${v1}`;
}

function fakeStripe(subscriptions: Map<string, SlotlockStripeSubscription>) {
  const calls: Array<{ url: string; body: string | null; headers: Headers }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = String(input);
    calls.push({ url: target, body: (init.body as string) ?? null, headers: new Headers(init.headers) });
    if (target.endsWith('/v1/checkout/sessions')) return Response.json({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    if (target.endsWith('/v1/billing_portal/sessions')) return Response.json({ url: 'https://billing.stripe.com/p/session/1' });
    const id = /\/v1\/subscriptions\/(\w+)$/.exec(target)?.[1];
    const found = id ? subscriptions.get(id) : undefined;
    return found
      ? Response.json(found)
      : Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, { status: 404 });
  });
  const stripe = createSlotlockStripe({
    secretKey: 'rk_test_fake',
    prices: { month: 'price_month', year: 'price_year' },
    fetch: fetch as typeof globalThis.fetch,
  });
  return { stripe, calls };
}

describe('Stripe signatures and plans', () => {
  it('accepts only a fresh signature made with the endpoint secret', () => {
    const body = '{"id":"evt_1"}';
    expect(verifySlotlockStripeSignature(body, sign(body), SECRET, NOW)).toBe(true);
    expect(verifySlotlockStripeSignature(body, `${sign(body)},v1=${'0'.repeat(64)}`, SECRET, NOW)).toBe(true);
    expect(verifySlotlockStripeSignature(`${body} `, sign(body), SECRET, NOW)).toBe(false);
    expect(verifySlotlockStripeSignature(body, sign(body, NOW, 'whsec_other'), SECRET, NOW)).toBe(false);
    expect(verifySlotlockStripeSignature(body, sign(body, NOW - 301_000), SECRET, NOW)).toBe(false);
    expect(verifySlotlockStripeSignature(body, null, SECRET, NOW)).toBe(false);
    expect(verifySlotlockStripeSignature(body, 't=1,v0=abc', SECRET, NOW)).toBe(false);
  });

  it('keeps the plan while Stripe retries a payment, and ends it after', () => {
    const of = (status: string) =>
      slotlockPlanOfSubscription({ id: 'sub_1', status, customer: 'cus_1' });
    expect(of('active')).toEqual({ plan: 'developer', status: 'active' });
    expect(of('trialing')).toEqual({ plan: 'developer', status: 'active' });
    expect(of('past_due')).toEqual({ plan: 'developer', status: 'past_due' });
    for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(of(status)).toEqual({ plan: 'free', status: 'canceled' });
    }
  });

  it('asks Checkout for a Managed Payments subscription tagged with the tenant', async () => {
    const { stripe, calls } = fakeStripe(new Map());
    const at = await stripe.checkout({
      tenantRef: 'github:42',
      interval: 'year',
      customer: 'cus_Old',
      successUrl: 'https://app.example.com/dashboard/plan?checkout=done',
      cancelUrl: 'https://app.example.com/dashboard/plan',
    });
    expect(at).toBe('https://checkout.stripe.com/c/pay/cs_1');
    const sent = Object.fromEntries(new URLSearchParams(calls[0]?.body ?? ''));
    expect(sent).toEqual({
      mode: 'subscription',
      'line_items[0][price]': 'price_year',
      'line_items[0][quantity]': '1',
      'managed_payments[enabled]': 'true',
      success_url: 'https://app.example.com/dashboard/plan?checkout=done',
      cancel_url: 'https://app.example.com/dashboard/plan',
      client_reference_id: 'github_42',
      'metadata[tenant_ref]': 'github:42',
      'subscription_data[metadata][tenant_ref]': 'github:42',
      customer: 'cus_Old',
    });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer rk_test_fake');
    await stripe.portal({ customer: 'cus_Old', returnUrl: 'https://app.example.com/dashboard/plan' });
    expect(Object.fromEntries(new URLSearchParams(calls[1]?.body ?? ''))).toEqual({
      customer: 'cus_Old',
      return_url: 'https://app.example.com/dashboard/plan',
    });
    await expect(stripe.subscription('sub_../x')).rejects.toThrow('Not a subscription id');
  });
});

describe.skipIf(!url)('the Stripe webhook (real Postgres)', () => {
  const tenant = `billing-${randomUUID()}`;
  let sql: ReturnType<typeof postgres>;
  const subscriptions = new Map<string, SlotlockStripeSubscription>();
  const { stripe } = fakeStripe(subscriptions);

  beforeAll(async () => {
    sql = postgres(url as string, { max: 2, onnotice: () => {} });
    const owner = createSlotlockStore(sql);
    await owner.applySchema();
    await owner.applyTenantRls();
  });
  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenant}::text)`;
    await sql.end();
  });

  const deliver = (event: unknown, signature?: string) => {
    const body = JSON.stringify(event);
    return handleSlotlockStripeWebhook(
      new Request('https://app.example.com/stripe/webhook', {
        method: 'POST',
        headers: { 'stripe-signature': signature ?? sign(body) },
        body,
      }),
      { secret: SECRET, stripe, sql, now: () => NOW },
    );
  };
  const subscription = (id: string, status: string): SlotlockStripeSubscription => ({
    id,
    status,
    customer: 'cus_Paid1',
    metadata: { tenant_ref: tenant },
    items: { data: [{ current_period_end: Math.floor(Date.UTC(2026, 11, 9) / 1000) }] },
  });

  it('refuses an unsigned delivery and changes nothing', async () => {
    subscriptions.set('sub_A1', subscription('sub_A1', 'active'));
    const response = await deliver({ data: { object: { object: 'subscription', id: 'sub_A1' } } }, 't=1,v1=00');
    expect(response.status).toBe(400);
    expect(await readSlotlockTenantPlan(sql, tenant)).toBeNull();
  });

  it('sets the plan from the subscription Stripe holds, whatever the event says', async () => {
    // The event's own copy says canceled; Stripe now holds it active.
    const response = await deliver({
      type: 'checkout.session.completed',
      data: { object: { object: 'checkout.session', subscription: 'sub_A1', status: 'canceled' } },
    });
    expect(response.status).toBe(200);
    expect(await readSlotlockTenantPlan(sql, tenant)).toMatchObject({
      plan: 'developer',
      status: 'active',
      stripeCustomer: 'cus_Paid1',
      stripeSubscription: 'sub_A1',
      currentPeriodEnd: new Date(Date.UTC(2026, 11, 9)),
    });
  });

  it('ends the plan when the subscription ends, but not a newer one', async () => {
    subscriptions.set('sub_A1', subscription('sub_A1', 'canceled'));
    subscriptions.set('sub_B2', subscription('sub_B2', 'active'));
    await deliver({ data: { object: { object: 'subscription', id: 'sub_B2' } } });
    // A late event about the old subscription leaves the new one's plan alone.
    await deliver({ data: { object: { object: 'subscription', id: 'sub_A1' } } });
    expect(await readSlotlockTenantPlan(sql, tenant)).toMatchObject({ plan: 'developer', stripeSubscription: 'sub_B2' });
    subscriptions.set('sub_B2', subscription('sub_B2', 'unpaid'));
    await deliver({ data: { object: { object: 'invoice', subscription: 'sub_B2' } } });
    expect(await readSlotlockTenantPlan(sql, tenant)).toMatchObject({
      plan: 'free',
      status: 'canceled',
      stripeCustomer: 'cus_Paid1',
      stripeSubscription: null,
      limits: { resources: 10 },
    });
  });

  it('ignores events about nothing of ours, and asks Stripe to retry when it cannot read one', async () => {
    expect((await deliver({ data: { object: { object: 'customer', id: 'cus_1' } } })).status).toBe(200);
    expect((await deliver({ data: { object: { object: 'subscription', id: 'sub_Missing' } } })).status).toBe(500);
  });
});
