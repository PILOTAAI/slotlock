// Hosted Slotlock's plans: what each one allows, and a tenant's plan as the database holds it
// (slotlock.tenant_plans, set from the tenant's Stripe subscription). A tenant with no plan row is on
// the deployment's default plan once it applies (slotlock.plan_defaults, `slotlock plan default`),
// and otherwise has no plan limits, so self-hosted Slotlock, which writes neither, is unchanged.
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

/**
 * What a plan allows a tenant to use each UTC calendar month (quotas.ts, with SLOTLOCK_QUOTAS=on).
 * They are the plan's, not stored per tenant: the Terms give 30 days' notice of a change, and the
 * release that makes it applies it to every tenant on the plan.
 */
export interface SlotlockPlanQuotas {
  /** Operations its API keys and the assistant run (MCP, A2A and REST, the application API too). */
  operations: number;
  /** Bookings made: reservations, events (a whole series is one) and holds confirmed. */
  bookings: number;
  /** Where use is refused, in percent of the quota: 100 stops at it, 110 allows a tenth more. */
  stopPercent: number;
}

export const SLOTLOCK_PLAN_QUOTAS: Readonly<Record<SlotlockPlan, Readonly<SlotlockPlanQuotas>>> =
  Object.freeze({
    free: Object.freeze({ operations: 25_000, bookings: 1_000, stopPercent: 100 }),
    developer: Object.freeze({ operations: 500_000, bookings: 25_000, stopPercent: 110 }),
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

/** The plan every tenant without one of its own is on, from `appliesFrom`. */
export interface SlotlockPlanDefault {
  plan: SlotlockPlan;
  limits: SlotlockPlanLimits;
  appliesFrom: Date;
}

/** The deployment's default plan, or null when it has none. */
export async function readSlotlockPlanDefault(sql: SlotlockSql): Promise<SlotlockPlanDefault | null> {
  const [row] = await sql<
    {
      plan: SlotlockPlan;
      max_resources: number;
      max_api_keys: number;
      max_webhook_endpoints: number;
      applies_from: Date;
    }[]
  >`SELECT * FROM slotlock.plan_default()`;
  if (!row) return null;
  return {
    plan: row.plan,
    limits: {
      resources: row.max_resources,
      apiKeys: row.max_api_keys,
      webhookEndpoints: row.max_webhook_endpoints,
    },
    appliesFrom: row.applies_from,
  };
}

/**
 * Sets the default plan, with the limits that plan allows, or removes it (null). Only the deployment
 * role may: another is refused EXECUTE (`plan_default_not_permitted`).
 */
export async function setSlotlockPlanDefault(
  sql: SlotlockSql,
  input: { plan: SlotlockPlan; appliesFrom: Date } | null,
): Promise<void> {
  const limits = input ? SLOTLOCK_PLAN_LIMITS[input.plan] : null;
  await sql`SELECT slotlock.set_plan_default(
    ${input?.plan ?? null}::text, ${limits?.resources ?? null}::integer,
    ${limits?.apiKeys ?? null}::integer, ${limits?.webhookEndpoints ?? null}::integer,
    ${input?.appliesFrom ?? null}::timestamptz)`.catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code !== '42501') throw error;
    throw Object.assign(
      new Error('Slotlock sets the default plan only as the deployment role', { cause: error }),
      { code: 'plan_default_not_permitted' as const },
    );
  });
}

/**
 * Puts a new tenant on the default plan at once, while the default does not yet apply to every
 * tenant: one with no API key, nothing in its feed and no webhook. True when it did. The dashboard
 * calls it before a tenant adds a key, resource or webhook endpoint.
 */
export async function enrolSlotlockTenantPlan(sql: SlotlockSql, tenantRef: string): Promise<boolean> {
  const [row] = await sql<{ enrolled: boolean }[]>`
    SELECT slotlock.enrol_tenant_plan(${tenantRef}::text) AS enrolled`.catch((error: unknown) => {
    throw slotlockPlanReadRefusal(error, 'slotlock.enrol_tenant_plan(text)');
  });
  return row?.enrolled === true;
}

/**
 * Reading a tenant's plan needs EXECUTE on slotlock.tenant_plan(text), which `slotlock migrate` (or
 * grantApplicationRole) grants: a role without it is told so (`application_role_not_granted`).
 */
export function slotlockPlanReadRefusal(
  error: unknown,
  signature = 'slotlock.tenant_plan(text)',
): unknown {
  if ((error as { code?: unknown } | null)?.code !== '42501') return error;
  return Object.assign(
    new Error(
      `Slotlock serving role may not run ${signature}: grant it what this release needs with grantApplicationRole (\`slotlock migrate\` does), once per release`,
      { cause: error },
    ),
    { code: 'application_role_not_granted' as const },
  );
}
