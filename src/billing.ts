// Hosted Slotlock's billing through Stripe: Checkout (with Managed Payments, Stripe as merchant of
// record) to start a Developer subscription, the customer portal to manage one, and the webhook that
// keeps a tenant's plan (plans.ts) in step with its subscription. Plain fetch, so it runs on a
// Worker. Self-hosted Slotlock never uses it.
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type SlotlockPlan,
  type SlotlockPlanStatus,
  readSlotlockTenantPlan,
  setSlotlockTenantPlan,
} from './plans.js';
import type { SlotlockSql } from './store.js';

export type SlotlockBillingInterval = 'month' | 'year';

/**
 * Stripe answered with an error, or did not answer, or (`subscription_exists`) the customer already
 * pays for a subscription. The message never holds the key.
 */
export class SlotlockBillingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: 'subscription_exists',
  ) {
    super(message);
    this.name = 'SlotlockBillingError';
  }
}

/**
 * The Stripe-Version every request sends unless `apiVersion` says otherwise: Managed Payments needs
 * 2025-03-31.basil or later and became generally available in this one (docs.stripe.com changelog,
 * read 2026-11-09). Pinned, so the account's default version never changes what is sent or read.
 */
export const SLOTLOCK_STRIPE_API_VERSION = '2026-04-22.dahlia';

export interface SlotlockStripeOptions {
  /** A restricted key: write on Checkout Sessions and portal sessions, read on Subscriptions. */
  secretKey: string;
  /** The Developer plan's price ids, monthly and yearly. */
  prices: Readonly<Record<SlotlockBillingInterval, string>>;
  /** Sent as Stripe-Version; SLOTLOCK_STRIPE_API_VERSION when unset. */
  apiVersion?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The parts of a Stripe subscription the plan is read from. */
export interface SlotlockStripeSubscription {
  id: string;
  status: string;
  customer: string | { id: string };
  metadata?: Record<string, string>;
  current_period_end?: number | null;
  items?: { data?: Array<{ current_period_end?: number | null }> };
}

export interface SlotlockStripe {
  /** A Checkout URL for a Developer subscription, tagged with the tenant. */
  checkout(input: {
    tenantRef: string;
    interval: SlotlockBillingInterval;
    customer: string | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string>;
  /** A customer portal URL, to change or cancel the subscription and see invoices. */
  portal(input: { customer: string; returnUrl: string }): Promise<string>;
  subscription(id: string): Promise<SlotlockStripeSubscription>;
  /** The customer's subscriptions that give a plan (`active`, `trialing`, `past_due`). */
  liveSubscriptionsOfCustomer(customer: string): Promise<SlotlockStripeSubscription[]>;
  /**
   * The tenant's subscriptions that give a plan, found by their `tenant_ref` metadata under any
   * customer (Stripe's search, which can lag a minute behind a subscription just created).
   */
  liveSubscriptionsOfTenant(tenantRef: string): Promise<SlotlockStripeSubscription[]>;
}

/** Statuses in which a subscription gives its tenant the Developer plan (slotlockPlanOfSubscription). */
const LIVE = new Set(['active', 'trialing', 'past_due']);

/** Whether the subscription gives its tenant a plan. */
export function slotlockSubscriptionIsLive(subscription: SlotlockStripeSubscription): boolean {
  return LIVE.has(subscription.status);
}

const STRIPE_ID = /^[A-Za-z0-9_]{1,255}$/;
/** A tenant reference as Stripe's search may quote it: no quote, backslash or control character. */
const SEARCHABLE = /^[^'"\\\p{Cc}]{1,500}$/u;

export function createSlotlockStripe(options: SlotlockStripeOptions): SlotlockStripe {
  const base = options.apiBase ?? 'https://api.stripe.com';
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: URLSearchParams): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.secretKey}`,
      'stripe-version': options.apiVersion ?? SLOTLOCK_STRIPE_API_VERSION,
    };
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method,
        headers,
        ...(body ? { body: body.toString() } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SlotlockBillingError('Stripe did not answer');
    }
    const parsed = (await response.json().catch(() => null)) as
      | (T & { error?: { type?: string; code?: string } })
      | null;
    if (!response.ok || !parsed) {
      const reason = [parsed?.error?.type, parsed?.error?.code].filter(Boolean).join(': ');
      throw new SlotlockBillingError(
        `Stripe refused ${method} ${path.split('?')[0]} (${String(response.status)}${reason ? `, ${reason}` : ''})`,
        response.status,
      );
    }
    return parsed;
  }

  async function liveSubscriptionsOfCustomer(customer: string): Promise<SlotlockStripeSubscription[]> {
    if (!STRIPE_ID.test(customer)) throw new SlotlockBillingError('Not a customer id');
    // Without a status, Stripe lists every subscription that is not canceled.
    const page = await call<{ data?: SlotlockStripeSubscription[] }>(
      'GET',
      `/v1/subscriptions?${new URLSearchParams({ customer, limit: '100' }).toString()}`,
    );
    return (page.data ?? []).filter(slotlockSubscriptionIsLive);
  }

  return {
    async checkout({ tenantRef, interval, customer, successUrl, cancelUrl }) {
      // A customer who already pays changes the plan in the portal: a second Checkout would charge
      // twice for one tenant. (A first purchase has no customer yet; the webhook catches that case.)
      if (customer && (await liveSubscriptionsOfCustomer(customer)).length > 0) {
        throw new SlotlockBillingError('The customer has a live subscription already', 409, 'subscription_exists');
      }
      const form = new URLSearchParams({
        mode: 'subscription',
        'line_items[0][price]': options.prices[interval],
        'line_items[0][quantity]': '1',
        'managed_payments[enabled]': 'true',
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: tenantRef.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200),
        'metadata[tenant_ref]': tenantRef,
        'subscription_data[metadata][tenant_ref]': tenantRef,
      });
      if (customer) form.set('customer', customer);
      const session = await call<{ url?: string }>('POST', '/v1/checkout/sessions', form);
      if (!session.url) throw new SlotlockBillingError('Stripe gave no Checkout URL');
      return session.url;
    },
    async portal({ customer, returnUrl }) {
      const session = await call<{ url?: string }>(
        'POST',
        '/v1/billing_portal/sessions',
        new URLSearchParams({ customer, return_url: returnUrl }),
      );
      if (!session.url) throw new SlotlockBillingError('Stripe gave no portal URL');
      return session.url;
    },
    async subscription(id) {
      if (!STRIPE_ID.test(id)) throw new SlotlockBillingError('Not a subscription id');
      return call<SlotlockStripeSubscription>('GET', `/v1/subscriptions/${id}`);
    },
    liveSubscriptionsOfCustomer,
    async liveSubscriptionsOfTenant(tenantRef) {
      if (!SEARCHABLE.test(tenantRef)) throw new SlotlockBillingError('Not a searchable tenant');
      const page = await call<{ data?: SlotlockStripeSubscription[] }>(
        'GET',
        `/v1/subscriptions/search?${new URLSearchParams({
          query: `metadata['tenant_ref']:'${tenantRef}'`,
          limit: '100',
        }).toString()}`,
      );
      return (page.data ?? []).filter(
        (found) => slotlockSubscriptionIsLive(found) && found.metadata?.tenant_ref === tenantRef,
      );
    },
  };
}

/**
 * Whether a webhook's body was signed by Stripe with this endpoint's secret
 * (docs.stripe.com/webhooks#verify-manually): `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`,
 * any v1 matching, within `toleranceSeconds` of now.
 */
export function verifySlotlockStripeSignature(
  body: string,
  header: string | null,
  secret: string,
  nowMs: number,
  toleranceSeconds = 300,
): boolean {
  if (!header || !secret) return false;
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't' && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) signatures.push(value);
  }
  if (timestamp === undefined || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${String(timestamp)}.${body}`).digest();
  return signatures.some((signature) =>
    timingSafeEqual(Buffer.from(signature, 'hex'), expected),
  );
}

/** The plan a subscription gives its tenant. */
export function slotlockPlanOfSubscription(subscription: SlotlockStripeSubscription): {
  plan: SlotlockPlan;
  status: SlotlockPlanStatus;
} {
  switch (subscription.status) {
    case 'active':
    case 'trialing':
      return { plan: 'developer', status: 'active' };
    case 'past_due':
      // Stripe is retrying the payment: keep the plan while it does.
      return { plan: 'developer', status: 'past_due' };
    default:
      // canceled, unpaid, incomplete, incomplete_expired, paused: the Free limits.
      return { plan: 'free', status: 'canceled' };
  }
}

/** The subscription a webhook event is about, if any. */
function subscriptionOf(event: unknown): string | null {
  const object = (event as { data?: { object?: Record<string, unknown> } })?.data?.object;
  if (!object) return null;
  if (object.object === 'subscription' && typeof object.id === 'string') return object.id;
  const field = object.subscription;
  if (typeof field === 'string') return field;
  if (field && typeof (field as { id?: unknown }).id === 'string') return (field as { id: string }).id;
  return null;
}

/**
 * Handles one Stripe webhook delivery: checks its signature, then, for any event about a
 * subscription, reads that subscription from Stripe (not the event, which may be stale or arrive out
 * of order) and sets its tenant's plan. A tenant that bought twice (two tabs, before either webhook
 * arrived) keeps Developer until its last live subscription ends, and the second purchase is
 * reported through `onDuplicate`, by subscription ids only, for a refund. Answers 400 to an unsigned
 * or unreadable body, 500 when Stripe or the database fails (Stripe retries), and 200 otherwise.
 */
export async function handleSlotlockStripeWebhook(
  request: Request,
  deps: {
    secret: string;
    stripe: SlotlockStripe;
    sql: SlotlockSql;
    now?: () => number;
    onError?: (error: unknown) => void;
    onDuplicate?: (subscriptionIds: readonly string[]) => void;
  },
): Promise<Response> {
  const text = (status: number, body: string) =>
    new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (request.method !== 'POST') return text(405, 'Use POST.');
  if (Number(request.headers.get('content-length') ?? 0) > 1_000_000) return text(413, 'Too large.');
  const body = await request.text();
  if (body.length > 1_000_000) return text(413, 'Too large.');
  const signed = verifySlotlockStripeSignature(
    body,
    request.headers.get('stripe-signature'),
    deps.secret,
    (deps.now ?? Date.now)(),
  );
  if (!signed) return text(400, 'Bad signature.');
  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return text(400, 'Not JSON.');
  }
  const id = subscriptionOf(event);
  if (!id) return text(200, 'Ignored.');
  try {
    const subscription = await deps.stripe.subscription(id);
    const tenantRef = subscription.metadata?.tenant_ref;
    // Not one of the dashboard's: nothing to set.
    if (!tenantRef) return text(200, 'Ignored.');
    const current = await readSlotlockTenantPlan(deps.sql, tenantRef);
    const named = current?.stripeSubscription ?? null;
    let chosen = subscription;
    if (!slotlockSubscriptionIsLive(subscription)) {
      // An ended subscription only ends the plan it gave: not one the tenant has started since.
      if (named && named !== subscription.id) return text(200, 'Ignored.');
      // Nor one the tenant still pays for under another subscription.
      const other = (await deps.stripe.liveSubscriptionsOfTenant(tenantRef)).find(
        (found) => found.id !== subscription.id,
      );
      if (other) chosen = other;
    } else if (named && named !== subscription.id) {
      const previous = await deps.stripe.subscription(named).catch(() => null);
      if (previous && slotlockSubscriptionIsLive(previous)) deps.onDuplicate?.([previous.id, subscription.id]);
    }
    const { plan, status } = slotlockPlanOfSubscription(chosen);
    const customer = typeof chosen.customer === 'string' ? chosen.customer : chosen.customer.id;
    const end = chosen.items?.data?.[0]?.current_period_end ?? chosen.current_period_end ?? null;
    await setSlotlockTenantPlan(deps.sql, {
      tenantRef,
      plan,
      status,
      stripeCustomer: customer,
      stripeSubscription: plan === 'free' ? null : chosen.id,
      currentPeriodEnd: plan === 'free' || !end ? null : new Date(end * 1000),
    });
    return text(200, 'Updated.');
  } catch (error) {
    deps.onError?.(error);
    return text(500, 'Try again.');
  }
}
