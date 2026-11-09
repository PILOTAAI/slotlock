// Hosted Slotlock's plans: what each one allows, and a tenant's plan as the database holds it
// (slotlock.tenant_plans, set from the tenant's Stripe subscription). A tenant with no plan row has no
// plan limits, so self-hosted Slotlock, which never writes one, is unchanged.
import type { SlotlockSql } from './store.js';

/** The plans hosted Slotlock sells. Custom runs on the customer's own servers and needs no row. */
export type SlotlockPlan = 'free' | 'developer';

/** Where the tenant's billing stands. A `canceled` or long-unpaid tenant is on the Free limits. */
export type SlotlockPlanStatus = 'active' | 'past_due' | 'canceled';

/** What a plan allows a tenant to hold at once. */
export interface SlotlockPlanLimits {
  /** Resources, archived ones included (the store's own count). */
  resources: number;
  /** Active API keys. */
  apiKeys: number;
  /** Webhook endpoints. */
  webhookEndpoints: number;
}

export const SLOTLOCK_PLAN_LIMITS: Readonly<Record<SlotlockPlan, Readonly<SlotlockPlanLimits>>> =
  Object.freeze({
    free: Object.freeze({ resources: 10, apiKeys: 10, webhookEndpoints: 2 }),
    developer: Object.freeze({ resources: 100, apiKeys: 100, webhookEndpoints: 10 }),
  });

/** A tenant's plan as the database holds it. */
export interface SlotlockTenantPlan {
  plan: SlotlockPlan;
  status: SlotlockPlanStatus;
  limits: SlotlockPlanLimits;
  stripeCustomer: string | null;
  stripeSubscription: string | null;
  currentPeriodEnd: Date | null;
}

interface TenantPlanRow {
  plan: SlotlockPlan;
  status: SlotlockPlanStatus;
  max_resources: number;
  max_api_keys: number;
  max_webhook_endpoints: number;
  stripe_customer: string | null;
  stripe_subscription: string | null;
  current_period_end: Date | null;
}

/** The tenant's plan, or null when it has none (no plan limits apply). */
export async function readSlotlockTenantPlan(
  sql: SlotlockSql,
  tenantRef: string,
): Promise<SlotlockTenantPlan | null> {
  const [row] = await sql<TenantPlanRow[]>`SELECT * FROM slotlock.tenant_plan(${tenantRef}::text)`;
  if (!row) return null;
  return {
    plan: row.plan,
    status: row.status,
    limits: {
      resources: row.max_resources,
      apiKeys: row.max_api_keys,
      webhookEndpoints: row.max_webhook_endpoints,
    },
    stripeCustomer: row.stripe_customer,
    stripeSubscription: row.stripe_subscription,
    currentPeriodEnd: row.current_period_end,
  };
}

/** Sets the tenant's plan, with the limits that plan allows. */
export async function setSlotlockTenantPlan(
  sql: SlotlockSql,
  input: {
    tenantRef: string;
    plan: SlotlockPlan;
    status: SlotlockPlanStatus;
    stripeCustomer?: string | null;
    stripeSubscription?: string | null;
    currentPeriodEnd?: Date | null;
  },
): Promise<void> {
  const limits = SLOTLOCK_PLAN_LIMITS[input.plan];
  await sql`SELECT slotlock.set_tenant_plan(
    ${input.tenantRef}::text, ${input.plan}::text, ${input.status}::text,
    ${limits.resources}::integer, ${limits.apiKeys}::integer, ${limits.webhookEndpoints}::integer,
    ${input.stripeCustomer ?? null}::text, ${input.stripeSubscription ?? null}::text,
    ${input.currentPeriodEnd ?? null}::timestamptz)`;
}
