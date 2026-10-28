// The event feed (RFC 0002 P1-5): what changed for a tenant, read by position, and the webhook
// endpoints it is delivered to. Rows are appended by triggers in the same transaction as the change
// (ddl.ts, SLOTLOCK_OUTBOX_DDL). These are the store's methods for reading them and for keeping each
// endpoint's delivery state; webhooks.ts signs and sends.
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
] as const);

export type SlotlockChangeType = (typeof SLOTLOCK_CHANGE_TYPES)[number];

/** How long the feed keeps a change, and so how far back a cursor may reach. */
export const SLOTLOCK_CHANGE_RETENTION_DAYS = 30;
/** Webhook endpoints one tenant may have. */
export const SLOTLOCK_MAX_WEBHOOK_ENDPOINTS = 10;
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
  /** Pass as `after` to read what follows this change. */
  position: string;
}

export interface SlotlockWebhookEndpoint {
  id: string;
  url: string;
  /** Null: every type. */
  eventTypes: SlotlockChangeType[] | null;
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
  | { ok: false; code: 'invalid_webhook_url' | 'invalid_event_types' }
  | { ok: false; code: 'webhook_limit_reached'; limit: number };

export type ListChangesResult =
  | { ok: true; changes: SlotlockChange[]; next: string }
  | { ok: false; code: 'invalid_cursor' | 'cursor_expired' };

export interface SlotlockEventFeed {
  /**
   * The tenant's changes after `after` (a `position`, or the oldest kept without it), oldest
   * first, up to `limit` (1-500, default 100). Only changes of transactions that have ended are
   * read, so a reader that follows `next` never skips one that commits late. `next` is the last
   * change's position, or `after` when there is none yet: poll with it. A position older than
   * SLOTLOCK_CHANGE_RETENTION_DAYS is `cursor_expired`: read from the start again.
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
   * Lease the tenant's endpoints that have changes due, each with its next `batch` (1-100)
   * changes, for `leaseMs` (1,000-300,000). A lease that runs out is claimed again by any worker,
   * so a worker that dies mid-batch costs a redelivery, never a lost change.
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
   * History: the changes to one resource (`resourceId`) or one record (`subject`: a booking's
   * reference, an event's or hold's id), newest first, `limit` (1-100) at a time, each with who
   * made it and, for a change of an existing record, what it was before. Pass the last one's
   * `id` as `before` for the page after. Kept as long as the feed keeps changes.
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
}

function encodePosition(position: Position): string {
  return Buffer.from(`1:${position.txid}:${position.id}:${position.at}`).toString('base64url');
}

function decodePosition(value: string): Position | null {
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const match = /^1:(\d{1,20}):(\d{1,19}):(\d{1,15})$/.exec(Buffer.from(value, 'base64url').toString());
  return match ? { txid: match[1] as string, id: match[2] as string, at: Number(match[3]) } : null;
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
}

function toChange(row: ChangeRow): SlotlockChange {
  return {
    id: `msg_${row.id}`,
    type: row.type,
    resourceId: row.resource_id,
    subject: row.subject,
    data: row.data,
    occurredAt: row.occurred_at,
    actor: row.actor,
    position: encodePosition({ txid: row.txid, id: row.id, at: row.occurred_at.getTime() }),
  };
}

interface EndpointRow {
  id: string;
  url: string;
  event_types: SlotlockChangeType[] | null;
  created_at: Date;
  attempts: number;
  failing_since: Date | null;
  last_status: number | null;
  last_error: string | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
}

function toEndpoint(row: EndpointRow): SlotlockWebhookEndpoint {
  return {
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
}

const ENDPOINT_COLUMNS = (sql: SlotlockSql) =>
  sql`id, url, event_types, created_at, attempts, failing_since, last_status, last_error,
      disabled_at, disabled_reason`;

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
      if (after && after.at < Date.now() - retentionDays * 86_400_000) {
        return { ok: false, code: 'cursor_expired' };
      }
      const rows = await sql<ChangeRow[]>`
        SELECT id::text, txid::text, type, resource_id, subject, data, occurred_at, actor
          FROM slotlock.outbox
         WHERE tenant_ref = ${params.tenantRef}
           AND txid < pg_snapshot_xmin(pg_current_snapshot())
           AND (${after?.txid ?? null}::xid8 IS NULL
                OR (txid, id) > (${after?.txid ?? null}::xid8, ${after?.id ?? null}::bigint))
         ORDER BY txid, id
         LIMIT ${limit}`;
      const changes = rows.map(toChange);
      const last = changes.at(-1);
      // With nothing new the position stays, dated now: a reader that is up to date stays current.
      const here = after ?? { txid: '0', id: '0', at: 0 };
      return {
        ok: true,
        changes,
        next: last?.position ?? encodePosition({ ...here, at: Date.now() }),
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
        SELECT id::text, txid::text, type, resource_id, subject, data, occurred_at, actor
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
          types.length > 20 ||
          !types.every((type) => (SLOTLOCK_CHANGE_TYPES as readonly string[]).includes(type)))
      ) {
        return { ok: false, code: 'invalid_event_types' };
      }
      const secret = `whsec_${randomBytes(32).toString('base64')}`;
      return inTransaction(sql, async (tx): Promise<CreateWebhookEndpointResult> => {
        // One at a time per tenant, so racing creates stop at the limit.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`slotlock:webhooks:${params.tenantRef}`}, 0))`;
        const [count] = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM slotlock.webhook_endpoints
           WHERE tenant_ref = ${params.tenantRef}`;
        if ((count?.count ?? 0) >= SLOTLOCK_MAX_WEBHOOK_ENDPOINTS) {
          return { ok: false, code: 'webhook_limit_reached', limit: SLOTLOCK_MAX_WEBHOOK_ENDPOINTS };
        }
        // From now on: every transaction that has not ended yet is at or after this position.
        const [row] = await tx<EndpointRow[]>`
          INSERT INTO slotlock.webhook_endpoints (tenant_ref, url, secret, event_types, cursor_txid)
          VALUES (${params.tenantRef}, ${params.url}, ${secret}, ${types}::text[],
                  pg_snapshot_xmin(pg_current_snapshot()))
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
        // The tenant's last endpoint takes it off the list servers deliver for.
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
              )
            FOR UPDATE SKIP LOCKED
         )
         RETURNING endpoint.id, endpoint.url, endpoint.secret, endpoint.attempts, endpoint.lease_token::text,
                   endpoint.event_types, endpoint.cursor_txid::text, endpoint.cursor_id::text`;
      const claims: SlotlockWebhookClaim[] = [];
      for (const endpoint of endpoints) {
        const rows = await sql<ChangeRow[]>`
          SELECT id::text, txid::text, type, resource_id, subject, data, occurred_at, actor
            FROM slotlock.outbox
           WHERE tenant_ref = ${params.tenantRef}
             AND txid < pg_snapshot_xmin(pg_current_snapshot())
             AND (txid, id) > (${endpoint.cursor_txid}::xid8, ${endpoint.cursor_id}::bigint)
             AND (${endpoint.event_types}::text[] IS NULL OR type = ANY (${endpoint.event_types}::text[]))
           ORDER BY txid, id
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
          // The tenant hears of it on the feed, which every reader and other endpoint sees.
          await tx`
            INSERT INTO slotlock.outbox (tenant_ref, type, subject, data)
            VALUES (${params.tenantRef}, 'webhook.disabled', ${params.endpointId},
                    ${tx.json({
                      // The id alone: the feed goes to the tenant's other endpoints, and a URL can
                      // carry a token.
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
        SELECT id::text, txid::text, type, resource_id, subject, data, occurred_at, actor
          FROM slotlock.outbox
         WHERE tenant_ref = ${params.tenantRef}
           AND (${params.resourceId ?? null}::uuid IS NULL OR resource_id = ${params.resourceId ?? null}::uuid)
           AND (${params.subject ?? null}::text IS NULL OR subject = ${params.subject ?? null})
           AND (${before}::bigint IS NULL OR id < ${before}::bigint)
         ORDER BY id DESC
         LIMIT ${limit}`;
      return rows.map(toChange);
    },

    async pruneChanges(params) {
      if (!isIdentity(params.tenantRef)) throw identityError();
      const rows = await sql<{ deleted: number }[]>`
        WITH doomed AS MATERIALIZED (
          SELECT id FROM slotlock.outbox
           WHERE tenant_ref = ${params.tenantRef}
             AND occurred_at < now() - make_interval(days => ${retentionDays})
             -- Nothing an enabled webhook has still to receive, however old.
             AND NOT EXISTS (
               SELECT 1 FROM slotlock.webhook_endpoints endpoint
                WHERE endpoint.tenant_ref = outbox.tenant_ref AND endpoint.disabled_at IS NULL
                  AND (outbox.txid, outbox.id) > (endpoint.cursor_txid, endpoint.cursor_id)
             )
           ORDER BY occurred_at
           LIMIT ${params.limit}
        ), missed AS (
          -- A disabled endpoint that had not received one of them has lost it.
          UPDATE slotlock.webhook_endpoints endpoint SET changes_pruned = true
           WHERE endpoint.tenant_ref = ${params.tenantRef} AND endpoint.disabled_at IS NOT NULL
             AND NOT endpoint.changes_pruned
             AND EXISTS (
               SELECT 1 FROM doomed JOIN slotlock.outbox change ON change.id = doomed.id
                WHERE (change.txid, change.id) > (endpoint.cursor_txid, endpoint.cursor_id))
        ), deleted AS (
          DELETE FROM slotlock.outbox change USING doomed WHERE change.id = doomed.id RETURNING 1
        )
        SELECT count(*)::int AS deleted FROM deleted`;
      return rows[0]?.deleted ?? 0;
    },
  };
}
