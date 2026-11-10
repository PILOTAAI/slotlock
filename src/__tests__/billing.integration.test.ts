// Stripe billing (billing.ts): Checkout and portal requests as Stripe documents them, signed
// webhooks only, and a webhook setting the tenant's plan from the subscription Stripe holds, never
// from the event. Real Postgres for the plan; a fake Stripe. Skipped without DATABASE_URL.
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_STRIPE_API_VERSION,
  type SlotlockStripeSubscription,
  createSlotlockStripe,
  handleSlotlockStripeWebhook,
  slotlockPlanOfSubscription,
  verifySlotlockStripeSignature,
} from '../billing.js';
import { readSlotlockTenantPlan, readSlotlockTenantQuotas } from '../plans.js';
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
    const query = new URL(target).searchParams;
    // A customer's subscriptions that are not canceled, as Stripe lists them without a status.
    if (new URL(target).pathname === '/v1/subscriptions') {
      const customer = query.get('customer');
      return Response.json({
        data: [...subscriptions.values()].filter(
          (found) => found.customer === customer && found.status !== 'canceled',
        ),
      });
    }
    // Search by metadata: metadata['tenant_ref']:'<tenant>'.
    if (new URL(target).pathname === '/v1/subscriptions/search') {
      const tenant = /^metadata\['tenant_ref'\]:'(.*)'$/.exec(query.get('query') ?? '')?.[1];
      return Response.json({
        data: [...subscriptions.values()].filter((found) => found.metadata?.tenant_ref === tenant),
      });
    }
    const id = /\/v1\/subscriptions\/(\w+)$/.exec(target)?.[1];
    const found = id ? subscriptions.get(id) : undefined;
    return found
      ? Response.json(found)
      : Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing' } }, { status: 404 });
  });
  const stripe = createSlotlockStripe({
    secretKey: 'rk_test_fake',
    prices: { month: 'price_month', year: 'price_year' },
    teamPrices: { month: 'price_team_month', year: 'price_team_year' },
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

  it('gives Team for a subscription at a Team price, however it was bought', () => {
    const team = { month: 'price_team_month', year: 'price_team_year' };
    const at = (price: string | { id: string }, status = 'active') =>
      slotlockPlanOfSubscription({ id: 'sub_1', status, customer: 'cus_1', items: { data: [{ price }] } }, team);
    expect(at({ id: 'price_team_year' })).toEqual({ plan: 'team', status: 'active' });
    expect(at('price_team_month', 'past_due')).toEqual({ plan: 'team', status: 'past_due' });
    expect(at({ id: 'price_year' })).toEqual({ plan: 'developer', status: 'active' });
    expect(at({ id: 'price_team_year' }, 'canceled')).toEqual({ plan: 'free', status: 'canceled' });
    // Without Team prices, every paid subscription is Developer.
    expect(slotlockPlanOfSubscription({ id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ price: 'price_team_year' }] } })).toMatchObject({ plan: 'developer' });
  });

  it('adds the metered overage price to a Developer checkout only, when overage is on', async () => {
    const calls: { url: string; body: string }[] = [];
    const stripe = createSlotlockStripe({
      secretKey: 'rk_test_fake',
      prices: { month: 'price_month', year: 'price_year' },
      teamPrices: { month: 'price_team_month', year: 'price_team_year' },
      overagePrice: 'price_overage',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: String(init.body ?? '') });
        return Response.json({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
      }) as typeof fetch,
    });
    const at = { interval: 'month' as const, customer: null, successUrl: 'https://a.example/ok', cancelUrl: 'https://a.example/no' };
    await stripe.checkout({ ...at, tenantRef: 'github:42' });
    await stripe.checkout({ ...at, tenantRef: 'github-org:91', plan: 'team' });
    const [developer, team] = calls.map((call) => new URLSearchParams(call.body));
    expect(developer?.get('line_items[1][price]')).toBe('price_overage');
    expect(developer?.has('line_items[1][quantity]')).toBe(false);
    expect(team?.has('line_items[1][price]')).toBe(false);
  });

  it("asks Checkout for the Team price for an organization's Team plan", async () => {
    const { stripe, calls } = fakeStripe(new Map());
    await stripe.checkout({
      tenantRef: 'github-org:91',
      interval: 'month',
      plan: 'team',
      customer: null,
      successUrl: 'https://app.example.com/dashboard/plan?checkout=done',
      cancelUrl: 'https://app.example.com/dashboard/plan',
    });
    const sent = new URLSearchParams(calls.find((call) => call.url.endsWith('/v1/checkout/sessions'))?.body ?? '');
    expect(sent.get('line_items[0][price]')).toBe('price_team_month');
    expect(sent.get('subscription_data[metadata][tenant_ref]')).toBe('github-org:91');
  });

  it('asks Checkout for a Managed Payments subscription tagged with the tenant', async () => {
    const { stripe, calls } = fakeStripe(new Map());
    const sent = (path: string) => calls.find((call) => call.url.endsWith(path));
    const at = await stripe.checkout({
      tenantRef: 'github:42',
      interval: 'year',
      customer: 'cus_Old',
      successUrl: 'https://app.example.com/dashboard/plan?checkout=done',
      cancelUrl: 'https://app.example.com/dashboard/plan',
    });
    expect(at).toBe('https://checkout.stripe.com/c/pay/cs_1');
    expect(Object.fromEntries(new URLSearchParams(sent('/v1/checkout/sessions')?.body ?? ''))).toEqual({
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
    expect(sent('/v1/checkout/sessions')?.headers.get('authorization')).toBe('Bearer rk_test_fake');
    // Pinned, so the account's default API version never changes what is sent or read.
    expect(sent('/v1/checkout/sessions')?.headers.get('stripe-version')).toBe(SLOTLOCK_STRIPE_API_VERSION);
    // A known customer's subscriptions are read first: none is live here.
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/subscriptions?customer=cus_Old&limit=100');
    await stripe.portal({ customer: 'cus_Old', returnUrl: 'https://app.example.com/dashboard/plan' });
    expect(Object.fromEntries(new URLSearchParams(sent('/v1/billing_portal/sessions')?.body ?? ''))).toEqual({
      customer: 'cus_Old',
      return_url: 'https://app.example.com/dashboard/plan',
    });
    await expect(stripe.subscription('sub_../x')).rejects.toThrow('Not a subscription id');
  });

  it('opens no second Checkout for a customer who already pays', async () => {
    const paid: SlotlockStripeSubscription = { id: 'sub_Paid', status: 'past_due', customer: 'cus_Paid' };
    const { stripe, calls } = fakeStripe(new Map([['sub_Paid', paid]]));
    await expect(
      stripe.checkout({
        tenantRef: 'github:42',
        interval: 'month',
        customer: 'cus_Paid',
        successUrl: 'https://app.example.com/dashboard/plan?checkout=done',
        cancelUrl: 'https://app.example.com/dashboard/plan',
      }),
    ).rejects.toMatchObject({ code: 'subscription_exists', status: 409 });
    expect(calls.some((call) => call.url.endsWith('/v1/checkout/sessions'))).toBe(false);
    await expect(stripe.liveSubscriptionsOfTenant("github:42' OR 'x")).rejects.toThrow(
      'Not a searchable tenant',
    );
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

  it('sets Team from a subscription at a Team price, which the database takes', async () => {
    subscriptions.set('sub_T1', {
      ...subscription('sub_T1', 'active'),
      items: { data: [{ current_period_end: Math.floor(Date.UTC(2026, 11, 9) / 1000), price: { id: 'price_team_year' } }] },
    });
    await sql`UPDATE slotlock.tenant_plans SET stripe_subscription = 'sub_T1' WHERE tenant_ref = ${tenant}`;
    const response = await deliver({ data: { object: { object: 'subscription', id: 'sub_T1' } } });
    expect(response.status).toBe(200);
    expect(await readSlotlockTenantPlan(sql, tenant)).toMatchObject({
      plan: 'team',
      limits: { resources: 500, apiKeys: 100, webhookEndpoints: 25 },
      stripeSubscription: 'sub_T1',
    });
    expect(await readSlotlockTenantQuotas(sql, tenant)).toEqual({ operations: 2_000_000, bookings: 100_000, stopPercent: 110 });
    // Back to the subscription the tests below expect.
    await sql`UPDATE slotlock.tenant_plans SET stripe_subscription = 'sub_A1' WHERE tenant_ref = ${tenant}`;
    subscriptions.delete('sub_T1');
    await deliver({ data: { object: { object: 'subscription', id: 'sub_A1' } } });
    expect(await readSlotlockTenantPlan(sql, tenant)).toMatchObject({ plan: 'developer' });
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

  it('keeps Developer while a second purchase still renews, and reports it', async () => {
    const twice = `billing-twice-${randomUUID()}`;
    const duplicates: string[][] = [];
    const paid = (id: string, customer: string, status: string): SlotlockStripeSubscription => ({
      id,
      status,
      customer,
      metadata: { tenant_ref: twice },
      items: { data: [{ current_period_end: Math.floor(Date.UTC(2026, 11, 9) / 1000) }] },
    });
    const send = (id: string) => {
      const body = JSON.stringify({ data: { object: { object: 'subscription', id } } });
      return handleSlotlockStripeWebhook(
        new Request('https://app.example.com/stripe/webhook', {
          method: 'POST',
          headers: { 'stripe-signature': sign(body) },
          body,
        }),
        { secret: SECRET, stripe, sql, now: () => NOW, onDuplicate: (ids) => duplicates.push([...ids]) },
      );
    };
    try {
      // Two tabs, two Checkouts, two customers: both paid before either webhook arrived.
      subscriptions.set('sub_T1', paid('sub_T1', 'cus_Tab1', 'active'));
      subscriptions.set('sub_T2', paid('sub_T2', 'cus_Tab2', 'active'));
      await send('sub_T1');
      await send('sub_T2');
      expect(duplicates).toEqual([['sub_T1', 'sub_T2']]);
      expect(await readSlotlockTenantPlan(sql, twice)).toMatchObject({ stripeSubscription: 'sub_T2' });

      // The one the plan names ends; the other still renews, so the plan stays and names it.
      subscriptions.set('sub_T2', paid('sub_T2', 'cus_Tab2', 'canceled'));
      await send('sub_T2');
      expect(await readSlotlockTenantPlan(sql, twice)).toMatchObject({
        plan: 'developer',
        stripeSubscription: 'sub_T1',
        stripeCustomer: 'cus_Tab1',
      });

      // The last one ends: Free.
      subscriptions.set('sub_T1', paid('sub_T1', 'cus_Tab1', 'canceled'));
      await send('sub_T1');
      expect(await readSlotlockTenantPlan(sql, twice)).toMatchObject({
        plan: 'free',
        stripeSubscription: null,
      });
    } finally {
      await sql`SELECT * FROM slotlock.erase_tenant(${twice}::text)`;
    }
  });

  it('ignores events about nothing of ours, and asks Stripe to retry when it cannot read one', async () => {
    expect((await deliver({ data: { object: { object: 'customer', id: 'cus_1' } } })).status).toBe(200);
    expect((await deliver({ data: { object: { object: 'subscription', id: 'sub_Missing' } } })).status).toBe(500);
  });
});
