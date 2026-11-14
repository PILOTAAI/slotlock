// Partner accounts (RFC 0003 part 4): a platform such as stackapi.app creates and runs Slotlock
// tenants for its own users and pays Pylota for them.
//
// - A partner (P1) is made by the deployment's schema owner (`slotlock partner create`), with a
//   contract: the plans its accounts may be on, the scopes their keys may carry, and its prices. Its
//   keys (`slk_partner_…`, stored as SHA-256 digests) carry the `partner` scope, which reaches the
//   partner API and nothing else: no calendar data, no tenant's tools.
// - Each of its users is an account (P2), tenant `partner:<partner>:<account>`: an ordinary tenant
//   under forced row-level security, with every limit, history and erasure. A suspended partner
//   suspends every account at once, and their keys stop authenticating.
// - The partner API (P3) creates accounts and puts them on a contract plan (P4: its limits and
//   quotas, never above the contract), makes, rotates and revokes their keys, suspends and erases
//   them, and reads their usage (P5).
import type { Sql } from 'postgres';
import { SlotlockAgentOperationError, type SlotlockAgentPrincipal } from './agent-server.js';
import {
  type SlotlockApiKey,
  type SlotlockApiKeyScope,
  type SlotlockApiKeyStore,
  SLOTLOCK_API_KEY_SCOPES,
  generateSlotlockPartnerKey,
  isSlotlockPartnerKey,
  slotlockApiKeyDigest,
  slotlockBearerCredential,
} from './api-keys.js';
import { SLOTLOCK_API_KEY_ACTIVE_LIMIT, SLOTLOCK_USAGE_RETENTION_DAYS } from './ddl.js';
import type { SlotlockSql } from './store.js';

import {
  SLOTLOCK_PARTNER_ACCOUNT,
  SLOTLOCK_PARTNER_ID,
  SLOTLOCK_PARTNER_PLAN,
  SLOTLOCK_PARTNER_SCOPE,
} from './partner-names.js';

export { SLOTLOCK_PARTNER_ACCOUNT, SLOTLOCK_PARTNER_ID, SLOTLOCK_PARTNER_PLAN, SLOTLOCK_PARTNER_SCOPE };

/** The tenant a partner's account is. */
export function slotlockPartnerTenantRef(partnerId: string, account: string): string {
  return `partner:${partnerId}:${account}`;
}

/** What one contract plan allows an account: as a hosted plan's limits and quotas. */
export interface SlotlockPartnerPlan {
  resources: number;
  apiKeys: number;
  webhookEndpoints: number;
  operations: number;
  bookings: number;
  /** Where use is refused, in percent of the quota (100-1000). */
  stopPercent: number;
}

/**
 * What a partner is billed (P6), in the currency's minor units: each account with at least one
 * operation in the month, each 10,000 operations and each 100 bookings an account made above its
 * plan's quota, and at least `minimum` a month.
 */
export interface SlotlockPartnerPricing {
  currency: string;
  activeAccount: number;
  operationsOverQuotaPer10k: number;
  bookingsOverQuotaPer100: number;
  minimum: number;
}

export interface SlotlockPartnerContract {
  plans: Readonly<Record<string, SlotlockPartnerPlan>>;
  /** The scopes an account's key may carry; `read` and `write` unless the contract says. */
  keyScopes: readonly SlotlockApiKeyScope[];
  pricing?: SlotlockPartnerPricing;
  /**
   * Whether the partner's keys may act for its accounts with `Slotlock-Account` (`act_on_behalf`,
   * RFC 0003 P3), instead of a key per account. Off unless the contract says.
   */
  actOnBehalf?: boolean;
}

function contractError(message: string): Error & { code: 'invalid_partner_contract' } {
  return Object.assign(new Error(`Slotlock partner contract: ${message}`), {
    code: 'invalid_partner_contract' as const,
  });
}

const whole = (value: unknown, min: number, max: number) =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/**
 * Read a contract as the owner writes it (snake_case JSON, as the database keeps it), refusing one
 * the database would not take: `invalid_partner_contract`.
 */
export function parseSlotlockPartnerContract(value: unknown): SlotlockPartnerContract {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw contractError('must be an object');
  const given = value as Record<string, unknown>;
  const plansGiven = given.plans;
  if (typeof plansGiven !== 'object' || plansGiven === null || Array.isArray(plansGiven)) {
    throw contractError('plans must be an object of plans by name');
  }
  const entries = Object.entries(plansGiven as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 20) throw contractError('needs 1-20 plans');
  const plans: Record<string, SlotlockPartnerPlan> = {};
  for (const [name, plan] of entries) {
    if (!SLOTLOCK_PARTNER_PLAN.test(name)) throw contractError(`plan name ${JSON.stringify(name)} is not a plan name`);
    const fields = (plan ?? {}) as Record<string, unknown>;
    const limits = {
      resources: fields.resources,
      apiKeys: fields.api_keys,
      webhookEndpoints: fields.webhook_endpoints,
      operations: fields.operations,
      bookings: fields.bookings,
      stopPercent: fields.stop_percent ?? 100,
    };
    if (
      !whole(limits.resources, 1, 100_000) ||
      !whole(limits.apiKeys, 1, SLOTLOCK_API_KEY_ACTIVE_LIMIT) ||
      !whole(limits.webhookEndpoints, 1, 1_000) ||
      !whole(limits.operations, 1, 1_000_000_000_000) ||
      !whole(limits.bookings, 1, 1_000_000_000_000) ||
      !whole(limits.stopPercent, 100, 1_000)
    ) {
      throw contractError(
        `plan ${name} needs resources (1-100,000), api_keys (1-${SLOTLOCK_API_KEY_ACTIVE_LIMIT}), webhook_endpoints (1-1,000), operations and bookings (whole, at least 1) and stop_percent (100-1,000)`,
      );
    }
    plans[name] = limits as SlotlockPartnerPlan;
  }
  const scopesGiven = given.key_scopes ?? ['read', 'write'];
  if (
    !Array.isArray(scopesGiven) ||
    scopesGiven.length === 0 ||
    scopesGiven.some((scope) => !(SLOTLOCK_API_KEY_SCOPES as readonly unknown[]).includes(scope))
  ) {
    throw contractError(`key_scopes must list some of ${SLOTLOCK_API_KEY_SCOPES.join(', ')}`);
  }
  const contract: SlotlockPartnerContract = {
    plans,
    keyScopes: SLOTLOCK_API_KEY_SCOPES.filter((scope) => scopesGiven.includes(scope)),
  };
  if (given.act_on_behalf !== undefined) {
    if (typeof given.act_on_behalf !== 'boolean') throw contractError('act_on_behalf must be true or false');
    if (given.act_on_behalf) contract.actOnBehalf = true;
  }
  if (given.pricing !== undefined) {
    const pricing = (given.pricing ?? {}) as Record<string, unknown>;
    const parsed = {
      currency: pricing.currency,
      activeAccount: pricing.active_account ?? 0,
      operationsOverQuotaPer10k: pricing.operations_over_quota_per_10k ?? 0,
      bookingsOverQuotaPer100: pricing.bookings_over_quota_per_100 ?? 0,
      minimum: pricing.minimum ?? 0,
    };
    if (
      typeof parsed.currency !== 'string' ||
      !/^[a-z]{3}$/.test(parsed.currency) ||
      !whole(parsed.activeAccount, 0, 100_000_000) ||
      !whole(parsed.operationsOverQuotaPer10k, 0, 100_000_000) ||
      !whole(parsed.bookingsOverQuotaPer100, 0, 100_000_000) ||
      !whole(parsed.minimum, 0, 1_000_000_000)
    ) {
      throw contractError(
        'pricing needs a currency (ISO 4217, lowercase) and whole amounts in its minor units: active_account, operations_over_quota_per_10k, bookings_over_quota_per_100, minimum',
      );
    }
    contract.pricing = parsed as SlotlockPartnerPricing;
  }
  return contract;
}

/** One of the partner's accounts, as the partner API shows it. */
export interface SlotlockPartnerAccount {
  account: string;
  plan: string;
  status: 'active' | 'suspended';
  createdAt: Date;
  updatedAt: Date;
  /** Resources, archived ones included, and active keys: on a single account's read only. */
  resources?: number;
  apiKeys?: number;
}

/** A partner's accounts' usage by account, UTC day and metric (P5). */
export interface SlotlockPartnerUsageRow {
  account: string;
  day: string;
  metric: string;
  count: number;
}

const partnerRefusal = (code: string, status: number, message?: string) =>
  new SlotlockAgentOperationError(code, status, message ? { message } : undefined);

/** The partner a principal acts for: a partner key's, or nothing (never a tenant's key). */
export function slotlockPrincipalPartner(principal: SlotlockAgentPrincipal): string {
  const partner = principal.partnerId;
  if (
    typeof partner !== 'string' ||
    !SLOTLOCK_PARTNER_ID.test(partner) ||
    !Array.isArray(principal.scopes) ||
    !principal.scopes.includes(SLOTLOCK_PARTNER_SCOPE)
  ) {
    throw partnerRefusal('forbidden', 403);
  }
  return partner;
}

/** What the partner API reads and changes, for one partner at a time. */
export interface SlotlockPartnerStore {
  contract(partnerId: string): Promise<SlotlockPartnerContract | null>;
  putAccount(
    partnerId: string,
    account: string,
    plan: string,
  ): Promise<{ account: SlotlockPartnerAccount; created: boolean } | null>;
  listAccounts(partnerId: string): Promise<SlotlockPartnerAccount[]>;
  getAccount(partnerId: string, account: string): Promise<SlotlockPartnerAccount | null>;
  /** The account's tenant, or null when the partner has no such account. */
  tenantOf(partnerId: string, account: string): Promise<string | null>;
  /** True when it changed something; null for no such account. */
  setSuspended(partnerId: string, account: string, suspended: boolean, reason?: string): Promise<boolean | null>;
  usage(partnerId: string, from: string, to: string, account?: string): Promise<SlotlockPartnerUsageRow[]>;
  /** Record a partner's comparison of one day's counts (P5 reconciliation). */
  recordReconciliation(partnerId: string, day: string, accounts: number, mismatched: number, worstPercent: number): Promise<void>;
  /** The account's keys, made and changed as any tenant's (api-keys.ts). */
  keys: SlotlockApiKeyStore;
  /**
   * Erase the account's tenant, with its partner's record of it, suspended or not. The partner API
   * does not call it: it erases as `/v1/tenant/erase` does, refusing a suspended account in the
   * erasure's own transaction.
   */
  eraseAccount(partnerId: string, account: string): Promise<{ erased: boolean; total: number }>;
}

interface AccountRow {
  account: string;
  plan: string;
  suspended: boolean;
  created_at: Date;
  updated_at: Date;
  resources?: string;
  api_keys?: string;
}

const toAccount = (row: AccountRow): SlotlockPartnerAccount => ({
  account: row.account,
  plan: row.plan,
  status: row.suspended ? 'suspended' : 'active',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.resources !== undefined ? { resources: Number(row.resources) } : {}),
  ...(row.api_keys !== undefined ? { apiKeys: Number(row.api_keys) } : {}),
});

/**
 * The partner store over the serving role, through SLOTLOCK_PARTNER_FUNCTIONS. `keys` is the API
 * key store; `eraseTenant` the store's erasure (a tenant's whole data, as `/v1/tenant/erase`).
 */
export function createSlotlockPartnerStore(
  sql: SlotlockSql,
  deps: { keys: SlotlockApiKeyStore; eraseTenant(tenantRef: string): Promise<{ total: number }> },
): SlotlockPartnerStore {
  const tenantOf = async (partnerId: string, account: string) => {
    if (!SLOTLOCK_PARTNER_ID.test(partnerId) || !SLOTLOCK_PARTNER_ACCOUNT.test(account)) return null;
    const [row] = await sql<{ tenant_ref: string }[]>`
      SELECT tenant_ref FROM slotlock.get_partner_account(${partnerId}::text, ${account}::text)`;
    return row?.tenant_ref ?? null;
  };
  return {
    async contract(partnerId) {
      if (!SLOTLOCK_PARTNER_ID.test(partnerId)) return null;
      const [row] = await sql<{ contract: unknown }[]>`
        SELECT slotlock.partner_contract(${partnerId}::text) AS contract`;
      return row?.contract ? parseSlotlockPartnerContract(row.contract) : null;
    },
    async putAccount(partnerId, account, plan) {
      try {
        const [row] = await sql<(AccountRow & { created: boolean })[]>`
          SELECT put.account, put.plan, false AS suspended, put.created_at, put.updated_at, put.created
            FROM slotlock.put_partner_account(${partnerId}::text, ${account}::text, ${plan}::text) put`;
        if (!row) return null;
        const found = await this.getAccount(partnerId, account);
        return { account: found ?? toAccount(row), created: row.created };
      } catch (error) {
        const hint = (error as { hint?: unknown }).hint;
        if (hint === 'invalid_partner_plan' || hint === 'invalid_partner_account') {
          throw partnerRefusal(hint, 400);
        }
        throw error;
      }
    },
    async listAccounts(partnerId) {
      const rows = await sql<AccountRow[]>`
        SELECT account, plan, suspended, created_at, updated_at
          FROM slotlock.list_partner_accounts(${partnerId}::text)`;
      return rows.map(toAccount);
    },
    async getAccount(partnerId, account) {
      if (!SLOTLOCK_PARTNER_ACCOUNT.test(account)) return null;
      const [row] = await sql<AccountRow[]>`
        SELECT account, plan, suspended, created_at, updated_at, resources::text, api_keys::text
          FROM slotlock.get_partner_account(${partnerId}::text, ${account}::text)`;
      return row ? toAccount(row) : null;
    },
    tenantOf,
    async setSuspended(partnerId, account, suspended, reason) {
      if (!SLOTLOCK_PARTNER_ACCOUNT.test(account)) return null;
      const [row] = await sql<{ changed: boolean | null }[]>`
        SELECT slotlock.set_partner_account_suspended(
          ${partnerId}::text, ${account}::text, ${suspended}::boolean, ${reason ?? null}::text) AS changed`;
      return row?.changed ?? null;
    },
    async usage(partnerId, from, to, account) {
      const rows = await sql<{ account: string; day: string; metric: string; count: string }[]>`
        SELECT account, day::text, metric, count::text
          FROM slotlock.partner_usage(${partnerId}::text, ${from}::date, ${to}::date, ${account ?? null}::text)`;
      return rows.map((row) => ({ account: row.account, day: row.day, metric: row.metric, count: Number(row.count) }));
    },
    async recordReconciliation(partnerId, day, accounts, mismatched, worstPercent) {
      await sql`SELECT slotlock.record_partner_reconciliation(${partnerId}::text, ${day}::date,
        ${accounts}::integer, ${mismatched}::integer, ${worstPercent}::numeric)`;
    },
    keys: deps.keys,
    async eraseAccount(partnerId, account) {
      const tenantRef = await tenantOf(partnerId, account);
      if (!tenantRef) return { erased: false, total: 0 };
      const erased = await deps.eraseTenant(tenantRef);
      return { erased: true, total: erased.total };
    },
  };
}

/**
 * Bearer authentication by partner key: a request with an active partner's unrevoked key is the
 * principal `partner_key:<id>` with the `partner` scope and its `partnerId`, in a tenant of its own
 * (`partner:<partner>`) that holds no data. Anything else is not a partner key (null), for the
 * tenant authenticator to try.
 */
export function createSlotlockPartnerKeyAuthenticator(
  sql: SlotlockSql,
): (request: Request) => Promise<SlotlockAgentPrincipal | null> {
  const contracts = new Map<string, SlotlockPartnerContract | null>();
  return async (request) => {
    const presented = slotlockBearerCredential(request);
    if (presented === undefined || !isSlotlockPartnerKey(presented)) return null;
    const account = request.headers.get(SLOTLOCK_ACCOUNT_FIELD);
    // A malformed account is refused before the key is looked up, as a malformed key is.
    if (account !== null && !SLOTLOCK_PARTNER_ACCOUNT.test(account)) return null;
    // One statement: the key, and with Slotlock-Account its partner's contract and the account's tenant.
    const [row] = await sql<{ key_id: string; partner_id: string; contract: string | null; tenant_ref: string | null }[]>`
      SELECT authenticated.key_id::text, authenticated.partner_id,
             CASE WHEN ${account}::text IS NULL THEN NULL
                  ELSE slotlock.partner_contract(authenticated.partner_id)::text END AS contract,
             CASE WHEN ${account}::text IS NULL THEN NULL
                  ELSE slotlock.partner_account_tenant(authenticated.partner_id, ${account}::text) END AS tenant_ref
        FROM slotlock.authenticate_partner_key(${slotlockApiKeyDigest(presented)}::bytea) authenticated`;
    if (!row) return null;
    if (account === null) {
      return {
        subject: `partner_key:${row.key_id}`,
        tenantRef: `partner:${row.partner_id}`,
        scopes: [SLOTLOCK_PARTNER_SCOPE],
        partnerId: row.partner_id,
      };
    }
    // Acting for one of its accounts (RFC 0003 P3): only where the contract allows it, only for an
    // account the partner has, and with no more than the contract lets its accounts' keys carry.
    if (!row.contract || !row.tenant_ref) return null;
    const contract = parsedContract(row.contract);
    if (!contract?.actOnBehalf) return null;
    return {
      subject: `partner_key:${row.key_id}`,
      tenantRef: row.tenant_ref,
      scopes: [...contract.keyScopes],
      onBehalfOf: row.partner_id,
    };
  };

  /** Contracts read, by their JSON text: parsed once while unchanged (at most 1,000 kept). */
  function parsedContract(text: string): SlotlockPartnerContract | null {
    const kept = contracts.get(text);
    if (kept !== undefined) return kept;
    let contract: SlotlockPartnerContract | null;
    try {
      contract = parseSlotlockPartnerContract(JSON.parse(text));
    } catch {
      contract = null;
    }
    if (contracts.size >= 1_000) contracts.delete(contracts.keys().next().value as string);
    contracts.set(text, contract);
    return contract;
  }
}

/** The request field a partner key names one of its accounts in, to act for it (RFC 0003 P3). */
export const SLOTLOCK_ACCOUNT_FIELD = 'slotlock-account';

// The schema owner's side (`slotlock partner …`): partners, their keys and status, as the owner
// role, which the partner tables' row-level security does not bind (it is enabled, not forced).

export interface SlotlockPartner {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  contract: SlotlockPartnerContract;
  stripeCustomer: string | null;
  webhookUrl: string | null;
  createdAt: Date;
}

interface PartnerRow {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  contract: unknown;
  stripe_customer: string | null;
  webhook_url: string | null;
  created_at: Date;
}

const toPartner = (row: PartnerRow): SlotlockPartner => ({
  id: row.id,
  name: row.name,
  status: row.status,
  contract: parseSlotlockPartnerContract(row.contract),
  stripeCustomer: row.stripe_customer,
  webhookUrl: row.webhook_url,
  createdAt: row.created_at,
});

/** The contract as the database keeps it: snake_case, as the owner writes it. */
export function slotlockPartnerContractJson(contract: SlotlockPartnerContract): Record<string, unknown> {
  return {
    plans: Object.fromEntries(
      Object.entries(contract.plans).map(([name, plan]) => [
        name,
        {
          resources: plan.resources,
          api_keys: plan.apiKeys,
          webhook_endpoints: plan.webhookEndpoints,
          operations: plan.operations,
          bookings: plan.bookings,
          stop_percent: plan.stopPercent,
        },
      ]),
    ),
    key_scopes: [...contract.keyScopes],
    ...(contract.actOnBehalf ? { act_on_behalf: true } : {}),
    ...(contract.pricing
      ? {
          pricing: {
            currency: contract.pricing.currency,
            active_account: contract.pricing.activeAccount,
            operations_over_quota_per_10k: contract.pricing.operationsOverQuotaPer10k,
            bookings_over_quota_per_100: contract.pricing.bookingsOverQuotaPer100,
            minimum: contract.pricing.minimum,
          },
        }
      : {}),
  };
}

/** Create a partner, or change its name and contract (as the schema owner). */
export async function putSlotlockPartner(
  sql: Sql,
  input: { id: string; name: string; contract: unknown },
): Promise<SlotlockPartner> {
  if (!SLOTLOCK_PARTNER_ID.test(input.id)) {
    throw Object.assign(new Error('Slotlock partner id must be 2-40 lowercase letters, digits or dashes, a letter first'), {
      code: 'invalid_partner',
    });
  }
  const contract = slotlockPartnerContractJson(parseSlotlockPartnerContract(input.contract));
  const [row] = await sql<PartnerRow[]>`
    INSERT INTO slotlock.partners (id, name, contract)
    VALUES (${input.id}, ${input.name}, ${JSON.stringify(contract)}::text::jsonb)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, contract = EXCLUDED.contract
    RETURNING id, name, status, contract, stripe_customer, webhook_url, created_at`;
  return toPartner(row as PartnerRow);
}

export async function listSlotlockPartners(sql: Sql): Promise<SlotlockPartner[]> {
  const rows = await sql<PartnerRow[]>`
    SELECT id, name, status, contract, stripe_customer, webhook_url, created_at
      FROM slotlock.partners ORDER BY id`;
  return rows.map(toPartner);
}

/** Suspend a partner (every account with it) or make it active again. False for no such partner. */
export async function setSlotlockPartnerStatus(sql: Sql, id: string, status: 'active' | 'suspended'): Promise<boolean> {
  const rows = await sql`UPDATE slotlock.partners SET status = ${status} WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

/** Where the partner is billed (P6) and where usage.period_closed goes (P5), with its secret. */
export async function setSlotlockPartnerBilling(
  sql: Sql,
  id: string,
  input: { stripeCustomer?: string | null; webhookUrl?: string | null; webhookSecret?: string | null },
): Promise<boolean> {
  const rows = await sql`
    UPDATE slotlock.partners
       SET stripe_customer = CASE WHEN ${input.stripeCustomer !== undefined} THEN ${input.stripeCustomer ?? null} ELSE stripe_customer END,
           webhook_url = CASE WHEN ${input.webhookUrl !== undefined} THEN ${input.webhookUrl ?? null} ELSE webhook_url END,
           webhook_secret = CASE WHEN ${input.webhookSecret !== undefined} THEN ${input.webhookSecret ?? null} ELSE webhook_secret END
     WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

/** A key for the partner, shown once: only its SHA-256 is kept. */
export async function createSlotlockPartnerKey(
  sql: Sql,
  partnerId: string,
  name: string,
): Promise<{ key: string; id: string; prefix: string }> {
  const { key, prefix, digest } = generateSlotlockPartnerKey();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO slotlock.partner_keys (partner_id, name, prefix, secret_hash)
    VALUES (${partnerId}, ${name}, ${prefix}, ${digest})
    RETURNING id::text`;
  return { key, id: (row as { id: string }).id, prefix };
}

/** Revoke one of a partner's keys at once. False for no such key. */
export async function revokeSlotlockPartnerKey(sql: Sql, partnerId: string, id: string): Promise<boolean> {
  const rows = await sql`
    UPDATE slotlock.partner_keys SET revoked_at = COALESCE(revoked_at, now())
     WHERE partner_id = ${partnerId} AND id = ${id}::uuid RETURNING id`;
  return rows.length > 0;
}

/** The partner API's view of a key it made for one of its accounts. */
export function slotlockPartnerKeyOutput(apiKey: SlotlockApiKey): Record<string, unknown> {
  return {
    id: apiKey.id,
    name: apiKey.name,
    prefix: apiKey.prefix,
    scopes: apiKey.scopes,
    created_at: apiKey.createdAt.toISOString(),
    expires_at: apiKey.expiresAt?.toISOString() ?? null,
    last_used_at: apiKey.lastUsedAt?.toISOString() ?? null,
    revoked_at: apiKey.revokedAt?.toISOString() ?? null,
    limits: apiKey.limits
      ? {
          ...(apiKey.limits.maxHolds !== undefined ? { max_holds: apiKey.limits.maxHolds } : {}),
          ...(apiKey.limits.maxHeldHours !== undefined ? { max_held_hours: apiKey.limits.maxHeldHours } : {}),
          ...(apiKey.limits.requestsPerMinute !== undefined
            ? { requests_per_minute: apiKey.limits.requestsPerMinute }
            : {}),
          ...(apiKey.limits.requiresApproval ? { requires_approval: true } : {}),
        }
      : null,
  };
}

/** The longest usage range the partner API reads, in days. */
export const SLOTLOCK_PARTNER_USAGE_DAYS = SLOTLOCK_USAGE_RETENTION_DAYS;
