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

/** Stripe answered with an error, or did not answer. The message never holds the key. */
export class SlotlockBillingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SlotlockBillingError';
  }
}

export interface SlotlockStripeOptions {
  /** A restricted key: write on Checkout Sessions and portal sessions, read on Subscriptions. */
  secretKey: string;
  /** The Developer plan's price ids, monthly and yearly. */
  prices: Readonly<Record<SlotlockBillingInterval, string>>;
  /** Sent as Stripe-Version; the account's default when unset. */
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
}

const STRIPE_ID = /^[A-Za-z0-9_]{1,255}$/;

export function createSlotlockStripe(options: SlotlockStripeOptions): SlotlockStripe {
  const base = options.apiBase ?? 'https://api.stripe.com';
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: URLSearchParams): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${options.secretKey}` };
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (options.apiVersion) headers['stripe-version'] = options.apiVersion;
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

  return {
    async checkout({ tenantRef, interval, customer, successUrl, cancelUrl }) {
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
 * of order) and sets its tenant's plan. Answers 400 to an unsigned or unreadable body, 500 when
 * Stripe or the database fails (Stripe retries), and 200 otherwise.
 */
export async function handleSlotlockStripeWebhook(
  request: Request,
  deps: {
    secret: string;
    stripe: SlotlockStripe;
    sql: SlotlockSql;
    now?: () => number;
    onError?: (error: unknown) => void;
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
    const { plan, status } = slotlockPlanOfSubscription(subscription);
    // An ended subscription only ends the plan it gave: not one the tenant has started since.
    if (plan === 'free') {
      const current = await readSlotlockTenantPlan(deps.sql, tenantRef);
      if (current?.stripeSubscription && current.stripeSubscription !== subscription.id) {
        return text(200, 'Ignored.');
      }
    }
    const customer =
      typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
    const end =
      subscription.items?.data?.[0]?.current_period_end ?? subscription.current_period_end ?? null;
    await setSlotlockTenantPlan(deps.sql, {
      tenantRef,
      plan,
      status,
      stripeCustomer: customer,
      stripeSubscription: plan === 'free' ? null : subscription.id,
      currentPeriodEnd: plan === 'free' || !end ? null : new Date(end * 1000),
    });
    return text(200, 'Updated.');
  } catch (error) {
    deps.onError?.(error);
    return text(500, 'Try again.');
  }
}
