// The staff console's billing figures (src/admin/stripe.ts): one rule, the one Home and Billing count
// paying plans by in the database (staff-ddl.ts staff_subscribed_plans), applied to what Stripe holds.
// Stripe's subscription fields as its API reference describes them (read 2026-11-14): with
// cancel_at_period_end the status stays `active` until the period ends, `canceled_at` is when the
// cancellation was asked for, and `ended_at` is when it ended.
import { describe, expect, it } from 'vitest';
import { createSlotlockAdminStripe, slotlockRevenueOf } from '../admin/stripe.js';

const NOW = Date.UTC(2026, 10, 14, 12);
const at = (month: number, date: number) => Date.UTC(2026, month, date) / 1000;
const item = (amount: number, interval = 'month', usage = 'licensed') => ({
  price: { unit_amount: amount, currency: 'gbp', recurring: { interval, interval_count: 1, usage_type: usage } },
  quantity: 1,
  current_period_end: at(11, 14),
});
const sub = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: `sub_${id}`,
  status,
  created: at(8, 1),
  metadata: { tenant_ref: `github:${id}` },
  items: { data: [item(500)] },
  ...extra,
});

const SUBSCRIPTIONS = [
  sub('1', 'active'),
  // £50 a year: £4.17 a month.
  sub('2', 'past_due', { items: { data: [item(5000, 'year')] } }),
  // Cancelled in the portal this month: still active until 14 December, so ending, not cancelled.
  sub('3', 'active', { cancel_at_period_end: true, canceled_at: at(10, 3) }),
  sub('4', 'past_due', { cancel_at: at(11, 1) }),
  sub('5', 'trialing'),
  // Not one of Slotlock's: no tenant_ref, as Checkout tags each one (billing.ts).
  sub('6', 'active', { metadata: {} }),
  sub('7', 'active', { metadata: { tenant_ref: '' } }),
  // Checkouts never paid: not new.
  sub('8', 'incomplete', { created: at(10, 10) }),
  sub('9', 'incomplete_expired', { created: at(10, 2) }),
  sub('10', 'active', { created: at(10, 5), items: { data: [item(500), item(1, 'month', 'metered')] } }),
  // Ended this month, though asked for last month.
  sub('11', 'canceled', { canceled_at: at(9, 20), ended_at: at(10, 2) }),
  // Bought and ended this month.
  sub('12', 'canceled', { created: at(10, 1), canceled_at: at(10, 8), ended_at: at(10, 8) }),
  // Ended last month.
  sub('13', 'canceled', { canceled_at: at(9, 2), ended_at: at(9, 30) }),
];

describe("the staff console's billing figures", () => {
  it('counts only Slotlock subscriptions that pay and renew, and the rest apart', () => {
    const revenue = slotlockRevenueOf(SUBSCRIPTIONS, NOW);
    expect(revenue).toMatchObject({
      paying: 3,
      // £5 + £4.17 + £5: never the ending ones, the trial, or another product's.
      mrr: { gbp: 1417 },
      pastDue: 1,
      trialing: 1,
      newThisMonth: 2,
      cancelledThisMonth: 2,
    });
    expect(revenue.ending).toEqual({
      count: 2,
      atRisk: { gbp: 1000 },
      subscriptions: [
        { id: 'sub_4', tenantRef: 'github:4', endsAt: at(11, 1) * 1000, monthly: 500, currency: 'gbp' },
        { id: 'sub_3', tenantRef: 'github:3', endsAt: at(11, 14) * 1000, monthly: 500, currency: 'gbp' },
      ],
    });
  });

  it('reads every page of subscriptions from Stripe, at all statuses, and applies the same rule', async () => {
    const asked: string[] = [];
    const stripe = createSlotlockAdminStripe({
      key: 'rk_test_admin',
      now: () => NOW,
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        asked.push(url.search);
        const page = url.searchParams.get('starting_after') ? SUBSCRIPTIONS.slice(7) : SUBSCRIPTIONS.slice(0, 7);
        return Response.json({ data: page, has_more: !url.searchParams.get('starting_after') });
      }) as typeof fetch,
    });
    expect(await stripe.revenue()).toEqual({ ...slotlockRevenueOf(SUBSCRIPTIONS, NOW), truncated: false, readAt: NOW });
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('status=all');
    expect(asked[1]).toContain('starting_after=sub_7');
  });
});
