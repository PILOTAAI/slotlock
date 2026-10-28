// DB mechanics for the Slotlock core — explicit `postgres` client in, structured results out.
// Domain policy (who may reserve, pricing, holds) belongs to future callers; this layer owns the
// reliable how: idempotent schema apply, EXCLUDE-arbitrated inserts with a structured conflict.
import { SLOTLOCK_CHANGE_RETENTION_DAYS, type SlotlockEventFeed, slotlockEventFeedMethods } from './event-feed.js';
import {
  type SlotlockBookingRule,
  type SlotlockBookingRules,
  bookingBufferAfterMs,
  bookingRuleBroken,
  bookingSearch,
  parseBookingRules,
} from './booking-rules.js';
import { createHash, randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import type { Sql, TransactionSql } from 'postgres';
import {
  SLOTLOCK_CORE_DDL,
  SLOTLOCK_DEPLOYMENT_CHECKS,
  SLOTLOCK_SCHEMA_CONTROL_REFUSAL,
  SLOTLOCK_SCHEMA_NEWER_REFUSAL,
  SLOTLOCK_SCHEMA_VERSION,
  SLOTLOCK_STRUCTURE_DDL,
  SLOTLOCK_TENANT_CONTEXT_SETTING,
  SLOTLOCK_TENANT_TABLES,
  SLOTLOCK_VALIDATION_DDL,
  createSlotlockApplicationRoleGrantsDdl,
  createSlotlockTenantRlsDdl,
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
  SlotlockReservation,
  SlotlockResource,
  PutCalendarEventCommand,
  PutCalendarEventResult,
  ReleaseHoldResult,
  WeeklyAvailabilityRule,
} from './types.js';
import { parseAvailabilityRules } from './weekly-hours.js';

/** Postgres exclusion_violation — the EXCLUDE constraint fired. */
const EXCLUSION_VIOLATION = '23P01';
/**
 * Concurrent inserts checking the same EXCLUDE range can deadlock inside the constraint check
 * itself (probed at ~30-40% under two-way contention — intrinsic to Postgres EXCLUDE, present
 * for raw inserts too). A 40P01 victim's transaction is fully rolled back, so one retry either
 * wins cleanly or loses with a proper 23P01 — both structured. Never surfaced raw.
 */
const DEADLOCK_DETECTED = '40P01';
const SERIALIZATION_FAILURE = '40001';
/** Holds are negotiation-scoped; a week is already generous. Beyond it is a caller bug. */
const MAX_HOLD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Turnaround cannot occupy a resource indefinitely because of a caller/unit error. */
const MAX_BUFFER_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export { SLOTLOCK_CALENDAR_HORIZON_DAYS };
/**
 * Longest one-off event the store accepts (ten years and some leap days): long enough for any lease
 * or long-term rental, short enough that a unit error cannot occupy a resource for ever. A recurring
 * series is bounded by its 367-day materialization window instead.
 */
export const SLOTLOCK_MAX_EVENT_DURATION_DAYS = 3_660;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CALENDAR_WINDOW_MS = SLOTLOCK_CALENDAR_HORIZON_DAYS * DAY_MS;
/**
 * Longest window a recurring series is stored (materialized) for: the 367-day search window plus
 * two days. The rolling horizon starts a day before the current UTC day and must reach 367 days
 * past its end, so that a search of the full 367 days from any moment of the day is complete.
 */
export const SLOTLOCK_MATERIALIZATION_WINDOW_DAYS = SLOTLOCK_CALENDAR_HORIZON_DAYS + 2;
const MAX_MATERIALIZATION_WINDOW_MS = SLOTLOCK_MATERIALIZATION_WINDOW_DAYS * DAY_MS;
const MAX_EVENT_DURATION_MS = SLOTLOCK_MAX_EVENT_DURATION_DAYS * DAY_MS;
const MAX_RESOURCE_LIST_LIMIT = 1_000;
/** Highest per-tenant resource cap `createResource` accepts. */
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
/** Free-looking resources one entry tries before the next entry: a race can take one first. */
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
 * Stable daily target shared by the event writer, maintenance worker, and readiness proof: from a
 * day before the current UTC day to 367 days past its end (SLOTLOCK_MATERIALIZATION_WINDOW_DAYS).
 */
export function calendarEventRollingHorizon(now = new Date()): Interval {
  if (!Number.isFinite(now.getTime())) throw invalidWindowError();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(midnight - DAY_MS);
  return { start, end: new Date(start.getTime() + MAX_MATERIALIZATION_WINDOW_MS) };
}

/**
 * A stored series expanded from the cursor its last expansion left, or `null` when there is none it
 * can use or the expansion from it is refused: the write's own search from the start was refused.
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

/** A series cursor as the jsonb column takes it. */
function seriesCursorJson(tx: TransactionSql, cursor: CalendarSeriesCursor | null) {
  return cursor === null ? null : tx.json(cursor as unknown as Parameters<TransactionSql['json']>[0]);
}

/**
 * The window a roll to `horizon` gives a series stored for `stored`: from the horizon's start to
 * the later of the two ends, so its end never moves back. `null` keeps the stored window: it covers
 * the horizon already, or it ends so far past it that no window from the horizon's start to its end
 * fits the 367-day cap (it rolls once the horizon is close enough).
 */
function rolledWindow(stored: Interval, horizon: Interval): Interval | null {
  if (stored.start <= horizon.start && stored.end >= horizon.end) return null;
  if (stored.end.getTime() - horizon.start.getTime() > MAX_MATERIALIZATION_WINDOW_MS) return null;
  return { start: horizon.start, end: stored.end > horizon.end ? stored.end : horizon.end };
}

/**
 * How far past a rule's UNTIL, read as UTC, an occurrence can still end, beyond the series' own
 * length. UNTIL bounds an occurrence's start (RFC 5545 §3.3.10), but a floating or date-only UNTIL
 * is a wall time in a zone from UTC-12 to UTC+14, or a whole day; a start in an hour the clocks skip
 * moves forward; and an occurrence's wall-clock end can pass its exact length by a clock change, a
 * whole day where a zone moved across the date line. Three days covers them together.
 */
const SERIES_UNTIL_SLACK_MS = 3 * DAY_MS;
/** Stored-series windows a COUNT rule is followed through, from its start, to find its end. */
const SERIES_COUNT_SEARCH_WINDOWS = 30;

/**
 * A time by which every occurrence of a recurring series ends, moved ones included, or `null` when
 * it may go on: its rule has neither UNTIL nor COUNT as ical.js reads it (as the expansion does),
 * or its COUNT occurrences are not all found within SERIES_COUNT_SEARCH_WINDOWS windows from its
 * start, or that search is over its budget. A COUNT series ends a day after its last occurrence as
 * the expansion reads it today, so a later reading of its end may be longer.
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
 * The latest end among a COUNT series' occurrences, expanded window by window from its start with
 * exceptions left out (so a cancelled or moved one is still found in its own place), or `null` when
 * fewer than `count` turn up. ical.js yields at most COUNT occurrences, so once `count` are found
 * there are no more. An occurrence is counted in the window its start falls in.
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
 * The recurrence_ends_by column for an event, as text: NULL for a one-off, 'infinity' for no known
 * end. Bind it as text (`::text::timestamptz`): postgres.js serializes a timestamptz parameter
 * through Date, which cannot hold 'infinity'.
 */
function recurrenceEndsByColumn(event: CalendarEventContent): string | null {
  if (!event.recurrence) return null;
  return seriesEndsBy(event)?.toISOString() ?? 'infinity';
}

/** The roll's `after`, checked, or `undefined` for a pass's first batch. */
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
 * Run `callback` in a transaction: a new one on a client (READ COMMITTED when asked, else the role's
 * default), or a savepoint inside the caller's, whose isolation cannot change.
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
 * Run deployment SQL resolving names only in pg_catalog, then the session's temporary schema. The
 * deployment role owns every table, so a function or operator it found through a schema another
 * role can create objects in ("$user", public) would run with that ownership. The DDL strings pin
 * themselves as well; this covers the statements the store sends around them. Every name read
 * before the pin is schema-qualified. The caller's search_path is restored afterwards; a failure
 * aborts the transaction, which reverts the pin as well.
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
 * The deployment DDL refuses a `slotlock` schema that another role controls with SQLSTATE 42501 and
 * its findings as a JSON array in DETAIL. Surface that as `unsafe_slotlock_schema` with `reasons`,
 * keeping the database's error (and its HINT) as `cause`. It refuses a schema a newer release
 * migrated with SQLSTATE 55000: surface that as `schema_newer`. Any other failure passes through.
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
   * The longest it waits for any one lock, in milliseconds (1-600,000; default 1,000). While a
   * migration waits for a lock on a table, every query that comes after it on that table waits
   * behind it; past this it gives up, lets them through, and tries again.
   */
  lockTimeoutMs?: number;
  /** The longest any one of its statements runs, in milliseconds (1-86,400,000; default 900,000). */
  statementTimeoutMs?: number;
  /** How many times it tries in all (1-20; default 5) before refusing with `schema_lock_timeout`. */
  attempts?: number;
}

/** PostgreSQL lock_not_available: a lock wait passed lock_timeout. */
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
 * Run one migration step: in a transaction (or a savepoint of the caller's), with names resolved
 * in pg_catalog only, serialized with every other migration of this database, and with the lock and
 * statement timeouts set. A step that waits past its lock timeout is rolled back and tried again
 * after a pause, up to `attempts` times. The caller's own timeouts are put back afterwards.
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
      if (pgCode(error) !== LOCK_NOT_AVAILABLE) throw error;
      if (attempt >= settings.attempts) {
        throw Object.assign(
          new Error(
            `Slotlock migration gave up after ${attempt} attempts to take its locks within ${settings.lockTimeoutMs} ms: a long transaction holds a slotlock table. Run it again once that transaction ends`,
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
 * A digest of what the migration defines in the `slotlock` schema: its tables and columns,
 * constraints (and whether each is validated), indexes, triggers and functions, and whether PUBLIC
 * holds any right on them. Grants to other roles, ownership and row-level security are left out:
 * applyTenantRls and grantApplicationRole change those after applySchema has recorded the digest.
 * Objects of an extension are left out too. Deparsed definitions depend on search_path, so this runs
 * with it pinned, as the migration does.
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
 * Whether the schema is exactly what this release's applySchema last left: the same version, DDL
 * and catalog digest, and no table left without FORCE by an interrupted migration. Reading needs
 * the right to (the deployment role owns the table); without it the full migration runs and refuses
 * what it must.
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
 * Whether every tenant table has forced RLS and only its tenant policy, bound to `setting`, whose
 * live fingerprint (computed as the RLS DDL computes it) matches the contract the DDL recorded.
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
             AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy every
                   WHERE every.polrelid = rel.oid) = 1
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
 * The schema version recorded by the last migration, or `null` when there is none this role can
 * read: no schema, a schema from 0.2 or earlier, or a role not yet granted the function (run
 * `slotlock migrate`, which grants it).
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
 * Refuse to serve a schema another release migrated: `schema_outdated` when it is older than this
 * release (or unversioned), so `slotlock migrate` must run first; `schema_newer` when a newer release
 * migrated it, whose schema this release's code does not know. Both carry `installed` and `expected`.
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

/** A keyset cursor `{ start, id }` from the last row of a previous page, checked. */
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
    /** The event's turnaround, kept after each occurrence. */
    bufferAfterMs?: number;
  },
): Promise<void> {
  await tx`
    DELETE FROM slotlock.reservations
     WHERE id IN (
       SELECT reservation_id FROM slotlock.calendar_event_occurrences
        WHERE event_id = ${params.eventId} AND reservation_id IS NOT NULL
     )`;
  await tx`DELETE FROM slotlock.calendar_event_occurrences WHERE event_id = ${params.eventId}`;

  for (const occurrence of params.occurrences) {
    let reservationId: string | null = null;
    if ((params.event.transparency ?? 'opaque') === 'opaque') {
      const occupied = new Date(occurrence.end.getTime() + (params.bufferAfterMs ?? 0));
      await reapExpiredHolds(tx, params.resourceId, occurrence.start, occupied);
      const derivedExternalRef = `calendar:${params.eventId}:${createHash('sha256')
        .update(occurrence.recurrenceId)
        .digest('hex')}`;
      const reservations = await tx<{ id: string }[]>`
        INSERT INTO slotlock.reservations (
          resource_id, tenant_ref, external_ref, starts_at, ends_at,
          buffer_after_ms, revision, source, calendar_event_id
        ) VALUES (
          ${params.resourceId}, ${params.tenantRef}, ${derivedExternalRef},
          ${occurrence.start}, ${occurrence.end}, ${params.bufferAfterMs ?? 0}, ${params.revision},
          ${`calendar-event:${params.eventId}`}, ${params.eventId}
        )
        RETURNING id`;
      reservationId = reservations[0]?.id ?? null;
      if (!reservationId) {
        throw new Error('slotlock: calendar occurrence reservation insert returned no row');
      }
    }
    await tx`
      INSERT INTO slotlock.calendar_event_occurrences (
        event_id, tenant_ref, recurrence_id, starts_at, ends_at, reservation_id
      ) VALUES (
        ${params.eventId}, ${params.tenantRef}, ${occurrence.recurrenceId},
        ${occurrence.start}, ${occurrence.end}, ${reservationId}
      )`;
  }
}

/** A recurring series' materialization window: finite, forward, and at most 369 days. */
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
 * A one-off event's materialization window must contain the event. It defaults to the event's own
 * interval and may exceed the 367-day recurrence cap only by being exactly that interval, which is
 * what the `slotlock_calendar_events_materialization_window_bounded` CHECK admits.
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
 * What makes a put the same request: its identity and the event it asks for. Not the window its
 * occurrences are stored over, which for a series is the rolling horizon from the current UTC
 * midnight: with it in the hash, a retry after midnight was refused as a different request.
 */
function putCommandHash(params: {
  command: PutCalendarEventCommand;
  ownerRef: string;
  event: CalendarEventContent;
}): string {
  return calendarCommandHash(putCommandValue(params));
}

/**
 * The hash 0.3.0 and earlier stored, with the window in it, so a command stored before the upgrade
 * still replays: always for a one-off event, whose window is its own span, and on the same UTC day
 * for a series. Remove once no stored command can be that old (commands are pruned after 30 days).
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
    // Only when present, so a create without a hold keeps the hash it always had.
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
 * (when there is one) and its occupation, leave the identity's tombstone at `revision`, and record
 * the command in `commandOwnerRef`'s namespace for replay.
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
 * The row an event write lost to. The write was rolled back, so the event's own rows from before
 * it are still there and are left out: they were to be replaced, and never block the event.
 */
async function findCalendarOverlap(
  sql: StoreSql,
  resourceId: string,
  occurrences: Array<{ start: Date; end: Date }>,
  eventId: string | undefined,
): Promise<{ ok: false; code: 'overlap'; conflictingReservationId: string | null }> {
  for (const occurrence of occurrences) {
    const result = await overlapLoss(
      sql,
      resourceId,
      occurrence.start,
      occurrence.end,
      0,
      undefined,
      eventId,
    );
    if (result.conflictingReservationId !== null) return result;
  }
  return { ok: false, code: 'overlap', conflictingReservationId: null };
}

/**
 * What the resource's booking rules say about a booking of `interval` made now (by the database's
 * clock, at this statement): the rule it breaks, if any, and the turnaround it must keep after it.
 * A resource without its own hours is judged against `defaultHours`.
 */
async function bookingRuling(
  tx: TransactionSql,
  resourceId: string,
  interval: Interval,
  defaultHours: readonly WeeklyAvailabilityRule[],
): Promise<{ rule: SlotlockBookingRule | null; turnaroundMs: number }> {
  const judge = await bookingJudge(tx, resourceId, defaultHours);
  return { rule: judge.broken(interval), turnaroundMs: judge.turnaroundMs };
}

/**
 * The resource's booking rules, read once, as a check of any interval booked now (by the database's
 * clock at this statement) and the turnaround a booking keeps.
 */
async function bookingJudge(
  tx: TransactionSql,
  resourceId: string,
  defaultHours: readonly WeeklyAvailabilityRule[],
): Promise<{
  broken: (interval: Interval, checks?: { first: boolean }) => SlotlockBookingRule | null;
  turnaroundMs: number;
}> {
  const [row] = await tx<
    { booking_rules: unknown; availability_rules: unknown; timezone: string; now: Date }[]
  >`
    SELECT booking_rules, availability_rules, timezone, statement_timestamp() AS now
      FROM slotlock.resources WHERE id = ${resourceId}`;
  if (!row || row.booking_rules === null || row.booking_rules === undefined) {
    return { broken: () => null, turnaroundMs: 0 };
  }
  const { bookingRules: rules, availabilityRules } = toResource({
    id: resourceId,
    external_ref: null,
    tenant_ref: null,
    timezone: row.timezone,
    availability_rules: row.availability_rules,
    booking_rules: row.booking_rules,
    pool_ref: null,
    visibility: 'shared',
    archived_at: null,
  });
  const hours = availabilityRules ?? defaultHours;
  // A later occurrence of a series is judged on its step and hours only: notice and advance are
  // about when the booking was made, which its first occurrence answers.
  const later =
    rules === undefined
      ? undefined
      : {
          ...(rules.slotStepMinutes !== undefined ? { slotStepMinutes: rules.slotStepMinutes } : {}),
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
      }),
    turnaroundMs: bookingBufferAfterMs(rules),
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
    // As asked, or raised to the resource's turnaround when it was stored.
    (buffer === params.bufferAfterMs || buffer === Math.max(params.bufferAfterMs, turnaroundMs)) &&
    Number(row.revision) === params.revision &&
    row.source === (params.source ?? null)
  );
}

function occupiedEnd(params: Pick<ExternalReservationCommand, 'end' | 'bufferAfterMs'>): Date {
  return new Date(params.end.getTime() + params.bufferAfterMs);
}

async function lockExternalIdentity(
  tx: TransactionSql,
  tenantRef: string,
  externalRef: string,
): Promise<void> {
  // JSON encoding is unambiguous for this pair and contains no NUL byte (Postgres text rejects
  // U+0000). The database hashes it to one transaction-scoped lock key.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([tenantRef, externalRef])}, 0))`;
}

/**
 * Whether the resource is the tenant's (`missing` when not), and whether it is archived. The row is
 * share-locked to the end of the transaction, so it is neither archived nor deleted meanwhile.
 */
async function tenantResourceState(
  tx: TransactionSql,
  resourceId: string,
  tenantRef: string,
): Promise<'missing' | 'archived' | 'active'> {
  const [row] = await tx<{ archived: boolean }[]>`
    SELECT archived_at IS NOT NULL AS archived FROM slotlock.resources
     WHERE id = ${resourceId} AND tenant_ref = ${tenantRef}
     FOR SHARE`;
  if (!row) return 'missing';
  return row.archived ? 'archived' : 'active';
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
};

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
  if (row.availability_rules !== null && row.availability_rules !== undefined) {
    // Written through setResourceAvailability, which validates; anything else reads as closed.
    try {
      resource.availabilityRules = parseAvailabilityRules(row.availability_rules);
    } catch {
      resource.availabilityRules = [];
    }
  }
  if (row.booking_rules !== null && row.booking_rules !== undefined) {
    // Written through setResourceBookingRules, which validates; anything else reads as refusing
    // every booking, never as no rule.
    try {
      resource.bookingRules = parseBookingRules(row.booking_rules);
    } catch {
      resource.bookingRules = { maxAdvanceDays: 1, minNoticeMinutes: 525_600 };
    }
  }
  return resource;
}

/** Validated rules as a jsonb parameter, or null for "use the default". */
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

async function upsertResource(
  executor: StoreSql,
  params: {
    externalRef?: string;
    tenantRef?: string;
    timezone?: string;
    visibility?: SlotlockResource['visibility'];
  },
): Promise<SlotlockResource> {
  type ResourceIdentityRow = ResourceRow;
  const visibility = params.visibility ?? 'shared';
  const asked = params.visibility ?? null;
  let rows: ResourceIdentityRow[];
  // An existing identity keeps the visibility it has: creating it again with none named returns it
  // as it is, and with another one is refused, so a private one is never made shared that way.
  if (params.tenantRef !== undefined && params.externalRef !== undefined) {
    rows = await executor<ResourceIdentityRow[]>`
      INSERT INTO slotlock.resources (external_ref, tenant_ref, timezone, visibility)
      VALUES (${params.externalRef}, ${params.tenantRef}, ${params.timezone ?? 'UTC'}, ${visibility})
      ON CONFLICT (tenant_ref, external_ref)
        WHERE tenant_ref IS NOT NULL AND external_ref IS NOT NULL
      DO UPDATE SET timezone = EXCLUDED.timezone
      WHERE ${asked}::text IS NULL OR slotlock.resources.visibility = ${asked}::text
      RETURNING id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref, visibility, archived_at`;
  } else if (params.externalRef !== undefined) {
    rows = await executor<ResourceIdentityRow[]>`
      INSERT INTO slotlock.resources (external_ref, tenant_ref, timezone, visibility)
      VALUES (${params.externalRef}, NULL, ${params.timezone ?? 'UTC'}, ${visibility})
      ON CONFLICT (external_ref)
        WHERE tenant_ref IS NULL AND external_ref IS NOT NULL
      DO UPDATE SET external_ref = EXCLUDED.external_ref
      WHERE ${asked}::text IS NULL OR slotlock.resources.visibility = ${asked}::text
      RETURNING id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref, visibility, archived_at`;
  } else {
    rows = await executor<ResourceIdentityRow[]>`
      INSERT INTO slotlock.resources (external_ref, tenant_ref, timezone, visibility)
      VALUES (NULL, NULL, ${params.timezone ?? 'UTC'}, ${visibility})
      RETURNING id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref, visibility, archived_at`;
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
 * Rematerialize one stored recurring master over the window a roll to `horizon` gives it
 * (rolledWindow): from where its last expansion stopped when that can be trusted, else its start.
 * False when there is no such master or nothing to roll. A collision throws the database's 23P01,
 * and a rule over the expansion budget CalendarExpansionLimitError; run it in a savepoint, which
 * either rolls back whole.
 */
async function rollStoredSeries(
  tx: TransactionSql,
  tenantRef: string,
  eventId: string,
  horizon: Interval,
): Promise<boolean> {
  const [row] = await tx<(CalendarEventRow & { ends_by_missing: boolean; buffer_after_ms: number })[]>`
    SELECT id, tenant_ref, owner_ref, external_ref, resource_id, starts_at, ends_at, timezone,
           summary, description, location, status, transparency, organizer, attendees,
           reminders, recurrence_rule, recurrence_exceptions, materialized_starts_at,
           materialized_ends_at, recurrence_cursor, revision, source, created_at,
           updated_at, recurrence_ends_by IS NULL AS ends_by_missing, buffer_after_ms
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
 * Work out and store when a series stored before 0.3 ends (recurrence_ends_by), as its next roll
 * would; its stored occurrences are left as they are.
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

/** Put a master the roll could not extend behind the others for an hour. */
async function deferRoll(executor: StoreSql, tenantRef: string, eventId: string): Promise<void> {
  await executor`
    UPDATE slotlock.calendar_events
       SET roll_retry_at = now() + interval '1 hour'
     WHERE id = ${eventId} AND tenant_ref = ${tenantRef}`;
}

/**
 * Whether every opaque recurring series on the resource (but `exceptEventId`) is stored over the
 * part of [start, end) that a roll can ever reach: from the later of `start` and the rolling
 * horizon's start. A write there must not land where such a series is not stored, or the series'
 * next roll would collide with it and stop. A series known to end before that part
 * (recurrence_ends_by) cannot meet the write and is left out, as is one stored through its end. A
 * series behind is first rolled to the horizon, in a savepoint of the write's transaction, so the
 * write meets its occurrences under the exclusion arbiter; false when one cannot be (it goes on
 * past the horizon and so does the write, it collides, or its rule is over the budget). Series are
 * rolled in id order; an event's update holds its own row while it rolls the others, so it and a
 * write rolling the same series in that order can deadlock, which the database breaks (the writer
 * retries once, then answers an overlap).
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
  // LEAST and GREATEST ignore a NULL argument (PostgreSQL 16, Conditional Expressions): a series
  // with no known end is behind wherever it is stored short of the write's end.
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
    // A series stored before 0.3 has not worked out when it ends; it does so now, and is left out
    // if it ends before the write or is stored through its end.
    if (due.some((row) => row.ends_by_unknown)) {
      for (const { id, ends_by_unknown } of due) {
        if (ends_by_unknown) await learnSeriesEnd(tx, params.tenantRef, id);
      }
      due = await behind();
      if (due.length === 0) return true;
    }
    // No roll stores a series past the horizon: one going on past it stays behind such a write.
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
 * Whether an event already occupies, on the resource, all the time `occurrences` would: such a
 * write (a rename, a new description) takes no time a series could later need, so it is not held
 * to where the series on the resource are stored.
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

/** From the earliest start to the latest end of an event's occurrences, or null for none. */
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
 * After a write lost to the exclusion arbiter: roll, in a transaction of its own, the series on the
 * resource the write's transaction rolled with it (and lost), so they stay extended and the loss
 * can name the occurrence that blocked it. A resource with no tenant has no series. Upkeep only: if
 * it fails, the series are left to maintenance and the write is still answered as a loss.
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
   * Apply the Slotlock DDL (idempotent). Owns the `slotlock` schema on the connected DB. Refuses
   * (`unsafe_slotlock_schema`, with the `reasons` found) a `slotlock` schema that a role other than the
   * connected one (superusers aside) owns or can create objects in, that holds an object such a
   * role owns (an extension included), or whose tables such a role may add triggers to or have a
   * trigger running a function such a role owns. Ownership through a group role counts as another
   * role's: deploy as the owning role itself (`SET ROLE`). Refuses (`schema_newer`) a schema a newer
   * release migrated, changing nothing. Records SLOTLOCK_SCHEMA_VERSION. A schema this release
   * already migrated, unchanged since, is left as it is without a lock on any table. Constraints an
   * upgrade adds NOT VALID are validated in a second transaction, whose locks no serving read or
   * write waits for (one inside a caller's transaction shares its locks until it ends); one that old
   * rows still break stays NOT VALID, and each later migration validates it again. Each lock it
   * waits for is bounded by `lockTimeoutMs`, after which it tries again (`schema_lock_timeout` once
   * out of attempts).
   */
  applySchema(options?: SlotlockMigrationOptions): Promise<void>;
  /**
   * Atomically enable forced tenant RLS using this store's configured context setting. Refuses the
   * same `slotlock` schemas as `applySchema()`. Tables already forced under exactly the policies it
   * installs, bound to this setting, are left as they are without a lock on any table.
   */
  applyTenantRls(options?: { allowRebind?: boolean } & SlotlockMigrationOptions): Promise<void>;
  /**
   * Grant an existing application role exactly what the store needs at runtime: USAGE on the
   * `slotlock` schema and DML on its tables. Run as the deployment role after every `applySchema()`.
   * Refuses (`unsafe_application_role`, with the `reasons` found) a role that has one of the known
   * ways around forced tenant RLS or the exclusion arbiter, itself, through a role it belongs to or
   * through PUBLIC: superuser, BYPASSRLS, REPLICATION or CREATEROLE, a server file or program role,
   * ownership of the database, of anything in it (its temporary objects and its own default
   * privileges aside) or of `btree_gist`, CREATE on the database or on any schema, TRUNCATE,
   * REFERENCES or TRIGGER on a Slotlock table (or by default on new ones), or a right on a server
   * setting. The check runs when the grant is made, so a right added later is not
   * detected until it runs again, and it is not exhaustive (SECURITY.md lists what it does not read).
   */
  grantApplicationRole(role: string, options?: SlotlockMigrationOptions): Promise<void>;
  /**
   * Run store operations with one transaction-local tenant context on the same connection. On a
   * client it opens a READ COMMITTED transaction, whatever the role's default. Inside a caller's
   * transaction of another level its writes are refused (`invalid_transaction_isolation`), since
   * that snapshot can miss a suspension, and its reads go on; with `isolation: 'read committed'`
   * such a transaction is refused outright. The serving role needs EXECUTE on
   * slotlock.tenant_suspended(text): without it this refuses with `application_role_not_granted`
   * (grantApplicationRole grants it), and on a schema without it with `schema_outdated`. With the
   * store's `maxTenantTransactions`, an aborted `signal` takes a call still waiting for its turn out
   * of the line, refused with the signal's reason.
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
    },
  ): Promise<T>;
  /**
   * INVARIANT (erasure completeness): a tenant integration must use a stable, erasable business
   * identifier for externalRef and include this schema in its own data-erasure workflow.
   *
   * With `maxTenantResources` (1-100,000, tenant-owned resources only), or the store's `resources`
   * limit (the lower of the two when both are set), a new resource of a tenant is refused
   * (`resource_limit_reached`, with the `limit`) once the tenant has that many; an existing
   * `externalRef` is still updated. Capped creates for one tenant run one at a time under a database lock, so racing ones
   * on any number of servers stop at the cap. The count needs READ COMMITTED: a capped create opens
   * one itself, and inside a caller's transaction of another level it refuses
   * (`invalid_transaction_isolation`). Uncapped creates do not wait for the lock and are not
   * counted against a cap until they commit.
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
  }): Promise<SlotlockResource>;
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
  }): Promise<SlotlockResource[]>;
  /** The tenant's pools by name, with how many members each has that may be booked (its capacity). */
  listPools(params: { tenantRef: string; visibility?: 'shared' }): Promise<{ pool: string; capacity: number }[]>;
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
  }): Promise<SlotlockResource[]>;
  /**
   * Insert a confirmed reservation with the EXCLUDE constraint as the overlap arbiter. Never
   * throws for the expected outcomes: an invalid window or a lost race come back structured.
   * Expired holds overlapping the window are lazily reaped in the same transaction — an
   * expired-but-unpurged hold can never block (no cron required). On a tenant's resource the
   * booking takes the tenant, and its own id as reference, so cancel and reschedule reach it. With
   * `tenantRef`, only a resource of that tenant (`resource_not_found` otherwise, whatever the
   * connection's row-level security).
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
   * Occupy a window WITHOUT committing: the hold blocks rivals under the same EXCLUDE arbiter
   * until `expiresAt` (DB clock — the statement's time + ttl, never the app clock), then frees via
   * lazy reap.
   * With `tenantRef`, only a resource of that tenant (`resource_not_found` otherwise, whatever the
   * connection's row-level security).
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
     * A retry identity, 1-500 UTF-8 bytes, unique inside `tenantRef` and `principalRef` (both
     * required with it): a request repeated with the same key and body answers the hold the first
     * made (`idempotent: true`), and one with another body is `idempotency_conflict`. The answer is
     * kept until the hold would have expired, released or confirmed; a retry after that makes a new
     * hold.
     */
    idempotencyKey?: string;
    /** Whose keys `idempotencyKey` is among, 1-500 UTF-8 bytes (an API key's subject, say). */
    principalRef?: string;
    /**
     * Who the hold belongs to, 1-500 UTF-8 bytes, inside `tenantRef` (required with it): an agent
     * acting for one person, say. `releaseHold` and `putCalendarEvent`'s `fromHold` with a
     * `holderRef` take only their own, and a holder may have `SLOTLOCK_MAX_HOLDS_PER_HOLDER` live at
     * once. Without it the hold has no holder and no cap: an application holding for its customers.
     */
    holderRef?: string;
    /**
     * Holds taken as alternatives for one booking share a group (a UUID): booking one with
     * `fromHold` releases the rest, and releasing one with a holder releases them all.
     */
    groupId?: string;
  }): Promise<AcquireHoldResult>;
  /** One of the tenant's live holds, or null (none, expired, confirmed, or another tenant's). */
  getHold(params: { tenantRef: string; holdId: string }): Promise<SlotlockHold | null>;
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
   * Flip an unexpired hold to a confirmed booking (expiry cleared). On a tenant's resource the
   * booking takes the tenant, and the hold's id as its reference at revision 1, so cancel and
   * reschedule reach it like any other (`reservation_cancelled` when a cancel of that reference
   * came first). Confirming it again answers the booking as it now is. With `tenantRef`, only a
   * hold on one of that tenant's resources counts: another tenant's is `hold_not_found` whatever
   * the connection's row-level security.
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
   * Atomically rematerialize due recurring masters into one rolling window without changing their
   * semantic revision. A collision rolls back that master and leaves its old coverage untouched.
   * A master is rolled from the window's start through the later of its stored end and the
   * window's, so its end never moves back. One that already covers the window, or whose end lies
   * too far past it for the 367-day cap from the window's start, is not due: it is left as it is
   * and not counted.
   */
  rollCalendarEventHorizon(params: {
    tenantRef: string;
    window: Interval;
    limit?: number;
    /** The previous batch's `next`: examine only the masters after it in this pass. */
    after?: CalendarHorizonRollCursor;
  }): Promise<CalendarHorizonRollResult>;
  /**
   * Delete one bounded batch of expired event bookkeeping for a tenant, which is what returns agent
   * quota: idempotency commands older than the replay window (every owner), then agent-owned
   * cancellation tombstones older than it with no remaining command. Active events and `internal`
   * (provider/sync) tombstones are never deleted. Rows another transaction holds are skipped, not
   * waited on. After the window a retried command is evaluated afresh under its expected revision,
   * and a pruned agent identity can be created again. Call until `hasMore` is false.
   */
  pruneCalendarEventRetention(params: {
    tenantRef: string;
    /** Rows per class per call, 1-1000. Defaults to 100. */
    limit?: number;
    /** Replay window in whole days, 1-3650. Defaults to `SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS`. */
    retentionDays?: number;
  }): Promise<CalendarEventRetentionResult>;
  /**
   * Delete one bounded batch of a tenant's dead booking rows: holds past their expiry and the
   * answers kept for keyed ones (at once), and references retired by a cancel no booking held,
   * older than the retention window. A cancelled booking's tombstone is never deleted here (only by
   * erasing the tenant), so its reference is never booked again. Rows another transaction holds
   * are skipped, not waited on. It also gives a confirmed booking a 0.2 server wrote without its
   * tenant the tenant and its own id as reference, as the migration does. Call until `hasMore` is
   * false.
   */
  /**
   * Time zone rules that changed since an event was booked (a new tzdata): a future one-off event
   * whose wall-clock time in its zone now falls at another instant. Each is reported once on the
   * feed (`event.timezone_shifted`, with the instant it has and the one its wall time now means).
   * With `move`, it is moved there instead (a new revision, `event.updated` naming `slotlock:tzdata`),
   * unless that overlaps another booking: then it stays and `event.timezone_conflict` reports it,
   * for a person or an agent to decide. Up to `limit` (1-1,000, default 100) events a call.
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
  /**
   * Offer freed time to the waitlist, in the order entries joined: each waiting entry whose window
   * is free (on its resource, or on the first free member of its pool) gets a hold for its holder
   * and the feed says so (`waitlist.offered`, with the hold). Entries whose window has started are
   * expired (`waitlist.expired`); finished ones older than the change feed's retention are deleted.
   * One tenant's offers run one at a time. One page of `limit` (1-100, default 50) entries: pass
   * `next` back as `after` for the next, until it is null.
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
     * How long a stray retirement is kept, in whole days, 1-3650. Defaults to
     * `SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS`.
     */
    retentionDays?: number;
  }): Promise<BookingRetentionResult>;
  /**
   * Suspend a tenant: from when this returns, every withTenant transaction for it (as every server
   * runs its requests) may read, and its writes are refused (`tenant_suspended`); one in flight is
   * waited for. Its keys still authenticate, but it gets no new key or secret. Maintenance and
   * erasure go on. True when it was not suspended already. Only the deployment role, which owns the
   * schema, may suspend (`tenant_suspension_not_permitted` for another).
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
   * Erase a tenant: delete every row it owns (resources, holds, bookings, events with their
   * attendees and reminders, cancellations, idempotency records, coverage, API keys, and a personal
   * tenant's dashboard records) in one transaction, waiting for its transactions in flight. API key
   * digests are retired so no erased key works again; a suspension stays. Erasing again deletes
   * nothing.
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
   * The first slot of `durationMs` inside the hours, whose time and turnaround buffer are free:
   * getFreeBusy × expandRules (in the resource's stored timezone) → findNextAvailable. Null when no
   * slot is free, and when one cannot be proven free: the coverage of the window (with the buffer's
   * tail) is not complete, because a recurring series is not stored that far or a required provider
   * calendar is not read that far. Another tenant's resource, an unknown id or one the store never
   * issues is `resource_not_found`. A search window longer than 367 days is `invalid_window`.
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
  | { ok: true; entry: SlotlockWaitlistEntry }
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
        | 'waitlist_limit_reached';
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
   * What one tenant may store, for a database tenants share (none by default). A write that would
   * pass a limit is refused with it (`*_limit_reached`); what the tenant has can still be revised
   * (a move adds no booking or event, so it is not refused), cancelled and released. Counted under
   * a lock per tenant and limit, so racing writers never pass it, in READ COMMITTED transactions
   * only (`invalid_transaction_isolation` otherwise). Bookings and events count while they are still
   * to come, and for 30 days after they were made, whatever time they hold; history older than that
   * does not count, and a count stops reading at the limit.
   */
  tenantLimits?: SlotlockTenantLimits;
  /**
   * How many withTenant transactions of one tenant run at once on this store (1-1,000; no limit by
   * default). The rest wait in this process, in order, so one tenant's transactions waiting on its
   * own locks hold at most this many of a pool's connections. Not counted inside a caller's
   * transaction, which holds its connection already.
   */
  maxTenantTransactions?: number;
  /**
   * The longest a withTenant transaction waits for any one lock, in milliseconds (1-600,000; none by
   * default). Past it the transaction is rolled back and refused with `lock_timeout`, which is safe
   * to retry. Not set inside a caller's transaction.
   */
  tenantLockTimeoutMs?: number;
}

/** Per-tenant row limits, each a whole number from 1 to 10,000,000 (resources: to 100,000). */
export interface SlotlockTenantLimits {
  /** Resources, archived ones included; the lower of this and a call's `maxTenantResources`. */
  resources?: number;
  /**
   * Holds on the tenant's resources, expired ones included until they are deleted. A keyed hold
   * keeps its place until it would have expired, released or confirmed, while its answer is kept
   * for retries. A hold at the limit first deletes the tenant's expired holds and forgets their
   * answers, as maintenance does, so only live holds keep a new one out.
   */
  holds?: number;
  /**
   * Bookings still to come or made in the last 30 days, cancellations made in the last 30 days,
   * and references a cancel retired with no booking until maintenance prunes them.
   */
  reservations?: number;
  /**
   * Calendar events of every owner still to come (a series until it is known to have ended) or made
   * in the last 30 days, cancellations of every owner made in the last 30 days, and agent-owned
   * cancellations until maintenance prunes them. Each event stores at most 2,000 occurrences.
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
 * Serialize one tenant's writes that add rows of one limited kind, so each counts what every
 * earlier one committed. Taken before any row lock, after the write's identity locks.
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
 * Rows a tenant added within this many days count against its limits whatever time they hold, so
 * bookings and events dated in the past, and cancellations, add at most the limit in any such
 * window. Ended history is not pruned: over a longer time it can still grow. The same window
 * maintenance keeps event idempotency records and stray retirements for.
 */
const TENANT_LIMIT_RECENT_DAYS = SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS;

/**
 * The rows a tenant has that its limit of `kind` counts: what is still to come, and what it added
 * in the last TENANT_LIMIT_RECENT_DAYS days; what ended before then is history and does not count.
 * Each part stops at `limit` rows, read through an index, so a count costs no more than the limit
 * however much history the tenant keeps; the total is at least `limit` exactly when the tenant is
 * at it.
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
      // Every held row, expired or not, until it is deleted: an expired hold no rival writes over
      // stays stored until maintenance or a hold at the limit deletes it. And the answer kept for
      // each keyed hold no longer held (released or confirmed, or its expired row deleted) until it
      // is forgotten. An answer whose hold is still a held row is left out: that row counts.
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
      // Bookings still to come; bookings that have ended and cancellations, made recently; and
      // references retired with no booking, until maintenance prunes them. A cancelled booking's
      // tombstone is kept for good, and stops counting once it is no longer recent.
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
      // One-off events still to come and series not known to have ended; events that have ended
      // and cancellations of any owner, made recently; and agent cancellations until maintenance
      // prunes them. The owner identity CHECK makes every owner but 'internal' an 'agent:' one.
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
 * Delete up to `limit` of a tenant's holds that have expired, oldest first; the number deleted. A
 * writer reaping or confirming a hold locks it: such a row is skipped, and the delete repeats the
 * predicate on the row as it now is.
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
 * Delete up to `limit` of a tenant's keyed hold answers whose hold has expired, so a retry with one
 * of their keys makes a new hold; answers another transaction holds are skipped. The number deleted.
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
 * Delete expired held rows whose occupied time (buffer included, as the EXCLUDE constraint reads
 * it) overlaps the requested window, whose `end` is its own occupied end, in deterministic id
 * order under FOR UPDATE — two concurrent reapers lock the same rows in the same order (no
 * deadlock), the loser simply finds them gone. Runs inside the caller's transaction, immediately
 * before its INSERT, so the EXCLUDE arbiter only ever sees LIVE occupation.
 */
async function reapExpiredHolds(
  tx: TransactionSql,
  resourceId: string,
  start: Date,
  end: Date,
): Promise<void> {
  await tx`
    DELETE FROM slotlock.reservations
     WHERE id IN (
       SELECT id FROM slotlock.reservations
        WHERE resource_id = ${resourceId}
          AND status = 'held'
          AND expires_at <= statement_timestamp()
          AND starts_at < ${end}
          AND COALESCE(occupied_ends_at, ends_at) > ${start}
        ORDER BY id
        FOR UPDATE
     )`;
}

/**
 * Structured answer after losing to the EXCLUDE arbiter: name the (live) winner.
 * conflictingReservationId can be null in one narrow race: the blocker expired between the
 * loser's transaction start (constraint saw it) and this lookup (live filter hides it) — an
 * immediate retry reaps it and wins.
 */
async function overlapLoss(
  sql: StoreSql,
  resourceId: string,
  start: Date,
  end: Date,
  bufferAfterMs = 0,
  excludeReservationId?: string,
  excludeCalendarEventId?: string,
): Promise<{ ok: false; code: 'overlap'; conflictingReservationId: string | null }> {
  const winners = await sql<{ id: string }[]>`
    SELECT id FROM slotlock.reservations
     WHERE resource_id = ${resourceId}
       AND (${excludeReservationId ?? null}::uuid IS NULL OR id <> ${excludeReservationId ?? null}::uuid)
       AND (${excludeCalendarEventId ?? null}::uuid IS NULL
            OR calendar_event_id IS DISTINCT FROM ${excludeCalendarEventId ?? null}::uuid)
       AND tstzrange(
             starts_at,
             COALESCE(occupied_ends_at, ends_at),
             '[)'
           ) && tstzrange(
             ${start},
             ${end} + ${bufferAfterMs} * interval '1 millisecond',
             '[)'
           )
       AND (status <> 'held' OR expires_at > statement_timestamp())
     ORDER BY starts_at
     LIMIT 1`;
  return { ok: false, code: 'overlap', conflictingReservationId: winners[0]?.id ?? null };
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
      // Handed straight to the next in line, so the count stays as it is.
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
  'archiveResource',
  'restoreResource',
  'deleteResource',
  'setResourceAvailability',
  'setResourceBookingRules',
  'setResourcePool',
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
  'checkInReservation',
  'joinWaitlist',
  'leaveWaitlist',
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
 * Reading a tenant's suspension needs EXECUTE on slotlock.tenant_suspended(text), which PUBLIC does
 * not hold (SQLSTATE 42501 without it), and a schema this release migrated (42883 before then).
 * Name the remedy for each; any other failure passes through.
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
 * A store on `sql`. With `refusal`, every method in SLOTLOCK_TENANT_WRITE_METHODS throws what it
 * returns before any query (a suspended tenant, or a suspension check that could be stale).
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
  const { maxTenantTransactions, tenantLockTimeoutMs } = options;
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
  createSlotlockTenantRlsDdl(configuredTenantSetting); // Validate once before any scoped query.
  const storeOptions: SlotlockStoreOptions = {
    tenantContextSetting: configuredTenantSetting,
    agentOwnerEventQuota: configuredAgentOwnerEventQuota,
    agentOwnerCommandQuota: configuredAgentOwnerCommandQuota,
    tenantLimits: configuredTenantLimits,
  };

  /**
   * Under the tenant's lock for `kind`: the limit when the tenant is at it, else null. No limit for
   * `kind`, or no tenant, takes no lock. Writes that only lower the count take no lock, so a count
   * read early stays an upper bound for the rest of the transaction.
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
    // A hold, and a keyed hold's answer, keep their place only until the hold expires; at the
    // limit, the expired holds and their answers are deleted, as maintenance would, and the count
    // is read again. Counting expired rows until then keeps what a tenant stores within the limit
    // between maintenance passes, however short its holds.
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
   * resource's (a resource never changes tenant, so it is read before any lock). Null with no limit.
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
    ...slotlockEventFeedMethods(sql),
    async applySchema(migrationOptions) {
      // PostgreSQL's IF NOT EXISTS DDL is idempotent after commit but not race-free: two fresh
      // application instances can still collide on pg_namespace/pg_extension unique indexes.
      // inMigration serializes bootstrap per database and the transaction releases the lock on
      // crashes. A schema this release already left as it is changes nothing and locks no table,
      // unless old rows kept one of its constraints NOT VALID: then only the validation runs again.
      const validate = await inMigration(sql, migrationOptions, async (tx) => {
        await tx.unsafe(SLOTLOCK_DEPLOYMENT_CHECKS).catch((error: unknown) => {
          throw schemaControlRefusal(error);
        });
        if (await slotlockSchemaUpToDate(tx)) return slotlockConstraintUnvalidated(tx);
        await tx.unsafe(SLOTLOCK_STRUCTURE_DDL).catch((error: unknown) => {
          throw schemaControlRefusal(error);
        });
        return true;
      });
      if (!validate) return;
      // Once the DDL has committed, its ACCESS EXCLUSIVE locks are gone: validating holds none that
      // a serving query waits for (ddl.ts, DEPLOYMENT_VALIDATE_CONSTRAINTS). Inside a caller's
      // transaction both steps share it, and its locks, until it ends. The digests go last, so a
      // migration stopped before them runs whole again.
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
      const release = await tenantSlots?.(tenantRef, options?.signal);
      // A lock wait that timed out leaves the transaction unusable, so the reset below fails with
      // another error in its place: noted here as it happens.
      let timedOut = false;
      return inTransaction(
        sql,
        async (tx) => {
          if (lockTimeout !== undefined) {
            await tx`SELECT set_config('lock_timeout', ${lockTimeout}, true)`;
          }
          if (isolation !== undefined) await assertReadCommitted(tx);
          // Held shared until the transaction ends: suspension and erasure, which take it
          // exclusively, wait for this transaction, and one that starts after them reads them below
          // (READ COMMITTED: a statement after the lock sees what committed before it was granted).
          const previous = await tx<{ value: string | null; isolation: string; actor: string | null }[]>`
            SELECT current_setting(${configuredTenantSetting}, true) AS value,
                   current_setting('slotlock.actor', true) AS actor,
                   current_setting('transaction_isolation') AS isolation,
                   pg_advisory_xact_lock_shared(
                     hashtextextended(${slotlockTenantLockKey(tenantRef)}, 0)
                   ) AS locked`;
          const [context] = await tx<{ suspended: boolean }[]>`
            SELECT set_config(${configuredTenantSetting}, ${tenantRef}, true) AS tenant,
                   set_config('slotlock.actor', ${actor ?? ''}, true) AS actor,
                   slotlock.tenant_suspended(${tenantRef}) AS suspended`.catch((error: unknown) => {
            throw suspensionCheckRefusal(error);
          });
          // A caller's REPEATABLE READ or SERIALIZABLE snapshot was taken before the lock was
          // granted, so it may not show a suspension that committed while this transaction waited:
          // its writes are refused, and it may read.
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
                            set_config('slotlock.actor', ${previous[0]?.actor ?? ''}, true)`;
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
      const requested = params.maxTenantResources;
      const configured = params.tenantRef === undefined ? undefined : configuredTenantLimits.resources;
      if (requested === undefined && configured === undefined) return upsertResource(sql, params);
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
          // Re-creating a resource the tenant has (by its reference) adds none.
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
          return upsertResource(tx, params);
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
        SELECT id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref, visibility, archived_at
          FROM slotlock.resources
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
           AND (${params.visibility ?? null}::text IS NULL OR visibility = ${params.visibility ?? null})`;
      const row = rows[0];
      return row ? toResource(row) : null;
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
        RETURNING id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref, visibility, archived_at`;
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
        RETURNING id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref,
                  visibility, archived_at`;
      const row = rows[0];
      return row ? toResource(row) : null;
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
        RETURNING id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref,
                  visibility, archived_at`;
      const row = rows[0];
      return row ? toResource(row) : null;
    },

    async listPoolMembers(params) {
      if (!isValidIdentity(params.tenantRef)) throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      if (!isPoolName(params.pool)) throw invalidPoolError();
      const rows = await sql<ResourceRow[]>`
        SELECT id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref,
               visibility, archived_at
          FROM slotlock.resources
         WHERE tenant_ref = ${params.tenantRef} AND pool_ref = ${params.pool}
           AND archived_at IS NULL
           AND (${params.visibility ?? null}::text IS NULL OR visibility = ${params.visibility ?? null})
         ORDER BY id
         LIMIT ${SLOTLOCK_MAX_POOL_MEMBERS}`;
      return rows.map(toResource);
    },

    async listPools(params) {
      if (!isValidIdentity(params.tenantRef)) throw invalidIdentityError('Slotlock tenant reference must be 1-500 UTF-8 bytes');
      const rows = await sql<{ pool: string; capacity: number }[]>`
        SELECT pool_ref AS pool, count(*)::int AS capacity
          FROM slotlock.resources
         WHERE tenant_ref = ${params.tenantRef} AND pool_ref IS NOT NULL AND archived_at IS NULL
           AND (${params.visibility ?? null}::text IS NULL OR visibility = ${params.visibility ?? null})
         GROUP BY pool_ref
         ORDER BY pool_ref
         LIMIT 1000`;
      return rows;
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
      const rows = await sql<ResourceRow[]>`
        SELECT id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref, visibility, archived_at
          FROM slotlock.resources
         WHERE tenant_ref = ${params.tenantRef}
           AND (${params.visibility ?? null}::text IS NULL OR visibility = ${params.visibility ?? null})
           AND (${params.includeArchived === true} OR archived_at IS NULL)
           AND (${params.after ?? null}::uuid IS NULL OR id > ${params.after ?? null}::uuid)
         ORDER BY id
         LIMIT ${limit}`;
      return rows.map(toResource);
    },

    async archiveResource(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.id)) {
        throw invalidIdentityError('Slotlock resource identity is invalid');
      }
      // Its clock time, not the transaction's start: a booking that committed holding the row's
      // share lock went in before this.
      const [row] = await sql<ResourceRow[]>`
        UPDATE slotlock.resources
           SET archived_at = COALESCE(archived_at, clock_timestamp())
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
        RETURNING id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref, visibility, archived_at`;
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
        RETURNING id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref, visibility, archived_at`;
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
        // Its rows go with it: reservations, events and their children, coverage and hold answers
        // all cascade from the resource.
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
      // A booking on a tenant's resource takes the tenant and its own id as reference, so it can be
      // cancelled and moved like any other; one on a resource with no tenant stays tenantless.
      const id = randomUUID();
      for (let attempt = 1; ; attempt++) {
        try {
          return await inTransaction(sql, async (tx): Promise<CreateReservationResult> => {
            const bookingLimit = await tenantLimitReached(
              tx,
              await limitTenant(tx, 'reservations', params.resourceId, params.tenantRef),
              'reservations',
            );
            const [resource] = await tx<{ tenant_ref: string | null; archived: boolean }[]>`
              SELECT tenant_ref, archived_at IS NOT NULL AS archived FROM slotlock.resources
               WHERE id = ${params.resourceId}
                 AND (${params.tenantRef ?? null}::text IS NULL
                      OR tenant_ref = ${params.tenantRef ?? null})
               FOR SHARE`;
            if (!resource) return { ok: false, code: 'resource_not_found' };
            if (resource.archived) return { ok: false, code: 'resource_archived' };
            if (bookingLimit !== null && resource.tenant_ref !== null) {
              return { ok: false, code: 'reservation_limit_reached', limit: bookingLimit };
            }
            const ruling = await bookingRuling(tx, params.resourceId, params, defaultHours);
            if (ruling.rule) return { ok: false, code: 'booking_rule_violated', rule: ruling.rule };
            const occupied = new Date(params.end.getTime() + ruling.turnaroundMs);
            if (
              resource.tenant_ref !== null &&
              !(await recurrenceCoversWrite(tx, {
                tenantRef: resource.tenant_ref,
                resourceId: params.resourceId,
                start: params.start,
                end: occupied,
              }))
            ) {
              return { ok: false, code: 'recurrence_not_materialized' };
            }
            await reapExpiredHolds(tx, params.resourceId, params.start, occupied);
            const [row] = await tx<ReservationRow[]>`
              INSERT INTO slotlock.reservations (
                id, resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms, source
              ) VALUES (
                ${id}, ${params.resourceId}, ${resource.tenant_ref},
                ${resource.tenant_ref === null ? null : id},
                ${params.start}, ${params.end}, ${ruling.turnaroundMs}, ${params.source ?? null}
              )
              RETURNING id, resource_id, tenant_ref, external_ref, starts_at, ends_at,
                        buffer_after_ms, revision, source`;
            if (!row) throw new Error('slotlock: reservation insert returned no row');
            return { ok: true, reservation: toReservation(row) };
          });
        } catch (err) {
          const code = pgCode(err);
          if ((code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE) && attempt === 1) {
            continue; // fully rolled back — one retry wins cleanly or loses with a clean 23P01
          }
          if (
            code !== EXCLUSION_VIOLATION &&
            code !== DEADLOCK_DETECTED &&
            code !== SERIALIZATION_FAILURE
          ) {
            throw err;
          }
          // A SECOND contention abort is treated as a loss too (structured, possibly with a null
          // winner if both rivals rolled back) — symmetric with 40P01, never a raw throw.
          await rollSeriesBehind(sql, params.resourceId, params.start, params.end);
          return overlapLoss(sql, params.resourceId, params.start, params.end);
        }
      }
    },

    async createExternalReservation(params) {
      const invalid = validateExternalCommand(params);
      if (invalid) return invalid;
      if (params.revision !== 1) return { ok: false, code: 'invalid_revision' };
      let written = params.bufferAfterMs;
      for (let attempt = 1; ; attempt++) {
        try {
          return await inTransaction(sql, async (tx): Promise<ExternalReservationResult> => {
            await lockExternalIdentity(tx, params.tenantRef, params.externalRef);
            const cancelled = await tx<{ revision: string | number }[]>`
              SELECT revision FROM slotlock.reservation_tombstones
               WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}`;
            if (cancelled[0]) return { ok: false, code: 'reservation_cancelled' };
            // A calendar event's occupation carries a reference in this namespace too, but it is
            // not a booking: create, reschedule and cancel never read, replay, move or free it,
            // and answer as for a reference no booking holds. Bookings have their own unique index.
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
              // The booking has moved on since: a delayed create is stale, as a delayed move is.
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
            const occupied = occupiedEnd({ end: params.end, bufferAfterMs });
            if (
              !(await recurrenceCoversWrite(tx, {
                tenantRef: params.tenantRef,
                resourceId: params.resourceId,
                start: params.start,
                end: occupied,
              }))
            ) {
              return { ok: false, code: 'recurrence_not_materialized' };
            }
            await reapExpiredHolds(tx, params.resourceId, params.start, occupied);
            const rows = await tx<ReservationRow[]>`
              INSERT INTO slotlock.reservations (
                resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms,
                revision, source
              ) VALUES (
                ${params.resourceId}, ${params.tenantRef}, ${params.externalRef}, ${params.start},
                ${params.end}, ${bufferAfterMs}, ${params.revision}, ${params.source ?? null}
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
          await rollSeriesBehind(
            sql,
            params.resourceId,
            params.start,
            occupiedEnd({ end: params.end, bufferAfterMs: written }),
          );
          return overlapLoss(sql, params.resourceId, params.start, params.end, written);
        }
      }
    },

    async rescheduleExternalReservation(params) {
      const invalid = validateExternalCommand(params);
      if (invalid) return invalid;
      let currentReservationId: string | undefined;
      let bufferAfterMs = params.bufferAfterMs;
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
            if (
              !(await recurrenceCoversWrite(tx, {
                tenantRef: params.tenantRef,
                resourceId: params.resourceId,
                start: params.start,
                end: occupiedEnd({ end: params.end, bufferAfterMs }),
              }))
            ) {
              return { ok: false, code: 'recurrence_not_materialized' };
            }
            await reapExpiredHolds(
              tx,
              params.resourceId,
              params.start,
              occupiedEnd({ end: params.end, bufferAfterMs }),
            );
            const rows = await tx<ReservationRow[]>`
              UPDATE slotlock.reservations
                 SET resource_id = ${params.resourceId},
                     starts_at = ${params.start},
                     ends_at = ${params.end},
                     buffer_after_ms = ${bufferAfterMs},
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
          const occupied = occupiedEnd({ end: params.end, bufferAfterMs });
          await rollSeriesBehind(sql, params.resourceId, params.start, occupied);
          return overlapLoss(
            sql,
            params.resourceId,
            params.start,
            params.end,
            bufferAfterMs,
            currentReservationId,
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
          // A calendar event's occupation row carries this reference: it is the event's, not a
          // booking's. Nothing is cancelled, and nothing retired: a tombstone would only grow.
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
        // cannot bring the booking back. Only such a stray retirement is pruned past retention.
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
      // Finiteness + cap: NaN/Infinity would raise raw 22008 in make_interval, and an absurd
      // ttl mints an effectively-eternal hold whose expiry can even exceed the JS Date range
      // (Invalid Date back to the caller). All refused pre-table.
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
      // The buffer written: the one asked for, raised to the resource's turnaround.
      let written = bufferAfterMs;
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
            const [resource] = await tx<{ tenant_ref: string | null; archived: boolean }[]>`
              SELECT tenant_ref, archived_at IS NOT NULL AS archived FROM slotlock.resources
               WHERE id = ${params.resourceId}
                 AND (${tenantRef ?? null}::text IS NULL OR tenant_ref = ${tenantRef ?? null})
               FOR SHARE`;
            if (!resource) return { ok: false, code: 'resource_not_found' };
            if (resource.archived) return { ok: false, code: 'resource_archived' };
            if (holdLimit !== null) return { ok: false, code: 'hold_limit_reached', limit: holdLimit };
            if (holderRef !== undefined) {
              // One holder's live holds, counted under a lock on the holder so racing holds stop
              // at the cap: an agent cannot hold a resource's whole week.
              await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
                'slotlock-holder',
                tenantRef,
                holderRef,
              ])}, 0))`;
              const [held] = await tx<{ count: number }[]>`
                SELECT count(*)::int AS count FROM slotlock.reservations
                 WHERE holder_ref = ${holderRef} AND tenant_ref IS NULL AND status = 'held'
                   AND expires_at > statement_timestamp()
                   AND resource_id IN (SELECT id FROM slotlock.resources WHERE tenant_ref = ${tenantRef ?? null})`;
              if ((held?.count ?? 0) >= SLOTLOCK_MAX_HOLDS_PER_HOLDER) {
                return { ok: false, code: 'hold_limit_reached', limit: SLOTLOCK_MAX_HOLDS_PER_HOLDER };
              }
            }
            const ruling = await bookingRuling(tx, params.resourceId, params, defaultHours);
            if (ruling.rule) return { ok: false, code: 'booking_rule_violated', rule: ruling.rule };
            written = Math.max(bufferAfterMs, ruling.turnaroundMs);
            const reach = occupiedEnd({ end: params.end, bufferAfterMs: written });
            if (
              resource.tenant_ref !== null &&
              !(await recurrenceCoversWrite(tx, {
                tenantRef: resource.tenant_ref,
                resourceId: params.resourceId,
                start: params.start,
                end: reach,
              }))
            ) {
              return { ok: false, code: 'recurrence_not_materialized' };
            }
            await reapExpiredHolds(tx, params.resourceId, params.start, reach);
            const [row] = await tx<HoldRow[]>`
              INSERT INTO slotlock.reservations (
                resource_id, starts_at, ends_at, buffer_after_ms, status, expires_at, source,
                holder_ref, hold_group_id
              ) VALUES (
                ${params.resourceId}, ${params.start}, ${params.end}, ${written}, 'held',
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
          // A SECOND contention abort is treated as a loss too (structured, possibly with a null
          // winner if both rivals rolled back) — symmetric with 40P01, never a raw throw.
          await rollSeriesBehind(
            sql,
            params.resourceId,
            params.start,
            occupiedEnd({ end: params.end, bufferAfterMs: written }),
          );
          return overlapLoss(sql, params.resourceId, params.start, params.end, written);
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
      // Not an id the store issues: it names no hold (and would be a raw 22P02 in the query).
      if (!isValidResourceId(holdId)) return { ok: false, code: 'hold_not_found' };
      return inTransaction(sql, async (tx): Promise<ConfirmHoldResult> => {
        // The tenant whose booking the hold becomes is its resource's; a hold never changes
        // resource, so it is read before the identity lock, which is taken before the row lock as
        // every booking write takes them.
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
        // The resource's share lock, as every booking write takes it: an archive waits for this
        // confirmation, and one that committed first is read here.
        const [resource] = await tx<{ archived: boolean }[]>`
          SELECT archived_at IS NOT NULL AS archived FROM slotlock.resources
           WHERE id = ${owner.resource_id}
           FOR SHARE`;
        const [row] = await tx<(ReservationRow & { status: string; live: boolean })[]>`
          SELECT id, resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms,
                 revision, source, status, (status = 'held' AND expires_at > statement_timestamp()) AS live
            FROM slotlock.reservations
           WHERE id = ${holdId}
           FOR UPDATE`;
        if (!row) {
          // NOTE: a hold reaped mid-flight by a rival (expired while this confirm waited on the
          // reaper's lock) reads as hold_not_found: the row is gone and the space was legitimately
          // taken; both refusal codes are terminal for the caller.
          return { ok: false, code: 'hold_not_found' };
        }
        if (row.status === 'confirmed') {
          // Idempotent confirm: a retried confirm (network replay) of an already-confirmed hold is
          // SUCCESS, the booking as it now is; reporting failure would make callers double-book
          // elsewhere. A confirmed hold's reference is its own id (none without a tenant); a
          // booking with another reference was never this hold.
          if (row.external_ref !== null && row.external_ref !== row.id) {
            return { ok: false, code: 'hold_not_found' };
          }
          return { ok: true, reservation: toReservation(row) };
        }
        if (!row.live) return { ok: false, code: 'hold_expired' };
        // Archived since the hold was taken: a confirmation would be a new booking on it.
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
        // The occupied end is already the end plus the hold's buffer (the trigger set it); the
        // tenant and reference make the hold a booking that cancel and reschedule reach.
        const [confirmed] = await tx<ReservationRow[]>`
          UPDATE slotlock.reservations
             SET status = 'confirmed', expires_at = NULL,
                 tenant_ref = ${bookingTenant}, external_ref = ${bookingTenant === null ? null : holdId}
           WHERE id = ${holdId}
          RETURNING id, resource_id, tenant_ref, external_ref, starts_at, ends_at,
                    buffer_after_ms, revision, source`;
        if (!confirmed) throw new Error('slotlock: hold confirmation returned no row');
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
      // Expired holds are dead occupation: excluded here so findNextAvailable can offer their
      // space (the acquiring transaction reaps the row itself when it takes the window).
      const rows = await sql<{ starts_at: Date; occupied_ends_at: Date }[]>`
        SELECT starts_at, COALESCE(occupied_ends_at, ends_at) AS occupied_ends_at
          FROM slotlock.reservations
         WHERE resource_id = ${resourceId}
           AND starts_at < ${window.end}
           AND COALESCE(occupied_ends_at, ends_at) > ${window.start}
           AND (status <> 'held' OR expires_at > statement_timestamp())
         ORDER BY starts_at
         LIMIT ${options.limit ?? null}`;
      return rows.map((r) => ({ start: r.starts_at, end: r.occupied_ends_at }));
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
          // A long-running series can take more than a write searches from its start. If it is
          // stored, it is expanded again below from where its last expansion stopped.
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
              // Preserve one guaranteed cancellation slot for every possible live identity. This
              // prevents update churn from making a principal unable to release calendar space.
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
                { resource_id: string; starts_at: Date; ends_at: Date; hold_group_id: string | null }[]
              >`
                SELECT resource_id, starts_at, ends_at, hold_group_id FROM slotlock.reservations
                 WHERE id = ${holdId} AND status = 'held' AND holder_ref = ${holderRef}
                   AND expires_at > statement_timestamp()
                 FOR UPDATE`;
              if (!hold) return { ok: false, code: 'hold_not_found' };
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
              // The hold and its alternatives give way to the event in this transaction.
              await tx`
                DELETE FROM slotlock.reservations
                 WHERE status = 'held' AND holder_ref = ${holderRef}
                   AND (id = ${holdId}
                        OR (${hold.hold_group_id}::uuid IS NOT NULL
                            AND hold_group_id = ${hold.hold_group_id}::uuid))`;
            }
            let turnaroundMs = 0;
            if (params.enforceBookingRules === true && (event.transparency ?? 'opaque') === 'opaque') {
              const judge = await bookingJudge(tx, params.resourceId, defaultHours);
              for (const [index, occurrence] of occurrences.entries()) {
                // A held time's notice and advance were judged when it was held.
                const rule = judge.broken(occurrence, { first: index === 0 && !params.fromHold });
                if (rule) return { ok: false, code: 'booking_rule_violated', rule };
              }
              turnaroundMs = judge.turnaroundMs;
            }
            const span = occurrenceSpan(occurrences);
            const reach = span && { start: span.start, end: new Date(span.end.getTime() + turnaroundMs) };
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
                  buffer_after_ms
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
                  ${revision}, ${params.source ?? null}, ${turnaroundMs}
                )`;
            }

            // The normalized children are the queryable/canonical representation. The JSON
            // columns above remain a migration-compatibility mirror until older readers retire.
            await replaceCalendarEventChildren(tx, params.tenantRef, eventId, event);
            await replaceCalendarEventOccurrences(tx, {
              tenantRef: params.tenantRef,
              eventId,
              resourceId: params.resourceId,
              event,
              occurrences,
              revision,
              bufferAfterMs: turnaroundMs,
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
          const reach = occurrenceSpan(attempted);
          if (reach) {
            await rollSeriesBehind(sql, params.resourceId, reach.start, reach.end, storedEventId);
          }
          return findCalendarOverlap(sql, params.resourceId, attempted, storedEventId);
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
      // Due: the masters rolledWindow rolls, which do not cover the window and end within the cap
      // of its start. Those it has never put back come first, then those it has, longest waiting
      // first: however many it cannot extend, they never stand in front of one it has not tried,
      // so every pass that is not capped by such new ones reaches the healthy series, and the ones
      // put back take turns.
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
              // It takes more than Slotlock expands: a rule that never occurs again, one with no
              // cursor to resume from whose search from its start has outgrown the budget, or one an
              // earlier Slotlock stored that this one refuses. Nothing was written; its old coverage
              // stays, and the masters after it still roll.
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
              // The savepoint rolled every delete/insert back, so the previous materialized
              // coverage remains truthful and callers will fail closed beyond it.
              conflicts += 1;
              conflictEventIds.push(candidate.id);
              await deferRoll(sql, params.tenantRef, candidate.id);
              break;
            }
            // Anything else this one series meets (a row no Slotlock would write, a constraint it
            // trips) was rolled back with its savepoint too: it is put back like one over the
            // budget, so no single row stops the tenant's roll.
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
        // An event's owner and reference never change, so they are read before its identity lock,
        // which is taken before its row lock as every event write takes them.
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
        // Cancelled while this waited on its lock.
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
        starts_at: Date;
        ends_at: Date;
        moved_start: Date;
        moved_end: Date;
      }[]>`
        SELECT event.id, event.resource_id, event.transparency, event.revision, event.starts_at, event.ends_at,
               slotlock.zoned_instant(event.wall_starts_at, event.timezone) AS moved_start,
               slotlock.zoned_instant(event.wall_ends_at, event.timezone) AS moved_end,
               COALESCE((SELECT max(booking.buffer_after_ms) FROM slotlock.reservations booking
                          WHERE booking.calendar_event_id = event.id), 0) AS buffer
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
            });
          });
          moved++;
        } catch (error) {
          if (pgCode(error) !== EXCLUSION_VIOLATION) throw error;
          // It stays where it was; whoever owns it decides.
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
      const retentionDays = params.retentionDays ?? SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS;
      if (
        !Number.isSafeInteger(retentionDays) ||
        retentionDays < 1 ||
        retentionDays > MAX_EVENT_COMMAND_RETENTION_DAYS
      ) {
        throw Object.assign(new Error('Slotlock retention window must be 1-3650 days'), {
          code: 'invalid_retention_window' as const,
        });
      }
      return inTransaction(sql, async (tx): Promise<BookingRetentionResult> => {
        // A 0.2 server still serving after the migration wrote its confirmed holds (and
        // createReservation bookings) on the tenant's resources without the tenant or a reference,
        // so no cancel or move reaches them; the migration gives those it finds the tenant and
        // their own id, and this gives later ones the same. Each takes its reference's identity lock
        // first, as every booking write does; a tombstone of its id retired nothing and goes.
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
                   clock_timestamp() - (${retentionDays}::int * interval '1 day')
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
      const retentionDays = params.retentionDays ?? SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS;
      if (
        !Number.isSafeInteger(retentionDays) ||
        retentionDays < 1 ||
        retentionDays > MAX_EVENT_COMMAND_RETENTION_DAYS
      ) {
        throw Object.assign(new Error('Slotlock retention window must be 1-3650 days'), {
          code: 'invalid_retention_window' as const,
        });
      }
      return inTransaction(sql, async (tx): Promise<CalendarEventRetentionResult> => {
        // Commands are exact-replay evidence, never resurrection authority: after the window every
        // owner's are eligible, and the active event or tombstone stays canonical where present.
        const commands = await tx<{ deleted: number }[]>`
          WITH candidates AS MATERIALIZED (
            SELECT command.owner_ref, command.idempotency_key
              FROM slotlock.calendar_event_commands command
             WHERE command.tenant_ref = ${params.tenantRef}
               AND command.created_at <
                   clock_timestamp() - (${retentionDays}::int * interval '1 day')
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
        // Once every command of an agent-owned cancelled identity is gone its tombstone may follow;
        // internal tombstones are provider/sync authority and stay. Event writers lock the tombstone
        // row, so a row they hold is skipped and the delete repeats the selection predicate.
        const tombstones = await tx<{ deleted: number }[]>`
          WITH candidates AS MATERIALIZED (
            SELECT tombstone.owner_ref, tombstone.external_ref
              FROM slotlock.calendar_event_tombstones tombstone
             WHERE tombstone.tenant_ref = ${params.tenantRef}
               AND tombstone.owner_ref LIKE 'agent:%'
               AND tombstone.cancelled_at <
                   clock_timestamp() - (${retentionDays}::int * interval '1 day')
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
                   clock_timestamp() - (${retentionDays}::int * interval '1 day')
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
          // A fresh read ends a staleness: the next one is reported again.
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

    async listCoverage(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.resourceId)) {
        throw invalidIdentityError('Slotlock coverage identity is invalid');
      }
      const maxAgeMs = params.maxAgeMs ?? 24 * 60 * 60 * 1000;
      const rows = await sql<{
        source: string;
        starts_at: Date;
        ends_at: Date;
        revision: string | number;
        observed_at: Date;
        last_error: string | null;
        last_error_at: Date | null;
        stale: boolean;
      }[]>`
        SELECT source, starts_at, ends_at, revision, observed_at, last_error, last_error_at,
               observed_at < now() - make_interval(secs => ${maxAgeMs / 1_000}) AS stale
          FROM slotlock.calendar_coverage
         WHERE tenant_ref = ${params.tenantRef} AND resource_id = ${params.resourceId}
         ORDER BY source`;
      return rows.map((row) => ({
        source: row.source,
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
          RETURNING coverage.resource_id, coverage.source, coverage.observed_at, coverage.last_error
        ), reported AS (
          INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
          SELECT ${params.tenantRef}, stale.resource_id, 'coverage.stale', stale.source,
                 jsonb_strip_nulls(jsonb_build_object(
                   'resource_id', stale.resource_id, 'source', stale.source,
                   'observed_at', stale.observed_at, 'last_error', stale.last_error)),
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
      // The same test twice: to find them, then under each reference's lock, as a cancel takes it.
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
          await tx`DELETE FROM slotlock.reservations WHERE id = ${row.id}`;
          await tx`
            INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
            VALUES (${tenantRef}, ${row.resource_id}, 'reservation.no_show', ${row.external_ref},
                    jsonb_build_object('id', ${row.id}::uuid, 'reference', ${row.external_ref}::text,
                                       'resource_id', ${row.resource_id}::uuid, 'revision', ${revision}::bigint,
                                       'check_in_minutes', ${row.minutes}::int),
                    'slotlock:maintenance')`;
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
      return inTransaction(sql, async (tx): Promise<JoinWaitlistResult> => {
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
        // Counted under the tenant's waitlist lock, which offers take too, so racing joins stop at the cap.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['slotlock-waitlist', tenantRef])}, 0))`;
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
            (tenant_ref, resource_id, pool_ref, starts_at, ends_at, holder_ref, offer_ttl_ms)
          VALUES (${tenantRef}, ${params.resourceId ?? null}, ${params.pool ?? null}, ${window.start},
                  ${window.end}, ${holderRef}, ${offerTtlMs})
          RETURNING ${tx.unsafe(WAITLIST_COLUMNS)}`;
        return { ok: true, entry: toWaitlistEntry(row as WaitlistRow) };
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
        // Waits for an offer pass that has this entry locked, so it leaves what that pass decided.
        const [left] = await tx<{ hold_id: string | null }[]>`
          DELETE FROM slotlock.waitlist_entries
           WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}
             AND (${params.holderRef ?? null}::text IS NULL OR holder_ref = ${params.holderRef ?? null})
          RETURNING hold_id`;
        if (!left) return false;
        // An offer not yet taken goes too, freeing the time for the next who waits; a confirmed
        // one is a booking now and stays.
        if (left.hold_id) {
          await buildSlotlockStore(tx, options, null).releaseHold(left.hold_id, { tenantRef: params.tenantRef });
        }
        return true;
      });
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
               AND ends_at < statement_timestamp() - make_interval(days => ${SLOTLOCK_CHANGE_RETENTION_DAYS})`;
        }
        // One page in join order; the caller passes `next` back for the rest.
        const waiting = await tx<WaitlistRow[]>`
          SELECT ${tx.unsafe(WAITLIST_COLUMNS)} FROM slotlock.waitlist_entries
           WHERE tenant_ref = ${tenantRef} AND status = 'waiting'
             AND (${after?.createdAt ?? null}::timestamptz IS NULL
                  OR (created_at, id) > (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
           ORDER BY created_at, id
           LIMIT ${limit}`;
        // Holds made through a store on this transaction, each in a savepoint of its own.
        const inner = buildSlotlockStore(tx, options, null);
        let offered = 0;
        for (const entry of waiting) {
          // Locked so a leave waits for this offer, and skipped if it left first.
          const [still] = await tx`
            SELECT 1 FROM slotlock.waitlist_entries
             WHERE id = ${entry.id} AND status = 'waiting' FOR UPDATE`;
          if (!still) continue;
          // Only resources whose window looks free are tried: a hold refused keeps its locks
          // until the transaction ends, so trying every member of a full pool would pile them up.
          const candidates = await tx<{ id: string }[]>`
            SELECT resource.id FROM slotlock.resources resource
             WHERE resource.tenant_ref = ${tenantRef} AND resource.archived_at IS NULL
               AND (resource.id = ${entry.resource_id}::uuid
                    OR (${entry.resource_id}::uuid IS NULL AND resource.pool_ref = ${entry.pool_ref}))
               AND NOT EXISTS (
                 SELECT 1 FROM slotlock.reservations taken
                  WHERE taken.resource_id = resource.id
                    AND tstzrange(taken.starts_at, COALESCE(taken.occupied_ends_at, taken.ends_at), '[)')
                        && tstzrange(${entry.starts_at}::timestamptz, ${entry.ends_at}::timestamptz, '[)')
                    AND (taken.status <> 'held' OR taken.expires_at > statement_timestamp()))
             ORDER BY resource.id
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
      const owner = await sql<{ id: string }[]>`
        SELECT id FROM slotlock.resources
         WHERE id = ${params.resourceId} AND tenant_ref = ${params.tenantRef}`;
      if (!owner[0]) {
        throw Object.assign(new Error('Slotlock resource belongs to another tenant'), {
          code: 'resource_tenant_mismatch' as const,
        });
      }
      const busyRows = await sql<{ starts_at: Date; occupied_ends_at: Date }[]>`
        SELECT reservation.starts_at,
               COALESCE(reservation.occupied_ends_at, reservation.ends_at) AS occupied_ends_at
          FROM slotlock.reservations reservation
         WHERE reservation.resource_id = ${params.resourceId}
           AND reservation.starts_at < ${window.end}
           AND COALESCE(reservation.occupied_ends_at, reservation.ends_at) > ${window.start}
           AND (reservation.status <> 'held' OR reservation.expires_at > statement_timestamp())
         ORDER BY reservation.starts_at
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
      const providerRequiredSources = callerRequiredSources.filter(
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
      const ageSeconds = coverageMaxAgeMs / 1000;
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
          // Put the intrinsic source first: it is the boundary the caller can repair by rolling
          // the event horizon, independently of any provider snapshot repair.
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
        SELECT id, external_ref, tenant_ref, timezone, availability_rules, booking_rules, pool_ref, visibility,
               archived_at, statement_timestamp() AS now
          FROM slotlock.resources
         WHERE id = ${params.resourceId} AND tenant_ref IS NOT DISTINCT FROM ${tenantRef}`;
      if (!row) throw notFound();
      if (!Number.isFinite(params.durationMs) || params.durationMs <= 0) return null;
      const resource = toResource(row);
      const rules = params.rules ?? resource.availabilityRules ?? [];
      // Only what a booking made now may take: the resource's booking rules bound the search.
      const search = bookingSearch({
        rules: resource.bookingRules,
        timezone: resource.timezone,
        window: asked,
        now: row.now,
        bufferAfterMs: askedBufferMs,
      });
      if (!search) return null;
      const { window, bufferAfterMs } = search;
      // A slot's buffer may run past the window: the time it can reach must be proven free too.
      const reach = { start: window.start, end: new Date(window.end.getTime() + bufferAfterMs) };
      let busy: Interval[];
      if (tenantRef === null) {
        // No event, coverage or series can belong to a resource with no tenant: only its rows.
        busy = await this.listBusy(params.resourceId, reach);
      } else {
        busy = [];
        const parts = bufferAfterMs > 0 ? [window, { start: window.end, end: reach.end }] : [window];
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
          // Absence is never treated as free time: what cannot be proven gives no slot.
          if (freeBusy.coverage.state !== 'complete') return null;
          busy.push(...freeBusy.busy);
        }
      }
      // A slot [s, s + d) with its buffer meets busy [b, e) exactly when [s, s + d) meets [b - buffer, e).
      return findNextAvailable({
        busy: busy.map((interval) => ({
          start: new Date(interval.start.getTime() - bufferAfterMs),
          end: interval.end,
        })),
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
        SELECT erased_table, erased_rows FROM slotlock.erase_tenant(${params.tenantRef}::text)`;
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

/** The deployment role alone may suspend: another role is refused EXECUTE on the functions. */
function suspensionRefusal(error: unknown): unknown {
  if (pgCode(error) !== '42501') return error;
  return Object.assign(
    new Error('Slotlock suspends tenants and lifts suspensions only as the deployment role'),
    { code: 'tenant_suspension_not_permitted' as const, cause: error },
  );
}
