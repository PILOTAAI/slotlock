// Closing a partner's month (RFC 0003 P5, P6): what its accounts used, the invoice lines its
// contract prices that at, recorded once, the signed usage.period_closed webhook that sends the
// partner the same numbers first, and the lines added to its next Stripe invoice.
//
// - Lines are recorded in slotlock.partner_invoices before anything is sent, and a month's lines
//   are never priced again: closing a month twice (a retry days later) sends the same numbers, and
//   only the lines Stripe has not taken yet. Stripe's own idempotency keys last about a day, so they
//   only guard a retry within one run.
// - The webhook carries the month's totals by account and metric, the lines, and a SHA-256 of the
//   canonical rows, so both sides can check they hold the same numbers; `GET /v1/partner/usage`
//   reads the same counts.
// - Pylota is the merchant here (a partner is billed as an ordinary business customer), not
//   Managed Payments, which sells only directly to customers.
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { SLOTLOCK_STRIPE_API_VERSION } from './billing.js';
import { type SlotlockPartnerContract, parseSlotlockPartnerContract } from './partners.js';
import { type SlotlockWebhookSender, createSlotlockWebhookSender, signSlotlockWebhook } from './webhooks.js';

/** One account's month: each metric's total (resources: the most it held on a day). */
export interface SlotlockPartnerAccountMonth {
  account: string;
  plan: string;
  totals: Readonly<Record<string, number>>;
}

/** One invoice line, in the contract currency's minor units. */
export interface SlotlockPartnerInvoiceLine {
  line: string;
  description: string;
  quantity: number;
  amount: number;
  currency: string;
}

/**
 * Price a month with the contract (P6): each account with at least one operation, each 10,000
 * operations and each 100 bookings an account made above its plan's quota (each account rounded up
 * on its own), and the minimum's shortfall. No pricing in the contract: no lines.
 */
export function priceSlotlockPartnerMonth(
  contract: SlotlockPartnerContract,
  accounts: readonly SlotlockPartnerAccountMonth[],
): SlotlockPartnerInvoiceLine[] {
  const pricing = contract.pricing;
  if (!pricing) return [];
  const lines: SlotlockPartnerInvoiceLine[] = [];
  const active = accounts.filter((month) => (month.totals.operations ?? 0) > 0).length;
  if (active > 0 && pricing.activeAccount > 0) {
    lines.push({
      line: 'active_accounts',
      description: `Active accounts (${active} × ${pricing.activeAccount} ${pricing.currency} minor units)`,
      quantity: active,
      amount: active * pricing.activeAccount,
      currency: pricing.currency,
    });
  }
  const over = (metric: 'operations' | 'bookings', per: number) =>
    accounts.reduce((sum, month) => {
      const plan = contract.plans[month.plan];
      const quota = plan ? plan[metric] : Number.POSITIVE_INFINITY;
      return sum + Math.ceil(Math.max(0, (month.totals[metric] ?? 0) - quota) / per);
    }, 0);
  const operationBlocks = over('operations', 10_000);
  if (operationBlocks > 0 && pricing.operationsOverQuotaPer10k > 0) {
    lines.push({
      line: 'operations_over_quota',
      description: `Operations above the accounts' quotas (${operationBlocks} × 10,000)`,
      quantity: operationBlocks,
      amount: operationBlocks * pricing.operationsOverQuotaPer10k,
      currency: pricing.currency,
    });
  }
  const bookingBlocks = over('bookings', 100);
  if (bookingBlocks > 0 && pricing.bookingsOverQuotaPer100 > 0) {
    lines.push({
      line: 'bookings_over_quota',
      description: `Bookings above the accounts' quotas (${bookingBlocks} × 100)`,
      quantity: bookingBlocks,
      amount: bookingBlocks * pricing.bookingsOverQuotaPer100,
      currency: pricing.currency,
    });
  }
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  if (subtotal < pricing.minimum) {
    lines.push({
      line: 'minimum',
      description: 'Up to the monthly minimum',
      quantity: 1,
      amount: pricing.minimum - subtotal,
      currency: pricing.currency,
    });
  }
  return lines;
}

/** The SHA-256 (hex) of a month's canonical rows: `account\tmetric\tcount` lines, sorted, then the invoice lines. */
export function slotlockPartnerMonthChecksum(
  accounts: readonly SlotlockPartnerAccountMonth[],
  lines: readonly SlotlockPartnerInvoiceLine[],
): string {
  const usage = accounts
    .flatMap((month) => Object.entries(month.totals).map(([metric, count]) => `${month.account}\t${metric}\t${count}`))
    .sort();
  const priced = lines.map((line) => `${line.line}\t${line.quantity}\t${line.amount}\t${line.currency}`).sort();
  return createHash('sha256').update([...usage, '', ...priced].join('\n')).digest('hex');
}

/** `YYYY-MM`, a month that has ended by `now` (UTC): its first day and the next month's. */
export function slotlockClosedMonth(month: string, now: number): { from: string; to: string; next: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw Object.assign(new Error('Slotlock month must be YYYY-MM'), { code: 'invalid_month' });
  }
  const [year, number] = month.split('-').map(Number) as [number, number];
  const start = Date.UTC(year, number - 1, 1);
  const next = Date.UTC(year, number, 1);
  if (next > now) {
    throw Object.assign(new Error(`Slotlock month ${month} has not ended`), { code: 'month_not_ended' });
  }
  const day = (at: number) => new Date(at).toISOString().slice(0, 10);
  return { from: day(start), to: day(next - 86_400_000), next: day(next) };
}

/** The month before `now` (UTC), `YYYY-MM`: what a run on the 1st closes. */
export function slotlockPreviousMonth(now: number): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

export interface SlotlockPartnerMonthClose {
  partner: string;
  month: string;
  accounts: SlotlockPartnerAccountMonth[];
  lines: (SlotlockPartnerInvoiceLine & { stripeItem: string | null })[];
  checksum: string;
  /** The webhook's HTTP status, or why it was not sent. */
  webhook: number | 'no_webhook' | 'failed';
  /** Lines Stripe took in this run, and those still waiting for it (no Stripe key, or a failure). */
  invoiced: number;
  pending: number;
}

/**
 * Close one partner's month, as the schema owner (`slotlock partner close`): read its accounts'
 * usage, record its invoice lines once, send usage.period_closed, and add the lines Stripe has not
 * taken to its next invoice (with `stripe`). Safe to run again: nothing is priced or billed twice.
 */
export async function closeSlotlockPartnerMonth(
  sql: Sql,
  input: {
    partnerId: string;
    month: string;
    now?: number;
    /** Stripe: a secret key with write access to invoice items. Without it, lines wait. */
    stripe?: { secretKey: string; fetch?: typeof fetch; apiBase?: string };
    /** How the webhook is sent (createSlotlockWebhookSender, which refuses private addresses). */
    send?: SlotlockWebhookSender;
  },
): Promise<SlotlockPartnerMonthClose> {
  const now = input.now ?? Date.now();
  const range = slotlockClosedMonth(input.month, now);
  const [partner] = await sql<
    { contract: unknown; stripe_customer: string | null; webhook_url: string | null; webhook_secret: string | null }[]
  >`SELECT contract, stripe_customer, webhook_url, webhook_secret FROM slotlock.partners WHERE id = ${input.partnerId}`;
  if (!partner) throw Object.assign(new Error('Slotlock partner not found'), { code: 'partner_not_found' });
  const contract = parseSlotlockPartnerContract(partner.contract);
  // Every account the partner had this month, with its plan now, and what it used.
  const rows = await sql<{ account: string; plan: string; metric: string | null; count: string | null }[]>`
    WITH daily AS (
      SELECT tenant_ref, day, metric, sum(count) AS count
        FROM slotlock.usage_daily
       WHERE day BETWEEN ${range.from}::date AND ${range.to}::date
         AND tenant_ref IN (SELECT tenant_ref FROM slotlock.partner_accounts WHERE partner_id = ${input.partnerId})
       GROUP BY tenant_ref, day, metric
    )
    SELECT owned.account, owned.plan, used.metric,
           CASE WHEN used.metric = 'resources' THEN max(used.count) ELSE sum(used.count) END::text AS count
      FROM slotlock.partner_accounts owned
      LEFT JOIN daily used ON used.tenant_ref = owned.tenant_ref
     WHERE owned.partner_id = ${input.partnerId}
     GROUP BY owned.account, owned.plan, used.metric
     ORDER BY owned.account, used.metric`;
  const byAccount = new Map<string, SlotlockPartnerAccountMonth>();
  for (const row of rows) {
    const month = byAccount.get(row.account) ?? { account: row.account, plan: row.plan, totals: {} };
    if (row.metric !== null) (month.totals as Record<string, number>)[row.metric] = Number(row.count ?? 0);
    byAccount.set(row.account, month);
  }
  const accounts = [...byAccount.values()];
  // Priced once: a month's recorded lines stand, however often it is closed.
  const priced = priceSlotlockPartnerMonth(contract, accounts);
  for (const line of priced) {
    await sql`
      INSERT INTO slotlock.partner_invoices (partner_id, month, line, description, quantity, amount, currency)
      VALUES (${input.partnerId}, ${range.from}::date, ${line.line}, ${line.description}, ${line.quantity},
              ${line.amount}, ${line.currency})
      ON CONFLICT (partner_id, month, line) DO NOTHING`;
  }
  const recorded = await sql<
    { line: string; description: string; quantity: string; amount: string; currency: string; stripe_item: string | null }[]
  >`SELECT line, description, quantity::text, amount::text, currency, stripe_item
      FROM slotlock.partner_invoices
     WHERE partner_id = ${input.partnerId} AND month = ${range.from}::date
     ORDER BY line`;
  const lines = recorded.map((row) => ({
    line: row.line,
    description: row.description,
    quantity: Number(row.quantity),
    amount: Number(row.amount),
    currency: row.currency,
    stripeItem: row.stripe_item,
  }));
  const checksum = slotlockPartnerMonthChecksum(accounts, lines);

  // The partner hears the numbers first (P5), signed as any Slotlock webhook.
  let webhook: SlotlockPartnerMonthClose['webhook'] = 'no_webhook';
  if (partner.webhook_url && partner.webhook_secret) {
    const id = `usage_period_closed_${input.partnerId}_${input.month.replace('-', '_')}`;
    const timestamp = Math.floor(now / 1_000);
    const body = JSON.stringify({
      type: 'usage.period_closed',
      partner: input.partnerId,
      month: input.month,
      from: range.from,
      to: range.to,
      accounts: accounts.map((month) => ({ account: month.account, plan: month.plan, totals: month.totals })),
      lines: lines.map(({ stripeItem: _, ...line }) => line),
      checksum,
    });
    try {
      const answer = await (input.send ?? createSlotlockWebhookSender())({
        url: partner.webhook_url,
        headers: {
          'Content-Type': 'application/json',
          'webhook-id': id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signSlotlockWebhook({ secret: partner.webhook_secret, id, timestamp, body }),
        },
        body,
      });
      webhook = answer.status;
    } catch {
      webhook = 'failed';
    }
  }

  // Then Stripe (P6): each line it has not taken, once, on the partner's next invoice.
  let invoiced = 0;
  const waiting = lines.filter((line) => line.stripeItem === null && line.amount > 0);
  if (input.stripe && partner.stripe_customer) {
    const send = input.stripe.fetch ?? fetch;
    for (const line of waiting) {
      const form = new URLSearchParams({
        customer: partner.stripe_customer,
        amount: String(line.amount),
        currency: line.currency,
        description: `${input.month}: ${line.description}`,
        'metadata[slotlock_partner]': input.partnerId,
        'metadata[slotlock_month]': input.month,
        'metadata[slotlock_line]': line.line,
      });
      const response = await send(`${input.stripe.apiBase ?? 'https://api.stripe.com'}/v1/invoiceitems`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.stripe.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'stripe-version': SLOTLOCK_STRIPE_API_VERSION,
          'idempotency-key': `slotlock-partner-${input.partnerId}-${input.month}-${line.line}`,
        },
        body: form.toString(),
      }).catch(() => null);
      if (!response?.ok) continue;
      const item = ((await response.json().catch(() => ({}))) as { id?: unknown }).id;
      if (typeof item !== 'string' || !/^ii_[A-Za-z0-9]{1,250}$/.test(item)) continue;
      await sql`
        UPDATE slotlock.partner_invoices SET stripe_item = ${item}, sent_at = now()
         WHERE partner_id = ${input.partnerId} AND month = ${range.from}::date AND line = ${line.line}
           AND stripe_item IS NULL`;
      line.stripeItem = item;
      invoiced += 1;
    }
  }
  return {
    partner: input.partnerId,
    month: input.month,
    accounts,
    lines,
    checksum,
    webhook,
    invoiced,
    pending: lines.filter((line) => line.stripeItem === null && line.amount > 0).length,
  };
}

/**
 * The `Slotlock-Client` request field (P5), as metrics count it: the name before any `/version`,
 * when it is one of the deployment's known integrators (SLOTLOCK_KNOWN_CLIENTS), else `other`, and
 * `none` without the field. Never anything else from the request.
 */
export function slotlockClientLabel(field: string | null, known: ReadonlySet<string>): string {
  if (field === null || field.trim() === '') return 'none';
  const name = field.trim().split('/')[0]?.toLowerCase() ?? '';
  return known.has(name) ? name : 'other';
}
