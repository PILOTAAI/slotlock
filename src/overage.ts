// Metered overage for Developer (RFC 0003 "Later"), off unless SLOTLOCK_OVERAGE=on. Stripe's test
// mode takes the metered price in a Managed Payments checkout (read 2026-11-10, RFC 0003 vendor
// facts); it stays off until a paid test subscription shows the meter billed and the Terms say what
// overage costs.
//
// With it on: checkout adds the metered price (SLOTLOCK_STRIPE_PRICE_OVERAGE) to a Developer
// subscription, and the Stripe webhook records which subscriptions carry it
// (tenant_plans.overage_metered). A paying Developer tenant whose subscription does is not refused at
// 110% of its monthly operations but at SLOTLOCK_OVERAGE_STOP_PERCENT (300% by default); one whose
// subscription does not (bought before overage was sold) stops at 110%, and nothing it uses is
// billed. `slotlock overage report`, run by the owner (daily, and on the 1st for the month before),
// sends Stripe a Billing Meter event for each metered tenant's operations above its quota that it
// has not reported yet. What was reported is recorded in slotlock.overage_reports first by month, so
// no operation is billed twice, and each event carries an identifier Stripe deduplicates within a
// day: Stripe refusing one as already taken counts as sent.
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { SLOTLOCK_STRIPE_API_VERSION } from './billing.js';
import { SLOTLOCK_PLAN_QUOTAS } from './plans.js';

/** The stop percent overage moves a paying Developer tenant to unless SLOTLOCK_OVERAGE_STOP_PERCENT says. */
export const SLOTLOCK_DEFAULT_OVERAGE_STOP_PERCENT = 300;

export interface SlotlockOverageReport {
  month: string;
  /** Tenants with operations above their quota this month, and what each was billed now. */
  tenants: { tenant: string; over: number; reported: number; sent: number }[];
  /** Operations sent to Stripe in this run. */
  sent: number;
  /** Tenants whose event Stripe did not take (run again). */
  failed: number;
}

/** `YYYY-MM` of a time, UTC. */
export function slotlockMonthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

/**
 * Report each paying Developer tenant's operations above its quota in `month` to Stripe, once, where
 * its subscription carries the metered price. Runs as the schema owner, on a schema migrated by this
 * release. A month can be reported while it runs and once more after it ends.
 */
export async function reportSlotlockOverage(
  sql: Sql,
  input: {
    month: string;
    stripe: { secretKey: string; eventName: string; fetch?: typeof fetch; apiBase?: string };
    now?: number;
  },
): Promise<SlotlockOverageReport> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) {
    throw Object.assign(new Error('Slotlock month must be YYYY-MM'), { code: 'invalid_month' });
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.stripe.eventName)) {
    throw Object.assign(new Error('Slotlock overage meter event name must be 1-100 of A-Z, a-z, 0-9, _ and -'), {
      code: 'invalid_meter_event',
    });
  }
  const from = `${input.month}-01`;
  const [year, monthNumber] = input.month.split('-').map(Number) as [number, number];
  // The month's last second: a closed month's events are dated in it.
  const monthEnd = Date.UTC(year, monthNumber, 1) - 1_000;
  const quota = SLOTLOCK_PLAN_QUOTAS.developer.operations;
  // Paying Developer tenants (their own plan, a live subscription with the metered price) and what
  // they used this month.
  const rows = await sql<{ tenant_ref: string; customer: string; used: string; reported: string | null }[]>`
    SELECT plan.tenant_ref, plan.stripe_customer AS customer,
           COALESCE((SELECT sum(used.count) FROM slotlock.usage_daily used
                      WHERE used.tenant_ref = plan.tenant_ref AND used.metric = 'operations'
                        AND used.day >= ${from}::date
                        AND used.day < (${from}::date + interval '1 month')), 0)::text AS used,
           (SELECT done.reported FROM slotlock.overage_reports done
             WHERE done.tenant_ref = plan.tenant_ref AND done.month = ${from}::date)::text AS reported
      FROM slotlock.tenant_plans plan
     WHERE plan.plan = 'developer' AND plan.source = 'direct'
       AND plan.stripe_customer IS NOT NULL AND plan.stripe_subscription IS NOT NULL
       AND plan.status <> 'canceled' AND plan.overage_metered
     ORDER BY plan.tenant_ref`;
  const send = input.stripe.fetch ?? fetch;
  const report: SlotlockOverageReport = { month: input.month, tenants: [], sent: 0, failed: 0 };
  for (const row of rows) {
    const over = Math.max(0, Number(row.used) - quota);
    const reported = Number(row.reported ?? 0);
    if (over <= reported) {
      if (over > 0) report.tenants.push({ tenant: row.tenant_ref, over, reported, sent: 0 });
      continue;
    }
    const delta = over - reported;
    // Recorded first: a run that stops between the two bills too little, never twice.
    await sql`
      INSERT INTO slotlock.overage_reports (tenant_ref, month, reported)
      VALUES (${row.tenant_ref}, ${from}::date, ${over})
      ON CONFLICT (tenant_ref, month) DO UPDATE
        SET reported = GREATEST(slotlock.overage_reports.reported, EXCLUDED.reported), updated_at = statement_timestamp()`;
    // The same total gives the same identifier, so a retry within Stripe's window is one event.
    const identifier = `slotlock-overage-${createHash('sha256').update(row.tenant_ref).digest('hex').slice(0, 24)}-${input.month}-${over}`;
    const response = await send(`${input.stripe.apiBase ?? 'https://api.stripe.com'}/v1/billing/meter_events`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.stripe.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'stripe-version': SLOTLOCK_STRIPE_API_VERSION,
      },
      body: new URLSearchParams({
        event_name: input.stripe.eventName,
        identifier,
        'payload[stripe_customer_id]': row.customer,
        'payload[value]': String(delta),
        // Within the month it is billed in; a closed month's are dated its last second.
        timestamp: String(Math.floor(Math.min(input.now ?? Date.now(), monthEnd) / 1_000)),
      }).toString(),
    }).catch(() => null);
    if (!response?.ok && !(await takenBefore(response, identifier))) {
      // Not taken: put the record back, so the next run sends it.
      await sql`
        UPDATE slotlock.overage_reports SET reported = ${reported}, updated_at = statement_timestamp()
         WHERE tenant_ref = ${row.tenant_ref} AND month = ${from}::date AND reported = ${over}`;
      report.failed += 1;
      report.tenants.push({ tenant: row.tenant_ref, over, reported, sent: 0 });
      continue;
    }
    report.sent += delta;
    report.tenants.push({ tenant: row.tenant_ref, over, reported: over, sent: delta });
  }
  return report;
}

/**
 * Whether Stripe refused an event only because it took one with this identifier before: a run whose
 * answer was lost sends it again, and Stripe says so with a 400 and no code (read in test mode,
 * 2026-11-10). Counted as sent, or the record would go back and the next total bill this delta twice.
 */
async function takenBefore(response: Response | null, identifier: string): Promise<boolean> {
  if (response?.status !== 400) return false;
  const body = (await response.json().catch(() => null)) as { error?: { type?: string; message?: string } } | null;
  return (
    body?.error?.type === 'invalid_request_error' &&
    body.error.message === `An event already exists with identifier ${identifier}.`
  );
}
