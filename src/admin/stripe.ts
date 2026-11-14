// What the admin console reads from Stripe (RFC 0006, M4 and 4.6), with a restricted key that can
// read subscriptions and invoices and nothing else: Slotlock's revenue, and one customer's
// subscriptions and recent invoices. Refunds, disputes and invoices themselves stay in Stripe; the
// console links there. Each read is kept an hour in Postgres (slotlock.admin_cache) by the caller.
//
// Revenue counts Slotlock's subscriptions only: those Checkout tagged with the account they are for
// (metadata tenant_ref, billing.ts), never another product's on the same Stripe account. It applies
// the rule the database counts paying plans by (staff-ddl.ts staff_subscribed_plans), so Home and
// Billing agree: paying is active or past due and not set to end. Stripe's subscription fields as
// its API reference describes them (read 2026-11-14): cancelled at the end of its period, a
// subscription stays `active` until then; `canceled_at` is when the cancellation was asked for, and
// `ended_at` when it ended.
import { slotlockSubscriptionEnding } from '../billing.js';

/** A paying subscription set to end, with what it brings in a month until then. */
export interface SlotlockEndingSubscription {
  id: string;
  tenantRef: string;
  /** When it ends, ms since the epoch. */
  endsAt: number;
  /** Minor units a month. */
  monthly: number;
  currency: string | null;
}

/** Slotlock's monthly recurring revenue and the month's movement, from Stripe's subscriptions. */
export interface SlotlockStripeRevenue {
  /** Minor units a month, by currency (gbp, eur…), from paying subscriptions' licensed prices. */
  mrr: Record<string, number>;
  /** Subscriptions active or past due and not set to end. */
  paying: number;
  /** Of those, past due: Stripe is retrying a payment. */
  pastDue: number;
  /** In a trial: no payment yet, so in neither of the above. */
  trialing: number;
  /** Active or past due, but set to end: what they bring in a month until then, and when each ends. */
  ending: { count: number; atRisk: Record<string, number>; subscriptions: SlotlockEndingSubscription[] };
  /** Created this UTC month and paid for at least once (never an abandoned checkout). */
  newThisMonth: number;
  /** Ended this UTC month. */
  cancelledThisMonth: number;
  /** True when Stripe had more subscriptions than the console reads (1,000). */
  truncated: boolean;
  /** When this was read from Stripe, ms since the epoch. */
  readAt: number;
}

/** One customer as the account page shows it. */
export interface SlotlockStripeCustomer {
  subscriptions: {
    id: string;
    status: string;
    currentPeriodEnd: number | null;
    cancelAtPeriodEnd: boolean;
    /** Minor units a month, from its licensed prices. */
    monthly: number;
    currency: string | null;
  }[];
  invoices: {
    id: string;
    number: string | null;
    status: string | null;
    amountDue: number;
    amountPaid: number;
    currency: string | null;
    created: number;
  }[];
  readAt: number;
}

export interface SlotlockAdminStripe {
  revenue(): Promise<SlotlockStripeRevenue>;
  customer(id: string): Promise<SlotlockStripeCustomer>;
}

const API = 'https://api.stripe.com';
const CUSTOMER = /^cus_[A-Za-z0-9]{1,250}$/;
const PAGES = 10;
/** The ending subscriptions the console keeps from one read, soonest first. */
const ENDING_LISTED = 100;
/** Statuses a subscription pays in. */
const PAID = new Set(['active', 'past_due']);
/** Statuses of one that was paid for at least once: not a checkout abandoned or still in a trial. */
const STARTED = new Set(['active', 'past_due', 'unpaid', 'canceled']);

interface StripePrice {
  unit_amount?: number | null;
  currency?: string;
  recurring?: { interval?: string; interval_count?: number; usage_type?: string } | null;
}
/** The fields of a Stripe subscription the console reads. */
export interface SlotlockAdminStripeSubscription {
  id: string;
  status: string;
  created?: number;
  canceled_at?: number | null;
  ended_at?: number | null;
  cancel_at_period_end?: boolean | null;
  cancel_at?: number | null;
  current_period_end?: number | null;
  currency?: string;
  metadata?: Record<string, string> | null;
  items?: { data?: { price?: StripePrice; quantity?: number; current_period_end?: number }[] };
}
type StripeSubscription = SlotlockAdminStripeSubscription;

/** Minor units a month: licensed prices only (a metered overage price has no fixed amount). */
function monthlyOf(subscription: Pick<StripeSubscription, 'currency' | 'items'>): { amount: number; currency: string | null } {
  let amount = 0;
  let currency: string | null = subscription.currency ?? null;
  for (const item of subscription.items?.data ?? []) {
    const price = item.price;
    if (!price?.recurring || price.recurring.usage_type === 'metered' || typeof price.unit_amount !== 'number') continue;
    const months =
      price.recurring.interval === 'year'
        ? 12 * (price.recurring.interval_count ?? 1)
        : price.recurring.interval === 'month'
          ? price.recurring.interval_count ?? 1
          : price.recurring.interval === 'week'
            ? (price.recurring.interval_count ?? 1) / 4.345
            : (price.recurring.interval_count ?? 1) / 30.44;
    amount += (price.unit_amount * (item.quantity ?? 1)) / months;
    currency = price.currency ?? currency;
  }
  return { amount: Math.round(amount), currency };
}

/**
 * Slotlock's revenue as the console shows it, from subscriptions as Stripe lists them (any status):
 * the one rule for paying, trialing, ending, new and cancelled (see the top of this file).
 */
export function slotlockRevenueOf(
  subscriptions: readonly StripeSubscription[],
  nowMs: number,
): Omit<SlotlockStripeRevenue, 'truncated' | 'readAt'> {
  const today = new Date(nowMs);
  const monthStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) / 1000;
  const mrr: Record<string, number> = {};
  const atRisk: Record<string, number> = {};
  const ending: SlotlockEndingSubscription[] = [];
  let paying = 0;
  let pastDue = 0;
  let trialing = 0;
  let newThisMonth = 0;
  let cancelledThisMonth = 0;
  for (const subscription of subscriptions) {
    const tenantRef = subscription.metadata?.tenant_ref;
    // Not one of Slotlock's: another product's on the same Stripe account.
    if (typeof tenantRef !== 'string' || tenantRef === '') continue;
    if ((subscription.created ?? 0) >= monthStart && STARTED.has(subscription.status)) newThisMonth += 1;
    if ((subscription.ended_at ?? 0) >= monthStart) cancelledThisMonth += 1;
    if (subscription.status === 'trialing') {
      trialing += 1;
      continue;
    }
    if (!PAID.has(subscription.status)) continue;
    const { amount, currency } = monthlyOf(subscription);
    const ends = slotlockSubscriptionEnding(subscription);
    if (ends) {
      if (currency) atRisk[currency] = (atRisk[currency] ?? 0) + amount;
      ending.push({ id: subscription.id, tenantRef, endsAt: ends.getTime(), monthly: amount, currency });
      continue;
    }
    paying += 1;
    if (subscription.status === 'past_due') pastDue += 1;
    if (currency) mrr[currency] = (mrr[currency] ?? 0) + amount;
  }
  ending.sort((a, b) => a.endsAt - b.endsAt || a.tenantRef.localeCompare(b.tenantRef));
  return {
    mrr,
    paying,
    pastDue,
    trialing,
    ending: { count: ending.length, atRisk, subscriptions: ending.slice(0, ENDING_LISTED) },
    newThisMonth,
    cancelledThisMonth,
  };
}

export function createSlotlockAdminStripe(options: {
  /** A restricted key with read access to subscriptions and invoices. */
  key: string;
  fetch?: typeof fetch;
  now?: () => number;
}): SlotlockAdminStripe {
  const fetcher = options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? (() => Date.now());

  async function get<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(path, API);
    for (const [name, value] of Object.entries(query)) url.searchParams.append(name, value);
    const response = await fetcher(url.href, {
      headers: { Authorization: `Bearer ${options.key}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw Object.assign(new Error(`Stripe answered ${response.status}`), { code: 'stripe_unavailable' });
    return (await response.json()) as T;
  }

  return {
    async revenue() {
      const at = now();
      const subscriptions: StripeSubscription[] = [];
      let after: string | null = null;
      let truncated = false;
      for (let page = 0; page < PAGES; page += 1) {
        const query: Record<string, string> = { status: 'all', limit: '100', 'expand[]': 'data.items.data.price' };
        if (after) query.starting_after = after;
        const listed = await get<{ data: StripeSubscription[]; has_more: boolean }>('/v1/subscriptions', query);
        subscriptions.push(...listed.data);
        after = listed.data.at(-1)?.id ?? null;
        if (!listed.has_more || !after) break;
        if (page === PAGES - 1) truncated = true;
      }
      return { ...slotlockRevenueOf(subscriptions, at), truncated, readAt: at };
    },

    async customer(id) {
      if (!CUSTOMER.test(id)) throw Object.assign(new Error('Not a Stripe customer id'), { code: 'invalid_customer' });
      const [subscriptions, invoices] = await Promise.all([
        get<{ data: StripeSubscription[] }>('/v1/subscriptions', {
          customer: id, status: 'all', limit: '10', 'expand[]': 'data.items.data.price',
        }),
        get<{ data: { id: string; number?: string | null; status?: string | null; amount_due?: number; amount_paid?: number; currency?: string; created?: number }[] }>(
          '/v1/invoices',
          { customer: id, limit: '5' },
        ),
      ]);
      return {
        subscriptions: subscriptions.data.map((subscription) => {
          const { amount, currency } = monthlyOf(subscription);
          return {
            id: subscription.id,
            status: subscription.status,
            currentPeriodEnd: subscription.items?.data?.[0]?.current_period_end ?? subscription.current_period_end ?? null,
            cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
            monthly: amount,
            currency,
          };
        }),
        invoices: invoices.data.map((invoice) => ({
          id: invoice.id,
          number: invoice.number ?? null,
          status: invoice.status ?? null,
          amountDue: invoice.amount_due ?? 0,
          amountPaid: invoice.amount_paid ?? 0,
          currency: invoice.currency ?? null,
          created: invoice.created ?? 0,
        })),
        readAt: now(),
      };
    },
  };
}

/** An amount in minor units, as people read it: €1,234.50. */
export function slotlockMoney(minor: number, currency: string | null): string {
  const code = (currency ?? 'eur').toUpperCase();
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${code}`;
  }
}
