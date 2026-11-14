// Stripe billing (billing.ts): Checkout and portal requests as Stripe documents them, signed
// webhooks only, and a webhook setting the tenant's plan from the subscription Stripe holds, never
// from the event. Real Postgres for the plan; a fake Stripe. Skipped without DATABASE_URL.
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_STRIPE_API_VERSION,
  type SlotlockStripeOptions,
  type SlotlockStripePrice,
  type SlotlockStripeSubscription,
  createSlotlockStripe,
  handleSlotlockStripeWebhook,
  slotlockPlanOfSubscription,
  slotlockPriceIsTeam,
  formatSlotlockPrice,
  verifySlotlockStripeSignature,
  slotlockSubscriptionEnding,
} from '../billing.js';
import { readSlotlockTenantPlan, readSlotlockTenantQuotas, setSlotlockTenantPlan } from '../plans.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const SECRET = 'whsec_test_only_not_a_real_secret';
const NOW = Date.UTC(2026, 10, 9, 12);

function sign(body: string, at = NOW, secret = SECRET) {
  const t = Math.floor(at / 1000);
  const v1 = createHmac('sha256', secret).update(`${String(t)}.${body}`).digest('hex');
  return `t=${String(t)},v1=${v1}`;
}

/**
 * What each payment (a PaymentIntent) paid, as Stripe's invoice payments list it: the
 * subscriptions whose invoices it paid; 'refused' answers 403, as a key without Read on Invoices.
 */
const invoicePayments = new Map<string, string[] | 'refused'>();

function fakeStripe(
  subscriptions: Map<string, SlotlockStripeSubscription>,
  refusePrices = false,
  extra: Partial<SlotlockStripeOptions> = {},
) {
  const calls: Array<{ url: string; body: string | null; headers: Headers }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const target = String(input);
    calls.push({ url: target, body: (init.body as string) ?? null, headers: new Headers(init.headers) });
    if (target.endsWith('/v1/checkout/sessions')) return Response.json({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    if (target.endsWith('/v1/billing_portal/sessions')) return Response.json({ url: 'https://billing.stripe.com/p/session/1' });
    // Prices as Stripe holds them: pence, and the currency.
    const amounts: Record<string, number> = { price_month: 500, price_year: 5000, price_team_month: 1500, price_team_year: 15000 };
    const priceId = /\/v1\/prices\/(\w+)$/.exec(target)?.[1];
    if (priceId !== undefined) {
      if (refusePrices) return Response.json({ error: { type: 'invalid_request_error', code: 'secret_key_required' } }, { status: 403 });
      return Response.json({ id: priceId, unit_amount: amounts[priceId], currency: 'gbp' });
    }
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
    // GET /v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=pi_…, each
    // invoice expanded (expand[]=data.invoice), as Stripe's API reference has it (read 2026-11-14).
    if (new URL(target).pathname === '/v1/invoice_payments') {
      expect(query.get('payment[type]')).toBe('payment_intent');
      expect(query.getAll('expand[]')).toEqual(['data.invoice']);
      const paid = invoicePayments.get(query.get('payment[payment_intent]') ?? '') ?? [];
      if (paid === 'refused') return Response.json({ error: { type: 'invalid_request_error', code: 'secret_key_required' } }, { status: 403 });
      return Response.json({
        object: 'list',
        data: paid.map((subscription, index) => ({
          object: 'invoice_payment',
          invoice: { object: 'invoice', id: `in_Paid${index}`, parent: { type: 'subscription_details', subscription_details: { subscription } } },
          payment: { type: 'payment_intent', payment_intent: query.get('payment[payment_intent]') },
          status: 'paid',
        })),
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
    portalConfigurations: { developer: 'bpc_Developer1', team: 'bpc_Team1' },
    fetch: fetch as typeof globalThis.fetch,
    ...extra,
  });
  return { stripe, calls };
}

describe('prices as Stripe holds them', () => {
  it('formats amounts as people read them', () => {
    expect(formatSlotlockPrice(500, 'gbp')).toBe('£5');
    expect(formatSlotlockPrice(15000, 'GBP')).toBe('£150');
    expect(formatSlotlockPrice(1250, 'usd')).toBe('US$12.50');
    expect(formatSlotlockPrice(899, 'eur')).toBe('€8.99');
    // Yen are counted whole.
    expect(formatSlotlockPrice(1000, 'jpy')).toBe('JP¥1,000');
  });

  it('reads each plan price from Stripe once in ten minutes, and a refusal as long', async () => {
    const { stripe, calls } = fakeStripe(new Map());
    expect(await stripe.shownPrices?.()).toEqual({ developer: { month: '£5', year: '£50' }, team: { month: '£15', year: '£150' } });
    await stripe.shownPrices?.();
    expect(calls.filter((call) => call.url.includes('/v1/prices/')).map((call) => new URL(call.url).pathname).sort()).toEqual([
      '/v1/prices/price_month',
      '/v1/prices/price_team_month',
      '/v1/prices/price_team_year',
      '/v1/prices/price_year',
    ]);
    // A key without Read on Prices: refused once, and not asked again on every page.
    const refused = fakeStripe(new Map(), true);
    await expect(refused.stripe.shownPrices?.()).rejects.toMatchObject({ name: 'SlotlockBillingError' });
    await expect(refused.stripe.shownPrices?.()).rejects.toMatchObject({ name: 'SlotlockBillingError' });
    expect(refused.calls.filter((call) => call.url.includes('/v1/prices/'))).toHaveLength(4);
  });
});

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

  it('says when a subscription that still gives its plan is set to end', () => {
    const base = { id: 'sub_1', customer: 'cus_1', items: { data: [{ current_period_end: 1_797_206_640 }] } };
    // Cancelled at the end of the period, as the billing portal cancels: the period's end.
    expect(slotlockSubscriptionEnding({ ...base, status: 'active', cancel_at_period_end: true })).toEqual(new Date(1_797_206_640_000));
    // A cancellation date of its own wins.
    expect(slotlockSubscriptionEnding({ ...base, status: 'active', cancel_at_period_end: true, cancel_at: 1_797_000_000 })).toEqual(
      new Date(1_797_000_000_000),
    );
    // Renewing, or already ended (the webhook has set Free): nothing ends.
    expect(slotlockSubscriptionEnding({ ...base, status: 'active', cancel_at_period_end: false })).toBeNull();
    expect(slotlockSubscriptionEnding({ ...base, status: 'canceled', cancel_at_period_end: true })).toBeNull();
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
    // Without Team prices, a price known only by its id is Developer.
    expect(slotlockPlanOfSubscription({ id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ price: 'price_team_year' }] } })).toMatchObject({ plan: 'developer' });
    // A Team price says so itself (scripts/configure-stripe.mjs): by its lookup key, its metadata or
    // its product's, so a Team price that replaced the configured ids still gives Team.
    const plain = (price: SlotlockStripePrice) =>
      slotlockPlanOfSubscription({ id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [{ price }] } }).plan;
    expect(plain({ id: 'price_new', lookup_key: 'slotlock_team_monthly' })).toBe('team');
    expect(plain({ id: 'price_new', metadata: { slotlock_plan: 'team' } })).toBe('team');
    expect(plain({ id: 'price_new', product: { id: 'prod_T', metadata: { slotlock_plan: 'team' } } })).toBe('team');
    expect(plain({ id: 'price_new', lookup_key: 'slotlock_developer_yearly', metadata: { slotlock_plan: 'developer' } })).toBe('developer');
    expect(slotlockPriceIsTeam({ id: 'price_new', product: 'prod_T' })).toBe(false);
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
      // Developer's own portal configuration: it switches between Developer's prices only.
      configuration: 'bpc_Developer1',
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

  it('opens no second Checkout while an unpaid subscription could still be paid', async () => {
    const unpaid: SlotlockStripeSubscription = { id: 'sub_Unpaid', status: 'unpaid', customer: 'cus_Owes' };
    const { stripe, calls } = fakeStripe(new Map([['sub_Unpaid', unpaid]]));
    const checkout = { tenantRef: 'github:43', interval: 'month' as const, customer: 'cus_Owes', successUrl: 'https://app.example.com/plan', cancelUrl: 'https://app.example.com/plan' };
    await expect(stripe.checkout(checkout)).rejects.toMatchObject({ code: 'subscription_exists', status: 409 });
    expect(calls.some((call) => call.url.endsWith('/v1/checkout/sessions'))).toBe(false);
    // An unpaid subscription gives no plan, though: it is not live.
    expect(await stripe.liveSubscriptionsOfCustomer('cus_Owes')).toEqual([]);
  });

  it("opens each plan's own portal configuration", async () => {
    const { stripe, calls } = fakeStripe(new Map());
    await stripe.portal({ customer: 'cus_A', returnUrl: 'https://app.example.com/plan' });
    await stripe.portal({ customer: 'cus_B', returnUrl: 'https://app.example.com/plan', plan: 'team' });
    const bodies = calls.filter((call) => call.url.endsWith('/v1/billing_portal/sessions')).map((call) => new URLSearchParams(call.body ?? ''));
    expect(bodies.map((body) => [body.get('customer'), body.get('configuration')])).toEqual([
      ['cus_A', 'bpc_Developer1'],
      ['cus_B', 'bpc_Team1'],
    ]);
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
    // Free, but still named: paying its invoice makes it live again, so the tenant is not erased
    // under it (erase_tenant and team deletion read the name).
    expect(await readSlotlockTenantPlan(sql, tenant)).toMatchObject({
      plan: 'free',
      status: 'canceled',
      stripeCustomer: 'cus_Paid1',
      stripeSubscription: 'sub_B2',
      currentPeriodEnd: null,
      limits: { resources: 10 },
    });
    expect(await readSlotlockTenantQuotas(sql, tenant, { overageStopPercent: 300 })).toMatchObject({ stopPercent: 100 });
    subscriptions.set('sub_B2', subscription('sub_B2', 'canceled'));
    await deliver({ data: { object: { object: 'subscription', id: 'sub_B2' } } });
    expect(await readSlotlockTenantPlan(sql, tenant)).toMatchObject({ plan: 'free', stripeCustomer: 'cus_Paid1', stripeSubscription: null });
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
      // Noted for the admin console too (RFC 0006, M4), once however often Stripe delivers it.
      await send('sub_T2');
      expect(await sql`SELECT kind, stripe_ref, detail FROM slotlock.billing_alerts WHERE tenant_ref = ${twice}`).toEqual([
        { kind: 'duplicate_subscription', stripe_ref: 'sub_T2', detail: { first: 'sub_T1' } },
      ]);

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

  it('notes a failed payment for the console, once, and clears it when the payment recovers', async () => {
    const late = `billing-late-${randomUUID()}`;
    // Stripe's ids are unique everywhere, so the alert is keyed by them alone.
    const invoice = `in_${randomUUID().replaceAll('-', '')}`;
    const owing = (status: string): SlotlockStripeSubscription => ({
      ...subscription('sub_L1', status),
      metadata: { tenant_ref: late },
    });
    try {
      subscriptions.set('sub_L1', owing('past_due'));
      const failed = {
        type: 'invoice.payment_failed',
        data: {
          object: {
            // As Stripe sends it at the pinned API version (2026-04-22.dahlia): since 2025-03-31.basil an
            // invoice names its subscription under parent.subscription_details, not `subscription`.
            object: 'invoice', id: invoice, amount_due: 500, currency: 'gbp',
            parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_L1' } },
            attempt_count: 2, customer_email: 'ada@example.com', customer_address: { line1: '1 Main St' },
          },
        },
      };
      expect((await deliver(failed)).status).toBe(200);
      expect((await deliver(failed)).status).toBe(200);
      expect(await readSlotlockTenantPlan(sql, late)).toMatchObject({ plan: 'developer', status: 'past_due' });
      const [alert] = await sql<{ kind: string; stripe_ref: string; detail: Record<string, unknown>; resolved_by: string | null }[]>`
        SELECT kind, stripe_ref, detail, resolved_by FROM slotlock.billing_alerts WHERE tenant_ref = ${late}`;
      expect(alert).toEqual({
        kind: 'payment_failed',
        stripe_ref: invoice,
        detail: { amount_due: 500, currency: 'gbp', attempt_count: 2, next_payment_attempt: null, subscription: 'sub_L1' },
        resolved_by: null,
      });
      // Never the customer's email or address.
      expect(JSON.stringify(alert)).not.toMatch(/ada@|Main St/);

      subscriptions.set('sub_L1', owing('active'));
      await deliver({
        type: 'invoice.paid',
        data: { object: { object: 'invoice', id: 'in_L2', parent: { subscription_details: { subscription: { id: 'sub_L1' } } } } },
      });
      expect((await sql`SELECT resolved_by FROM slotlock.billing_alerts WHERE tenant_ref = ${late}`)[0]?.resolved_by).toBe('stripe');
    } finally {
      // Erasure refuses a live subscription; the test's plan goes first.
      await sql`DELETE FROM slotlock.tenant_plans WHERE tenant_ref = ${late}`;
      await sql`SELECT * FROM slotlock.erase_tenant(${late}::text)`;
    }
  });

  it('keeps when a cancelled subscription ends, and whether it is in a trial, while it is the one the plan names', async () => {
    const ending = `billing-ending-${randomUUID()}`;
    const term = async () =>
      (await sql<{ ends_at: Date | null; trialing: boolean }[]>`
        SELECT ends_at, trialing FROM slotlock.tenant_plans WHERE tenant_ref = ${ending}`)[0];
    const theirs = (id: string, status: string, extra: Partial<SlotlockStripeSubscription> = {}): SlotlockStripeSubscription => ({
      ...subscription(id, status),
      metadata: { tenant_ref: ending },
      ...extra,
    });
    try {
      subscriptions.set('sub_E1', theirs('sub_E1', 'active'));
      await deliver({ data: { object: { object: 'subscription', id: 'sub_E1' } } });
      expect(await term()).toEqual({ ends_at: null, trialing: false });
      // Cancelled in the portal: active until the end of the period it was paid for.
      subscriptions.set('sub_E1', theirs('sub_E1', 'active', { cancel_at_period_end: true }));
      await deliver({ type: 'customer.subscription.updated', data: { object: { object: 'subscription', id: 'sub_E1' } } });
      expect(await term()).toEqual({ ends_at: new Date(Date.UTC(2026, 11, 9)), trialing: false });
      expect(await readSlotlockTenantPlan(sql, ending)).toMatchObject({ plan: 'developer', status: 'active' });
      // A date to cancel at, which Stripe sets apart from the period.
      subscriptions.set('sub_E1', theirs('sub_E1', 'active', { cancel_at: Math.floor(Date.UTC(2026, 11, 1) / 1000) }));
      await deliver({ data: { object: { object: 'subscription', id: 'sub_E1' } } });
      expect(await term()).toEqual({ ends_at: new Date(Date.UTC(2026, 11, 1)), trialing: false });
      // Renewing again.
      subscriptions.set('sub_E1', theirs('sub_E1', 'active'));
      await deliver({ data: { object: { object: 'subscription', id: 'sub_E1' } } });
      expect(await term()).toEqual({ ends_at: null, trialing: false });
      subscriptions.set('sub_E1', theirs('sub_E1', 'trialing', { cancel_at_period_end: true }));
      await deliver({ data: { object: { object: 'subscription', id: 'sub_E1' } } });
      expect(await term()).toEqual({ ends_at: new Date(Date.UTC(2026, 11, 9)), trialing: true });
      // The plan names another subscription (a Worker from before this release writes it so): what
      // was kept about the last one goes with it.
      await setSlotlockTenantPlan(sql, { tenantRef: ending, plan: 'developer', status: 'active', stripeCustomer: 'cus_Paid1', stripeSubscription: 'sub_E2' });
      expect(await term()).toEqual({ ends_at: null, trialing: false });
      // On a schema from before this release, the plan is set as before, and nothing else.
      subscriptions.set('sub_E2', theirs('sub_E2', 'active', { cancel_at_period_end: true }));
      const rolledBack = new Error('rolled back');
      const seen = await sql
        .begin(async (tx) => {
          await tx`DROP FUNCTION slotlock.set_tenant_plan_renewal(text, text, timestamptz, boolean)`;
          const body = JSON.stringify({ data: { object: { object: 'subscription', id: 'sub_E2' } } });
          const response = await handleSlotlockStripeWebhook(
            new Request('https://app.example.com/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': sign(body) }, body }),
            { secret: SECRET, stripe, sql: tx as unknown as typeof sql, now: () => NOW },
          );
          const [row] = await tx<{ ends_at: Date | null }[]>`SELECT ends_at FROM slotlock.tenant_plans WHERE tenant_ref = ${ending}`;
          throw Object.assign(rolledBack, { seen: { status: response.status, endsAt: row?.ends_at ?? null } });
        })
        .catch((error: unknown) => (error === rolledBack ? (error as { seen?: unknown }).seen : Promise.reject(error)));
      expect(seen).toEqual({ status: 200, endsAt: null });
      // Ended, with no other subscription live: the plan is Free, and nothing says it ends.
      subscriptions.set('sub_E1', theirs('sub_E1', 'canceled'));
      subscriptions.set('sub_E2', theirs('sub_E2', 'canceled'));
      await deliver({ data: { object: { object: 'subscription', id: 'sub_E2' } } });
      expect(await term()).toEqual({ ends_at: null, trialing: false });
    } finally {
      subscriptions.delete('sub_E1');
      subscriptions.delete('sub_E2');
      await sql`DELETE FROM slotlock.tenant_plans WHERE tenant_ref = ${ending}`;
      await sql`SELECT * FROM slotlock.erase_tenant(${ending}::text)`;
    }
  });

  it('notes a refund that left a plan running, for the account the refunded payment paid, once', async () => {
    // One Stripe customer who pays for two accounts (a person's own, and a team they bought for).
    const person = `billing-refunded-${randomUUID()}`;
    const team = `billing-refunded-team-${randomUUID()}`;
    const customer = `cus_Refund${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const errors: unknown[] = [];
    const charge = (id: string, paymentIntent: string | null, extra: Record<string, unknown> = {}) => ({
      id: `evt_${id}`,
      type: 'charge.refunded',
      // A Charge as Stripe's API reference describes it (read 2026-11-14): at this API version it
      // names no invoice, only the PaymentIntent that paid it. Billing details and card are never kept.
      data: {
        object: {
          object: 'charge', id, customer, payment_intent: paymentIntent, amount: 500, amount_refunded: 500, refunded: true, currency: 'gbp',
          billing_details: { email: 'ada@example.com', name: 'Ada Lovelace' }, payment_method_details: { card: { last4: '4242' } },
          ...extra,
        },
      },
    });
    const send = async (event: unknown) => {
      const body = JSON.stringify(event);
      const response = await handleSlotlockStripeWebhook(
        new Request('https://app.example.com/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': sign(body) }, body }),
        { secret: SECRET, stripe, sql, now: () => NOW, onError: (error) => errors.push(error) },
      );
      return { status: response.status, text: await response.text() };
    };
    const alerts = async () =>
      sql<{ tenant_ref: string; stripe_ref: string; detail: Record<string, unknown> }[]>`
        SELECT tenant_ref, stripe_ref, detail FROM slotlock.billing_alerts
         WHERE kind = 'refunded_plan_active' AND tenant_ref IN (${person}, ${team}) ORDER BY id`;
    const theirs = (id: string, tenant: string, status: string, extra: Partial<SlotlockStripeSubscription> = {}): SlotlockStripeSubscription => ({
      ...subscription(id, status),
      customer,
      metadata: { tenant_ref: tenant },
      ...extra,
    });
    try {
      // Not a customer of any plan yet: nothing to note.
      invoicePayments.set('pi_R0', ['sub_R1']);
      expect(await send(charge('ch_R0', 'pi_R0'))).toEqual({ status: 200, text: 'Ignored.' });
      subscriptions.set('sub_R1', theirs('sub_R1', person, 'active'));
      subscriptions.set('sub_R2', theirs('sub_R2', team, 'active'));
      await deliver({ data: { object: { object: 'subscription', id: 'sub_R1' } } });
      await deliver({ data: { object: { object: 'subscription', id: 'sub_R2' } } });

      // Refunded in full, and the plan it paid for still renews: that account alone needs a person.
      invoicePayments.set('pi_R1', ['sub_R1']);
      expect(await send(charge('ch_R1', 'pi_R1'))).toEqual({ status: 200, text: 'Noted.' });
      expect(await send(charge('ch_R1', 'pi_R1'))).toEqual({ status: 200, text: 'Noted.' });
      expect(await alerts()).toEqual([
        {
          tenant_ref: person,
          stripe_ref: 'ch_R1',
          detail: { amount: 500, amount_refunded: 500, currency: 'gbp', refunded: true, subscription: 'sub_R1' },
        },
      ]);
      expect(JSON.stringify(await alerts())).not.toMatch(/ada@|Lovelace|4242/);
      // One payment for both accounts' invoices: each account is told, under the same charge.
      invoicePayments.set('pi_RB', ['sub_R1', 'sub_R2']);
      await send(charge('ch_RB', 'pi_RB'));
      expect((await alerts()).filter((alert) => alert.stripe_ref === 'ch_RB').map((alert) => alert.tenant_ref).sort()).toEqual([person, team].sort());
      // Part of a charge refunded: noted too, saying how much.
      invoicePayments.set('pi_R2', ['sub_R2']);
      await send(charge('ch_R2', 'pi_R2', { amount_refunded: 200, refunded: false }));
      expect((await alerts()).at(-1)).toMatchObject({ tenant_ref: team, stripe_ref: 'ch_R2', detail: { amount_refunded: 200, refunded: false } });
      const noted = (await alerts()).length;

      // Cancelled in Stripe as it was refunded, before that event arrived: Stripe's word, not the
      // database's, decides, so nothing needs a person.
      subscriptions.set('sub_R1', theirs('sub_R1', person, 'active', { cancel_at_period_end: true }));
      invoicePayments.set('pi_R3', ['sub_R1']);
      await send(charge('ch_R3', 'pi_R3'));
      subscriptions.set('sub_R1', theirs('sub_R1', person, 'canceled'));
      await send(charge('ch_R4', 'pi_R3'));
      subscriptions.set('sub_R1', theirs('sub_R1', person, 'active'));
      // A payment of no subscription's invoice, or no payment to follow: nothing to match it to.
      invoicePayments.set('pi_R5', []);
      expect(await send(charge('ch_R5', 'pi_R5'))).toEqual({ status: 200, text: 'Ignored.' });
      expect(await send(charge('ch_R6', null))).toEqual({ status: 200, text: 'Ignored.' });
      // A subscription another customer's account holds is never told of this customer's refund.
      subscriptions.set('sub_Other', { ...subscription('sub_Other', 'active'), customer: 'cus_Someone', metadata: { tenant_ref: `billing-other-${randomUUID()}` } });
      invoicePayments.set('pi_R7', ['sub_Other']);
      expect(await send(charge('ch_R7', 'pi_R7'))).toEqual({ status: 200, text: 'Ignored.' });
      expect((await alerts()).length).toBe(noted);

      // A key that cannot read invoice payments: said once, and not retried for days.
      invoicePayments.set('pi_R8', 'refused');
      expect(await send(charge('ch_R8', 'pi_R8'))).toEqual({ status: 200, text: 'Ignored.' });
      expect(errors).toHaveLength(1);
      expect(String((errors[0] as Error).message)).toContain('403');
      // Not a charge, or not one Stripe could have sent: ignored. Unsigned: refused.
      expect((await send({ type: 'charge.refunded', data: { object: { object: 'charge', id: "ch_'; DROP", customer } } })).text).toBe('Ignored.');
      expect((await send({ type: 'charge.refunded', data: { object: { object: 'refund', id: 're_1', customer } } })).text).toBe('Ignored.');
      expect((await deliver(charge('ch_R9', 'pi_R1'), 't=1,v1=00')).status).toBe(400);
      expect((await alerts()).length).toBe(noted);
    } finally {
      subscriptions.delete('sub_R1');
      subscriptions.delete('sub_R2');
      subscriptions.delete('sub_Other');
      invoicePayments.clear();
      for (const tenant of [person, team]) {
        await sql`DELETE FROM slotlock.billing_alerts WHERE tenant_ref = ${tenant}`;
        await sql`DELETE FROM slotlock.tenant_plans WHERE tenant_ref = ${tenant}`;
        await sql`SELECT * FROM slotlock.erase_tenant(${tenant}::text)`;
      }
    }
  });

  it('notes no refund on a schema from before this release, which cannot say whose customer it is', async () => {
    const rolledBack = new Error('rolled back');
    const seen = await sql
      .begin(async (tx) => {
        await tx`DROP FUNCTION slotlock.tenant_plans_of_customer(text)`;
        const body = JSON.stringify({ type: 'charge.refunded', data: { object: { object: 'charge', id: 'ch_Old1', customer: 'cus_Paid1', amount: 500, amount_refunded: 500 } } });
        const response = await handleSlotlockStripeWebhook(
          new Request('https://app.example.com/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': sign(body) }, body }),
          { secret: SECRET, stripe, sql: tx as unknown as typeof sql, now: () => NOW },
        );
        throw Object.assign(rolledBack, { seen: { status: response.status, text: await response.text() } });
      })
      .catch((error: unknown) => (error === rolledBack ? (error as { seen?: unknown }).seen : Promise.reject(error)));
    expect(seen).toEqual({ status: 200, text: 'Ignored.' });
  });

  it('ignores events about nothing of ours, and asks Stripe to retry when it cannot read one', async () => {
    expect((await deliver({ data: { object: { object: 'customer', id: 'cus_1' } } })).status).toBe(200);
    expect((await deliver({ data: { object: { object: 'subscription', id: 'sub_Missing' } } })).status).toBe(500);
  });

  /** Delivers `event` as Stripe would, with what the webhook reports kept in `reported`. */
  const deliverTo = (
    event: unknown,
    reported: { erased: string[] },
    using: typeof stripe = stripe,
  ) => {
    const body = JSON.stringify(event);
    return handleSlotlockStripeWebhook(
      new Request('https://app.example.com/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': sign(body) }, body }),
      { secret: SECRET, stripe: using, sql, now: () => NOW, onErased: (id) => reported.erased.push(id) },
    );
  };
  const aboutInvoice = (subscriptionId: string) => ({
    type: 'invoice.paid',
    data: { object: { object: 'invoice', id: 'in_Late1', parent: { subscription_details: { subscription: subscriptionId } } } },
  });

  it('keeps a subscription Stripe can still revive on the plan, so its team is neither deleted nor erased under it', async () => {
    const person = `github:${String(800_000_000 + Math.floor(Math.random() * 90_000_000))}`;
    const handle = `owes-${randomUUID().slice(0, 8)}`;
    await sql`SELECT slotlock.dashboard_sign_in(${person}, NULL)`;
    const [made] = await sql<{ tenant_ref: string }[]>`SELECT tenant_ref FROM slotlock.create_team(${person}, 'Owes', ${handle}, NULL)`;
    const team = made?.tenant_ref as string;
    const reported = { erased: [] as string[] };
    const owed = (status: string): SlotlockStripeSubscription => ({
      id: 'sub_Owe1',
      status,
      customer: 'cus_Owe1',
      metadata: { tenant_ref: team },
      items: { data: [{ current_period_end: Math.floor(Date.UTC(2026, 11, 9) / 1000), price: { id: 'price_team_month' } }] },
    });
    const scheduled = async () =>
      (await sql<{ refusal: string | null }[]>`SELECT slotlock.schedule_team_deletion(${team}, ${person}, ${handle}) AS refusal`)[0]?.refusal;
    try {
      subscriptions.set('sub_Owe1', owed('active'));
      await deliverTo({ data: { object: { object: 'subscription', id: 'sub_Owe1' } } }, reported);
      expect(await readSlotlockTenantPlan(sql, team)).toMatchObject({ plan: 'team', stripeSubscription: 'sub_Owe1' });
      for (const status of ['unpaid', 'incomplete']) {
        subscriptions.set('sub_Owe1', owed(status));
        expect((await deliverTo({ data: { object: { object: 'invoice', id: 'in_Owe1', subscription: 'sub_Owe1' } } }, reported)).status).toBe(200);
        // Free limits, as the Terms say; but paying the invoice makes it live again, so it stays named.
        expect(await readSlotlockTenantPlan(sql, team), status).toMatchObject({
          plan: 'free',
          status: 'canceled',
          stripeSubscription: 'sub_Owe1',
          limits: { resources: 10 },
        });
        expect(await scheduled(), status).toBe('subscription_live');
        await expect(sql`SELECT * FROM slotlock.erase_tenant(${team}::text)`, status).rejects.toMatchObject({
          code: '55006',
          hint: 'billing_active',
        });
      }
      // Cancelled in Stripe, nothing can bill it again: the team is deleted, and erased when due.
      subscriptions.set('sub_Owe1', owed('canceled'));
      await deliverTo({ data: { object: { object: 'subscription', id: 'sub_Owe1' } } }, reported);
      expect(await readSlotlockTenantPlan(sql, team)).toMatchObject({ plan: 'free', stripeSubscription: null });
      expect(await scheduled()).toBeNull();
      await sql`UPDATE slotlock.workspaces SET delete_after = statement_timestamp() - interval '1 minute' WHERE tenant_ref = ${team}`;
      await sql`SELECT slotlock.erase_deleted_teams()`;
      expect(await sql`SELECT 1 FROM slotlock.workspaces WHERE tenant_ref = ${team}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM slotlock.tenant_plans WHERE tenant_ref = ${team}`).toHaveLength(0);

      // Whatever Stripe sends about it later writes nothing of the erased team back. One that can
      // still bill is reported (by its id only), for staff to cancel in Stripe.
      expect((await deliverTo(aboutInvoice('sub_Owe1'), reported)).status).toBe(200);
      subscriptions.set('sub_Owe1', owed('active'));
      expect((await deliverTo(aboutInvoice('sub_Owe1'), reported)).status).toBe(200);
      expect(await sql`SELECT 1 FROM slotlock.tenant_plans WHERE tenant_ref = ${team}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM slotlock.billing_alerts WHERE tenant_ref = ${team}`).toHaveLength(0);
      expect(reported.erased).toEqual(['sub_Owe1']);
    } finally {
      subscriptions.delete('sub_Owe1');
      await sql`DELETE FROM slotlock.tenant_plans WHERE tenant_ref = ${team}`;
      await sql`SELECT * FROM slotlock.erase_tenant(${team}::text)`;
      await sql`SELECT * FROM slotlock.erase_tenant(${person}::text)`;
    }
  });

  it("writes nothing back for an erased person, and reports a subscription of theirs that could still bill", async () => {
    const person = `github:${String(800_000_000 + Math.floor(Math.random() * 90_000_000))}`;
    const reported = { erased: [] as string[] };
    const theirs = (id: string, status: string): SlotlockStripeSubscription => ({
      id,
      status,
      customer: 'cus_Gone1',
      metadata: { tenant_ref: person },
      items: { data: [{ current_period_end: Math.floor(Date.UTC(2026, 11, 9) / 1000) }] },
    });
    try {
      await sql`SELECT slotlock.dashboard_sign_in(${person}, NULL)`;
      subscriptions.set('sub_Gone1', theirs('sub_Gone1', 'canceled'));
      await deliverTo({ data: { object: { object: 'subscription', id: 'sub_Gone1' } } }, reported);
      expect(await readSlotlockTenantPlan(sql, person)).toMatchObject({ plan: 'free', stripeCustomer: 'cus_Gone1', stripeSubscription: null });
      await sql`SELECT * FROM slotlock.erase_tenant(${person}::text)`;
      // A late event about the cancelled subscription: nothing to write, nothing to report.
      expect((await deliverTo(aboutInvoice('sub_Gone1'), reported)).status).toBe(200);
      // One bought just before the erasure, whose first event arrives after it: refused, and reported.
      subscriptions.set('sub_Gone2', theirs('sub_Gone2', 'active'));
      expect((await deliverTo({ data: { object: { object: 'subscription', id: 'sub_Gone2' } } }, reported)).status).toBe(200);
      expect(await readSlotlockTenantPlan(sql, person)).toBeNull();
      expect(await sql`SELECT 1 FROM slotlock.tenant_plans WHERE tenant_ref = ${person}`).toHaveLength(0);
      expect(reported.erased).toEqual(['sub_Gone2']);
      // Signed in again, the person is someone the service holds once more, and may buy a plan.
      await sql`SELECT slotlock.dashboard_sign_in(${person}, NULL)`;
      await deliverTo({ data: { object: { object: 'subscription', id: 'sub_Gone2' } } }, reported);
      expect(await readSlotlockTenantPlan(sql, person)).toMatchObject({ plan: 'developer', stripeSubscription: 'sub_Gone2' });
    } finally {
      subscriptions.delete('sub_Gone1');
      subscriptions.delete('sub_Gone2');
      await sql`DELETE FROM slotlock.tenant_plans WHERE tenant_ref = ${person}`;
      await sql`SELECT * FROM slotlock.erase_tenant(${person}::text)`;
    }
  });

  it('records whether the subscription carries the metered overage price, which alone lifts the stop', async () => {
    const metered = `billing-metered-${randomUUID()}`;
    const selling = fakeStripe(subscriptions, false, { overagePrice: 'price_overage' }).stripe;
    const reported = { erased: [] as string[] };
    const developer = (id: string, prices: string[], status = 'active'): SlotlockStripeSubscription => ({
      id,
      status,
      customer: 'cus_Metered1',
      metadata: { tenant_ref: metered },
      items: {
        data: prices.map((price) => ({ current_period_end: Math.floor(Date.UTC(2026, 11, 9) / 1000), price: { id: price } })),
      },
    });
    const stop = async () => (await readSlotlockTenantQuotas(sql, metered, { overageStopPercent: 300 }))?.stopPercent;
    try {
      // Bought before overage was sold: the Developer price alone. Refused past 110%, as before.
      subscriptions.set('sub_M1', developer('sub_M1', ['price_month']));
      await deliverTo({ data: { object: { object: 'subscription', id: 'sub_M1' } } }, reported, selling);
      expect(await readSlotlockTenantPlan(sql, metered)).toMatchObject({ plan: 'developer', status: 'active', stripeSubscription: 'sub_M1' });
      expect(await stop()).toBe(110);
      // The metered price added to it (Stripe sends customer.subscription.updated): its use past the
      // quota is billed, so it runs to the overage stop.
      subscriptions.set('sub_M1', developer('sub_M1', ['price_month', 'price_overage']));
      await deliverTo({ data: { object: { object: 'subscription', id: 'sub_M1' } } }, reported, selling);
      expect(await stop()).toBe(300);
      // Read by a Worker that sells no overage, it is not known to carry the price: 110% again.
      await deliverTo(aboutInvoice('sub_M1'), reported);
      expect(await stop()).toBe(110);
      await deliverTo(aboutInvoice('sub_M1'), reported, selling);
      expect(await stop()).toBe(300);
      // A plan written for another subscription (as a Worker from before this release writes it)
      // never keeps the last one's price.
      await setSlotlockTenantPlan(sql, {
        tenantRef: metered,
        plan: 'developer',
        status: 'active',
        stripeCustomer: 'cus_Metered1',
        stripeSubscription: 'sub_M2',
      });
      expect(await stop()).toBe(110);
      // Unpaid: Free, whatever its items.
      subscriptions.set('sub_M1', developer('sub_M1', ['price_month', 'price_overage'], 'unpaid'));
      await sql`UPDATE slotlock.tenant_plans SET stripe_subscription = 'sub_M1' WHERE tenant_ref = ${metered}`;
      await deliverTo(aboutInvoice('sub_M1'), reported, selling);
      expect(await stop()).toBe(100);
    } finally {
      subscriptions.delete('sub_M1');
      await sql`DELETE FROM slotlock.tenant_plans WHERE tenant_ref = ${metered}`;
      await sql`SELECT * FROM slotlock.erase_tenant(${metered}::text)`;
    }
  });
});
