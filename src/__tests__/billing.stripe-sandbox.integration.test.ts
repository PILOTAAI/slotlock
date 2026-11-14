// Billing against Stripe itself, in a sandbox: the prices, portal configurations and Checkout
// sessions scripts/configure-stripe.mjs sets up, and every event a subscription's life sends,
// signed and fed to the dashboard's webhook (billing.ts) with real Postgres. Stripe test clocks
// stand in for the months: a renewal that fails and recovers, a switch to yearly, cancelling at the
// end of the period, and the same for Team; and a refund that leaves a plan running.
//
// Runs only with a sandbox key and a database; it refuses a live key:
//   SLOTLOCK_STRIPE_SANDBOX_KEY=sk_test_… DATABASE_URL=… npx vitest run src/__tests__/billing.stripe-sandbox.integration.test.ts
// Run scripts/configure-stripe.mjs on the sandbox first. Everything made here is on one test clock,
// deleted at the end with its customers and subscriptions.
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SLOTLOCK_STRIPE_API_VERSION,
  type SlotlockStripe,
  createSlotlockStripe,
  handleSlotlockStripeWebhook,
  slotlockPlanOfSubscription,
} from '../billing.js';
import { readSlotlockTenantPlan } from '../plans.js';
import { createSlotlockStore } from '../store.js';

const KEY = process.env.SLOTLOCK_STRIPE_SANDBOX_KEY?.trim();
const DATABASE = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
if (KEY && !/^(sk|rk)_test_/.test(KEY)) throw new Error('SLOTLOCK_STRIPE_SANDBOX_KEY must be a test-mode key (sk_test_… or rk_test_…)');

const SECRET = 'whsec_sandbox_test_only';
const STEP = 600_000;
const DAY = 86_400;
const TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
];

// biome-ignore lint/suspicious/noExplicitAny: Stripe's objects, read field by field below.
type StripeObject = Record<string, any>;
interface StripeEvent {
  id: string;
  type: string;
  created: number;
  api_version: string;
  data: { object: StripeObject };
}

async function api(method: string, path: string, body?: Record<string, string>): Promise<StripeObject> {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      'stripe-version': SLOTLOCK_STRIPE_API_VERSION,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: new URLSearchParams(body).toString() } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await response.json()) as StripeObject;
  if (!response.ok) throw new Error(`Stripe answered ${response.status} to ${method} /v1/${path.split('?')[0]}: ${json.error?.message}`);
  return json;
}

async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 240_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

describe.skipIf(!KEY || !DATABASE)('billing against the Stripe sandbox', () => {
  let sql: ReturnType<typeof postgres>;
  let stripe: SlotlockStripe;
  let clock: StripeObject;
  const prices: Record<string, string> = {};
  const portals: Record<string, StripeObject> = {};
  const tenants: string[] = [];
  const delivered = new Set<string>();
  const errors: unknown[] = [];

  beforeAll(async () => {
    sql = postgres(DATABASE as string, { max: 2, onnotice: () => {} });
    const owner = createSlotlockStore(sql);
    await owner.applySchema();
    await owner.applyTenantRls();
    const found = await api(
      'GET',
      `prices?active=true&limit=10&${['developer_monthly', 'developer_yearly', 'team_monthly', 'team_yearly'].map((name) => `lookup_keys[]=slotlock_${name}`).join('&')}`,
    );
    for (const price of found.data) prices[price.lookup_key] = price.id;
    if (Object.keys(prices).length !== 4) throw new Error('Run scripts/configure-stripe.mjs on the sandbox first: the four prices are not all there.');
    const configurations = await api('GET', 'billing_portal/configurations?active=true&limit=100&expand[]=data.features.subscription_update.products');
    for (const configuration of configurations.data) {
      if (configuration.metadata?.slotlock_plan) portals[configuration.metadata.slotlock_plan] = configuration;
    }
    if (!portals.developer || !portals.team) throw new Error('Run scripts/configure-stripe.mjs on the sandbox first: a plan has no portal configuration.');
    stripe = createSlotlockStripe({
      secretKey: KEY as string,
      prices: { month: price('developer_monthly'), year: price('developer_yearly') },
      teamPrices: { month: price('team_monthly'), year: price('team_yearly') },
      portalConfigurations: { developer: portals.developer.id, team: portals.team.id },
      timeoutMs: 60_000,
    });
    clock = await api('POST', 'test_helpers/test_clocks', {
      frozen_time: String(Math.floor(Date.now() / 1000)),
      name: 'Slotlock billing test',
    });
  }, STEP);

  afterAll(async () => {
    // Deleting the clock deletes its customers and their subscriptions.
    if (clock?.id) await api('DELETE', `test_helpers/test_clocks/${clock.id}`).catch(() => {});
    for (const tenant of tenants) {
      await sql`DELETE FROM slotlock.tenant_plans WHERE tenant_ref = ${tenant}`;
      await sql`SELECT * FROM slotlock.erase_tenant(${tenant}::text)`;
    }
    await sql?.end();
  }, STEP);

  const price = (name: string) => {
    const id = prices[`slotlock_${name}`];
    if (!id) throw new Error(`No price slotlock_${name}`);
    return id;
  };

  const tenant = (kind: string) => {
    const ref = `stripe-sandbox-${kind}-${randomUUID()}`;
    tenants.push(ref);
    return ref;
  };

  const deliver = async (event: unknown) => {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', SECRET).update(`${String(t)}.${body}`).digest('hex');
    const response = await handleSlotlockStripeWebhook(
      new Request('https://app.example.com/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${String(t)},v1=${v1}` }, body }),
      { secret: SECRET, stripe, sql, onError: (error) => errors.push(error) },
    );
    return { status: response.status, text: await response.text() };
  };

  /** Waits for Stripe's event of this type about the customer, then delivers every new one, oldest first. */
  const settle = async (customer: string, type: string, match: (event: StripeEvent) => boolean = () => true) => {
    const events = await until(`${type} for ${customer}`, async () => {
      const page = await api('GET', `events?limit=100&${TYPES.map((name) => `types[]=${name}`).join('&')}`);
      const ours = (page.data as StripeEvent[]).filter((event) => event.data.object.customer === customer && !delivered.has(event.id));
      return ours.some((event) => event.type === type && match(event)) ? ours.sort((a, b) => a.created - b.created) : null;
    });
    for (const event of events) {
      delivered.add(event.id);
      // As Stripe renders it at the account's default API version, and at the pinned one, as the
      // webhook endpoint (configure-stripe.mjs) receives it. A refund is noted, not a plan set.
      const answer = event.type === 'charge.refunded' ? 'Noted.' : 'Updated.';
      expect(await deliver(event), `${event.type} at ${event.api_version}`).toEqual({ status: 200, text: answer });
      const object = event.data.object;
      const path = object.object === 'invoice' ? `invoices/${object.id}` : object.object === 'subscription' ? `subscriptions/${object.id}` : null;
      if (path) {
        const pinned = { ...event, api_version: SLOTLOCK_STRIPE_API_VERSION, data: { object: await api('GET', path) } };
        expect(await deliver(pinned), `${event.type} at ${SLOTLOCK_STRIPE_API_VERSION}`).toEqual({ status: 200, text: 'Updated.' });
      }
    }
    return events;
  };

  const advance = async (to: number) => {
    await api('POST', `test_helpers/test_clocks/${clock.id}/advance`, { frozen_time: String(to) });
    await until('the test clock', async () => (await api('GET', `test_helpers/test_clocks/${clock.id}`)).status === 'ready');
  };

  const customer = async (paymentMethod = 'pm_card_visa') => {
    const made = await api('POST', 'customers', { name: 'Slotlock billing test', test_clock: clock.id });
    await pay(made.id, paymentMethod);
    return made.id as string;
  };
  const pay = async (customerId: string, token: string) => {
    const method = await api('POST', `payment_methods/${token}/attach`, { customer: customerId });
    await api('POST', `customers/${customerId}`, { 'invoice_settings[default_payment_method]': method.id });
  };

  it('has each plan in pounds, and a portal that switches within its own plan only', async () => {
    const amounts = await Promise.all(Object.values(prices).map((id) => api('GET', `prices/${id}`)));
    expect(amounts.map((price) => [price.lookup_key, price.unit_amount, price.currency, price.recurring.interval]).sort()).toEqual([
      ['slotlock_developer_monthly', 500, 'gbp', 'month'],
      ['slotlock_developer_yearly', 5000, 'gbp', 'year'],
      ['slotlock_team_monthly', 1500, 'gbp', 'month'],
      ['slotlock_team_yearly', 15000, 'gbp', 'year'],
    ]);
    for (const [plan, configuration] of Object.entries(portals)) {
      const update = configuration.features.subscription_update;
      expect(update.enabled).toBe(true);
      expect(update.proration_behavior).toBe('always_invoice');
      expect(update.products).toHaveLength(1);
      expect([...update.products[0].prices].sort()).toEqual([prices[`slotlock_${plan}_monthly`], prices[`slotlock_${plan}_yearly`]].sort());
      expect(update.products[0].adjustable_quantity.enabled).toBe(false);
      expect(configuration.features.subscription_cancel.mode).toBe('at_period_end');
    }
  }, STEP);

  it('opens Checkout with Managed Payments for each plan, at its price in pounds', async () => {
    const base = 'https://app.example.com/dashboard/plan';
    for (const [plan, interval, amount] of [
      ['developer', 'month', 500],
      ['team', 'year', 15000],
    ] as const) {
      const ref = tenant(`checkout-${plan}`);
      const url = await stripe.checkout({ tenantRef: ref, interval, plan, customer: null, successUrl: base, cancelUrl: base });
      const id = /\/(cs_test_[A-Za-z0-9]+)/.exec(url)?.[1];
      expect(id, url).toBeDefined();
      const session = await api('GET', `checkout/sessions/${id}`);
      expect(session).toMatchObject({ mode: 'subscription', currency: 'gbp', amount_subtotal: amount, metadata: { tenant_ref: ref } });
      await api('POST', `checkout/sessions/${id}/expire`);
    }
  }, STEP);

  it("gives Developer for a Developer subscription's whole life: renewal failing and recovering, yearly, cancelled", async () => {
    const ref = tenant('developer');
    const buyer = await customer();
    const subscription = await api('POST', 'subscriptions', {
      customer: buyer,
      'items[0][price]': price('developer_monthly'),
      'metadata[tenant_ref]': ref,
    });
    expect(subscription.status).toBe('active');
    await settle(buyer, 'invoice.paid');
    const started = await readSlotlockTenantPlan(sql, ref);
    expect(started).toMatchObject({ plan: 'developer', status: 'active', stripeCustomer: buyer, stripeSubscription: subscription.id });
    const periodEnd = subscription.items.data[0].current_period_end as number;
    expect(started?.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000);

    // A second Checkout for a customer who pays already is refused; the portal opens in Developer's.
    await expect(
      stripe.checkout({ tenantRef: ref, interval: 'year', customer: buyer, successUrl: 'https://app.example.com/', cancelUrl: 'https://app.example.com/' }),
    ).rejects.toMatchObject({ code: 'subscription_exists', status: 409 });
    expect(await stripe.portal({ customer: buyer, returnUrl: 'https://app.example.com/dashboard/plan', plan: 'developer' })).toMatch(
      /^https:\/\/billing\.stripe\.com\//,
    );

    // The renewal fails: the plan carries on, past due, and the people who run the service are told.
    await pay(buyer, 'pm_card_chargeCustomerFail');
    await advance(periodEnd + 2 * 3600);
    const failed = await settle(buyer, 'invoice.payment_failed');
    expect(await readSlotlockTenantPlan(sql, ref)).toMatchObject({ plan: 'developer', status: 'past_due' });
    const invoice = failed.find((event) => event.type === 'invoice.payment_failed')?.data.object as StripeObject;
    const [alert] = await sql<{ kind: string; detail: Record<string, unknown>; resolved_by: string | null }[]>`
      SELECT kind, detail, resolved_by FROM slotlock.billing_alerts WHERE tenant_ref = ${ref} AND stripe_ref = ${invoice.id}`;
    expect(alert).toMatchObject({ kind: 'payment_failed', detail: { amount_due: 500, currency: 'gbp', subscription: subscription.id }, resolved_by: null });

    // A good card pays it: active again, and the alert is closed.
    await pay(buyer, 'pm_card_visa');
    await api('POST', `invoices/${invoice.id}/pay`);
    await settle(buyer, 'invoice.paid', (event) => event.data.object.id === invoice.id);
    expect(await readSlotlockTenantPlan(sql, ref)).toMatchObject({ plan: 'developer', status: 'active' });
    expect((await sql`SELECT resolved_by FROM slotlock.billing_alerts WHERE tenant_ref = ${ref}`)[0]?.resolved_by).toBe('stripe');

    // To yearly, as the portal does it: charged at once, less what is left of the month.
    const current = await api('GET', `subscriptions/${subscription.id}`);
    const yearly = await api('POST', `subscriptions/${subscription.id}`, {
      'items[0][id]': current.items.data[0].id,
      'items[0][price]': price('developer_yearly'),
      proration_behavior: 'always_invoice',
    });
    await settle(buyer, 'invoice.paid', (event) => event.data.object.billing_reason === 'subscription_update');
    const year = yearly.items.data[0].current_period_end as number;
    expect(year - (clock.frozen_time as number)).toBeGreaterThan(360 * DAY);
    expect(await readSlotlockTenantPlan(sql, ref)).toMatchObject({ plan: 'developer', status: 'active', stripeSubscription: subscription.id });
    expect((await readSlotlockTenantPlan(sql, ref))?.currentPeriodEnd?.getTime()).toBe(year * 1000);

    // Cancelled in the portal: the plan runs to the end of the year paid for, then returns to Free.
    await api('POST', `subscriptions/${subscription.id}`, { cancel_at_period_end: 'true' });
    await settle(buyer, 'customer.subscription.updated', (event) => event.data.object.cancel_at_period_end === true);
    expect(await readSlotlockTenantPlan(sql, ref)).toMatchObject({ plan: 'developer', status: 'active' });
    await advance(year + 3600);
    await settle(buyer, 'customer.subscription.deleted');
    expect(await readSlotlockTenantPlan(sql, ref)).toMatchObject({ plan: 'free', stripeSubscription: null, currentPeriodEnd: null });
    expect(errors).toEqual([]);
  }, STEP);

  it('notes a refund that left the plan running, from the Charge Stripe sends', async () => {
    const ref = tenant('refund');
    const buyer = await customer();
    const subscription = await api('POST', 'subscriptions', {
      customer: buyer,
      'items[0][price]': price('developer_monthly'),
      'metadata[tenant_ref]': ref,
    });
    await settle(buyer, 'invoice.paid');
    expect(await readSlotlockTenantPlan(sql, ref)).toMatchObject({ plan: 'developer', status: 'active', stripeCustomer: buyer });

    // The first invoice's charge, refunded in full as staff refund one in Stripe's dashboard. The
    // fields the webhook reads (billing.ts refundedChargeOf), as Stripe's API reference has them
    // (read 2026-11-14): a Charge's customer, payment_intent, amount, amount_refunded, currency and
    // refunded (no invoice at this API version), and a Refund's charge.
    const [paid] = (await api('GET', `charges?customer=${buyer}&limit=1`)).data as StripeObject[];
    expect(paid).toMatchObject({ object: 'charge', customer: buyer, amount: 500, amount_refunded: 0, currency: 'gbp', refunded: false });
    expect(paid?.id).toMatch(/^(ch|py)_[A-Za-z0-9]+$/);
    expect(paid?.payment_intent).toMatch(/^pi_[A-Za-z0-9]+$/);
    expect(paid).not.toHaveProperty('invoice');
    // The payment's invoice payments name the invoice it paid, and that invoice the subscription.
    expect(await stripe.paidSubscriptions?.(paid?.payment_intent as string)).toEqual([subscription.id]);
    const refund = await api('POST', 'refunds', { charge: paid?.id });
    expect(refund).toMatchObject({ object: 'refund', charge: paid?.id, amount: 500, currency: 'gbp' });

    const events = await settle(buyer, 'charge.refunded');
    const sent = events.find((event) => event.type === 'charge.refunded')?.data.object as StripeObject;
    expect(sent).toMatchObject({ object: 'charge', id: paid?.id, customer: buyer, amount: 500, amount_refunded: 500, refunded: true, currency: 'gbp' });
    // The plan still renews: a person ends it, or says why not.
    expect(await readSlotlockTenantPlan(sql, ref)).toMatchObject({ plan: 'developer', status: 'active' });
    const alerts = await sql<{ kind: string; detail: Record<string, unknown> }[]>`
      SELECT kind, detail FROM slotlock.billing_alerts WHERE tenant_ref = ${ref} AND stripe_ref = ${paid?.id as string}`;
    expect(alerts).toEqual([
      {
        kind: 'refunded_plan_active',
        detail: { amount: 500, amount_refunded: 500, currency: 'gbp', refunded: true, subscription: subscription.id },
      },
    ]);
    await sql`DELETE FROM slotlock.billing_alerts WHERE tenant_ref = ${ref}`;
    await api('DELETE', `subscriptions/${subscription.id}`);
    await settle(buyer, 'customer.subscription.deleted');
    expect(await readSlotlockTenantPlan(sql, ref)).toMatchObject({ plan: 'free', stripeSubscription: null });
    expect(errors).toEqual([]);
  }, STEP);

  it('gives Team for a Team subscription, by its price even without the configured ids', async () => {
    const ref = tenant('team');
    const buyer = await customer();
    const subscription = await api('POST', 'subscriptions', {
      customer: buyer,
      'items[0][price]': price('team_monthly'),
      'metadata[tenant_ref]': ref,
    });
    await settle(buyer, 'invoice.paid');
    expect(await readSlotlockTenantPlan(sql, ref)).toMatchObject({ plan: 'team', status: 'active', stripeSubscription: subscription.id });
    // The price says it is Team's itself (lookup key and metadata), so Team survives new price ids.
    expect(slotlockPlanOfSubscription((await api('GET', `subscriptions/${subscription.id}`)) as never)).toMatchObject({ plan: 'team' });
    expect(await stripe.portal({ customer: buyer, returnUrl: 'https://app.example.com/dashboard/plan', plan: 'team' })).toMatch(
      /^https:\/\/billing\.stripe\.com\//,
    );

    const current = await api('GET', `subscriptions/${subscription.id}`);
    await api('POST', `subscriptions/${subscription.id}`, {
      'items[0][id]': current.items.data[0].id,
      'items[0][price]': price('team_yearly'),
      proration_behavior: 'always_invoice',
    });
    await settle(buyer, 'invoice.paid', (event) => event.data.object.billing_reason === 'subscription_update');
    expect(await readSlotlockTenantPlan(sql, ref)).toMatchObject({ plan: 'team', status: 'active' });

    await api('DELETE', `subscriptions/${subscription.id}`);
    await settle(buyer, 'customer.subscription.deleted');
    expect(await readSlotlockTenantPlan(sql, ref)).toMatchObject({ plan: 'free', stripeSubscription: null });
    expect(errors).toEqual([]);
  }, STEP);
});
