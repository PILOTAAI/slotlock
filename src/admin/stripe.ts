// What the admin console reads from Stripe (RFC 0006, M4 and 4.6), with a restricted key that can
// read subscriptions and invoices and nothing else: revenue across the account, and one customer's
// subscriptions and recent invoices. Refunds, disputes and invoices themselves stay in Stripe; the
// console links there. Each read is kept an hour in Postgres (slotlock.admin_cache) by the caller.

/** Monthly recurring revenue and the month's movement, from Stripe's subscriptions. */
export interface SlotlockStripeRevenue {
  /** Minor units a month, by currency (eur, usd…), from live subscriptions' licensed prices. */
  mrr: Record<string, number>;
  /** Live subscriptions: active, trialing or past due. */
  live: number;
  pastDue: number;
  /** Subscriptions created this UTC month, and cancelled this UTC month. */
  newThisMonth: number;
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
const LIVE = new Set(['active', 'trialing', 'past_due']);

interface StripePrice {
  unit_amount?: number | null;
  currency?: string;
  recurring?: { interval?: string; interval_count?: number; usage_type?: string } | null;
}
interface StripeSubscription {
  id: string;
  status: string;
  created?: number;
  canceled_at?: number | null;
  cancel_at_period_end?: boolean;
  current_period_end?: number | null;
  currency?: string;
  items?: { data?: { price?: StripePrice; quantity?: number; current_period_end?: number }[] };
}

/** Minor units a month: licensed prices only (a metered overage price has no fixed amount). */
function monthlyOf(subscription: StripeSubscription): { amount: number; currency: string | null } {
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
      const today = new Date(at);
      const monthStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) / 1000;
      const mrr: Record<string, number> = {};
      let live = 0;
      let pastDue = 0;
      let newThisMonth = 0;
      let cancelledThisMonth = 0;
      let after: string | null = null;
      let truncated = false;
      for (let page = 0; page < PAGES; page += 1) {
        const query: Record<string, string> = { status: 'all', limit: '100', 'expand[]': 'data.items.data.price' };
        if (after) query.starting_after = after;
        const listed = await get<{ data: StripeSubscription[]; has_more: boolean }>('/v1/subscriptions', query);
        for (const subscription of listed.data) {
          if ((subscription.created ?? 0) >= monthStart) newThisMonth += 1;
          if ((subscription.canceled_at ?? 0) >= monthStart) cancelledThisMonth += 1;
          if (!LIVE.has(subscription.status)) continue;
          live += 1;
          if (subscription.status === 'past_due') pastDue += 1;
          const { amount, currency } = monthlyOf(subscription);
          if (currency) mrr[currency] = (mrr[currency] ?? 0) + amount;
        }
        after = listed.data.at(-1)?.id ?? null;
        if (!listed.has_more || !after) break;
        if (page === PAGES - 1) truncated = true;
      }
      return { mrr, live, pastDue, newThisMonth, cancelledThisMonth, truncated, readAt: at };
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
