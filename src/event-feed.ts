// The event feed: what changed for a tenant, read by position, and the webhook endpoints it is
// delivered to. Rows are appended by triggers in the changing transaction (ddl.ts,
// SLOTLOCK_OUTBOX_DDL); webhooks.ts signs and sends.
import { slotlockPlanReadRefusal } from './plans.js';
import { randomBytes } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

type SlotlockSql = Sql | TransactionSql;

/** A transaction on a client, or a savepoint inside the caller's (a tenant's, say). */
async function inTransaction<T>(sql: SlotlockSql, callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return ('begin' in sql ? sql.begin(callback) : sql.savepoint(callback)) as Promise<T>;
}

/** What a change can be, as the feed and a webhook's `event_types` name it. */
export const SLOTLOCK_CHANGE_TYPES = Object.freeze([
  'hold.created',
  'hold.updated',
  'hold.confirmed',
  'hold.released',
  'hold.expired',
  'reservation.created',
  'reservation.updated',
  'reservation.cancelled',
  'reservation.checked_in',
  'reservation.no_show',
  'event.created',
  'event.updated',
  'event.cancelled',
  'event.timezone_shifted',
  'event.timezone_conflict',
  'coverage.stale',
  'waitlist.offered',
  'waitlist.expired',
  'webhook.disabled',
  // A plan's monthly quota 80% or 100% used (quotas.ts): the metric, the share and the counts.
  'usage.threshold_reached',
  // Configuration changes: ids and states, never a secret or a URL.
  'resource.created',
  'resource.updated',
  'resource.archived',
  'resource.restored',
  'resource.deleted',
  'coverage.recorded',
  'coverage.deleted',
  'webhook.created',
  'webhook.enabled',
  'webhook.deleted',
  'key.created',
  'key.rotated',
  'key.revoked',
] as const);

export type SlotlockChangeType = (typeof SLOTLOCK_CHANGE_TYPES)[number];

/**
 * Where a change came from (withTenant's `origin`): an agent protocol (`mcp`, `a2a`), the REST
 * API's agent routes (`rest`) or application operations (`application`), the dashboard, its
 * assistant, maintenance, or direct store calls (`library`). Never anything about a person.
 */
export const SLOTLOCK_CHANGE_ORIGINS = Object.freeze([
  'mcp',
  'a2a',
  'rest',
  'application',
  'dashboard',
  'dashboard-assistant',
  'maintenance',
  'library',
] as const);

export type SlotlockChangeOrigin = (typeof SLOTLOCK_CHANGE_ORIGINS)[number];

/** Whether `value` is one of SLOTLOCK_CHANGE_ORIGINS. */
export function isSlotlockChangeOrigin(value: unknown): value is SlotlockChangeOrigin {
  return typeof value === 'string' && (SLOTLOCK_CHANGE_ORIGINS as readonly string[]).includes(value);
}

/**
 * The unkeyed digest 0.5.3 named a coverage source by (`src_` + 24 hex of sha256(tenant, newline,
 * source)); anyone knowing the tenant could confirm a guess. Used only by the upgrade to find and
 * rename those changes. `tenant` and `source` are SQL expressions.
 */
export function legacyCoverageSourceDigestSql(tenant: string, source: string): string {
  return `'src_' || pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${tenant} || E'\\n' || ${source}, 'UTF8')), 'hex'), 24)`;
}

/**
 * Throws `coverage_source_id_unavailable`: since 0.6 a source's `source_id` is random and only the
 * database knows it (0.5.3's unkeyed digest let anyone confirm a guessed source).
 *
 * @deprecated Read `sourceId` from `listCoverage` (`source_id` of `slotlock_get_coverage`). It may
 * be removed in 0.7.0.
 */
export function slotlockCoverageSourceId(_tenantRef: string, _source: string): never {
  throw Object.assign(
    new Error(
      "slotlockCoverageSourceId cannot work out a source's id since 0.6: it is random. Read sourceId from listCoverage (source_id of slotlock_get_coverage)",
    ),
    { code: 'coverage_source_id_unavailable' as const },
  );
}

/** What a coverage source's `source_id` is: `src_` and 32 random hex digits. */
const SLOTLOCK_COVERAGE_SOURCE_ID = /^src_[0-9a-f]{32}$/;

/**
 * The `source_id` of a `coverage.*` change whose source can no longer be named: an earlier
 * release's change whose source was deleted, or one not yet renamed.
 */
const SLOTLOCK_REDACTED_SOURCE_ID = 'src_redacted';

/**
 * A change's subject and data as the feed serves them. A `coverage.*` change never carries `source`
 * or `last_error` (which can quote it), and is named by a current `source_id` or `src_redacted`:
 * rows an earlier release wrote are renamed in batches after upgrade, so one not reached yet is
 * served redacted.
 */
export function slotlockServedChange(
  type: string,
  subject: string,
  data: Record<string, unknown>,
): { subject: string; data: Record<string, unknown> } {
  if (!type.startsWith('coverage.')) return { subject, data };
  const { source: _source, last_error: _lastError, ...rest } = data;
  const sourceId = SLOTLOCK_COVERAGE_SOURCE_ID.test(subject) ? subject : SLOTLOCK_REDACTED_SOURCE_ID;
  return { subject: sourceId, data: { ...rest, source_id: sourceId } };
}

/** How long the feed keeps a change, and so how far back a cursor may reach. */
export const SLOTLOCK_CHANGE_RETENTION_DAYS = 30;
/** Webhook endpoints one tenant may have. */
export const SLOTLOCK_MAX_WEBHOOK_ENDPOINTS = 25;
/** After this long failing, an endpoint is disabled and the feed says so (`webhook.disabled`). */
export const SLOTLOCK_WEBHOOK_FAILING_LIMIT_MS = 24 * 60 * 60 * 1_000;

export interface SlotlockChange {
  /** Stable across every read and every delivery: the webhook's `webhook-id`. */
  id: string;
  type: SlotlockChangeType;
  resourceId: string | null;
  /** The record that changed: a booking's reference, else its id. */
  subject: string;
  data: Record<string, unknown>;
  occurredAt: Date;
  /** Who made it (withTenant's `actor`: an API key, an agent), or null when unrecorded. */
  actor: string | null;
  /** Where it came from (withTenant's `origin`), or null when unrecorded (before 0.6, say). */
  origin: SlotlockChangeOrigin | null;
  /** The API key that made it (withTenant's `keyId`), or null when no key did. */
  keyId: string | null;
  /** Pass as `after` to read what follows this change. */
  position: string;
}

/** Resources one webhook endpoint's filter may name. */
export const SLOTLOCK_WEBHOOK_FILTER_RESOURCES = 100;
/** Pools, locations or groups one webhook endpoint's filter may name, of each. */
export const SLOTLOCK_WEBHOOK_FILTER_REFS = 20;

/**
 * Which resources' changes an endpoint receives (RFC 0003 G5): only changes about a resource that
 * matches one of these, as it is when the change is delivered, so a change about no resource (a key,
 * a webhook, a usage notice) is not sent. A location includes every location in it. At most
 * SLOTLOCK_WEBHOOK_FILTER_RESOURCES ids, and SLOTLOCK_WEBHOOK_FILTER_REFS of each of the others.
 */
export interface SlotlockWebhookFilter {
  resourceIds?: string[];
  pools?: string[];
  locations?: string[];
  groups?: string[];
}

export interface SlotlockWebhookEndpoint {
  id: string;
  url: string;
  /** Null: every type. */
  eventTypes: SlotlockChangeType[] | null;
  /** Only changes about these resources; absent, changes about any resource or none. */
  filter?: SlotlockWebhookFilter;
  createdAt: Date;
  /** Failed attempts since the last delivery that succeeded. */
  attempts: number;
  failingSince: Date | null;
  lastStatus: number | null;
  lastError: string | null;
  disabledAt: Date | null;
  disabledReason: string | null;
}

export interface SlotlockWebhookClaim {
  /** `attempts`: deliveries that have failed in a row so far, which sets the next retry's delay. */
  endpoint: { id: string; url: string; secret: string; attempts: number };
  /** Settle the claim with it; another worker's claim on the same endpoint has another. */
  leaseToken: string;
  /** In order, at most `batch`. */
  changes: SlotlockChange[];
}

export type CreateWebhookEndpointResult =
  | { ok: true; endpoint: SlotlockWebhookEndpoint; secret: string }
  | { ok: false; code: 'invalid_webhook_url' | 'invalid_event_types' | 'invalid_webhook_filter' }
  | { ok: false; code: 'webhook_limit_reached'; limit: number };

export type ListChangesResult =
  | { ok: true; changes: SlotlockChange[]; next: string }
  | { ok: false; code: 'invalid_cursor' | 'cursor_expired' };

export interface SlotlockEventFeed {
  /**
   * The tenant's changes after `after` (or from the oldest kept), oldest first, up to `limit`
   * (1-500, default 100). Only ended transactions are read, so a reader following `next` never
   * skips a late commit. `next` is the last position, or `after` when there is none: poll with it.
   * A position before a pruned change is `cursor_expired`.
   */
  listChanges(params: {
    tenantRef: string;
    after?: string;
    limit?: number;
  }): Promise<ListChangesResult>;
  /**
   * The tenant's latest changes, newest first, up to `limit` (1-100, default 20): what happened
   * lately, for people to read. To follow the feed, read listChanges.
   */
  listRecentChanges(params: { tenantRef: string; limit?: number }): Promise<SlotlockChange[]>;
  /**
   * Add a webhook endpoint for the tenant's changes from now on. `url` is https (http only for
   * `localhost`), with no credentials or fragment, at most 2,048 bytes. The secret (`whsec_…`,
   * 32 random bytes) is returned here only. At most SLOTLOCK_MAX_WEBHOOK_ENDPOINTS per tenant.
   */
  createWebhookEndpoint(params: {
    tenantRef: string;
    url: string;
    eventTypes?: readonly string[];
    /** Only changes about these resources (`invalid_webhook_filter` past its bounds). */
    filter?: SlotlockWebhookFilter;
  }): Promise<CreateWebhookEndpointResult>;
  listWebhookEndpoints(params: { tenantRef: string }): Promise<SlotlockWebhookEndpoint[]>;
  deleteWebhookEndpoint(params: { tenantRef: string; id: string }): Promise<{ deleted: boolean }>;
  /**
   * Deliver to a disabled endpoint again, from where it stopped; null when there is none. When
   * the changes it missed are older than the feed keeps, `changes_pruned`: it would skip them
   * unseen, so delete it, add it again, and read what it missed from listChanges.
   */
  enableWebhookEndpoint(params: {
    tenantRef: string;
    id: string;
  }): Promise<SlotlockWebhookEndpoint | null | { code: 'changes_pruned' }>;
  /**
   * Lease the tenant's endpoints with changes due, each with its next `batch` (1-100) changes, for
   * `leaseMs` (1,000-300,000). An expired lease is claimed again by any worker, so a crash costs a
   * redelivery, never a lost change.
   */
  claimWebhookDeliveries(params: {
    tenantRef: string;
    leaseMs: number;
    batch: number;
  }): Promise<SlotlockWebhookClaim[]>;
  /**
   * Record how a claim went: `delivered`, the position of the last change the endpoint accepted;
   * `failure` for the one it did not, retried after `retryInMs`. An endpoint failing for
   * SLOTLOCK_WEBHOOK_FAILING_LIMIT_MS, or answering 410 (`gone`), is disabled, and the feed records
   * `webhook.disabled`. Nothing changes once the lease has passed to another worker.
   */
  settleWebhookDelivery(params: {
    tenantRef: string;
    endpointId: string;
    leaseToken: string;
    delivered?: string;
    failure?: { status: number | null; error: string; retryInMs: number; gone?: boolean };
  }): Promise<void>;
  /**
   * History of one resource (`resourceId`: its bookings, events and configuration) or one record
   * (`subject`), newest first, `limit` (1-100) at a time, each with `actor`, `keyId`, `origin` and
   * the prior state where there was one. Pass the last `id` as `before` for the next page. Kept as
   * long as the feed.
   */
  listHistory(params: {
    tenantRef: string;
    resourceId?: string;
    subject?: string;
    limit?: number;
    before?: string;
  }): Promise<SlotlockChange[]>;
  /** Delete up to `limit` of the tenant's changes older than the retention; how many went. */
  pruneChanges(params: { tenantRef: string; limit: number }): Promise<number>;
}

interface Position {
  txid: string;
  id: string;
  at: number;
  /** Given by 0.4, before the pruned position was kept: it also expires by its date. */
  dated?: boolean;
}

function encodePosition(position: Position): string {
  return Buffer.from(`2:${position.txid}:${position.id}:${position.at}`).toString('base64url');
}

function decodePosition(value: string): Position | null {
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const match = /^([12]):(\d{1,20}):(\d{1,19}):(\d{1,15})$/.exec(Buffer.from(value, 'base64url').toString());
  if (!match) return null;
  const position: Position = { txid: match[2] as string, id: match[3] as string, at: Number(match[4]) };
  if (match[1] === '1') position.dated = true;
  return position;
}

interface ChangeRow {
  id: string;
  txid: string;
  type: SlotlockChangeType;
  resource_id: string | null;
  subject: string;
  data: Record<string, unknown>;
  occurred_at: Date;
  actor: string | null;
  origin: string | null;
  key_id: string | null;
}

function toChange(row: ChangeRow): SlotlockChange {
  return {
    id: `msg_${row.id}`,
    type: row.type,
    resourceId: row.resource_id,
    ...slotlockServedChange(row.type, row.subject, row.data),
    occurredAt: row.occurred_at,
    actor: row.actor,
    // An origin a later release added: unrecorded here, not a failed page.
    origin: isSlotlockChangeOrigin(row.origin) ? row.origin : null,
    keyId: row.key_id,
    position: encodePosition({ txid: row.txid, id: row.id, at: row.occurred_at.getTime() }),
  };
}

interface EndpointRow {
  id: string;
  url: string;
  event_types: SlotlockChangeType[] | null;
  filter_resource_ids: string[] | null;
  filter_pools: string[] | null;
  filter_locations: string[] | null;
  filter_groups: string[] | null;
  created_at: Date;
  attempts: number;
  failing_since: Date | null;
  last_status: number | null;
  last_error: string | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
}

function toEndpoint(row: EndpointRow): SlotlockWebhookEndpoint {
  const endpoint: SlotlockWebhookEndpoint = {
    id: row.id,
    url: row.url,
    eventTypes: row.event_types,
    createdAt: row.created_at,
    attempts: row.attempts,
    failingSince: row.failing_since,
    lastStatus: row.last_status,
    lastError: row.last_error,
    disabledAt: row.disabled_at,
    disabledReason: row.disabled_reason,
  };
  const filter: SlotlockWebhookFilter = {};
  if (row.filter_resource_ids) filter.resourceIds = row.filter_resource_ids;
  if (row.filter_pools) filter.pools = row.filter_pools;
  if (row.filter_locations) filter.locations = row.filter_locations;
  if (row.filter_groups) filter.groups = row.filter_groups;
  if (Object.keys(filter).length > 0) endpoint.filter = filter;
  return endpoint;
}

const ENDPOINT_COLUMNS = (sql: SlotlockSql) =>
  sql`id, url, event_types, created_at, attempts, failing_since, last_status, last_error,
      disabled_at, disabled_reason, filter_resource_ids::text[], filter_pools, filter_locations,
      filter_groups`;

/** A pool's, location's or group's reference. */
const GROUPING_REF = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/**
 * A webhook filter as it is stored, each list without repeats, or null when one is out of bounds.
 * An empty filter, or empty lists, filter nothing.
 */
function parseWebhookFilter(filter: SlotlockWebhookFilter | undefined): {
  resourceIds: string[] | null;
  pools: string[] | null;
  locations: string[] | null;
  groups: string[] | null;
} | null {
  const list = (values: unknown, max: number, valid: (value: string) => boolean): string[] | null | false => {
    if (values === undefined) return null;
    if (!Array.isArray(values)) return false;
    const kept = [...new Set(values)];
    if (kept.length === 0) return null;
    if (kept.length > max || !kept.every((value) => typeof value === 'string' && valid(value))) return false;
    return (kept as string[]).sort();
  };
  const resourceIds = list(filter?.resourceIds, SLOTLOCK_WEBHOOK_FILTER_RESOURCES, (value) => UUID.test(value));
  const pools = list(filter?.pools, SLOTLOCK_WEBHOOK_FILTER_REFS, (value) => GROUPING_REF.test(value));
  const locations = list(filter?.locations, SLOTLOCK_WEBHOOK_FILTER_REFS, (value) => GROUPING_REF.test(value));
  const groups = list(filter?.groups, SLOTLOCK_WEBHOOK_FILTER_REFS, (value) => GROUPING_REF.test(value));
  if (resourceIds === false || pools === false || locations === false || groups === false) return null;
  return {
    resourceIds: resourceIds?.map((id) => id.toLowerCase()) ?? null,
    pools,
    locations,
    groups,
  };
}

/**
 * Whether a change (`change`, a row of slotlock.outbox) passes an endpoint's filter (`due`, a row of
 * slotlock.webhook_endpoints): no filter, or a resource it names, or one in a pool, at a location
 * (or a location in it) or in a group it names, as the resource is now; or a change to a resource
 * that says it was in one (resource.created, resource.deleted, or resource.updated's `before`),
 * so an endpoint also learns of a resource deleted, or moved out of what it follows.
 */
const FILTER_MATCH = `(
  (due.filter_resource_ids IS NULL AND due.filter_pools IS NULL
   AND due.filter_locations IS NULL AND due.filter_groups IS NULL)
  OR change.resource_id = ANY (due.filter_resource_ids)
  OR EXISTS (
    SELECT 1 FROM slotlock.resources held
     WHERE held.tenant_ref = change.tenant_ref AND held.id = change.resource_id
       AND (held.pool_ref = ANY (due.filter_pools)
            OR (held.location_ref IS NOT NULL
                AND slotlock.location_path(held.tenant_ref, held.location_ref) && due.filter_locations)
            OR EXISTS (SELECT 1 FROM slotlock.resource_group_members member
                        WHERE member.tenant_ref = held.tenant_ref AND member.resource_id = held.id
                          AND member.group_ref = ANY (due.filter_groups))))
  OR (change.type LIKE 'resource.%' AND (
       (change.data ->> 'pool') = ANY (due.filter_pools)
    OR (change.data #>> '{before,pool}') = ANY (due.filter_pools)
    OR EXISTS (
         SELECT 1 FROM unnest(ARRAY[change.data ->> 'location', change.data #>> '{before,location}']) was(ref)
          WHERE was.ref IS NOT NULL
            AND (was.ref = ANY (due.filter_locations)
                 OR slotlock.location_path(change.tenant_ref, was.ref) && due.filter_locations))
    OR (jsonb_typeof(change.data -> 'groups') = 'array' AND (change.data -> 'groups') ?| due.filter_groups)
    OR (jsonb_typeof(change.data #> '{before,groups}') = 'array'
        AND (change.data #> '{before,groups}') ?| due.filter_groups))))`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= 500;
}

function identityError(): Error & { code: 'invalid_identity' } {
  return Object.assign(new Error('Slotlock tenant reference must be 1-500 UTF-8 bytes'), {
    code: 'invalid_identity' as const,
  });
}

/** A webhook URL Slotlock will call: https, or http to localhost; no credentials or fragment. */
export function isWebhookUrl(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/**
 * The feed's methods on `sql`: the store's own client, or its tenant transaction. Changes are kept
 * `retentionDays` (default SLOTLOCK_CHANGE_RETENTION_DAYS), and a cursor reaches back as far.
 */
export function slotlockEventFeedMethods(
  sql: SlotlockSql,
  retentionDays: number = SLOTLOCK_CHANGE_RETENTION_DAYS,
): SlotlockEventFeed {
  return {
    async listChanges(params) {
      if (!isIdentity(params.tenantRef)) throw identityError();
      const limit = params.limit ?? 100;
      if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500)) {
        throw Object.assign(new RangeError('Slotlock change page limit must be 1-500'), {
          code: 'invalid_limit' as const,
        });
      }
      const after = params.after === undefined ? null : decodePosition(params.after);
      if (params.after !== undefined && !after) return { ok: false, code: 'invalid_cursor' };
      // One statement, so the pruned position and the page share a snapshot.
      const rows = await sql<
        (Omit<ChangeRow, 'id'> & {
          id: string | null;
          pruned_txid: string | null;
          pruned_id: string | null;
          horizon: string;
        })[]
      >`
        SELECT mark.txid::text AS pruned_txid, mark.id::text AS pruned_id,
               pg_snapshot_xmin(pg_current_snapshot())::text AS horizon,
               page.id::text, page.txid::text, page.type, page.resource_id, page.subject,
               page.data, page.occurred_at, page.actor, page.origin, page.key_id::text
          FROM (SELECT 1) here
          LEFT JOIN slotlock.outbox_pruned mark ON mark.tenant_ref = ${params.tenantRef}
          LEFT JOIN LATERAL (
            SELECT * FROM slotlock.outbox
             WHERE tenant_ref = ${params.tenantRef}
               AND txid < pg_snapshot_xmin(pg_current_snapshot())
               AND (${after?.txid ?? null}::xid8 IS NULL
                    OR (txid, id) > (${after?.txid ?? null}::xid8, ${after?.id ?? null}::bigint))
               -- Starting over: from the mark on. A change kept before it (one another server
               -- left when it pruned past it) would end a page that is expired at once.
               AND (mark.txid IS NULL OR (txid, id) > (mark.txid, mark.id))
             ORDER BY txid, id
             LIMIT ${limit}
          ) page ON true
         ORDER BY page.txid, page.id`;
      const head = rows[0];
      if (!head) throw new Error('slotlock: change page returned no row');
      // Pruned by any server: reading on could skip a change. A 0.4 cursor also expires by date,
      // since 0.4 pruned by age, not feed order.
      if (
        after &&
        ((head.pruned_txid !== null &&
          (BigInt(head.pruned_txid) > BigInt(after.txid) ||
            (BigInt(head.pruned_txid) === BigInt(after.txid) &&
              BigInt(head.pruned_id ?? 0) > BigInt(after.id)))) ||
          (after.dated === true &&
            after.at < Date.now() - SLOTLOCK_CHANGE_RETENTION_DAYS * 86_400_000))
      ) {
        return { ok: false, code: 'cursor_expired' };
      }
      const changes = rows.flatMap((row) => (row.id === null ? [] : [toChange(row as ChangeRow)]));
      const last = changes.at(-1);
      // Nothing new: the position stays, dated now. Before any change, every one to come is after
      // the oldest running transaction.
      const here = after ?? { txid: head.horizon, id: '0', at: 0 };
      return {
        ok: true,
        changes,
        next: last?.position ?? encodePosition({ txid: here.txid, id: here.id, at: Date.now() }),
      };
    },

    async listRecentChanges(params) {
      if (!isIdentity(params.tenantRef)) throw identityError();
      const limit = params.limit ?? 20;
      if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100)) {
        throw Object.assign(new RangeError('Slotlock recent change limit must be 1-100'), {
          code: 'invalid_limit' as const,
        });
      }
      const rows = await sql<ChangeRow[]>`
        SELECT id::text, txid::text, type, resource_id, subject, data, occurred_at, actor, origin,
               key_id::text
          FROM slotlock.outbox
         WHERE tenant_ref = ${params.tenantRef}
         ORDER BY txid DESC, id DESC
         LIMIT ${limit}`;
      return rows.map(toChange);
    },

    async createWebhookEndpoint(params) {
      if (!isIdentity(params.tenantRef)) throw identityError();
      if (!isWebhookUrl(params.url)) return { ok: false, code: 'invalid_webhook_url' };
      const types = params.eventTypes === undefined ? null : [...new Set(params.eventTypes)];
      if (
        types !== null &&
        (types.length === 0 ||
          !types.every((type) => (SLOTLOCK_CHANGE_TYPES as readonly string[]).includes(type)))
      ) {
        return { ok: false, code: 'invalid_event_types' };
      }
      const filter = parseWebhookFilter(params.filter);
      if (filter === null) return { ok: false, code: 'invalid_webhook_filter' };
      const secret = `whsec_${randomBytes(32).toString('base64')}`;
      return inTransaction(sql, async (tx): Promise<CreateWebhookEndpointResult> => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`slotlock:webhooks:${params.tenantRef}`}, 0))`;
        const [count] = await tx<{ count: number; planned: number | null }[]>`
          SELECT count(*)::int AS count,
                 (SELECT max_webhook_endpoints FROM slotlock.tenant_plan(${params.tenantRef}::text))
                   AS planned
            FROM slotlock.webhook_endpoints
           WHERE tenant_ref = ${params.tenantRef}`.catch((error: unknown) => {
          throw slotlockPlanReadRefusal(error);
        });
        // The lower of the server's limit and the tenant's plan (plans.ts), when it has one.
        const limit = Math.min(SLOTLOCK_MAX_WEBHOOK_ENDPOINTS, count?.planned ?? SLOTLOCK_MAX_WEBHOOK_ENDPOINTS);
        if ((count?.count ?? 0) >= limit) {
          return { ok: false, code: 'webhook_limit_reached', limit };
        }
        // From now on: every transaction not yet ended is at or after this position.
        const [row] = await tx<EndpointRow[]>`
          INSERT INTO slotlock.webhook_endpoints (
            tenant_ref, url, secret, event_types, cursor_txid,
            filter_resource_ids, filter_pools, filter_locations, filter_groups
          )
          VALUES (${params.tenantRef}, ${params.url}, ${secret}, ${types}::text[],
                  pg_snapshot_xmin(pg_current_snapshot()),
                  ${filter.resourceIds}::uuid[], ${filter.pools}::text[], ${filter.locations}::text[],
                  ${filter.groups}::text[])
          RETURNING ${ENDPOINT_COLUMNS(tx)}`;
        if (!row) throw new Error('slotlock: webhook endpoint insert returned no row');
        await tx`SELECT slotlock.register_webhook_tenant(${params.tenantRef}::text)`;
        return { ok: true, endpoint: toEndpoint(row), secret };
      });
    },

    async listWebhookEndpoints(params) {
      if (!isIdentity(params.tenantRef)) throw identityError();
      const rows = await sql<EndpointRow[]>`
        SELECT ${ENDPOINT_COLUMNS(sql)} FROM slotlock.webhook_endpoints
         WHERE tenant_ref = ${params.tenantRef}
         ORDER BY created_at, id`;
      return rows.map(toEndpoint);
    },

    async deleteWebhookEndpoint(params) {
      if (!isIdentity(params.tenantRef)) throw identityError();
      if (!UUID.test(params.id)) return { deleted: false };
      return inTransaction(sql, async (tx) => {
        const rows = await tx`
          DELETE FROM slotlock.webhook_endpoints
           WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
           RETURNING id`;
        const [left] = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM slotlock.webhook_endpoints
           WHERE tenant_ref = ${params.tenantRef}`;
        if ((left?.count ?? 0) === 0) {
          await tx`SELECT slotlock.unregister_webhook_tenant(${params.tenantRef}::text)`;
        }
        return { deleted: rows.length > 0 };
      });
    },

    async enableWebhookEndpoint(params) {
      if (!isIdentity(params.tenantRef)) throw identityError();
      if (!UUID.test(params.id)) return null;
      const [behind] = await sql<{ id: string }[]>`
        SELECT id FROM slotlock.webhook_endpoints
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id} AND changes_pruned`;
      if (behind) return { code: 'changes_pruned' };
      const [row] = await sql<EndpointRow[]>`
        UPDATE slotlock.webhook_endpoints
           SET disabled_at = NULL, disabled_reason = NULL, attempts = 0, failing_since = NULL,
               next_attempt_at = NULL, lease_until = NULL, lease_token = NULL
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
         RETURNING ${ENDPOINT_COLUMNS(sql)}`;
      return row ? toEndpoint(row) : null;
    },

    async claimWebhookDeliveries(params) {
      if (!isIdentity(params.tenantRef)) throw identityError();
      if (!(Number.isSafeInteger(params.leaseMs) && params.leaseMs >= 1_000 && params.leaseMs <= 300_000)) {
        throw new RangeError('Slotlock webhook lease must be 1,000-300,000 ms');
      }
      if (!(Number.isSafeInteger(params.batch) && params.batch >= 1 && params.batch <= 100)) {
        throw new RangeError('Slotlock webhook batch must be 1-100 changes');
      }
      // An endpoint that takes only some changes (by type or filter) moves past the ones it does
      // not take, up to the last change that has ended, when none before it is for the endpoint:
      // else its cursor would stay where it was made, keeping the whole feed from being pruned and
      // every claim reading it all again. Not one being delivered (leased), nor one waiting to try
      // again (it has a change for it).
      await sql`
        UPDATE slotlock.webhook_endpoints due
           SET cursor_txid = head.txid, cursor_id = head.id
          FROM (SELECT change.txid, change.id FROM slotlock.outbox change
                 WHERE change.tenant_ref = ${params.tenantRef}
                   AND change.txid < pg_snapshot_xmin(pg_current_snapshot())
                 ORDER BY change.txid DESC, change.id DESC
                 LIMIT 1) head
         WHERE due.tenant_ref = ${params.tenantRef}
           AND due.disabled_at IS NULL
           AND (due.lease_until IS NULL OR due.lease_until <= now())
           AND (due.event_types IS NOT NULL OR due.filter_resource_ids IS NOT NULL OR due.filter_pools IS NOT NULL
                OR due.filter_locations IS NOT NULL OR due.filter_groups IS NOT NULL)
           AND (head.txid, head.id) > (due.cursor_txid, due.cursor_id)
           AND NOT EXISTS (
             SELECT 1 FROM slotlock.outbox change
              WHERE change.tenant_ref = due.tenant_ref
                AND (change.txid, change.id) > (due.cursor_txid, due.cursor_id)
                AND (change.txid, change.id) <= (head.txid, head.id)
                AND (due.event_types IS NULL OR change.type = ANY (due.event_types))
                AND ${sql.unsafe(FILTER_MATCH)})`;
      const endpoints = await sql<
        { id: string; url: string; secret: string; attempts: number; lease_token: string; event_types: string[] | null; cursor_txid: string; cursor_id: string }[]
      >`
        UPDATE slotlock.webhook_endpoints endpoint
           SET lease_until = now() + make_interval(secs => ${params.leaseMs / 1_000}),
               lease_token = gen_random_uuid()
         WHERE endpoint.id IN (
           SELECT due.id FROM slotlock.webhook_endpoints due
            WHERE due.tenant_ref = ${params.tenantRef}
              AND due.disabled_at IS NULL
              AND (due.next_attempt_at IS NULL OR due.next_attempt_at <= now())
              AND (due.lease_until IS NULL OR due.lease_until <= now())
              AND EXISTS (
                SELECT 1 FROM slotlock.outbox change
                 WHERE change.tenant_ref = due.tenant_ref
                   AND change.txid < pg_snapshot_xmin(pg_current_snapshot())
                   AND (change.txid, change.id) > (due.cursor_txid, due.cursor_id)
                   AND (due.event_types IS NULL OR change.type = ANY (due.event_types))
                   AND ${sql.unsafe(FILTER_MATCH)}
              )
            FOR UPDATE SKIP LOCKED
         )
         RETURNING endpoint.id, endpoint.url, endpoint.secret, endpoint.attempts, endpoint.lease_token::text,
                   endpoint.event_types, endpoint.cursor_txid::text, endpoint.cursor_id::text`;
      const claims: SlotlockWebhookClaim[] = [];
      for (const endpoint of endpoints) {
        const rows = await sql<ChangeRow[]>`
          SELECT change.id::text, change.txid::text, change.type, change.resource_id, change.subject,
                 change.data, change.occurred_at, change.actor, change.origin, change.key_id::text
            FROM slotlock.outbox change, slotlock.webhook_endpoints due
           WHERE due.id = ${endpoint.id}::uuid
             AND change.tenant_ref = ${params.tenantRef}
             AND change.txid < pg_snapshot_xmin(pg_current_snapshot())
             AND (change.txid, change.id) > (${endpoint.cursor_txid}::xid8, ${endpoint.cursor_id}::bigint)
             AND (${endpoint.event_types}::text[] IS NULL OR change.type = ANY (${endpoint.event_types}::text[]))
             AND ${sql.unsafe(FILTER_MATCH)}
           ORDER BY change.txid, change.id
           LIMIT ${params.batch}`;
        claims.push({
          endpoint: { id: endpoint.id, url: endpoint.url, secret: endpoint.secret, attempts: endpoint.attempts },
          leaseToken: endpoint.lease_token,
          changes: rows.map(toChange),
        });
      }
      return claims;
    },

    async settleWebhookDelivery(params) {
      if (!isIdentity(params.tenantRef)) throw identityError();
      const delivered = params.delivered === undefined ? null : decodePosition(params.delivered);
      if (params.delivered !== undefined && !delivered) {
        throw new TypeError('Slotlock webhook delivery position is not one the feed gave');
      }
      const failure = params.failure;
      await inTransaction(sql, async (tx) => {
        const [settled] = await tx<{ disabled: boolean }[]>`
          UPDATE slotlock.webhook_endpoints
             SET cursor_txid = COALESCE(${delivered?.txid ?? null}::xid8, cursor_txid),
                 cursor_id = COALESCE(${delivered?.id ?? null}::bigint, cursor_id),
                 -- Progress before a failure starts the count again: an endpoint that keeps
                 -- advancing is not failing, however often one change needs a retry.
                 attempts = CASE WHEN ${failure ? 1 : 0}::int = 0 THEN 0
                                 WHEN ${delivered ? 1 : 0}::int = 1 THEN 1
                                 ELSE attempts + 1 END,
                 failing_since = CASE WHEN ${failure ? 1 : 0}::int = 0 THEN NULL
                                      WHEN ${delivered ? 1 : 0}::int = 1 THEN now()
                                      ELSE COALESCE(failing_since, now()) END,
                 next_attempt_at = CASE WHEN ${failure ? 1 : 0}::int = 1
                                        THEN now() + make_interval(secs => ${(failure?.retryInMs ?? 0) / 1_000})
                                   END,
                 last_status = COALESCE(${failure?.status ?? null}::int, last_status),
                 last_error = CASE WHEN ${failure ? 1 : 0}::int = 1
                                   THEN left(${failure?.error ?? ''}, 500) ELSE last_error END,
                 disabled_at = CASE
                   WHEN ${failure?.gone === true}::boolean
                     OR (${failure ? 1 : 0}::int = 1
                         AND now() - COALESCE(failing_since, now())
                             >= make_interval(secs => ${SLOTLOCK_WEBHOOK_FAILING_LIMIT_MS / 1_000}))
                   THEN now() END,
                 disabled_reason = CASE
                   WHEN ${failure?.gone === true}::boolean THEN 'gone'
                   WHEN ${failure ? 1 : 0}::int = 1
                        AND now() - COALESCE(failing_since, now())
                            >= make_interval(secs => ${SLOTLOCK_WEBHOOK_FAILING_LIMIT_MS / 1_000})
                   THEN 'failing' END,
                 lease_until = NULL,
                 lease_token = NULL
           WHERE tenant_ref = ${params.tenantRef} AND id = ${params.endpointId}
             AND lease_token = ${params.leaseToken}::uuid
           RETURNING disabled_at IS NOT NULL AS disabled`;
        if (settled?.disabled) {
          await tx`
            INSERT INTO slotlock.outbox (tenant_ref, type, subject, data)
            VALUES (${params.tenantRef}, 'webhook.disabled', ${params.endpointId},
                    ${tx.json({
                      // The id alone: the feed reaches other endpoints, and a URL can carry a
                      // token.
                      id: params.endpointId,
                      reason: failure?.gone === true ? 'gone' : 'failing',
                      last_status: failure?.status ?? null,
                    })})`;
        }
      });
    },

    async listHistory(params) {
      if (!isIdentity(params.tenantRef)) throw identityError();
      if ((params.resourceId === undefined) === (params.subject === undefined)) {
        throw new TypeError('Slotlock history is of one resource or one record: give resourceId or subject');
      }
      if (params.resourceId !== undefined && !UUID.test(params.resourceId)) return [];
      if (params.subject !== undefined && !isIdentity(params.subject)) return [];
      const limit = params.limit ?? 50;
      if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100)) {
        throw new RangeError('Slotlock history page limit must be 1-100');
      }
      const before = params.before === undefined ? null : /^msg_(\d{1,19})$/.exec(params.before)?.[1];
      if (before === undefined) return [];
      const rows = await sql<ChangeRow[]>`
        SELECT id::text, txid::text, type, resource_id, subject, data, occurred_at, actor, origin,
               key_id::text
          FROM slotlock.outbox
         WHERE tenant_ref = ${params.tenantRef}
           AND (${params.resourceId ?? null}::uuid IS NULL OR resource_id = ${params.resourceId ?? null}::uuid)
           AND (${params.subject ?? null}::text IS NULL OR (
                 subject = ${params.subject ?? null}
                 -- A coverage change matches only by the name it is served under: one not renamed
                 -- yet may still hold its source, and a guess must not find it.
                 AND (type NOT LIKE 'coverage.%' OR subject ~ '^src_([0-9a-f]{32}|redacted)$')))
           AND (${before}::bigint IS NULL OR id < ${before}::bigint)
         ORDER BY id DESC
         LIMIT ${limit}`;
      return rows.map(toChange);
    },

    async pruneChanges(params) {
      if (!isIdentity(params.tenantRef)) throw identityError();
      // Oldest first in feed order, and only up to the first change kept (within retention, still
      // owed to an enabled webhook, or later than the oldest running transaction), so every kept
      // change is after every pruned one and a reader starting over reads past the gap.
      const rows = await sql<{ deleted: number }[]>`
        WITH head AS MATERIALIZED (
          SELECT outbox.id, outbox.txid,
                 outbox.occurred_at >= now() - make_interval(days => ${retentionDays})
                 OR EXISTS (
                   SELECT 1 FROM slotlock.webhook_endpoints endpoint
                    WHERE endpoint.tenant_ref = outbox.tenant_ref AND endpoint.disabled_at IS NULL
                      AND (outbox.txid, outbox.id) > (endpoint.cursor_txid, endpoint.cursor_id)
                 ) AS kept
            FROM slotlock.outbox
           WHERE outbox.tenant_ref = ${params.tenantRef}
             AND outbox.txid < pg_snapshot_xmin(pg_current_snapshot())
           ORDER BY outbox.txid, outbox.id
           LIMIT ${params.limit}
        ), doomed AS MATERIALIZED (
          SELECT change.id, change.txid FROM head change
           WHERE NOT EXISTS (
             SELECT 1 FROM head keeper
              WHERE keeper.kept AND (keeper.txid, keeper.id) <= (change.txid, change.id))
        ), missed AS (
          -- A disabled endpoint that had not received one of them has lost it.
          UPDATE slotlock.webhook_endpoints endpoint SET changes_pruned = true
           WHERE endpoint.tenant_ref = ${params.tenantRef} AND endpoint.disabled_at IS NOT NULL
             AND NOT endpoint.changes_pruned
             AND EXISTS (
               SELECT 1 FROM doomed
                WHERE (doomed.txid, doomed.id) > (endpoint.cursor_txid, endpoint.cursor_id))
        ), deleted AS (
          DELETE FROM slotlock.outbox change USING doomed WHERE change.id = doomed.id RETURNING 1
        )
        SELECT count(*)::int AS deleted FROM deleted`;
      return rows[0]?.deleted ?? 0;
    },
  };
}

/**
 * A position at or before every change that has not ended yet, so a reader that starts from it and
 * follows `next` misses none still to come (it may read again some that ended just before). Live
 * updates start here (agent-store-backend.ts, createSlotlockStoreChangeSource).
 */
export async function slotlockChangeFeedHead(sql: SlotlockSql): Promise<string> {
  const [row] = await sql<{ horizon: string }[]>`
    SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon`;
  if (!row) throw new Error('slotlock: change feed head returned no row');
  return encodePosition({ txid: row.horizon, id: '0', at: Date.now() });
}
