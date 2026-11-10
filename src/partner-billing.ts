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
  /** Each account's totals as the month was first closed: later runs send the same. */
  accounts: SlotlockPartnerAccountMonth[];
  lines: (SlotlockPartnerInvoiceLine & { stripeItem: string | null })[];
  checksum: string;
  /** True when this run closed the month; false when an earlier run had. */
  closedNow: boolean;
  /**
   * The webhook: delivered in this run (a 2xx), delivered by an earlier run, not configured, or
   * failed (no answer, or another status, in `webhookStatus`), to be sent again by the next run.
   */
  webhook: 'delivered' | 'already_delivered' | 'no_webhook' | 'failed';
  webhookStatus?: number;
  /** Lines Stripe took in this run, and those still waiting for it (no Stripe key, or a failure). */
  invoiced: number;
  pending: number;
}

interface FrozenMonth {
  accounts: SlotlockPartnerAccountMonth[];
  checksum: string;
  webhookDelivered: boolean;
}

/** Each account's month: what its tenant used, and what an erased one of the same name had used. */
async function readPartnerMonth(sql: Sql, partnerId: string, range: { from: string; to: string }) {
  const rows = await sql<{ account: string; plan: string; metric: string | null; count: string | null }[]>`
    WITH daily AS (
      SELECT tenant_ref, day, metric, sum(count) AS count
        FROM slotlock.usage_daily
       WHERE day BETWEEN ${range.from}::date AND ${range.to}::date
         AND tenant_ref IN (SELECT tenant_ref FROM slotlock.partner_accounts WHERE partner_id = ${partnerId})
       GROUP BY tenant_ref, day, metric
    )
    SELECT owned.account, owned.plan, used.metric,
           CASE WHEN used.metric = 'resources' THEN max(used.count) ELSE sum(used.count) END::text AS count
      FROM slotlock.partner_accounts owned
      LEFT JOIN daily used ON used.tenant_ref = owned.tenant_ref
     WHERE owned.partner_id = ${partnerId}
     GROUP BY owned.account, owned.plan, used.metric
    UNION ALL
    SELECT erased.account, erased.plan, erased.metric, erased.count::text
      FROM slotlock.partner_erased_usage erased
     WHERE erased.partner_id = ${partnerId} AND erased.month = ${range.from}::date`;
  const byAccount = new Map<string, SlotlockPartnerAccountMonth>();
  for (const row of rows) {
    const month = byAccount.get(row.account) ?? { account: row.account, plan: row.plan, totals: {} };
    if (row.metric !== null) {
      const totals = month.totals as Record<string, number>;
      const count = Number(row.count ?? 0);
      // An account erased and made again in the month: both counted, resources at their most.
      totals[row.metric] = row.metric === 'resources' ? Math.max(totals[row.metric] ?? 0, count) : (totals[row.metric] ?? 0) + count;
    }
    byAccount.set(row.account, month);
  }
  return canonicalAccounts([...byAccount.values()]);
}

/** Accounts by name, each one's metrics by name: the order the webhook body and its checksum use. */
function canonicalAccounts(accounts: readonly SlotlockPartnerAccountMonth[]): SlotlockPartnerAccountMonth[] {
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...accounts]
    .sort((a, b) => byName(a.account, b.account))
    .map((month) => ({
      account: month.account,
      plan: month.plan,
      totals: Object.fromEntries(Object.entries(month.totals).sort(([a], [b]) => byName(a, b))),
    }));
}

/** Stripe's invoice items for the customer that this partner's month already made (a run that stopped after Stripe took them). */
async function existingInvoiceItems(
  stripe: { secretKey: string; fetch?: typeof fetch; apiBase?: string },
  customer: string,
  partnerId: string,
  month: string,
): Promise<Map<string, string>> {
  const send = stripe.fetch ?? fetch;
  const found = new Map<string, string>();
  let after: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const query = new URLSearchParams({ customer, limit: '100', ...(after ? { starting_after: after } : {}) });
    const response = await send(`${stripe.apiBase ?? 'https://api.stripe.com'}/v1/invoiceitems?${query.toString()}`, {
      headers: { authorization: `Bearer ${stripe.secretKey}`, 'stripe-version': SLOTLOCK_STRIPE_API_VERSION },
    }).catch(() => null);
    if (!response?.ok) throw Object.assign(new Error('Stripe did not list the invoice items'), { code: 'stripe_unavailable' });
    const listed = (await response.json().catch(() => null)) as {
      data?: { id?: unknown; metadata?: Record<string, string> }[];
      has_more?: boolean;
    } | null;
    for (const item of listed?.data ?? []) {
      if (
        typeof item.id === 'string' &&
        item.metadata?.slotlock_partner === partnerId &&
        item.metadata.slotlock_month === month &&
        typeof item.metadata.slotlock_line === 'string'
      ) {
        found.set(item.metadata.slotlock_line, item.id);
      }
    }
    const last = listed?.data?.at(-1)?.id;
    if (!listed?.has_more || typeof last !== 'string') break;
    after = last;
  }
  return found;
}

/**
 * Close one partner's month, as the schema owner (`slotlock partner close`). The first run freezes
 * it: each account's totals (erased accounts' included), the invoice lines the contract prices them
 * at and their checksum, in one transaction. Every run then sends usage.period_closed with that same
 * body until the partner's endpoint takes it (a 2xx), and adds to the partner's next Stripe invoice
 * each line Stripe has not taken, adopting one it took in a run that stopped before recording it.
 * Nothing is priced or billed twice, however often or concurrently it runs.
 */
export async function closeSlotlockPartnerMonth(
  sql: Sql,
  input: {
    partnerId: string;
    month: string;
    now?: number;
    /** Stripe: a secret key with read and write access to invoice items. Without it, lines wait. */
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

  // Frozen on the first run, under the partner's month lock, so racing runs freeze it once.
  let closedNow = false;
  const frozen = await sql.begin(async (tx): Promise<FrozenMonth> => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`slotlock:partner-month:${input.partnerId}:${input.month}`}, 0))`;
    const [kept] = await tx<{ accounts: SlotlockPartnerAccountMonth[]; checksum: string; delivered: boolean }[]>`
      SELECT accounts, checksum, webhook_delivered_at IS NOT NULL AS delivered
        FROM slotlock.partner_month_closes WHERE partner_id = ${input.partnerId} AND month = ${range.from}::date`;
    // jsonb keeps no key order: put it back, so every run sends the same bytes.
    if (kept) return { accounts: canonicalAccounts(kept.accounts), checksum: kept.checksum, webhookDelivered: kept.delivered };
    const accounts = await readPartnerMonth(tx as unknown as Sql, input.partnerId, range);
    const priced = priceSlotlockPartnerMonth(parseSlotlockPartnerContract(partner.contract), accounts);
    for (const line of priced) {
      await tx`
        INSERT INTO slotlock.partner_invoices (partner_id, month, line, description, quantity, amount, currency)
        VALUES (${input.partnerId}, ${range.from}::date, ${line.line}, ${line.description}, ${line.quantity},
                ${line.amount}, ${line.currency})`;
    }
    const checksum = slotlockPartnerMonthChecksum(accounts, priced);
    await tx`
      INSERT INTO slotlock.partner_month_closes (partner_id, month, accounts, checksum)
      VALUES (${input.partnerId}, ${range.from}::date, ${JSON.stringify(accounts)}::text::jsonb, ${checksum})`;
    closedNow = true;
    return { accounts, checksum, webhookDelivered: false };
  });
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

  // The partner hears the numbers first (P5), signed as any Slotlock webhook, the same body each time.
  let webhook: SlotlockPartnerMonthClose['webhook'] = 'no_webhook';
  let webhookStatus: number | undefined;
  if (frozen.webhookDelivered) {
    webhook = 'already_delivered';
  } else if (partner.webhook_url && partner.webhook_secret) {
    const id = `usage_period_closed_${input.partnerId}_${input.month.replace('-', '_')}`;
    const timestamp = Math.floor(now / 1_000);
    const body = JSON.stringify({
      type: 'usage.period_closed',
      partner: input.partnerId,
      month: input.month,
      from: range.from,
      to: range.to,
      accounts: frozen.accounts.map((month) => ({ account: month.account, plan: month.plan, totals: month.totals })),
      lines: lines.map(({ stripeItem: _, ...line }) => line),
      checksum: frozen.checksum,
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
      webhookStatus = answer.status;
      webhook = answer.status >= 200 && answer.status < 300 ? 'delivered' : 'failed';
    } catch {
      webhook = 'failed';
    }
    await sql`
      UPDATE slotlock.partner_month_closes
         SET webhook_status = ${webhookStatus ?? null},
             webhook_delivered_at = CASE WHEN ${webhook === 'delivered'} THEN statement_timestamp() ELSE webhook_delivered_at END
       WHERE partner_id = ${input.partnerId} AND month = ${range.from}::date`;
  }

  // Then Stripe (P6): each line it has not taken, once, on the partner's next invoice.
  let invoiced = 0;
  const waiting = lines.filter((line) => line.stripeItem === null && line.amount > 0);
  if (input.stripe && partner.stripe_customer && waiting.length > 0) {
    const send = input.stripe.fetch ?? fetch;
    // An item a run made before it stopped is adopted, never made again (idempotency keys last a day).
    const made = await existingInvoiceItems(input.stripe, partner.stripe_customer, input.partnerId, input.month);
    for (const line of waiting) {
      let item: unknown = made.get(line.line);
      if (item === undefined) {
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
        item = ((await response.json().catch(() => ({}))) as { id?: unknown }).id;
      }
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
    accounts: frozen.accounts,
    lines,
    checksum: frozen.checksum,
    closedNow,
    webhook,
    ...(webhookStatus !== undefined ? { webhookStatus } : {}),
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
