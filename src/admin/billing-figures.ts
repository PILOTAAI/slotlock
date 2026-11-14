// What the staff console says about billing, as data its pages (and any redesign of them) render:
// a plan with the date it ends, a billing alert in words, the subscriptions set to end with what
// each brings in a month, and the links into Stripe. The figures themselves come from the database
// (staff-ddl.ts staff_subscribed_plans) and Stripe (stripe.ts slotlockRevenueOf), by one rule.
import { type SlotlockStripeRevenue, slotlockMoney } from './stripe.js';

const PLAN_NAMES: Readonly<Record<string, string>> = Object.freeze({ free: 'Free', developer: 'Developer', team: 'Team' });

/** A plan's name as people read it: Developer, Team, Free; a partner's plan as it is called. */
export function slotlockPlanName(plan: string | null | undefined): string {
  return PLAN_NAMES[plan ?? 'free'] ?? plan ?? 'Free';
}

/** A day as people read it: 14 Dec this year, 14 Dec 2027 another. */
export function slotlockShortDate(value: Date | string | number, nowMs: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  const sameYear = date.getUTCFullYear() === new Date(nowMs).getUTCFullYear();
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}

/** A plan, with the day it ends when its subscription is set to end: "Developer · ends 14 Dec". */
export function slotlockPlanLabel(plan: string | null | undefined, endsAt: Date | string | null | undefined, nowMs: number): string {
  return endsAt ? `${slotlockPlanName(plan)} · ends ${slotlockShortDate(endsAt, nowMs)}` : slotlockPlanName(plan);
}

/** Amounts by currency, each as people read it, joined: £20.00 + €5.00. */
export function slotlockMoneyByCurrency(amounts: Readonly<Record<string, number>>): string {
  const parts = Object.entries(amounts).map(([currency, minor]) => slotlockMoney(minor, currency));
  return parts.length ? parts.join(' + ') : slotlockMoney(0, 'gbp');
}

/** Where a Stripe object is in Stripe's dashboard: an invoice, a payment (a charge), or a subscription. */
export function slotlockStripeLink(ref: string): string {
  if (ref.startsWith('in_')) return `https://dashboard.stripe.com/invoices/${encodeURIComponent(ref)}`;
  if (/^(ch|py)_/.test(ref)) return `https://dashboard.stripe.com/payments/${encodeURIComponent(ref)}`;
  return `https://dashboard.stripe.com/subscriptions/${encodeURIComponent(ref)}`;
}

/** A billing alert in words: what happened, and its detail. */
export function slotlockBillingAlertWords(kind: string, detail: Record<string, unknown>): { title: string; detail: string | null } {
  const currency = typeof detail.currency === 'string' ? detail.currency : null;
  if (kind === 'payment_failed') {
    return {
      title: 'Payment failed',
      detail: typeof detail.amount_due === 'number' ? `${slotlockMoney(detail.amount_due, currency)}, attempt ${String(detail.attempt_count ?? '?')}` : null,
    };
  }
  if (kind === 'refunded_plan_active') {
    const refunded = typeof detail.amount_refunded === 'number' ? slotlockMoney(detail.amount_refunded, currency) : null;
    const of = typeof detail.amount === 'number' ? slotlockMoney(detail.amount, currency) : null;
    const amounts = refunded ? `${refunded}${of ? ` of ${of}` : ''} refunded` : null;
    // Part of a payment refunded (Stripe's `refunded` is true only once all of it is) says only that:
    // a partial refund is often meant to leave the plan as it is.
    if (detail.refunded === false) return { title: 'Partly refunded', detail: amounts };
    return {
      title: 'Refunded, plan still active',
      detail: amounts ? `${amounts}: end the plan, or say why not` : 'End the plan, or say why not',
    };
  }
  if (kind === 'duplicate_subscription') {
    return { title: 'Second subscription', detail: typeof detail.first === 'string' ? `besides ${detail.first}: refund one` : null };
  }
  return { title: kind, detail: null };
}

/** A paying plan set to end: its account, plan, when, and what it brings in a month (Stripe's, when read). */
export interface SlotlockEndingRow {
  account: string;
  plan: string | null;
  endsAt: number;
  monthly: number | null;
  currency: string | null;
}

/**
 * The plans set to end, soonest first: the database's (the webhook keeps each end date), with
 * Stripe's amounts when it was read, and any Stripe knows of that the webhook has not recorded yet.
 */
export function slotlockEndingRows(
  recorded: readonly { account_ref: string; plan: string | null; ends_at: string | Date }[],
  revenue: Pick<SlotlockStripeRevenue, 'ending'> | null,
): SlotlockEndingRow[] {
  const fromStripe = new Map((revenue?.ending.subscriptions ?? []).map((item) => [item.tenantRef, item]));
  const rows: SlotlockEndingRow[] = recorded.map((row) => {
    const stripe = fromStripe.get(row.account_ref);
    fromStripe.delete(row.account_ref);
    return {
      account: row.account_ref,
      plan: row.plan,
      endsAt: new Date(row.ends_at).getTime(),
      monthly: stripe?.monthly ?? null,
      currency: stripe?.currency ?? null,
    };
  });
  for (const item of fromStripe.values()) {
    rows.push({ account: item.tenantRef, plan: null, endsAt: item.endsAt, monthly: item.monthly, currency: item.currency });
  }
  return rows.sort((a, b) => a.endsAt - b.endsAt || a.account.localeCompare(b.account));
}
