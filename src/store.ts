// DB mechanics for the Slotlock core — explicit `postgres` client in, structured results out.
// Domain policy (who may reserve, pricing, holds) belongs to future callers; this layer owns the
// reliable how: idempotent schema apply, EXCLUDE-arbitrated inserts with a structured conflict.
import { createHash, randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import {
  SLOTLOCK_CORE_DDL,
  SLOTLOCK_SCHEMA_CONTROL_REFUSAL,
  SLOTLOCK_TENANT_CONTEXT_SETTING,
  createSlotlockApplicationRoleGrantsDdl,
  createSlotlockTenantRlsDdl,
} from './ddl.js';
import { findNextAvailable, mergeIntervals } from './engine.js';
import { expandRules } from './rules.js';
import {
  CalendarContractError,
  expandCalendarEventOccurrences,
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
  CalendarFreeBusy,
  CalendarHorizonRollResult,
  CalendarOrganizer,
  CalendarRecurrenceException,
  CalendarReminder,
  CancelCalendarEventResult,
  CancelExternalReservationResult,
  ConfirmHoldResult,
  CreateReservationResult,
  ExternalReservationCommand,
  ExternalReservationResult,
  Interval,
  SlotlockCalendarEvent,
  SlotlockReservation,
  SlotlockResource,
  PutCalendarEventCommand,
  PutCalendarEventResult,
  ReleaseHoldResult,
  WeeklyAvailabilityRule,
} from './types.js';

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
export const SLOTLOCK_CALENDAR_HORIZON_DAYS = 367;
/**
 * Longest one-off event the store accepts (ten years and some leap days): long enough for any lease
 * or long-term rental, short enough that a unit error cannot occupy a resource for ever. A recurring
 * series is bounded by its 367-day materialization window instead.
 */
export const SLOTLOCK_MAX_EVENT_DURATION_DAYS = 3_660;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CALENDAR_WINDOW_MS = SLOTLOCK_CALENDAR_HORIZON_DAYS * DAY_MS;
const MAX_EVENT_DURATION_MS = SLOTLOCK_MAX_EVENT_DURATION_DAYS * DAY_MS;
const MAX_RESOURCE_LIST_LIMIT = 1_000;
const MAX_CALENDAR_LIST_LIMIT = 1_000;
const MAX_FREE_BUSY_INTERVALS = 10_000;
const MAX_COVERAGE_SOURCES = 64;
const MAX_COVERAGE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Trusted provider/maintenance namespace used by backwards-compatible store callers. */
export const SLOTLOCK_INTERNAL_EVENT_OWNER_REF = 'internal';
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

/** Stable daily target shared by the event writer, maintenance worker, and readiness proof. */
export function calendarEventRollingHorizon(now = new Date()): Interval {
  if (!Number.isFinite(now.getTime())) throw invalidWindowError();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = new Date(midnight - DAY_MS);
  return { start, end: new Date(start.getTime() + SLOTLOCK_CALENDAR_HORIZON_DAYS * DAY_MS) };
}

/** What `createSlotlockStore` accepts: a `postgres` client, or a transaction/savepoint from one. */
export type SlotlockSql = Sql | TransactionSql;
type StoreSql = SlotlockSql;

async function inTransaction<T>(
  executor: StoreSql,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if ('begin' in executor) return (await executor.begin(callback)) as T;
  return (await executor.savepoint(callback)) as T;
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
 * keeping the database's error (and its HINT) as `cause`; any other failure passes through unchanged.
 */
function schemaControlRefusal(error: unknown): unknown {
  const failure = error as { code?: unknown; message?: unknown; detail?: unknown } | null;
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

function invalidWindowError(): Error & { code: 'invalid_window' } {
  return Object.assign(new Error('Slotlock window must contain two finite dates with end > start'), {
    code: 'invalid_window' as const,
  });
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

function assertValidResourceInput(params: {
  externalRef?: string;
  tenantRef?: string;
  timezone?: string;
}): void {
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
      await reapExpiredHolds(tx, params.resourceId, occurrence.start, occurrence.end);
      const derivedExternalRef = `calendar:${params.eventId}:${createHash('sha256')
        .update(occurrence.recurrenceId)
        .digest('hex')}`;
      const reservations = await tx<{ id: string }[]>`
        INSERT INTO slotlock.reservations (
          resource_id, tenant_ref, external_ref, starts_at, ends_at,
          buffer_after_ms, revision, source, calendar_event_id
        ) VALUES (
          ${params.resourceId}, ${params.tenantRef}, ${derivedExternalRef},
          ${occurrence.start}, ${occurrence.end}, 0, ${params.revision},
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
    window.end.getTime() - window.start.getTime() > Math.max(MAX_CALENDAR_WINDOW_MS, duration)
  ) {
    throw new CalendarContractError('invalid_icalendar');
  }
  return { start: new Date(window.start), end: new Date(window.end) };
}

function calendarCommandHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function putCommandHash(params: {
  command: PutCalendarEventCommand;
  ownerRef: string;
  event: CalendarEventContent;
  window: Interval;
}): string {
  return calendarCommandHash({
    operation: 'put',
    ownerRef: params.ownerRef,
    externalRef: params.command.externalRef,
    idempotencyKey: params.command.idempotencyKey,
    expectedRevision: params.command.expectedRevision,
    resourceId: params.command.resourceId,
    source: params.command.source ?? null,
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
    materializationWindow: {
      start: params.window.start.toISOString(),
      end: params.window.end.toISOString(),
    },
  });
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

async function findCalendarOverlap(
  sql: StoreSql,
  resourceId: string,
  occurrences: Array<{ start: Date; end: Date }>,
): Promise<{ ok: false; code: 'overlap'; conflictingReservationId: string | null }> {
  for (const occurrence of occurrences) {
    const result = await overlapLoss(sql, resourceId, occurrence.start, occurrence.end);
    if (result.conflictingReservationId !== null) return result;
  }
  return { ok: false, code: 'overlap', conflictingReservationId: null };
}

function sameExternalPayload(row: ReservationRow, params: ExternalReservationCommand): boolean {
  return (
    row.resource_id === params.resourceId &&
    row.starts_at.getTime() === params.start.getTime() &&
    row.ends_at.getTime() === params.end.getTime() &&
    Number(row.buffer_after_ms) === params.bufferAfterMs &&
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

async function resourceBelongsToTenant(
  tx: TransactionSql,
  resourceId: string,
  tenantRef: string,
): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM slotlock.resources
     WHERE id = ${resourceId} AND tenant_ref = ${tenantRef}
     FOR SHARE`;
  return rows.length === 1;
}

function pgCode(err: unknown): string | undefined {
  let cur = err as { code?: string; cause?: unknown } | undefined;
  while (cur && typeof cur === 'object') {
    if (typeof cur.code === 'string') return cur.code;
    cur = cur.cause as typeof cur;
  }
  return undefined;
}

export interface SlotlockStore {
  /**
   * Apply the Slotlock DDL (idempotent). Owns the `slotlock` schema on the connected DB. Refuses
   * (`unsafe_slotlock_schema`, with the `reasons` found) a `slotlock` schema that a role other than the
   * connected one (superusers aside) owns or can create objects in, that holds an object such a
   * role owns (an extension included), or whose tables such a role may add triggers to or have a
   * trigger running a function such a role owns. Ownership through a group role counts as another
   * role's: deploy as the owning role itself (`SET ROLE`).
   */
  applySchema(): Promise<void>;
  /**
   * Atomically enable forced tenant RLS using this store's configured context setting. Refuses the
   * same `slotlock` schemas as `applySchema()`.
   */
  applyTenantRls(options?: { allowRebind?: boolean }): Promise<void>;
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
  grantApplicationRole(role: string): Promise<void>;
  /** Run store operations with one transaction-local tenant context on the same connection. */
  withTenant<T>(tenantRef: string, callback: (store: SlotlockTenantStore) => Promise<T>): Promise<T>;
  /**
   * INVARIANT (erasure completeness): a tenant integration must use a stable, erasable business
   * identifier for externalRef and include this schema in its own data-erasure workflow.
   */
  createResource(params: {
    externalRef?: string;
    tenantRef?: string;
    timezone?: string;
  }): Promise<SlotlockResource>;
  /** Resolve one tenant-owned resource without revealing another tenant's matching id. */
  getResource(params: { tenantRef: string; id: string }): Promise<SlotlockResource | null>;
  /** Bounded tenant resource discovery, ordered and keyset-paginated by immutable UUID. */
  listResources(params: {
    tenantRef: string;
    limit?: number;
    after?: string;
  }): Promise<SlotlockResource[]>;
  /**
   * Insert a confirmed reservation with the EXCLUDE constraint as the overlap arbiter. Never
   * throws for the expected outcomes: an invalid window or a lost race come back structured.
   * Expired holds overlapping the window are lazily reaped in the same transaction — an
   * expired-but-unpurged hold can never block (no cron required).
   */
  createReservation(params: {
    resourceId: string;
    start: Date;
    end: Date;
    source?: string;
  }): Promise<CreateReservationResult>;
  /** Idempotently create a tenant-owned booking reservation by its stable business identity. */
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
   * until `expiresAt` (DB clock — now() + ttl, never the app clock), then frees via lazy reap.
   */
  acquireHold(params: {
    resourceId: string;
    start: Date;
    end: Date;
    ttlMs: number;
    source?: string;
  }): Promise<AcquireHoldResult>;
  /** Flip an unexpired hold to a confirmed reservation (expiry cleared). */
  confirmHold(holdId: string): Promise<ConfirmHoldResult>;
  /** Delete a live hold; released=false when it was already gone (expired-reaped or confirmed). */
  releaseHold(holdId: string): Promise<ReleaseHoldResult>;
  /** Reservations overlapping `window` for one resource, as merged-ready half-open intervals. */
  listBusy(resourceId: string, window: Interval): Promise<Interval[]>;
  /** Create or revise one trusted event under expected-revision + tenant idempotency guards. */
  putCalendarEvent(params: PutCalendarEventCommand): Promise<PutCalendarEventResult>;
  /** Read one active event. A cancelled/tombstoned identity reads as absent. */
  getCalendarEvent(params: {
    tenantRef: string;
    /** Defaults to the trusted `internal` namespace. */
    ownerRef?: string;
    externalRef: string;
  }): Promise<SlotlockCalendarEvent | null>;
  /** List active events with at least one materialized occurrence intersecting the window. */
  listCalendarEvents(params: {
    tenantRef: string;
    /** Defaults to the trusted `internal` namespace. */
    ownerRef?: string;
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
  }): Promise<CancelCalendarEventResult>;
  /**
   * Atomically rematerialize due recurring masters into one rolling window without changing their
   * semantic revision. A collision rolls back that master and leaves its old coverage untouched.
   */
  rollCalendarEventHorizon(params: {
    tenantRef: string;
    window: Interval;
    limit?: number;
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
  /** Convenience composition: listBusy × expandRules (in the resource's stored timezone) → findNextAvailable. */
  findNextAvailableFor(params: {
    resourceId: string;
    rules: WeeklyAvailabilityRule[];
    searchWindow: Interval;
    durationMs: number;
  }): Promise<Interval | null>;
}

export type SlotlockTenantStore = Omit<
  SlotlockStore,
  'applySchema' | 'applyTenantRls' | 'grantApplicationRole' | 'withTenant'
>;

export interface SlotlockStoreOptions {
  /** Namespaced PostgreSQL setting installed by applyTenantRls. Defaults to `slotlock.tenant_ref`. */
  tenantContextSetting?: string;
  /** Hard active + tombstone identity ceiling per non-internal owner. Defaults to 1,000. */
  agentOwnerEventQuota?: number;
  /** Hard retained-command ceiling per non-internal owner. Defaults to 10,000; cannot be disabled. */
  agentOwnerCommandQuota?: number;
}

/**
 * Delete expired held rows overlapping the requested window, in deterministic id order under
 * FOR UPDATE — two concurrent reapers lock the same rows in the same order (no deadlock), the
 * loser simply finds them gone. Runs inside the caller's transaction, immediately before its
 * INSERT, so the EXCLUDE arbiter only ever sees LIVE occupation.
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
          AND expires_at <= now()
          AND starts_at < ${end}
          AND ends_at > ${start}
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
): Promise<{ ok: false; code: 'overlap'; conflictingReservationId: string | null }> {
  const winners = await sql<{ id: string }[]>`
    SELECT id FROM slotlock.reservations
     WHERE resource_id = ${resourceId}
       AND (${excludeReservationId ?? null}::uuid IS NULL OR id <> ${excludeReservationId ?? null}::uuid)
       AND tstzrange(
             starts_at,
             COALESCE(occupied_ends_at, ends_at),
             '[)'
           ) && tstzrange(
             ${start},
             ${end} + ${bufferAfterMs} * interval '1 millisecond',
             '[)'
           )
       AND (status <> 'held' OR expires_at > now())
     ORDER BY starts_at
     LIMIT 1`;
  return { ok: false, code: 'overlap', conflictingReservationId: winners[0]?.id ?? null };
}

export function createSlotlockStore(sql: StoreSql, options: SlotlockStoreOptions = {}): SlotlockStore {
  const configuredTenantSetting = options.tenantContextSetting ?? SLOTLOCK_TENANT_CONTEXT_SETTING;
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
  createSlotlockTenantRlsDdl(configuredTenantSetting); // Validate once before any scoped query.
  return {
    async applySchema() {
      // PostgreSQL's IF NOT EXISTS DDL is idempotent after commit but not race-free: two fresh
      // application instances can still collide on pg_namespace/pg_extension unique indexes.
      // Serialize bootstrap per database and let the transaction release the lock on crashes.
      await inTransaction(sql, (tx) =>
        withPinnedSearchPath(tx, async () => {
          await tx`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${SCHEMA_APPLY_LOCK}, 0))`;
          await tx.unsafe(SLOTLOCK_CORE_DDL).catch((error: unknown) => {
            throw schemaControlRefusal(error);
          });
        }),
      );
    },

    async applyTenantRls(applyOptions) {
      const ddl = createSlotlockTenantRlsDdl(configuredTenantSetting);
      await inTransaction(sql, (tx) =>
        withPinnedSearchPath(tx, async () => {
          await tx`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${SCHEMA_APPLY_LOCK}, 0))`;
          const bindings = await tx<{ binding: string }[]>`
            SELECT DISTINCT obj_description(policy.oid, 'pg_policy') AS binding
              FROM pg_policy policy
              JOIN pg_class table_class ON table_class.oid = policy.polrelid
              JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
             WHERE namespace.nspname = 'slotlock'
               AND table_class.relname IN (
                 'resources',
                 'reservations',
                 'reservation_tombstones',
                 'reservation_conflict_archive',
                 'calendar_events',
                 'calendar_event_attendees',
                 'calendar_event_reminders',
                 'calendar_event_exceptions',
                 'calendar_event_occurrences',
                 'calendar_event_tombstones',
                 'calendar_event_commands',
                 'calendar_coverage'
               )
               AND obj_description(policy.oid, 'pg_policy') LIKE 'slotlock:tenant-context:%'`;
          const conflictingBinding = bindings.find(
            ({ binding }) => binding !== `slotlock:tenant-context:${configuredTenantSetting}`,
          );
          if (conflictingBinding && applyOptions?.allowRebind !== true) {
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
        }),
      );
    },

    async grantApplicationRole(role) {
      const ddl = createSlotlockApplicationRoleGrantsDdl(role);
      await inTransaction(sql, (tx) =>
        withPinnedSearchPath(tx, async () => {
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
        }),
      );
    },

    async withTenant(tenantRef, callback) {
      if (!isValidIdentity(tenantRef)) {
        throw Object.assign(new Error('Slotlock tenant reference must be 1-500 UTF-8 bytes'), {
          code: 'invalid_tenant_ref' as const,
        });
      }
      return inTransaction(sql, async (tx) => {
        const previous = await tx<{ value: string | null }[]>`
          SELECT current_setting(${configuredTenantSetting}, true) AS value`;
        await tx`SELECT set_config(${configuredTenantSetting}, ${tenantRef}, true)`;
        try {
          return await callback(
            createSlotlockStore(tx, {
              tenantContextSetting: configuredTenantSetting,
              agentOwnerEventQuota: configuredAgentOwnerEventQuota,
              agentOwnerCommandQuota: configuredAgentOwnerCommandQuota,
            }) as SlotlockTenantStore,
          );
        } finally {
          await tx`SELECT set_config(${configuredTenantSetting}, ${previous[0]?.value ?? ''}, true)`;
        }
      });
    },

    async createResource(params) {
      assertValidResourceInput(params);
      type ResourceIdentityRow = {
        id: string;
        external_ref: string | null;
        tenant_ref: string | null;
        timezone: string;
      };
      let rows: ResourceIdentityRow[];
      if (params.tenantRef !== undefined && params.externalRef !== undefined) {
        rows = await sql<ResourceIdentityRow[]>`
          INSERT INTO slotlock.resources (external_ref, tenant_ref, timezone)
          VALUES (${params.externalRef}, ${params.tenantRef}, ${params.timezone ?? 'UTC'})
          ON CONFLICT (tenant_ref, external_ref)
            WHERE tenant_ref IS NOT NULL AND external_ref IS NOT NULL
          DO UPDATE SET timezone = EXCLUDED.timezone
          RETURNING id, external_ref, tenant_ref, timezone`;
      } else if (params.externalRef !== undefined) {
        rows = await sql<ResourceIdentityRow[]>`
          INSERT INTO slotlock.resources (external_ref, tenant_ref, timezone)
          VALUES (${params.externalRef}, NULL, ${params.timezone ?? 'UTC'})
          ON CONFLICT (external_ref)
            WHERE tenant_ref IS NULL AND external_ref IS NOT NULL
          DO UPDATE SET external_ref = EXCLUDED.external_ref
          RETURNING id, external_ref, tenant_ref, timezone`;
      } else {
        rows = await sql<ResourceIdentityRow[]>`
          INSERT INTO slotlock.resources (external_ref, tenant_ref, timezone)
          VALUES (NULL, NULL, ${params.timezone ?? 'UTC'})
          RETURNING id, external_ref, tenant_ref, timezone`;
      }
      const row = rows[0];
      if (!row) {
        throw new Error('slotlock: resource upsert returned no row');
      }
      return {
        id: row.id,
        externalRef: row.external_ref,
        tenantRef: row.tenant_ref,
        timezone: row.timezone,
      };
    },

    async getResource(params) {
      if (!isValidIdentity(params.tenantRef) || !isValidResourceId(params.id)) {
        throw Object.assign(new Error('Slotlock resource identity is invalid'), {
          code: 'invalid_identity' as const,
        });
      }
      const rows = await sql<
        { id: string; external_ref: string | null; tenant_ref: string | null; timezone: string }[]
      >`
        SELECT id, external_ref, tenant_ref, timezone
          FROM slotlock.resources
         WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}`;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        externalRef: row.external_ref,
        tenantRef: row.tenant_ref,
        timezone: row.timezone,
      };
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
      const rows = await sql<
        { id: string; external_ref: string | null; tenant_ref: string | null; timezone: string }[]
      >`
        SELECT id, external_ref, tenant_ref, timezone
          FROM slotlock.resources
         WHERE tenant_ref = ${params.tenantRef}
           AND (${params.after ?? null}::uuid IS NULL OR id > ${params.after ?? null}::uuid)
         ORDER BY id
         LIMIT ${limit}`;
      return rows.map((row) => ({
        id: row.id,
        externalRef: row.external_ref,
        tenantRef: row.tenant_ref,
        timezone: row.timezone,
      }));
    },

    async createReservation(params) {
      if (!isFiniteWindow({ start: params.start, end: params.end })) {
        return { ok: false, code: 'invalid_window' };
      }
      for (let attempt = 1; ; attempt++) {
        try {
          const rows = await inTransaction(sql, async (tx) => {
            await reapExpiredHolds(tx, params.resourceId, params.start, params.end);
            return tx<
              {
                id: string;
                resource_id: string;
                starts_at: Date;
                ends_at: Date;
                source: string | null;
              }[]
            >`
              INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, source)
              VALUES (${params.resourceId}, ${params.start}, ${params.end}, ${params.source ?? null})
              RETURNING id, resource_id, starts_at, ends_at, source`;
          });
          const row = rows[0];
          if (!row) throw new Error('slotlock: reservation insert returned no row');
          const reservation: SlotlockReservation = {
            id: row.id,
            resourceId: row.resource_id,
            tenantRef: null,
            externalRef: null,
            start: row.starts_at,
            end: row.ends_at,
            bufferAfterMs: 0,
            revision: 1,
            source: row.source,
          };
          return { ok: true, reservation };
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
          return overlapLoss(sql, params.resourceId, params.start, params.end);
        }
      }
    },

    async createExternalReservation(params) {
      const invalid = validateExternalCommand(params);
      if (invalid) return invalid;
      if (params.revision !== 1) return { ok: false, code: 'invalid_revision' };
      for (let attempt = 1; ; attempt++) {
        try {
          return await inTransaction(sql, async (tx): Promise<ExternalReservationResult> => {
            await lockExternalIdentity(tx, params.tenantRef, params.externalRef);
            const cancelled = await tx<{ revision: string | number }[]>`
              SELECT revision FROM slotlock.reservation_tombstones
               WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}`;
            if (cancelled[0]) return { ok: false, code: 'reservation_cancelled' };
            const existing = await tx<ReservationRow[]>`
              SELECT id, resource_id, tenant_ref, external_ref, starts_at, ends_at,
                     buffer_after_ms, revision, source
                FROM slotlock.reservations
               WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}
               FOR UPDATE`;
            const found = existing[0];
            if (found) {
              if (!sameExternalPayload(found, params)) {
                return { ok: false, code: 'idempotency_conflict' };
              }
              return { ok: true, reservation: toReservation(found), idempotent: true };
            }
            if (!(await resourceBelongsToTenant(tx, params.resourceId, params.tenantRef))) {
              return { ok: false, code: 'resource_tenant_mismatch' };
            }
            await reapExpiredHolds(tx, params.resourceId, params.start, occupiedEnd(params));
            const rows = await tx<ReservationRow[]>`
              INSERT INTO slotlock.reservations (
                resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms,
                revision, source
              ) VALUES (
                ${params.resourceId}, ${params.tenantRef}, ${params.externalRef}, ${params.start},
                ${params.end}, ${params.bufferAfterMs}, ${params.revision}, ${params.source ?? null}
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
          return overlapLoss(
            sql,
            params.resourceId,
            params.start,
            params.end,
            params.bufferAfterMs,
          );
        }
      }
    },

    async rescheduleExternalReservation(params) {
      const invalid = validateExternalCommand(params);
      if (invalid) return invalid;
      let currentReservationId: string | undefined;
      for (let attempt = 1; ; attempt++) {
        try {
          return await inTransaction(sql, async (tx): Promise<ExternalReservationResult> => {
            await lockExternalIdentity(tx, params.tenantRef, params.externalRef);
            const existing = await tx<ReservationRow[]>`
              SELECT id, resource_id, tenant_ref, external_ref, starts_at, ends_at,
                     buffer_after_ms, revision, source
                FROM slotlock.reservations
               WHERE tenant_ref = ${params.tenantRef} AND external_ref = ${params.externalRef}
               FOR UPDATE`;
            const found = existing[0];
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
            if (sameExternalPayload(found, params)) {
              return { ok: true, reservation: toReservation(found), idempotent: true };
            }
            if (params.revision === currentRevision) {
              return { ok: false, code: 'idempotency_conflict' };
            }
            if (params.revision !== currentRevision + 1) {
              return { ok: false, code: 'revision_conflict' };
            }
            if (!(await resourceBelongsToTenant(tx, params.resourceId, params.tenantRef))) {
              return { ok: false, code: 'resource_tenant_mismatch' };
            }
            await reapExpiredHolds(tx, params.resourceId, params.start, occupiedEnd(params));
            const rows = await tx<ReservationRow[]>`
              UPDATE slotlock.reservations
                 SET resource_id = ${params.resourceId},
                     starts_at = ${params.start},
                     ends_at = ${params.end},
                     buffer_after_ms = ${params.bufferAfterMs},
                     revision = ${params.revision},
                     source = ${params.source ?? null}
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
          return overlapLoss(
            sql,
            params.resourceId,
            params.start,
            params.end,
            params.bufferAfterMs,
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
           FOR UPDATE`;
        const found = existing[0];
        if (found) {
          const currentRevision = Number(found.revision);
          if (params.revision <= currentRevision) return { ok: false, code: 'stale_revision' };
          if (params.revision !== currentRevision + 1) {
            return { ok: false, code: 'revision_conflict' };
          }
        }

        await tx`
          INSERT INTO slotlock.reservation_tombstones (tenant_ref, external_ref, revision)
          VALUES (${params.tenantRef}, ${params.externalRef}, ${params.revision})`;
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
      const ttlSeconds = params.ttlMs / 1000;
      for (let attempt = 1; ; attempt++) {
        try {
          const rows = await inTransaction(sql, async (tx) => {
            await reapExpiredHolds(tx, params.resourceId, params.start, params.end);
            return tx<
              {
                id: string;
                resource_id: string;
                starts_at: Date;
                ends_at: Date;
                expires_at: Date;
                source: string | null;
              }[]
            >`
              INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, status, expires_at, source)
              VALUES (${params.resourceId}, ${params.start}, ${params.end}, 'held',
                      now() + make_interval(secs => ${ttlSeconds}), ${params.source ?? null})
              RETURNING id, resource_id, starts_at, ends_at, expires_at, source`;
          });
          const row = rows[0];
          if (!row) throw new Error('slotlock: hold insert returned no row');
          return {
            ok: true,
            hold: {
              id: row.id,
              resourceId: row.resource_id,
              start: row.starts_at,
              end: row.ends_at,
              expiresAt: row.expires_at,
              source: row.source,
            },
          };
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
          return overlapLoss(sql, params.resourceId, params.start, params.end);
        }
      }
    },

    async confirmHold(holdId) {
      const rows = await sql<
        {
          id: string;
          resource_id: string;
          starts_at: Date;
          ends_at: Date;
          source: string | null;
        }[]
      >`
        UPDATE slotlock.reservations
           SET status = 'confirmed', expires_at = NULL
         WHERE id = ${holdId} AND status = 'held' AND expires_at > now()
         RETURNING id, resource_id, starts_at, ends_at, source`;
      const row = rows[0];
      if (row) {
        return {
          ok: true,
          reservation: {
            id: row.id,
            resourceId: row.resource_id,
            tenantRef: null,
            externalRef: null,
            start: row.starts_at,
            end: row.ends_at,
            bufferAfterMs: 0,
            revision: 1,
            source: row.source,
          },
        };
      }
      const present = await sql<
        {
          status: string;
          expired: boolean;
          resource_id: string;
          starts_at: Date;
          ends_at: Date;
          source: string | null;
        }[]
      >`
        SELECT status, (status = 'held' AND expires_at <= now()) AS expired,
               resource_id, starts_at, ends_at, source
          FROM slotlock.reservations WHERE id = ${holdId}`;
      const found = present[0];
      // Idempotent confirm: a retried confirm (network replay) of an already-confirmed hold is
      // SUCCESS — the booking exists; reporting failure would make callers double-book elsewhere.
      if (found && found.status === 'confirmed') {
        return {
          ok: true,
          reservation: {
            id: holdId,
            resourceId: found.resource_id,
            tenantRef: null,
            externalRef: null,
            start: found.starts_at,
            end: found.ends_at,
            bufferAfterMs: 0,
            revision: 1,
            source: found.source,
          },
        };
      }
      if (found?.expired) return { ok: false, code: 'hold_expired' };
      // NOTE: a hold reaped mid-flight by a rival (expired while this confirm waited on the
      // reaper's lock) reads as hold_not_found — the row is gone and the space was legitimately
      // taken; both refusal codes are terminal for the caller.
      return { ok: false, code: 'hold_not_found' };
    },

    async releaseHold(holdId) {
      const rows = await sql<{ id: string }[]>`
        DELETE FROM slotlock.reservations
         WHERE id = ${holdId} AND status = 'held'
         RETURNING id`;
      return { ok: true, released: rows.length > 0 };
    },

    async listBusy(resourceId, window) {
      if (!isFiniteWindow(window)) throw invalidWindowError();
      // Expired holds are dead occupation: excluded here so findNextAvailable can offer their
      // space (the acquiring transaction reaps the row itself when it takes the window).
      const rows = await sql<{ starts_at: Date; occupied_ends_at: Date }[]>`
        SELECT starts_at, COALESCE(occupied_ends_at, ends_at) AS occupied_ends_at
          FROM slotlock.reservations
         WHERE resource_id = ${resourceId}
           AND starts_at < ${window.end}
           AND COALESCE(occupied_ends_at, ends_at) > ${window.start}
           AND (status <> 'held' OR expires_at > now())
         ORDER BY starts_at`;
      return rows.map((r) => ({ start: r.starts_at, end: r.occupied_ends_at }));
    },

    async putCalendarEvent(params) {
      const ownerRef = params.ownerRef ?? SLOTLOCK_INTERNAL_EVENT_OWNER_REF;
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
      let occurrences: CalendarEventOccurrence[];
      try {
        event = normalizeCalendarEventContent(params);
        if (event.recurrence) {
          if (!params.materializationWindow) return { ok: false, code: 'invalid_event' };
          materializationWindow = calendarWindow(params.materializationWindow);
        } else {
          materializationWindow = oneOffEventWindow(event, params.materializationWindow);
        }
        occurrences = expandCalendarEventOccurrences(event, materializationWindow);
      } catch (error) {
        if (error instanceof CalendarContractError) return { ok: false, code: 'invalid_event' };
        throw error;
      }
      const payloadHash = putCommandHash({
        command: params,
        ownerRef,
        event,
        window: materializationWindow,
      });

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
              if (priorCommand.operation !== 'put' || priorCommand.payload_hash !== payloadHash) {
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
            if (!(await resourceBelongsToTenant(tx, params.resourceId, params.tenantRef))) {
              return { ok: false, code: 'resource_tenant_mismatch' };
            }
            const existing = await tx<CalendarEventRow[]>`
              SELECT id, tenant_ref, owner_ref, external_ref, resource_id, starts_at, ends_at, timezone,
                     summary, description, location, status, transparency, organizer, attendees,
                     reminders, recurrence_rule, recurrence_exceptions, materialized_starts_at,
                     materialized_ends_at, revision, source, created_at, updated_at
                FROM slotlock.calendar_events
               WHERE tenant_ref = ${params.tenantRef}
                 AND owner_ref = ${ownerRef}
                 AND external_ref = ${params.externalRef}
               FOR UPDATE`;
            const found = existing[0];
            const currentRevision = found ? Number(found.revision) : 0;
            if (params.expectedRevision !== currentRevision) {
              return { ok: false, code: 'revision_conflict', currentRevision };
            }
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
            const eventId = found?.id ?? randomUUID();
            const revision = currentRevision + 1;

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
                       revision = ${revision},
                       source = ${params.source ?? null},
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
                  materialized_ends_at, revision, source
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
                  ${materializationWindow.start}, ${materializationWindow.end}, ${revision},
                  ${params.source ?? null}
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
          return findCalendarOverlap(sql, params.resourceId, occurrences);
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

    async listCalendarEvents(params) {
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
           AND event.owner_ref = ${ownerRef}
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
      const window = calendarWindow(params.window);
      const limit = params.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_CALENDAR_LIST_LIMIT) {
        throw Object.assign(new Error('Slotlock horizon batch limit must be 1-1000'), {
          code: 'invalid_limit' as const,
        });
      }
      const candidates = await sql<{ id: string }[]>`
        SELECT id
          FROM slotlock.calendar_events
         WHERE tenant_ref = ${params.tenantRef}
           AND recurrence_rule IS NOT NULL
           AND (
             materialized_starts_at <> ${window.start}
             OR materialized_ends_at < ${window.end}
           )
         ORDER BY materialized_ends_at, id
         LIMIT ${limit + 1}`;
      const due = candidates.slice(0, limit);
      let extended = 0;
      let conflicts = 0;

      for (const candidate of due) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const changed = await inTransaction(sql, async (tx) => {
              const [row] = await tx<CalendarEventRow[]>`
                SELECT id, tenant_ref, owner_ref, external_ref, resource_id, starts_at, ends_at, timezone,
                       summary, description, location, status, transparency, organizer, attendees,
                       reminders, recurrence_rule, recurrence_exceptions, materialized_starts_at,
                       materialized_ends_at, revision, source, created_at, updated_at
                  FROM slotlock.calendar_events
                 WHERE id = ${candidate.id} AND tenant_ref = ${params.tenantRef}
                 FOR UPDATE`;
              if (
                !row ||
                row.recurrence_rule === null ||
                (row.materialized_starts_at.getTime() === window.start.getTime() &&
                  row.materialized_ends_at >= window.end)
              ) {
                return false;
              }
              const childMap = await loadCalendarEventChildren(tx, [row.id]);
              const event = toCalendarEvent(row, childMap.get(row.id));
              const occurrences = expandCalendarEventOccurrences(event, window);
              await replaceCalendarEventOccurrences(tx, {
                tenantRef: params.tenantRef,
                eventId: row.id,
                resourceId: row.resource_id,
                event,
                occurrences,
                revision: Number(row.revision),
              });
              await tx`
                UPDATE slotlock.calendar_events
                   SET materialized_starts_at = ${window.start},
                       materialized_ends_at = ${window.end}
                 WHERE id = ${row.id} AND tenant_ref = ${params.tenantRef}`;
              return true;
            });
            if (changed) extended += 1;
            break;
          } catch (error) {
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
              break;
            }
            throw error;
          }
        }
      }
      return {
        examined: due.length,
        extended,
        conflicts,
        hasMore: candidates.length > limit,
      };
    },

    async cancelCalendarEvent(params) {
      const ownerRef = params.ownerRef ?? SLOTLOCK_INTERNAL_EVENT_OWNER_REF;
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
        const events = await tx<{ id: string; revision: string | number }[]>`
          SELECT id, revision FROM slotlock.calendar_events
           WHERE tenant_ref = ${params.tenantRef}
             AND owner_ref = ${ownerRef}
             AND external_ref = ${params.externalRef}
           FOR UPDATE`;
        const found = events[0];
        const currentRevision = found ? Number(found.revision) : 0;
        if (!found && ownerRef !== SLOTLOCK_INTERNAL_EVENT_OWNER_REF) {
          return { ok: false, code: 'event_not_found' };
        }
        if (params.expectedRevision !== currentRevision) {
          return { ok: false, code: 'revision_conflict', currentRevision };
        }
        const eventId = found?.id ?? randomUUID();
        const revision = currentRevision + 1;
        if (found) {
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
               AND owner_ref = ${ownerRef}`;
        }
        await tx`
          INSERT INTO slotlock.calendar_event_tombstones (
            tenant_ref, owner_ref, external_ref, event_id, revision
          ) VALUES (
            ${params.tenantRef}, ${ownerRef}, ${params.externalRef}, ${eventId}, ${revision}
          )`;
        await tx`
          INSERT INTO slotlock.calendar_event_commands (
            tenant_ref, owner_ref, idempotency_key, operation, payload_hash, event_id, external_ref,
            result_revision, occurrence_count
          ) VALUES (
            ${params.tenantRef}, ${ownerRef}, ${params.idempotencyKey}, 'cancel', ${payloadHash},
            ${eventId}, ${params.externalRef}, ${revision}, 0
          )`;
        return {
          ok: true,
          eventId,
          externalRef: params.externalRef,
          revision,
          idempotent: false,
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
        if (!(await resourceBelongsToTenant(tx, params.resourceId, params.tenantRef))) {
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
                   revision = ${params.revision}, observed_at = now()
             WHERE tenant_ref = ${params.tenantRef}
               AND resource_id = ${params.resourceId}
               AND source = ${params.source}`;
        } else {
          if (params.revision !== 1) return { ok: false, code: 'revision_conflict' };
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
           AND (reservation.status <> 'held' OR reservation.expires_at > now())
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
               bool_and(
                 materialized_ends_at >= ${window.end}
                 AND (
                   earliest_possible_at >= ${window.start}
                   OR materialized_starts_at <= ${window.start}
                 )
               ) AS complete,
               bool_or(
                 materialized_ends_at > ${window.start}
                 AND (
                   earliest_possible_at >= ${window.start}
                   OR materialized_starts_at < ${window.end}
                 )
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
      if (!isFiniteWindow(params.searchWindow)) throw invalidWindowError();
      if (!Number.isFinite(params.durationMs) || params.durationMs <= 0) return null;
      // Rules are authored in the resource's zone — expansion must honour it (DST-correct).
      const tzRows = await sql<{ timezone: string }[]>`
        SELECT timezone FROM slotlock.resources WHERE id = ${params.resourceId}`;
      const busy = await this.listBusy(params.resourceId, params.searchWindow);
      const windows = expandRules(params.rules, params.searchWindow, tzRows[0]?.timezone ?? 'UTC');
      return findNextAvailable({ busy, windows, durationMs: params.durationMs });
    },
  };
}
