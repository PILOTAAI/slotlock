// Approval policies and pending approvals (RFC 0004 A4), in the tenant's transaction under its
// row-level security. A policy says which writes a person approves before they are made, or which
// are refused; an approval is one such write waiting, its time held by holds that belong to it. The
// store's requestApproval makes one; the agent backend runs a granted one.
import type { Sql, TransactionSql } from 'postgres';
import type { SlotlockApproval, SlotlockApprovalKind, SlotlockApprovalPolicy } from './types.js';

type StoreSql = Sql | TransactionSql;

/** The longest a policy may let a write wait for a person: 30 days. */
export const SLOTLOCK_MAX_APPROVAL_MINUTES = 30 * 24 * 60;
/** The wait a policy that names none gives a person: a day. */
export const SLOTLOCK_DEFAULT_APPROVAL_MINUTES = 24 * 60;
/** The policy reference a key whose bookings all wait for a person is held by (RFC 0004 A5). */
export const SLOTLOCK_KEY_APPROVAL_POLICY = 'api-key';
/** Policies one tenant may have. */
export const SLOTLOCK_MAX_APPROVAL_POLICIES = 50;
export const SLOTLOCK_APPROVAL_KINDS: readonly SlotlockApprovalKind[] = Object.freeze(['single', 'pool', 'bundle', 'move']);
const POLICY_REF = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const GROUPING_REF = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** References of each kind a policy's applies_to may name. */
const MAX_APPLIES_TO = 50;

export class SlotlockApprovalPolicyError extends Error {
  readonly code = 'invalid_approval_policy' as const;
  constructor(message: string) {
    super(`Slotlock approval policy: ${message}`);
  }
}

export interface PutApprovalPolicyParams {
  tenantRef: string;
  ref: string;
  name: string;
  appliesTo?: SlotlockApprovalPolicy['appliesTo'];
  conditions?: SlotlockApprovalPolicy['conditions'];
  outcome: SlotlockApprovalPolicy['outcome'];
  approvalTtlMinutes?: number;
  leadMinutes?: number;
  /** It also holds the tenant's own bookings through the application API (default false). */
  includeApplication?: boolean;
}

interface PolicyRow {
  ref: string;
  name: string;
  applies_to: Record<string, unknown>;
  conditions: Record<string, unknown>;
  outcome: 'require_approval' | 'refuse';
  approval_ttl_minutes: number;
  lead_minutes: number;
  include_application: boolean;
  created_at: Date;
  updated_at: Date;
}

const POLICY_COLUMNS =
  'ref, name, applies_to, conditions, outcome, approval_ttl_minutes, lead_minutes, include_application, created_at, updated_at';

function toPolicy(row: PolicyRow): SlotlockApprovalPolicy {
  const applies = row.applies_to as { resource_ids?: string[]; pools?: string[]; locations?: string[]; groups?: string[] };
  const conditions = row.conditions as { longer_than_minutes?: number; outside_hours?: boolean; kinds?: SlotlockApprovalKind[] };
  return {
    ref: row.ref,
    name: row.name,
    appliesTo: {
      ...(applies.resource_ids ? { resourceIds: applies.resource_ids } : {}),
      ...(applies.pools ? { pools: applies.pools } : {}),
      ...(applies.locations ? { locations: applies.locations } : {}),
      ...(applies.groups ? { groups: applies.groups } : {}),
    },
    conditions: {
      ...(conditions.longer_than_minutes !== undefined ? { longerThanMinutes: conditions.longer_than_minutes } : {}),
      ...(conditions.outside_hours !== undefined ? { outsideHours: conditions.outside_hours } : {}),
      ...(conditions.kinds ? { kinds: conditions.kinds } : {}),
    },
    outcome: row.outcome,
    approvalTtlMinutes: row.approval_ttl_minutes,
    leadMinutes: row.lead_minutes,
    includeApplication: row.include_application === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function refList(values: readonly string[] | undefined, pattern: RegExp, what: string): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > MAX_APPLIES_TO || values.some((value) => !pattern.test(value))) {
    throw new SlotlockApprovalPolicyError(`${what} must be at most ${MAX_APPLIES_TO} references`);
  }
  return [...new Set(values)].sort();
}

/** A policy's stored shape, checked: applies_to and conditions in snake_case JSON. */
function storedPolicy(params: PutApprovalPolicyParams) {
  if (!POLICY_REF.test(params.ref)) throw new SlotlockApprovalPolicyError('ref must be 1-63 of a-z, 0-9, _ and -');
  if (params.ref === SLOTLOCK_KEY_APPROVAL_POLICY) {
    throw new SlotlockApprovalPolicyError(`ref ${SLOTLOCK_KEY_APPROVAL_POLICY} is the one a key's own approval uses`);
  }
  const name = params.name.trim();
  if (name.length < 1 || name.length > 200) throw new SlotlockApprovalPolicyError('name must be 1-200 characters');
  if (params.outcome !== 'require_approval' && params.outcome !== 'refuse') {
    throw new SlotlockApprovalPolicyError('outcome must be require_approval or refuse');
  }
  const ttl = params.approvalTtlMinutes ?? SLOTLOCK_DEFAULT_APPROVAL_MINUTES;
  const lead = params.leadMinutes ?? 0;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > SLOTLOCK_MAX_APPROVAL_MINUTES) {
    throw new SlotlockApprovalPolicyError(`approval_ttl_minutes must be 1-${SLOTLOCK_MAX_APPROVAL_MINUTES}`);
  }
  if (!Number.isSafeInteger(lead) || lead < 0 || lead > SLOTLOCK_MAX_APPROVAL_MINUTES) {
    throw new SlotlockApprovalPolicyError(`lead_minutes must be 0-${SLOTLOCK_MAX_APPROVAL_MINUTES}`);
  }
  const applies = params.appliesTo ?? {};
  const resourceIds = refList(applies.resourceIds, UUID, 'resource_ids');
  const appliesTo = {
    ...(resourceIds ? { resource_ids: resourceIds.map((id) => id.toLowerCase()) } : {}),
    ...(applies.pools ? { pools: refList(applies.pools, GROUPING_REF, 'pools') } : {}),
    ...(applies.locations ? { locations: refList(applies.locations, GROUPING_REF, 'locations') } : {}),
    ...(applies.groups ? { groups: refList(applies.groups, GROUPING_REF, 'groups') } : {}),
  };
  const given = params.conditions ?? {};
  if (
    given.longerThanMinutes !== undefined &&
    (!Number.isSafeInteger(given.longerThanMinutes) || given.longerThanMinutes < 0 || given.longerThanMinutes > 5_270_400)
  ) {
    throw new SlotlockApprovalPolicyError('longer_than_minutes must be 0-5,270,400');
  }
  if (given.outsideHours !== undefined && typeof given.outsideHours !== 'boolean') {
    throw new SlotlockApprovalPolicyError('outside_hours must be true or false');
  }
  if (
    given.kinds !== undefined &&
    (!Array.isArray(given.kinds) ||
      given.kinds.length === 0 ||
      given.kinds.some((kind) => !SLOTLOCK_APPROVAL_KINDS.includes(kind)))
  ) {
    throw new SlotlockApprovalPolicyError(`kinds must name some of ${SLOTLOCK_APPROVAL_KINDS.join(', ')}`);
  }
  const conditions = {
    ...(given.longerThanMinutes !== undefined ? { longer_than_minutes: given.longerThanMinutes } : {}),
    ...(given.outsideHours !== undefined ? { outside_hours: given.outsideHours } : {}),
    ...(given.kinds !== undefined ? { kinds: [...new Set(given.kinds)].sort() } : {}),
  };
  if (params.includeApplication !== undefined && typeof params.includeApplication !== 'boolean') {
    throw new SlotlockApprovalPolicyError('include_application must be true or false');
  }
  return { name, appliesTo, conditions, ttl, lead, includeApplication: params.includeApplication === true };
}

/** Create or replace a policy by its reference. Throws `invalid_approval_policy`; at most 50. */
export async function putApprovalPolicy(sql: StoreSql, params: PutApprovalPolicyParams): Promise<SlotlockApprovalPolicy | null> {
  const stored = storedPolicy(params);
  const [row] = await sql<PolicyRow[]>`
    INSERT INTO slotlock.approval_policies (
      tenant_ref, ref, name, applies_to, conditions, outcome, approval_ttl_minutes, lead_minutes,
      include_application
    )
    SELECT ${params.tenantRef}, ${params.ref}, ${stored.name}, ${sql.json(stored.appliesTo)},
           ${sql.json(stored.conditions)}, ${params.outcome}, ${stored.ttl}, ${stored.lead},
           ${stored.includeApplication}
     WHERE EXISTS (SELECT 1 FROM slotlock.approval_policies WHERE tenant_ref = ${params.tenantRef} AND ref = ${params.ref})
        OR (SELECT count(*) FROM slotlock.approval_policies WHERE tenant_ref = ${params.tenantRef})
           < ${SLOTLOCK_MAX_APPROVAL_POLICIES}
    ON CONFLICT (tenant_ref, ref) DO UPDATE
      SET name = EXCLUDED.name, applies_to = EXCLUDED.applies_to, conditions = EXCLUDED.conditions,
          outcome = EXCLUDED.outcome, approval_ttl_minutes = EXCLUDED.approval_ttl_minutes,
          lead_minutes = EXCLUDED.lead_minutes, include_application = EXCLUDED.include_application,
          updated_at = statement_timestamp()
    RETURNING ${sql.unsafe(POLICY_COLUMNS)}`;
  return row ? toPolicy(row) : null;
}

export async function listApprovalPolicies(sql: StoreSql, tenantRef: string): Promise<SlotlockApprovalPolicy[]> {
  const rows = await sql<PolicyRow[]>`
    SELECT ${sql.unsafe(POLICY_COLUMNS)} FROM slotlock.approval_policies
     WHERE tenant_ref = ${tenantRef} ORDER BY ref`;
  return rows.map(toPolicy);
}

export async function deleteApprovalPolicy(sql: StoreSql, tenantRef: string, ref: string): Promise<boolean> {
  if (!POLICY_REF.test(ref)) return false;
  const rows = await sql`DELETE FROM slotlock.approval_policies WHERE tenant_ref = ${tenantRef} AND ref = ${ref} RETURNING ref`;
  return rows.length > 0;
}

/**
 * The tenant's policies that apply to any of these resources: by id, pool, location (a resource in
 * a location inside one named counts) or group, or every resource when a policy names none.
 */
export async function approvalPoliciesFor(
  sql: StoreSql,
  tenantRef: string,
  resourceIds: readonly string[],
): Promise<SlotlockApprovalPolicy[]> {
  const ids = resourceIds.filter((id) => UUID.test(id));
  if (ids.length === 0) return [];
  const rows = await sql<PolicyRow[]>`
    SELECT ${sql.unsafe(POLICY_COLUMNS.split(', ').map((column) => `policy.${column}`).join(', '))}
      FROM slotlock.approval_policies policy
     WHERE policy.tenant_ref = ${tenantRef}
       AND EXISTS (
         SELECT 1 FROM slotlock.resources resource
          WHERE resource.tenant_ref = ${tenantRef} AND resource.id = ANY (${ids}::uuid[])
            AND (policy.applies_to = '{}'::jsonb
                 OR resource.id::text IN (SELECT pg_catalog.jsonb_array_elements_text(policy.applies_to -> 'resource_ids'))
                 OR resource.pool_ref IN (SELECT pg_catalog.jsonb_array_elements_text(policy.applies_to -> 'pools'))
                 OR (resource.location_ref IS NOT NULL
                     AND slotlock.location_path(resource.tenant_ref, resource.location_ref)
                         && ARRAY(SELECT pg_catalog.jsonb_array_elements_text(policy.applies_to -> 'locations')))
                 OR EXISTS (
                   SELECT 1 FROM slotlock.resource_group_members member
                    WHERE member.tenant_ref = resource.tenant_ref AND member.resource_id = resource.id
                      AND member.group_ref IN (SELECT pg_catalog.jsonb_array_elements_text(policy.applies_to -> 'groups')))))
     ORDER BY policy.ref`;
  return rows.map(toPolicy);
}

interface ApprovalRow {
  id: string;
  policy_ref: string;
  status: SlotlockApproval['status'];
  operation: SlotlockApproval['operation'];
  request: Record<string, unknown>;
  requester: Record<string, unknown>;
  hold_ids: string[];
  resource_ids: string[];
  starts_at: Date;
  ends_at: Date;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  reason: string | null;
  created_at: Date;
}

export const APPROVAL_COLUMNS =
  'id, policy_ref, status, operation, request, requester, hold_ids, resource_ids, starts_at, ends_at, expires_at, decided_by, decided_at, reason, created_at';

export function toApproval(row: ApprovalRow): SlotlockApproval {
  return {
    id: row.id,
    policyRef: row.policy_ref,
    status: row.status,
    operation: row.operation,
    request: row.request,
    requestedBy:
      typeof row.requester.subject === 'string'
        ? row.requester.subject.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || null
        : null,
    holdIds: row.hold_ids,
    resourceIds: row.resource_ids,
    start: row.starts_at,
    end: row.ends_at,
    expiresAt: row.expires_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export type ApprovalRowWithRequester = ApprovalRow;

export async function listApprovals(
  sql: StoreSql,
  params: { tenantRef: string; status?: SlotlockApproval['status']; limit: number },
): Promise<SlotlockApproval[]> {
  const rows = await sql<ApprovalRow[]>`
    SELECT ${sql.unsafe(APPROVAL_COLUMNS)} FROM slotlock.approvals
     WHERE tenant_ref = ${params.tenantRef}
       AND (${params.status ?? null}::text IS NULL OR status = ${params.status ?? null})
     ORDER BY created_at DESC, id
     LIMIT ${params.limit}`;
  return rows.map(toApproval);
}

/** One approval with whom it runs as, for a grant. */
export async function getApproval(
  sql: StoreSql,
  tenantRef: string,
  id: string,
): Promise<(SlotlockApproval & { requester: Record<string, unknown> }) | null> {
  if (!UUID.test(id)) return null;
  const [row] = await sql<ApprovalRow[]>`
    SELECT ${sql.unsafe(APPROVAL_COLUMNS)} FROM slotlock.approvals WHERE tenant_ref = ${tenantRef} AND id = ${id}`;
  return row ? { ...toApproval(row), requester: row.requester } : null;
}

/** The approval a requester's retry made, by its request key. */
export async function approvalByRequestKey(sql: StoreSql, tenantRef: string, requestKey: string): Promise<SlotlockApproval | null> {
  const [row] = await sql<ApprovalRow[]>`
    SELECT ${sql.unsafe(APPROVAL_COLUMNS)} FROM slotlock.approvals
     WHERE tenant_ref = ${tenantRef} AND request_key = ${requestKey}`;
  return row ? toApproval(row) : null;
}

async function noteApproval(sql: StoreSql, tenantRef: string, type: string, approval: SlotlockApproval): Promise<void> {
  await sql`
    INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
    VALUES (${tenantRef}, ${approval.resourceIds[0] ?? null}, ${type}, ${approval.id},
            ${sql.json({
              id: approval.id,
              policy: approval.policyRef,
              operation: approval.operation,
              status: approval.status,
              resource_ids: approval.resourceIds,
              start: approval.start.toISOString(),
              end: approval.end.toISOString(),
              expires_at: approval.expiresAt.toISOString(),
              ...(approval.reason ? { reason: approval.reason } : {}),
            })},
            NULLIF(current_setting('slotlock.actor', true), ''))`;
}

export { noteApproval as recordApprovalChange };

type Decided = { ok: true; approval: SlotlockApproval } | { ok: false; code: 'approval_not_found' | 'approval_not_pending' | 'approval_expired' };

/** Lock a pending, unexpired approval and let its holds go: the first half of a grant. */
export async function beginApprovalGrant(sql: StoreSql, tenantRef: string, id: string): Promise<Decided> {
  if (!UUID.test(id)) return { ok: false, code: 'approval_not_found' };
  const [row] = await sql<(ApprovalRow & { live: boolean })[]>`
    SELECT ${sql.unsafe(APPROVAL_COLUMNS)}, expires_at > statement_timestamp() AS live
      FROM slotlock.approvals WHERE tenant_ref = ${tenantRef} AND id = ${id} FOR UPDATE`;
  if (!row) return { ok: false, code: 'approval_not_found' };
  if (row.status !== 'pending') return { ok: false, code: 'approval_not_pending' };
  if (!row.live) return { ok: false, code: 'approval_expired' };
  await sql`DELETE FROM slotlock.reservations WHERE status = 'held' AND holder_ref = ${`approval:${id}`}`;
  return { ok: true, approval: toApproval(row) };
}

/** Mark a granted approval, in the transaction that made its write: the second half. */
export async function finishApprovalGrant(sql: StoreSql, tenantRef: string, id: string, decidedBy: string): Promise<SlotlockApproval> {
  const [row] = await sql<ApprovalRow[]>`
    UPDATE slotlock.approvals
       SET status = 'granted', decided_by = ${decidedBy}, decided_at = statement_timestamp()
     WHERE tenant_ref = ${tenantRef} AND id = ${id} AND status = 'pending'
     RETURNING ${sql.unsafe(APPROVAL_COLUMNS)}`;
  if (!row) throw new Error('slotlock: approval grant found no pending approval');
  const approval = toApproval(row);
  await noteApproval(sql, tenantRef, 'approval.granted', approval);
  return approval;
}

/** Decline a pending approval: its holds go, and the feed says so. */
export async function declineApproval(
  sql: StoreSql,
  params: { tenantRef: string; id: string; decidedBy: string; reason?: string },
): Promise<Decided> {
  if (!UUID.test(params.id)) return { ok: false, code: 'approval_not_found' };
  const [row] = await sql<ApprovalRow[]>`
    SELECT ${sql.unsafe(APPROVAL_COLUMNS)} FROM slotlock.approvals
     WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id} FOR UPDATE`;
  if (!row) return { ok: false, code: 'approval_not_found' };
  if (row.status !== 'pending') return { ok: false, code: 'approval_not_pending' };
  await sql`DELETE FROM slotlock.reservations WHERE status = 'held' AND holder_ref = ${`approval:${params.id}`}`;
  const [declined] = await sql<ApprovalRow[]>`
    UPDATE slotlock.approvals
       SET status = 'declined', decided_by = ${params.decidedBy}, decided_at = statement_timestamp(),
           reason = ${params.reason ?? null}
     WHERE id = ${params.id}
     RETURNING ${sql.unsafe(APPROVAL_COLUMNS)}`;
  const approval = toApproval(declined as ApprovalRow);
  await noteApproval(sql, params.tenantRef, 'approval.declined', approval);
  return { ok: true, approval };
}

/** Maintenance: pending approvals past their wait expire, their holds go. How many did. */
export async function expireApprovals(sql: StoreSql, tenantRef: string, limit: number): Promise<number> {
  const rows = await sql<ApprovalRow[]>`
    UPDATE slotlock.approvals
       SET status = 'expired', decided_by = 'slotlock:maintenance', decided_at = statement_timestamp()
     WHERE id IN (
       SELECT id FROM slotlock.approvals
        WHERE tenant_ref = ${tenantRef} AND status = 'pending' AND expires_at <= statement_timestamp()
        ORDER BY expires_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
     RETURNING ${sql.unsafe(APPROVAL_COLUMNS)}`;
  for (const row of rows) {
    await sql`DELETE FROM slotlock.reservations WHERE status = 'held' AND holder_ref = ${`approval:${row.id}`}`;
    await noteApproval(sql, tenantRef, 'approval.expired', toApproval(row));
  }
  return rows.length;
}
