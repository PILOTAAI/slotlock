// DB mechanics for the Slotlock core: explicit `postgres` client in, structured results out.
import {
  type SlotlockResourceAttributes,
  type SlotlockResourceKind,
  type SlotlockResourceProfileChange,
  type SlotlockResourceProfileInput,
  SLOTLOCK_MAX_LOCATION_DEPTH,
  SLOTLOCK_MAX_LOCATIONS,
  SLOTLOCK_MAX_RESOURCE_GROUPS,
  SLOTLOCK_POOL_ORDERS,
  SLOTLOCK_RESOURCE_KINDS,
  type SlotlockLocation,
  type SlotlockPoolOrder,
  type SlotlockResourceGroup,
  type SlotlockResourceScope,
  isSlotlockResourceScope,
  parseSlotlockLocation,
  parseSlotlockResourceGroup,
  parseSlotlockResourceProfile,
  slotlockGroupingRef,
} from './resource-profile.js';
import { type SlotlockUsageRow, readSlotlockTenantUsage } from './usage.js';
import { slotlockPlanReadRefusal } from './plans.js';
import {
  SLOTLOCK_CHANGE_ORIGINS,
  SLOTLOCK_CHANGE_RETENTION_DAYS,
  type SlotlockChangeOrigin,
  type SlotlockEventFeed,
  isSlotlockChangeOrigin,
  slotlockEventFeedMethods,
} from './event-feed.js';
import {
  type SlotlockBookingRule,
  type SlotlockBookingRules,
  bookingBufferBeforeMs,
  bookingSearchBlocked,
  bookingSearchReach,
  parseBookingRuleDefaults,
  parseEffectiveBookingRules,
  bookingBufferAfterMs,
  bookingRuleBroken,
  bookingSearch,
  parseBookingRules,
} from './booking-rules.js';
import { createHash, randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import type { Sql, TransactionSql } from 'postgres';
import {
  SLOTLOCK_ASSISTANT_CHAT_ID,
  SLOTLOCK_ASSISTANT_MAX_CHATS,
  SLOTLOCK_CORE_DDL,
  SLOTLOCK_COVERAGE_CHANGE_RENAME_BATCH,
  SLOTLOCK_DEPLOYMENT_CHECKS,
  SLOTLOCK_SCHEMA_CONTROL_REFUSAL,
  SLOTLOCK_SCHEMA_NEWER_REFUSAL,
  SLOTLOCK_SCHEMA_VERSION,
  SLOTLOCK_STRUCTURE_DDL,
  SLOTLOCK_TENANT_CONTEXT_SETTING,
  SLOTLOCK_RESOURCE_SCOPED_TABLES,
  SLOTLOCK_RESOURCE_SCOPE_SETTING,
  SLOTLOCK_TENANT_TABLES,
  SLOTLOCK_VALIDATION_DDL,
  createSlotlockApplicationRoleGrantsDdl,
  createSlotlockTenantRlsDdl,
  slotlockCoverageChangeRenameSql,
  slotlockTenantLockKey,
} from './ddl.js';
import { findNextAvailable, mergeIntervals } from './engine.js';
import {
  SLOTLOCK_CALENDAR_HORIZON_DAYS,
  assertBoundedSearchWindow,
  expandRules,
  invalidWindowError,
} from './rules.js';
import {
  CalendarContractError,
  CalendarExpansionLimitError,
  type CalendarSeriesCursor,
  type CalendarSeriesExpansion,
  expandCalendarEventSeries,
  normalizeCalendarEventContent,
} from './sync.js';
import type {
  AcquireHoldResult,
  CalendarAttendee,
  CalendarCoverageCommand,
  CalendarCoverageResult,
  CalendarEventContent,
  CalendarEventOccurrence,
  CalendarEventRetentionResult,
  BookingRetentionResult,
  SlotlockTenantErasure,
  SlotlockBookingRuleDefaults,
  CalendarFreeBusy,
  CalendarHorizonRollCursor,
  CalendarHorizonRollResult,
  CalendarOrganizer,
  CalendarRecurrenceException,
  CalendarReminder,
  CancelCalendarEventResult,
  CancelExternalReservationResult,
  ConfirmHoldResult,
  CreateReservationResult,
  DeleteResourceResult,
  ExternalReservationCommand,
  ExternalReservationResult,
  Interval,
  SlotlockCalendarEvent,
  SlotlockAgendaEntry,
  SlotlockHold,
  SlotlockBookingDescription,
  SlotlockApproval,
  SlotlockApprovalPolicy,
  SlotlockReservation,
  SlotlockResource,
  PutCalendarEventCommand,
  PutCalendarEventResult,
  ReleaseHoldResult,
  WeeklyAvailabilityRule,
} from './types.js';
import { parseAvailabilityRules } from './weekly-hours.js';
import {
  type PutApprovalPolicyParams,
  APPROVAL_COLUMNS,
  approvalByRequestKey,
  approvalPoliciesFor,
  beginApprovalGrant,
  declineApproval,
  deleteApprovalPolicy,
  expireApprovals,
  finishApprovalGrant,
  getApproval,
  listApprovalPolicies,
  listApprovals,
  putApprovalPolicy,
  recordApprovalChange,
  toApproval,
} from './approvals.js';

const EXCLUSION_VIOLATION = '23P01';
/** Holds one approval may own: a bundle's resources, or a move's new time in pieces. */
const SLOTLOCK_MAX_APPROVAL_HOLDS = 20;
/** Approvals one requester, and one tenant, may have waiting at once. */
const SLOTLOCK_MAX_PENDING_APPROVALS_PER_REQUESTER = 50;
const SLOTLOCK_MAX_PENDING_APPROVALS = 500;
/**
 * Concurrent inserts on the same EXCLUDE range can deadlock inside the constraint check itself
 * (intrinsic to Postgres EXCLUDE). The victim is fully rolled back, so one retry either wins or
 * loses with a structured 23P01.
 */
const DEADLOCK_DETECTED = '40P01';
const SERIALIZATION_FAILURE = '40001';
/** Holds are negotiation-scoped; a week is already generous. */
const MAX_HOLD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Guards against a caller unit error occupying a resource indefinitely. */
const MAX_BUFFER_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** A day, as bufferBeforeMinutes allows: a read by start can then still use the index. */
const MAX_BUFFER_BEFORE_MS = 24 * 60 * 60 * 1000;
export { SLOTLOCK_CALENDAR_HORIZON_DAYS };
/**
 * Longest one-off event (ten years and some leap days); a recurring series is bounded by its
 * materialization window instead.
 */
export const SLOTLOCK_MAX_EVENT_DURATION_DAYS = 3_660;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CALENDAR_WINDOW_MS = SLOTLOCK_CALENDAR_HORIZON_DAYS * DAY_MS;
/**
 * The 367-day search window plus two days: the rolling horizon starts a day before the current UTC
 * day and must reach 367 days past its end.
 */
export const SLOTLOCK_MATERIALIZATION_WINDOW_DAYS = SLOTLOCK_CALENDAR_HORIZON_DAYS + 2;
const MAX_MATERIALIZATION_WINDOW_MS = SLOTLOCK_MATERIALIZATION_WINDOW_DAYS * DAY_MS;
const MAX_EVENT_DURATION_MS = SLOTLOCK_MAX_EVENT_DURATION_DAYS * DAY_MS;
const MAX_RESOURCE_LIST_LIMIT = 1_000;
const MAX_TENANT_RESOURCE_LIMIT = 100_000;
const MAX_CALENDAR_LIST_LIMIT = 1_000;
const MAX_FREE_BUSY_INTERVALS = 10_000;
const MAX_COVERAGE_SOURCES = 64;
const MAX_COVERAGE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Trusted provider/maintenance namespace used by backwards-compatible store callers. */
export const SLOTLOCK_INTERNAL_EVENT_OWNER_REF = 'internal';

/** How many live holds one holder (a keyed hold's principal) may have in a tenant at once. */
export const SLOTLOCK_MAX_HOLDS_PER_HOLDER = 20;
/** Windows one holder may wait for at once (joinWaitlist). */
export const SLOTLOCK_MAX_WAITLIST_PER_HOLDER = 20;
/** Waiting entries one tenant may have. */
export const SLOTLOCK_MAX_WAITLIST_PER_TENANT = 10_000;
/** The longest window one waitlist entry may wait for. */
const MAX_WAITLIST_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const DEFAULT_OFFER_TTL_MS = 15 * 60 * 1000;
/** How long before its start a booking may be checked in. */
export const SLOTLOCK_CHECK_IN_OPENS_MINUTES = 60;
/** Free-looking resources one entry tries before the next: a race can take one first. */
const OFFER_CANDIDATES = 3;
/** Default hard ceiling for retained active + tombstoned identities per agent principal. */
export const SLOTLOCK_AGENT_OWNER_EVENT_QUOTA = 1_000;
/** Hard retained command ceiling; includes reserved cancellation capacity for every identity. */
export const SLOTLOCK_AGENT_OWNER_COMMAND_QUOTA = 10_000;
/**
 * Default exact-replay window for event commands. `pruneCalendarEventRetention` never deletes a
 * command or an agent tombstone younger than its window, so a retried command replays inside it.
 */
export const SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS = 30;
const MAX_EVENT_COMMAND_RETENTION_DAYS = 3_650;
const MAX_CONFIGURED_AGENT_OWNER_EVENT_QUOTA = 100_000;
const MAX_CONFIGURED_AGENT_OWNER_COMMAND_QUOTA = 1_000_000;
const SCHEMA_APPLY_LOCK = 'slotlock:schema-apply:v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AGENT_EVENT_OWNER_PATTERN = /^agent:[0-9a-f]{64}$/;

/** Store-owned coverage source for bounded, locally materialized recurring events. */
export const SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE = 'slotlock:local-recurrence-materialization';

/**
 * From a day before the current UTC day to SLOTLOCK_MATERIALIZATION_WINDOW_DAYS past its end;
 * shared by the writer, maintenance and readiness.
 */
export function calendarEventRollingHorizon(now = new Date()): Interval {
  if (!Number.isFinite(now.getTime())) throw invalidWindowError();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(midnight - DAY_MS);
  return { start, end: new Date(start.getTime() + MAX_MATERIALIZATION_WINDOW_MS) };
}

/**
 * A stored series expanded from its last cursor, or `null` when there is no usable cursor or the
 * expansion is refused.
 */
function resumeStoredSeries(
  event: CalendarEventContent,
  window: Interval,
  found: CalendarEventRow | undefined,
): CalendarSeriesExpansion | null {
  if (!found?.recurrence_cursor) return null;
  try {
    return expandCalendarEventSeries(event, window, {
      cursor: found.recurrence_cursor,
      stored: false,
      resumeOnly: true,
    });
  } catch (error) {
    if (error instanceof CalendarContractError) return null;
    throw error;
  }
}

function seriesCursorJson(tx: TransactionSql, cursor: CalendarSeriesCursor | null) {
  return cursor === null ? null : tx.json(cursor as unknown as Parameters<TransactionSql['json']>[0]);
}

/**
 * From the horizon's start to the later of the two ends, so the end never moves back. `null` keeps
 * the stored window: it already covers the horizon, or no window from the horizon's start fits the
 * 367-day cap yet.
 */
function rolledWindow(stored: Interval, horizon: Interval): Interval | null {
  if (stored.start <= horizon.start && stored.end >= horizon.end) return null;
  if (stored.end.getTime() - horizon.start.getTime() > MAX_MATERIALIZATION_WINDOW_MS) return null;
  return { start: horizon.start, end: stored.end > horizon.end ? stored.end : horizon.end };
}

/**
 * How far past a rule's UNTIL, read as UTC, an occurrence can still end. UNTIL bounds starts (RFC
 * 5545 §3.3.10), but a floating or date-only UNTIL is a wall time in any zone (UTC-12 to UTC+14),
 * skipped hours move starts forward, and clock changes stretch ends: three days covers them
 * together.
 */
const SERIES_UNTIL_SLACK_MS = 3 * DAY_MS;
/** Stored-series windows a COUNT rule is followed through, from its start, to find its end. */
const SERIES_COUNT_SEARCH_WINDOWS = 30;

/**
 * A time by which every occurrence of a series ends, or `null` when it may go on: no UNTIL or COUNT
 * as ical.js reads it, or the COUNT occurrences are not all found within
 * SERIES_COUNT_SEARCH_WINDOWS windows or the search budget.
 */
function seriesEndsBy(event: CalendarEventContent): Date | null {
  const recurrence = event.recurrence;
  if (!recurrence) return null;
  let rule: ICAL.Recur;
  try {
    rule = ICAL.Recur.fromString(recurrence.rrule);
  } catch {
    return null;
  }
  let endsBy: number;
  if (rule.until) {
    // ical.js stops at the first occurrence past UNTIL; a floating or date UNTIL reads as UTC.
    const untilMs = rule.until.toUnixTime() * 1000;
    endsBy = untilMs + (event.end.getTime() - event.start.getTime()) + SERIES_UNTIL_SLACK_MS;
  } else if (rule.count) {
    const last = lastCountedOccurrenceEnd(event, rule.count);
    if (last === null) return null;
    endsBy = last + DAY_MS;
  } else {
    return null;
  }
  for (const exception of recurrence.exceptions ?? []) {
    if (!exception.cancelled && exception.end && exception.end.getTime() > endsBy) {
      endsBy = exception.end.getTime();
    }
  }
  const ends = new Date(endsBy);
  return Number.isFinite(ends.getTime()) ? ends : null;
}

/**
 * The latest end among a COUNT series' occurrences, expanded window by window with exceptions left
 * out (so a moved one is found in its own place), or `null` when fewer than `count` turn up.
 */
function lastCountedOccurrenceEnd(event: CalendarEventContent, count: number): number | null {
  const rrule = event.recurrence?.rrule;
  if (rrule === undefined) return null;
  const series: CalendarEventContent = { ...event, recurrence: { rrule } };
  let cursor: unknown = null;
  let found = 0;
  let lastEnd = Number.NEGATIVE_INFINITY;
  let from = event.start.getTime();
  try {
    for (let window = 0; window < SERIES_COUNT_SEARCH_WINDOWS; window++) {
      const to = from + MAX_MATERIALIZATION_WINDOW_MS;
      const expansion = expandCalendarEventSeries(
        series,
        { start: new Date(from), end: new Date(to) },
        { cursor, stored: true },
      );
      for (const occurrence of expansion.occurrences) {
        if (occurrence.start.getTime() < from) continue;
        found += 1;
        if (occurrence.end.getTime() > lastEnd) lastEnd = occurrence.end.getTime();
      }
      if (found >= count) return lastEnd;
      cursor = expansion.cursor;
      from = to;
    }
  } catch (error) {
    if (error instanceof CalendarExpansionLimitError || error instanceof CalendarContractError) {
      return null;
    }
    throw error;
  }
  return null;
}

/**
 * recurrence_ends_by as text: NULL for a one-off, 'infinity' for no known end. Bind it as text
 * (`::text::timestamptz`): postgres.js serializes timestamptz through Date, which cannot hold
 * 'infinity'.
 */
function recurrenceEndsByColumn(event: CalendarEventContent): string | null {
  if (!event.recurrence) return null;
  return seriesEndsBy(event)?.toISOString() ?? 'infinity';
}

function rollCursor(after: CalendarHorizonRollCursor | undefined): CalendarHorizonRollCursor | undefined {
  if (after === undefined) return undefined;
  const retryAt = after.rollRetryAt ?? null;
  if (
    (retryAt !== null && (!(retryAt instanceof Date) || !Number.isFinite(retryAt.getTime()))) ||
    !(after.materializedEndsAt instanceof Date) ||
    !Number.isFinite(after.materializedEndsAt.getTime()) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after.eventId)
  ) {
    throw Object.assign(new Error('Slotlock horizon cursor must be a previous batch\'s `next`'), {
      code: 'invalid_cursor' as const,
    });
  }
  return after;
}

/** What `createSlotlockStore` accepts: a `postgres` client, or a transaction/savepoint from one. */
export type SlotlockSql = Sql | TransactionSql;
type StoreSql = SlotlockSql;

/**
 * A new transaction on a client (READ COMMITTED when asked), or a savepoint inside the caller's,
 * whose isolation cannot change.
 */
async function inTransaction<T>(
  executor: StoreSql,
  callback: (tx: TransactionSql) => Promise<T>,
  isolation?: 'read committed',
): Promise<T> {
  if ('begin' in executor) {
    if (isolation === 'read committed') {
      return (await executor.begin('isolation level read committed', callback)) as T;
    }
    return (await executor.begin(callback)) as T;
  }
  return (await executor.savepoint(callback)) as T;
}

function invalidIsolationError(): Error & { code: 'invalid_transaction_isolation' } {
  return Object.assign(
    new Error(
      'Slotlock needs a READ COMMITTED transaction here, so its lock-then-count check sees every row committed before the lock',
    ),
    { code: 'invalid_transaction_isolation' as const },
  );
}

async function assertReadCommitted(tx: TransactionSql): Promise<void> {
  const [row] = await tx<{ level: string }[]>`
    SELECT current_setting('transaction_isolation') AS level`;
  if (row?.level !== 'read committed') throw invalidIsolationError();
}

/**
 * Run deployment SQL with names resolved only in pg_catalog and pg_temp. The deployment role owns
 * every table, so a function found in a schema another role can write to ("$user", public) would
 * run with that ownership. The caller's search_path is restored afterwards.
 */
async function withPinnedSearchPath<T>(
  tx: TransactionSql,
  operation: () => Promise<T>,
): Promise<T> {
  const [caller] = await tx<{ path: string }[]>`
    SELECT pg_catalog.current_setting('search_path') AS path`;
  await tx`SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true)`;
  const result = await operation();
  await tx`SELECT pg_catalog.set_config('search_path', ${caller?.path ?? ''}, true)`;
  return result;
}

/**
 * Map the DDL's refusals: SQLSTATE 42501 (another role controls the schema; findings as JSON in
 * DETAIL) to `unsafe_slotlock_schema`, and 55000 to `schema_newer`. Anything else passes through.
 */
function schemaControlRefusal(error: unknown): unknown {
  const failure = error as { code?: unknown; message?: unknown; detail?: unknown } | null;
  if (
    failure?.code === '55000' &&
    typeof failure.message === 'string' &&
    failure.message.startsWith(SLOTLOCK_SCHEMA_NEWER_REFUSAL)
  ) {
    return Object.assign(new Error(failure.message, { cause: error }), {
      code: 'schema_newer' as const,
    });
  }
  if (
    failure?.code !== '42501' ||
    typeof failure.message !== 'string' ||
    !failure.message.startsWith(SLOTLOCK_SCHEMA_CONTROL_REFUSAL)
  ) {
    return error;
  }
  let reasons: string[] = [];
  try {
    const detail: unknown = JSON.parse(String(failure.detail));
    if (Array.isArray(detail)) reasons = detail.map(String);
  } catch {
    // Not the check's DETAIL: the message alone still says what was refused.
  }
  const found = reasons.length > 0 ? ` (${reasons.join('; ')})` : '';
  return Object.assign(new Error(`${failure.message}${found}`, { cause: error }), {
    code: 'unsafe_slotlock_schema' as const,
    reasons,
  });
}

/** How a migration (applySchema, applyTenantRls, grantApplicationRole) waits and how long it runs. */
export interface SlotlockMigrationOptions {
  /**
   * The longest it waits for any one lock, in milliseconds (1-600,000; default 1,000). Queries on a
   * table queue behind a migration waiting for its lock, so past this it gives up, lets them
   * through, and retries.
   */
  lockTimeoutMs?: number;
  /** The longest any one of its statements runs, in milliseconds (1-86,400,000; default 900,000). */
  statementTimeoutMs?: number;
  /** How many times it tries in all (1-20; default 5) before refusing with `schema_lock_timeout`. */
  attempts?: number;
}

const LOCK_NOT_AVAILABLE = '55P03';

const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 1_000;
const DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MIGRATION_ATTEMPTS = 5;
const SLOTLOCK_CORE_DDL_SHA256 = createHash('sha256').update(SLOTLOCK_CORE_DDL).digest('hex');

function migrationSettings(options: SlotlockMigrationOptions | undefined) {
  const lockTimeoutMs = options?.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
  const statementTimeoutMs = options?.statementTimeoutMs ?? DEFAULT_MIGRATION_STATEMENT_TIMEOUT_MS;
  const attempts = options?.attempts ?? DEFAULT_MIGRATION_ATTEMPTS;
  const whole = (value: number, max: number) =>
    Number.isSafeInteger(value) && value >= 1 && value <= max;
  if (
    !whole(lockTimeoutMs, 600_000) ||
    !whole(statementTimeoutMs, 86_400_000) ||
    !whole(attempts, 20)
  ) {
    throw Object.assign(
      new Error(
        'Slotlock migration lockTimeoutMs must be 1-600000, statementTimeoutMs 1-86400000 and attempts 1-20, whole numbers',
      ),
      { code: 'invalid_migration_options' as const },
    );
  }
  return { lockTimeoutMs, statementTimeoutMs, attempts };
}

/**
 * One migration step: in a transaction (or savepoint), names pinned to pg_catalog, serialized with
 * every other migration, under the lock and statement timeouts. A lock timeout or deadlock is
 * rolled back and retried up to `attempts` times. The caller's own timeouts are restored
 * afterwards.
 */
async function inMigration<T>(
  executor: StoreSql,
  options: SlotlockMigrationOptions | undefined,
  step: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const settings = migrationSettings(options);
  for (let attempt = 1; ; attempt++) {
    try {
      return await inTransaction(executor, (tx) =>
        withPinnedSearchPath(tx, async () => {
          // Taken before the timeouts are set: waiting for another migration holds up no query.
          await tx`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${SCHEMA_APPLY_LOCK}, 0))`;
          const [caller] = await tx<{ lock: string; statement: string }[]>`
            SELECT pg_catalog.current_setting('lock_timeout') AS lock,
                   pg_catalog.current_setting('statement_timeout') AS statement`;
          await tx`
            SELECT pg_catalog.set_config('lock_timeout', ${`${settings.lockTimeoutMs}ms`}, true),
                   pg_catalog.set_config('statement_timeout', ${`${settings.statementTimeoutMs}ms`}, true)`;
          const result = await step(tx);
          await tx`
            SELECT pg_catalog.set_config('lock_timeout', ${caller?.lock ?? '0'}, true),
                   pg_catalog.set_config('statement_timeout', ${caller?.statement ?? '0'}, true)`;
          return result;
        }),
      );
    } catch (error) {
      // A deadlock victim (a writer took outbox then coverage, a rename batch the other order) lost
      // its locks, so it retries like a lock timeout.
      const code = pgCode(error);
      if (code !== LOCK_NOT_AVAILABLE && code !== DEADLOCK_DETECTED) throw error;
      if (attempt >= settings.attempts) {
        throw Object.assign(
          new Error(
            `Slotlock migration gave up after ${attempt} attempts to take its locks within ${settings.lockTimeoutMs} ms: a long transaction holds a slotlock table, or took them in another order. Run it again once that transaction ends`,
            { cause: error },
          ),
          { code: 'schema_lock_timeout' as const },
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(attempt * 250, 2_000) + Math.floor(Math.random() * 250)),
      );
    }
  }
}

/**
 * A digest of what the migration defines in the `slotlock` schema: tables, columns, constraints
 * (and whether validated), indexes, triggers, functions and PUBLIC grants. Grants to other roles,
 * ownership and RLS are left out: applyTenantRls and grantApplicationRole change those later. Runs
 * with search_path pinned, as deparsed definitions depend on it.
 */
async function slotlockCatalogDigest(tx: TransactionSql): Promise<string> {
  const [row] = await tx<{ digest: string }[]>`
    WITH schema AS (
      SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'slotlock'
    ), members AS (
      SELECT objid FROM pg_catalog.pg_depend WHERE deptype = 'e'
    ), items (item) AS (
      SELECT 'relation ' || rel.relname || ' ' || rel.relkind::text || ' '
             || EXISTS (SELECT 1 FROM pg_catalog.aclexplode(rel.relacl) acl WHERE acl.grantee = 0)::text
        FROM pg_catalog.pg_class rel, schema
       WHERE rel.relnamespace = schema.oid AND rel.oid NOT IN (SELECT objid FROM members)
      UNION ALL
      SELECT 'column ' || rel.relname || '.' || att.attname || ' '
             || pg_catalog.format_type(att.atttypid, att.atttypmod) || ' ' || att.attnotnull::text || ' '
             || COALESCE(pg_catalog.pg_get_expr(def.adbin, def.adrelid), '')
        FROM pg_catalog.pg_attribute att
        JOIN pg_catalog.pg_class rel ON rel.oid = att.attrelid
        JOIN schema ON rel.relnamespace = schema.oid
        LEFT JOIN pg_catalog.pg_attrdef def ON def.adrelid = att.attrelid AND def.adnum = att.attnum
       WHERE rel.relkind IN ('r', 'p') AND att.attnum > 0 AND NOT att.attisdropped
      UNION ALL
      SELECT 'constraint ' || rel.relname || '.' || con.conname || ' '
             || pg_catalog.pg_get_constraintdef(con.oid) || ' ' || con.convalidated::text
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
        JOIN schema ON rel.relnamespace = schema.oid
      UNION ALL
      SELECT 'index ' || pg_catalog.pg_get_indexdef(idx.indexrelid)
        FROM pg_catalog.pg_index idx
        JOIN pg_catalog.pg_class rel ON rel.oid = idx.indrelid
        JOIN schema ON rel.relnamespace = schema.oid
      UNION ALL
      SELECT 'trigger ' || pg_catalog.pg_get_triggerdef(trg.oid) || ' ' || trg.tgenabled::text
        FROM pg_catalog.pg_trigger trg
        JOIN pg_catalog.pg_class rel ON rel.oid = trg.tgrelid
        JOIN schema ON rel.relnamespace = schema.oid
       WHERE NOT trg.tgisinternal
      UNION ALL
      SELECT 'function ' || fn.oid::pg_catalog.regprocedure::text || ' ' || fn.prosecdef::text || ' '
             || fn.provolatile::text || ' ' || COALESCE(fn.proconfig::text, '') || ' '
             || pg_catalog.md5(fn.prosrc) || ' '
             || EXISTS (SELECT 1 FROM pg_catalog.aclexplode(
                          COALESCE(fn.proacl, pg_catalog.acldefault('f', fn.proowner))) acl
                         WHERE acl.grantee = 0)::text
        FROM pg_catalog.pg_proc fn, schema
       WHERE fn.pronamespace = schema.oid AND fn.oid NOT IN (SELECT objid FROM members)
      UNION ALL
      SELECT 'extension ' || ext.extname || ' ' || ext.extnamespace::pg_catalog.regnamespace::text
        FROM pg_catalog.pg_extension ext
       WHERE ext.extname = 'btree_gist'
    )
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
             COALESCE(pg_catalog.string_agg(item, pg_catalog.chr(10) ORDER BY item), ''),
             'UTF8')), 'hex') AS digest
      FROM items`;
  return row?.digest ?? '';
}

/**
 * Whether the schema is exactly what this release's applySchema last left: same version, DDL and
 * catalog digest, and no table left unforced by an interrupted migration. Without the right to read
 * it, the full migration runs instead.
 */
async function slotlockSchemaUpToDate(tx: TransactionSql): Promise<boolean> {
  const [present] = await tx<{ versioned: boolean; lifted: boolean }[]>`
    SELECT COALESCE(pg_catalog.has_table_privilege(
             pg_catalog.to_regclass('slotlock.schema_version'), 'SELECT'), false) AS versioned,
           COALESCE(pg_catalog.has_table_privilege(
             pg_catalog.to_regclass('slotlock.deployment_lifted_row_security'), 'SELECT'), false)
             AS lifted`;
  if (!present?.versioned || !present.lifted) return false;
  const [recorded] = await tx<
    { version: number; ddl_sha256: string | null; catalog_sha256: string | null; lifted: boolean }[]
  >`
    SELECT version, ddl_sha256, catalog_sha256,
           EXISTS (SELECT 1 FROM slotlock.deployment_lifted_row_security) AS lifted
      FROM slotlock.schema_version
     WHERE singleton`;
  if (
    !recorded ||
    recorded.lifted ||
    recorded.version !== SLOTLOCK_SCHEMA_VERSION ||
    recorded.ddl_sha256 !== SLOTLOCK_CORE_DDL_SHA256 ||
    recorded.catalog_sha256 === null
  ) {
    return false;
  }
  return recorded.catalog_sha256 === (await slotlockCatalogDigest(tx));
}

/**
 * Rename the coverage changes an earlier release wrote (ddl.ts, slotlockCoverageChangeRenameSql),
 * in batches of SLOTLOCK_COVERAGE_CHANGE_RENAME_BATCH outbox ids, resuming from
 * `schema_version.coverage_changes_renamed_through`. An older server still running can write more,
 * so every migration runs a pass until one finds nothing.
 *
 * The head is read once every transaction already writing to the outbox has ended, so nothing at or
 * below it commits later. Forced RLS would hide other tenants' rows, so each batch lifts FORCE from
 * calendar_coverage and outbox under ACCESS EXCLUSIVE (in writer lock order) and restores it before
 * committing. A superuser or BYPASSRLS role instead holds SHARE ROW EXCLUSIVE on the outbox only
 * while reading the head.
 */
async function renameEarlierCoverageChanges(
  executor: StoreSql,
  options: SlotlockMigrationOptions | undefined,
): Promise<void> {
  /**
   * Run `work` able to read every tenant's rows: as is for a superuser or BYPASSRLS role, else with
   * FORCE lifted under ACCESS EXCLUSIVE (calendar_coverage, then outbox: writer lock order) and put
   * back after.
   */
  const everyTenant = async <T>(tx: TransactionSql, bypass: boolean, work: () => Promise<T>) => {
    const forced = bypass
      ? []
      : await tx<{ name: string }[]>`
          SELECT rel.relname::text AS name
            FROM pg_catalog.pg_class rel
            JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
           WHERE ns.nspname = 'slotlock' AND rel.relname IN ('calendar_coverage', 'outbox')
             AND rel.relforcerowsecurity
           ORDER BY rel.relname`;
    const lifted = forced.map(({ name }) => `slotlock.${name}`);
    if (lifted.length > 0) {
      await tx.unsafe(`LOCK TABLE ${lifted.join(', ')} IN ACCESS EXCLUSIVE MODE`);
      for (const table of lifted) await tx.unsafe(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    }
    const result = await work();
    for (const table of lifted) await tx.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    return result;
  };

  // The head, in its own short transaction: writes in flight hold ROW EXCLUSIVE from before they
  // took their id, so none at or below it commits later.
  const start = await inMigration(executor, options, async (tx) => {
    const [state] = await tx<{ renamed: boolean; through: string | null; bypass: boolean }[]>`
      SELECT version.coverage_changes_renamed AS renamed,
             version.coverage_changes_renamed_through::text AS through,
             EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                      WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) AS bypass
        FROM slotlock.schema_version version
       WHERE version.singleton`;
    if (state === undefined || state.renamed) return null;
    if (state.bypass) await tx.unsafe('LOCK TABLE slotlock.outbox IN SHARE ROW EXCLUSIVE MODE');
    const [top] = await everyTenant(tx, state.bypass, () =>
      tx<{ head: string }[]>`SELECT COALESCE(max(id), 0)::text AS head FROM slotlock.outbox`,
    );
    return { head: top?.head ?? '0', through: state.through, bypass: state.bypass };
  });
  if (start === null) return;
  const { head, bypass } = start;
  const firstPass = start.through === null;
  const rename = slotlockCoverageChangeRenameSql('$1::bigint', '$2::bigint', '$3::int');
  let after = start.through ?? '0';
  let renamedTotal = 0;
  for (;;) {
    const last = await inMigration(executor, options, async (tx) => {
      const [row] = await everyTenant(tx, bypass, () =>
        tx.unsafe<{ last: string | null; renamed: number }[]>(rename, [
          after,
          head,
          SLOTLOCK_COVERAGE_CHANGE_RENAME_BATCH,
        ]),
      );
      const read = row?.last ?? null;
      renamedTotal += row?.renamed ?? 0;
      await tx`
        UPDATE slotlock.schema_version
           SET coverage_changes_renamed_through = ${read ?? head}::bigint,
               coverage_changes_renamed = ${read === null && !firstPass && renamedTotal === 0}
         WHERE singleton`;
      return read;
    });
    if (last === null) return;
    after = String(last);
  }
}

async function coverageChangesRenamePending(tx: TransactionSql): Promise<boolean> {
  const [row] = await tx<{ renamed: boolean }[]>`
    SELECT coverage_changes_renamed AS renamed FROM slotlock.schema_version WHERE singleton`;
  return row !== undefined && !row.renamed;
}

/** Whether a constraint in the `slotlock` schema is still NOT VALID (old rows broke it). */
async function slotlockConstraintUnvalidated(tx: TransactionSql): Promise<boolean> {
  const [row] = await tx<{ unvalidated: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'slotlock' AND NOT con.convalidated
    ) AS unvalidated`;
  return row?.unvalidated === true;
}

/**
 * Whether every tenant table has forced RLS and only its tenant policy bound to `setting`, matching
 * the fingerprint the DDL recorded.
 */
async function tenantRlsUpToDate(tx: TransactionSql, setting: string): Promise<boolean> {
  const [present] = await tx<{ readable: boolean }[]>`
    SELECT COALESCE(pg_catalog.has_table_privilege(
             pg_catalog.to_regclass('slotlock.rls_policy_contracts'), 'SELECT'), false) AS readable`;
  if (!present?.readable) return false;
  const tables = [...SLOTLOCK_TENANT_TABLES];
  const [state] = await tx<{ current: boolean | null; matched: number }[]>`
    SELECT pg_catalog.bool_and(
             rel.relrowsecurity AND rel.relforcerowsecurity
             -- The tenant policy, and on a table a limited key is held to, the restrictive scope
             -- policy, which can only narrow it; no other.
             AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy every
                   WHERE every.polrelid = rel.oid
                     AND (every.polname = 'tenant_isolation_v1'
                          OR NOT (every.polname = 'resource_scope_v1' AND NOT every.polpermissive
                                  AND wanted.name = ANY (${Object.keys(SLOTLOCK_RESOURCE_SCOPED_TABLES)}::text[])))) = 1
             AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy scoped
                   WHERE scoped.polrelid = rel.oid AND scoped.polname = 'resource_scope_v1'
                     AND NOT scoped.polpermissive)
                 = CASE WHEN wanted.name = ANY (${Object.keys(SLOTLOCK_RESOURCE_SCOPED_TABLES)}::text[]) THEN 1 ELSE 0 END
             AND pg_catalog.obj_description(pol.oid, 'pg_policy') = ${`slotlock:tenant-context:${setting}`}
             AND contract.tenant_context_setting = ${setting}
             AND contract.policy_fingerprint = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   pg_catalog.concat_ws(
                     pg_catalog.chr(31), live.policyname, live.permissive, live.roles::text, live.cmd,
                     COALESCE(live.qual, ''), COALESCE(live.with_check, '')
                   ),
                   'UTF8')), 'hex')
           ) AS current,
           pg_catalog.count(*)::int AS matched
      FROM pg_catalog.unnest(${tables}::text[]) AS wanted(name)
      JOIN pg_catalog.pg_namespace ns ON ns.nspname = 'slotlock'
      JOIN pg_catalog.pg_class rel ON rel.relnamespace = ns.oid AND rel.relname = wanted.name
      JOIN pg_catalog.pg_policy pol ON pol.polrelid = rel.oid AND pol.polname = 'tenant_isolation_v1'
      JOIN pg_catalog.pg_policies live
        ON live.schemaname = 'slotlock' AND live.tablename = wanted.name
       AND live.policyname = 'tenant_isolation_v1'
      JOIN slotlock.rls_policy_contracts contract ON contract.table_name = wanted.name`;
  return state?.current === true && state.matched === tables.length;
}

/**
 * The recorded schema version, or `null` when this role cannot read one: no schema, 0.2 or earlier,
 * or the function not yet granted (`slotlock migrate` grants it).
 */
export async function readSlotlockSchemaVersion(sql: SlotlockSql): Promise<number | null> {
  const [readable] = await sql<{ readable: boolean }[]>`
    SELECT COALESCE(pg_catalog.has_function_privilege(
             pg_catalog.to_regprocedure('slotlock.installed_schema_version()'), 'EXECUTE'), false)
             AS readable`;
  if (!readable?.readable) return null;
  const [row] = await sql<{ version: number | null }[]>`
    SELECT slotlock.installed_schema_version() AS version`;
  return row?.version ?? null;
}

/**
 * Refuse a schema another release migrated: `schema_outdated` (older or unversioned: run `slotlock
 * migrate`) or `schema_newer`. Both carry `installed` and `expected`.
 */
export async function assertSlotlockSchemaCurrent(sql: SlotlockSql): Promise<void> {
  const installed = await readSlotlockSchemaVersion(sql);
  if (installed === SLOTLOCK_SCHEMA_VERSION) return;
  const newer = installed !== null && installed > SLOTLOCK_SCHEMA_VERSION;
  throw Object.assign(
    new Error(
      newer
        ? `The slotlock schema is version ${installed}, migrated by a newer release; this release serves version ${SLOTLOCK_SCHEMA_VERSION}. Serve it with that release or a later one`
        : `The slotlock schema is ${installed === null ? 'unversioned (0.2 or earlier)' : `version ${installed}`}; this release serves version ${SLOTLOCK_SCHEMA_VERSION}. Run \`slotlock migrate\` with this release first`,
    ),
    {
      code: newer ? ('schema_newer' as const) : ('schema_outdated' as const),
      installed,
      expected: SLOTLOCK_SCHEMA_VERSION,
    },
  );
}

interface ReservationRow {
  id: string;
  resource_id: string;
  tenant_ref: string | null;
  external_ref: string | null;
  starts_at: Date;
  ends_at: Date;
  buffer_after_ms: string | number;
  revision: string | number;
  source: string | null;
}

interface CalendarEventRow {
  id: string;
  tenant_ref: string;
  owner_ref: string;
  external_ref: string;
  resource_id: string;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  summary: string;
  description: string | null;
  location: string | null;
  status: 'confirmed' | 'tentative';
  transparency: 'opaque' | 'transparent';
  organizer: CalendarOrganizer | null;
  attendees: CalendarAttendee[];
  reminders: CalendarReminder[];
  recurrence_rule: string | null;
  recurrence_exceptions: Array<{
    recurrenceId: string;
    cancelled?: boolean;
    start?: string;
    end?: string;
  }>;
  materialized_starts_at: Date;
  materialized_ends_at: Date;
  /** Selected only where a series is expanded (the write and the roll). */
  recurrence_cursor?: unknown;
  revision: string | number;
  source: string | null;
  created_at: Date;
  updated_at: Date;
}

interface CalendarEventAttendeeRow {
  event_id: string;
  email: string;
  display_name: string | null;
  role: NonNullable<CalendarAttendee['role']> | null;
  participation_status: NonNullable<CalendarAttendee['participationStatus']> | null;
  rsvp: boolean | null;
}

interface CalendarEventReminderRow {
  event_id: string;
  action: CalendarReminder['action'];
  minutes_before_start: number;
}

interface CalendarEventExceptionRow {
  event_id: string;
  recurrence_id: Date;
  cancelled: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
}

interface CalendarEventChildren {
  attendees: CalendarAttendee[];
  reminders: CalendarReminder[];
  exceptions: CalendarRecurrenceException[];
}

interface CalendarCommandRow {
  operation: 'put' | 'cancel';
  payload_hash: string;
  event_id: string;
  external_ref: string;
  result_revision: string | number;
  occurrence_count: number;
}

function isFiniteWindow(window: Interval): boolean {
  return (
    window.start instanceof Date &&
    window.end instanceof Date &&
    Number.isFinite(window.start.getTime()) &&
    Number.isFinite(window.end.getTime()) &&
    window.end.getTime() > window.start.getTime()
  );
}

function isValidIdentity(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 500;
}

function isValidEventOwnerRef(value: string): boolean {
  return value === SLOTLOCK_INTERNAL_EVENT_OWNER_REF || AGENT_EVENT_OWNER_PATTERN.test(value);
}

function isValidResourceId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function assertValidVisibility(visibility: unknown): void {
  if (visibility !== undefined && visibility !== 'shared' && visibility !== 'private') {
    throw Object.assign(new Error("Slotlock resource visibility must be 'shared' or 'private'"), {
      code: 'invalid_visibility' as const,
    });
  }
}

function assertValidResourceInput(params: {
  externalRef?: string;
  tenantRef?: string;
  timezone?: string;
  visibility?: SlotlockResource['visibility'];
}): void {
  assertValidVisibility(params.visibility);
  if (
    params.externalRef !== undefined &&
    (params.externalRef.trim().length === 0 || Buffer.byteLength(params.externalRef, 'utf8') > 500)
  ) {
    throw Object.assign(new Error('Slotlock externalRef must be 1-500 UTF-8 bytes'), {
      code: 'invalid_external_ref' as const,
    });
  }
  if (params.tenantRef !== undefined && params.externalRef === undefined) {
    throw Object.assign(new Error('Slotlock tenant-owned resources require an externalRef'), {
      code: 'invalid_external_ref' as const,
    });
  }
  if (params.tenantRef !== undefined && !isValidIdentity(params.tenantRef)) {
    throw Object.assign(new Error('Slotlock tenantRef must be 1-500 UTF-8 bytes'), {
      code: 'invalid_tenant_ref' as const,
    });
  }
  const timezone = params.timezone ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(0);
  } catch {
    throw Object.assign(new Error(`Slotlock timezone is not a valid IANA zone: ${timezone}`), {
      code: 'invalid_timezone' as const,
    });
  }
}

function validateExternalCommand(
  params: ExternalReservationCommand,
): Extract<ExternalReservationResult, { ok: false }> | null {
  if (!isFiniteWindow(params)) return { ok: false, code: 'invalid_window' };
  if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.externalRef)) {
    return { ok: false, code: 'invalid_identity' };
  }
  if (
    !Number.isSafeInteger(params.bufferAfterMs) ||
    params.bufferAfterMs < 0 ||
    params.bufferAfterMs > MAX_BUFFER_AFTER_MS
  ) {
    return { ok: false, code: 'invalid_buffer' };
  }
  if (!Number.isSafeInteger(params.revision) || params.revision <= 0) {
    return { ok: false, code: 'invalid_revision' };
  }
  return null;
}

function toReservation(row: ReservationRow): SlotlockReservation {
  return {
    id: row.id,
    resourceId: row.resource_id,
    tenantRef: row.tenant_ref,
    externalRef: row.external_ref,
    start: row.starts_at,
    end: row.ends_at,
    bufferAfterMs: Number(row.buffer_after_ms),
    revision: Number(row.revision),
    source: row.source,
  };
}

interface AgendaRow {
  id: string;
  resource_id: string;
  starts_at: Date;
  ends_at: Date;
  status: 'held' | 'confirmed';
  external_ref: string | null;
  expires_at: Date | null;
  source: string | null;
  calendar_event_id: string | null;
  summary: string | null;
}

interface HoldRow {
  id: string;
  resource_id: string;
  starts_at: Date;
  ends_at: Date;
  buffer_after_ms: string | number;
  expires_at: Date;
  source: string | null;
  hold_group_id?: string | null;
}

function toHold(row: HoldRow): SlotlockHold {
  return {
    id: row.id,
    resourceId: row.resource_id,
    start: row.starts_at,
    end: row.ends_at,
    bufferAfterMs: Number(row.buffer_after_ms),
    expiresAt: row.expires_at,
    source: row.source,
    ...(row.hold_group_id ? { groupId: row.hold_group_id } : {}),
  };
}

function pageCursor(after: { start: Date; id: string } | undefined) {
  if (
    after !== undefined &&
    (!(after.start instanceof Date) ||
      !Number.isFinite(after.start.getTime()) ||
      !UUID_PATTERN.test(after.id))
  ) {
    throw Object.assign(new Error('Slotlock page cursor is invalid'), {
      code: 'invalid_cursor' as const,
    });
  }
  return { start: after?.start ?? null, id: after?.id ?? null };
}

function pageLimit(limit: number | undefined): number {
  const value = limit ?? 100;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CALENDAR_LIST_LIMIT) {
    throw Object.assign(new Error('Slotlock list limit must be 1-1000'), {
      code: 'invalid_limit' as const,
    });
  }
  return value;
}

function sandboxTestOnlyError(): Error & { code: 'sandbox_test_only' } {
  return Object.assign(
    new Error('Slotlock does this only in a test environment (a tenant ending ~test)'),
    { code: 'sandbox_test_only' as const },
  );
}

function invalidIdentityError(message: string): Error & { code: 'invalid_identity' } {
  return Object.assign(new Error(message), { code: 'invalid_identity' as const });
}

function eventExceptionsForJson(
  exceptions: CalendarRecurrenceException[] | undefined,
): CalendarEventRow['recurrence_exceptions'] {
  return (exceptions ?? []).map((exception) => {
    const result: CalendarEventRow['recurrence_exceptions'][number] = {
      recurrenceId: exception.recurrenceId.toISOString(),
    };
    if (exception.cancelled !== undefined) result.cancelled = exception.cancelled;
    if (exception.start) result.start = exception.start.toISOString();
    if (exception.end) result.end = exception.end.toISOString();
    return result;
  });
}

function organizerForJson(organizer: CalendarOrganizer | undefined): Record<string, string> | null {
  if (!organizer) return null;
  const result: Record<string, string> = { email: organizer.email };
  if (organizer.name) result.name = organizer.name;
  return result;
}

function attendeesForJson(
  attendees: CalendarAttendee[] | undefined,
): Array<Record<string, string | boolean>> {
  return (attendees ?? []).map((attendee) => {
    const result: Record<string, string | boolean> = { email: attendee.email };
    if (attendee.name !== undefined) result.name = attendee.name;
    if (attendee.role !== undefined) result.role = attendee.role;
    if (attendee.participationStatus !== undefined) {
      result.participationStatus = attendee.participationStatus;
    }
    if (attendee.rsvp !== undefined) result.rsvp = attendee.rsvp;
    return result;
  });
}

function remindersForJson(
  reminders: CalendarReminder[] | undefined,
): Array<Record<string, string | number>> {
  return (reminders ?? []).map((reminder) => ({
    action: reminder.action,
    minutesBeforeStart: reminder.minutesBeforeStart,
  }));
}

function eventExceptionsFromJson(
  exceptions: CalendarEventRow['recurrence_exceptions'],
): CalendarRecurrenceException[] {
  return exceptions.map((exception) => {
    const result: CalendarRecurrenceException = {
      recurrenceId: new Date(exception.recurrenceId),
    };
    if (exception.cancelled !== undefined) result.cancelled = exception.cancelled;
    if (exception.start !== undefined) result.start = new Date(exception.start);
    if (exception.end !== undefined) result.end = new Date(exception.end);
    return result;
  });
}

function toCalendarEvent(
  row: CalendarEventRow,
  normalizedChildren?: CalendarEventChildren,
): SlotlockCalendarEvent {
  const event: SlotlockCalendarEvent = {
    id: row.id,
    tenantRef: row.tenant_ref,
    ownerRef: row.owner_ref,
    externalRef: row.external_ref,
    resourceId: row.resource_id,
    start: row.starts_at,
    end: row.ends_at,
    timezone: row.timezone,
    summary: row.summary,
    status: row.status,
    transparency: row.transparency,
    revision: Number(row.revision),
    source: row.source,
    materializationWindow: {
      start: row.materialized_starts_at,
      end: row.materialized_ends_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.description !== null) event.description = row.description;
  if (row.location !== null) event.location = row.location;
  if (row.organizer !== null) event.organizer = row.organizer;
  const attendees = normalizedChildren?.attendees ?? row.attendees;
  const reminders = normalizedChildren?.reminders ?? row.reminders;
  const exceptions =
    normalizedChildren?.exceptions ?? eventExceptionsFromJson(row.recurrence_exceptions);
  if (attendees.length > 0) event.attendees = attendees;
  if (reminders.length > 0) event.reminders = reminders;
  if (row.recurrence_rule !== null) {
    event.recurrence = {
      rrule: row.recurrence_rule,
      exceptions,
    };
  }
  return event;
}

async function replaceCalendarEventChildren(
  tx: TransactionSql,
  tenantRef: string,
  eventId: string,
  event: CalendarEventContent,
): Promise<void> {
  await tx`DELETE FROM slotlock.calendar_event_attendees
            WHERE tenant_ref = ${tenantRef} AND event_id = ${eventId}`;
  await tx`DELETE FROM slotlock.calendar_event_reminders
            WHERE tenant_ref = ${tenantRef} AND event_id = ${eventId}`;
  await tx`DELETE FROM slotlock.calendar_event_exceptions
            WHERE tenant_ref = ${tenantRef} AND event_id = ${eventId}`;

  const attendees = attendeesForJson(event.attendees);
  if (attendees.length > 0) {
    await tx`
      INSERT INTO slotlock.calendar_event_attendees (
        tenant_ref, event_id, ordinal, email, display_name, role, participation_status, rsvp
      )
      SELECT ${tenantRef}, ${eventId}, (item.ordinality - 1)::int,
             item.value->>'email', NULLIF(item.value->>'name', ''),
             NULLIF(item.value->>'role', ''),
             NULLIF(item.value->>'participationStatus', ''),
             CASE WHEN item.value ? 'rsvp' THEN (item.value->>'rsvp')::boolean ELSE NULL END
        FROM jsonb_array_elements(${tx.json(attendees)}) WITH ORDINALITY AS item(value, ordinality)`;
  }

  const reminders = remindersForJson(event.reminders);
  if (reminders.length > 0) {
    await tx`
      INSERT INTO slotlock.calendar_event_reminders (
        tenant_ref, event_id, ordinal, action, minutes_before_start
      )
      SELECT ${tenantRef}, ${eventId}, (item.ordinality - 1)::int,
             item.value->>'action', (item.value->>'minutesBeforeStart')::int
        FROM jsonb_array_elements(${tx.json(reminders)}) WITH ORDINALITY AS item(value, ordinality)`;
  }

  const exceptions = eventExceptionsForJson(event.recurrence?.exceptions);
  if (exceptions.length > 0) {
    await tx`
      INSERT INTO slotlock.calendar_event_exceptions (
        tenant_ref, event_id, recurrence_id, cancelled, starts_at, ends_at
      )
      SELECT ${tenantRef}, ${eventId}, (item.value->>'recurrenceId')::timestamptz,
             COALESCE((item.value->>'cancelled')::boolean, false),
             NULLIF(item.value->>'start', '')::timestamptz,
             NULLIF(item.value->>'end', '')::timestamptz
        FROM jsonb_array_elements(${tx.json(exceptions)}) AS item(value)`;
  }
}

async function loadCalendarEventChildren(
  executor: StoreSql,
  eventIds: string[],
): Promise<Map<string, CalendarEventChildren>> {
  const result = new Map<string, CalendarEventChildren>();
  for (const eventId of eventIds) {
    result.set(eventId, { attendees: [], reminders: [], exceptions: [] });
  }
  if (eventIds.length === 0) return result;

  const attendeeRows = await executor<CalendarEventAttendeeRow[]>`
    SELECT event_id, email, display_name, role, participation_status, rsvp
      FROM slotlock.calendar_event_attendees
     WHERE event_id IN ${executor(eventIds)}
     ORDER BY event_id, ordinal`;
  for (const row of attendeeRows) {
    const attendee: CalendarAttendee = { email: row.email };
    if (row.display_name !== null) attendee.name = row.display_name;
    if (row.role !== null) attendee.role = row.role;
    if (row.participation_status !== null) {
      attendee.participationStatus = row.participation_status;
    }
    if (row.rsvp !== null) attendee.rsvp = row.rsvp;
    result.get(row.event_id)?.attendees.push(attendee);
  }

  const reminderRows = await executor<CalendarEventReminderRow[]>`
    SELECT event_id, action, minutes_before_start
      FROM slotlock.calendar_event_reminders
     WHERE event_id IN ${executor(eventIds)}
     ORDER BY event_id, ordinal`;
  for (const row of reminderRows) {
    result.get(row.event_id)?.reminders.push({
      action: row.action,
      minutesBeforeStart: row.minutes_before_start,
    });
  }

  const exceptionRows = await executor<CalendarEventExceptionRow[]>`
    SELECT event_id, recurrence_id, cancelled, starts_at, ends_at
      FROM slotlock.calendar_event_exceptions
     WHERE event_id IN ${executor(eventIds)}
     ORDER BY event_id, recurrence_id`;
  for (const row of exceptionRows) {
    const exception: CalendarRecurrenceException = { recurrenceId: row.recurrence_id };
    if (row.cancelled) exception.cancelled = true;
    if (row.starts_at !== null) exception.start = row.starts_at;
    if (row.ends_at !== null) exception.end = row.ends_at;
    result.get(row.event_id)?.exceptions.push(exception);
  }
  return result;
}

async function replaceCalendarEventOccurrences(
  tx: TransactionSql,
  params: {
    tenantRef: string;
    eventId: string;
    resourceId: string;
    event: CalendarEventContent;
    occurrences: CalendarEventOccurrence[];
    revision: number;
    bufferAfterMs?: number;
    bufferBeforeMs?: number;
  },
): Promise<void> {
  await tx`
    DELETE FROM slotlock.reservations
     WHERE id IN (
       SELECT reservation_id FROM slotlock.calendar_event_occurrences
        WHERE event_id = ${params.eventId} AND reservation_id IS NOT NULL
     )`;
  await tx`DELETE FROM slotlock.calendar_event_occurrences WHERE event_id = ${params.eventId}`;
  if (params.occurrences.length === 0) return;

  // Three statements for the whole series, not three per occurrence: a series of 2,000 holds the
  // tenant's locks for as long as its round trips take, and every write queued behind it waits.
  const starts = params.occurrences.map((occurrence) => occurrence.start.toISOString());
  const ends = params.occurrences.map((occurrence) => occurrence.end.toISOString());
  const reservationIds: string[] = params.occurrences.map(() => '');
  if ((params.event.transparency ?? 'opaque') === 'opaque') {
    const occupied = params.occurrences.map((occurrence) =>
      occupiedTime({
        ...occurrence,
        bufferBeforeMs: params.bufferBeforeMs ?? 0,
        bufferAfterMs: params.bufferAfterMs ?? 0,
      }),
    );
    await reapExpiredHoldsAcross(tx, params.resourceId, occupied);
    const externalRefs = params.occurrences.map(
      (occurrence) =>
        `calendar:${params.eventId}:${createHash('sha256').update(occurrence.recurrenceId).digest('hex')}`,
    );
    const inserted = await tx<{ id: string; external_ref: string }[]>`
      INSERT INTO slotlock.reservations (
        resource_id, tenant_ref, external_ref, starts_at, ends_at,
        buffer_after_ms, buffer_before_ms, revision, source, calendar_event_id
      )
      SELECT ${params.resourceId}, ${params.tenantRef}, occurrence.external_ref,
             occurrence.starts_at, occurrence.ends_at, ${params.bufferAfterMs ?? 0},
             ${params.bufferBeforeMs ?? 0}, ${params.revision},
             ${`calendar-event:${params.eventId}`}, ${params.eventId}
        FROM ROWS FROM (pg_catalog.unnest(${externalRefs}::text[]),
                        pg_catalog.unnest(${starts}::text[]::timestamptz[]),
                        pg_catalog.unnest(${ends}::text[]::timestamptz[]))
             WITH ORDINALITY AS occurrence(external_ref, starts_at, ends_at, ordinal)
       ORDER BY occurrence.ordinal
      RETURNING id, external_ref`;
    const byRef = new Map(inserted.map((row) => [row.external_ref, row.id]));
    externalRefs.forEach((externalRef, index) => {
      const id = byRef.get(externalRef);
      if (!id) throw new Error('slotlock: calendar occurrence reservation insert returned no row');
      reservationIds[index] = id;
    });
  }
  await tx`
    INSERT INTO slotlock.calendar_event_occurrences (
      event_id, tenant_ref, recurrence_id, starts_at, ends_at, reservation_id
    )
    SELECT ${params.eventId}, ${params.tenantRef}, occurrence.recurrence_id,
           occurrence.starts_at, occurrence.ends_at, NULLIF(occurrence.reservation_id, '')::uuid
      FROM ROWS FROM (pg_catalog.unnest(${params.occurrences.map((occurrence) => occurrence.recurrenceId)}::text[]),
                      pg_catalog.unnest(${starts}::text[]::timestamptz[]),
                      pg_catalog.unnest(${ends}::text[]::timestamptz[]),
                      pg_catalog.unnest(${reservationIds}::text[]))
           WITH ORDINALITY AS occurrence(recurrence_id, starts_at, ends_at, reservation_id, ordinal)
     ORDER BY occurrence.ordinal`;
}

function seriesWindow(window: Interval): Interval {
  if (
    !isFiniteWindow(window) ||
    window.end.getTime() - window.start.getTime() > MAX_MATERIALIZATION_WINDOW_MS
  ) {
    throw new CalendarContractError('invalid_icalendar');
  }
  return { start: new Date(window.start), end: new Date(window.end) };
}

function calendarWindow(window: Interval): Interval {
  if (
    !isFiniteWindow(window) ||
    window.end.getTime() - window.start.getTime() > MAX_CALENDAR_WINDOW_MS
  ) {
    throw new CalendarContractError('invalid_icalendar');
  }
  return { start: new Date(window.start), end: new Date(window.end) };
}

/**
 * A one-off event's window must contain the event. It may exceed the 367-day cap only by being
 * exactly the event's interval, as the `slotlock_calendar_events_materialization_window_bounded`
 * CHECK admits.
 */
function oneOffEventWindow(event: Interval, requested: Interval | undefined): Interval {
  const duration = event.end.getTime() - event.start.getTime();
  if (duration > MAX_EVENT_DURATION_MS) throw new CalendarContractError('invalid_icalendar');
  const window = requested ?? event;
  if (
    !isFiniteWindow(window) ||
    window.start > event.start ||
    window.end < event.end ||
    window.end.getTime() - window.start.getTime() > Math.max(MAX_MATERIALIZATION_WINDOW_MS, duration)
  ) {
    throw new CalendarContractError('invalid_icalendar');
  }
  return { start: new Date(window.start), end: new Date(window.end) };
}

function calendarCommandHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * A put's identity and the event it asks for, not its storage window: a series' window moves with
 * the UTC day, so a retry after midnight must still match.
 */
function putCommandHash(params: {
  command: PutCalendarEventCommand;
  ownerRef: string;
  event: CalendarEventContent;
}): string {
  return calendarCommandHash(putCommandValue(params));
}

/**
 * The hash 0.3.0 and earlier stored (window included), so an older stored command still replays.
 * Remove once no stored command can be that old (pruned after 30 days).
 */
export function legacyPutCommandHash(
  params: Parameters<typeof putCommandHash>[0] & { window: Interval },
): string {
  return calendarCommandHash({
    ...putCommandValue(params),
    materializationWindow: {
      start: params.window.start.toISOString(),
      end: params.window.end.toISOString(),
    },
  });
}

function putCommandValue(params: Parameters<typeof putCommandHash>[0]) {
  return {
    operation: 'put',
    ownerRef: params.ownerRef,
    externalRef: params.command.externalRef,
    idempotencyKey: params.command.idempotencyKey,
    expectedRevision: params.command.expectedRevision,
    resourceId: params.command.resourceId,
    source: params.command.source ?? null,
    // Only when present, so a create without a hold keeps its hash.
    ...(params.command.fromHold ? { fromHold: params.command.fromHold.holdId } : {}),
    event: {
      ...params.event,
      start: params.event.start.toISOString(),
      end: params.event.end.toISOString(),
      recurrence: params.event.recurrence
        ? {
            rrule: params.event.recurrence.rrule,
            exceptions: eventExceptionsForJson(params.event.recurrence.exceptions),
          }
        : null,
    },
  };
}

function cancelCommandHash(params: {
  ownerRef: string;
  externalRef: string;
  idempotencyKey: string;
  expectedRevision: number;
}): string {
  return calendarCommandHash({ operation: 'cancel', ...params });
}

function commandResult(
  row: CalendarCommandRow,
  idempotent: boolean,
): Extract<PutCalendarEventResult, { ok: true }> {
  return {
    ok: true,
    eventId: row.event_id,
    externalRef: row.external_ref,
    revision: Number(row.result_revision),
    occurrenceCount: row.occurrence_count,
    idempotent,
  };
}

async function lockCalendarIdempotency(
  tx: TransactionSql,
  tenantRef: string,
  ownerRef: string,
  idempotencyKey: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(
    hashtextextended(
      ${JSON.stringify(['slotlock-event-command', tenantRef, ownerRef, idempotencyKey])},
      0
    )
  )`;
}

async function lockCalendarEventIdentity(
  tx: TransactionSql,
  tenantRef: string,
  ownerRef: string,
  externalRef: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(
    hashtextextended(${JSON.stringify(['slotlock-event', tenantRef, ownerRef, externalRef])}, 0)
  )`;
}

async function lockCalendarOwnerQuota(
  tx: TransactionSql,
  tenantRef: string,
  ownerRef: string,
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(
    hashtextextended(${JSON.stringify(['slotlock-event-owner-quota', tenantRef, ownerRef])}, 0)
  )`;
}

async function calendarOwnerCommandCount(
  tx: TransactionSql,
  tenantRef: string,
  ownerRef: string,
): Promise<number> {
  const rows = await tx<{ count: string | number }[]>`
    SELECT count(*)::int AS count
      FROM slotlock.calendar_event_commands
     WHERE tenant_ref = ${tenantRef} AND owner_ref = ${ownerRef}`;
  const count = Number(rows[0]?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('slotlock: invalid owner command count');
  }
  return count;
}

/**
 * The end of every event cancellation, under the event's identity and row locks: remove the event
 * and its occupation, leave the tombstone at `revision`, and record the command for replay.
 */
async function finishCalendarCancel(
  tx: TransactionSql,
  params: {
    tenantRef: string;
    ownerRef: string;
    externalRef: string;
    eventId: string | null;
    revision: number;
    commandOwnerRef: string;
    idempotencyKey: string;
    payloadHash: string;
  },
): Promise<CancelCalendarEventResult> {
  const eventId = params.eventId ?? randomUUID();
  if (params.eventId !== null) {
    await tx`
      DELETE FROM slotlock.reservations
       WHERE id IN (
         SELECT reservation_id FROM slotlock.calendar_event_occurrences
          WHERE event_id = ${eventId} AND reservation_id IS NOT NULL
       )`;
    await tx`
      DELETE FROM slotlock.calendar_events
       WHERE id = ${eventId}
         AND tenant_ref = ${params.tenantRef}
         AND owner_ref = ${params.ownerRef}`;
  }
  await tx`
    INSERT INTO slotlock.calendar_event_tombstones (
      tenant_ref, owner_ref, external_ref, event_id, revision
    ) VALUES (
      ${params.tenantRef}, ${params.ownerRef}, ${params.externalRef}, ${eventId}, ${params.revision}
    )`;
  await tx`
    INSERT INTO slotlock.calendar_event_commands (
      tenant_ref, owner_ref, idempotency_key, operation, payload_hash, event_id, external_ref,
      result_revision, occurrence_count
    ) VALUES (
      ${params.tenantRef}, ${params.commandOwnerRef}, ${params.idempotencyKey}, 'cancel',
      ${params.payloadHash}, ${eventId}, ${params.externalRef}, ${params.revision}, 0
    )`;
  return {
    ok: true,
    eventId,
    externalRef: params.externalRef,
    revision: params.revision,
    idempotent: false,
  };
}

/**
 * The row an event write lost to. The write was rolled back, so the event's own previous rows are
 * excluded: they were to be replaced.
 */
async function findCalendarOverlap(
  sql: StoreSql,
  resourceId: string,
  occurrences: Array<{ start: Date; end: Date }>,
  eventId: string | undefined,
  buffers: { bufferBeforeMs: number; bufferAfterMs: number } = { bufferBeforeMs: 0, bufferAfterMs: 0 },
): Promise<{ ok: false; code: 'overlap'; conflictingReservationId: string | null }> {
  for (const occurrence of occurrences) {
    const result = await overlapLoss(
      sql,
      resourceId,
      occurrence.start,
      occurrence.end,
      buffers.bufferAfterMs,
      undefined,
      eventId,
      buffers.bufferBeforeMs,
    );
    if (result.conflictingReservationId !== null) return result;
  }
  return { ok: false, code: 'overlap', conflictingReservationId: null };
}

/**
 * What the resource's effective booking rules say about booking `interval` now (database clock):
 * the rule broken, if any, and the buffers to keep. A resource without its own hours is judged
 * against `defaultHours`.
 */
async function bookingRuling(
  tx: TransactionSql,
  resourceId: string,
  interval: Interval,
  defaultHours: readonly WeeklyAvailabilityRule[],
): Promise<{ rule: SlotlockBookingRule | null; turnaroundMs: number; bufferBeforeMs: number }> {
  const judge = await bookingJudge(tx, resourceId, defaultHours);
  return {
    rule: judge.broken(interval),
    turnaroundMs: judge.turnaroundMs,
    bufferBeforeMs: judge.bufferBeforeMs,
  };
}

/** How recently a sync must have read a resource whose booking rules require certainty. */
const CERTAIN_COVERAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The resource's effective booking rules, read once, as a check of any interval booked now
 * (database clock) and the buffers to keep.
 */
async function bookingJudge(
  tx: TransactionSql,
  resourceId: string,
  defaultHours: readonly WeeklyAvailabilityRule[],
): Promise<{
  broken: (interval: Interval, checks?: { first: boolean }) => SlotlockBookingRule | null;
  turnaroundMs: number;
  bufferBeforeMs: number;
}> {
  const [row] = await tx<
    { effective_booking_rules: unknown; availability_rules: unknown; timezone: string; now: Date }[]
  >`
    SELECT ${tx.unsafe(EFFECTIVE_BOOKING_RULES)}, availability_rules, timezone,
           statement_timestamp() AS now
      FROM slotlock.resources WHERE id = ${resourceId}`;
  if (!row || row.effective_booking_rules === null || row.effective_booking_rules === undefined) {
    return { broken: () => null, turnaroundMs: 0, bufferBeforeMs: 0 };
  }
  const { effectiveBookingRules: rules, availabilityRules } = toResource({
    id: resourceId,
    external_ref: null,
    tenant_ref: null,
    timezone: row.timezone,
    availability_rules: row.availability_rules,
    booking_rules: null,
    pool_ref: null,
    visibility: 'shared',
    archived_at: null,
    effective_booking_rules: row.effective_booking_rules,
  });
  const hours = availabilityRules ?? defaultHours;
  const coverage =
    rules?.requireCertain === true
      ? await tx<{ starts_at: Date; ends_at: Date; fresh: boolean }[]>`
          SELECT starts_at, ends_at,
                 observed_at >= statement_timestamp()
                   - make_interval(secs => ${CERTAIN_COVERAGE_MAX_AGE_MS / 1000}) AS fresh
            FROM slotlock.calendar_coverage WHERE resource_id = ${resourceId}`
      : [];
  const turnaroundMs = bookingBufferAfterMs(rules);
  const bufferBeforeMs = bookingBufferBeforeMs(rules);
  const uncertain = (interval: Interval) =>
    coverage.some(
      (source) =>
        !source.fresh ||
        source.starts_at.getTime() > interval.start.getTime() - bufferBeforeMs ||
        source.ends_at.getTime() < interval.end.getTime() + turnaroundMs,
    );
  // Later occurrences are judged on step and hours only: notice and advance concern when the
  // booking was made.
  const later =
    rules === undefined
      ? undefined
      : {
          ...(rules.slotStepMinutes !== undefined ? { slotStepMinutes: rules.slotStepMinutes } : {}),
          ...(rules.stepOffsetMinutes !== undefined ? { stepOffsetMinutes: rules.stepOffsetMinutes } : {}),
          ...(rules.enforceHours !== undefined ? { enforceHours: rules.enforceHours } : {}),
        };
  return {
    broken: (interval, checks = { first: true }) =>
      bookingRuleBroken({
        rules: checks.first ? rules : later,
        timezone: row.timezone,
        hours,
        interval,
        now: row.now,
      }) ?? (uncertain(interval) ? 'uncertain' : null),
    turnaroundMs,
    bufferBeforeMs,
  };
}

function sameExternalPayload(
  row: ReservationRow,
  params: ExternalReservationCommand,
  turnaroundMs = 0,
): boolean {
  const buffer = Number(row.buffer_after_ms);
  return (
    row.resource_id === params.resourceId &&
    row.starts_at.getTime() === params.start.getTime() &&
    row.ends_at.getTime() === params.end.getTime() &&
    (buffer === params.bufferAfterMs || buffer === Math.max(params.bufferAfterMs, turnaroundMs)) &&
    Number(row.revision) === params.revision &&
    row.source === (params.source ?? null)
  );
}

async function lockExternalIdentity(
  tx: TransactionSql,
  tenantRef: string,
  externalRef: string,
): Promise<void> {
  // JSON is unambiguous for this pair and has no NUL byte (Postgres text rejects U+0000).
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([tenantRef, externalRef])}, 0))`;
}

/**
 * Lock a resource a write is about to occupy time on, with its composite parent, in id order, to
 * the end of the transaction (RFC 0004 A7): writes to one resource, or one composite's family,
 * take turns. Without it, writers racing for the same time each insert, then wait at the
 * exclusion constraint for one another, and PostgreSQL breaks each such deadlock only after its
 * deadlock_timeout (a second), so a burst of agents for one slot could take many seconds. With
 * it, each meets the winner's committed row and is refused at once. NO KEY UPDATE, so foreign
 * keys to the resource are not blocked; an archive or delete waits for the write, as before. The
 * resource's own row, or null when there is none (for the tenant, when one is given).
 */
async function lockResourceForWrite(
  tx: TransactionSql,
  resourceId: string,
  tenantRef: string | null,
): Promise<{ tenant_ref: string | null; archived: boolean } | null> {
  const rows = await tx<{ id: string; tenant_ref: string | null; archived: boolean }[]>`
    SELECT id, tenant_ref, archived_at IS NOT NULL AS archived FROM slotlock.resources
     WHERE (id = ${resourceId}
            OR id = (SELECT parent_id FROM slotlock.resources WHERE id = ${resourceId}))
       AND (${tenantRef}::text IS NULL OR tenant_ref = ${tenantRef})
     ORDER BY id
     FOR NO KEY UPDATE`;
  const own = rows.find((row) => row.id === resourceId);
  return own ? { tenant_ref: own.tenant_ref, archived: own.archived } : null;
}

/**
 * Whether the resource is the tenant's (`missing` when not), and whether it is archived, locked
 * for the write that follows (lockResourceForWrite).
 */
async function tenantResourceState(
  tx: TransactionSql,
  resourceId: string,
  tenantRef: string,
): Promise<'missing' | 'archived' | 'active'> {
  const row = await readResourceForWrite(tx, resourceId, tenantRef);
  if (!row) return 'missing';
  return row.archived ? 'archived' : 'active';
}

/**
 * A resource a write is about to check its booking against, key-share locked so it is not deleted
 * meanwhile. It does not make writers wait for each other: lockResourceForWrite does, later, right
 * before the occupation is written, and checks again that the resource is there and not archived.
 * (KEY SHARE never conflicts with the NO KEY UPDATE that follows, so two writers cannot deadlock
 * upgrading.)
 */
async function readResourceForWrite(
  tx: TransactionSql,
  resourceId: string,
  tenantRef: string | null,
): Promise<{ tenant_ref: string | null; archived: boolean } | null> {
  const [row] = await tx<{ tenant_ref: string | null; archived: boolean }[]>`
    SELECT tenant_ref, archived_at IS NOT NULL AS archived FROM slotlock.resources
     WHERE id = ${resourceId} AND (${tenantRef}::text IS NULL OR tenant_ref = ${tenantRef})
     FOR KEY SHARE`;
  return row ?? null;
}

function pgCode(err: unknown): string | undefined {
  let cur = err as { code?: string; cause?: unknown } | undefined;
  while (cur && typeof cur === 'object') {
    if (typeof cur.code === 'string') return cur.code;
    cur = cur.cause as typeof cur;
  }
  return undefined;
}

/** Members a pool booking or search considers at most, in id order. */
export const SLOTLOCK_MAX_POOL_MEMBERS = 100;
/** The most pools of one tenant that may have default booking rules (`setBookingRuleDefaults`). */
export const SLOTLOCK_MAX_POOL_RULE_DEFAULTS = 1_000;

/** A pool's name: 1-100 of a-z, 0-9, `.`, `_` and `-`, starting with a letter or digit. */
interface WaitlistRow {
  id: string;
  resource_id: string | null;
  pool_ref: string | null;
  starts_at: Date;
  ends_at: Date;
  holder_ref: string;
  offer_ttl_ms: string | number;
  status: SlotlockWaitlistEntry['status'];
  hold_id: string | null;
  offered_resource_id: string | null;
  offered_at: Date | null;
  created_at: Date;
}

const WAITLIST_COLUMNS =
  'id, resource_id, pool_ref, starts_at, ends_at, holder_ref, offer_ttl_ms, status, hold_id, offered_resource_id, offered_at, created_at';

function toWaitlistEntry(row: WaitlistRow): SlotlockWaitlistEntry {
  return {
    id: row.id,
    resourceId: row.resource_id,
    pool: row.pool_ref,
    start: row.starts_at,
    end: row.ends_at,
    holderRef: row.holder_ref,
    offerTtlMs: Number(row.offer_ttl_ms),
    status: row.status,
    holdId: row.hold_id,
    offeredResourceId: row.offered_resource_id,
    offeredAt: row.offered_at,
    createdAt: row.created_at,
  };
}

export function isPoolName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(value);
}

function invalidPoolError(): Error & { code: 'invalid_pool' } {
  return Object.assign(new Error('Slotlock pool must be 1-100 of a-z, 0-9, ".", "_" and "-"'), {
    code: 'invalid_pool' as const,
  });
}

type ResourceRow = {
  id: string;
  external_ref: string | null;
  tenant_ref: string | null;
  timezone: string;
  availability_rules: unknown;
  booking_rules: unknown;
  pool_ref: string | null;
  visibility: NonNullable<SlotlockResource['visibility']>;
  archived_at: Date | null;
  /** The profile (resource-profile.ts); absent when the query did not read it. */
  name?: string | null;
  description?: string | null;
  kind?: string;
  capacity?: number | null;
  labels?: string[];
  attributes?: unknown;
  /** Where it is, and the groups it is in; absent when the query did not read them. */
  location_ref?: string | null;
  location_name?: string | null;
  group_refs?: string[];
  parent_id?: string | null;
  part_index?: number | null;
  /** The rules that apply (EFFECTIVE_BOOKING_RULES); absent when the query did not read them. */
  effective_booking_rules?: unknown;
};

/** A resource's own columns, as toResource reads them. */
const RESOURCE_COLUMNS = `id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref,
  visibility, archived_at, name, description, kind, capacity, labels, attributes, location_ref,
  parent_id, part_index,
  (SELECT place.name FROM slotlock.locations place
    WHERE place.tenant_ref = resources.tenant_ref AND place.ref = resources.location_ref) AS location_name,
  ARRAY(SELECT member.group_ref FROM slotlock.resource_group_members member
         WHERE member.tenant_ref = resources.tenant_ref AND member.resource_id = resources.id
         ORDER BY member.group_ref) AS group_refs`;

/**
 * A resource row's effective booking rules (jsonb; NULL for none): tenant defaults, overlaid by its
 * pool's, overlaid by its own, field by field. Reads from a row of slotlock.resources named
 * `resources` (no alias).
 */
const EFFECTIVE_BOOKING_RULES = `NULLIF(
  COALESCE((SELECT defaults.rules FROM slotlock.booking_rule_defaults defaults
             WHERE defaults.tenant_ref = resources.tenant_ref AND defaults.pool_ref = ''), '{}'::jsonb)
  || COALESCE((SELECT defaults.rules FROM slotlock.booking_rule_defaults defaults
                WHERE defaults.tenant_ref = resources.tenant_ref
                  AND defaults.pool_ref = resources.pool_ref), '{}'::jsonb)
  || COALESCE(resources.booking_rules, '{}'::jsonb),
  '{}'::jsonb) AS effective_booking_rules`;

/** What rules Slotlock did not write read as: no booking passes them. */
const REFUSE_EVERY_BOOKING: SlotlockBookingRules = Object.freeze({ maxAdvanceDays: 1, minNoticeMinutes: 525_600 });

/** Rules written validated, so anything else read back refuses every booking. */
function storedBookingRules(value: unknown): SlotlockBookingRules {
  try {
    return parseBookingRules(value);
  } catch {
    return { ...REFUSE_EVERY_BOOKING };
  }
}

function toResource(row: ResourceRow): SlotlockResource {
  const resource: SlotlockResource = {
    id: row.id,
    externalRef: row.external_ref,
    tenantRef: row.tenant_ref,
    timezone: row.timezone,
    visibility: row.visibility,
  };
  if (row.archived_at !== null) resource.archivedAt = row.archived_at;
  if (row.pool_ref !== null && row.pool_ref !== undefined) resource.pool = row.pool_ref;
  // The profile, each part only when it says something.
  if (typeof row.name === 'string') resource.name = row.name;
  if (typeof row.description === 'string') resource.description = row.description;
  if (row.kind !== undefined && row.kind !== 'other' && (SLOTLOCK_RESOURCE_KINDS as readonly string[]).includes(row.kind)) {
    resource.kind = row.kind as SlotlockResourceKind;
  }
  if (typeof row.capacity === 'number') resource.capacity = row.capacity;
  if (Array.isArray(row.labels) && row.labels.length > 0) resource.labels = [...row.labels];
  if (
    row.attributes !== null &&
    typeof row.attributes === 'object' &&
    !Array.isArray(row.attributes) &&
    Object.keys(row.attributes).length > 0
  ) {
    resource.attributes = { ...(row.attributes as SlotlockResourceAttributes) };
  }
  if (typeof row.location_ref === 'string') {
    resource.location = row.location_ref;
    if (typeof row.location_name === 'string') resource.locationName = row.location_name;
  }
  if (Array.isArray(row.group_refs) && row.group_refs.length > 0) resource.groups = [...row.group_refs];
  if (typeof row.parent_id === 'string' && typeof row.part_index === 'number') {
    resource.parentId = row.parent_id;
    resource.partIndex = row.part_index;
  }
  if (row.availability_rules !== null && row.availability_rules !== undefined) {
    // Written validated; anything else reads as closed.
    try {
      resource.availabilityRules = parseAvailabilityRules(row.availability_rules);
    } catch {
      resource.availabilityRules = [];
    }
  }
  if (row.booking_rules !== null && row.booking_rules !== undefined) {
    // Written validated; anything else refuses every booking, never as no rule.
    resource.bookingRules = storedBookingRules(row.booking_rules);
  }
  if (row.effective_booking_rules !== null && row.effective_booking_rules !== undefined) {
    // Levels are validated alone, so only their combination can disagree (an offset over a shorter
    // step): that one is read modulo the step. A field invalid in itself refuses every booking.
    const { rules, dropped } = parseEffectiveBookingRules(row.effective_booking_rules);
    if (dropped.length > 0) {
      console.warn(
        JSON.stringify({ message: 'slotlock refused invalid booking rules', resource: row.id, dropped }),
      );
      resource.effectiveBookingRules = { ...REFUSE_EVERY_BOOKING };
    } else if (Object.keys(rules).length > 0) {
      resource.effectiveBookingRules = rules;
    }
  }
  return resource;
}

function availabilityParameter(sql: StoreSql, rules: readonly WeeklyAvailabilityRule[] | null) {
  // sql.json, not JSON.stringify: a string bound to jsonb is stored as a JSON string.
  if (rules === null) return null;
  return sql.json(
    parseAvailabilityRules(rules).map(({ rrule, startMinutes, durationMinutes }) => ({
      rrule,
      startMinutes,
      durationMinutes,
    })),
  );
}

/** What the location and group guards (ddl.ts) refuse with, by their HINT. */
const GROUPING_REFUSALS: ReadonlySet<string> = new Set([
  'pool_order_limit_reached',
  'composite_too_deep',
  'composite_parts_limit',
  'composite_busy',
  'location_too_deep',
  'location_cycle',
  'location_limit_reached',
  'group_limit_reached',
  'resource_group_limit_reached',
]);

/**
 * A location or group write PostgreSQL refused, as the store's code: a guard's HINT, or the code
 * `foreignKeys` gives a foreign key that failed. Anything else as it was.
 */
function groupingRefusal(error: unknown, foreignKeys: Readonly<Record<string, string>> = {}): unknown {
  const failure = error as { code?: unknown; hint?: unknown; constraint_name?: unknown; message?: unknown } | null;
  const coded = (code: string) =>
    Object.assign(new Error(typeof failure?.message === 'string' ? failure.message : code, { cause: error }), { code });
  if (failure?.code === '23514' && typeof failure.hint === 'string' && GROUPING_REFUSALS.has(failure.hint)) {
    return coded(failure.hint);
  }
  if (failure?.code === '23503' && typeof failure.constraint_name === 'string') {
    const code = foreignKeys[failure.constraint_name];
    if (code !== undefined) return coded(code);
  }
  return error;
}

/**
 * Run a location or group write in a savepoint of its own (a transaction when there is none), and
 * map what PostgreSQL refuses (groupingRefusal). A failed statement leaves the caller's transaction
 * usable, and postgres.js reports the mapped error rather than the statement's.
 */
async function guardedWrite<T>(
  executor: StoreSql,
  write: (tx: TransactionSql) => Promise<T>,
  foreignKeys: Readonly<Record<string, string>> = {},
): Promise<T> {
  try {
    return await inTransaction(executor, write);
  } catch (error) {
    throw groupingRefusal(error, foreignKeys);
  }
}

/** A resource's location that the tenant does not have. */
const RESOURCE_LOCATION_MISSING = Object.freeze({ slotlock_resources_location_fkey: 'location_not_found' });

/** The nearest time zone a location, or one above it, has; null when none has one. */
async function locationTimezone(executor: StoreSql, tenantRef: string, location: string): Promise<string | null> {
  const [row] = await executor<{ timezone: string }[]>`
    WITH RECURSIVE up(ref, parent_ref, timezone, steps) AS (
      SELECT place.ref, place.parent_ref, place.timezone, 1 FROM slotlock.locations place
       WHERE place.tenant_ref = ${tenantRef} AND place.ref = ${location}
      UNION ALL
      SELECT place.ref, place.parent_ref, place.timezone, up.steps + 1
        FROM slotlock.locations place JOIN up ON place.tenant_ref = ${tenantRef} AND place.ref = up.parent_ref
       WHERE up.timezone IS NULL AND up.steps <= ${SLOTLOCK_MAX_LOCATION_DEPTH}
    )
    SELECT timezone FROM up WHERE timezone IS NOT NULL ORDER BY steps LIMIT 1`;
  return row?.timezone ?? null;
}

interface LocationRow {
  ref: string;
  name: string;
  parent_ref: string | null;
  timezone: string | null;
  resources: number;
}

const toLocation = (row: LocationRow): SlotlockLocation => ({
  ref: row.ref,
  name: row.name,
  parentRef: row.parent_ref,
  timezone: row.timezone,
  resources: Number(row.resources),
});

interface GroupRow {
  ref: string;
  name: string;
  description: string | null;
  members: number;
}

const toGroup = (row: GroupRow): SlotlockResourceGroup => ({
  ref: row.ref,
  name: row.name,
  description: row.description,
  members: Number(row.members),
});

/**
 * A checked profile change as statement parameters: each field's value (null when not given or
 * cleared) and whether it was given. Labels travel as one comma-joined string, which a label never
 * contains: postgres.js binds an array as text[] only once the pool knows the server's types.
 */
function profileParameters(change: SlotlockResourceProfileChange) {
  return {
    name: change.name ?? null,
    setName: change.name !== undefined,
    description: change.description ?? null,
    setDescription: change.description !== undefined,
    kind: change.kind ?? null,
    setKind: change.kind !== undefined,
    capacity: change.capacity ?? null,
    setCapacity: change.capacity !== undefined,
    labels: change.labels === undefined ? null : change.labels.join(','),
    setLabels: change.labels !== undefined,
    attributes: change.attributes === undefined ? null : JSON.stringify(change.attributes),
    setAttributes: change.attributes !== undefined,
  };
}

async function upsertResource(
  executor: StoreSql,
  params: {
    externalRef?: string;
    tenantRef?: string;
    timezone?: string;
    visibility?: SlotlockResource['visibility'];
    profile?: SlotlockResourceProfileChange;
    location?: string;
  },
): Promise<SlotlockResource> {
  type ResourceIdentityRow = ResourceRow;
  const visibility = params.visibility ?? 'shared';
  const asked = params.visibility ?? null;
  const profile = profileParameters(params.profile ?? {});
  let rows: ResourceIdentityRow[];
  // An existing identity keeps its visibility: re-creating with another is refused, so a private
  // one is never made shared. Its profile takes the fields given, and keeps the rest.
  if (params.tenantRef !== undefined && params.externalRef !== undefined) {
    rows = await executor<ResourceIdentityRow[]>`
      INSERT INTO slotlock.resources (
        external_ref, tenant_ref, timezone, visibility, name, description, kind, capacity, labels, attributes,
        location_ref
      )
      VALUES (
        ${params.externalRef}, ${params.tenantRef}, ${params.timezone ?? 'UTC'}, ${visibility},
        ${profile.name}::text, ${profile.description}::text, COALESCE(${profile.kind}::text, 'other'),
        ${profile.capacity}::integer,
        COALESCE(pg_catalog.string_to_array(${profile.labels}::text, ','), '{}'::text[]),
        COALESCE(${profile.attributes}::text::jsonb, '{}'::jsonb),
        ${params.location ?? null}::text
      )
      ON CONFLICT (tenant_ref, external_ref)
        WHERE tenant_ref IS NOT NULL AND external_ref IS NOT NULL
      DO UPDATE SET timezone = EXCLUDED.timezone,
        name = CASE WHEN ${profile.setName}::boolean THEN EXCLUDED.name ELSE slotlock.resources.name END,
        description = CASE WHEN ${profile.setDescription}::boolean THEN EXCLUDED.description
                           ELSE slotlock.resources.description END,
        kind = CASE WHEN ${profile.setKind}::boolean THEN EXCLUDED.kind ELSE slotlock.resources.kind END,
        capacity = CASE WHEN ${profile.setCapacity}::boolean THEN EXCLUDED.capacity ELSE slotlock.resources.capacity END,
        labels = CASE WHEN ${profile.setLabels}::boolean THEN EXCLUDED.labels ELSE slotlock.resources.labels END,
        attributes = CASE WHEN ${profile.setAttributes}::boolean THEN EXCLUDED.attributes
                          ELSE slotlock.resources.attributes END,
        location_ref = CASE WHEN ${params.location !== undefined}::boolean THEN EXCLUDED.location_ref
                            ELSE slotlock.resources.location_ref END
      WHERE ${asked}::text IS NULL OR slotlock.resources.visibility = ${asked}::text
      RETURNING ${executor.unsafe(RESOURCE_COLUMNS)}, ${executor.unsafe(EFFECTIVE_BOOKING_RULES)}`;
  } else if (params.externalRef !== undefined) {
    // A legacy resource (no tenant) has no profile.
    rows = await executor<ResourceIdentityRow[]>`
      INSERT INTO slotlock.resources (external_ref, tenant_ref, timezone, visibility)
      VALUES (${params.externalRef}, NULL, ${params.timezone ?? 'UTC'}, ${visibility})
      ON CONFLICT (external_ref)
        WHERE tenant_ref IS NULL AND external_ref IS NOT NULL
      DO UPDATE SET external_ref = EXCLUDED.external_ref
      WHERE ${asked}::text IS NULL OR slotlock.resources.visibility = ${asked}::text
      RETURNING ${executor.unsafe(RESOURCE_COLUMNS)}, ${executor.unsafe(EFFECTIVE_BOOKING_RULES)}`;
  } else {
    rows = await executor<ResourceIdentityRow[]>`
      INSERT INTO slotlock.resources (external_ref, tenant_ref, timezone, visibility)
      VALUES (NULL, NULL, ${params.timezone ?? 'UTC'}, ${visibility})
      RETURNING ${executor.unsafe(RESOURCE_COLUMNS)}, ${executor.unsafe(EFFECTIVE_BOOKING_RULES)}`;
  }
  const row = rows[0];
  if (!row) {
    throw Object.assign(new Error('Slotlock resource visibility cannot be changed by creating it'), {
      code: 'resource_visibility_conflict' as const,
    });
  }
  return toResource(row);
}

/**
 * Rematerialize one stored recurring master over rolledWindow: from its last expansion's cursor
 * when trustworthy, else its start. False when there is nothing to roll. A collision throws 23P01
 * and an over-budget rule CalendarExpansionLimitError; run it in a savepoint.
 */
async function rollStoredSeries(
  tx: TransactionSql,
  tenantRef: string,
  eventId: string,
  horizon: Interval,
): Promise<boolean> {
  const [row] = await tx<
    (CalendarEventRow & { ends_by_missing: boolean; buffer_after_ms: number; buffer_before_ms: number })[]
  >`
    SELECT id, tenant_ref, owner_ref, external_ref, resource_id, starts_at, ends_at, timezone,
           summary, description, location, status, transparency, organizer, attendees,
           reminders, recurrence_rule, recurrence_exceptions, materialized_starts_at,
           materialized_ends_at, recurrence_cursor, revision, source, created_at,
           updated_at, recurrence_ends_by IS NULL AS ends_by_missing, buffer_after_ms, buffer_before_ms
      FROM slotlock.calendar_events
     WHERE id = ${eventId} AND tenant_ref = ${tenantRef}
     FOR UPDATE`;
  if (!row || row.recurrence_rule === null) return false;
  const rolled = rolledWindow(
    { start: row.materialized_starts_at, end: row.materialized_ends_at },
    horizon,
  );
  if (!rolled) return false;
  const childMap = await loadCalendarEventChildren(tx, [row.id]);
  const event = toCalendarEvent(row, childMap.get(row.id));
  const { occurrences, cursor } = expandCalendarEventSeries(event, rolled, {
    cursor: row.recurrence_cursor ?? null,
    stored: true,
  });
  await replaceCalendarEventOccurrences(tx, {
    tenantRef,
    eventId: row.id,
    resourceId: row.resource_id,
    event,
    occurrences,
    revision: Number(row.revision),
    bufferAfterMs: Number(row.buffer_after_ms ?? 0),
    bufferBeforeMs: Number(row.buffer_before_ms ?? 0),
  });
  // A series stored before 0.3 learns when it ends at its first roll.
  const endsBy = row.ends_by_missing ? recurrenceEndsByColumn(event) : null;
  await tx`
    UPDATE slotlock.calendar_events
       SET materialized_starts_at = ${rolled.start},
           materialized_ends_at = ${rolled.end},
           recurrence_cursor = ${seriesCursorJson(tx, cursor)},
           recurrence_ends_by = COALESCE(recurrence_ends_by, ${endsBy}::text::timestamptz),
           roll_retry_at = NULL
     WHERE id = ${row.id} AND tenant_ref = ${tenantRef}`;
  return true;
}

/**
 * Work out and store when a series stored before 0.3 ends, as its next roll would; its occurrences
 * are left as they are.
 */
async function learnSeriesEnd(tx: TransactionSql, tenantRef: string, eventId: string): Promise<void> {
  const [row] = await tx<CalendarEventRow[]>`
    SELECT id, tenant_ref, owner_ref, external_ref, resource_id, starts_at, ends_at, timezone,
           summary, description, location, status, transparency, organizer, attendees,
           reminders, recurrence_rule, recurrence_exceptions, materialized_starts_at,
           materialized_ends_at, recurrence_cursor, revision, source, created_at,
           updated_at
      FROM slotlock.calendar_events
     WHERE id = ${eventId} AND tenant_ref = ${tenantRef}
       AND recurrence_rule IS NOT NULL AND recurrence_ends_by IS NULL
     FOR UPDATE`;
  if (!row) return;
  const childMap = await loadCalendarEventChildren(tx, [row.id]);
  const event = toCalendarEvent(row, childMap.get(row.id));
  await tx`
    UPDATE slotlock.calendar_events
       SET recurrence_ends_by = ${recurrenceEndsByColumn(event)}::text::timestamptz
     WHERE id = ${row.id} AND tenant_ref = ${tenantRef} AND recurrence_ends_by IS NULL`;
}

async function deferRoll(executor: StoreSql, tenantRef: string, eventId: string): Promise<void> {
  await executor`
    UPDATE slotlock.calendar_events
       SET roll_retry_at = now() + interval '1 hour'
     WHERE id = ${eventId} AND tenant_ref = ${tenantRef}`;
}

/**
 * Whether every opaque recurring series on the resource (but `exceptEventId`) is stored over the
 * part of [start, end) a roll can reach. A write must not land where a series is not stored yet, or
 * the series' next roll would collide with it. A series behind is first rolled to the horizon in a
 * savepoint, so the write meets its occurrences under the exclusion arbiter; false when one cannot
 * be. Series roll in id order; a deadlock with a concurrent writer is broken by the database
 * (retried once, then an overlap).
 */
async function recurrenceCoversWrite(
  tx: TransactionSql,
  params: {
    tenantRef: string;
    resourceId: string;
    start: Date;
    end: Date;
    exceptEventId?: string;
  },
): Promise<boolean> {
  const horizon = calendarEventRollingHorizon();
  if (params.end <= horizon.start) return true;
  const from = params.start > horizon.start ? params.start : horizon.start;
  // LEAST and GREATEST ignore NULL arguments (PostgreSQL 16): a series with no known end is behind
  // wherever it is stored short of the write's end.
  const behind = () => tx<{ id: string; ends_by_unknown: boolean; ends_in_horizon: boolean }[]>`
    SELECT event.id, event.recurrence_ends_by IS NULL AS ends_by_unknown,
           COALESCE(event.recurrence_ends_by <= ${horizon.end}::timestamptz, false)
             AS ends_in_horizon
      FROM slotlock.calendar_events event
     WHERE event.tenant_ref = ${params.tenantRef}
       AND event.resource_id = ${params.resourceId}
       AND event.recurrence_rule IS NOT NULL
       AND event.transparency = 'opaque'
       AND event.id IS DISTINCT FROM ${params.exceptEventId ?? null}::uuid
       AND (event.recurrence_ends_by IS NULL OR event.recurrence_ends_by > ${from}::timestamptz)
       AND (
         event.materialized_ends_at < LEAST(${params.end}::timestamptz, event.recurrence_ends_by)
         OR event.materialized_starts_at > GREATEST(
              ${from}::timestamptz,
              LEAST(event.starts_at, COALESCE((
                SELECT min(exception.starts_at)
                  FROM slotlock.calendar_event_exceptions exception
                 WHERE exception.tenant_ref = event.tenant_ref
                   AND exception.event_id = event.id
                   AND exception.cancelled = false
              ), event.starts_at))
            )
       )
     ORDER BY event.id`;
  let due = await behind();
  if (due.length === 0) return true;
  if (params.end > horizon.end) {
    // A series stored before 0.3 works out its end now, and is left out if it ends before the write
    // or is stored through its end.
    if (due.some((row) => row.ends_by_unknown)) {
      for (const { id, ends_by_unknown } of due) {
        if (ends_by_unknown) await learnSeriesEnd(tx, params.tenantRef, id);
      }
      due = await behind();
      if (due.length === 0) return true;
    }
    if (due.some((row) => !row.ends_in_horizon)) return false;
  }
  for (const { id } of due) {
    try {
      await tx.savepoint((sp) => rollStoredSeries(sp, params.tenantRef, id, horizon));
    } catch (error) {
      if (error instanceof CalendarExpansionLimitError || pgCode(error) === EXCLUSION_VIOLATION) {
        return false;
      }
      throw error;
    }
  }
  return (await behind()).length === 0;
}

/**
 * Whether an event already occupies all the time `occurrences` would: such a write (a rename) takes
 * no time a series could later need.
 */
async function holdsEveryOccurrence(
  tx: TransactionSql,
  eventId: string,
  resourceId: string,
  occurrences: readonly CalendarEventOccurrence[],
): Promise<boolean> {
  const held = await tx<{ start: Date; end: Date }[]>`
    SELECT reservation.starts_at AS start, reservation.ends_at AS end
      FROM slotlock.calendar_event_occurrences occurrence
      JOIN slotlock.reservations reservation ON reservation.id = occurrence.reservation_id
     WHERE occurrence.event_id = ${eventId}
       AND reservation.resource_id = ${resourceId}`;
  return occurrences.every((occurrence) =>
    held.some(({ start, end }) => start <= occurrence.start && occurrence.end <= end),
  );
}

function occurrenceSpan(occurrences: readonly CalendarEventOccurrence[]): Interval | null {
  const [first] = occurrences;
  if (!first) return null;
  let start = first.start;
  let end = first.end;
  for (const occurrence of occurrences) {
    if (occurrence.start < start) start = occurrence.start;
    if (occurrence.end > end) end = occurrence.end;
  }
  return { start, end };
}

/**
 * After a write lost to the exclusion arbiter: roll, in a transaction of its own, the series the
 * write's transaction rolled and lost, so the loss can name the blocking occurrence. Upkeep only:
 * on failure, maintenance rolls them later.
 */
async function rollSeriesBehind(
  executor: StoreSql,
  resourceId: string,
  start: Date,
  end: Date,
  exceptEventId?: string,
): Promise<void> {
  try {
    await inTransaction(executor, async (tx) => {
      const [resource] = await tx<{ tenant_ref: string | null }[]>`
        SELECT tenant_ref FROM slotlock.resources WHERE id = ${resourceId}`;
      if (!resource?.tenant_ref) return;
      await recurrenceCoversWrite(tx, {
        tenantRef: resource.tenant_ref,
        resourceId,
        start,
        end,
        ...(exceptEventId !== undefined ? { exceptEventId } : {}),
      });
    });
  } catch {
    // Rolled back whole (its own transaction, or a savepoint of the caller's).
  }
}

export interface SlotlockStore extends SlotlockEventFeed {
  /**
   * Apply the Slotlock DDL (idempotent). Refuses (`unsafe_slotlock_schema`, with `reasons`) a
   * `slotlock` schema that another role (superusers aside) owns, can create objects in, owns an
   * object in, or can add triggers to; ownership through a group role counts, so deploy as the
   * owning role itself (`SET ROLE`). Refuses (`schema_newer`) a schema a newer release migrated. An
   * unchanged schema is left without locking any table. Constraints added NOT VALID are validated
   * in a second transaction; one old rows still break stays NOT VALID and is retried on each
   * migration. Each lock wait is bounded by `lockTimeoutMs` and retried (`schema_lock_timeout` once
   * out of attempts).
   */
  applySchema(options?: SlotlockMigrationOptions): Promise<void>;
  /**
   * Atomically enable forced tenant RLS using the store's context setting. Refuses the same schemas
   * as `applySchema()`. Tables already set up exactly so are left without a lock.
   */
  applyTenantRls(options?: { allowRebind?: boolean } & SlotlockMigrationOptions): Promise<void>;
  /**
   * Grant an existing application role exactly what the store needs at runtime: USAGE on the
   * `slotlock` schema and DML on its tables. Run as the deployment role after every
   * `applySchema()`. Refuses (`unsafe_application_role`, with `reasons`) a role with a known way
   * around forced RLS or the exclusion arbiter, directly, by membership or through PUBLIC
   * (SECURITY.md lists the checks and what they do not cover). The check runs only at grant time.
   */
  grantApplicationRole(role: string, options?: SlotlockMigrationOptions): Promise<void>;
  /**
   * Run store operations with one transaction-local tenant context on the same connection. On a
   * client it opens a READ COMMITTED transaction. Inside a caller's transaction of another level,
   * writes are refused (`invalid_transaction_isolation`), since that snapshot can miss a
   * suspension. Needs EXECUTE on slotlock.tenant_suspended(text) (`application_role_not_granted`
   * without it; grantApplicationRole grants it). With `maxTenantTransactions`, an aborted `signal`
   * removes a waiting call from the line.
   */
  withTenant<T>(
    tenantRef: string,
    callback: (store: SlotlockTenantStore) => Promise<T>,
    options?: {
      isolation?: 'read committed';
      signal?: AbortSignal;
      /**
       * Who is making these changes (an API key's id, an agent's subject), 1-200 characters
       * without control characters: the history (listHistory) records it with each change.
       */
      actor?: string;
      /**
       * Where the changes come from (SLOTLOCK_CHANGE_ORIGINS: `mcp`, `rest`, `dashboard`, ...),
       * recorded with each beside the actor. Unset, the enclosing withTenant's, else `library`.
       */
      origin?: SlotlockChangeOrigin;
      /** The id (a UUID) of the API key making these changes, recorded with each. */
      keyId?: string;
      /**
       * A key limited to part of its tenant (RFC 0003 G6): the transaction reaches only the
       * resources at these locations (each with every location in it) or in these groups, as they
       * are when it starts, by the database's resource_scope_v1 policies, on every table keyed by
       * resource, for reads and writes. A resource outside it is not found.
       */
      resourceScope?: SlotlockResourceScope;
    },
  ): Promise<T>;
  /**
   * INVARIANT (erasure completeness): a tenant integration must use a stable, erasable business
   * identifier for externalRef and include this schema in its own data-erasure workflow.
   *
   * With `maxTenantResources` (1-100,000) or the store's `resources` limit (the lower applies), a
   * new resource is refused (`resource_limit_reached`) once the tenant has that many; an existing
   * `externalRef` is still updated. Capped creates serialize on a database lock, so racing servers
   * stop at the cap; this needs READ COMMITTED (`invalid_transaction_isolation` inside another
   * level).
   */
  createResource(params: {
    externalRef?: string;
    tenantRef?: string;
    timezone?: string;
    maxTenantResources?: number;
    /**
     * `shared` (the default) or `private`, which agents never see. Fixed at creation: creating an
     * existing reference again with none named returns it as it is, and with another visibility is
     * refused (`resource_visibility_conflict`).
     */
    visibility?: SlotlockResource['visibility'];
    /**
     * Its profile (resource-profile.ts): name, description, kind, capacity, labels and attributes,
     * each optional. Creating an existing reference again sets the fields given and keeps the rest.
     * Refused (`invalid_resource_profile`) outside its bounds, or for a resource with no tenant.
     */
    profile?: SlotlockResourceProfileInput;
    /**
     * The reference of the location it is at (`location_not_found` when the tenant has none such).
     * Without a `timezone`, a new resource takes the nearest time zone its location, or one above
     * it, has, else UTC.
     */
    location?: string;
  }): Promise<SlotlockResource>;
  /**
   * Change one of the tenant's resources' profile: the fields given, keeping the rest (`null`
   * clears a name, description or capacity). Null for an id that is not the tenant's; refused
   * (`invalid_resource_profile`) outside its bounds. The feed's `resource.updated` names the
   * fields that changed (`profile_changed`), never their values.
   */
  updateResourceProfile(params: {
    tenantRef: string;
    id: string;
    profile: SlotlockResourceProfileInput;
    /** Move it to this location, or to none (`null`); left out, it stays (`location_not_found`). */
    location?: string | null;
  }): Promise<SlotlockResource | null>;
  /**
   * The tenant's locations, each under its parent, depth first (RFC 0003 G2), with how many
   * resources are at each.
   */
  listLocations(params: { tenantRef: string }): Promise<SlotlockLocation[]>;
  /**
   * Create the location with this reference, or change its name, and the parent and time zone
   * given. Refused: `invalid_location` (naming the field), `location_not_found` (no such parent),
   * `location_too_deep` (past SLOTLOCK_MAX_LOCATION_DEPTH levels), `location_cycle` (under itself),
   * `location_limit_reached` (SLOTLOCK_MAX_LOCATIONS).
   */
  putLocation(params: {
    tenantRef: string;
    ref: string;
    name: string;
    parentRef?: string | null;
    timezone?: string | null;
  }): Promise<SlotlockLocation>;
  /** Change a location's name, parent or time zone, as putLocation; null when it has none such. */
  updateLocation(params: {
    tenantRef: string;
    ref: string;
    name?: string;
    parentRef?: string | null;
    timezone?: string | null;
  }): Promise<SlotlockLocation | null>;
  /**
   * Delete a location: false when it has none such; refused (`location_in_use`) while a resource is
   * at it or a location is under it.
   */
  deleteLocation(params: { tenantRef: string; ref: string }): Promise<boolean>;
  /** The tenant's groups (RFC 0003 G3), by reference, with how many resources are in each. */
  listGroups(params: { tenantRef: string }): Promise<SlotlockResourceGroup[]>;
  /**
   * Create the group with this reference, or change its name, and its description when given.
   * Refused: `invalid_group` (naming the field), `group_limit_reached` (SLOTLOCK_MAX_RESOURCE_GROUPS).
   */
  putGroup(params: {
    tenantRef: string;
    ref: string;
    name: string;
    description?: string | null;
  }): Promise<SlotlockResourceGroup>;
  /** Delete a group, its resources left as they are: false when it has none such. */
  deleteGroup(params: { tenantRef: string; ref: string }): Promise<boolean>;
  /**
   * Put one of the tenant's resources in a group: true when it was not in it. Refused:
   * `group_not_found`, `resource_not_found`, `resource_group_limit_reached`
   * (SLOTLOCK_MAX_GROUPS_PER_RESOURCE).
   */
  addGroupMember(params: { tenantRef: string; group: string; resourceId: string }): Promise<boolean>;
  /** Take a resource out of a group: true when it was in it. */
  removeGroupMember(params: { tenantRef: string; group: string; resourceId: string }): Promise<boolean>;
  /**
   * Resolve one tenant-owned resource without revealing another tenant's matching id. An archived
   * one is returned (with `archivedAt`); with `visibility`, only one of that visibility.
   */
  getResource(params: {
    tenantRef: string;
    id: string;
    visibility?: SlotlockResource['visibility'];
  }): Promise<SlotlockResource | null>;
  /**
   * Archive one of the tenant's resources: no list shows it and it takes no new booking, hold or
   * event (`resource_archived`), while what is on it stays and can still be cancelled or released.
   * Archiving it again keeps the first time. Null for an id that is not the tenant's.
   */
  archiveResource(params: { tenantRef: string; id: string }): Promise<SlotlockResource | null>;
  /** Put an archived resource back in use. Null for an id that is not the tenant's. */
  restoreResource(params: { tenantRef: string; id: string }): Promise<SlotlockResource | null>;
  /**
   * Delete one of the tenant's resources with its history (its past bookings, coverage and the
   * occupation of cancelled events), freeing its place under the resource cap. Refused
   * (`resource_in_use`) while a booking on it has not ended, a hold on it is live, or a calendar
   * event (one-off not yet over, or recurring) is on it: cancel or move those first.
   */
  deleteResource(params: { tenantRef: string; id: string }): Promise<DeleteResourceResult>;
  /**
   * Set one resource's own weekly bookable hours, or clear them (`null`) so it uses the default;
   * `[]` makes it never bookable. Null for an id that is not the tenant's. Refuses rules Slotlock
   * cannot evaluate (`invalid_availability`): at most 50, each weekly with BYDAY.
   */
  setResourceAvailability(params: {
    tenantRef: string;
    id: string;
    rules: readonly WeeklyAvailabilityRule[] | null;
  }): Promise<SlotlockResource | null>;
  /**
   * Set one resource's booking rules (`SlotlockBookingRules`), or clear them (`null`). They apply to
   * bookings made from then on: holds, reservations, moves, and events written with
   * `enforceBookingRules`. Null for an id that is not the tenant's. Refuses rules outside their
   * bounds (`invalid_booking_rules`).
   */
  setResourceBookingRules(params: {
    tenantRef: string;
    id: string;
    rules: SlotlockBookingRules | null;
  }): Promise<SlotlockResource | null>;
  /**
   * Set (or clear, with `null`) the tenant's default booking rules, or one pool's (`pool`): a
   * resource's rules as they apply (`effectiveBookingRules`) are the tenant's, overlaid by its
   * pool's, overlaid by its own, a field set at a narrower level winning. They apply to bookings made
   * from then on. `checkInMinutes` is only a resource's own (`invalid_booking_rules`, as for rules
   * outside their bounds); `pool` is a pool name (`invalid_pool`). At most
   * SLOTLOCK_MAX_POOL_RULE_DEFAULTS pools a tenant have them (`pool_rules_limit_reached` for one
   * more). Returns the rules stored.
   */
  setBookingRuleDefaults(params: {
    tenantRef: string;
    pool: string | null;
    rules: SlotlockBookingRules | null;
  }): Promise<SlotlockBookingRules | null>;
  /** The tenant's default booking rules, and each pool's that has them, by pool name. */
  getBookingRuleDefaults(params: { tenantRef: string }): Promise<SlotlockBookingRuleDefaults>;
  /**
   * Put one resource in a pool, or take it out (`null`): `pool` is 1-100 characters of a-z, 0-9,
   * `.`, `_` and `-`, starting with a letter or digit (`invalid_pool` otherwise). A resource is in
   * one pool at most. Null for an id that is not the tenant's.
   */
  setResourcePool(params: {
    tenantRef: string;
    id: string;
    pool: string | null;
  }): Promise<SlotlockResource | null>;
  /**
   * The members of one of the tenant's pools that may be booked, in the order a pool booking tries
   * them (by id): archived ones left out, and with `visibility: 'shared'` private ones too.
   */
  listPoolMembers(params: {
    tenantRef: string;
    pool: string;
    visibility?: 'shared';
    /** In the pool's order (`setPoolOrder`) rather than by id. */
    ordered?: boolean;
    /**
     * For a booking about to take one (with `ordered`): a round-robin pool's place is locked until
     * the transaction ends, so bookings at once go round in turn instead of starting from one place.
     */
    forBooking?: boolean;
  }): Promise<SlotlockResource[]>;
  /**
   * The tenant's pools by name, with how many members each has that may be booked (its capacity)
   * and the order a pool booking tries them in.
   */
  listPools(params: {
    tenantRef: string;
    visibility?: 'shared';
  }): Promise<{ pool: string; capacity: number; order: SlotlockPoolOrder }[]>;
  /**
   * Set the order a pool booking tries a pool's members in (RFC 0003 G7): `stable` (by id, the
   * default), `least_booked` or `round_robin`: `invalid_pool` for a name that is not a pool's,
   * `invalid_pool_order` for an order that is not one of these, `pool_order_limit_reached` past
   * SLOTLOCK_MAX_POOL_SETTINGS pools a tenant.
   */
  setPoolOrder(params: { tenantRef: string; pool: string; order: SlotlockPoolOrder }): Promise<SlotlockPoolOrder>;
  /**
   * Make a resource a part of another (RFC 0003 G8), or no part (`null`): a booking of the whole
   * then conflicts with every part, two parts never with each other. Null for no such resource;
   * `parent_not_found`, `composite_too_deep` (one level only), `composite_parts_limit`
   * (SLOTLOCK_MAX_COMPOSITE_PARTS) and `composite_busy` (either side has a booking or live hold to
   * come) refuse it.
   */
  setResourceParent(params: { tenantRef: string; id: string; parentId: string | null }): Promise<SlotlockResource | null>;
  /** Note the member a pool booking took, from which `round_robin` goes on. */
  notePoolBooking(params: { tenantRef: string; pool: string; resourceId: string }): Promise<void>;
  /** Set (or clear, with `null`) the bookable hours of every resource the tenant has; returns how many. */
  setTenantAvailability(params: {
    tenantRef: string;
    rules: readonly WeeklyAvailabilityRule[] | null;
  }): Promise<number>;
  /** Bounded tenant resource discovery, ordered and keyset-paginated by immutable UUID. */
  listResources(params: {
    tenantRef: string;
    limit?: number;
    after?: string;
    /** Only resources of this visibility; omitted, both. */
    visibility?: SlotlockResource['visibility'];
    /** Archived resources too; omitted, only those in use. */
    includeArchived?: boolean;
    /** Only resources of this kind (`other` for those that say none). */
    kind?: SlotlockResourceKind;
    /** Only resources with every one of these labels (at most 20). */
    labels?: readonly string[];
    /** Only resources at this location or a location under it. */
    location?: string;
    /** Only resources in this group. */
    group?: string;
    /** Only this pool's members. */
    pool?: string;
  }): Promise<SlotlockResource[]>;
  /**
   * How many resources the tenant has, archived ones included: the count a resource limit (a hosted
   * plan's, `maxTenantResources`) is checked against.
   */
  countResources(params: { tenantRef: string }): Promise<number>;
  /**
   * Roll the tenant's committed bookings and holds up from its feed into its daily usage
   * (usage.ts, `slotlock.roll_up_usage`), up to `limit` changes (1-100,000, default 5,000): how
   * many it read. Fewer than `limit` means it has caught up.
   */
  rollUpUsage(params: { tenantRef: string; limit?: number }): Promise<number>;
  /**
   * The tenant's usage from `from` to `to`, UTC days `YYYY-MM-DD` inclusive, at most
   * SLOTLOCK_USAGE_RETENTION_DAYS apart (usage.ts, `slotlock.tenant_usage`): empty unless the
   * deployment meters it.
   */
  readUsage(params: { tenantRef: string; from: string; to: string }): Promise<SlotlockUsageRow[]>;
  /**
   * Insert a confirmed reservation with the EXCLUDE constraint as the overlap arbiter; expected
   * outcomes (invalid window, lost race) come back structured. Expired holds overlapping the window
   * are reaped in the same transaction, so they never block. On a tenant's resource the booking
   * takes the tenant and its own id as reference. With `tenantRef`, only that tenant's resource
   * (`resource_not_found` otherwise, whatever the connection's RLS).
   */
  createReservation(params: {
    resourceId: string;
    start: Date;
    end: Date;
    source?: string;
    tenantRef?: string;
  }): Promise<CreateReservationResult>;
  /**
   * Idempotently create a tenant-owned booking reservation by its stable business identity. The
   * rows a calendar event occupies are not bookings: here, in reschedule and in cancel their
   * references answer as references no booking holds.
   */
  createExternalReservation(params: ExternalReservationCommand): Promise<ExternalReservationResult>;
  /** Atomically move an existing tenant-owned booking; a conflict leaves its old range intact. */
  rescheduleExternalReservation(
    params: ExternalReservationCommand,
  ): Promise<ExternalReservationResult>;
  /** Idempotently cancel a booking without exposing whether another tenant owns the key. */
  cancelExternalReservation(params: {
    tenantRef: string;
    externalRef: string;
    revision: number;
  }): Promise<CancelExternalReservationResult>;
  /**
   * Occupy a window without committing: the hold blocks rivals under the same EXCLUDE arbiter until
   * `expiresAt` (database clock: statement time + ttl), then frees via lazy reap. With `tenantRef`,
   * only that tenant's resource (`resource_not_found` otherwise, whatever the connection's RLS).
   */
  acquireHold(params: {
    resourceId: string;
    start: Date;
    end: Date;
    ttlMs: number;
    source?: string;
    tenantRef?: string;
    /** Turnaround kept busy after `end`, 0 to 30 days; the confirmed booking keeps it. */
    bufferAfterMs?: number;
    /**
     * A retry identity, 1-500 UTF-8 bytes, unique within `tenantRef` and `principalRef` (both
     * required): the same key and body answer the first hold (`idempotent: true`); another body is
     * `idempotency_conflict`. Kept until the hold would have expired, released or confirmed.
     */
    idempotencyKey?: string;
    /** Whose keys `idempotencyKey` is among, 1-500 UTF-8 bytes (an API key's subject, say). */
    principalRef?: string;
    /**
     * Who the hold belongs to, 1-500 UTF-8 bytes, within `tenantRef` (required): `releaseHold` and
     * `fromHold` with a `holderRef` take only their own, and a holder may have `maxHoldsPerHolder`
     * live at once (and `maxHeldHoursPerHolder` together, when set). Without it the hold has no
     * holder and no cap.
     */
    holderRef?: string;
    /**
     * Lower the holder's caps for this hold (an API key's own limits, RFC 0004 A5): never above
     * `maxHoldsPerHolder` and `maxHeldHoursPerHolder`, which win where they are lower.
     */
    holderCaps?: { maxHolds?: number; maxHeldHours?: number };
    /**
     * Holds taken as alternatives for one booking share a group (a UUID): booking one with
     * `fromHold` releases the rest, and releasing one with a holder releases them all.
     */
    groupId?: string;
  }): Promise<AcquireHoldResult>;
  /** One of the tenant's live holds, or null (none, expired, confirmed, or another tenant's). */
  getHold(params: { tenantRef: string; holdId: string }): Promise<SlotlockHold | null>;
  /**
   * One holder's own hold by id, lapsed or live (`live`), so a confirm can say `hold_expired`
   * rather than not found. Null when it is gone, booked, or another holder's.
   */
  getHolderHold(params: {
    tenantRef: string;
    holdId: string;
    holderRef: string;
  }): Promise<{ hold: SlotlockHold; live: boolean } | null>;
  /** The tenant's live holds on one resource, by start then id, keyset-paginated like events. */
  listHolds(params: {
    tenantRef: string;
    resourceId: string;
    limit?: number;
    after?: { start: Date; id: string };
  }): Promise<SlotlockHold[]>;
  /**
   * What occupies the tenant's resources in `window` (at most 367 days), every resource at once, by
   * start then id: bookings, calendar events' occurrences and live holds, up to `limit` (1-1000,
   * default 100). An agenda for people to read; listReservations, listCalendarEvents and listHolds
   * page through each.
   */
  listAgenda(params: { tenantRef: string; window: Interval; limit?: number }): Promise<SlotlockAgendaEntry[]>;
  /**
   * The tenant's booking with this reference as it now is (its current revision), or null: none,
   * cancelled, or a calendar event's occupation, which is not a booking.
   */
  getReservation(params: { tenantRef: string; externalRef: string }): Promise<SlotlockReservation | null>;
  /**
   * Any booking, hold or event occurrence of the tenant's by its row id (the id a refused write's
   * `conflictingReservationId` names): the time it occupies, buffers included, and whose it is.
   * Null when the tenant has none, or the transaction's key may not see it.
   */
  describeBooking(params: { tenantRef: string; id: string }): Promise<SlotlockBookingDescription | null>;
  /**
   * The time an owner's calendar events occupy now, buffers included, one row per occupation: what
   * an approval (RFC 0004 A4) holds for a write, read in the write's own rolled-back transaction.
   */
  eventOccupancy(params: {
    tenantRef: string;
    ownerRef: string;
    externalRefs: readonly string[];
  }): Promise<{ resourceId: string; start: Date; end: Date; recurring: boolean }[]>;
  /** Create or replace an approval policy; null when the tenant has its 50 already. */
  putApprovalPolicy(params: PutApprovalPolicyParams): Promise<SlotlockApprovalPolicy | null>;
  listApprovalPolicies(params: { tenantRef: string }): Promise<SlotlockApprovalPolicy[]>;
  deleteApprovalPolicy(params: { tenantRef: string; ref: string }): Promise<{ deleted: boolean }>;
  /** The tenant's policies that apply to any of these resources (by id, pool, location, group, or all). */
  approvalPoliciesFor(params: { tenantRef: string; resourceIds: readonly string[] }): Promise<SlotlockApprovalPolicy[]>;
  /**
   * A write waiting for a person: its time held by holds the approval owns, until `expiresAt`, and
   * the request kept to run as its requester when granted. A retry with the same `requestKey`
   * answers the same approval (`replayed`), or `idempotency_conflict` for another request. With
   * `consumeHold`, the requester's own hold of that time gives way to the approval's in the same
   * transaction. `overlap` when the time is taken; `approval_limit_reached` past the pending caps.
   */
  requestApproval(params: {
    tenantRef: string;
    policyRef: string;
    operation: SlotlockApproval['operation'];
    request: Record<string, unknown>;
    requester: Record<string, unknown>;
    requesterRef: string;
    requestKey: string;
    holds: readonly { resourceId: string; start: Date; end: Date }[];
    start: Date;
    end: Date;
    expiresAt: Date;
    consumeHold?: { holdId: string; holderRef: string };
  }): Promise<
    | { ok: true; approval: SlotlockApproval; replayed: boolean }
    | { ok: false; code: 'overlap' | 'approval_limit_reached' | 'idempotency_conflict'; limit?: number }
  >;
  /** The approval a request key made, or null. */
  findApproval(params: { tenantRef: string; requestKey: string }): Promise<SlotlockApproval | null>;
  getApproval(params: {
    tenantRef: string;
    id: string;
  }): Promise<(SlotlockApproval & { requester: Record<string, unknown> }) | null>;
  listApprovals(params: {
    tenantRef: string;
    status?: SlotlockApproval['status'];
    limit?: number;
  }): Promise<SlotlockApproval[]>;
  /**
   * Lock a pending, unexpired approval and let its holds go, so its write can take their time in
   * the same transaction; finishApprovalGrant then marks it granted.
   */
  beginApprovalGrant(params: {
    tenantRef: string;
    id: string;
  }): Promise<
    | { ok: true; approval: SlotlockApproval }
    | { ok: false; code: 'approval_not_found' | 'approval_not_pending' | 'approval_expired' }
  >;
  finishApprovalGrant(params: { tenantRef: string; id: string; decidedBy: string }): Promise<SlotlockApproval>;
  declineApproval(params: {
    tenantRef: string;
    id: string;
    decidedBy: string;
    reason?: string;
  }): Promise<
    | { ok: true; approval: SlotlockApproval }
    | { ok: false; code: 'approval_not_found' | 'approval_not_pending' | 'approval_expired' }
  >;
  /** Maintenance: up to `limit` pending approvals past their wait expire and free their time. */
  expireApprovals(params: { tenantRef: string; limit?: number }): Promise<{ expired: number }>;
  /**
   * Empty a test environment (RFC 0004 A6): its resources, locations, groups, bookings, events,
   * holds, waitlist, approval policies and feed; its keys, webhooks, plan and usage stay. Refused
   * (`sandbox_test_only`) for a tenant that is not a test environment (`~test`). Rows removed, by
   * table.
   */
  resetTestTenant(params: { tenantRef: string }): Promise<Record<string, number>>;
  /**
   * In a test environment, make what would lapse within `minutes` lapse now (RFC 0004 A6): holds
   * (a waitlist offer's and an approval's among them) and pending approvals. Maintenance then
   * reaps them as it would have. Refused (`sandbox_test_only`) elsewhere.
   */
  fastForwardTestTenant(params: { tenantRef: string; minutes: number }): Promise<{ holds: number; approvals: number }>;
  /**
   * The tenant's bookings on one resource whose occupied time meets `window` (at most 367 days),
   * by start then id, keyset-paginated: pass the last one's `{ start, id }` as `after`.
   */
  listReservations(params: {
    tenantRef: string;
    resourceId: string;
    window: Interval;
    limit?: number;
    after?: { start: Date; id: string };
  }): Promise<SlotlockReservation[]>;
  /**
   * Turn an unexpired hold into a confirmed booking. On a tenant's resource the booking takes the
   * tenant and the hold's id as reference at revision 1 (`reservation_cancelled` when a cancel of
   * that reference came first). Confirming again answers the booking as it now is. With
   * `tenantRef`, another tenant's hold is `hold_not_found` whatever the connection's RLS.
   */
  confirmHold(holdId: string, options?: SlotlockHoldTenantOptions): Promise<ConfirmHoldResult>;
  /**
   * Delete a live hold; released=false when it was already gone (expired-reaped or confirmed). With
   * `tenantRef`, only a hold on one of that tenant's resources, as for confirmHold.
   */
  releaseHold(
    holdId: string,
    options?: SlotlockHoldTenantOptions & {
      /**
       * Only a hold this holder took (`acquireHold`'s `holderRef`), with the rest of its group:
       * released=false for another holder's.
       */
      holderRef?: string;
    },
  ): Promise<ReleaseHoldResult>;
  /**
   * Reservations overlapping `window` for one resource, as merged-ready half-open intervals. With
   * `tenantRef`, only a resource of that tenant (`resource_not_found` otherwise, whatever the
   * connection's row-level security). An id the store never issues is `invalid_identity`. With
   * `limit`, at most that many, the first by start.
   */
  listBusy(
    resourceId: string,
    window: Interval,
    options?: { tenantRef?: string; limit?: number },
  ): Promise<Interval[]>;
  /** Create or revise one trusted event under expected-revision + tenant idempotency guards. */
  putCalendarEvent(params: PutCalendarEventCommand): Promise<PutCalendarEventResult>;
  /** Read one active event. A cancelled/tombstoned identity reads as absent. */
  getCalendarEvent(params: {
    tenantRef: string;
    /** Defaults to the trusted `internal` namespace. */
    ownerRef?: string;
    externalRef: string;
  }): Promise<SlotlockCalendarEvent | null>;
  /**
   * One of the tenant's active events by id, whichever owner (the tenant itself or an agent key)
   * wrote it: null when there is none, it was cancelled, or it is another tenant's.
   */
  getCalendarEventById(params: { tenantRef: string; eventId: string }): Promise<SlotlockCalendarEvent | null>;
  /** List active events with at least one materialized occurrence intersecting the window. */
  listCalendarEvents(params: {
    tenantRef: string;
    /** Defaults to the trusted `internal` namespace. */
    ownerRef?: string;
    /**
     * Every owner's events, each with its `ownerRef`, so a tenant reaches what any of its keys
     * booked, a revoked one's included. Not with `ownerRef`.
     */
    allOwners?: boolean;
    resourceId: string;
    window: Interval;
    limit?: number;
    /** Stable keyset cursor from the final event in the previous page. */
    after?: { start: Date; id: string };
  }): Promise<SlotlockCalendarEvent[]>;
  /** Expected-revision cancellation removes all derived reservations and leaves a tombstone. */
  cancelCalendarEvent(params: {
    tenantRef: string;
    /** Defaults to the trusted `internal` namespace. */
    ownerRef?: string;
    externalRef: string;
    idempotencyKey: string;
    expectedRevision: number;
    /**
     * The resource the writer read the event on: `event_not_found` when the stored event is on
     * another, checked under the event's lock.
     */
    expectedResourceId?: string;
  }): Promise<CancelCalendarEventResult>;
  /**
   * The tenant's cancellation of one of its events by id, whichever owner wrote it: an agent key's
   * included, after the key is revoked and when it has spent its command quota. The event's
   * identity is cancelled (its tombstone is its owner's, so that key cannot re-create it), and the
   * command is the tenant's own: its idempotency key is in the trusted `internal` namespace, where
   * it replays. A cancelled event, an unknown id or another tenant's is `event_not_found`.
   */
  cancelCalendarEventById(params: {
    tenantRef: string;
    eventId: string;
    idempotencyKey: string;
    expectedRevision: number;
    /** As for cancelCalendarEvent: `event_not_found` when the event is on another resource. */
    expectedResourceId?: string;
  }): Promise<CancelCalendarEventResult>;
  /**
   * Rematerialize due recurring masters into one rolling window without changing their revision. A
   * collision rolls back that master and keeps its old coverage. A master is rolled from the
   * window's start through the later of its stored end and the window's; one already covering the
   * window, or too far past it for the 367-day cap, is not due and not counted.
   */
  rollCalendarEventHorizon(params: {
    tenantRef: string;
    window: Interval;
    limit?: number;
    /** The previous batch's `next`: examine only the masters after it in this pass. */
    after?: CalendarHorizonRollCursor;
  }): Promise<CalendarHorizonRollResult>;
  /**
   * Delete one bounded batch of expired event bookkeeping, which returns agent quota: commands
   * older than the replay window (every owner), then agent-owned tombstones older than it with no
   * remaining command. Active events and `internal` tombstones are never deleted. Locked rows are
   * skipped. Afterwards a retried command is evaluated afresh. Call until `hasMore` is false.
   */
  pruneCalendarEventRetention(params: {
    tenantRef: string;
    /** Rows per class per call, 1-1000. Defaults to 100. */
    limit?: number;
    /** Replay window in whole days, 1-3650. Defaults to the store's `retentionDays`, at least 30. */
    retentionDays?: number;
  }): Promise<CalendarEventRetentionResult>;
  /**
   * Delete one bounded batch of a tenant's dead booking rows: expired holds and their keyed
   * answers, and references retired with no booking past retention. A cancelled booking's tombstone
   * is only deleted by erasure, so its reference is never booked again. Locked rows are skipped.
   * Also gives a confirmed booking a 0.2 server wrote without a tenant its tenant and reference, as
   * the migration does. Call until `hasMore` is false.
   */
  /**
   * Find future one-off events whose wall-clock time now falls at another instant (new tzdata),
   * each reported once (`event.timezone_shifted`). With `move`, it is moved (a new revision,
   * `event.updated` by `slotlock:tzdata`) unless that overlaps another booking, which
   * `event.timezone_conflict` reports instead. Up to `limit` (1-1,000, default 100) a call.
   */
  followZoneRules(params: {
    tenantRef: string;
    move?: boolean;
    limit?: number;
  }): Promise<{ shifted: number; moved: number; conflicts: number }>;
  /**
   * A source failed to read (a feed answered 500, a token expired): kept as its last error, at most
   * 500 characters, beside its coverage, which stays as it was. `coverage_not_found` for a source
   * that has never recorded coverage on the resource.
   */
  recordCoverageFailure(params: {
    tenantRef: string;
    resourceId: string;
    source: string;
    error: string;
  }): Promise<{ ok: true } | { ok: false; code: 'coverage_not_found' | 'invalid_identity' }>;
  /**
   * Retire a source (a sync disconnected or replaced): its coverage of the resource is forgotten, so
   * free/busy and the booking rule `requireCertain` stop waiting on it. False when there was none.
   */
  deleteCoverage(params: { tenantRef: string; resourceId: string; source: string }): Promise<boolean>;
  /**
   * Each source's coverage of one resource and how healthy it is: when it was last read, its last
   * error, and whether it is `stale` (not read for `maxAgeMs`, default a day, as free/busy judges).
   */
  listCoverage(params: {
    tenantRef: string;
    resourceId: string;
    maxAgeMs?: number;
  }): Promise<SlotlockCoverageHealth[]>;
  /**
   * Put each source that has gone stale (not read for `maxAgeMs`, default a day) on the feed once
   * (`coverage.stale`), until it is read again. Up to `limit` (default 100); how many.
   */
  reportStaleCoverage(params: { tenantRef: string; maxAgeMs?: number; limit?: number }): Promise<number>;
  /**
   * Claim a booking by its reference (check-in), so a resource whose booking rules ask for check-in
   * (`checkInMinutes`) does not release it. Check-in opens `SLOTLOCK_CHECK_IN_OPENS_MINUTES` before
   * the start (`check_in_not_open` sooner), and a move to another start clears it. Checking in again
   * keeps the first time. Refused once the booking has ended (`reservation_ended`); a reference with
   * no live booking is `reservation_not_found`. The feed says so (`reservation.checked_in`).
   */
  checkInReservation(params: { tenantRef: string; externalRef: string }): Promise<CheckInReservationResult>;
  /**
   * Release up to `limit` (default 100) bookings left unclaimed: on a resource whose booking rules
   * ask for check-in, made since they did, not checked in `checkInMinutes` after the start, and not
   * yet ended. Each is cancelled as `cancelExternalReservation` would (its reference retired at the
   * next revision) and the feed says why (`reservation.no_show`). How many.
   */
  releaseNoShows(params: { tenantRef: string; limit?: number }): Promise<number>;
  /**
   * Wait for a window on one resource (`resourceId`) or any member of a pool (`pool`): when it comes
   * free, `offerWaitlist` holds it for `holderRef` for `offerTtlMs` (1 minute to a day, default 15
   * minutes), first come first offered. A holder may wait for `SLOTLOCK_MAX_WAITLIST_PER_HOLDER`
   * windows at once and a tenant `SLOTLOCK_MAX_WAITLIST_PER_TENANT`.
   */
  joinWaitlist(params: {
    tenantRef: string;
    resourceId?: string;
    pool?: string;
    start: Date;
    end: Date;
    holderRef: string;
    offerTtlMs?: number;
    /**
     * A retry identity, kept as long as the entry: the same key and request answer the entry the
     * first made (`replayed`), another request `idempotency_conflict`.
     */
    idempotencyKey?: string;
  }): Promise<JoinWaitlistResult>;
  /** The tenant's waitlist entries, oldest first, optionally of one resource, pool or holder. */
  listWaitlist(params: {
    tenantRef: string;
    resourceId?: string;
    pool?: string;
    holderRef?: string;
    limit?: number;
  }): Promise<SlotlockWaitlistEntry[]>;
  /**
   * Stop waiting; with `holderRef`, only that holder's entry. A hold offered and not yet confirmed is
   * released with it. False when there was none.
   */
  leaveWaitlist(params: { tenantRef: string; id: string; holderRef?: string }): Promise<boolean>;
  /** The tenant's dashboard assistant settings, or null when it has none. */
  getAssistantSettings(params: { tenantRef: string }): Promise<SlotlockAssistantSettingsRecord | null>;
  /**
   * Set the tenant's assistant settings. `key` is the sealed key and its hint, null for none, or
   * `'keep'` to keep the one stored (none, for a tenant without settings). A stored key is kept only
   * for the provider and base URL it was entered for: `'keep'` with another provider or URL changes
   * nothing and answers `{ saved: false }`, decided in the one statement that writes, so racing
   * saves cannot carry the key elsewhere.
   */
  putAssistantSettings(params: {
    tenantRef: string;
    provider: 'anthropic' | 'openai';
    baseUrl: string;
    model: string;
    key: { sealed: string; hint: string } | null | 'keep';
    updatedBy?: string;
  }): Promise<{ saved: boolean }>;
  /** Remove the tenant's assistant settings, its key with them. False when it had none. */
  deleteAssistantSettings(params: { tenantRef: string }): Promise<boolean>;
  /**
   * Replace the tenant's sealed assistant key `from` with `to`, the same key sealed under a newer
   * secret (SLOTLOCK_ASSISTANT_PREVIOUS_SECRETS), only while `from` is still the one stored: a key an
   * owner saved since is never overwritten. Nothing else changes, its hint and who set it included.
   * True when it was replaced.
   */
  resealAssistantKey(params: { tenantRef: string; from: string; to: string }): Promise<boolean>;
  /**
   * A member's conversations with the assistant, the most recent first (at most `limit`, default
   * 100): what the Chats list shows. Expired ones are left out.
   */
  listAssistantChats(params: {
    tenantRef: string;
    memberRef: string;
    limit?: number;
  }): Promise<SlotlockAssistantChatSummary[]>;
  /** One of a member's conversations, or null when there is none by that id (or it expired). */
  getAssistantChat(params: {
    tenantRef: string;
    memberRef: string;
    chatId: string;
  }): Promise<SlotlockAssistantChatRecord | null>;
  /**
   * Store one of a member's conversations, creating it (titled `title`) or replacing its messages.
   * Its actions become those stored already that `keep` names, in their stored state
   * (settleAssistantAction changes it), and the `added` ones not stored already: an action is never
   * put back into a conversation that no longer has it. It is kept until deleted, or for `ttlMs`
   * (1 second to 3,650 days) from now when given, and then the tenant is listed for
   * sweepAssistantConversations. The member keeps at most SLOTLOCK_ASSISTANT_MAX_CHATS: past it,
   * the least recently used go.
   */
  putAssistantChat(params: {
    tenantRef: string;
    memberRef: string;
    chatId: string;
    title: string;
    messages: unknown[];
    added: Record<string, Record<string, unknown>>;
    keep: readonly string[];
    ttlMs: number | null;
  }): Promise<void>;
  /** Give one of a member's conversations a new title (1-120 characters). False when there is none. */
  renameAssistantChat(params: {
    tenantRef: string;
    memberRef: string;
    chatId: string;
    title: string;
  }): Promise<boolean>;
  /**
   * Change one proposed action of a conversation, only while its `status` is `from`: its fields are
   * merged with `patch`. The action as changed, or null when it is not in that state (or not
   * there): of two racing approvals, one wins.
   */
  settleAssistantAction(params: {
    tenantRef: string;
    memberRef: string;
    chatId: string;
    actionId: string;
    from: string;
    patch: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null>;
  /** Delete one of a member's conversations. False when there was none. */
  deleteAssistantChat(params: { tenantRef: string; memberRef: string; chatId: string }): Promise<boolean>;
  /** Delete up to `limit` (default 1,000) of the tenant's expired assistant conversations: how many. */
  pruneAssistantConversations(params: { tenantRef: string; limit?: number }): Promise<number>;
  /**
   * Delete up to `limit` (1-100,000, default 10,000) expired assistant conversations of every
   * tenant (slotlock.sweep_assistant_conversations): how many, and nothing else.
   */
  sweepAssistantConversations(params?: { limit?: number }): Promise<number>;
  /**
   * Offer freed time to the waitlist in join order: each waiting entry whose window is free (on its
   * resource, or the first free pool member) gets a hold for its holder (`waitlist.offered`).
   * Started windows expire (`waitlist.expired`); finished entries past retention are deleted. One
   * tenant's offers run one at a time. Pages of `limit` (1-100, default 50): pass `next` back as
   * `after` until null.
   */
  offerWaitlist(params: {
    tenantRef: string;
    limit?: number;
    after?: { createdAt: Date; id: string };
  }): Promise<{ offered: number; expired: number; next: { createdAt: Date; id: string } | null }>;
  pruneBookingRetention(params: {
    tenantRef: string;
    /** Rows per class per call, 1-1000. Defaults to 100. */
    limit?: number;
    /**
     * How long a stray retirement is kept, in whole days, 1-3650. Defaults to the store's
     * `retentionDays`, at least 30.
     */
    retentionDays?: number;
  }): Promise<BookingRetentionResult>;
  /**
   * Suspend a tenant: from when this returns, its withTenant transactions may read but writes are
   * refused (`tenant_suspended`); one in flight is waited for. Its keys still authenticate but it
   * gets no new key. Maintenance and erasure go on. True when it was not suspended already.
   * Deployment role only (`tenant_suspension_not_permitted`).
   */
  suspendTenant(params: {
    tenantRef: string;
    /** Why, for the operator: 1-500 characters without control characters. */
    reason?: string;
  }): Promise<{ suspended: boolean }>;
  /** Lift a suspension; true when the tenant was suspended. The deployment role only. */
  unsuspendTenant(params: { tenantRef: string }): Promise<{ unsuspended: boolean }>;
  /** Whether the tenant is suspended. */
  isTenantSuspended(params: { tenantRef: string }): Promise<boolean>;
  /**
   * Erase a tenant: delete every row it owns in one transaction, waiting for its transactions in
   * flight. API key digests are retired so no erased key works again; a suspension stays. Erasing
   * again deletes nothing.
   */
  eraseTenant(params: { tenantRef: string }): Promise<SlotlockTenantErasure>;
  /** Record the bounded, complete source window represented by a provider cursor/revision. */
  recordCalendarCoverage(params: CalendarCoverageCommand): Promise<CalendarCoverageResult>;
  /** Return merged busy intervals plus explicit completeness for caller-required provider sources. */
  getFreeBusy(params: {
    tenantRef: string;
    resourceId: string;
    window: Interval;
    requiredSources?: string[];
    coverageMaxAgeMs?: number;
  }): Promise<CalendarFreeBusy>;
  /**
   * The first slot of `durationMs` inside the hours whose time and turnaround buffer are free
   * (getFreeBusy × expandRules in the resource's timezone → findNextAvailable). Null when no slot
   * is free or one cannot be proven free (coverage incomplete: a series not stored that far, or a
   * required provider not read that far). Unknown or another tenant's resource is
   * `resource_not_found`; a window over 367 days is `invalid_window`.
   */
  findNextAvailableFor(params: {
    /** The resource's tenant; `null` for a resource that has none (the legacy namespace). */
    tenantRef: string | null;
    resourceId: string;
    /** The hours to search; omitted, the resource's own (none: no slot). */
    rules?: WeeklyAvailabilityRule[];
    searchWindow: Interval;
    durationMs: number;
    /** Turnaround after the slot that must be free too (it may run past the hours), 0-30 days. */
    bufferAfterMs?: number;
    /** Provider sources that must prove complete coverage, as for getFreeBusy. */
    requiredSources?: string[];
    coverageMaxAgeMs?: number;
  }): Promise<Interval | null>;
}

/**
 * The model a tenant's dashboard assistant uses (dashboard Settings, Assistant). The API key is held
 * only sealed (assistant.ts sealSlotlockAssistantKey), never in the clear.
 */
export interface SlotlockAssistantSettingsRecord {
  provider: 'anthropic' | 'openai';
  baseUrl: string;
  model: string;
  /** The API key, sealed with the deployment's assistant secret; null when it has none. */
  sealedKey: string | null;
  /** The key's last four characters, to show; null when it has none. */
  keyHint: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

/** One member's live conversation with the dashboard assistant, as assistant.ts keeps it. */
/** One of a member's conversations with the assistant, as the Chats list shows it. */
export interface SlotlockAssistantChatSummary {
  /** 16 URL-safe characters. */
  id: string;
  title: string;
  updatedAt: Date;
}

/** One of a member's conversations with the assistant, whole. */
export interface SlotlockAssistantChatRecord extends SlotlockAssistantChatSummary {
  messages: unknown[];
  /** The writes it proposed, by id. */
  actions: Record<string, Record<string, unknown>>;
  createdAt: Date;
  /** When it is deleted unless used again; null when it is kept until the member deletes it. */
  expiresAt: Date | null;
}


/** One entry of a tenant's waitlist (joinWaitlist). */
export interface SlotlockWaitlistEntry {
  id: string;
  /** The resource it waits on, or null when it waits on a pool. */
  resourceId: string | null;
  pool: string | null;
  start: Date;
  end: Date;
  holderRef: string;
  offerTtlMs: number;
  /** `waiting`, `offered` (a hold was made: `holdId` on `offeredResourceId`) or `expired`. */
  status: 'waiting' | 'offered' | 'expired';
  holdId: string | null;
  offeredResourceId: string | null;
  offeredAt: Date | null;
  createdAt: Date;
}

export type JoinWaitlistResult =
  | { ok: true; entry: SlotlockWaitlistEntry; replayed: boolean }
  | {
      ok: false;
      code:
        | 'invalid_identity'
        | 'invalid_window'
        | 'invalid_ttl'
        | 'invalid_pool'
        | 'resource_not_found'
        | 'resource_archived'
        | 'pool_not_found'
        | 'waitlist_limit_reached'
        | 'idempotency_conflict';
    };

export type CheckInReservationResult =
  | { ok: true; reference: string; checkedInAt: Date }
  | {
      ok: false;
      code: 'invalid_identity' | 'reservation_not_found' | 'reservation_ended' | 'check_in_not_open';
    };

/** One source's coverage of a resource, with its health (listCoverage). */
export interface SlotlockCoverageHealth {
  source: string;
  /**
   * How the change feed names the source, never the source itself: `src_` and 32 random hex
   * digits, made when the source is first recorded for the resource and kept until it is deleted.
   */
  sourceId: string;
  start: Date;
  end: Date;
  revision: number;
  /** When it was last read. */
  observedAt: Date;
  lastError: string | null;
  lastErrorAt: Date | null;
  /** Not read for longer than free/busy trusts: time it covers is unproven, not free. */
  stale: boolean;
}

export type SlotlockTenantStore = Omit<
  SlotlockStore,
  'applySchema' | 'applyTenantRls' | 'grantApplicationRole' | 'withTenant'
>;

export interface SlotlockStoreOptions {
  /** Namespaced PostgreSQL setting installed by applyTenantRls. Defaults to `slotlock.tenant_ref`. */
  tenantContextSetting?: string;
  /**
   * The bookable hours of a resource without its own, where its booking rules enforce hours
   * (`enforceHours`). None by default: such a resource is then never bookable.
   */
  defaultAvailabilityRules?: readonly WeeklyAvailabilityRule[];
  /** Hard active + tombstone identity ceiling per non-internal owner. Defaults to 1,000. */
  agentOwnerEventQuota?: number;
  /** Hard retained-command ceiling per non-internal owner. Defaults to 10,000; cannot be disabled. */
  agentOwnerCommandQuota?: number;
  /**
   * What one tenant may store, for a shared database (none by default). A write that would pass a
   * limit is refused (`*_limit_reached`); existing rows can still be revised, cancelled and
   * released. Counted under a per-tenant lock in READ COMMITTED transactions only. Bookings and
   * events count while still to come and for 30 days after they were made.
   */
  tenantLimits?: SlotlockTenantLimits;
  /**
   * How many withTenant transactions of one tenant run at once on this store (1-1,000; unlimited by
   * default). The rest wait in order, so one tenant waiting on its own locks holds at most this
   * many pool connections. Not counted inside a caller's transaction.
   */
  maxTenantTransactions?: number;
  /**
   * The longest a withTenant transaction waits for any one lock, in milliseconds (1-600,000; none by
   * default). Past it the transaction is rolled back and refused with `lock_timeout`, which is safe
   * to retry. Not set inside a caller's transaction.
   */
  tenantLockTimeoutMs?: number;
  /**
   * Days history is kept, 1-3,650 (default 30): the change feed (and cursor reach) and ended
   * waitlist entries; and, when longer than 30 days, retired idempotency answers, booking
   * references and past events' commands. A cursor before a pruned change answers `cursor_expired`.
   */
  retentionDays?: number;
  /**
   * Live holds one holder (`acquireHold`'s `holderRef`) may have at once, 1-10,000. Defaults to
   * SLOTLOCK_MAX_HOLDS_PER_HOLDER (20).
   */
  maxHoldsPerHolder?: number;
  /**
   * Hours one holder's live holds may hold together, 1-876,000 (none by default): past it a hold is
   * refused with `held_time_limit_reached`, however few holds it has.
   */
  maxHeldHoursPerHolder?: number;
}

/** Per-tenant row limits, each a whole number from 1 to 10,000,000 (resources: to 100,000). */
export interface SlotlockTenantLimits {
  /** Resources, archived ones included; the lower of this and a call's `maxTenantResources`. */
  resources?: number;
  /**
   * Holds, expired ones included until deleted; a keyed hold keeps its place while its answer is
   * kept. At the limit, expired holds and their answers are deleted first, so only live holds keep
   * a new one out.
   */
  holds?: number;
  /**
   * Bookings still to come or made in the last 30 days, cancellations made in the last 30 days,
   * and references a cancel retired with no booking until maintenance prunes them.
   */
  reservations?: number;
  /**
   * Events of every owner still to come (a series until known to have ended) or made in the last 30
   * days, cancellations made in the last 30 days, and agent cancellations until pruned. Each event
   * stores at most 2,000 occurrences.
   */
  events?: number;
  /** Provider coverage rows: one per resource and source. */
  coverage?: number;
}

type TenantLimitKind = Exclude<keyof SlotlockTenantLimits, 'resources'>;

const MAX_TENANT_LIMIT = 10_000_000;

function tenantLimitsOption(limits: SlotlockTenantLimits | undefined): SlotlockTenantLimits {
  const valid: SlotlockTenantLimits = {};
  for (const kind of ['resources', 'holds', 'reservations', 'events', 'coverage'] as const) {
    const value = limits?.[kind];
    if (value === undefined) continue;
    const max = kind === 'resources' ? MAX_TENANT_RESOURCE_LIMIT : MAX_TENANT_LIMIT;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
      throw Object.assign(
        new Error(`Slotlock tenant limit ${kind} must be a whole number from 1 to ${max}`),
        { code: 'invalid_tenant_limits' as const },
      );
    }
    valid[kind] = value;
  }
  return valid;
}

/**
 * Serialize a tenant's writes adding rows of one limited kind, so each counts what earlier ones
 * committed. Taken after the identity locks, before any row lock.
 */
async function lockTenantLimit(
  tx: TransactionSql,
  tenantRef: string,
  kind: TenantLimitKind,
): Promise<void> {
  // An object, so the key never equals a [tenantRef, externalRef] identity lock's.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify({ tenantLimit: kind, tenantRef })}, 0))`;
}

/**
 * Rows added within this many days count whatever time they hold, so back-dated bookings and
 * cancellations add at most the limit per window. Maintenance keeps idempotency records and stray
 * retirements at least this long.
 */
const TENANT_LIMIT_RECENT_DAYS = SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS;

/**
 * The rows a tenant's `kind` limit counts: what is still to come plus what it added in the last
 * TENANT_LIMIT_RECENT_DAYS days. Each part stops at `limit` rows read through an index, so a count
 * costs at most the limit.
 */
async function tenantLimitCount(
  tx: TransactionSql,
  tenantRef: string,
  kind: TenantLimitKind,
  limit: number,
): Promise<number> {
  let rows: { count: number }[];
  switch (kind) {
    case 'holds':
      // Every held row until deleted (expired ones too), plus each keyed hold's kept answer once
      // its row is gone.
      rows = await tx<{ count: number }[]>`
        SELECT (
          (SELECT count(*) FROM (
            SELECT 1
              FROM slotlock.reservations hold
              JOIN slotlock.resources resource ON resource.id = hold.resource_id
             WHERE resource.tenant_ref = ${tenantRef} AND hold.status = 'held'
             LIMIT ${limit}) held)
          + (SELECT count(*) FROM (
            SELECT 1 FROM slotlock.hold_commands answer
             WHERE answer.tenant_ref = ${tenantRef}
               AND NOT EXISTS (
                 SELECT 1 FROM slotlock.reservations hold
                  WHERE hold.id = answer.hold_id AND hold.status = 'held'
               )
             LIMIT ${limit}) kept)
        )::int AS count`;
      break;
    case 'reservations':
      // Bookings still to come; ended bookings and cancellations made recently; and stray
      // retirements until pruned.
      rows = await tx<{ count: number }[]>`
        WITH recent AS (
          SELECT now() - ${TENANT_LIMIT_RECENT_DAYS}::int * interval '1 day' AS since
        )
        SELECT (
          (SELECT count(*) FROM (
            SELECT 1 FROM slotlock.reservations
             WHERE tenant_ref = ${tenantRef} AND external_ref IS NOT NULL
               AND calendar_event_id IS NULL AND occupied_ends_at > now()
             LIMIT ${limit}) live)
          + (SELECT count(*) FROM (
            SELECT 1 FROM slotlock.reservations, recent
             WHERE tenant_ref = ${tenantRef} AND external_ref IS NOT NULL
               AND calendar_event_id IS NULL AND created_at > recent.since
               AND occupied_ends_at <= now()
             LIMIT ${limit}) ended)
          + (SELECT count(*) FROM (
            SELECT 1 FROM slotlock.reservation_tombstones, recent
             WHERE tenant_ref = ${tenantRef} AND cancelled_at > recent.since
             LIMIT ${limit}) cancelled)
          + (SELECT count(*) FROM (
            SELECT 1 FROM slotlock.reservation_tombstones, recent
             WHERE tenant_ref = ${tenantRef} AND stray AND cancelled_at <= recent.since
             LIMIT ${limit}) retired)
        )::int AS count`;
      break;
    case 'events':
      // One-off events still to come and series not known to have ended; recent ended events and
      // cancellations; and agent cancellations until pruned. The owner CHECK makes every owner but
      // 'internal' an 'agent:' one.
      rows = await tx<{ count: number }[]>`
        WITH recent AS (
          SELECT now() - ${TENANT_LIMIT_RECENT_DAYS}::int * interval '1 day' AS since
        )
        SELECT (
          (SELECT count(*) FROM (
            SELECT 1 FROM slotlock.calendar_events
             WHERE tenant_ref = ${tenantRef} AND recurrence_rule IS NULL AND ends_at > now()
             LIMIT ${limit}) one_off)
          + (SELECT count(*) FROM (
            SELECT 1 FROM slotlock.calendar_events
             WHERE tenant_ref = ${tenantRef} AND recurrence_rule IS NOT NULL
               AND (recurrence_ends_by IS NULL OR recurrence_ends_by > now())
             LIMIT ${limit}) series)
          + (SELECT count(*) FROM (
            SELECT 1 FROM slotlock.calendar_events, recent
             WHERE tenant_ref = ${tenantRef} AND created_at > recent.since
               AND CASE WHEN recurrence_rule IS NULL THEN ends_at <= now()
                        ELSE recurrence_ends_by <= now() END
             LIMIT ${limit}) ended)
          + (SELECT count(*) FROM (
            SELECT 1 FROM slotlock.calendar_event_tombstones, recent
             WHERE tenant_ref = ${tenantRef} AND cancelled_at > recent.since
             LIMIT ${limit}) cancelled)
          + (SELECT count(*) FROM (
            SELECT 1 FROM slotlock.calendar_event_tombstones, recent
             WHERE tenant_ref = ${tenantRef} AND owner_ref LIKE 'agent:%'
               AND cancelled_at <= recent.since
             LIMIT ${limit}) agent_cancelled)
        )::int AS count`;
      break;
    case 'coverage':
      rows = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM (
          SELECT 1 FROM slotlock.calendar_coverage WHERE tenant_ref = ${tenantRef} LIMIT ${limit}
        ) kept`;
      break;
  }
  const count = Number(rows[0]?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('slotlock: invalid tenant row count');
  return count;
}

/**
 * Delete up to `limit` of a tenant's expired holds, oldest first. Rows a reaper or confirmer has
 * locked are skipped, and the delete rechecks the predicate.
 */
async function deleteExpiredHolds(
  tx: TransactionSql,
  tenantRef: string,
  limit: number,
): Promise<number> {
  const [row] = await tx<{ deleted: number }[]>`
    WITH candidates AS MATERIALIZED (
      SELECT hold.id
        FROM slotlock.reservations hold
        JOIN slotlock.resources resource ON resource.id = hold.resource_id
       WHERE resource.tenant_ref = ${tenantRef}
         AND hold.status = 'held' AND hold.expires_at <= statement_timestamp()
       ORDER BY hold.expires_at, hold.id
       LIMIT ${limit}
       FOR UPDATE OF hold SKIP LOCKED
    ), deleted AS (
      DELETE FROM slotlock.reservations hold
       USING candidates candidate
       WHERE hold.id = candidate.id
         AND hold.status = 'held' AND hold.expires_at <= statement_timestamp()
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted`;
  return Number(row?.deleted ?? 0);
}

/**
 * Delete up to `limit` keyed hold answers whose hold has expired, so a retry makes a new hold;
 * locked answers are skipped.
 */
async function forgetExpiredHoldAnswers(
  tx: TransactionSql,
  tenantRef: string,
  limit: number,
): Promise<number> {
  const [row] = await tx<{ deleted: number }[]>`
    WITH candidates AS MATERIALIZED (
      SELECT answer.principal_ref, answer.idempotency_key
        FROM slotlock.hold_commands answer
       WHERE answer.tenant_ref = ${tenantRef} AND answer.expires_at <= statement_timestamp()
       ORDER BY answer.expires_at, answer.principal_ref, answer.idempotency_key
       LIMIT ${limit}
       FOR UPDATE OF answer SKIP LOCKED
    ), deleted AS (
      DELETE FROM slotlock.hold_commands answer
       USING candidates candidate
       WHERE answer.tenant_ref = ${tenantRef}
         AND answer.principal_ref = candidate.principal_ref
         AND answer.idempotency_key = candidate.idempotency_key
      RETURNING 1
    )
    SELECT count(*)::int AS deleted FROM deleted`;
  return Number(row?.deleted ?? 0);
}

/**
 * A booking's occupied time as the exclusion constraint reads it: start less its leading buffer to
 * end plus its trailing one.
 */
function occupiedTime(params: { start: Date; end: Date; bufferBeforeMs?: number; bufferAfterMs?: number }): Interval {
  return {
    start: new Date(params.start.getTime() - (params.bufferBeforeMs ?? 0)),
    end: new Date(params.end.getTime() + (params.bufferAfterMs ?? 0)),
  };
}

/**
 * Occupied start before `end`, written so the (resource_id, starts_at, ends_at) index still
 * applies: no row starts more than a day after its occupied start.
 */
function occupiedStartsBefore(executor: StoreSql, end: Date, alias?: string) {
  const column = (name: string) => executor.unsafe(alias === undefined ? name : `${alias}.${name}`);
  return executor`(${column('starts_at')} < ${new Date(end.getTime() + MAX_BUFFER_BEFORE_MS)}
                   AND COALESCE(${column('occupied_starts_at')}, ${column('starts_at')}) < ${end})`;
}

/**
 * Delete expired held rows whose occupied time overlaps the window, in id order under FOR UPDATE:
 * concurrent reapers lock in the same order (no deadlock) and the loser finds them gone. Runs right
 * before the caller's INSERT, so the EXCLUDE arbiter only sees live occupation.
 */
async function reapExpiredHolds(
  tx: TransactionSql,
  resourceId: string,
  start: Date,
  end: Date,
): Promise<void> {
  // A composite's parent and parts too (RFC 0003 G8): their expired holds' claims are in the way.
  await tx`
    DELETE FROM slotlock.reservations
     WHERE id IN (
       SELECT id FROM slotlock.reservations
        WHERE resource_id IN (
                SELECT ${resourceId}::uuid
                UNION ALL SELECT family.parent_id FROM slotlock.resources family
                           WHERE family.id = ${resourceId} AND family.parent_id IS NOT NULL
                UNION ALL SELECT family.id FROM slotlock.resources family WHERE family.parent_id = ${resourceId})
          AND status = 'held'
          AND expires_at <= statement_timestamp()
          AND ${occupiedStartsBefore(tx, end)}
          AND COALESCE(occupied_ends_at, ends_at) > ${start}
        ORDER BY id
        FOR UPDATE
     )`;
}

/**
 * reapExpiredHolds for many windows on one resource in one statement (a series' occurrences): the
 * same rows, in the same id order under FOR UPDATE, as one call per window would delete. The
 * envelope of the windows bounds the scan so the index applies; each row must still overlap one.
 */
async function reapExpiredHoldsAcross(
  tx: TransactionSql,
  resourceId: string,
  windows: readonly Interval[],
): Promise<void> {
  if (windows.length === 0) return;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const window of windows) {
    first = Math.min(first, window.start.getTime());
    last = Math.max(last, window.end.getTime());
  }
  await tx`
    DELETE FROM slotlock.reservations
     WHERE id IN (
       SELECT held.id FROM slotlock.reservations held
        WHERE held.resource_id IN (
                SELECT ${resourceId}::uuid
                UNION ALL SELECT family.parent_id FROM slotlock.resources family
                           WHERE family.id = ${resourceId} AND family.parent_id IS NOT NULL
                UNION ALL SELECT family.id FROM slotlock.resources family WHERE family.parent_id = ${resourceId})
          AND held.status = 'held'
          AND held.expires_at <= statement_timestamp()
          AND ${occupiedStartsBefore(tx, new Date(last), 'held')}
          AND COALESCE(held.occupied_ends_at, held.ends_at) > ${new Date(first)}
          AND EXISTS (
                SELECT 1
                  FROM ROWS FROM (pg_catalog.unnest(${windows.map((window) => window.start.toISOString())}::text[]::timestamptz[]),
                                  pg_catalog.unnest(${windows.map((window) => window.end.toISOString())}::text[]::timestamptz[]))
                       AS occupied(starts_at, ends_at)
                 WHERE COALESCE(held.occupied_starts_at, held.starts_at) < occupied.ends_at
                   AND COALESCE(held.occupied_ends_at, held.ends_at) > occupied.starts_at)
        ORDER BY held.id
        FOR UPDATE
     )`;
}

/**
 * What else keeps a resource busy as part of a composite (RFC 0003 G8), as rows of
 * (occupied_starts_at, occupied_ends_at): a part, the bookings of its parent as a whole; a parent,
 * the bookings of any of its parts. Its own bookings are read with its own rows. Nothing for a
 * resource that is neither.
 */
function compositeBusy(executor: StoreSql, resourceId: string, window: Interval) {
  return executor`
    SELECT lower(claim.during) AS occupied_starts_at, upper(claim.during) AS occupied_ends_at
      FROM slotlock.resources me
      JOIN slotlock.composite_claims claim
        ON claim.resource_id = COALESCE(me.parent_id, me.id)
       AND claim.booked_resource_id <> me.id
       AND (me.parent_id IS NULL OR claim.span @> me.part_index)
     WHERE me.id = ${resourceId}
       AND claim.during && tstzrange(${window.start}, ${window.end}, '[)')
       AND (claim.status <> 'held' OR claim.expires_at > statement_timestamp())`;
}

/**
 * Structured answer after losing to the EXCLUDE arbiter: name the live winner.
 * conflictingReservationId is null in one narrow race (the blocker expired between the constraint
 * check and this lookup); an immediate retry reaps it and wins.
 */
async function overlapLoss(
  sql: StoreSql,
  resourceId: string,
  start: Date,
  end: Date,
  bufferAfterMs = 0,
  excludeReservationId?: string,
  excludeCalendarEventId?: string,
  bufferBeforeMs = 0,
): Promise<{ ok: false; code: 'overlap'; conflictingReservationId: string | null }> {
  const winners = await sql<{ id: string }[]>`
    SELECT id FROM slotlock.reservations
     WHERE resource_id = ${resourceId}
       AND (${excludeReservationId ?? null}::uuid IS NULL OR id <> ${excludeReservationId ?? null}::uuid)
       AND (${excludeCalendarEventId ?? null}::uuid IS NULL
            OR calendar_event_id IS DISTINCT FROM ${excludeCalendarEventId ?? null}::uuid)
       AND tstzrange(
             COALESCE(occupied_starts_at, starts_at),
             COALESCE(occupied_ends_at, ends_at),
             '[)'
           ) && tstzrange(
             ${start}::timestamptz - ${bufferBeforeMs} * interval '1 millisecond',
             ${end}::timestamptz + ${bufferAfterMs} * interval '1 millisecond',
             '[)'
           )
       AND (status <> 'held' OR expires_at > statement_timestamp())
     ORDER BY starts_at
     LIMIT 1`;
  if (winners[0]) return { ok: false, code: 'overlap', conflictingReservationId: winners[0].id };
  // Lost to a composite's claim (RFC 0003 G8): the booking on the whole, or on a part, in the way.
  const claimed = await sql<{ id: string }[]>`
    SELECT claim.reservation_id::text AS id
      FROM slotlock.resources me
      JOIN slotlock.composite_claims claim
        ON claim.resource_id = COALESCE(me.parent_id, me.id)
       AND claim.booked_resource_id <> me.id
       AND (me.parent_id IS NULL OR claim.span @> me.part_index)
     WHERE me.id = ${resourceId}
       AND (${excludeReservationId ?? null}::uuid IS NULL OR claim.reservation_id <> ${excludeReservationId ?? null}::uuid)
       AND claim.during && tstzrange(
             ${start}::timestamptz - ${bufferBeforeMs} * interval '1 millisecond',
             ${end}::timestamptz + ${bufferAfterMs} * interval '1 millisecond',
             '[)'
           )
       AND (claim.status <> 'held' OR claim.expires_at > statement_timestamp())
     ORDER BY lower(claim.during)
     LIMIT 1`;
  return { ok: false, code: 'overlap', conflictingReservationId: claimed[0]?.id ?? null };
}

export interface SlotlockHoldTenantOptions {
  /** Only a hold on one of this tenant's resources: 1-500 UTF-8 bytes. */
  tenantRef?: string;
}

/** The tenant a hold call is limited to, or null for none; an invalid one is refused. */
function holdTenantRef(options: SlotlockHoldTenantOptions): string | null {
  const tenantRef = options.tenantRef;
  if (tenantRef === undefined) return null;
  if (!isValidIdentity(tenantRef)) {
    throw Object.assign(new Error('Slotlock tenantRef must be 1-500 UTF-8 bytes'), {
      code: 'invalid_tenant_ref' as const,
    });
  }
  return tenantRef;
}

/**
 * At most `max` holders per tenant at once; the rest wait in order. An aborted signal takes a
 * waiter out of the line, rejecting with its reason. Each holder calls the release it gets once.
 */
export function createTenantSlots(
  max: number,
): (tenantRef: string, signal?: AbortSignal) => Promise<() => void> {
  const tenants = new Map<string, { running: number; waiting: Array<() => void> }>();
  return async (tenantRef, signal) => {
    signal?.throwIfAborted();
    let tenant = tenants.get(tenantRef);
    if (!tenant) {
      tenant = { running: 0, waiting: [] };
      tenants.set(tenantRef, tenant);
    }
    const slots = tenant;
    if (slots.running < max) {
      slots.running += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          slots.waiting.splice(slots.waiting.indexOf(start), 1);
          reject(signal?.reason);
        };
        slots.waiting.push(start);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Handed straight to the next in line, so the count is unchanged.
      const next = slots.waiting.shift();
      if (next) {
        next();
        return;
      }
      slots.running -= 1;
      if (slots.running === 0) tenants.delete(tenantRef);
    };
  };
}

function lockTimeoutError(cause: unknown): Error & { code: 'lock_timeout' } {
  return Object.assign(
    new Error('Slotlock tenant transaction waited too long for a lock: retry later', { cause }),
    { code: 'lock_timeout' as const },
  );
}

export function createSlotlockStore(sql: StoreSql, options: SlotlockStoreOptions = {}): SlotlockStore {
  return buildSlotlockStore(sql, options, null);
}

/**
 * Every store method that writes for a tenant: what a suspended tenant's withTenant store refuses.
 * Maintenance (rolling series, pruning, purging) and erasure are not among them.
 */
export const SLOTLOCK_TENANT_WRITE_METHODS = Object.freeze([
  'createResource',
  'updateResourceProfile',
  'putLocation',
  'updateLocation',
  'deleteLocation',
  'putGroup',
  'deleteGroup',
  'addGroupMember',
  'removeGroupMember',
  'archiveResource',
  'restoreResource',
  'deleteResource',
  'setResourceAvailability',
  'setResourceBookingRules',
  'setBookingRuleDefaults',
  'setResourcePool',
  'setResourceParent',
  'setPoolOrder',
  'notePoolBooking',
  'putApprovalPolicy',
  'deleteApprovalPolicy',
  'requestApproval',
  'beginApprovalGrant',
  'finishApprovalGrant',
  'declineApproval',
  'resetTestTenant',
  'fastForwardTestTenant',
  'setTenantAvailability',
  'createReservation',
  'createExternalReservation',
  'rescheduleExternalReservation',
  'cancelExternalReservation',
  'acquireHold',
  'confirmHold',
  'releaseHold',
  'putCalendarEvent',
  'cancelCalendarEvent',
  'cancelCalendarEventById',
  'recordCalendarCoverage',
  'createWebhookEndpoint',
  'deleteWebhookEndpoint',
  'enableWebhookEndpoint',
  'recordCoverageFailure',
  'deleteCoverage',
  'checkInReservation',
  'joinWaitlist',
  'leaveWaitlist',
  'putAssistantSettings',
  'deleteAssistantSettings',
  'resealAssistantKey',
  'putAssistantChat',
  'renameAssistantChat',
  'settleAssistantAction',
  'deleteAssistantChat',
] as const satisfies readonly (keyof SlotlockStore)[]);

function tenantSuspendedError(): Error & { code: 'tenant_suspended' } {
  return Object.assign(new Error('Slotlock tenant is suspended: it may read, and write nothing'), {
    code: 'tenant_suspended' as const,
  });
}

function staleSuspensionCheckError(): Error & { code: 'invalid_transaction_isolation' } {
  return Object.assign(
    new Error(
      'Slotlock writes for a tenant only in a READ COMMITTED transaction, whose suspension check sees every suspension committed before the tenant lock',
    ),
    { code: 'invalid_transaction_isolation' as const },
  );
}

/**
 * Reading a suspension needs EXECUTE on slotlock.tenant_suspended(text) (42501 without it) and a
 * schema this release migrated (42883 before). Name the remedy for each.
 */
function suspensionCheckRefusal(error: unknown): unknown {
  const code = pgCode(error);
  if (code === '42501') {
    return Object.assign(
      new Error(
        'Slotlock serving role may not run slotlock.tenant_suspended(text): grant it what this release needs with grantApplicationRole (`slotlock migrate` does), once per release',
        { cause: error },
      ),
      { code: 'application_role_not_granted' as const },
    );
  }
  if (code === '42883') {
    return Object.assign(
      new Error(
        'The slotlock schema predates this release (it has no slotlock.tenant_suspended(text)): run applySchema (`slotlock migrate`) with this release first',
        { cause: error },
      ),
      { code: 'schema_outdated' as const },
    );
  }
  return error;
}

/**
 * A store on `sql`. With `refusal`, every SLOTLOCK_TENANT_WRITE_METHODS method throws it before any
 * query.
 */
function buildSlotlockStore(
  sql: StoreSql,
  options: SlotlockStoreOptions,
  refusal: (() => Error) | null,
): SlotlockStore {
  const configuredTenantSetting = options.tenantContextSetting ?? SLOTLOCK_TENANT_CONTEXT_SETTING;
  const defaultHours = parseAvailabilityRules([...(options.defaultAvailabilityRules ?? [])]);
  const configuredAgentOwnerEventQuota =
    options.agentOwnerEventQuota ?? SLOTLOCK_AGENT_OWNER_EVENT_QUOTA;
  const configuredAgentOwnerCommandQuota =
    options.agentOwnerCommandQuota ?? SLOTLOCK_AGENT_OWNER_COMMAND_QUOTA;
  if (
    !Number.isSafeInteger(configuredAgentOwnerEventQuota) ||
    configuredAgentOwnerEventQuota <= 0 ||
    configuredAgentOwnerEventQuota > MAX_CONFIGURED_AGENT_OWNER_EVENT_QUOTA
  ) {
    throw Object.assign(
      new Error('Slotlock agent owner event quota must be an integer from 1-100000'),
      {
        code: 'invalid_agent_owner_event_quota' as const,
      },
    );
  }
  if (
    !Number.isSafeInteger(configuredAgentOwnerCommandQuota) ||
    configuredAgentOwnerCommandQuota <= configuredAgentOwnerEventQuota ||
    configuredAgentOwnerCommandQuota > MAX_CONFIGURED_AGENT_OWNER_COMMAND_QUOTA
  ) {
    throw Object.assign(
      new Error(
        'Slotlock agent owner command quota must exceed its event quota and be at most 1000000',
      ),
      { code: 'invalid_agent_owner_command_quota' as const },
    );
  }
  const configuredTenantLimits = tenantLimitsOption(options.tenantLimits);
  const { maxTenantTransactions, tenantLockTimeoutMs, maxHeldHoursPerHolder } = options;
  const retentionDays = options.retentionDays ?? SLOTLOCK_CHANGE_RETENTION_DAYS;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw Object.assign(new Error('Slotlock retentionDays must be a whole number from 1 to 3650'), {
      code: 'invalid_retention' as const,
    });
  }
  const maxHoldsPerHolder = options.maxHoldsPerHolder ?? SLOTLOCK_MAX_HOLDS_PER_HOLDER;
  if (
    !Number.isSafeInteger(maxHoldsPerHolder) ||
    maxHoldsPerHolder < 1 ||
    maxHoldsPerHolder > 10_000 ||
    (maxHeldHoursPerHolder !== undefined &&
      (!Number.isSafeInteger(maxHeldHoursPerHolder) ||
        maxHeldHoursPerHolder < 1 ||
        maxHeldHoursPerHolder > 876_000))
  ) {
    throw Object.assign(
      new Error('Slotlock maxHoldsPerHolder must be 1-10000 and maxHeldHoursPerHolder 1-876000, whole numbers'),
      { code: 'invalid_holder_limits' as const },
    );
  }
  const whole = (value: number | undefined, max: number) =>
    value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= max);
  if (!whole(maxTenantTransactions, 1_000) || !whole(tenantLockTimeoutMs, 600_000)) {
    throw Object.assign(
      new Error(
        'Slotlock maxTenantTransactions must be 1-1000 and tenantLockTimeoutMs 1-600000, whole numbers',
      ),
      { code: 'invalid_tenant_transaction_options' as const },
    );
  }
  // Only a client opens transactions of its own; inside a caller's, neither applies.
  const ownTransactions = 'begin' in sql;
  const tenantSlots =
    ownTransactions && maxTenantTransactions !== undefined
      ? createTenantSlots(maxTenantTransactions)
      : undefined;
  const lockTimeout =
    ownTransactions && tenantLockTimeoutMs !== undefined ? `${tenantLockTimeoutMs}ms` : undefined;
  createSlotlockTenantRlsDdl(configuredTenantSetting);
  const storeOptions: SlotlockStoreOptions = {
    tenantContextSetting: configuredTenantSetting,
    agentOwnerEventQuota: configuredAgentOwnerEventQuota,
    agentOwnerCommandQuota: configuredAgentOwnerCommandQuota,
    tenantLimits: configuredTenantLimits,
    retentionDays,
    maxHoldsPerHolder,
    ...(maxHeldHoursPerHolder !== undefined ? { maxHeldHoursPerHolder } : {}),
  };

  /**
   * Under the tenant's lock for `kind`: the limit when the tenant is at it, else null. Writes that
   * only lower the count take no lock, so an early count stays an upper bound.
   */
  async function tenantLimitReached(
    tx: TransactionSql,
    tenantRef: string | null,
    kind: TenantLimitKind,
  ): Promise<number | null> {
    const limit = configuredTenantLimits[kind];
    if (limit === undefined || tenantRef === null) return null;
    await assertReadCommitted(tx);
    await lockTenantLimit(tx, tenantRef, kind);
    if ((await tenantLimitCount(tx, tenantRef, kind, limit)) < limit) return null;
    // At the limit, expired holds and their answers are deleted, as maintenance would, and the
    // count is read again.
    if (
      kind !== 'holds' ||
      (await deleteExpiredHolds(tx, tenantRef, limit)) +
        (await forgetExpiredHoldAnswers(tx, tenantRef, limit)) ===
        0
    ) {
      return limit;
    }
    return (await tenantLimitCount(tx, tenantRef, kind, limit)) >= limit ? limit : null;
  }

  /**
   * The tenant whose limit a write on the resource counts against: the caller's, else the
   * resource's (never changes, so read before any lock). Null with no limit.
   */
  async function limitTenant(
    tx: TransactionSql,
    kind: TenantLimitKind,
    resourceId: string,
    tenantRef: string | undefined,
  ): Promise<string | null> {
    if (configuredTenantLimits[kind] === undefined) return null;
    if (tenantRef !== undefined) return tenantRef;
    const [resource] = await tx<{ tenant_ref: string | null }[]>`
      SELECT tenant_ref FROM slotlock.resources WHERE id = ${resourceId}`;
    return resource?.tenant_ref ?? null;
  }

  const store: SlotlockStore = {
    ...slotlockEventFeedMethods(sql, retentionDays),
    async applySchema(migrationOptions) {
      // IF NOT EXISTS DDL is idempotent but not race-free: two fresh instances can collide on
      // pg_namespace/pg_extension indexes, so inMigration serializes bootstrap. An unchanged schema
      // locks no table unless a constraint is still NOT VALID or the coverage rename is unfinished.
      const next = await inMigration(sql, migrationOptions, async (tx) => {
        await tx.unsafe(SLOTLOCK_DEPLOYMENT_CHECKS).catch((error: unknown) => {
          throw schemaControlRefusal(error);
        });
        if (await slotlockSchemaUpToDate(tx)) {
          return {
            validate: await slotlockConstraintUnvalidated(tx),
            rename: await coverageChangesRenamePending(tx),
          };
        }
        await tx.unsafe(SLOTLOCK_STRUCTURE_DDL).catch((error: unknown) => {
          throw schemaControlRefusal(error);
        });
        return { validate: true, rename: await coverageChangesRenamePending(tx) };
      });
      // Renamed in short batches after the structure commits, never under its locks; the feed
      // redacts any not yet renamed (event-feed.ts, slotlockServedChange).
      if (next.rename) await renameEarlierCoverageChanges(sql, migrationOptions);
      if (!next.validate) return;
      // After the DDL commits its ACCESS EXCLUSIVE locks are gone, so validation blocks no serving
      // query (ddl.ts, DEPLOYMENT_VALIDATE_CONSTRAINTS). Digests go last, so a migration stopped
      // earlier runs whole again.
      await inMigration(sql, migrationOptions, async (tx) => {
        await tx.unsafe(SLOTLOCK_VALIDATION_DDL);
        await tx`
          UPDATE slotlock.schema_version
             SET ddl_sha256 = ${SLOTLOCK_CORE_DDL_SHA256},
                 catalog_sha256 = ${await slotlockCatalogDigest(tx)}
           WHERE singleton`;
      });
    },

    async applyTenantRls(applyOptions) {
      const ddl = createSlotlockTenantRlsDdl(configuredTenantSetting);
      const { allowRebind, ...migrationOptions } = applyOptions ?? {};
      await inMigration(sql, migrationOptions, async (tx) => {
        await tx.unsafe(SLOTLOCK_DEPLOYMENT_CHECKS).catch((error: unknown) => {
          throw schemaControlRefusal(error);
        });
        if (await tenantRlsUpToDate(tx, configuredTenantSetting)) return;
        const bindings = await tx<{ binding: string }[]>`
          SELECT DISTINCT obj_description(policy.oid, 'pg_policy') AS binding
            FROM pg_policy policy
            JOIN pg_class table_class ON table_class.oid = policy.polrelid
            JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
           WHERE namespace.nspname = 'slotlock'
             AND table_class.relname IN ${tx([...SLOTLOCK_TENANT_TABLES])}
             AND obj_description(policy.oid, 'pg_policy') LIKE 'slotlock:tenant-context:%'`;
        const conflictingBinding = bindings.find(
          ({ binding }) => binding !== `slotlock:tenant-context:${configuredTenantSetting}`,
        );
        if (conflictingBinding && allowRebind !== true) {
          throw Object.assign(
            new Error(
              `Slotlock tenant RLS is already bound to ${conflictingBinding.binding.slice('slotlock:tenant-context:'.length)}`,
            ),
            { code: 'tenant_context_conflict' as const },
          );
        }
        await tx.unsafe(ddl).catch((error: unknown) => {
          throw schemaControlRefusal(error);
        });
      });
    },

    async grantApplicationRole(role, migrationOptions) {
      const ddl = createSlotlockApplicationRoleGrantsDdl(role);
      await inMigration(sql, migrationOptions, (tx) =>
        (async () => {
          // Every role the target belongs to counts, not only the target: a member can SET ROLE to
          // it or use its privileges, and one holding only ADMIN OPTION can grant itself either.
          // MEMBER also counts a PostgreSQL 16 grant made with none of ADMIN, INHERIT or SET, which
          // confers nothing; refusing that one is the price of never missing a usable path. The
          // privilege functions, and the PUBLIC grantee (0) in an ACL, count what every role holds.
          // Unsafe, one reason each:
          // - RLS is skipped (superuser, BYPASSRLS); data leaves outside SQL (REPLICATION, the server
          //   file and program roles); a role can grant itself one of those (CREATEROLE before 16).
          // - The role can drop or replace what enforces isolation: it owns the database (and so
          //   public, where btree_gist usually lives), anything in it, or btree_gist. Its temporary
          //   objects and its default privileges (for tables it cannot create) reach no other
          //   session, so they do not count.
          // - It can create objects: in a schema on some search path (its own "$user" schema, or
          //   one named after the deployment role) a function or operator decides what a call with
          //   that name runs, in every tenant's session or in the next deployment.
          // - It holds a right RLS does not filter: TRUNCATE empties a table for every tenant, a
          //   foreign key check reads every tenant's keys, a trigger sees every tenant's rows; or a
          //   default privilege that grants one on the table a later release adds, set by a role
          //   that can create slotlock tables (a default applies only to the tables its role creates).
          // - It can change a server setting (ALTER SYSTEM reaches archive_command, a shell command).
          // A superuser holds every right, so its privilege-based reasons would only repeat it.
          const [check] = await tx<{ found: boolean; reasons: string[] }[]>`
            WITH target AS (
              SELECT oid FROM pg_catalog.pg_roles WHERE rolname = ${role}
            ), granted AS (
              SELECT member_of.oid, member_of.rolname, member_of.rolsuper, member_of.rolbypassrls,
                     member_of.rolreplication, member_of.rolcreaterole
                FROM target
                JOIN pg_catalog.pg_roles member_of
                  ON pg_catalog.pg_has_role(target.oid, member_of.oid, 'MEMBER')
            ), ordinary AS (
              SELECT oid FROM granted WHERE NOT rolsuper
            ), here AS (
              SELECT oid, datdba
                FROM pg_catalog.pg_database
               WHERE datname = pg_catalog.current_database()
            ), slotlock AS (
              SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'slotlock'
            ), reasons (reason) AS (
              SELECT 'superuser' FROM granted WHERE rolsuper
              UNION SELECT 'BYPASSRLS' FROM granted WHERE rolbypassrls
              UNION SELECT 'REPLICATION' FROM granted WHERE rolreplication
              UNION SELECT 'CREATEROLE' FROM granted WHERE rolcreaterole
              UNION SELECT 'member of ' || rolname
                      FROM granted
                     WHERE rolname IN ('pg_execute_server_program',
                                       'pg_read_server_files',
                                       'pg_write_server_files')
              UNION SELECT 'owner of the database'
                      FROM granted, here
                     WHERE here.datdba = granted.oid
              UNION SELECT 'owner of objects in the database'
                      FROM granted, here, pg_catalog.pg_shdepend owned
                     CROSS JOIN LATERAL pg_catalog.pg_identify_object(
                       owned.classid, owned.objid, owned.objsubid
                     ) ident
                     WHERE owned.dbid = here.oid
                       AND owned.deptype = 'o'
                       AND owned.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                       AND owned.refobjid = granted.oid
                       AND owned.classid <> 'pg_catalog.pg_default_acl'::pg_catalog.regclass
                       AND COALESCE(ident.schema, '') !~ '^pg_(toast_)?temp_'
              UNION SELECT 'owner of the btree_gist extension'
                      FROM granted, pg_catalog.pg_extension ext
                     WHERE ext.extname = 'btree_gist' AND ext.extowner = granted.oid
              UNION SELECT 'CREATE on the database'
                      FROM ordinary, here
                     WHERE pg_catalog.has_database_privilege(ordinary.oid, here.oid, 'CREATE')
              UNION SELECT 'owner of or CREATE on schema ' || ns.nspname
                      FROM ordinary, pg_catalog.pg_namespace ns
                     WHERE ns.nspname !~ '^pg_(toast_)?temp_'
                       AND (ns.nspowner = ordinary.oid
                            OR pg_catalog.has_schema_privilege(ordinary.oid, ns.oid, 'CREATE'))
              UNION SELECT 'TRUNCATE, REFERENCES or TRIGGER on a slotlock table'
                      FROM ordinary, slotlock, pg_catalog.pg_class rel
                     WHERE rel.relnamespace = slotlock.oid
                       AND rel.relkind IN ('r', 'p', 'v', 'm', 'f')
                       AND (pg_catalog.has_table_privilege(ordinary.oid, rel.oid, 'TRUNCATE, TRIGGER')
                            OR pg_catalog.has_any_column_privilege(ordinary.oid, rel.oid, 'REFERENCES'))
              UNION SELECT 'TRUNCATE, REFERENCES or TRIGGER by default on new slotlock tables'
                      FROM ordinary, pg_catalog.pg_default_acl def
                     CROSS JOIN LATERAL pg_catalog.aclexplode(def.defaclacl) acl
                     WHERE def.defaclobjtype = 'r'
                       AND pg_catalog.has_schema_privilege(def.defaclrole, (SELECT oid FROM slotlock), 'CREATE')
                       AND (def.defaclnamespace = 0 OR def.defaclnamespace IN (SELECT oid FROM slotlock))
                       AND acl.grantee IN (ordinary.oid, 0)
                       AND acl.privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER')
              UNION SELECT 'a right on server setting ' || setting.parname
                      FROM ordinary, pg_catalog.pg_parameter_acl setting
                     CROSS JOIN LATERAL pg_catalog.aclexplode(setting.paracl) acl
                     WHERE acl.grantee IN (ordinary.oid, 0)
            )
            SELECT EXISTS (SELECT 1 FROM target) AS found,
                   ARRAY(SELECT reason FROM reasons ORDER BY reason) AS reasons`;
          if (!check?.found) {
            throw Object.assign(new Error(`Slotlock application role ${role} does not exist`), {
              code: 'role_not_found' as const,
            });
          }
          if (check.reasons.length > 0) {
            throw Object.assign(
              new Error(
                `Slotlock application role ${role} could get around forced RLS or the exclusion arbiter, itself, through a role it belongs to or through PUBLIC (${check.reasons.join('; ')}); use a plain NOBYPASSRLS login role that owns nothing and can create nothing`,
              ),
              { code: 'unsafe_application_role' as const, reasons: check.reasons },
            );
          }
          await tx.unsafe(ddl);
        })(),
      );
    },

    async withTenant(tenantRef, callback, options) {
      if (!isValidIdentity(tenantRef)) {
        throw Object.assign(new Error('Slotlock tenant reference must be 1-500 UTF-8 bytes'), {
          code: 'invalid_tenant_ref' as const,
        });
      }
      const isolation = options?.isolation;
      if (isolation !== undefined && isolation !== 'read committed') throw invalidIsolationError();
      const actor = options?.actor;
      if (actor !== undefined && !/^[^\u0000-\u001f\u007f]{1,200}$/u.test(actor)) {
        throw Object.assign(new Error('Slotlock actor must be 1-200 characters without control characters'), {
          code: 'invalid_identity' as const,
        });
      }
      const origin = options?.origin;
      if (origin !== undefined && !isSlotlockChangeOrigin(origin)) {
        throw Object.assign(new Error(`Slotlock origin must be one of ${SLOTLOCK_CHANGE_ORIGINS.join(', ')}`), {
          code: 'invalid_identity' as const,
        });
      }
      const keyId = options?.keyId;
      if (keyId !== undefined && !isValidResourceId(keyId)) {
        throw Object.assign(new Error('Slotlock key id must be a UUID'), { code: 'invalid_identity' as const });
      }
      const scope = options?.resourceScope;
      if (scope !== undefined && !isSlotlockResourceScope(scope)) {
        throw Object.assign(new Error('Slotlock resource scope must name locations or groups by reference'), {
          code: 'invalid_identity' as const,
        });
      }
      const release = await tenantSlots?.(tenantRef, options?.signal);
      // A lock timeout leaves the transaction unusable, so the reset below would fail with another
      // error: noted here.
      let timedOut = false;
      return inTransaction(
        sql,
        async (tx) => {
          if (lockTimeout !== undefined) {
            await tx`SELECT set_config('lock_timeout', ${lockTimeout}, true)`;
          }
          if (isolation !== undefined) await assertReadCommitted(tx);
          // Held shared until the transaction ends: suspension and erasure take it exclusively, so
          // they wait for this transaction, and one starting after them sees them (READ COMMITTED).
          const previous = await tx<
            { value: string | null; isolation: string; actor: string | null; origin: string | null; key: string | null }[]
          >`
            SELECT current_setting(${configuredTenantSetting}, true) AS value,
                   current_setting('slotlock.actor', true) AS actor,
                   current_setting('slotlock.origin', true) AS origin,
                   current_setting('slotlock.key_id', true) AS key,
                   current_setting('transaction_isolation') AS isolation,
                   pg_advisory_xact_lock_shared(
                     hashtextextended(${slotlockTenantLockKey(tenantRef)}, 0)
                   ) AS locked`;
          const [context] = await tx<{ suspended: boolean; scope: string | null }[]>`
            SELECT set_config(${configuredTenantSetting}, ${tenantRef}, true) AS tenant,
                   set_config('slotlock.actor', ${actor ?? ''}, true) AS actor,
                   set_config('slotlock.origin', COALESCE(${origin ?? null}::text,
                     NULLIF(current_setting('slotlock.origin', true), ''), 'library'), true) AS origin,
                   set_config('slotlock.key_id', ${keyId ?? ''}, true) AS key,
                   current_setting(${SLOTLOCK_RESOURCE_SCOPE_SETTING}, true) AS scope,
                   slotlock.tenant_suspended(${tenantRef}) AS suspended`.catch((error: unknown) => {
            throw suspensionCheckRefusal(error);
          });
          // A limited key's resources, read in the tenant's context (and within an enclosing
          // scope, if one is set), then held for the rest of the transaction.
          if (scope !== undefined) {
            await tx`
              SELECT set_config(${SLOTLOCK_RESOURCE_SCOPE_SETTING}, '{' || COALESCE((
                       SELECT string_agg(held.id::text, ',' ORDER BY held.id)
                         FROM slotlock.resources held
                        WHERE held.tenant_ref = ${tenantRef}
                          AND ((held.location_ref IS NOT NULL
                                AND slotlock.location_path(held.tenant_ref, held.location_ref)
                                    && pg_catalog.string_to_array(${scope.locations.join(',')}::text, ','))
                               OR EXISTS (
                                 SELECT 1 FROM slotlock.resource_group_members member
                                  WHERE member.tenant_ref = held.tenant_ref AND member.resource_id = held.id
                                    AND member.group_ref = ANY (pg_catalog.string_to_array(${scope.groups.join(',')}::text, ','))))
                     ), '') || '}', true)`;
          }
          // A caller's REPEATABLE READ or SERIALIZABLE snapshot predates the lock, so it may miss a
          // suspension: its writes are refused, reads allowed.
          const refusal =
            context?.suspended === true
              ? tenantSuspendedError
              : previous[0]?.isolation !== 'read committed'
                ? staleSuspensionCheckError
                : null;
          try {
            return await callback(
              buildSlotlockStore(tx, storeOptions, refusal) as SlotlockTenantStore,
            );
          } catch (error) {
            if (pgCode(error) === LOCK_NOT_AVAILABLE) timedOut = true;
            throw error;
          } finally {
            await tx`SELECT set_config(${configuredTenantSetting}, ${previous[0]?.value ?? ''}, true),
                            set_config('slotlock.actor', ${previous[0]?.actor ?? ''}, true),
                            set_config('slotlock.origin', ${previous[0]?.origin ?? ''}, true),
                            set_config('slotlock.key_id', ${previous[0]?.key ?? ''}, true),
                            set_config(${SLOTLOCK_RESOURCE_SCOPE_SETTING}, ${context?.scope ?? ''}, true)`;
          }
        },
        'read committed',
      )
        .catch((error: unknown) => {
          if (lockTimeout !== undefined && (timedOut || pgCode(error) === LOCK_NOT_AVAILABLE)) {
            throw lockTimeoutError(error);
          }
          throw error;
        })
        .finally(() => release?.());
    },

    async createResource(params) {
      assertValidResourceInput(params);
      if (params.profile !== undefined && params.tenantRef === undefined) {
        throw Object.assign(new Error('Slotlock gives a profile only to a resource with a tenant'), {
          code: 'invalid_resource_profile' as const,
        });
      }
      const { profile: given, maxTenantResources: _limit, location, ...identity } = params;
      if (location !== undefined) {
        if (params.tenantRef === undefined) {
          throw Object.assign(new Error('Slotlock gives a location only to a resource with a tenant'), {
            code: 'invalid_location' as const,
            field: 'location',
          });
        }
        slotlockGroupingRef('invalid_location', location);
        // Without a time zone of its own, it takes its location's.
        if (identity.timezone === undefined) {
          const zone = await locationTimezone(sql, params.tenantRef, location);
          if (zone !== null) identity.timezone = zone;
        }
      }
      const upsert = {
        ...identity,
        ...(given !== undefined ? { profile: parseSlotlockResourceProfile(given) } : {}),
        ...(location !== undefined ? { location } : {}),
      };
      const requested = params.maxTenantResources;
      // The lower of the store's own limit and the tenant's plan (plans.ts), when it has one.
      const planned =
        params.tenantRef === undefined
          ? undefined
          : (
              await sql<{ max_resources: number }[]>`
                SELECT max_resources FROM slotlock.tenant_plan(${params.tenantRef}::text)`.catch(
                (error: unknown) => {
                  throw slotlockPlanReadRefusal(error);
                },
              )
            )[0]?.max_resources;
      const storeLimit = params.tenantRef === undefined ? undefined : configuredTenantLimits.resources;
      const configured =
        planned === undefined
          ? storeLimit
          : storeLimit === undefined
            ? planned
            : Math.min(planned, storeLimit);
      if (requested === undefined && configured === undefined) {
        if (location === undefined) return upsertResource(sql, upsert);
        return guardedWrite(sql, (tx) => upsertResource(tx, upsert), RESOURCE_LOCATION_MISSING);
      }
      if (
        requested !== undefined &&
        (!Number.isSafeInteger(requested) ||
          requested < 1 ||
          requested > MAX_TENANT_RESOURCE_LIMIT ||
          params.tenantRef === undefined ||
          params.externalRef === undefined)
      ) {
        throw Object.assign(
          new Error(
            `Slotlock maxTenantResources must be a whole number from 1 to ${MAX_TENANT_RESOURCE_LIMIT}, for a tenant-owned resource`,
          ),
          { code: 'invalid_resource_limit' as const },
        );
      }
      const max =
        requested === undefined
          ? (configured as number)
          : configured === undefined
            ? requested
            : Math.min(requested, configured);
      const tenantRef = params.tenantRef as string;
      const externalRef = params.externalRef ?? null;
      return inTransaction(
        sql,
        async (tx) => {
          await assertReadCommitted(tx);
          // An object, so the key never equals a [tenantRef, externalRef] identity lock's.
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify({ resourceCount: tenantRef })}, 0))`;
          // READ COMMITTED: each statement below sees every create committed before the lock.
          // Re-creating a known reference adds none.
          const known =
            externalRef === null
              ? []
              : await tx<{ id: string }[]>`
                  SELECT id FROM slotlock.resources
                   WHERE tenant_ref = ${tenantRef} AND external_ref = ${externalRef}`;
          if (known.length === 0) {
            const [counted] = await tx<{ count: string }[]>`
              SELECT count(*) AS count FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
            if (Number(counted?.count ?? 0) >= max) {
              throw Object.assign(
                new Error(`Slotlock tenant already has ${max} resources, the most allowed here`),
                { code: 'resource_limit_reached' as const, limit: max },
              );
            }
          }
          if (location === undefined) return upsertResource(tx, upsert);
          return guardedWrite(tx, (inner) => upsertResource(inner, upsert), RESOURCE_LOCATION_MISSING);
        },
        'read committed',
      );
    },

    async getResource(params) {
      assertValidVisibility(params.visibility);
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.id)) {
        throw Object.assign(new Error('Slotlock resource identity is invalid'), {
          code: 'invalid_identity' as const,
        });
      }
      const rows = await sql<ResourceRow[]>`
        SELECT ${sql.unsafe(RESOURCE_COLUMNS)}, ${sql.unsafe(EFFECTIVE_BOOKING_RULES)}
          FROM slotlock.resources
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
           AND (${params.visibility ?? null}::text IS NULL OR visibility = ${params.visibility ?? null})`;
      const row = rows[0];
      return row ? toResource(row) : null;
    },

    async updateResourceProfile(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.id)) {
        throw Object.assign(new Error('Slotlock resource identity is invalid'), {
          code: 'invalid_identity' as const,
        });
      }
      const profile = profileParameters(parseSlotlockResourceProfile(params.profile));
      const location =
        params.location === undefined || params.location === null
          ? null
          : slotlockGroupingRef('invalid_location', params.location);
      const rows = await guardedWrite(sql, (tx) => tx<ResourceRow[]>`
        UPDATE slotlock.resources
           SET name = CASE WHEN ${profile.setName}::boolean THEN ${profile.name}::text ELSE name END,
               description = CASE WHEN ${profile.setDescription}::boolean
                                  THEN ${profile.description}::text ELSE description END,
               kind = CASE WHEN ${profile.setKind}::boolean THEN ${profile.kind}::text ELSE kind END,
               capacity = CASE WHEN ${profile.setCapacity}::boolean
                               THEN ${profile.capacity}::integer ELSE capacity END,
               labels = CASE WHEN ${profile.setLabels}::boolean
                             THEN pg_catalog.string_to_array(${profile.labels}::text, ',') ELSE labels END,
               attributes = CASE WHEN ${profile.setAttributes}::boolean
                                 THEN ${profile.attributes}::text::jsonb ELSE attributes END,
               location_ref = CASE WHEN ${params.location !== undefined}::boolean
                                   THEN ${location}::text ELSE location_ref END
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
        RETURNING ${tx.unsafe(RESOURCE_COLUMNS)}, ${tx.unsafe(EFFECTIVE_BOOKING_RULES)}`, RESOURCE_LOCATION_MISSING);
      const row = rows[0];
      return row ? toResource(row) : null;
    },

    async listLocations(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const rows = await sql<LocationRow[]>`
        WITH RECURSIVE tree(ref, name, parent_ref, timezone, path) AS (
          SELECT place.ref, place.name, place.parent_ref, place.timezone, ARRAY[place.ref]
            FROM slotlock.locations place
           WHERE place.tenant_ref = ${params.tenantRef} AND place.parent_ref IS NULL
          UNION ALL
          SELECT place.ref, place.name, place.parent_ref, place.timezone, tree.path || place.ref
            FROM slotlock.locations place
            JOIN tree ON place.tenant_ref = ${params.tenantRef} AND place.parent_ref = tree.ref
           WHERE cardinality(tree.path) <= ${SLOTLOCK_MAX_LOCATION_DEPTH}
        )
        SELECT tree.ref, tree.name, tree.parent_ref, tree.timezone,
               (SELECT count(*) FROM slotlock.resources held
                 WHERE held.tenant_ref = ${params.tenantRef} AND held.location_ref = tree.ref)::int AS resources
          FROM tree
         ORDER BY tree.path
         LIMIT ${SLOTLOCK_MAX_LOCATIONS}`;
      return rows.map(toLocation);
    },

    async putLocation(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const location = parseSlotlockLocation(params);
      const [row] = await guardedWrite(sql, (tx) => tx<LocationRow[]>`
        INSERT INTO slotlock.locations AS kept (tenant_ref, ref, name, parent_ref, timezone)
        VALUES (${params.tenantRef}, ${location.ref}, ${location.name ?? ''}, ${location.parentRef ?? null},
                ${location.timezone ?? null})
        ON CONFLICT (tenant_ref, ref) DO UPDATE
        SET name = EXCLUDED.name,
            parent_ref = CASE WHEN ${location.parentRef !== undefined}::boolean
                              THEN EXCLUDED.parent_ref ELSE kept.parent_ref END,
            timezone = CASE WHEN ${location.timezone !== undefined}::boolean
                            THEN EXCLUDED.timezone ELSE kept.timezone END
        RETURNING kept.ref, kept.name, kept.parent_ref, kept.timezone,
                  (SELECT count(*) FROM slotlock.resources held
                    WHERE held.tenant_ref = kept.tenant_ref AND held.location_ref = kept.ref)::int AS resources`,
        { slotlock_locations_parent_fkey: 'location_not_found' },
      );
      return toLocation(row as LocationRow);
    },

    async updateLocation(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const location = parseSlotlockLocation(params);
      const [row] = await guardedWrite(sql, (tx) => tx<LocationRow[]>`
        UPDATE slotlock.locations AS kept
           SET name = COALESCE(${location.name ?? null}::text, kept.name),
               parent_ref = CASE WHEN ${location.parentRef !== undefined}::boolean
                                 THEN ${location.parentRef ?? null}::text ELSE kept.parent_ref END,
               timezone = CASE WHEN ${location.timezone !== undefined}::boolean
                               THEN ${location.timezone ?? null}::text ELSE kept.timezone END
         WHERE kept.tenant_ref = ${params.tenantRef} AND kept.ref = ${location.ref}
        RETURNING kept.ref, kept.name, kept.parent_ref, kept.timezone,
                  (SELECT count(*) FROM slotlock.resources held
                    WHERE held.tenant_ref = kept.tenant_ref AND held.location_ref = kept.ref)::int AS resources`,
        { slotlock_locations_parent_fkey: 'location_not_found' },
      );
      return row ? toLocation(row) : null;
    },

    async deleteLocation(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const ref = slotlockGroupingRef('invalid_location', params.ref);
      const rows = await guardedWrite(
        sql,
        (tx) => tx<{ ref: string }[]>`
          DELETE FROM slotlock.locations
           WHERE tenant_ref = ${params.tenantRef} AND ref = ${ref}
          RETURNING ref`,
        {
          slotlock_locations_parent_fkey: 'location_in_use',
          slotlock_resources_location_fkey: 'location_in_use',
        },
      );
      return rows.length > 0;
    },

    async listGroups(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const rows = await sql<GroupRow[]>`
        SELECT kept.ref, kept.name, kept.description,
               (SELECT count(*) FROM slotlock.resource_group_members member
                 WHERE member.tenant_ref = kept.tenant_ref AND member.group_ref = kept.ref)::int AS members
          FROM slotlock.resource_groups kept
         WHERE kept.tenant_ref = ${params.tenantRef}
         ORDER BY kept.ref
         LIMIT ${SLOTLOCK_MAX_RESOURCE_GROUPS}`;
      return rows.map(toGroup);
    },

    async putGroup(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const group = parseSlotlockResourceGroup(params);
      const [row] = await guardedWrite(sql, (tx) => tx<GroupRow[]>`
        INSERT INTO slotlock.resource_groups AS kept (tenant_ref, ref, name, description)
        VALUES (${params.tenantRef}, ${group.ref}, ${group.name}, ${group.description})
        ON CONFLICT (tenant_ref, ref) DO UPDATE
        SET name = EXCLUDED.name,
            description = CASE WHEN ${params.description !== undefined}::boolean
                               THEN EXCLUDED.description ELSE kept.description END
        RETURNING kept.ref, kept.name, kept.description,
                  (SELECT count(*) FROM slotlock.resource_group_members member
                    WHERE member.tenant_ref = kept.tenant_ref AND member.group_ref = kept.ref)::int AS members`);
      return toGroup(row as GroupRow);
    },

    async deleteGroup(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const ref = slotlockGroupingRef('invalid_group', params.ref);
      const rows = await sql<{ ref: string }[]>`
        DELETE FROM slotlock.resource_groups
         WHERE tenant_ref = ${params.tenantRef} AND ref = ${ref}
        RETURNING ref`;
      return rows.length > 0;
    },

    async addGroupMember(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const group = slotlockGroupingRef('invalid_group', params.group);
      if (!isValidResourceId(params.resourceId)) {
        throw Object.assign(new Error('Slotlock resource not found in this tenant'), {
          code: 'resource_not_found' as const,
        });
      }
      const rows = await guardedWrite(
        sql,
        (tx) => tx<{ added: boolean }[]>`
          INSERT INTO slotlock.resource_group_members (tenant_ref, group_ref, resource_id)
          VALUES (${params.tenantRef}, ${group}, ${params.resourceId}::uuid)
          ON CONFLICT DO NOTHING
          RETURNING true AS added`,
        {
          slotlock_resource_group_members_group_fkey: 'group_not_found',
          slotlock_resource_group_members_resource_fkey: 'resource_not_found',
        },
      );
      return rows.length > 0;
    },

    async removeGroupMember(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const group = slotlockGroupingRef('invalid_group', params.group);
      if (!isValidResourceId(params.resourceId)) return false;
      const rows = await sql<{ group_ref: string }[]>`
        DELETE FROM slotlock.resource_group_members
         WHERE tenant_ref = ${params.tenantRef} AND group_ref = ${group}
           AND resource_id = ${params.resourceId}::uuid
        RETURNING group_ref`;
      return rows.length > 0;
    },

    async setResourceAvailability(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.id)) {
        throw Object.assign(new Error('Slotlock resource identity is invalid'), {
          code: 'invalid_identity' as const,
        });
      }
      const rules = availabilityParameter(sql, params.rules);
      const rows = await sql<ResourceRow[]>`
        UPDATE slotlock.resources
           SET availability_rules = ${rules}::jsonb
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
        RETURNING ${sql.unsafe(RESOURCE_COLUMNS)}, ${sql.unsafe(EFFECTIVE_BOOKING_RULES)}`;
      const row = rows[0];
      return row ? toResource(row) : null;
    },

    async setResourceBookingRules(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.id)) {
        throw Object.assign(new Error('Slotlock resource identity is invalid'), {
          code: 'invalid_identity' as const,
        });
      }
      let rules: SlotlockBookingRules | null = null;
      if (params.rules !== null) {
        try {
          rules = parseBookingRules(params.rules);
        } catch (error) {
          throw Object.assign(new Error((error as Error).message), {
            code: 'invalid_booking_rules' as const,
          });
        }
      }
      const rows = await sql<ResourceRow[]>`
        UPDATE slotlock.resources
           SET booking_rules = ${rules === null ? null : sql.json({ ...rules })}::jsonb,
               -- Kept while check-in stays asked for, from the moment it first was; cleared without.
               check_in_since = CASE
                 WHEN ${rules?.checkInMinutes ?? null}::int IS NULL THEN NULL
                 WHEN booking_rules ? 'checkInMinutes' THEN COALESCE(check_in_since, statement_timestamp())
                 ELSE statement_timestamp()
               END
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
        RETURNING ${sql.unsafe(RESOURCE_COLUMNS)}, ${sql.unsafe(EFFECTIVE_BOOKING_RULES)}`;
      const row = rows[0];
      return row ? toResource(row) : null;
    },

    async setBookingRuleDefaults(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      if (params.pool !== null && !isPoolName(params.pool)) throw invalidPoolError();
      const pool = params.pool ?? '';
      if (params.rules === null) {
        await sql`
          DELETE FROM slotlock.booking_rule_defaults
           WHERE tenant_ref = ${params.tenantRef} AND pool_ref = ${pool}`;
        return null;
      }
      let rules: SlotlockBookingRules;
      try {
        rules = parseBookingRuleDefaults(params.rules);
      } catch (error) {
        throw Object.assign(new Error((error as Error).message), {
          code: 'invalid_booking_rules' as const,
        });
      }
      const tenantRef = params.tenantRef;
      return inTransaction(sql, async (tx) => {
        if (pool !== '') {
          // Counted under the tenant's lock, which only READ COMMITTED makes see every committed
          // row.
          await assertReadCommitted(tx);
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`slotlock:rule-defaults:${tenantRef}`}, 0))`;
          const [counted] = await tx<{ pools: number; exists: boolean }[]>`
            SELECT count(*)::int AS pools, bool_or(pool_ref = ${pool}) IS TRUE AS exists
              FROM slotlock.booking_rule_defaults
             WHERE tenant_ref = ${tenantRef} AND pool_ref <> ''`;
          if (!counted?.exists && (counted?.pools ?? 0) >= SLOTLOCK_MAX_POOL_RULE_DEFAULTS) {
            throw Object.assign(
              new Error(`Slotlock keeps default booking rules for at most ${SLOTLOCK_MAX_POOL_RULE_DEFAULTS} pools a tenant`),
              { code: 'pool_rules_limit_reached' as const, limit: SLOTLOCK_MAX_POOL_RULE_DEFAULTS },
            );
          }
        }
        await tx`
          INSERT INTO slotlock.booking_rule_defaults (tenant_ref, pool_ref, rules)
          VALUES (${tenantRef}, ${pool}, ${tx.json({ ...rules })}::jsonb)
          ON CONFLICT (tenant_ref, pool_ref)
          DO UPDATE SET rules = EXCLUDED.rules, updated_at = statement_timestamp()`;
        return rules;
      });
    },

    async getBookingRuleDefaults(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const rows = await sql<{ pool_ref: string; rules: unknown }[]>`
        SELECT pool_ref, rules FROM slotlock.booking_rule_defaults
         WHERE tenant_ref = ${params.tenantRef}
         ORDER BY pool_ref
         LIMIT ${SLOTLOCK_MAX_POOL_RULE_DEFAULTS + 1}`;
      const defaults: SlotlockBookingRuleDefaults = { tenant: null, pools: {} };
      for (const row of rows) {
        const rules = storedBookingRules(row.rules);
        if (row.pool_ref === '') defaults.tenant = rules;
        else defaults.pools[row.pool_ref] = rules;
      }
      return defaults;
    },

    async setResourcePool(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.id)) {
        throw Object.assign(new Error('Slotlock resource identity is invalid'), {
          code: 'invalid_identity' as const,
        });
      }
      if (params.pool !== null && !isPoolName(params.pool)) throw invalidPoolError();
      const rows = await sql<ResourceRow[]>`
        UPDATE slotlock.resources SET pool_ref = ${params.pool}
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
        RETURNING ${sql.unsafe(RESOURCE_COLUMNS)}, ${sql.unsafe(EFFECTIVE_BOOKING_RULES)}`;
      const row = rows[0];
      return row ? toResource(row) : null;
    },

    async setResourceParent(params) {
      if (
        !isValidIdentity(params.tenantRef) ||
        !isValidResourceId(params.id) ||
        (params.parentId !== null && !isValidResourceId(params.parentId))
      ) {
        throw Object.assign(new Error('Slotlock resource identity is invalid'), {
          code: 'invalid_identity' as const,
        });
      }
      if (params.parentId === params.id) {
        throw Object.assign(new Error('Slotlock resource cannot be a part of itself'), { code: 'composite_too_deep' as const });
      }
      const rows = await guardedWrite(
        sql,
        (tx) => tx<ResourceRow[]>`
          UPDATE slotlock.resources SET parent_id = ${params.parentId}::uuid
           WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
          RETURNING ${tx.unsafe(RESOURCE_COLUMNS)}, ${tx.unsafe(EFFECTIVE_BOOKING_RULES)}`,
        { slotlock_resources_parent_fkey: 'parent_not_found' },
      );
      const row = rows[0];
      return row ? toResource(row) : null;
    },

    async listPoolMembers(params) {
      if (!isValidIdentity(params.tenantRef)) throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      if (!isPoolName(params.pool)) throw invalidPoolError();
      const rows = await sql<ResourceRow[]>`
        SELECT ${sql.unsafe(RESOURCE_COLUMNS)}, ${sql.unsafe(EFFECTIVE_BOOKING_RULES)}
          FROM slotlock.resources
         WHERE tenant_ref = ${params.tenantRef} AND pool_ref = ${params.pool}
           AND archived_at IS NULL
           AND (${params.visibility ?? null}::text IS NULL OR visibility = ${params.visibility ?? null})
         ORDER BY id
         LIMIT ${SLOTLOCK_MAX_POOL_MEMBERS}`;
      const members = rows.map(toResource);
      if (params.ordered !== true || members.length < 2) return members;
      let [settings] = await sql<{ member_order: SlotlockPoolOrder; last_member: string | null }[]>`
        SELECT member_order, last_member::text FROM slotlock.pool_settings
         WHERE tenant_ref = ${params.tenantRef} AND pool_ref = ${params.pool}`;
      if (settings?.member_order === 'round_robin' && params.forBooking === true) {
        // Read again under the row's lock, held until the booking commits with the place it noted.
        [settings] = await sql<{ member_order: SlotlockPoolOrder; last_member: string | null }[]>`
          SELECT member_order, last_member::text FROM slotlock.pool_settings
           WHERE tenant_ref = ${params.tenantRef} AND pool_ref = ${params.pool}
           FOR UPDATE`;
      }
      if (settings?.member_order === 'round_robin') {
        // From the first member after the one booked last, by id, round to the start.
        const after = settings.last_member;
        const next = after === null ? 0 : members.findIndex((member) => member.id > after);
        const start = next < 0 ? 0 : next;
        return [...members.slice(start), ...members.slice(0, start)];
      }
      if (settings?.member_order === 'least_booked') {
        // Bookings made on each in the last 30 days, holds and cancelled ones not counted.
        const counts = await sql<{ resource_id: string; booked: number }[]>`
          SELECT booked.resource_id::text, count(*)::int AS booked
            FROM slotlock.reservations booked
           WHERE booked.tenant_ref = ${params.tenantRef}
             AND booked.resource_id = ANY (${members.map((member) => member.id)}::uuid[])
             AND booked.status = 'confirmed'
             AND booked.created_at > statement_timestamp() - interval '30 days'
           GROUP BY booked.resource_id`;
        const booked = new Map(counts.map((row) => [row.resource_id, Number(row.booked)]));
        // Stable among equals: by id, as the database orders them.
        return [...members].sort(
          (a, b) => (booked.get(a.id) ?? 0) - (booked.get(b.id) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      }
      return members;
    },

    async listPools(params) {
      if (!isValidIdentity(params.tenantRef)) throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      const rows = await sql<{ pool: string; capacity: number; member_order: SlotlockPoolOrder }[]>`
        SELECT pool_ref AS pool, count(*)::int AS capacity,
               COALESCE((SELECT settings.member_order FROM slotlock.pool_settings settings
                          WHERE settings.tenant_ref = ${params.tenantRef}
                            AND settings.pool_ref = resources.pool_ref), 'stable') AS member_order
          FROM slotlock.resources
         WHERE tenant_ref = ${params.tenantRef} AND pool_ref IS NOT NULL AND archived_at IS NULL
           AND (${params.visibility ?? null}::text IS NULL OR visibility = ${params.visibility ?? null})
         GROUP BY pool_ref
         ORDER BY pool_ref
         LIMIT 1000`;
      return rows.map((row) => ({ pool: row.pool, capacity: row.capacity, order: row.member_order }));
    },

    async setPoolOrder(params) {
      if (!isValidIdentity(params.tenantRef)) throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      if (!isPoolName(params.pool)) throw invalidPoolError();
      if (!(SLOTLOCK_POOL_ORDERS as readonly string[]).includes(params.order)) {
        throw Object.assign(new Error(`Slotlock pool order must be one of ${SLOTLOCK_POOL_ORDERS.join(', ')}`), {
          code: 'invalid_pool_order' as const,
        });
      }
      // At most SLOTLOCK_MAX_POOL_SETTINGS pools a tenant (pool_settings_guard).
      await guardedWrite(sql, (tx) => tx`
        INSERT INTO slotlock.pool_settings (tenant_ref, pool_ref, member_order)
        VALUES (${params.tenantRef}, ${params.pool}, ${params.order})
        ON CONFLICT (tenant_ref, pool_ref)
        DO UPDATE SET member_order = EXCLUDED.member_order, updated_at = statement_timestamp()`);
      return params.order;
    },

    async notePoolBooking(params) {
      if (!isValidIdentity(params.tenantRef)) throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      if (!isPoolName(params.pool) || !isValidResourceId(params.resourceId)) return;
      // Only a pool that goes round keeps its place; another has nothing to note.
      await sql`
        UPDATE slotlock.pool_settings
           SET last_member = ${params.resourceId}::uuid, updated_at = statement_timestamp()
         WHERE tenant_ref = ${params.tenantRef} AND pool_ref = ${params.pool}
           AND member_order = 'round_robin'`;
    },

    async setTenantAvailability(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw Object.assign(new Error('Slotlock tenant reference must be 1-500 UTF-8 bytes'), {
          code: 'invalid_identity' as const,
        });
      }
      const rules = availabilityParameter(sql, params.rules);
      const updated = await sql`
        UPDATE slotlock.resources
           SET availability_rules = ${rules}::jsonb
         WHERE tenant_ref = ${params.tenantRef}`;
      return updated.count;
    },

    async listResources(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw Object.assign(new Error('Slotlock tenant reference must be 1-500 UTF-8 bytes'), {
          code: 'invalid_identity' as const,
        });
      }
      const limit = params.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RESOURCE_LIST_LIMIT) {
        throw Object.assign(new Error('Slotlock resource list limit must be 1-1000'), {
          code: 'invalid_limit' as const,
        });
      }
      if (params.after !== undefined && !isValidResourceId(params.after)) {
        throw Object.assign(new Error('Slotlock resource cursor is invalid'), {
          code: 'invalid_cursor' as const,
        });
      }
      // The filters are checked as a profile is, so a bad one is refused rather than matching none.
      const place = params.location === undefined ? null : slotlockGroupingRef('invalid_location', params.location);
      const group = params.group === undefined ? null : slotlockGroupingRef('invalid_group', params.group);
      if (params.pool !== undefined && !isPoolName(params.pool)) throw invalidPoolError();
      const pool = params.pool ?? null;
      const filter = parseSlotlockResourceProfile({
        ...(params.kind !== undefined ? { kind: params.kind } : {}),
        ...(params.labels !== undefined ? { labels: params.labels } : {}),
      });
      const rows = await sql<ResourceRow[]>`
        SELECT ${sql.unsafe(RESOURCE_COLUMNS)}, ${sql.unsafe(EFFECTIVE_BOOKING_RULES)}
          FROM slotlock.resources
         WHERE tenant_ref = ${params.tenantRef}
           AND (${params.visibility ?? null}::text IS NULL OR visibility = ${params.visibility ?? null})
           AND (${params.includeArchived === true} OR archived_at IS NULL)
           AND (${params.after ?? null}::uuid IS NULL OR id > ${params.after ?? null}::uuid)
           AND (${filter.kind ?? null}::text IS NULL OR kind = ${filter.kind ?? null}::text)
           AND (${filter.labels === undefined || filter.labels.length === 0 ? null : filter.labels.join(',')}::text IS NULL
                OR labels @> pg_catalog.string_to_array(${filter.labels?.join(',') ?? ''}::text, ','))
           AND (${place}::text IS NULL OR location_ref IN (
                 WITH RECURSIVE below(ref, steps) AS (
                   SELECT place.ref, 1 FROM slotlock.locations place
                    WHERE place.tenant_ref = ${params.tenantRef} AND place.ref = ${place}::text
                   UNION ALL
                   SELECT place.ref, below.steps + 1
                     FROM slotlock.locations place
                     JOIN below ON place.tenant_ref = ${params.tenantRef} AND place.parent_ref = below.ref
                    WHERE below.steps <= ${SLOTLOCK_MAX_LOCATION_DEPTH}
                 )
                 SELECT ref FROM below))
           AND (${group}::text IS NULL OR EXISTS (
                 SELECT 1 FROM slotlock.resource_group_members member
                  WHERE member.tenant_ref = resources.tenant_ref AND member.resource_id = resources.id
                    AND member.group_ref = ${group}::text))
           AND (${pool}::text IS NULL OR pool_ref = ${pool}::text)
         ORDER BY id
         LIMIT ${limit}`;
      return rows.map(toResource);
    },

    async readUsage(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      return readSlotlockTenantUsage(sql, params.tenantRef, params.from, params.to);
    },

    async rollUpUsage(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const limit = params.limit ?? 5_000;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
        throw Object.assign(new Error('Slotlock usage roll-up limit must be 1-100,000'), {
          code: 'invalid_limit' as const,
        });
      }
      const [result] = await sql<{ read: number }[]>`
        SELECT slotlock.roll_up_usage(${params.tenantRef}::text, ${limit}::integer) AS read`;
      return result?.read ?? 0;
    },

    async countResources(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw Object.assign(new Error('Slotlock tenant reference must be 1-500 UTF-8 bytes'), {
          code: 'invalid_identity' as const,
        });
      }
      const [counted] = await sql<{ count: string }[]>`
        SELECT count(*) AS count FROM slotlock.resources WHERE tenant_ref = ${params.tenantRef}`;
      return Number(counted?.count ?? 0);
    },

    async archiveResource(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.id)) {
        throw invalidIdentityError('Slotlock resource identity is invalid');
      }
      // Clock time, not transaction start: a booking that committed holding the row's share lock
      // went in before this.
      const [row] = await sql<ResourceRow[]>`
        UPDATE slotlock.resources
           SET archived_at = COALESCE(archived_at, clock_timestamp())
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
        RETURNING ${sql.unsafe(RESOURCE_COLUMNS)}, ${sql.unsafe(EFFECTIVE_BOOKING_RULES)}`;
      return row ? toResource(row) : null;
    },

    async restoreResource(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.id)) {
        throw invalidIdentityError('Slotlock resource identity is invalid');
      }
      const [row] = await sql<ResourceRow[]>`
        UPDATE slotlock.resources
           SET archived_at = NULL
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
        RETURNING ${sql.unsafe(RESOURCE_COLUMNS)}, ${sql.unsafe(EFFECTIVE_BOOKING_RULES)}`;
      return row ? toResource(row) : null;
    },

    async deleteResource(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.id)) {
        throw invalidIdentityError('Slotlock resource identity is invalid');
      }
      return inTransaction(sql, async (tx): Promise<DeleteResourceResult> => {
        // The row lock waits for writers holding its share lock and keeps new ones out until done.
        const [resource] = await tx<{ id: string }[]>`
          SELECT id FROM slotlock.resources
           WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
           FOR UPDATE`;
        if (!resource) return { ok: true, deleted: false };
        const [live] = await tx<{ live: boolean }[]>`
          SELECT EXISTS (
                   SELECT 1 FROM slotlock.reservations
                    WHERE resource_id = ${params.id}
                      AND calendar_event_id IS NULL
                      AND (CASE WHEN status = 'held' THEN expires_at > statement_timestamp()
                                ELSE COALESCE(occupied_ends_at, ends_at) > now() END)
                 )
                 OR EXISTS (
                   SELECT 1 FROM slotlock.calendar_events
                    WHERE tenant_ref = ${params.tenantRef} AND resource_id = ${params.id}
                      AND (recurrence_rule IS NOT NULL OR ends_at > now())
                 ) AS live`;
        if (live?.live) return { ok: false, code: 'resource_in_use' };
        // Reservations, events and their children, coverage and hold answers all cascade from the
        // resource.
        await tx`DELETE FROM slotlock.resources WHERE id = ${params.id}`;
        return { ok: true, deleted: true };
      });
    },

    async createReservation(params) {
      if (!isFiniteWindow({ start: params.start, end: params.end })) {
        return { ok: false, code: 'invalid_window' };
      }
      if (!isValidResourceId(params.resourceId)) return { ok: false, code: 'resource_not_found' };
      if (params.tenantRef !== undefined && !isValidIdentity(params.tenantRef)) {
        return { ok: false, code: 'resource_not_found' };
      }
      // A booking on a tenant's resource takes the tenant and its own id as reference; one on a
      // tenantless resource stays tenantless.
      const id = randomUUID();
      let bufferBeforeMs = 0;
      let bufferAfterMs = 0;
      for (let attempt = 1; ; attempt++) {
        try {
          return await inTransaction(sql, async (tx): Promise<CreateReservationResult> => {
            const bookingLimit = await tenantLimitReached(
              tx,
              await limitTenant(tx, 'reservations', params.resourceId, params.tenantRef),
              'reservations',
            );
            const resource = await readResourceForWrite(tx, params.resourceId, params.tenantRef ?? null);
            if (!resource) return { ok: false, code: 'resource_not_found' };
            if (resource.archived) return { ok: false, code: 'resource_archived' };
            if (bookingLimit !== null && resource.tenant_ref !== null) {
              return { ok: false, code: 'reservation_limit_reached', limit: bookingLimit };
            }
            const ruling = await bookingRuling(tx, params.resourceId, params, defaultHours);
            if (ruling.rule) return { ok: false, code: 'booking_rule_violated', rule: ruling.rule };
            bufferBeforeMs = ruling.bufferBeforeMs;
            bufferAfterMs = ruling.turnaroundMs;
            const occupied = occupiedTime({ ...params, bufferBeforeMs, bufferAfterMs });
            if (
              resource.tenant_ref !== null &&
              !(await recurrenceCoversWrite(tx, {
                tenantRef: resource.tenant_ref,
                resourceId: params.resourceId,
                ...occupied,
              }))
            ) {
              return { ok: false, code: 'recurrence_not_materialized' };
            }
            // Writers to this resource take turns from here to the insert (lockResourceForWrite).
            const locked = await lockResourceForWrite(tx, params.resourceId, params.tenantRef ?? null);
            if (!locked) return { ok: false, code: 'resource_not_found' };
            if (locked.archived) return { ok: false, code: 'resource_archived' };
            await reapExpiredHolds(tx, params.resourceId, occupied.start, occupied.end);
            const [row] = await tx<ReservationRow[]>`
              INSERT INTO slotlock.reservations (
                id, resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms,
                buffer_before_ms, source
              ) VALUES (
                ${id}, ${params.resourceId}, ${resource.tenant_ref},
                ${resource.tenant_ref === null ? null : id},
                ${params.start}, ${params.end}, ${ruling.turnaroundMs}, ${ruling.bufferBeforeMs},
                ${params.source ?? null}
              )
              RETURNING id, resource_id, tenant_ref, external_ref, starts_at, ends_at,
                        buffer_after_ms, revision, source`;
            if (!row) throw new Error('slotlock: reservation insert returned no row');
            return { ok: true, reservation: toReservation(row) };
          });
        } catch (err) {
          const code = pgCode(err);
          if ((code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE) && attempt === 1) {
            continue; // fully rolled back: one retry wins or loses with a clean 23P01
          }
          if (
            code !== EXCLUSION_VIOLATION &&
            code !== DEADLOCK_DETECTED &&
            code !== SERIALIZATION_FAILURE
          ) {
            throw err;
          }
          // A second contention abort is a structured loss too (possibly with a null winner), never
          // a raw throw.
          const occupied = occupiedTime({ ...params, bufferBeforeMs, bufferAfterMs });
          await rollSeriesBehind(sql, params.resourceId, occupied.start, occupied.end);
          return overlapLoss(
            sql,
            params.resourceId,
            params.start,
            params.end,
            bufferAfterMs,
            undefined,
            undefined,
            bufferBeforeMs,
          );
        }
      }
    },

    async createExternalReservation(params) {
      const invalid = validateExternalCommand(params);
      if (invalid) return invalid;
      if (params.revision !== 1) return { ok: false, code: 'invalid_revision' };
      let written = params.bufferAfterMs;
      let writtenBefore = 0;
      for (let attempt = 1; ; attempt++) {
        try {
          return await inTransaction(sql, async (tx): Promise<ExternalReservationResult> => {
            await lockExternalIdentity(tx, params.tenantRef, params.externalRef);
            const cancelled = await tx<{ revision: string | number }[]>`
              SELECT revision FROM slotlock.reservation_tombstones
               WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}`;
            if (cancelled[0]) return { ok: false, code: 'reservation_cancelled' };
            // A calendar event's occupation carries a reference in this namespace too, but it is
            // not a booking: create, reschedule and cancel treat it as a reference no booking
            // holds.
            const existing = await tx<ReservationRow[]>`
              SELECT id, resource_id, tenant_ref, external_ref, starts_at, ends_at,
                     buffer_after_ms, revision, source
                FROM slotlock.reservations
               WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}
                 AND calendar_event_id IS NULL
               FOR UPDATE`;
            const found = existing[0];
            const ruling = await bookingRuling(tx, params.resourceId, params, defaultHours);
            if (found) {
              // Moved on since: a delayed create is stale, as a delayed move is.
              if (params.revision < Number(found.revision)) {
                return { ok: false, code: 'stale_revision' };
              }
              if (!sameExternalPayload(found, params, ruling.turnaroundMs)) {
                return { ok: false, code: 'idempotency_conflict' };
              }
              return { ok: true, reservation: toReservation(found), idempotent: true };
            }
            const bookingLimit = await tenantLimitReached(tx, params.tenantRef, 'reservations');
            const resourceState = await tenantResourceState(tx, params.resourceId, params.tenantRef);
            if (resourceState === 'missing') return { ok: false, code: 'resource_tenant_mismatch' };
            if (resourceState === 'archived') return { ok: false, code: 'resource_archived' };
            if (bookingLimit !== null) {
              return { ok: false, code: 'reservation_limit_reached', limit: bookingLimit };
            }
            if (ruling.rule) return { ok: false, code: 'booking_rule_violated', rule: ruling.rule };
            const bufferAfterMs = Math.max(params.bufferAfterMs, ruling.turnaroundMs);
            written = bufferAfterMs;
            writtenBefore = ruling.bufferBeforeMs;
            const occupied = occupiedTime({ ...params, bufferBeforeMs: writtenBefore, bufferAfterMs });
            if (
              !(await recurrenceCoversWrite(tx, {
                tenantRef: params.tenantRef,
                resourceId: params.resourceId,
                ...occupied,
              }))
            ) {
              return { ok: false, code: 'recurrence_not_materialized' };
            }
            // Writers to this resource take turns from here to the insert (lockResourceForWrite).
            const locked = await lockResourceForWrite(tx, params.resourceId, params.tenantRef);
            if (!locked) return { ok: false, code: 'resource_tenant_mismatch' };
            if (locked.archived) return { ok: false, code: 'resource_archived' };
            await reapExpiredHolds(tx, params.resourceId, occupied.start, occupied.end);
            const rows = await tx<ReservationRow[]>`
              INSERT INTO slotlock.reservations (
                resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms,
                buffer_before_ms, revision, source
              ) VALUES (
                ${params.resourceId}, ${params.tenantRef}, ${params.externalRef}, ${params.start},
                ${params.end}, ${bufferAfterMs}, ${writtenBefore}, ${params.revision},
                ${params.source ?? null}
              )
              RETURNING id, resource_id, tenant_ref, external_ref, starts_at, ends_at,
                        buffer_after_ms, revision, source`;
            const row = rows[0];
            if (!row) throw new Error('slotlock: external reservation insert returned no row');
            return { ok: true, reservation: toReservation(row), idempotent: false };
          });
        } catch (err) {
          const code = pgCode(err);
          if ((code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE) && attempt === 1) {
            continue;
          }
          if (
            code !== EXCLUSION_VIOLATION &&
            code !== DEADLOCK_DETECTED &&
            code !== SERIALIZATION_FAILURE
          ) {
            throw err;
          }
          const occupied = occupiedTime({ ...params, bufferBeforeMs: writtenBefore, bufferAfterMs: written });
          await rollSeriesBehind(sql, params.resourceId, occupied.start, occupied.end);
          return overlapLoss(
            sql,
            params.resourceId,
            params.start,
            params.end,
            written,
            undefined,
            undefined,
            writtenBefore,
          );
        }
      }
    },

    async rescheduleExternalReservation(params) {
      const invalid = validateExternalCommand(params);
      if (invalid) return invalid;
      let currentReservationId: string | undefined;
      let bufferAfterMs = params.bufferAfterMs;
      let bufferBeforeMs = 0;
      for (let attempt = 1; ; attempt++) {
        try {
          return await inTransaction(sql, async (tx): Promise<ExternalReservationResult> => {
            await lockExternalIdentity(tx, params.tenantRef, params.externalRef);
            const existing = await tx<ReservationRow[]>`
              SELECT id, resource_id, tenant_ref, external_ref, starts_at, ends_at,
                     buffer_after_ms, revision, source
                FROM slotlock.reservations
               WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}
                 AND calendar_event_id IS NULL
               FOR UPDATE`;
            const found = existing[0];
            const ruling = await bookingRuling(tx, params.resourceId, params, defaultHours);
            if (!found) {
              const cancelled = await tx<{ revision: string | number }[]>`
                SELECT revision FROM slotlock.reservation_tombstones
                 WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}`;
              return cancelled[0]
                ? { ok: false, code: 'reservation_cancelled' }
                : { ok: false, code: 'reservation_not_found' };
            }
            currentReservationId = found.id;
            const currentRevision = Number(found.revision);
            if (params.revision < currentRevision) return { ok: false, code: 'stale_revision' };
            if (sameExternalPayload(found, params, ruling.turnaroundMs)) {
              return { ok: true, reservation: toReservation(found), idempotent: true };
            }
            if (params.revision === currentRevision) {
              return { ok: false, code: 'idempotency_conflict' };
            }
            if (params.revision !== currentRevision + 1) {
              return { ok: false, code: 'revision_conflict' };
            }
            const resourceState = await tenantResourceState(tx, params.resourceId, params.tenantRef);
            if (resourceState === 'missing') return { ok: false, code: 'resource_tenant_mismatch' };
            if (resourceState === 'archived') return { ok: false, code: 'resource_archived' };
            if (ruling.rule) return { ok: false, code: 'booking_rule_violated', rule: ruling.rule };
            bufferAfterMs = Math.max(params.bufferAfterMs, ruling.turnaroundMs);
            bufferBeforeMs = ruling.bufferBeforeMs;
            const occupied = occupiedTime({ ...params, bufferBeforeMs, bufferAfterMs });
            if (
              !(await recurrenceCoversWrite(tx, {
                tenantRef: params.tenantRef,
                resourceId: params.resourceId,
                ...occupied,
              }))
            ) {
              return { ok: false, code: 'recurrence_not_materialized' };
            }
            // Writers to this resource take turns from here to the insert (lockResourceForWrite).
            const locked = await lockResourceForWrite(tx, params.resourceId, params.tenantRef);
            if (!locked) return { ok: false, code: 'resource_tenant_mismatch' };
            if (locked.archived) return { ok: false, code: 'resource_archived' };
            await reapExpiredHolds(tx, params.resourceId, occupied.start, occupied.end);
            const rows = await tx<ReservationRow[]>`
              UPDATE slotlock.reservations
                 SET resource_id = ${params.resourceId},
                     starts_at = ${params.start},
                     ends_at = ${params.end},
                     buffer_after_ms = ${bufferAfterMs},
                     buffer_before_ms = ${bufferBeforeMs},
                     revision = ${params.revision},
                     source = ${params.source ?? null},
                     -- A check-in is for the time it was made for: a move to another start clears it.
                     checked_in_at = CASE
                       WHEN starts_at = ${params.start} AND resource_id = ${params.resourceId}
                       THEN checked_in_at
                     END
               WHERE id = ${found.id}
               RETURNING id, resource_id, tenant_ref, external_ref, starts_at, ends_at,
                         buffer_after_ms, revision, source`;
            const row = rows[0];
            if (!row) throw new Error('slotlock: external reservation update returned no row');
            return { ok: true, reservation: toReservation(row), idempotent: false };
          });
        } catch (err) {
          const code = pgCode(err);
          if ((code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE) && attempt === 1) {
            continue;
          }
          if (
            code !== EXCLUSION_VIOLATION &&
            code !== DEADLOCK_DETECTED &&
            code !== SERIALIZATION_FAILURE
          ) {
            throw err;
          }
          const occupied = occupiedTime({ ...params, bufferBeforeMs, bufferAfterMs });
          await rollSeriesBehind(sql, params.resourceId, occupied.start, occupied.end);
          return overlapLoss(
            sql,
            params.resourceId,
            params.start,
            params.end,
            bufferAfterMs,
            currentReservationId,
            undefined,
            bufferBeforeMs,
          );
        }
      }
    },

    async cancelExternalReservation(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.externalRef)) {
        return { ok: false, code: 'invalid_identity' };
      }
      if (!Number.isSafeInteger(params.revision) || params.revision <= 0) {
        return { ok: false, code: 'invalid_revision' };
      }
      return inTransaction(sql, async (tx): Promise<CancelExternalReservationResult> => {
        await lockExternalIdentity(tx, params.tenantRef, params.externalRef);
        const tombstones = await tx<{ revision: string | number }[]>`
          SELECT revision FROM slotlock.reservation_tombstones
           WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}
           FOR UPDATE`;
        const tombstone = tombstones[0];
        if (tombstone) {
          const cancelledRevision = Number(tombstone.revision);
          if (params.revision === cancelledRevision) {
            return { ok: true, cancelled: false, revision: cancelledRevision };
          }
          return params.revision < cancelledRevision
            ? { ok: false, code: 'stale_revision' }
            : { ok: false, code: 'reservation_cancelled' };
        }

        const existing = await tx<{ id: string; revision: string | number }[]>`
          SELECT id, revision FROM slotlock.reservations
           WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}
             AND calendar_event_id IS NULL
           FOR UPDATE`;
        const found = existing[0];
        if (found) {
          const currentRevision = Number(found.revision);
          if (params.revision <= currentRevision) return { ok: false, code: 'stale_revision' };
          if (params.revision !== currentRevision + 1) {
            return { ok: false, code: 'revision_conflict' };
          }
        }

        if (!found) {
          // This reference is a calendar event's occupation, not a booking: nothing to cancel or
          // retire.
          const [occupation] = await tx<{ id: string }[]>`
            SELECT id FROM slotlock.reservations
             WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}
               AND calendar_event_id IS NOT NULL
             LIMIT 1`;
          if (occupation) return { ok: true, cancelled: false, revision: params.revision };
          // Retiring a reference no booking holds adds a row; cancelling a booking replaces one.
          const limit = await tenantLimitReached(tx, params.tenantRef, 'reservations');
          if (limit !== null) return { ok: false, code: 'reservation_limit_reached', limit };
        }
        // A reference no booking holds yet is retired too, so a create delivered after its cancel
        // cannot bring it back.
        await tx`
          INSERT INTO slotlock.reservation_tombstones (tenant_ref, external_ref, revision, stray)
          VALUES (${params.tenantRef}, ${params.externalRef}, ${params.revision}, ${!found})`;
        if (!found) return { ok: true, cancelled: false, revision: params.revision };
        const deleted = await tx<{ id: string }[]>`
          DELETE FROM slotlock.reservations WHERE id = ${found.id} RETURNING id`;
        return { ok: true, cancelled: deleted.length === 1, revision: params.revision };
      });
    },

    async acquireHold(params) {
      if (!isFiniteWindow({ start: params.start, end: params.end })) {
        return { ok: false, code: 'invalid_window' };
      }
      // NaN/Infinity would raise a raw 22008 in make_interval, and a huge ttl could exceed the JS
      // Date range.
      if (!Number.isFinite(params.ttlMs) || params.ttlMs <= 0 || params.ttlMs > MAX_HOLD_TTL_MS) {
        return { ok: false, code: 'invalid_ttl' };
      }
      const bufferAfterMs = params.bufferAfterMs ?? 0;
      if (
        !Number.isSafeInteger(bufferAfterMs) ||
        bufferAfterMs < 0 ||
        bufferAfterMs > MAX_BUFFER_AFTER_MS
      ) {
        return { ok: false, code: 'invalid_buffer' };
      }
      const { tenantRef, principalRef, idempotencyKey } = params;
      if (tenantRef !== undefined && !isValidIdentity(tenantRef)) {
        return { ok: false, code: 'invalid_identity' };
      }
      const keyed = idempotencyKey !== undefined || principalRef !== undefined;
      if (
        keyed &&
        (tenantRef === undefined || !isValidIdentity(principalRef) || !isValidIdentity(idempotencyKey))
      ) {
        return { ok: false, code: 'invalid_identity' };
      }
      if (!isValidResourceId(params.resourceId)) return { ok: false, code: 'resource_not_found' };
      if (params.groupId !== undefined && !isValidResourceId(params.groupId)) {
        return { ok: false, code: 'invalid_identity' };
      }
      const { holderRef } = params;
      if (holderRef !== undefined && (tenantRef === undefined || !isValidIdentity(holderRef))) {
        return { ok: false, code: 'invalid_identity' };
      }
      const payloadHash = calendarCommandHash({
        operation: 'hold',
        resourceId: params.resourceId,
        start: params.start.toISOString(),
        end: params.end.toISOString(),
        ttlMs: params.ttlMs,
        bufferAfterMs,
        source: params.source ?? null,
        ...(params.groupId !== undefined ? { groupId: params.groupId } : {}),
        ...(holderRef !== undefined ? { holderRef } : {}),
      });
      const ttlSeconds = params.ttlMs / 1000;
      // The holder's caps: the store's, lowered by its key's own (RFC 0004 A5), never raised.
      const asked = params.holderCaps;
      const holdCap = Math.min(maxHoldsPerHolder, asked?.maxHolds ?? Number.POSITIVE_INFINITY);
      const heldHoursCap =
        asked?.maxHeldHours !== undefined
          ? Math.min(maxHeldHoursPerHolder ?? Number.POSITIVE_INFINITY, asked.maxHeldHours)
          : maxHeldHoursPerHolder;
      if (
        (asked?.maxHolds !== undefined && !(Number.isSafeInteger(asked.maxHolds) && asked.maxHolds >= 1)) ||
        (asked?.maxHeldHours !== undefined && !(Number.isSafeInteger(asked.maxHeldHours) && asked.maxHeldHours >= 1))
      ) {
        return { ok: false, code: 'invalid_identity' };
      }
      // The buffer asked for, raised to the resource's turnaround, and its rule's leading buffer.
      let written = bufferAfterMs;
      let writtenBefore = 0;
      for (let attempt = 1; ; attempt++) {
        try {
          return await inTransaction(sql, async (tx): Promise<AcquireHoldResult> => {
            if (keyed) {
              await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
                'slotlock-hold-command',
                tenantRef,
                principalRef,
                idempotencyKey,
              ])}, 0))`;
              const [prior] = await tx<(HoldRow & { payload_hash: string })[]>`
                SELECT hold_id AS id, resource_id, starts_at, ends_at, buffer_after_ms, expires_at,
                       source, payload_hash,
                       (SELECT hold_group_id FROM slotlock.reservations WHERE id = hold_id) AS hold_group_id
                  FROM slotlock.hold_commands
                 WHERE tenant_ref = ${tenantRef ?? null} AND principal_ref = ${principalRef ?? null}
                   AND idempotency_key = ${idempotencyKey ?? null}`;
              if (prior) {
                return prior.payload_hash === payloadHash
                  ? { ok: true, hold: toHold(prior), idempotent: true }
                  : { ok: false, code: 'idempotency_conflict' };
              }
            }
            const holdLimit = await tenantLimitReached(
              tx,
              await limitTenant(tx, 'holds', params.resourceId, tenantRef),
              'holds',
            );
            const resource = await readResourceForWrite(tx, params.resourceId, tenantRef ?? null);
            if (!resource) return { ok: false, code: 'resource_not_found' };
            if (resource.archived) return { ok: false, code: 'resource_archived' };
            if (holdLimit !== null) return { ok: false, code: 'hold_limit_reached', limit: holdLimit };
            let heldSeconds: number | null = null;
            if (holderRef !== undefined) {
              // Counted under a lock on the holder, so racing holds stop at the cap: an agent
              // cannot hold a resource's whole week.
              await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
                'slotlock-holder',
                tenantRef,
                holderRef,
              ])}, 0))`;
              const [held] = await tx<{ count: number; seconds: number }[]>`
                SELECT count(*)::int AS count,
                       COALESCE(sum(extract(epoch FROM
                         ends_at + (buffer_after_ms + buffer_before_ms) * interval '1 millisecond'
                           - starts_at)), 0)::float8
                         AS seconds
                  FROM slotlock.reservations
                 WHERE holder_ref = ${holderRef} AND tenant_ref IS NULL AND status = 'held'
                   AND expires_at > statement_timestamp()
                   AND resource_id IN (SELECT id FROM slotlock.resources WHERE tenant_ref = ${tenantRef ?? null})`;
              if ((held?.count ?? 0) >= holdCap) {
                return { ok: false, code: 'hold_limit_reached', limit: holdCap };
              }
              if (heldHoursCap !== undefined) heldSeconds = held?.seconds ?? 0;
            }
            const ruling = await bookingRuling(tx, params.resourceId, params, defaultHours);
            if (ruling.rule) return { ok: false, code: 'booking_rule_violated', rule: ruling.rule };
            written = Math.max(bufferAfterMs, ruling.turnaroundMs);
            writtenBefore = ruling.bufferBeforeMs;
            const reach = occupiedTime({ ...params, bufferBeforeMs: writtenBefore, bufferAfterMs: written });
            if (
              heldSeconds !== null &&
              heldHoursCap !== undefined &&
              heldSeconds + (reach.end.getTime() - reach.start.getTime()) / 1000 >
                heldHoursCap * 3_600
            ) {
              return { ok: false, code: 'held_time_limit_reached', limit: heldHoursCap };
            }
            if (
              resource.tenant_ref !== null &&
              !(await recurrenceCoversWrite(tx, {
                tenantRef: resource.tenant_ref,
                resourceId: params.resourceId,
                ...reach,
              }))
            ) {
              return { ok: false, code: 'recurrence_not_materialized' };
            }
            // Writers to this resource take turns from here to the insert (lockResourceForWrite).
            const locked = await lockResourceForWrite(tx, params.resourceId, tenantRef ?? null);
            if (!locked) return { ok: false, code: 'resource_not_found' };
            if (locked.archived) return { ok: false, code: 'resource_archived' };
            await reapExpiredHolds(tx, params.resourceId, reach.start, reach.end);
            const [row] = await tx<HoldRow[]>`
              INSERT INTO slotlock.reservations (
                resource_id, starts_at, ends_at, buffer_after_ms, buffer_before_ms, status,
                expires_at, source, holder_ref, hold_group_id
              ) VALUES (
                ${params.resourceId}, ${params.start}, ${params.end}, ${written}, ${writtenBefore}, 'held',
                statement_timestamp() + make_interval(secs => ${ttlSeconds}), ${params.source ?? null},
                ${holderRef ?? null}, ${params.groupId ?? null}
              )
              RETURNING id, resource_id, starts_at, ends_at, buffer_after_ms, expires_at, source,
                        hold_group_id`;
            if (!row) throw new Error('slotlock: hold insert returned no row');
            if (keyed) {
              await tx`
                INSERT INTO slotlock.hold_commands (
                  tenant_ref, principal_ref, idempotency_key, payload_hash, hold_id, resource_id,
                  starts_at, ends_at, buffer_after_ms, expires_at, source
                ) VALUES (
                  ${tenantRef ?? null}, ${principalRef ?? null}, ${idempotencyKey ?? null},
                  ${payloadHash}, ${row.id}, ${row.resource_id}, ${row.starts_at}, ${row.ends_at},
                  ${row.buffer_after_ms}, ${row.expires_at}, ${row.source}
                )`;
            }
            return { ok: true, hold: toHold(row), idempotent: false };
          });
        } catch (err) {
          const code = pgCode(err);
          if ((code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE) && attempt === 1) {
            continue;
          }
          if (
            code !== EXCLUSION_VIOLATION &&
            code !== DEADLOCK_DETECTED &&
            code !== SERIALIZATION_FAILURE
          ) {
            throw err;
          }
          // A second contention abort is a structured loss too (possibly with a null winner), never
          // a raw throw.
          const occupied = occupiedTime({ ...params, bufferBeforeMs: writtenBefore, bufferAfterMs: written });
          await rollSeriesBehind(sql, params.resourceId, occupied.start, occupied.end);
          return overlapLoss(
            sql,
            params.resourceId,
            params.start,
            params.end,
            written,
            undefined,
            undefined,
            writtenBefore,
          );
        }
      }
    },

    async getHold(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      if (!isValidResourceId(params.holdId)) return null;
      const [row] = await sql<HoldRow[]>`
        SELECT hold.id, hold.resource_id, hold.starts_at, hold.ends_at, hold.buffer_after_ms,
               hold.expires_at, hold.source
          FROM slotlock.reservations hold
          JOIN slotlock.resources resource ON resource.id = hold.resource_id
         WHERE hold.id = ${params.holdId} AND resource.tenant_ref = ${params.tenantRef}
           AND hold.status = 'held' AND hold.expires_at > statement_timestamp()`;
      return row ? toHold(row) : null;
    },

    async getHolderHold(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.holderRef)) {
        throw invalidIdentityError('Slotlock tenant and holder must be 1-500 UTF-8 bytes');
      }
      if (!isValidResourceId(params.holdId)) return null;
      const [row] = await sql<(HoldRow & { live: boolean })[]>`
        SELECT hold.id, hold.resource_id, hold.starts_at, hold.ends_at, hold.buffer_after_ms,
               hold.expires_at, hold.source, hold.expires_at > statement_timestamp() AS live
          FROM slotlock.reservations hold
          JOIN slotlock.resources resource ON resource.id = hold.resource_id
         WHERE hold.id = ${params.holdId} AND resource.tenant_ref = ${params.tenantRef}
           AND hold.status = 'held' AND hold.holder_ref = ${params.holderRef}`;
      return row ? { hold: toHold(row), live: row.live } : null;
    },

    async listHolds(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      if (!isValidResourceId(params.resourceId)) {
        throw invalidIdentityError('Slotlock resource id must be a UUID');
      }
      const limit = pageLimit(params.limit);
      const after = pageCursor(params.after);
      const rows = await sql<HoldRow[]>`
        SELECT hold.id, hold.resource_id, hold.starts_at, hold.ends_at, hold.buffer_after_ms,
               hold.expires_at, hold.source
          FROM slotlock.reservations hold
          JOIN slotlock.resources resource ON resource.id = hold.resource_id
         WHERE hold.resource_id = ${params.resourceId} AND resource.tenant_ref = ${params.tenantRef}
           AND hold.status = 'held' AND hold.expires_at > statement_timestamp()
           AND (${after.start}::timestamptz IS NULL
                OR (hold.starts_at, hold.id) > (${after.start}::timestamptz, ${after.id}::uuid))
         ORDER BY hold.starts_at, hold.id
         LIMIT ${limit}`;
      return rows.map(toHold);
    },

    async listAgenda(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const window = calendarWindow(params.window);
      const limit = pageLimit(params.limit);
      // A confirmed row without a tenant is a parity shadow, not a booking.
      const rows = await sql<AgendaRow[]>`
        SELECT entry.id, entry.resource_id, entry.starts_at, entry.ends_at, entry.status,
               entry.external_ref, entry.expires_at, entry.source, entry.calendar_event_id,
               event.summary
          FROM slotlock.reservations entry
          JOIN slotlock.resources resource ON resource.id = entry.resource_id
          LEFT JOIN slotlock.calendar_events event ON event.id = entry.calendar_event_id
         WHERE resource.tenant_ref = ${params.tenantRef}
           AND entry.starts_at < ${window.end} AND entry.ends_at > ${window.start}
           AND ((entry.status = 'held' AND entry.expires_at > statement_timestamp())
                OR (entry.status = 'confirmed' AND entry.tenant_ref = ${params.tenantRef}))
         ORDER BY entry.starts_at, entry.id
         LIMIT ${limit}`;
      return rows.map((row) => ({
        id: row.id,
        resourceId: row.resource_id,
        start: row.starts_at,
        end: row.ends_at,
        kind: row.status === 'held' ? 'hold' : row.calendar_event_id ? 'event' : 'booking',
        reference: row.status === 'held' || row.calendar_event_id ? null : row.external_ref,
        summary: row.summary,
        expiresAt: row.status === 'held' ? row.expires_at : null,
        source: row.source,
      }));
    },

    async describeBooking(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      if (!isValidResourceId(params.id)) return null;
      const [row] = await sql<
        {
          resource_id: string;
          status: 'held' | 'confirmed';
          holder_ref: string | null;
          occupied_start: Date;
          occupied_end: Date;
          event_id: string | null;
          event_ref: string | null;
          event_owner_ref: string | null;
        }[]
      >`
        SELECT booking.resource_id, booking.status, booking.holder_ref,
               COALESCE(booking.occupied_starts_at, booking.starts_at) AS occupied_start,
               COALESCE(booking.occupied_ends_at, booking.ends_at) AS occupied_end,
               event.id AS event_id, event.external_ref AS event_ref, event.owner_ref AS event_owner_ref
          FROM slotlock.reservations booking
          JOIN slotlock.resources resource ON resource.id = booking.resource_id
          LEFT JOIN slotlock.calendar_events event
            ON event.id = booking.calendar_event_id AND event.tenant_ref = ${params.tenantRef}
         WHERE booking.id = ${params.id} AND resource.tenant_ref = ${params.tenantRef}`;
      if (!row) return null;
      return {
        id: params.id,
        resourceId: row.resource_id,
        status: row.status,
        holderRef: row.holder_ref,
        eventId: row.event_id,
        eventRef: row.event_ref,
        eventOwnerRef: row.event_owner_ref,
        start: row.occupied_start,
        end: row.occupied_end,
      };
    },

    async eventOccupancy(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.ownerRef)) {
        throw invalidIdentityError('Slotlock tenant and owner must be 1-500 UTF-8 bytes');
      }
      const refs = params.externalRefs.filter((ref) => isValidIdentity(ref));
      if (refs.length === 0) return [];
      const rows = await sql<{ resource_id: string; start: Date; end: Date; recurring: boolean }[]>`
        SELECT booking.resource_id,
               COALESCE(booking.occupied_starts_at, booking.starts_at) AS start,
               COALESCE(booking.occupied_ends_at, booking.ends_at) AS "end",
               event.recurrence_rule IS NOT NULL AS recurring
          FROM slotlock.calendar_events event
          JOIN slotlock.reservations booking ON booking.calendar_event_id = event.id
         WHERE event.tenant_ref = ${params.tenantRef} AND event.owner_ref = ${params.ownerRef}
           AND event.external_ref = ANY (${refs}::text[])
         ORDER BY booking.resource_id, 2, booking.id`;
      return rows.map((row) => ({ resourceId: row.resource_id, start: row.start, end: row.end, recurring: row.recurring }));
    },

    async putApprovalPolicy(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      return putApprovalPolicy(sql, params);
    },

    async listApprovalPolicies(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      return listApprovalPolicies(sql, params.tenantRef);
    },

    async deleteApprovalPolicy(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      return { deleted: await deleteApprovalPolicy(sql, params.tenantRef, params.ref) };
    },

    async approvalPoliciesFor(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      return approvalPoliciesFor(sql, params.tenantRef, params.resourceIds);
    },

    async requestApproval(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.requesterRef)) {
        throw invalidIdentityError('Slotlock tenant and requester must be 1-500 UTF-8 bytes');
      }
      if (!/^[0-9a-f]{64}$/.test(params.requestKey)) {
        throw invalidIdentityError('Slotlock approval request key must be 64 hex characters');
      }
      if (
        params.holds.length < 1 ||
        params.holds.length > SLOTLOCK_MAX_APPROVAL_HOLDS ||
        params.holds.some((hold) => !isValidResourceId(hold.resourceId) || !(hold.end > hold.start))
      ) {
        throw invalidIdentityError(`Slotlock approval holds must be 1-${SLOTLOCK_MAX_APPROVAL_HOLDS} intervals on resources`);
      }
      const { tenantRef } = params;
      try {
        return await inTransaction(sql, async (tx) => {
          // Retries of one request wait for each other, so the second answers the first's approval.
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
            'slotlock-approval',
            tenantRef,
            params.requestKey,
          ])}, 0))`;
          const prior = await approvalByRequestKey(tx, tenantRef, params.requestKey);
          if (prior) {
            const [same] = await tx<{ same: boolean }[]>`
              SELECT request = ${tx.json(params.request as never)}::jsonb AS same
                FROM slotlock.approvals WHERE id = ${prior.id}`;
            return same?.same
              ? { ok: true as const, approval: prior, replayed: true }
              : { ok: false as const, code: 'idempotency_conflict' as const };
          }
          // Counted under a lock on the tenant's approvals, so racing requests stop at the caps.
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['slotlock-approvals', tenantRef])}, 0))`;
          const [pending] = await tx<{ tenant: number; requester: number }[]>`
            SELECT count(*)::int AS tenant,
                   (count(*) FILTER (WHERE requester ->> 'subject' = ${params.requesterRef}))::int AS requester
              FROM slotlock.approvals
             WHERE tenant_ref = ${tenantRef} AND status = 'pending' AND expires_at > statement_timestamp()`;
          if ((pending?.requester ?? 0) >= SLOTLOCK_MAX_PENDING_APPROVALS_PER_REQUESTER) {
            return { ok: false as const, code: 'approval_limit_reached' as const, limit: SLOTLOCK_MAX_PENDING_APPROVALS_PER_REQUESTER };
          }
          if ((pending?.tenant ?? 0) >= SLOTLOCK_MAX_PENDING_APPROVALS) {
            return { ok: false as const, code: 'approval_limit_reached' as const, limit: SLOTLOCK_MAX_PENDING_APPROVALS };
          }
          const id = randomUUID();
          // The requester's own hold of the time gives way to the approval's.
          if (params.consumeHold && isValidResourceId(params.consumeHold.holdId)) {
            await tx`
              DELETE FROM slotlock.reservations
               WHERE id = ${params.consumeHold.holdId} AND status = 'held'
                 AND holder_ref = ${params.consumeHold.holderRef}`;
          }
          const holds = [...params.holds].sort(
            (left, right) => left.resourceId.localeCompare(right.resourceId) || left.start.getTime() - right.start.getTime(),
          );
          // Locked as any booking write locks them, in id order, so a racing booking takes turns.
          for (const resourceId of [...new Set(holds.map((hold) => hold.resourceId))].sort()) {
            await lockResourceForWrite(tx, resourceId, tenantRef);
          }
          for (const hold of holds) await reapExpiredHolds(tx, hold.resourceId, hold.start, hold.end);
          const held = await tx<{ id: string }[]>`
            INSERT INTO slotlock.reservations (
              resource_id, starts_at, ends_at, buffer_after_ms, buffer_before_ms, status, expires_at,
              source, holder_ref, hold_group_id
            )
            SELECT wanted.resource_id, wanted.starts_at, wanted.ends_at, 0, 0, 'held', ${params.expiresAt},
                   'slotlock:approval', ${`approval:${id}`}, ${id}::uuid
              FROM ROWS FROM (pg_catalog.unnest(${holds.map((hold) => hold.resourceId)}::uuid[]),
                              pg_catalog.unnest(${holds.map((hold) => hold.start.toISOString())}::text[]::timestamptz[]),
                              pg_catalog.unnest(${holds.map((hold) => hold.end.toISOString())}::text[]::timestamptz[]))
                   AS wanted(resource_id, starts_at, ends_at)
            RETURNING id`;
          const [row] = await tx<Parameters<typeof toApproval>[0][]>`
            INSERT INTO slotlock.approvals (
              id, tenant_ref, policy_ref, operation, request, requester, hold_ids, resource_ids,
              starts_at, ends_at, request_key, expires_at
            ) VALUES (
              ${id}, ${tenantRef}, ${params.policyRef}, ${params.operation}, ${tx.json(params.request as never)},
              ${tx.json(params.requester as never)}, ${held.map((hold) => hold.id)}::uuid[],
              ${[...new Set(holds.map((hold) => hold.resourceId))]}::uuid[], ${params.start}, ${params.end},
              ${params.requestKey}, ${params.expiresAt}
            )
            RETURNING ${tx.unsafe(APPROVAL_COLUMNS)}`;
          if (!row) throw new Error('slotlock: approval insert returned no row');
          const approval = toApproval(row);
          await recordApprovalChange(tx, tenantRef, 'approval.requested', approval);
          return { ok: true as const, approval, replayed: false };
        }, 'read committed');
      } catch (err) {
        if (pgCode(err) === EXCLUSION_VIOLATION) return { ok: false, code: 'overlap' };
        throw err;
      }
    },

    async findApproval(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      if (!/^[0-9a-f]{64}$/.test(params.requestKey)) return null;
      return approvalByRequestKey(sql, params.tenantRef, params.requestKey);
    },

    async getApproval(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      return getApproval(sql, params.tenantRef, params.id);
    },

    async listApprovals(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const limit = params.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw invalidIdentityError('Slotlock approval list limit must be 1-200');
      }
      return listApprovals(sql, {
        tenantRef: params.tenantRef,
        limit,
        ...(params.status !== undefined ? { status: params.status } : {}),
      });
    },

    async beginApprovalGrant(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      return beginApprovalGrant(sql, params.tenantRef, params.id);
    },

    async finishApprovalGrant(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.decidedBy)) {
        throw invalidIdentityError('Slotlock tenant and decider must be 1-500 UTF-8 bytes');
      }
      return finishApprovalGrant(sql, params.tenantRef, params.id, params.decidedBy);
    },

    async declineApproval(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.decidedBy)) {
        throw invalidIdentityError('Slotlock tenant and decider must be 1-500 UTF-8 bytes');
      }
      if (params.reason !== undefined && params.reason.length > 500) {
        throw invalidIdentityError('Slotlock approval reason must be at most 500 characters');
      }
      return declineApproval(sql, params);
    },

    async resetTestTenant(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      if (!params.tenantRef.endsWith('~test')) throw sandboxTestOnlyError();
      const rows = await sql<{ reset_table: string; reset_rows: string | number }[]>`
        SELECT * FROM slotlock.reset_test_tenant(${params.tenantRef}::text)`.catch((error: unknown) => {
        if ((error as { hint?: unknown }).hint === 'sandbox_test_only') throw sandboxTestOnlyError();
        throw error;
      });
      return Object.fromEntries(rows.map((row) => [row.reset_table, Number(row.reset_rows)]));
    },

    async fastForwardTestTenant(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      if (!params.tenantRef.endsWith('~test')) throw sandboxTestOnlyError();
      if (!Number.isSafeInteger(params.minutes) || params.minutes < 1 || params.minutes > 525_600) {
        throw invalidIdentityError('Slotlock fast-forward is 1 to 525,600 minutes');
      }
      const [counted] = await sql<{ holds: number; approvals: number }[]>`
        WITH lapsed_holds AS (
          UPDATE slotlock.reservations hold
             SET expires_at = statement_timestamp() - interval '1 millisecond'
           WHERE hold.status = 'held'
             AND hold.expires_at > statement_timestamp()
             AND hold.expires_at <= statement_timestamp() + make_interval(mins => ${params.minutes})
             AND hold.resource_id IN (SELECT id FROM slotlock.resources WHERE tenant_ref = ${params.tenantRef})
          RETURNING 1
        ), lapsed_approvals AS (
          UPDATE slotlock.approvals
             SET expires_at = statement_timestamp() - interval '1 millisecond'
           WHERE tenant_ref = ${params.tenantRef} AND status = 'pending'
             AND expires_at > statement_timestamp()
             AND expires_at <= statement_timestamp() + make_interval(mins => ${params.minutes})
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM lapsed_holds)::int AS holds,
               (SELECT count(*) FROM lapsed_approvals)::int AS approvals`;
      return { holds: counted?.holds ?? 0, approvals: counted?.approvals ?? 0 };
    },

    async expireApprovals(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const limit = params.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw invalidIdentityError('Slotlock approval expiry limit must be 1-1000');
      }
      return { expired: await expireApprovals(sql, params.tenantRef, limit) };
    },

    async getReservation(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.externalRef)) {
        throw invalidIdentityError('Slotlock booking identity must be 1-500 UTF-8 bytes');
      }
      const [row] = await sql<ReservationRow[]>`
        SELECT id, resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms,
               revision, source
          FROM slotlock.reservations
         WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}
           AND calendar_event_id IS NULL`;
      return row ? toReservation(row) : null;
    },

    async listReservations(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      if (!isValidResourceId(params.resourceId)) {
        throw invalidIdentityError('Slotlock resource id must be a UUID');
      }
      const window = calendarWindow(params.window);
      const limit = pageLimit(params.limit);
      const after = pageCursor(params.after);
      const rows = await sql<ReservationRow[]>`
        SELECT id, resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms,
               revision, source
          FROM slotlock.reservations
         WHERE tenant_ref = ${params.tenantRef} AND resource_id = ${params.resourceId}
           AND calendar_event_id IS NULL
           AND starts_at < ${window.end}
           AND COALESCE(occupied_ends_at, ends_at) > ${window.start}
           AND (${after.start}::timestamptz IS NULL
                OR (starts_at, id) > (${after.start}::timestamptz, ${after.id}::uuid))
         ORDER BY starts_at, id
         LIMIT ${limit}`;
      return rows.map(toReservation);
    },

    async confirmHold(holdId, options = {}) {
      const tenantRef = holdTenantRef(options);
      // Not an id the store issues (and a raw 22P02 in the query).
      if (!isValidResourceId(holdId)) return { ok: false, code: 'hold_not_found' };
      return inTransaction(sql, async (tx): Promise<ConfirmHoldResult> => {
        // A hold never changes resource, so the owner is read before the identity lock, taken
        // before the row lock as every booking write does.
        const [owner] = await tx<{ resource_id: string; resource_tenant: string | null }[]>`
          SELECT hold.resource_id, resource.tenant_ref AS resource_tenant
            FROM slotlock.reservations hold
            JOIN slotlock.resources resource ON resource.id = hold.resource_id
           WHERE hold.id = ${holdId} AND hold.calendar_event_id IS NULL
             AND (${tenantRef}::text IS NULL OR resource.tenant_ref = ${tenantRef})`;
        if (!owner) return { ok: false, code: 'hold_not_found' };
        const bookingTenant = owner.resource_tenant;
        if (bookingTenant !== null) await lockExternalIdentity(tx, bookingTenant, holdId);
        const bookingLimit = await tenantLimitReached(tx, bookingTenant, 'reservations');
        // The resource's lock, as every booking write takes it: an archive waits for this
        // confirmation.
        const resource = await lockResourceForWrite(tx, owner.resource_id, null);
        const [row] = await tx<
          (ReservationRow & { status: string; live: boolean; hold_group_id: string | null; holder_ref: string | null })[]
        >`
          SELECT id, resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms,
                 revision, source, status, (status = 'held' AND expires_at > statement_timestamp()) AS live,
                 hold_group_id, holder_ref
            FROM slotlock.reservations
           WHERE id = ${holdId}
           FOR UPDATE`;
        if (!row) {
          // A hold reaped by a rival while this confirm waited reads as hold_not_found; both
          // refusals are terminal for the caller.
          return { ok: false, code: 'hold_not_found' };
        }
        if (row.status === 'confirmed') {
          // A retried confirm of an already-confirmed hold is success: reporting failure would make
          // callers double-book elsewhere. A booking with another reference was never this hold.
          if (row.external_ref !== null && row.external_ref !== row.id) {
            return { ok: false, code: 'hold_not_found' };
          }
          return { ok: true, reservation: toReservation(row) };
        }
        if (!row.live) return { ok: false, code: 'hold_expired' };
        if (resource?.archived !== false) return { ok: false, code: 'resource_archived' };
        if (bookingTenant !== null) {
          const [retired] = await tx<{ revision: string }[]>`
            SELECT revision FROM slotlock.reservation_tombstones
             WHERE tenant_ref = ${bookingTenant} AND external_ref = ${holdId}`;
          if (retired) return { ok: false, code: 'reservation_cancelled' };
          const [taken] = await tx<{ id: string }[]>`
            SELECT id FROM slotlock.reservations
             WHERE tenant_ref = ${bookingTenant} AND external_ref = ${holdId}
               AND calendar_event_id IS NULL`;
          if (taken) return { ok: false, code: 'idempotency_conflict' };
        }
        if (bookingLimit !== null) {
          return { ok: false, code: 'reservation_limit_reached', limit: bookingLimit };
        }
        // The trigger already set the occupied end; the tenant and reference make the hold a
        // booking cancel and reschedule reach.
        const [confirmed] = await tx<ReservationRow[]>`
          UPDATE slotlock.reservations
             SET status = 'confirmed', expires_at = NULL,
                 tenant_ref = ${bookingTenant}, external_ref = ${bookingTenant === null ? null : holdId}
           WHERE id = ${holdId}
          RETURNING id, resource_id, tenant_ref, external_ref, starts_at, ends_at,
                    buffer_after_ms, revision, source`;
        if (!confirmed) throw new Error('slotlock: hold confirmation returned no row');
        // Its linked alternatives (one group, one holder) are released with it, as booking one
        // from an agent releases the rest.
        if (row.hold_group_id !== null && row.holder_ref !== null) {
          await tx`
            DELETE FROM slotlock.reservations
             WHERE status = 'held' AND hold_group_id = ${row.hold_group_id}::uuid
               AND holder_ref = ${row.holder_ref} AND id <> ${holdId}`;
        }
        return { ok: true, reservation: toReservation(confirmed) };
      });
    },

    async releaseHold(holdId, options = {}) {
      const tenantRef = holdTenantRef(options);
      if (!isValidResourceId(holdId)) return { ok: true, released: false };
      if (options.holderRef !== undefined) {
        if (!isValidIdentity(options.holderRef)) return { ok: true, released: false };
        const released = await sql<{ id: string }[]>`
          WITH taken AS (
            SELECT id, hold_group_id FROM slotlock.reservations
             WHERE id = ${holdId} AND status = 'held' AND holder_ref = ${options.holderRef}
               AND (${tenantRef}::text IS NULL
                    OR resource_id IN (SELECT id FROM slotlock.resources WHERE tenant_ref = ${tenantRef}))
          )
          DELETE FROM slotlock.reservations hold
           USING taken
           WHERE hold.status = 'held' AND hold.holder_ref = ${options.holderRef}
             AND (${tenantRef}::text IS NULL
                  OR hold.resource_id IN (SELECT id FROM slotlock.resources WHERE tenant_ref = ${tenantRef}))
             AND (hold.id = taken.id
                  OR (taken.hold_group_id IS NOT NULL AND hold.hold_group_id = taken.hold_group_id))
          RETURNING hold.id`;
        return { ok: true, released: released.some(({ id }) => id === holdId) };
      }
      const rows = await sql<{ id: string }[]>`
        DELETE FROM slotlock.reservations
         WHERE id = ${holdId} AND status = 'held'
           AND (${tenantRef}::text IS NULL
                OR resource_id IN (SELECT id FROM slotlock.resources WHERE tenant_ref = ${tenantRef}))
         RETURNING id`;
      return { ok: true, released: rows.length > 0 };
    },

    async listBusy(resourceId, window, options = {}) {
      if (!isFiniteWindow(window)) throw invalidWindowError();
      if (!isValidResourceId(resourceId)) {
        throw invalidIdentityError('Slotlock resource id must be a UUID');
      }
      if (options.limit !== undefined && !(Number.isSafeInteger(options.limit) && options.limit > 0)) {
        throw Object.assign(new Error('Slotlock busy read limit must be a positive whole number'), {
          code: 'invalid_limit' as const,
        });
      }
      if (options.tenantRef !== undefined) {
        if (!isValidIdentity(options.tenantRef)) {
          throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
        }
        const [owned] = await sql<{ id: string }[]>`
          SELECT id FROM slotlock.resources
           WHERE id = ${resourceId} AND tenant_ref = ${options.tenantRef}`;
        if (!owned) {
          throw Object.assign(new Error('Slotlock resource not found in this tenant'), {
            code: 'resource_not_found' as const,
          });
        }
      }
      // Expired holds are excluded so findNextAvailable can offer their space; the acquiring
      // transaction reaps the row itself.
      const rows = await sql<{ occupied_starts_at: Date; occupied_ends_at: Date }[]>`
        SELECT occupied_starts_at, occupied_ends_at FROM (
          SELECT COALESCE(occupied_starts_at, starts_at) AS occupied_starts_at,
                 COALESCE(occupied_ends_at, ends_at) AS occupied_ends_at
            FROM slotlock.reservations
           WHERE resource_id = ${resourceId}
             AND ${occupiedStartsBefore(sql, window.end)}
             AND COALESCE(occupied_ends_at, ends_at) > ${window.start}
             AND (status <> 'held' OR expires_at > statement_timestamp())
          UNION ALL
          ${compositeBusy(sql, resourceId, window)}
        ) busy
         ORDER BY occupied_starts_at
         LIMIT ${options.limit ?? null}`;
      return rows.map((r) => ({ start: r.occupied_starts_at, end: r.occupied_ends_at }));
    },

    async putCalendarEvent(params) {
      const ownerRef = params.ownerRef ?? SLOTLOCK_INTERNAL_EVENT_OWNER_REF;
      if (params.expectedResourceId !== undefined && !isValidResourceId(params.expectedResourceId)) {
        return { ok: false, code: 'invalid_identity' };
      }
      if (
        !isValidIdentity(params.tenantRef) ||
        !isValidEventOwnerRef(ownerRef) ||
        !isValidIdentity(params.externalRef) ||
        !isValidIdentity(params.idempotencyKey) ||
        !isValidResourceId(params.resourceId) ||
        (params.source !== undefined && !isValidIdentity(params.source))
      ) {
        return { ok: false, code: 'invalid_identity' };
      }
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) {
        return { ok: false, code: 'invalid_revision' };
      }
      let event: CalendarEventContent;
      let materializationWindow: Interval;
      let expanded: CalendarSeriesExpansion | null = null;
      try {
        event = normalizeCalendarEventContent(params);
        if (event.recurrence) {
          if (!params.materializationWindow) return { ok: false, code: 'invalid_event' };
          materializationWindow = seriesWindow(params.materializationWindow);
        } else {
          materializationWindow = oneOffEventWindow(event, params.materializationWindow);
        }
        try {
          expanded = expandCalendarEventSeries(event, materializationWindow, {
            cursor: null,
            stored: false,
          });
        } catch (error) {
          // A long-running series can outgrow the write's search budget from its start; a stored
          // one is expanded below from its last cursor.
          if (!(error instanceof CalendarExpansionLimitError) || !event.recurrence) throw error;
        }
      } catch (error) {
        if (error instanceof CalendarContractError) return { ok: false, code: 'invalid_event' };
        throw error;
      }
      const payloadHash = putCommandHash({ command: params, ownerRef, event });
      const legacyPayloadHash = legacyPutCommandHash({
        command: params,
        ownerRef,
        event,
        window: materializationWindow,
      });
      const recurrenceEndsBy = recurrenceEndsByColumn(event);

      let attempted: CalendarEventOccurrence[] = expanded?.occurrences ?? [];
      let attemptedBuffers = { bufferBeforeMs: 0, bufferAfterMs: 0 };
      let storedEventId: string | undefined;
      for (let attempt = 1; ; attempt++) {
        try {
          return await inTransaction(sql, async (tx): Promise<PutCalendarEventResult> => {
            await lockCalendarIdempotency(tx, params.tenantRef, ownerRef, params.idempotencyKey);
            await lockCalendarEventIdentity(tx, params.tenantRef, ownerRef, params.externalRef);
            const commands = await tx<CalendarCommandRow[]>`
              SELECT operation, payload_hash, event_id, external_ref,
                     result_revision, occurrence_count
               FROM slotlock.calendar_event_commands
               WHERE tenant_ref = ${params.tenantRef}
                 AND owner_ref = ${ownerRef}
                 AND idempotency_key = ${params.idempotencyKey}
               FOR UPDATE`;
            const priorCommand = commands[0];
            if (priorCommand) {
              if (
                priorCommand.operation !== 'put' ||
                (priorCommand.payload_hash !== payloadHash &&
                  priorCommand.payload_hash !== legacyPayloadHash)
              ) {
                return { ok: false, code: 'idempotency_conflict' };
              }
              return commandResult(priorCommand, true);
            }

            if (ownerRef !== SLOTLOCK_INTERNAL_EVENT_OWNER_REF) {
              await lockCalendarOwnerQuota(tx, params.tenantRef, ownerRef);
              const commandCount = await calendarOwnerCommandCount(tx, params.tenantRef, ownerRef);
              // Reserve one cancellation slot for every possible live identity, so update churn
              // cannot leave a principal unable to release calendar space.
              const putCommandLimit =
                configuredAgentOwnerCommandQuota - configuredAgentOwnerEventQuota;
              if (commandCount >= putCommandLimit) {
                return {
                  ok: false,
                  code: 'owner_command_quota_exceeded',
                  limit: configuredAgentOwnerCommandQuota,
                };
              }
            }

            const tombstones = await tx<{ revision: string | number }[]>`
              SELECT revision FROM slotlock.calendar_event_tombstones
               WHERE tenant_ref = ${params.tenantRef}
                 AND owner_ref = ${ownerRef}
                 AND external_ref = ${params.externalRef}
               FOR UPDATE`;
            if (tombstones[0]) {
              return {
                ok: false,
                code: 'event_cancelled',
                currentRevision: Number(tombstones[0].revision),
              };
            }
            const resourceState = await tenantResourceState(tx, params.resourceId, params.tenantRef);
            if (resourceState === 'missing') return { ok: false, code: 'resource_tenant_mismatch' };
            if (resourceState === 'archived') return { ok: false, code: 'resource_archived' };
            const existing = await tx<CalendarEventRow[]>`
              SELECT id, tenant_ref, owner_ref, external_ref, resource_id, starts_at, ends_at, timezone,
                     summary, description, location, status, transparency, organizer, attendees,
                     reminders, recurrence_rule, recurrence_exceptions, materialized_starts_at,
                     materialized_ends_at, recurrence_cursor, revision, source, created_at, updated_at
                FROM slotlock.calendar_events
               WHERE tenant_ref = ${params.tenantRef}
                 AND owner_ref = ${ownerRef}
                 AND external_ref = ${params.externalRef}
               FOR UPDATE`;
            const found = existing[0];
            storedEventId = found?.id;
            if (
              params.expectedResourceId !== undefined &&
              found?.resource_id !== params.expectedResourceId
            ) {
              return { ok: false, code: 'resource_tenant_mismatch' };
            }
            const currentRevision = found ? Number(found.revision) : 0;
            if (params.expectedRevision !== currentRevision) {
              return { ok: false, code: 'revision_conflict', currentRevision };
            }
            const series = expanded ?? resumeStoredSeries(event, materializationWindow, found);
            if (!series) return { ok: false, code: 'invalid_event' };
            const { occurrences } = series;
            attempted = occurrences;
            if (!found && ownerRef !== SLOTLOCK_INTERNAL_EVENT_OWNER_REF) {
              const owned = await tx<{ count: string | number }[]>`
                SELECT (
                  (SELECT count(*) FROM slotlock.calendar_events
                    WHERE tenant_ref = ${params.tenantRef} AND owner_ref = ${ownerRef})
                  +
                  (SELECT count(*) FROM slotlock.calendar_event_tombstones
                    WHERE tenant_ref = ${params.tenantRef} AND owner_ref = ${ownerRef})
                )::int AS count`;
              const ownedIdentityCount = Number(owned[0]?.count ?? 0);
              if (!Number.isSafeInteger(ownedIdentityCount) || ownedIdentityCount < 0) {
                throw new Error('slotlock: invalid owner event count');
              }
              if (ownedIdentityCount >= configuredAgentOwnerEventQuota) {
                return {
                  ok: false,
                  code: 'owner_event_quota_exceeded',
                  limit: configuredAgentOwnerEventQuota,
                };
              }
            }
            if (!found) {
              const limit = await tenantLimitReached(tx, params.tenantRef, 'events');
              if (limit !== null) return { ok: false, code: 'event_limit_reached', limit };
            }
            const eventId = found?.id ?? randomUUID();
            const revision = currentRevision + 1;
            if (params.fromHold) {
              const { holdId, holderRef } = params.fromHold;
              if (!isValidResourceId(holdId) || !isValidIdentity(holderRef)) {
                return { ok: false, code: 'hold_not_found' };
              }
              const [hold] = await tx<
                { resource_id: string; starts_at: Date; ends_at: Date; hold_group_id: string | null; live: boolean }[]
              >`
                SELECT resource_id, starts_at, ends_at, hold_group_id,
                       expires_at > statement_timestamp() AS live
                  FROM slotlock.reservations
                 WHERE id = ${holdId} AND status = 'held' AND holder_ref = ${holderRef}
                 FOR UPDATE`;
              if (!hold) return { ok: false, code: 'hold_not_found' };
              // The holder's own hold that lapsed and is not yet reaped: named as the application
              // API's confirm names it. Another holder's stays not found.
              if (!hold.live) return { ok: false, code: 'hold_expired' };
              const [only] = occurrences;
              if (
                hold.resource_id !== params.resourceId ||
                occurrences.length !== 1 ||
                !only ||
                only.start < hold.starts_at ||
                only.end > hold.ends_at
              ) {
                return { ok: false, code: 'hold_mismatch' };
              }
              await tx`
                DELETE FROM slotlock.reservations
                 WHERE status = 'held' AND holder_ref = ${holderRef}
                   AND (id = ${holdId}
                        OR (${hold.hold_group_id}::uuid IS NOT NULL
                            AND hold_group_id = ${hold.hold_group_id}::uuid))`;
            }
            let turnaroundMs = 0;
            let bufferBeforeMs = 0;
            if (params.enforceBookingRules === true && (event.transparency ?? 'opaque') === 'opaque') {
              const judge = await bookingJudge(tx, params.resourceId, defaultHours);
              for (const [index, occurrence] of occurrences.entries()) {
                // A held time's notice and advance were judged when it was held.
                const rule = judge.broken(occurrence, { first: index === 0 && !params.fromHold });
                if (rule) return { ok: false, code: 'booking_rule_violated', rule };
              }
              turnaroundMs = judge.turnaroundMs;
              bufferBeforeMs = judge.bufferBeforeMs;
            }
            attemptedBuffers = { bufferBeforeMs, bufferAfterMs: turnaroundMs };
            const span = occurrenceSpan(occurrences);
            const reach = span && occupiedTime({ ...span, bufferBeforeMs, bufferAfterMs: turnaroundMs });
            if (
              (event.transparency ?? 'opaque') === 'opaque' &&
              reach &&
              !(found && (await holdsEveryOccurrence(tx, found.id, params.resourceId, occurrences)))
            ) {
              if (
                !(await recurrenceCoversWrite(tx, {
                  tenantRef: params.tenantRef,
                  resourceId: params.resourceId,
                  ...reach,
                  ...(found ? { exceptEventId: found.id } : {}),
                }))
              ) {
                return { ok: false, code: 'recurrence_not_materialized' };
              }
            }

            if (found) {
              await tx`
                UPDATE slotlock.calendar_events
                   SET resource_id = ${params.resourceId},
                       starts_at = ${event.start},
                       ends_at = ${event.end},
                       timezone = ${event.timezone},
                       summary = ${event.summary},
                       description = ${event.description ?? null},
                       location = ${event.location ?? null},
                       status = ${event.status ?? 'confirmed'},
                       transparency = ${event.transparency ?? 'opaque'},
                       organizer = ${event.organizer ? tx.json(organizerForJson(event.organizer)) : null},
                       attendees = ${tx.json(attendeesForJson(event.attendees))},
                       reminders = ${tx.json(remindersForJson(event.reminders))},
                       recurrence_rule = ${event.recurrence?.rrule ?? null},
                       recurrence_exceptions = ${tx.json(
                         eventExceptionsForJson(event.recurrence?.exceptions),
                       )},
                       materialized_starts_at = ${materializationWindow.start},
                       materialized_ends_at = ${materializationWindow.end},
                       recurrence_cursor = ${seriesCursorJson(tx, series.cursor)},
                       recurrence_ends_by = ${recurrenceEndsBy}::text::timestamptz,
                       roll_retry_at = NULL,
                       revision = ${revision},
                       source = ${params.source ?? null},
                       buffer_after_ms = ${turnaroundMs},
                       buffer_before_ms = ${bufferBeforeMs},
                       updated_at = now()
                 WHERE id = ${eventId}
                   AND tenant_ref = ${params.tenantRef}
                   AND owner_ref = ${ownerRef}`;
            } else {
              await tx`
                INSERT INTO slotlock.calendar_events (
                  id, tenant_ref, owner_ref, external_ref, resource_id, starts_at, ends_at, timezone,
                  summary, description, location, status, transparency, organizer, attendees,
                  reminders, recurrence_rule, recurrence_exceptions, materialized_starts_at,
                  materialized_ends_at, recurrence_cursor, recurrence_ends_by, revision, source,
                  buffer_after_ms, buffer_before_ms
                ) VALUES (
                  ${eventId}, ${params.tenantRef}, ${ownerRef}, ${params.externalRef},
                  ${params.resourceId},
                  ${event.start}, ${event.end}, ${event.timezone}, ${event.summary},
                  ${event.description ?? null}, ${event.location ?? null},
                  ${event.status ?? 'confirmed'}, ${event.transparency ?? 'opaque'},
                  ${event.organizer ? tx.json(organizerForJson(event.organizer)) : null},
                  ${tx.json(attendeesForJson(event.attendees))},
                  ${tx.json(remindersForJson(event.reminders))},
                  ${event.recurrence?.rrule ?? null},
                  ${tx.json(eventExceptionsForJson(event.recurrence?.exceptions))},
                  ${materializationWindow.start}, ${materializationWindow.end},
                  ${seriesCursorJson(tx, series.cursor)}, ${recurrenceEndsBy}::text::timestamptz,
                  ${revision}, ${params.source ?? null}, ${turnaroundMs}, ${bufferBeforeMs}
                )`;
            }

            // The normalized children are canonical; the JSON columns above are a compatibility
            // mirror until older readers retire.
            await replaceCalendarEventChildren(tx, params.tenantRef, eventId, event);
            // Writers to this resource take turns from here to its occupations (lockResourceForWrite).
            const locked = await lockResourceForWrite(tx, params.resourceId, params.tenantRef);
            if (!locked) return { ok: false, code: 'resource_tenant_mismatch' };
            if (locked.archived) return { ok: false, code: 'resource_archived' };
            await replaceCalendarEventOccurrences(tx, {
              tenantRef: params.tenantRef,
              eventId,
              resourceId: params.resourceId,
              event,
              occurrences,
              revision,
              bufferAfterMs: turnaroundMs,
              bufferBeforeMs,
            });

            await tx`
              INSERT INTO slotlock.calendar_event_commands (
                tenant_ref, owner_ref, idempotency_key, operation, payload_hash, event_id, external_ref,
                result_revision, occurrence_count
              ) VALUES (
                ${params.tenantRef}, ${ownerRef}, ${params.idempotencyKey}, 'put', ${payloadHash},
                ${eventId},
                ${params.externalRef}, ${revision}, ${occurrences.length}
              )`;
            return {
              ok: true,
              eventId,
              externalRef: params.externalRef,
              revision,
              occurrenceCount: occurrences.length,
              idempotent: false,
            };
          });
        } catch (error) {
          const code = pgCode(error);
          if ((code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE) && attempt === 1) {
            continue;
          }
          if (
            code !== EXCLUSION_VIOLATION &&
            code !== DEADLOCK_DETECTED &&
            code !== SERIALIZATION_FAILURE
          ) {
            throw error;
          }
          const span = occurrenceSpan(attempted);
          if (span) {
            const reach = occupiedTime({ ...span, ...attemptedBuffers });
            await rollSeriesBehind(sql, params.resourceId, reach.start, reach.end, storedEventId);
          }
          return findCalendarOverlap(sql, params.resourceId, attempted, storedEventId, attemptedBuffers);
        }
      }
    },

    async getCalendarEvent(params) {
      const ownerRef = params.ownerRef ?? SLOTLOCK_INTERNAL_EVENT_OWNER_REF;
      if (
        !isValidIdentity(params.tenantRef) ||
        !isValidEventOwnerRef(ownerRef) ||
        !isValidIdentity(params.externalRef)
      ) {
        throw Object.assign(new Error('Slotlock event identity must be 1-500 UTF-8 bytes'), {
          code: 'invalid_identity' as const,
        });
      }
      const rows = await sql<CalendarEventRow[]>`
        SELECT id, tenant_ref, owner_ref, external_ref, resource_id, starts_at, ends_at, timezone,
               summary, description, location, status, transparency, organizer, attendees,
               reminders, recurrence_rule, recurrence_exceptions, materialized_starts_at,
               materialized_ends_at, revision, source, created_at, updated_at
          FROM slotlock.calendar_events
         WHERE tenant_ref = ${params.tenantRef}
           AND owner_ref = ${ownerRef}
           AND external_ref = ${params.externalRef}`;
      const row = rows[0];
      if (!row) return null;
      const children = await loadCalendarEventChildren(sql, [row.id]);
      return toCalendarEvent(row, children.get(row.id));
    },

    async getCalendarEventById(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      if (!isValidResourceId(params.eventId)) {
        throw invalidIdentityError('Slotlock event id must be a UUID');
      }
      const rows = await sql<CalendarEventRow[]>`
        SELECT id, tenant_ref, owner_ref, external_ref, resource_id, starts_at, ends_at, timezone,
               summary, description, location, status, transparency, organizer, attendees,
               reminders, recurrence_rule, recurrence_exceptions, materialized_starts_at,
               materialized_ends_at, revision, source, created_at, updated_at
          FROM slotlock.calendar_events
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.eventId}`;
      const row = rows[0];
      if (!row) return null;
      const children = await loadCalendarEventChildren(sql, [row.id]);
      return toCalendarEvent(row, children.get(row.id));
    },

    async listCalendarEvents(params) {
      if (params.allOwners === true && params.ownerRef !== undefined) {
        throw invalidIdentityError('Slotlock lists one owner or every owner, not both');
      }
      const allOwners = params.allOwners === true;
      const ownerRef = params.ownerRef ?? SLOTLOCK_INTERNAL_EVENT_OWNER_REF;
      if (!isValidIdentity(params.tenantRef) || !isValidEventOwnerRef(ownerRef)) {
        throw Object.assign(new Error('Slotlock tenant reference must be 1-500 UTF-8 bytes'), {
          code: 'invalid_identity' as const,
        });
      }
      if (!isValidResourceId(params.resourceId)) {
        throw Object.assign(new Error('Slotlock resource id must be a UUID'), {
          code: 'invalid_identity' as const,
        });
      }
      const window = calendarWindow(params.window);
      const limit = params.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CALENDAR_LIST_LIMIT) {
        throw Object.assign(new Error('Slotlock calendar list limit must be 1-1000'), {
          code: 'invalid_limit' as const,
        });
      }
      if (
        params.after &&
        (!(params.after.start instanceof Date) ||
          !Number.isFinite(params.after.start.getTime()) ||
          !UUID_PATTERN.test(params.after.id))
      ) {
        throw Object.assign(new Error('Slotlock calendar cursor is invalid'), {
          code: 'invalid_cursor' as const,
        });
      }
      const afterStart = params.after?.start ?? null;
      const afterId = params.after?.id ?? null;
      const rows = await sql<CalendarEventRow[]>`
        SELECT event.id, event.tenant_ref, event.owner_ref, event.external_ref, event.resource_id,
               event.starts_at, event.ends_at, event.timezone, event.summary, event.description,
               event.location, event.status, event.transparency, event.organizer, event.attendees,
               event.reminders, event.recurrence_rule, event.recurrence_exceptions,
               event.materialized_starts_at, event.materialized_ends_at, event.revision,
               event.source, event.created_at, event.updated_at
          FROM slotlock.calendar_events event
         WHERE event.tenant_ref = ${params.tenantRef}
           AND (${allOwners}::boolean OR event.owner_ref = ${ownerRef})
           AND event.resource_id = ${params.resourceId}
           AND EXISTS (
             SELECT 1 FROM slotlock.calendar_event_occurrences occurrence
              WHERE occurrence.event_id = event.id
                AND occurrence.starts_at < ${window.end}
                AND occurrence.ends_at > ${window.start}
           )
           AND (
             ${afterStart}::timestamptz IS NULL
             OR event.starts_at > ${afterStart}::timestamptz
             OR (
               event.starts_at = ${afterStart}::timestamptz
               AND event.id > ${afterId}::uuid
             )
           )
         ORDER BY event.starts_at, event.id
         LIMIT ${limit}`;
      const children = await loadCalendarEventChildren(
        sql,
        rows.map((row) => row.id),
      );
      return rows.map((row) => toCalendarEvent(row, children.get(row.id)));
    },

    async rollCalendarEventHorizon(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw Object.assign(new Error('Slotlock tenant reference must be 1-500 UTF-8 bytes'), {
          code: 'invalid_identity' as const,
        });
      }
      const window = seriesWindow(params.window);
      const limit = params.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CALENDAR_LIST_LIMIT) {
        throw Object.assign(new Error('Slotlock horizon batch limit must be 1-1000'), {
          code: 'invalid_limit' as const,
        });
      }
      const after = rollCursor(params.after);
      // Due masters, never-deferred ones first, then deferred ones longest-waiting first: masters
      // it cannot extend never starve healthy ones, and deferred ones take turns.
      const candidates = await sql<
        { id: string; materialized_ends_at: Date; roll_retry_at: Date | null }[]
      >`
        SELECT id, materialized_ends_at, roll_retry_at
          FROM slotlock.calendar_events
         WHERE tenant_ref = ${params.tenantRef}
           AND recurrence_rule IS NOT NULL
           AND (
             materialized_starts_at > ${window.start}
             OR materialized_ends_at < ${window.end}
           )
           AND materialized_ends_at <= ${new Date(window.start.getTime() + MAX_MATERIALIZATION_WINDOW_MS)}
           -- One it could not extend waits its turn behind the ones it can.
           AND (roll_retry_at IS NULL OR roll_retry_at <= now())
           AND (
             ${after?.materializedEndsAt ?? null}::timestamptz IS NULL
             OR (COALESCE(roll_retry_at, '-infinity'), materialized_ends_at, id) >
                (COALESCE(${after?.rollRetryAt ?? null}::timestamptz, '-infinity'),
                 ${after?.materializedEndsAt ?? null}::timestamptz, ${after?.eventId ?? null}::uuid)
           )
         ORDER BY COALESCE(roll_retry_at, '-infinity'), materialized_ends_at, id
         LIMIT ${limit + 1}`;
      const due = candidates.slice(0, limit);
      let extended = 0;
      let conflicts = 0;
      let refused = 0;
      const refusedEventIds: string[] = [];
      const conflictEventIds: string[] = [];

      for (const candidate of due) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const changed = await inTransaction(sql, (tx) =>
              rollStoredSeries(tx, params.tenantRef, candidate.id, window),
            );
            if (changed) extended += 1;
            break;
          } catch (error) {
            if (error instanceof CalendarExpansionLimitError) {
              // Over the expansion budget (or a rule this release refuses): nothing written, old
              // coverage kept, later masters still roll.
              refused += 1;
              refusedEventIds.push(candidate.id);
              await deferRoll(sql, params.tenantRef, candidate.id);
              break;
            }
            const code = pgCode(error);
            if ((code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE) && attempt === 1) {
              continue;
            }
            if (
              code === EXCLUSION_VIOLATION ||
              code === DEADLOCK_DETECTED ||
              code === SERIALIZATION_FAILURE
            ) {
              // The savepoint rolled everything back, so old coverage stays truthful and callers
              // fail closed beyond it.
              conflicts += 1;
              conflictEventIds.push(candidate.id);
              await deferRoll(sql, params.tenantRef, candidate.id);
              break;
            }
            // Any other failure was rolled back with its savepoint too: defer it like an
            // over-budget one, so no single row stops the tenant's roll.
            refused += 1;
            refusedEventIds.push(candidate.id);
            await deferRoll(sql, params.tenantRef, candidate.id);
            break;
          }
        }
      }
      const last = due.at(-1);
      const hasMore = candidates.length > limit;
      return {
        examined: due.length,
        extended,
        conflicts,
        conflictEventIds,
        refused,
        refusedEventIds,
        hasMore,
        next:
          hasMore && last
            ? {
                rollRetryAt: last.roll_retry_at,
                materializedEndsAt: last.materialized_ends_at,
                eventId: last.id,
              }
            : null,
      };
    },

    async cancelCalendarEvent(params) {
      const ownerRef = params.ownerRef ?? SLOTLOCK_INTERNAL_EVENT_OWNER_REF;
      if (params.expectedResourceId !== undefined && !isValidResourceId(params.expectedResourceId)) {
        return { ok: false, code: 'invalid_identity' };
      }
      if (
        !isValidIdentity(params.tenantRef) ||
        !isValidEventOwnerRef(ownerRef) ||
        !isValidIdentity(params.externalRef) ||
        !isValidIdentity(params.idempotencyKey)
      ) {
        return { ok: false, code: 'invalid_identity' };
      }
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) {
        return { ok: false, code: 'invalid_revision' };
      }
      const payloadHash = cancelCommandHash({
        ownerRef,
        externalRef: params.externalRef,
        idempotencyKey: params.idempotencyKey,
        expectedRevision: params.expectedRevision,
      });
      return inTransaction(sql, async (tx): Promise<CancelCalendarEventResult> => {
        await lockCalendarIdempotency(tx, params.tenantRef, ownerRef, params.idempotencyKey);
        await lockCalendarEventIdentity(tx, params.tenantRef, ownerRef, params.externalRef);
        const commands = await tx<CalendarCommandRow[]>`
          SELECT operation, payload_hash, event_id, external_ref,
                 result_revision, occurrence_count
           FROM slotlock.calendar_event_commands
           WHERE tenant_ref = ${params.tenantRef}
             AND owner_ref = ${ownerRef}
             AND idempotency_key = ${params.idempotencyKey}
           FOR UPDATE`;
        const priorCommand = commands[0];
        if (priorCommand) {
          if (priorCommand.operation !== 'cancel' || priorCommand.payload_hash !== payloadHash) {
            return { ok: false, code: 'idempotency_conflict' };
          }
          return {
            ok: true,
            eventId: priorCommand.event_id,
            externalRef: priorCommand.external_ref,
            revision: Number(priorCommand.result_revision),
            idempotent: true,
          };
        }
        if (ownerRef !== SLOTLOCK_INTERNAL_EVENT_OWNER_REF) {
          await lockCalendarOwnerQuota(tx, params.tenantRef, ownerRef);
          const commandCount = await calendarOwnerCommandCount(tx, params.tenantRef, ownerRef);
          if (commandCount >= configuredAgentOwnerCommandQuota) {
            return {
              ok: false,
              code: 'owner_command_quota_exceeded',
              limit: configuredAgentOwnerCommandQuota,
            };
          }
        }
        const tombstones = await tx<{ event_id: string; revision: string | number }[]>`
          SELECT event_id, revision FROM slotlock.calendar_event_tombstones
           WHERE tenant_ref = ${params.tenantRef}
             AND owner_ref = ${ownerRef}
             AND external_ref = ${params.externalRef}
           FOR UPDATE`;
        if (tombstones[0]) {
          return {
            ok: false,
            code: 'revision_conflict',
            currentRevision: Number(tombstones[0].revision),
          };
        }
        const events = await tx<{ id: string; resource_id: string; revision: string | number }[]>`
          SELECT id, resource_id, revision FROM slotlock.calendar_events
           WHERE tenant_ref = ${params.tenantRef}
             AND owner_ref = ${ownerRef}
             AND external_ref = ${params.externalRef}
           FOR UPDATE`;
        const found = events[0];
        if (
          params.expectedResourceId !== undefined &&
          found?.resource_id !== params.expectedResourceId
        ) {
          return { ok: false, code: 'event_not_found' };
        }
        const currentRevision = found ? Number(found.revision) : 0;
        if (!found && ownerRef !== SLOTLOCK_INTERNAL_EVENT_OWNER_REF) {
          return { ok: false, code: 'event_not_found' };
        }
        if (params.expectedRevision !== currentRevision) {
          return { ok: false, code: 'revision_conflict', currentRevision };
        }
        return finishCalendarCancel(tx, {
          tenantRef: params.tenantRef,
          ownerRef,
          externalRef: params.externalRef,
          eventId: found?.id ?? null,
          revision: currentRevision + 1,
          commandOwnerRef: ownerRef,
          idempotencyKey: params.idempotencyKey,
          payloadHash,
        });
      });
    },

    async cancelCalendarEventById(params) {
      if (
        !isValidIdentity(params.tenantRef) ||
        !isValidResourceId(params.eventId) ||
        !isValidIdentity(params.idempotencyKey) ||
        (params.expectedResourceId !== undefined && !isValidResourceId(params.expectedResourceId))
      ) {
        return { ok: false, code: 'invalid_identity' };
      }
      if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) {
        return { ok: false, code: 'invalid_revision' };
      }
      const commandOwnerRef = SLOTLOCK_INTERNAL_EVENT_OWNER_REF;
      // Its own operation in the hash: an owner-scoped cancel under the same key never replays it.
      const payloadHash = calendarCommandHash({
        operation: 'cancel-by-id',
        eventId: params.eventId,
        idempotencyKey: params.idempotencyKey,
        expectedRevision: params.expectedRevision,
        expectedResourceId: params.expectedResourceId ?? null,
      });
      return inTransaction(sql, async (tx): Promise<CancelCalendarEventResult> => {
        await lockCalendarIdempotency(tx, params.tenantRef, commandOwnerRef, params.idempotencyKey);
        const commands = await tx<CalendarCommandRow[]>`
          SELECT operation, payload_hash, event_id, external_ref,
                 result_revision, occurrence_count
            FROM slotlock.calendar_event_commands
           WHERE tenant_ref = ${params.tenantRef}
             AND owner_ref = ${commandOwnerRef}
             AND idempotency_key = ${params.idempotencyKey}
           FOR UPDATE`;
        const priorCommand = commands[0];
        if (priorCommand) {
          if (priorCommand.operation !== 'cancel' || priorCommand.payload_hash !== payloadHash) {
            return { ok: false, code: 'idempotency_conflict' };
          }
          return {
            ok: true,
            eventId: priorCommand.event_id,
            externalRef: priorCommand.external_ref,
            revision: Number(priorCommand.result_revision),
            idempotent: true,
          };
        }
        // Owner and reference never change, so they are read before the identity lock, taken before
        // the row lock as every event write does.
        const [identity] = await tx<{ owner_ref: string; external_ref: string }[]>`
          SELECT owner_ref, external_ref FROM slotlock.calendar_events
           WHERE tenant_ref = ${params.tenantRef} AND id = ${params.eventId}`;
        if (!identity) return { ok: false, code: 'event_not_found' };
        await lockCalendarEventIdentity(
          tx,
          params.tenantRef,
          identity.owner_ref,
          identity.external_ref,
        );
        const [found] = await tx<{ id: string; resource_id: string; revision: string | number }[]>`
          SELECT id, resource_id, revision FROM slotlock.calendar_events
           WHERE tenant_ref = ${params.tenantRef} AND id = ${params.eventId}
           FOR UPDATE`;
        if (!found) return { ok: false, code: 'event_not_found' };
        if (
          params.expectedResourceId !== undefined &&
          found.resource_id !== params.expectedResourceId
        ) {
          return { ok: false, code: 'event_not_found' };
        }
        const currentRevision = Number(found.revision);
        if (params.expectedRevision !== currentRevision) {
          return { ok: false, code: 'revision_conflict', currentRevision };
        }
        return finishCalendarCancel(tx, {
          tenantRef: params.tenantRef,
          ownerRef: identity.owner_ref,
          externalRef: identity.external_ref,
          eventId: found.id,
          revision: currentRevision + 1,
          commandOwnerRef,
          idempotencyKey: params.idempotencyKey,
          payloadHash,
        });
      });
    },

    async followZoneRules(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const limit = params.limit ?? 100;
      if (!(Number.isSafeInteger(limit) && limit >= 1 && limit <= 1_000)) {
        throw new RangeError('Slotlock zone-rule batch must be 1-1,000 events');
      }
      const shifted = await sql<{
        id: string;
        resource_id: string;
        transparency: CalendarEventContent['transparency'];
        revision: string | number;
        buffer: string | number;
        buffer_before: string | number;
        starts_at: Date;
        ends_at: Date;
        moved_start: Date;
        moved_end: Date;
      }[]>`
        SELECT event.id, event.resource_id, event.transparency, event.revision, event.starts_at, event.ends_at,
               slotlock.zoned_instant(event.wall_starts_at, event.timezone) AS moved_start,
               slotlock.zoned_instant(event.wall_ends_at, event.timezone) AS moved_end,
               COALESCE((SELECT max(booking.buffer_after_ms) FROM slotlock.reservations booking
                          WHERE booking.calendar_event_id = event.id), 0) AS buffer,
               COALESCE((SELECT max(booking.buffer_before_ms) FROM slotlock.reservations booking
                          WHERE booking.calendar_event_id = event.id), 0) AS buffer_before
          FROM slotlock.calendar_events event
         WHERE event.tenant_ref = ${params.tenantRef}
           AND event.recurrence_rule IS NULL
           AND event.starts_at > now()
           AND event.zone_shift_reported_at IS NULL
           AND slotlock.zoned_instant(event.wall_starts_at, event.timezone) IS NOT NULL
           AND slotlock.zoned_instant(event.wall_ends_at, event.timezone) IS NOT NULL
           AND (slotlock.zoned_instant(event.wall_starts_at, event.timezone) <> event.starts_at
                OR slotlock.zoned_instant(event.wall_ends_at, event.timezone) <> event.ends_at)
         ORDER BY event.starts_at, event.id
         LIMIT ${limit}
         FOR UPDATE OF event SKIP LOCKED`;
      let moved = 0;
      let conflicts = 0;
      const report = async (event: (typeof shifted)[number], type: 'event.timezone_shifted' | 'event.timezone_conflict') => {
        await sql`UPDATE slotlock.calendar_events SET zone_shift_reported_at = now() WHERE id = ${event.id}`;
        await sql`
          INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
          VALUES (${params.tenantRef}, ${event.resource_id}, ${type}, ${event.id},
                  ${sql.json({
                    id: event.id,
                    resource_id: event.resource_id,
                    start: event.starts_at.toISOString(),
                    end: event.ends_at.toISOString(),
                    zone_start: event.moved_start.toISOString(),
                    zone_end: event.moved_end.toISOString(),
                  })}, 'slotlock:tzdata')`;
      };
      for (const event of shifted) {
        if (!params.move) {
          await report(event, 'event.timezone_shifted');
          continue;
        }
        try {
          await inTransaction(sql, async (tx) => {
            const revision = Number(event.revision) + 1;
            await tx`SELECT set_config('slotlock.actor', 'slotlock:tzdata', true)`;
            await tx`
              UPDATE slotlock.calendar_events
                 SET starts_at = ${event.moved_start}, ends_at = ${event.moved_end},
                     materialized_starts_at = ${event.moved_start}, materialized_ends_at = ${event.moved_end},
                     revision = ${revision}, updated_at = now()
               WHERE id = ${event.id}`;
            await replaceCalendarEventOccurrences(tx, {
              tenantRef: params.tenantRef,
              eventId: event.id,
              resourceId: event.resource_id,
              event: { transparency: event.transparency } as CalendarEventContent,
              occurrences: [
                { recurrenceId: event.moved_start.toISOString(), start: event.moved_start, end: event.moved_end },
              ],
              revision,
              bufferAfterMs: Number(event.buffer),
              bufferBeforeMs: Number(event.buffer_before),
            });
          });
          moved++;
        } catch (error) {
          if (pgCode(error) !== EXCLUSION_VIOLATION) throw error;
          await report(event, 'event.timezone_conflict');
          conflicts++;
        }
      }
      return { shifted: shifted.length, moved, conflicts };
    },

    async pruneBookingRetention(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const limit = params.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CALENDAR_LIST_LIMIT) {
        throw Object.assign(new Error('Slotlock retention batch limit must be 1-1000'), {
          code: 'invalid_limit' as const,
        });
      }
      // Never under the default: a shorter retention trims the feed, not how long a retry is
      // answered as the first was.
      const keepDays =
        params.retentionDays ?? Math.max(retentionDays, SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS);
      if (
        !Number.isSafeInteger(keepDays) ||
        keepDays < 1 ||
        keepDays > MAX_EVENT_COMMAND_RETENTION_DAYS
      ) {
        throw Object.assign(new Error('Slotlock retention window must be 1-3650 days'), {
          code: 'invalid_retention_window' as const,
        });
      }
      return inTransaction(sql, async (tx): Promise<BookingRetentionResult> => {
        // A 0.2 server still running after the migration wrote confirmed holds and
        // createReservation bookings without the tenant or a reference; give them both, as the
        // migration does. Each takes its reference's identity lock first, and a tombstone of its id
        // goes.
        const legacy = await tx<{ id: string }[]>`
          SELECT booking.id
            FROM slotlock.reservations booking
            JOIN slotlock.resources resource ON resource.id = booking.resource_id
           WHERE resource.tenant_ref = ${params.tenantRef}
             AND booking.tenant_ref IS NULL AND booking.status = 'confirmed'
             AND booking.calendar_event_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM slotlock.reservations taken
                WHERE taken.tenant_ref = ${params.tenantRef}
                  AND taken.external_ref = booking.id::text
                  AND taken.calendar_event_id IS NULL
             )
           ORDER BY booking.id
           LIMIT ${limit}`;
        for (const { id } of legacy) {
          await lockExternalIdentity(tx, params.tenantRef, id);
          const [taken] = await tx<{ id: string }[]>`
            SELECT id FROM slotlock.reservations
             WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${id}
               AND calendar_event_id IS NULL`;
          if (taken) continue;
          await tx`
            DELETE FROM slotlock.reservation_tombstones
             WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${id}`;
          await tx`
            UPDATE slotlock.reservations
               SET tenant_ref = ${params.tenantRef}, external_ref = id::text,
                   occupied_ends_at = ends_at + buffer_after_ms * interval '1 millisecond'
             WHERE id = ${id} AND tenant_ref IS NULL AND status = 'confirmed'`;
        }
        const expiredHoldsDeleted = await deleteExpiredHolds(tx, params.tenantRef, limit);
        const holdCommandsDeleted = await forgetExpiredHoldAnswers(tx, params.tenantRef, limit);
        // Only references retired with no booking: a cancelled booking's tombstone is kept.
        const [tombstones] = await tx<{ deleted: number }[]>`
          WITH candidates AS MATERIALIZED (
            SELECT tombstone.external_ref
              FROM slotlock.reservation_tombstones tombstone
             WHERE tombstone.tenant_ref = ${params.tenantRef}
               AND tombstone.stray
               AND tombstone.cancelled_at <
                   clock_timestamp() - (${keepDays}::int * interval '1 day')
             ORDER BY tombstone.cancelled_at, tombstone.external_ref
             LIMIT ${limit}
             FOR UPDATE OF tombstone SKIP LOCKED
          ), deleted AS (
            DELETE FROM slotlock.reservation_tombstones tombstone
             USING candidates candidate
             WHERE tombstone.tenant_ref = ${params.tenantRef}
               AND tombstone.external_ref = candidate.external_ref
               AND tombstone.stray
            RETURNING 1
          )
          SELECT count(*)::int AS deleted FROM deleted`;
        const tombstonesDeleted = Number(tombstones?.deleted ?? 0);
        return {
          expiredHoldsDeleted,
          holdCommandsDeleted,
          tombstonesDeleted,
          hasMore:
            legacy.length === limit ||
            expiredHoldsDeleted === limit ||
            holdCommandsDeleted === limit ||
            tombstonesDeleted === limit,
        };
      });
    },

    async pruneCalendarEventRetention(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw Object.assign(new Error('Slotlock tenant reference must be 1-500 UTF-8 bytes'), {
          code: 'invalid_identity' as const,
        });
      }
      const limit = params.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CALENDAR_LIST_LIMIT) {
        throw Object.assign(new Error('Slotlock retention batch limit must be 1-1000'), {
          code: 'invalid_limit' as const,
        });
      }
      // Never under the default: a shorter retention trims the feed, not how long a retry is
      // answered as the first was.
      const keepDays =
        params.retentionDays ?? Math.max(retentionDays, SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS);
      if (
        !Number.isSafeInteger(keepDays) ||
        keepDays < 1 ||
        keepDays > MAX_EVENT_COMMAND_RETENTION_DAYS
      ) {
        throw Object.assign(new Error('Slotlock retention window must be 1-3650 days'), {
          code: 'invalid_retention_window' as const,
        });
      }
      return inTransaction(sql, async (tx): Promise<CalendarEventRetentionResult> => {
        // Commands are replay evidence, never resurrection authority: after the window every
        // owner's go.
        const commands = await tx<{ deleted: number }[]>`
          WITH candidates AS MATERIALIZED (
            SELECT command.owner_ref, command.idempotency_key
              FROM slotlock.calendar_event_commands command
             WHERE command.tenant_ref = ${params.tenantRef}
               AND command.created_at <
                   clock_timestamp() - (${keepDays}::int * interval '1 day')
             ORDER BY command.created_at, command.owner_ref, command.idempotency_key
             LIMIT ${limit}
             FOR UPDATE OF command SKIP LOCKED
          ), deleted AS (
            DELETE FROM slotlock.calendar_event_commands command
             USING candidates candidate
             WHERE command.tenant_ref = ${params.tenantRef}
               AND command.owner_ref = candidate.owner_ref
               AND command.idempotency_key = candidate.idempotency_key
            RETURNING 1
          )
          SELECT count(*)::int AS deleted FROM deleted`;
        // An agent-owned tombstone may follow once all its commands are gone; internal ones are
        // provider/sync authority and stay. Locked rows are skipped and the predicate rechecked.
        const tombstones = await tx<{ deleted: number }[]>`
          WITH candidates AS MATERIALIZED (
            SELECT tombstone.owner_ref, tombstone.external_ref
              FROM slotlock.calendar_event_tombstones tombstone
             WHERE tombstone.tenant_ref = ${params.tenantRef}
               AND tombstone.owner_ref LIKE 'agent:%'
               AND tombstone.cancelled_at <
                   clock_timestamp() - (${keepDays}::int * interval '1 day')
               AND NOT EXISTS (
                 SELECT 1 FROM slotlock.calendar_event_commands command
                  WHERE command.tenant_ref = tombstone.tenant_ref
                    AND command.owner_ref = tombstone.owner_ref
                    AND command.event_id = tombstone.event_id
                    AND command.external_ref = tombstone.external_ref
               )
             ORDER BY tombstone.cancelled_at, tombstone.owner_ref, tombstone.external_ref
             LIMIT ${limit}
             FOR UPDATE OF tombstone SKIP LOCKED
          ), deleted AS (
            DELETE FROM slotlock.calendar_event_tombstones tombstone
             USING candidates candidate
             WHERE tombstone.tenant_ref = ${params.tenantRef}
               AND tombstone.owner_ref = candidate.owner_ref
               AND tombstone.external_ref = candidate.external_ref
               AND tombstone.owner_ref LIKE 'agent:%'
               AND tombstone.cancelled_at <
                   clock_timestamp() - (${keepDays}::int * interval '1 day')
               AND NOT EXISTS (
                 SELECT 1 FROM slotlock.calendar_event_commands command
                  WHERE command.tenant_ref = tombstone.tenant_ref
                    AND command.owner_ref = tombstone.owner_ref
                    AND command.event_id = tombstone.event_id
                    AND command.external_ref = tombstone.external_ref
               )
            RETURNING 1
          )
          SELECT count(*)::int AS deleted FROM deleted`;
        const commandsDeleted = Number(commands[0]?.deleted ?? 0);
        const tombstonesDeleted = Number(tombstones[0]?.deleted ?? 0);
        if (
          !Number.isSafeInteger(commandsDeleted) ||
          commandsDeleted < 0 ||
          !Number.isSafeInteger(tombstonesDeleted) ||
          tombstonesDeleted < 0
        ) {
          throw new Error('slotlock: invalid retention count');
        }
        return {
          commandsDeleted,
          tombstonesDeleted,
          hasMore: commandsDeleted === limit || tombstonesDeleted === limit,
        };
      });
    },

    async recordCalendarCoverage(params) {
      if (
        !isValidIdentity(params.tenantRef) ||
        !isValidIdentity(params.source) ||
        !isValidResourceId(params.resourceId)
      ) {
        return { ok: false, code: 'invalid_identity' };
      }
      let window: Interval;
      try {
        window = calendarWindow(params.window);
      } catch {
        return { ok: false, code: 'invalid_window' };
      }
      if (!Number.isSafeInteger(params.revision) || params.revision <= 0) {
        return { ok: false, code: 'invalid_revision' };
      }
      return inTransaction(sql, async (tx): Promise<CalendarCoverageResult> => {
        await lockExternalIdentity(
          tx,
          params.tenantRef,
          `calendar-coverage:${params.resourceId}:${params.source}`,
        );
        // Coverage of an archived resource may still be recorded: it books nothing.
        if ((await tenantResourceState(tx, params.resourceId, params.tenantRef)) === 'missing') {
          return { ok: false, code: 'resource_tenant_mismatch' };
        }
        const rows = await tx<{ starts_at: Date; ends_at: Date; revision: string | number }[]>`
          SELECT starts_at, ends_at, revision FROM slotlock.calendar_coverage
           WHERE tenant_ref = ${params.tenantRef}
             AND resource_id = ${params.resourceId}
             AND source = ${params.source}
           FOR UPDATE`;
        const found = rows[0];
        if (found) {
          const currentRevision = Number(found.revision);
          if (params.revision < currentRevision) return { ok: false, code: 'stale_revision' };
          if (params.revision === currentRevision) {
            if (
              found.starts_at.getTime() !== window.start.getTime() ||
              found.ends_at.getTime() !== window.end.getTime()
            ) {
              return { ok: false, code: 'idempotency_conflict' };
            }
            return { ok: true, revision: currentRevision, idempotent: true };
          }
          if (params.revision !== currentRevision + 1) {
            return { ok: false, code: 'revision_conflict' };
          }
          await tx`
            UPDATE slotlock.calendar_coverage
               SET starts_at = ${window.start}, ends_at = ${window.end},
                   revision = ${params.revision}, observed_at = now(), stale_reported_at = NULL
             WHERE tenant_ref = ${params.tenantRef}
               AND resource_id = ${params.resourceId}
               AND source = ${params.source}`;
        } else {
          if (params.revision !== 1) return { ok: false, code: 'revision_conflict' };
          const limit = await tenantLimitReached(tx, params.tenantRef, 'coverage');
          if (limit !== null) return { ok: false, code: 'coverage_limit_reached', limit };
          await tx`
            INSERT INTO slotlock.calendar_coverage (
              tenant_ref, resource_id, source, starts_at, ends_at, revision
            ) VALUES (
              ${params.tenantRef}, ${params.resourceId}, ${params.source},
              ${window.start}, ${window.end}, ${params.revision}
            )`;
        }
        return { ok: true, revision: params.revision, idempotent: false };
      });
    },

    async recordCoverageFailure(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.source) || !isValidResourceId(params.resourceId)) {
        return { ok: false, code: 'invalid_identity' };
      }
      const rows = await sql`
        UPDATE slotlock.calendar_coverage
           SET last_error = left(${String(params.error).replace(/[\u0000-\u001f\u007f]/g, ' ')}, 500),
               last_error_at = now()
         WHERE tenant_ref = ${params.tenantRef} AND resource_id = ${params.resourceId}
           AND source = ${params.source}
         RETURNING source`;
      return rows.length > 0 ? { ok: true } : { ok: false, code: 'coverage_not_found' };
    },

    async deleteCoverage(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.source) || !isValidResourceId(params.resourceId)) {
        return false;
      }
      const rows = await sql`
        DELETE FROM slotlock.calendar_coverage
         WHERE tenant_ref = ${params.tenantRef} AND resource_id = ${params.resourceId}
           AND source = ${params.source}
         RETURNING source`;
      return rows.length > 0;
    },

    async listCoverage(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.resourceId)) {
        throw invalidIdentityError('Slotlock coverage identity is invalid');
      }
      const maxAgeMs = params.maxAgeMs ?? 24 * 60 * 60 * 1000;
      const rows = await sql<{
        source: string;
        source_id: string;
        starts_at: Date;
        ends_at: Date;
        revision: string | number;
        observed_at: Date;
        last_error: string | null;
        last_error_at: Date | null;
        stale: boolean;
      }[]>`
        SELECT source, source_id, starts_at, ends_at, revision, observed_at, last_error, last_error_at,
               observed_at < now() - make_interval(secs => ${maxAgeMs / 1_000}) AS stale
          FROM slotlock.calendar_coverage
         WHERE tenant_ref = ${params.tenantRef} AND resource_id = ${params.resourceId}
         ORDER BY source`;
      return rows.map((row) => ({
        source: row.source,
        sourceId: row.source_id,
        start: row.starts_at,
        end: row.ends_at,
        revision: Number(row.revision),
        observedAt: row.observed_at,
        lastError: row.last_error,
        lastErrorAt: row.last_error_at,
        stale: row.stale,
      }));
    },

    async reportStaleCoverage(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const maxAgeMs = params.maxAgeMs ?? 24 * 60 * 60 * 1000;
      const rows = await sql<{ count: number }[]>`
        WITH stale AS (
          UPDATE slotlock.calendar_coverage coverage SET stale_reported_at = now()
           WHERE (coverage.tenant_ref, coverage.resource_id, coverage.source) IN (
             SELECT tenant_ref, resource_id, source FROM slotlock.calendar_coverage
              WHERE tenant_ref = ${params.tenantRef} AND stale_reported_at IS NULL
                AND observed_at < now() - make_interval(secs => ${maxAgeMs / 1_000})
              ORDER BY observed_at LIMIT ${params.limit ?? 100}
              FOR UPDATE SKIP LOCKED)
          RETURNING coverage.resource_id, coverage.source_id, coverage.observed_at
        ), reported AS (
          INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
          SELECT ${params.tenantRef}, stale.resource_id, 'coverage.stale', stale.source_id,
                 jsonb_build_object(
                   'resource_id', stale.resource_id, 'source_id', stale.source_id,
                   'observed_at', stale.observed_at),
                 'slotlock:maintenance'
            FROM stale
          RETURNING 1
        )
        SELECT count(*)::int AS count FROM reported`;
      return rows[0]?.count ?? 0;
    },

    async checkInReservation(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.externalRef)) {
        return { ok: false, code: 'invalid_identity' };
      }
      return inTransaction(sql, async (tx): Promise<CheckInReservationResult> => {
        const [row] = await tx<{ id: string; resource_id: string; checked_in_at: Date; ended: boolean; first: boolean }[]>`
          WITH booking AS (
            SELECT id, checked_in_at, ends_at <= statement_timestamp() AS ended,
                   starts_at - make_interval(mins => ${SLOTLOCK_CHECK_IN_OPENS_MINUTES}) > statement_timestamp() AS early
              FROM slotlock.reservations
             WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}
               AND calendar_event_id IS NULL AND status = 'confirmed'
             FOR UPDATE
          )
          UPDATE slotlock.reservations reservation
             SET checked_in_at = COALESCE(reservation.checked_in_at, statement_timestamp())
            FROM booking
           WHERE reservation.id = booking.id AND NOT booking.ended AND NOT booking.early
          RETURNING reservation.id, reservation.resource_id, reservation.checked_in_at,
                    false AS ended, booking.checked_in_at IS NULL AS first`;
        if (!row) {
          const [booking] = await tx<{ ended: boolean }[]>`
            SELECT ends_at <= statement_timestamp() AS ended FROM slotlock.reservations
             WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}
               AND calendar_event_id IS NULL AND status = 'confirmed'`;
          if (!booking) return { ok: false, code: 'reservation_not_found' };
          return { ok: false, code: booking.ended ? 'reservation_ended' : 'check_in_not_open' };
        }
        if (row.first) {
          await tx`
            INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
            VALUES (${params.tenantRef}, ${row.resource_id}, 'reservation.checked_in', ${params.externalRef},
                    jsonb_build_object('id', ${row.id}::uuid, 'reference', ${params.externalRef}::text,
                                       'resource_id', ${row.resource_id}::uuid,
                                       'checked_in_at', ${row.checked_in_at}::timestamptz),
                    NULLIF(current_setting('slotlock.actor', true), ''))`;
        }
        return { ok: true, reference: params.externalRef, checkedInAt: row.checked_in_at };
      });
    },

    async releaseNoShows(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const limit = params.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw invalidIdentityError('Slotlock no-show limit must be 1-1,000');
      }
      // A suspended tenant's bookings stay as they are.
      if (refusal) return 0;
      const tenantRef = params.tenantRef;
      // The same test twice: to find them, then under each reference's lock.
      const due = (tx: StoreSql, externalRef: string | null) => tx<
        { id: string; external_ref: string; revision: string | number; resource_id: string; minutes: number }[]
      >`
        SELECT reservation.id, reservation.external_ref, reservation.revision, reservation.resource_id,
               (resource.booking_rules->>'checkInMinutes')::int AS minutes
          FROM slotlock.reservations reservation
          JOIN slotlock.resources resource ON resource.id = reservation.resource_id
         WHERE reservation.tenant_ref = ${tenantRef} AND resource.tenant_ref = ${tenantRef}
           AND (${externalRef}::text IS NULL OR reservation.external_ref = ${externalRef})
           AND reservation.status = 'confirmed' AND reservation.calendar_event_id IS NULL
           AND reservation.checked_in_at IS NULL
           AND resource.check_in_since IS NOT NULL AND resource.booking_rules ? 'checkInMinutes'
           AND reservation.created_at >= resource.check_in_since
           -- A booking made after its start (a walk-in) has its window from when it was made.
           AND GREATEST(reservation.starts_at, reservation.created_at)
               + make_interval(mins => (resource.booking_rules->>'checkInMinutes')::int)
               <= statement_timestamp()
           AND reservation.ends_at > statement_timestamp()
         ORDER BY reservation.starts_at, reservation.id
         LIMIT ${externalRef === null ? limit : 1}
         ${externalRef === null ? tx`` : tx`FOR UPDATE OF reservation`}`;
      let released = 0;
      for (const candidate of await due(sql, null)) {
        const done = await inTransaction(sql, async (tx) => {
          await lockExternalIdentity(tx, tenantRef, candidate.external_ref);
          const [row] = await due(tx, candidate.external_ref);
          if (!row || row.id !== candidate.id) return false;
          const revision = Number(row.revision) + 1;
          await tx`
            INSERT INTO slotlock.reservation_tombstones (tenant_ref, external_ref, revision, stray)
            VALUES (${tenantRef}, ${row.external_ref}, ${revision}, false)`;
          // The deletion is the change: the feed's trigger names it reservation.no_show (one change,
          // not a cancellation too), by maintenance, with the check-in window it missed.
          await tx`
            SELECT set_config('slotlock.ending', 'no_show', true),
                   set_config('slotlock.ending_detail', ${String(row.minutes)}, true),
                   set_config('slotlock.actor', 'slotlock:maintenance', true)`;
          await tx`DELETE FROM slotlock.reservations WHERE id = ${row.id}`;
          await tx`
            SELECT set_config('slotlock.ending', '', true), set_config('slotlock.ending_detail', '', true)`;
          return true;
        });
        if (done) released += 1;
      }
      return released;
    },

    async joinWaitlist(params) {
      const { tenantRef, holderRef } = params;
      if (!isValidIdentity(tenantRef) || !isValidIdentity(holderRef)) return { ok: false, code: 'invalid_identity' };
      if ((params.resourceId === undefined) === (params.pool === undefined)) {
        return { ok: false, code: 'invalid_identity' };
      }
      if (params.resourceId !== undefined && !isValidResourceId(params.resourceId)) {
        return { ok: false, code: 'resource_not_found' };
      }
      if (params.pool !== undefined && !isPoolName(params.pool)) return { ok: false, code: 'invalid_pool' };
      const window = { start: params.start, end: params.end };
      if (
        !isFiniteWindow(window) ||
        window.end.getTime() - window.start.getTime() > MAX_WAITLIST_WINDOW_MS
      ) {
        return { ok: false, code: 'invalid_window' };
      }
      const offerTtlMs = params.offerTtlMs ?? DEFAULT_OFFER_TTL_MS;
      if (!Number.isSafeInteger(offerTtlMs) || offerTtlMs < 60_000 || offerTtlMs > 86_400_000) {
        return { ok: false, code: 'invalid_ttl' };
      }
      const key = params.idempotencyKey;
      if (key !== undefined && !isValidIdentity(key)) return { ok: false, code: 'invalid_identity' };
      const payloadHash =
        key === undefined
          ? null
          : createHash('sha256')
              .update(
                JSON.stringify([
                  params.resourceId ?? null,
                  params.pool ?? null,
                  window.start.toISOString(),
                  window.end.toISOString(),
                  holderRef,
                  offerTtlMs,
                ]),
              )
              .digest('hex');
      return inTransaction(sql, async (tx): Promise<JoinWaitlistResult> => {
        // The tenant's waitlist lock first, which offers and every join take: a retry racing its
        // first finds the entry the first made.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['slotlock-waitlist', tenantRef])}, 0))`;
        if (key !== undefined) {
          const [earlier] = await tx<(WaitlistRow & { payload_hash: string })[]>`
            SELECT ${tx.unsafe(WAITLIST_COLUMNS)}, payload_hash FROM slotlock.waitlist_entries
             WHERE tenant_ref = ${tenantRef} AND idempotency_key = ${key}`;
          if (earlier) {
            if (earlier.payload_hash !== payloadHash) return { ok: false, code: 'idempotency_conflict' };
            return { ok: true, entry: toWaitlistEntry(earlier), replayed: true };
          }
        }
        if (params.resourceId !== undefined) {
          const [resource] = await tx<{ archived: boolean }[]>`
            SELECT archived_at IS NOT NULL AS archived FROM slotlock.resources
             WHERE id = ${params.resourceId} AND tenant_ref = ${tenantRef}`;
          if (!resource) return { ok: false, code: 'resource_not_found' };
          if (resource.archived) return { ok: false, code: 'resource_archived' };
        } else {
          const [member] = await tx`
            SELECT 1 FROM slotlock.resources
             WHERE tenant_ref = ${tenantRef} AND pool_ref = ${params.pool ?? null} AND archived_at IS NULL
             LIMIT 1`;
          if (!member) return { ok: false, code: 'pool_not_found' };
        }
        // Counted under the tenant's waitlist lock (taken above), which offers take too, so racing
        // joins stop at the cap.
        const [counts] = await tx<{ tenant: number; holder: number }[]>`
          SELECT count(*)::int AS tenant, count(*) FILTER (WHERE holder_ref = ${holderRef})::int AS holder
            FROM slotlock.waitlist_entries WHERE tenant_ref = ${tenantRef} AND status = 'waiting'`;
        if (
          (counts?.holder ?? 0) >= SLOTLOCK_MAX_WAITLIST_PER_HOLDER ||
          (counts?.tenant ?? 0) >= SLOTLOCK_MAX_WAITLIST_PER_TENANT
        ) {
          return { ok: false, code: 'waitlist_limit_reached' };
        }
        const [row] = await tx<WaitlistRow[]>`
          INSERT INTO slotlock.waitlist_entries
            (tenant_ref, resource_id, pool_ref, starts_at, ends_at, holder_ref, offer_ttl_ms,
             idempotency_key, payload_hash)
          VALUES (${tenantRef}, ${params.resourceId ?? null}, ${params.pool ?? null}, ${window.start},
                  ${window.end}, ${holderRef}, ${offerTtlMs}, ${key ?? null}, ${payloadHash})
          RETURNING ${tx.unsafe(WAITLIST_COLUMNS)}`;
        return { ok: true, entry: toWaitlistEntry(row as WaitlistRow), replayed: false };
      });
    },

    async listWaitlist(params) {
      if (!isValidIdentity(params.tenantRef)) throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      if (params.resourceId !== undefined && !isValidResourceId(params.resourceId)) return [];
      const limit = params.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw invalidIdentityError('Slotlock waitlist limit must be 1-1,000');
      }
      const rows = await sql<WaitlistRow[]>`
        SELECT ${sql.unsafe(WAITLIST_COLUMNS)} FROM slotlock.waitlist_entries
         WHERE tenant_ref = ${params.tenantRef}
           AND (${params.resourceId ?? null}::uuid IS NULL OR resource_id = ${params.resourceId ?? null}::uuid)
           AND (${params.pool ?? null}::text IS NULL OR pool_ref = ${params.pool ?? null})
           AND (${params.holderRef ?? null}::text IS NULL OR holder_ref = ${params.holderRef ?? null})
         ORDER BY created_at, id
         LIMIT ${limit}`;
      return rows.map(toWaitlistEntry);
    },

    async leaveWaitlist(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.id)) return false;
      return inTransaction(sql, async (tx) => {
        const [left] = await tx<{ hold_id: string | null }[]>`
          DELETE FROM slotlock.waitlist_entries
           WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
             AND (${params.holderRef ?? null}::text IS NULL OR holder_ref = ${params.holderRef ?? null})
          RETURNING hold_id`;
        if (!left) return false;
        // An untaken offer's hold goes too; a confirmed one is a booking now and stays.
        if (left.hold_id) {
          await buildSlotlockStore(tx, options, null).releaseHold(left.hold_id, { tenantRef: params.tenantRef });
        }
        return true;
      });
    },

    async getAssistantSettings(params) {
      if (!isValidIdentity(params.tenantRef)) throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      const [row] = await sql<
        {
          provider: 'anthropic' | 'openai';
          base_url: string;
          model: string;
          sealed_key: string | null;
          key_hint: string | null;
          updated_by: string | null;
          updated_at: Date;
        }[]
      >`
        SELECT provider, base_url, model, sealed_key, key_hint, updated_by, updated_at
          FROM slotlock.assistant_settings WHERE tenant_ref = ${params.tenantRef}`;
      if (!row) return null;
      return {
        provider: row.provider,
        baseUrl: row.base_url,
        model: row.model,
        sealedKey: row.sealed_key,
        keyHint: row.key_hint,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
      };
    },

    async putAssistantSettings(params) {
      if (!isValidIdentity(params.tenantRef)) throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      const keep = params.key === 'keep';
      const key = params.key === 'keep' ? null : params.key;
      const saved = await sql`
        INSERT INTO slotlock.assistant_settings AS stored
          (tenant_ref, provider, base_url, model, sealed_key, key_hint, updated_by, updated_at)
        VALUES (${params.tenantRef}, ${params.provider}, ${params.baseUrl}, ${params.model},
                ${key?.sealed ?? null}, ${key?.hint ?? null}, ${params.updatedBy ?? null},
                statement_timestamp())
        ON CONFLICT (tenant_ref) DO UPDATE SET
          provider = EXCLUDED.provider,
          base_url = EXCLUDED.base_url,
          model = EXCLUDED.model,
          sealed_key = CASE WHEN ${keep}::boolean THEN stored.sealed_key ELSE EXCLUDED.sealed_key END,
          key_hint = CASE WHEN ${keep}::boolean THEN stored.key_hint ELSE EXCLUDED.key_hint END,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at
        WHERE NOT ${keep}::boolean
           OR stored.sealed_key IS NULL
           OR (stored.provider = EXCLUDED.provider AND stored.base_url = EXCLUDED.base_url)
        RETURNING 1`;
      return { saved: saved.length > 0 };
    },

    async deleteAssistantSettings(params) {
      if (!isValidIdentity(params.tenantRef)) return false;
      const rows = await sql`
        DELETE FROM slotlock.assistant_settings WHERE tenant_ref = ${params.tenantRef} RETURNING 1`;
      return rows.length > 0;
    },

    async resealAssistantKey(params) {
      if (!isValidIdentity(params.tenantRef)) return false;
      if (params.to.length === 0 || params.to === params.from) return false;
      const rows = await sql`
        UPDATE slotlock.assistant_settings SET sealed_key = ${params.to}
         WHERE tenant_ref = ${params.tenantRef} AND sealed_key = ${params.from}
        RETURNING 1`;
      return rows.length > 0;
    },

    async listAssistantChats(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.memberRef)) return [];
      const limit = params.limit ?? SLOTLOCK_ASSISTANT_MAX_CHATS;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > SLOTLOCK_ASSISTANT_MAX_CHATS) {
        throw invalidIdentityError(`Slotlock assistant chat list limit must be 1-${String(SLOTLOCK_ASSISTANT_MAX_CHATS)}`);
      }
      const rows = await sql<{ chat_id: string; title: string; updated_at: Date }[]>`
        SELECT chat_id, title, updated_at FROM slotlock.assistant_chats
         WHERE tenant_ref = ${params.tenantRef} AND member_ref = ${params.memberRef}
           AND (expires_at IS NULL OR expires_at > statement_timestamp())
         ORDER BY updated_at DESC, chat_id
         LIMIT ${limit}`;
      return rows.map((row) => ({ id: row.chat_id, title: row.title, updatedAt: row.updated_at }));
    },

    async getAssistantChat(params) {
      if (
        !isValidIdentity(params.tenantRef) ||
        !isValidIdentity(params.memberRef) ||
        !SLOTLOCK_ASSISTANT_CHAT_ID.test(params.chatId)
      ) {
        return null;
      }
      const [row] = await sql<
        {
          title: string;
          messages: unknown[];
          actions: Record<string, Record<string, unknown>>;
          created_at: Date;
          updated_at: Date;
          expires_at: Date | null;
        }[]
      >`
        SELECT title, messages, actions, created_at, updated_at, expires_at FROM slotlock.assistant_chats
         WHERE tenant_ref = ${params.tenantRef} AND member_ref = ${params.memberRef}
           AND chat_id = ${params.chatId}
           AND (expires_at IS NULL OR expires_at > statement_timestamp())`;
      if (!row) return null;
      return {
        id: params.chatId,
        title: row.title,
        messages: row.messages,
        actions: row.actions,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
      };
    },

    async putAssistantChat(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidIdentity(params.memberRef)) {
        throw invalidIdentityError('Slotlock tenant and member references must be 1-500 UTF-8 bytes');
      }
      if (!SLOTLOCK_ASSISTANT_CHAT_ID.test(params.chatId)) {
        throw invalidIdentityError('Slotlock assistant chat id must be 16 URL-safe characters');
      }
      const title = params.title.trim();
      if ([...title].length < 1 || [...title].length > 120) {
        throw invalidIdentityError('Slotlock assistant chat title must be 1-120 characters');
      }
      if (
        params.ttlMs !== null &&
        (!Number.isSafeInteger(params.ttlMs) || params.ttlMs < 1_000 || params.ttlMs > 3_650 * 86_400_000)
      ) {
        throw invalidIdentityError('Slotlock assistant conversation ttlMs must be 1 second to 3,650 days');
      }
      const ttlSeconds = params.ttlMs === null ? null : params.ttlMs / 1_000;
      const messages = sql.json(params.messages as never);
      const added = sql.json(params.added as never);
      const keep = [...params.keep];
      await sql`
        INSERT INTO slotlock.assistant_chats AS stored
          (tenant_ref, member_ref, chat_id, title, messages, actions, created_at, updated_at, expires_at)
        VALUES (${params.tenantRef}, ${params.memberRef}, ${params.chatId}, ${title}, ${messages}, ${added},
                statement_timestamp(), statement_timestamp(),
                CASE WHEN ${ttlSeconds}::double precision IS NULL THEN NULL
                     ELSE statement_timestamp() + make_interval(secs => ${ttlSeconds}::double precision) END)
        ON CONFLICT (tenant_ref, member_ref, chat_id) DO UPDATE SET
          messages = EXCLUDED.messages,
          -- The stored ones kept, as they stand, then the new ones: never a settled one again.
          actions = (
            SELECT coalesce(jsonb_object_agg(existing.key, existing.value), '{}'::jsonb)
              FROM jsonb_each(stored.actions) AS existing
             WHERE existing.key = ANY(${keep}::text[])
          ) || (
            SELECT coalesce(jsonb_object_agg(fresh.key, fresh.value), '{}'::jsonb)
              FROM jsonb_each(EXCLUDED.actions) AS fresh
             WHERE NOT stored.actions ? fresh.key
          ),
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at`;
      // The member keeps the most recent; past the limit, the least recently used go.
      await sql`
        DELETE FROM slotlock.assistant_chats gone
         WHERE gone.tenant_ref = ${params.tenantRef} AND gone.member_ref = ${params.memberRef}
           AND gone.chat_id IN (
             SELECT kept.chat_id FROM slotlock.assistant_chats kept
              WHERE kept.tenant_ref = ${params.tenantRef} AND kept.member_ref = ${params.memberRef}
              ORDER BY kept.updated_at DESC, kept.chat_id
             OFFSET ${SLOTLOCK_ASSISTANT_MAX_CHATS})`;
      if (ttlSeconds !== null) {
        await sql`
          SELECT slotlock.register_assistant_tenant(
            ${params.tenantRef}::text,
            statement_timestamp() + make_interval(secs => ${ttlSeconds}::double precision))`;
      }
    },

    async renameAssistantChat(params) {
      if (
        !isValidIdentity(params.tenantRef) ||
        !isValidIdentity(params.memberRef) ||
        !SLOTLOCK_ASSISTANT_CHAT_ID.test(params.chatId)
      ) {
        return false;
      }
      const title = params.title.trim();
      if ([...title].length < 1 || [...title].length > 120) {
        throw invalidIdentityError('Slotlock assistant chat title must be 1-120 characters');
      }
      const rows = await sql`
        UPDATE slotlock.assistant_chats SET title = ${title}
         WHERE tenant_ref = ${params.tenantRef} AND member_ref = ${params.memberRef}
           AND chat_id = ${params.chatId}
           AND (expires_at IS NULL OR expires_at > statement_timestamp())
        RETURNING 1`;
      return rows.length > 0;
    },

    async settleAssistantAction(params) {
      if (
        !isValidIdentity(params.tenantRef) ||
        !isValidIdentity(params.memberRef) ||
        !SLOTLOCK_ASSISTANT_CHAT_ID.test(params.chatId)
      ) {
        return null;
      }
      const patch = sql.json(params.patch as never);
      const [row] = await sql<{ action: Record<string, unknown> }[]>`
        UPDATE slotlock.assistant_chats
           SET actions = jsonb_set(actions, ARRAY[${params.actionId}::text],
                                   (actions -> ${params.actionId}::text) || ${patch}::jsonb)
         WHERE tenant_ref = ${params.tenantRef} AND member_ref = ${params.memberRef}
           AND chat_id = ${params.chatId}
           AND (expires_at IS NULL OR expires_at > statement_timestamp())
           AND actions -> ${params.actionId}::text ->> 'status' = ${params.from}
        RETURNING actions -> ${params.actionId}::text AS action`;
      return row?.action ?? null;
    },

    async pruneAssistantConversations(params) {
      if (!isValidIdentity(params.tenantRef)) return 0;
      const limit = params.limit ?? 1_000;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw invalidIdentityError('Slotlock assistant prune limit must be 1-10,000');
      }
      // The conversations a deployment gave a lifetime, past it; and those 0.8 kept, past theirs.
      const chats = await sql`
        DELETE FROM slotlock.assistant_chats
         WHERE tenant_ref = ${params.tenantRef}
           AND (member_ref, chat_id) IN (
             SELECT member_ref, chat_id FROM slotlock.assistant_chats
              WHERE tenant_ref = ${params.tenantRef} AND expires_at <= statement_timestamp()
              LIMIT ${limit})
           AND expires_at <= statement_timestamp()
        RETURNING 1`;
      const old = await sql`
        DELETE FROM slotlock.assistant_conversations
         WHERE tenant_ref = ${params.tenantRef}
           AND member_ref IN (
             SELECT member_ref FROM slotlock.assistant_conversations
              WHERE tenant_ref = ${params.tenantRef} AND expires_at <= statement_timestamp()
              LIMIT ${limit})
           AND expires_at <= statement_timestamp()
        RETURNING 1`;
      return chats.length + old.length;
    },

    async sweepAssistantConversations(params) {
      const limit = params?.limit ?? 10_000;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
        throw invalidIdentityError('Slotlock assistant sweep limit must be 1-100,000');
      }
      const [row] = await sql<{ deleted: string | number }[]>`
        SELECT slotlock.sweep_assistant_conversations(${limit}::integer) AS deleted`;
      return Number(row?.deleted ?? 0);
    },

    async deleteAssistantChat(params) {
      if (
        !isValidIdentity(params.tenantRef) ||
        !isValidIdentity(params.memberRef) ||
        !SLOTLOCK_ASSISTANT_CHAT_ID.test(params.chatId)
      ) {
        return false;
      }
      const rows = await sql`
        DELETE FROM slotlock.assistant_chats
         WHERE tenant_ref = ${params.tenantRef} AND member_ref = ${params.memberRef}
           AND chat_id = ${params.chatId} RETURNING 1`;
      return rows.length > 0;
    },

    async offerWaitlist(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const limit = params.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw invalidIdentityError('Slotlock waitlist offer limit must be 1-100');
      }
      // A suspended tenant gets no new holds.
      if (refusal) return { offered: 0, expired: 0, next: null };
      const tenantRef = params.tenantRef;
      const after = params.after ?? null;
      return inTransaction(sql, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['slotlock-waitlist', tenantRef])}, 0))`;
        let expired = 0;
        if (!after) {
          const [gone] = await tx<{ count: number }[]>`
            WITH gone AS (
              UPDATE slotlock.waitlist_entries SET status = 'expired'
               WHERE tenant_ref = ${tenantRef} AND status = 'waiting' AND starts_at <= statement_timestamp()
              RETURNING id, resource_id, pool_ref, starts_at, ends_at, holder_ref
            ), reported AS (
              INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
              SELECT ${tenantRef}, gone.resource_id, 'waitlist.expired', gone.id::text,
                     jsonb_strip_nulls(jsonb_build_object(
                       'id', gone.id, 'resource_id', gone.resource_id, 'pool', gone.pool_ref,
                       'start', gone.starts_at, 'end', gone.ends_at, 'holder_ref', gone.holder_ref)),
                     'slotlock:maintenance'
                FROM gone
              RETURNING 1
            )
            SELECT count(*)::int AS count FROM reported`;
          expired = gone?.count ?? 0;
          await tx`
            DELETE FROM slotlock.waitlist_entries
             WHERE tenant_ref = ${tenantRef} AND status <> 'waiting'
               AND ends_at < statement_timestamp() - make_interval(days => ${retentionDays})`;
        }
        const waiting = await tx<WaitlistRow[]>`
          SELECT ${tx.unsafe(WAITLIST_COLUMNS)} FROM slotlock.waitlist_entries
           WHERE tenant_ref = ${tenantRef} AND status = 'waiting'
             AND (${after?.createdAt ?? null}::timestamptz IS NULL
                  OR (created_at, id) > (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
           ORDER BY created_at, id
           LIMIT ${limit}`;
        const inner = buildSlotlockStore(tx, options, null);
        let offered = 0;
        for (const entry of waiting) {
          const [still] = await tx`
            SELECT 1 FROM slotlock.waitlist_entries
             WHERE id = ${entry.id} AND status = 'waiting' FOR UPDATE`;
          if (!still) continue;
          // Only resources that look free (buffers included) are tried: a refused hold keeps its
          // locks until the transaction ends.
          const candidates = await tx<{ id: string }[]>`
            SELECT resources.id
              FROM slotlock.resources,
                   LATERAL (SELECT ${tx.unsafe(EFFECTIVE_BOOKING_RULES)}) effective,
                   LATERAL (SELECT
                     COALESCE(least(greatest((effective.effective_booking_rules->>'bufferBeforeMinutes')::numeric, 0), 1440)::int, 0)
                       AS before_minutes,
                     COALESCE(least(greatest((effective.effective_booking_rules->>'turnaroundMinutes')::numeric, 0), 1440)::int, 0)
                       AS after_minutes) buffers
             WHERE resources.tenant_ref = ${tenantRef} AND resources.archived_at IS NULL
               AND (resources.id = ${entry.resource_id}::uuid
                    OR (${entry.resource_id}::uuid IS NULL AND resources.pool_ref = ${entry.pool_ref}))
               AND NOT EXISTS (
                 SELECT 1 FROM slotlock.reservations taken
                  WHERE taken.resource_id = resources.id
                    AND tstzrange(COALESCE(taken.occupied_starts_at, taken.starts_at),
                                  COALESCE(taken.occupied_ends_at, taken.ends_at), '[)')
                        && tstzrange(${entry.starts_at}::timestamptz - make_interval(mins => buffers.before_minutes),
                                     ${entry.ends_at}::timestamptz + make_interval(mins => buffers.after_minutes), '[)')
                    AND (taken.status <> 'held' OR taken.expires_at > statement_timestamp()))
             ORDER BY resources.id
             LIMIT ${OFFER_CANDIDATES}`;
          for (const { id: resourceId } of candidates) {
            const hold = await inner.acquireHold({
              resourceId,
              start: entry.starts_at,
              end: entry.ends_at,
              ttlMs: Number(entry.offer_ttl_ms),
              tenantRef,
              holderRef: entry.holder_ref,
              source: 'slotlock:waitlist',
            });
            if (!hold.ok) continue;
            await tx`
              UPDATE slotlock.waitlist_entries
                 SET status = 'offered', hold_id = ${hold.hold.id}, offered_resource_id = ${resourceId},
                     offered_at = statement_timestamp()
               WHERE id = ${entry.id}`;
            await tx`
              INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
              VALUES (${tenantRef}, ${resourceId}, 'waitlist.offered', ${entry.id},
                      jsonb_strip_nulls(jsonb_build_object(
                        'id', ${entry.id}::uuid, 'hold_id', ${hold.hold.id}::uuid,
                        'resource_id', ${resourceId}::uuid, 'pool', ${entry.pool_ref}::text,
                        'start', ${entry.starts_at}::timestamptz, 'end', ${entry.ends_at}::timestamptz,
                        'expires_at', ${hold.hold.expiresAt}::timestamptz,
                        'holder_ref', ${entry.holder_ref}::text)),
                      'slotlock:maintenance')`;
            offered += 1;
            break;
          }
        }
        const last = waiting.length === limit ? waiting[waiting.length - 1] : undefined;
        return { offered, expired, next: last ? { createdAt: last.created_at, id: last.id } : null };
      });
    },

    async getFreeBusy(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw Object.assign(new Error('Slotlock tenant reference must be 1-500 UTF-8 bytes'), {
          code: 'invalid_identity' as const,
        });
      }
      if (!isValidResourceId(params.resourceId)) {
        throw Object.assign(new Error('Slotlock resource id must be a UUID'), {
          code: 'invalid_identity' as const,
        });
      }
      const window = calendarWindow(params.window);
      const callerRequiredSources = [...new Set(params.requiredSources ?? [])];
      if (
        callerRequiredSources.length > MAX_COVERAGE_SOURCES ||
        callerRequiredSources.some((source) => !isValidIdentity(source))
      ) {
        throw Object.assign(new Error('Slotlock coverage sources must be 1-500 UTF-8 bytes'), {
          code: 'invalid_identity' as const,
        });
      }
      const coverageMaxAgeMs = params.coverageMaxAgeMs ?? 24 * 60 * 60 * 1000;
      if (
        !Number.isSafeInteger(coverageMaxAgeMs) ||
        coverageMaxAgeMs <= 0 ||
        coverageMaxAgeMs > MAX_COVERAGE_AGE_MS
      ) {
        throw Object.assign(new Error('Slotlock coverage max age is outside its safe bound'), {
          code: 'invalid_coverage_age' as const,
        });
      }
      const owner = await sql<{ id: string; require_certain: boolean }[]>`
        SELECT id, COALESCE((effective.effective_booking_rules->>'requireCertain')::boolean, false)
                 AS require_certain
          FROM slotlock.resources,
               LATERAL (SELECT ${sql.unsafe(EFFECTIVE_BOOKING_RULES)}) effective
         WHERE id = ${params.resourceId} AND tenant_ref = ${params.tenantRef}`;
      if (!owner[0]) {
        throw Object.assign(new Error('Slotlock resource belongs to another tenant'), {
          code: 'resource_tenant_mismatch' as const,
        });
      }
      const busyRows = await sql<{ starts_at: Date; occupied_ends_at: Date }[]>`
        SELECT COALESCE(reservation.occupied_starts_at, reservation.starts_at) AS starts_at,
               COALESCE(reservation.occupied_ends_at, reservation.ends_at) AS occupied_ends_at
          FROM slotlock.reservations reservation
         WHERE reservation.resource_id = ${params.resourceId}
           AND ${occupiedStartsBefore(sql, window.end, 'reservation')}
           AND COALESCE(reservation.occupied_ends_at, reservation.ends_at) > ${window.start}
           AND (reservation.status <> 'held' OR reservation.expires_at > statement_timestamp())
        UNION ALL
        ${compositeBusy(sql, params.resourceId, window)}
         ORDER BY 1
         LIMIT ${MAX_FREE_BUSY_INTERVALS + 1}`;
      if (busyRows.length > MAX_FREE_BUSY_INTERVALS) {
        throw Object.assign(new Error('Slotlock free/busy work limit exceeded'), {
          code: 'calendar_work_limit' as const,
        });
      }
      const [localRecurrenceCoverage] = await sql<
        { source_count: number; complete: boolean | null; overlaps: boolean | null }[]
      >`
        WITH recurring_sources AS (
          SELECT event.materialized_starts_at,
                 event.materialized_ends_at,
                 LEAST(
                   event.starts_at,
                   COALESCE((
                     SELECT min(exception.starts_at)
                       FROM slotlock.calendar_event_exceptions exception
                      WHERE exception.tenant_ref = event.tenant_ref
                        AND exception.event_id = event.id
                        AND exception.cancelled = false
                   ), event.starts_at)
                 ) AS earliest_possible_at
            FROM slotlock.calendar_events event
           WHERE event.tenant_ref = ${params.tenantRef}
             AND event.resource_id = ${params.resourceId}
             AND event.recurrence_rule IS NOT NULL
             AND event.transparency = 'opaque'
        )
        SELECT count(*)::int AS source_count,
               -- Complete when what is stored runs from where the series can first occur in the
               -- window (its start, if that is later) to the window's end: a series stored only
               -- from after its start leaves the occurrences before that unknown.
               bool_and(
                 materialized_ends_at >= ${window.end}
                 AND materialized_starts_at <= GREATEST(earliest_possible_at, ${window.start})
               ) AS complete,
               bool_or(
                 materialized_ends_at > ${window.start}
                 AND materialized_starts_at < ${window.end}
               ) AS overlaps
          FROM recurring_sources
         WHERE earliest_possible_at < ${window.end}`;
      const localRecurrenceRequired = Number(localRecurrenceCoverage?.source_count ?? 0) > 0;
      // Requiring certainty means every sync covering the resource, judged by the same day, as
      // writes do (bookingJudge).
      const requireCertain = owner[0].require_certain;
      const recordedSources = requireCertain
        ? (
            await sql<{ source: string }[]>`
              SELECT source FROM slotlock.calendar_coverage
               WHERE tenant_ref = ${params.tenantRef} AND resource_id = ${params.resourceId}`
          ).map(({ source }) => source)
        : [];
      const providerRequiredSources = [...new Set([...callerRequiredSources, ...recordedSources])].filter(
        (source) => source !== SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE,
      );
      if (!localRecurrenceRequired && providerRequiredSources.length === 0) {
        return {
          busy: mergeIntervals(
            busyRows.map((row) => ({
              start: row.starts_at < window.start ? window.start : row.starts_at,
              end: row.occupied_ends_at > window.end ? window.end : row.occupied_ends_at,
            })),
          ),
          coverage: { state: 'complete', missingSources: [] },
        };
      }
      const ageSeconds =
        (requireCertain ? Math.min(coverageMaxAgeMs, CERTAIN_COVERAGE_MAX_AGE_MS) : coverageMaxAgeMs) / 1000;
      const coverageRows =
        providerRequiredSources.length === 0
          ? []
          : await sql<{ source: string; starts_at: Date; ends_at: Date; fresh: boolean }[]>`
              SELECT source, starts_at, ends_at,
                     observed_at >= now() - make_interval(secs => ${ageSeconds}) AS fresh
                FROM slotlock.calendar_coverage
               WHERE tenant_ref = ${params.tenantRef}
                 AND resource_id = ${params.resourceId}
                 AND source IN ${sql(providerRequiredSources)}`;
      const bySource = new Map(coverageRows.map((row) => [row.source, row]));
      const missingSources = providerRequiredSources.filter((source) => {
        const coverage = bySource.get(source);
        return (
          !coverage?.fresh || coverage.starts_at > window.start || coverage.ends_at < window.end
        );
      });
      let hasFreshOverlap = coverageRows.some(
        (coverage) =>
          coverage.fresh && coverage.starts_at < window.end && coverage.ends_at > window.start,
      );
      if (localRecurrenceRequired) {
        if (localRecurrenceCoverage?.complete !== true) {
          // The intrinsic source first: the caller can repair it by rolling the horizon,
          // independent of providers.
          missingSources.unshift(SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE);
        }
        hasFreshOverlap ||= localRecurrenceCoverage?.overlaps === true;
      }
      return {
        busy: mergeIntervals(
          busyRows.map((row) => ({
            start: row.starts_at < window.start ? window.start : row.starts_at,
            end: row.occupied_ends_at > window.end ? window.end : row.occupied_ends_at,
          })),
        ),
        coverage: {
          state: missingSources.length === 0 ? 'complete' : hasFreshOverlap ? 'partial' : 'unknown',
          missingSources,
        },
      };
    },

    async findNextAvailableFor(params) {
      const asked = params.searchWindow;
      if (!isFiniteWindow(asked)) throw invalidWindowError();
      assertBoundedSearchWindow(asked);
      const { tenantRef } = params;
      if (tenantRef !== null && !isValidIdentity(tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const askedBufferMs = params.bufferAfterMs ?? 0;
      if (
        !Number.isSafeInteger(askedBufferMs) ||
        askedBufferMs < 0 ||
        askedBufferMs > MAX_BUFFER_AFTER_MS
      ) {
        throw Object.assign(new Error('Slotlock bufferAfterMs must be a whole 0-30 days'), {
          code: 'invalid_buffer' as const,
        });
      }
      const notFound = () =>
        Object.assign(new Error('Slotlock resource not found in this tenant'), {
          code: 'resource_not_found' as const,
        });
      if (!isValidResourceId(params.resourceId)) throw notFound();
      const [row] = await sql<(ResourceRow & { now: Date })[]>`
        SELECT ${sql.unsafe(RESOURCE_COLUMNS)}, ${sql.unsafe(EFFECTIVE_BOOKING_RULES)}, statement_timestamp() AS now
          FROM slotlock.resources
         WHERE id = ${params.resourceId} AND tenant_ref IS NOT DISTINCT FROM ${tenantRef}`;
      if (!row) throw notFound();
      if (!Number.isFinite(params.durationMs) || params.durationMs <= 0) return null;
      const resource = toResource(row);
      const rules = params.rules ?? resource.availabilityRules ?? [];
      const search = bookingSearch({
        rules: resource.effectiveBookingRules,
        timezone: resource.timezone,
        window: asked,
        now: row.now,
        bufferAfterMs: askedBufferMs,
      });
      if (!search) return null;
      const { window } = search;
      // A slot's buffers may run past the window: that reach must be proven free too.
      const reach = bookingSearchReach(search);
      let busy: Interval[];
      if (tenantRef === null) {
        // A tenantless resource has no events, coverage or series: only its rows.
        busy = await this.listBusy(params.resourceId, reach);
      } else {
        busy = [];
        const parts = [
          ...(reach.start < window.start ? [{ start: reach.start, end: window.start }] : []),
          window,
          ...(reach.end > window.end ? [{ start: window.end, end: reach.end }] : []),
        ];
        for (const part of parts) {
          const freeBusy = await this.getFreeBusy({
            tenantRef,
            resourceId: params.resourceId,
            window: part,
            ...(params.requiredSources !== undefined
              ? { requiredSources: params.requiredSources }
              : {}),
            ...(params.coverageMaxAgeMs !== undefined
              ? { coverageMaxAgeMs: params.coverageMaxAgeMs }
              : {}),
          });
          // Absence is never free time.
          if (freeBusy.coverage.state !== 'complete') return null;
          busy.push(...freeBusy.busy);
        }
      }
      return findNextAvailable({
        busy: bookingSearchBlocked(busy, search),
        windows: expandRules(rules, window, resource.timezone),
        durationMs: params.durationMs,
        ...(search.align ? { align: search.align } : {}),
      });
    },

    async suspendTenant(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const reason = params.reason;
      if (
        reason !== undefined &&
        (typeof reason !== 'string' ||
          reason.length === 0 ||
          Array.from(reason).length > 500 ||
          Array.from(reason).some((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
          }))
      ) {
        throw Object.assign(
          new Error('Slotlock suspension reason must be 1-500 characters without control characters'),
          { code: 'invalid_suspension_reason' as const },
        );
      }
      try {
        const [row] = await sql<{ suspended: boolean }[]>`
          SELECT slotlock.suspend_tenant(${params.tenantRef}::text, ${reason ?? null}::text) AS suspended`;
        return { suspended: row?.suspended === true };
      } catch (error) {
        throw suspensionRefusal(error);
      }
    },

    async unsuspendTenant(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      try {
        const [row] = await sql<{ unsuspended: boolean }[]>`
          SELECT slotlock.unsuspend_tenant(${params.tenantRef}::text) AS unsuspended`;
        return { unsuspended: row?.unsuspended === true };
      } catch (error) {
        throw suspensionRefusal(error);
      }
    },

    async isTenantSuspended(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const [row] = await sql<{ suspended: boolean }[]>`
        SELECT slotlock.tenant_suspended(${params.tenantRef}::text) AS suspended`.catch(
        (error: unknown) => {
          throw suspensionCheckRefusal(error);
        },
      );
      return row?.suspended === true;
    },

    async eraseTenant(params) {
      if (!isValidIdentity(params.tenantRef)) {
        throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      }
      const erased = await sql<{ erased_table: string; erased_rows: string | number }[]>`
        SELECT erased_table, erased_rows FROM slotlock.erase_tenant(${params.tenantRef}::text)`.catch(
        (error: unknown) => {
          throw billingActiveRefusal(error);
        },
      );
      const rows: Record<string, number> = {};
      let total = 0;
      for (const row of erased) {
        const count = Number(row.erased_rows);
        rows[row.erased_table] = count;
        total += count;
      }
      return { rows, total };
    },
  };
  if (refusal === null) return store;
  const refuse = async () => {
    throw refusal();
  };
  return Object.assign(
    store,
    Object.fromEntries(SLOTLOCK_TENANT_WRITE_METHODS.map((name) => [name, refuse])),
  );
}

/**
 * erase_tenant refuses a tenant whose plan names a live subscription (`billing_active`): it is
 * cancelled first, so it does not renew for an erased account.
 */
function billingActiveRefusal(error: unknown): unknown {
  if (pgCode(error) !== '55006' || (error as { hint?: unknown }).hint !== 'billing_active') return error;
  return Object.assign(
    new Error('Slotlock tenant has a live subscription: cancel it before erasing the tenant', {
      cause: error,
    }),
    { code: 'billing_active' as const },
  );
}

/** The deployment role alone may suspend: others are refused EXECUTE on the functions. */
function suspensionRefusal(error: unknown): unknown {
  if (pgCode(error) !== '42501') return error;
  return Object.assign(
    new Error('Slotlock suspends tenants and lifts suspensions only as the deployment role'),
    { code: 'tenant_suspension_not_permitted' as const, cause: error },
  );
}
