// Stored hours and their exceptions (RFC 0004 B1, B2), in the tenant's transaction under its
// row-level security. The tenant and each location may store weekly hours a resource without its
// own inherits; exceptions close whole local days, or give them hours of their own, for the tenant,
// a location (and everything inside it) or one resource.
import type { Sql, TransactionSql } from 'postgres';
import {
  SLOTLOCK_MAX_AVAILABILITY_EXCEPTIONS,
  type SlotlockAvailabilityException,
  type SlotlockExceptionOutcome,
  type SlotlockExceptionSource,
  type SlotlockExceptionWindow,
  type SlotlockRankedException,
  invalidException,
  parseExceptionDays,
  storedExceptionWindows,
} from './hours.js';
import type { SlotlockHoliday } from './holidays.js';
import type { SlotlockInheritedAvailability, WeeklyAvailabilityRule } from './types.js';
import { parseAvailabilityRules } from './weekly-hours.js';

type StoreSql = Sql | TransactionSql;

const LOCATION_REF = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL = 200;
const MAX_SOURCE_UID_BYTES = 600;
const MAX_LIST = 1_000;

/** The tenant's stored hours and each location's that has them. */
export interface SlotlockAvailabilityDefaults {
  tenant: WeeklyAvailabilityRule[] | null;
  locations: { location: string; rules: WeeklyAvailabilityRule[] }[];
}

/**
 * What storing the tenant's hours does to resources with hours of their own: `none` keeps them,
 * `all` clears them so every resource inherits, and `matching` clears only those whose hours are
 * the same as the tenant's were before, or as the hours being stored: the copies an earlier
 * version (0.8.0 and before) made, while hours set apart on purpose stay.
 */
export type SlotlockOverrideResources = 'none' | 'matching' | 'all';

export const SLOTLOCK_OVERRIDE_RESOURCES: readonly SlotlockOverrideResources[] = Object.freeze(['none', 'matching', 'all']);

/** What setting stored hours changed: resources now on them, and those that keep their own. */
export interface SlotlockAvailabilityDefaultsResult {
  /** Resources in use whose hours these now are. */
  inheriting: number;
  /** Resources in use the hours reach that keep hours of their own. */
  ownHours: number;
}

export interface SlotlockAvailabilityExceptionInput {
  tenantRef: string;
  /** A location: it and every location inside it. */
  location?: string;
  /** One resource. Neither: the whole tenant. */
  resourceId?: string;
  startsOn: string;
  /** The last day, inclusive; the first when absent. */
  endsOn?: string;
  outcome: SlotlockExceptionOutcome;
  hours?: readonly SlotlockExceptionWindow[];
  label: string;
  source?: SlotlockExceptionSource;
  /** An import's own id for the exception: importing again updates the same one. */
  sourceUid?: string;
  /** The holiday calendar it is imported from (importHolidayCalendar); internal. */
  calendarId?: string;
}

/** Inherited hours as slotlock.inherited_availability gives them; rules that do not parse read as closed. */
export function storedInheritedAvailability(value: unknown): SlotlockInheritedAvailability | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { source, location, rules } = value as Record<string, unknown>;
  if (source !== 'location' && source !== 'tenant') return undefined;
  let parsed: WeeklyAvailabilityRule[];
  try {
    parsed = parseAvailabilityRules(rules);
  } catch {
    parsed = [];
  }
  return source === 'location' && typeof location === 'string'
    ? { source, location, rules: parsed }
    : { source: 'tenant', rules: parsed };
}

function storedRules(value: unknown): WeeklyAvailabilityRule[] {
  try {
    return parseAvailabilityRules(value);
  } catch {
    return [];
  }
}

function rulesParameter(sql: StoreSql, rules: readonly WeeklyAvailabilityRule[]) {
  return sql.json(parseAvailabilityRules([...rules]).map((rule) => ({ ...rule })) as never);
}

function notFound(code: 'location_not_found' | 'resource_not_found', message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * Store the tenant's weekly hours (or clear them, `null`): every resource without its own and with
 * no location hours above it uses them. `overrideResources` says what becomes of the hours
 * resources keep of their own (SlotlockOverrideResources; `none` by default).
 */
export async function storeTenantAvailability(
  sql: StoreSql,
  params: {
    tenantRef: string;
    rules: readonly WeeklyAvailabilityRule[] | null;
    overrideResources?: SlotlockOverrideResources;
  },
): Promise<SlotlockAvailabilityDefaultsResult> {
  const override = params.overrideResources ?? 'none';
  if (!SLOTLOCK_OVERRIDE_RESOURCES.includes(override)) {
    throw Object.assign(new Error("overrideResources must be 'none', 'matching' or 'all'"), {
      code: 'invalid_availability' as const,
    });
  }
  const rules = params.rules === null ? null : parseAvailabilityRules([...params.rules]);
  // The hours stored before, for `matching`: read before they are replaced.
  const [before] =
    override === 'matching'
      ? await sql<{ rules: unknown }[]>`
          SELECT rules FROM slotlock.availability_defaults
           WHERE tenant_ref = ${params.tenantRef} AND location_ref IS NULL`
      : [];
  if (params.rules === null) {
    await sql`DELETE FROM slotlock.availability_defaults WHERE tenant_ref = ${params.tenantRef} AND location_ref IS NULL`;
  } else {
    await sql`
      INSERT INTO slotlock.availability_defaults (tenant_ref, location_ref, rules)
      VALUES (${params.tenantRef}, NULL, ${rulesParameter(sql, params.rules)}::jsonb)
      ON CONFLICT (tenant_ref, (COALESCE(location_ref, '')))
      DO UPDATE SET rules = EXCLUDED.rules, updated_at = statement_timestamp()`;
  }
  if (override === 'all') {
    await sql`
      UPDATE slotlock.resources SET availability_rules = NULL
       WHERE tenant_ref = ${params.tenantRef} AND availability_rules IS NOT NULL`;
  } else if (override === 'matching') {
    const same = [rules, before ? storedRules(before.rules) : null].filter(
      (candidate): candidate is WeeklyAvailabilityRule[] => candidate !== null,
    );
    if (same.length > 0) {
      // The same hours in any order: each list compared with its rules sorted.
      await sql`
        WITH wanted AS (
          SELECT COALESCE((SELECT jsonb_agg(rule ORDER BY rule::text) FROM jsonb_array_elements(hours) rule), '[]'::jsonb) AS hours
            FROM jsonb_array_elements(${sql.json(same.map((list) => list.map((rule) => ({ ...rule }))) as never)}::jsonb) hours
        )
        UPDATE slotlock.resources AS resource SET availability_rules = NULL
         WHERE resource.tenant_ref = ${params.tenantRef}
           AND jsonb_typeof(resource.availability_rules) = 'array'
           AND COALESCE(
                 (SELECT jsonb_agg(rule ORDER BY rule::text) FROM jsonb_array_elements(resource.availability_rules) rule),
                 '[]'::jsonb
               ) IN (SELECT hours FROM wanted)`;
    }
  }
  const [counted] = await sql<{ inheriting: string; own_hours: string }[]>`
    SELECT count(*) FILTER (
             WHERE availability_rules IS NULL
               AND COALESCE(slotlock.inherited_availability(tenant_ref, location_ref) ->> 'source', 'server') <> 'location'
           ) AS inheriting,
           count(*) FILTER (WHERE availability_rules IS NOT NULL) AS own_hours
      FROM slotlock.resources
     WHERE tenant_ref = ${params.tenantRef} AND archived_at IS NULL`;
  return { inheriting: Number(counted?.inheriting ?? 0), ownHours: Number(counted?.own_hours ?? 0) };
}

/**
 * Store a location's weekly hours (or clear them, `null`): resources at it or inside it without
 * their own use them, unless a location nearer them has its own. Null for a location the tenant
 * does not have.
 */
export async function setLocationAvailability(
  sql: StoreSql,
  params: { tenantRef: string; location: string; rules: readonly WeeklyAvailabilityRule[] | null },
): Promise<SlotlockAvailabilityDefaultsResult | null> {
  if (!LOCATION_REF.test(params.location)) return null;
  const [place] = await sql<{ ref: string }[]>`
    SELECT ref FROM slotlock.locations
     WHERE tenant_ref = ${params.tenantRef} AND ref = ${params.location} FOR KEY SHARE`;
  if (!place) return null;
  if (params.rules === null) {
    await sql`
      DELETE FROM slotlock.availability_defaults
       WHERE tenant_ref = ${params.tenantRef} AND location_ref = ${params.location}`;
  } else {
    await sql`
      INSERT INTO slotlock.availability_defaults (tenant_ref, location_ref, rules)
      VALUES (${params.tenantRef}, ${params.location}, ${rulesParameter(sql, params.rules)}::jsonb)
      ON CONFLICT (tenant_ref, (COALESCE(location_ref, '')))
      DO UPDATE SET rules = EXCLUDED.rules, updated_at = statement_timestamp()`;
  }
  const [counted] = await sql<{ inheriting: string; own_hours: string }[]>`
    SELECT count(*) FILTER (
             WHERE availability_rules IS NULL
               AND slotlock.inherited_availability(tenant_ref, location_ref) ->> 'location' = ${params.location}
           ) AS inheriting,
           count(*) FILTER (WHERE availability_rules IS NOT NULL) AS own_hours
      FROM slotlock.resources
     WHERE tenant_ref = ${params.tenantRef} AND archived_at IS NULL AND location_ref IS NOT NULL
       AND ${params.location} = ANY (slotlock.location_path(tenant_ref, location_ref))`;
  return { inheriting: Number(counted?.inheriting ?? 0), ownHours: Number(counted?.own_hours ?? 0) };
}

export async function getAvailabilityDefaults(
  sql: StoreSql,
  params: { tenantRef: string },
): Promise<SlotlockAvailabilityDefaults> {
  const rows = await sql<{ location_ref: string | null; rules: unknown }[]>`
    SELECT location_ref, rules FROM slotlock.availability_defaults
     WHERE tenant_ref = ${params.tenantRef}
     ORDER BY location_ref NULLS FIRST`;
  const tenant = rows.find((row) => row.location_ref === null);
  return {
    tenant: tenant ? storedRules(tenant.rules) : null,
    locations: rows
      .filter((row): row is { location_ref: string; rules: unknown } => row.location_ref !== null)
      .map((row) => ({ location: row.location_ref, rules: storedRules(row.rules) })),
  };
}

type ExceptionRow = {
  id: string;
  tenant_ref: string;
  location_ref: string | null;
  resource_id: string | null;
  starts_on: string;
  ends_on: string;
  outcome: SlotlockExceptionOutcome;
  hours: unknown;
  label: string;
  source: SlotlockExceptionSource;
  source_uid: string | null;
  calendar_id: string | null;
  created_at: Date;
};

const EXCEPTION_COLUMNS = `id, tenant_ref, location_ref, resource_id,
  to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
  outcome, hours, label, source, source_uid, calendar_id, created_at`;

function toException(row: ExceptionRow): SlotlockAvailabilityException {
  return {
    id: row.id,
    tenantRef: row.tenant_ref,
    ...(row.location_ref !== null ? { location: row.location_ref } : {}),
    ...(row.resource_id !== null ? { resourceId: row.resource_id } : {}),
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    outcome: row.outcome,
    ...(row.outcome === 'open' ? { hours: storedExceptionWindows(row.hours) } : {}),
    label: row.label,
    source: row.source,
    ...(row.source_uid !== null ? { sourceUid: row.source_uid } : {}),
    ...(row.calendar_id !== null ? { calendarId: row.calendar_id } : {}),
    createdAt: row.created_at,
  };
}

/**
 * Add an exception, or, for an import's `sourceUid` already stored at that scope, update it.
 * Refuses `invalid_availability_exception`, `location_not_found`, `resource_not_found` and
 * `availability_exceptions_limit_reached` (SLOTLOCK_MAX_AVAILABILITY_EXCEPTIONS a tenant).
 */
export async function createAvailabilityException(
  sql: StoreSql,
  input: SlotlockAvailabilityExceptionInput,
): Promise<SlotlockAvailabilityException> {
  const days = parseExceptionDays({
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    outcome: input.outcome,
    hours: input.hours,
  });
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (label.length < 1 || [...label].length > MAX_LABEL) {
    throw invalidException(`The label must be 1-${MAX_LABEL} characters`);
  }
  if (input.location !== undefined && input.resourceId !== undefined) {
    throw invalidException('An exception is for a location or a resource, not both');
  }
  const source = input.source ?? 'manual';
  if (!['manual', 'ics', 'vavailability'].includes(source)) throw invalidException('Unknown source');
  if (
    input.sourceUid !== undefined &&
    (typeof input.sourceUid !== 'string' ||
      input.sourceUid.length === 0 ||
      Buffer.byteLength(input.sourceUid) > MAX_SOURCE_UID_BYTES)
  ) {
    throw invalidException(`A source id is 1-${MAX_SOURCE_UID_BYTES} bytes`);
  }
  if (input.location !== undefined) {
    const [place] = LOCATION_REF.test(input.location)
      ? await sql<{ ref: string }[]>`
          SELECT ref FROM slotlock.locations
           WHERE tenant_ref = ${input.tenantRef} AND ref = ${input.location} FOR KEY SHARE`
      : [];
    if (!place) throw notFound('location_not_found', 'Slotlock has no such location');
  }
  if (input.resourceId !== undefined) {
    const [resource] = UUID.test(input.resourceId)
      ? await sql<{ id: string }[]>`
          SELECT id FROM slotlock.resources
           WHERE tenant_ref = ${input.tenantRef} AND id = ${input.resourceId}::uuid FOR KEY SHARE`
      : [];
    if (!resource) throw notFound('resource_not_found', 'Slotlock has no such resource');
  }
  const hours = days.hours ? sql.json(days.hours.map((window) => ({ ...window })) as never) : null;
  const location = input.location ?? null;
  const resourceId = input.resourceId ?? null;
  const sourceUid = input.sourceUid ?? null;
  const calendarId = input.calendarId ?? null;
  const rows = await sql<ExceptionRow[]>`
    INSERT INTO slotlock.availability_exceptions (
      tenant_ref, location_ref, resource_id, starts_on, ends_on, outcome, hours, label, source, source_uid,
      calendar_id
    )
    SELECT ${input.tenantRef}, ${location}, ${resourceId}::uuid, ${days.startsOn}::date, ${days.endsOn}::date,
           ${days.outcome}, ${hours}::jsonb, ${label}, ${source}, ${sourceUid}, ${calendarId}::uuid
     WHERE (SELECT count(*) FROM slotlock.availability_exceptions WHERE tenant_ref = ${input.tenantRef})
             < ${SLOTLOCK_MAX_AVAILABILITY_EXCEPTIONS}
        OR (${sourceUid}::text IS NOT NULL AND EXISTS (
              SELECT 1 FROM slotlock.availability_exceptions
               WHERE tenant_ref = ${input.tenantRef}
                 AND COALESCE(location_ref, '') = COALESCE(${location}::text, '')
                 AND COALESCE(resource_id::text, '') = COALESCE(${resourceId}::text, '')
                 AND source_uid = ${sourceUid}))
    ON CONFLICT (tenant_ref, (COALESCE(location_ref, '')), (COALESCE(resource_id::text, '')), source_uid)
      WHERE source_uid IS NOT NULL
    DO UPDATE SET starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on, outcome = EXCLUDED.outcome,
                  hours = EXCLUDED.hours, label = EXCLUDED.label, source = EXCLUDED.source,
                  calendar_id = EXCLUDED.calendar_id
    RETURNING ${sql.unsafe(EXCEPTION_COLUMNS)}`;
  const row = rows[0];
  if (!row) {
    throw Object.assign(
      new Error(`Slotlock keeps at most ${SLOTLOCK_MAX_AVAILABILITY_EXCEPTIONS} availability exceptions a tenant`),
      { code: 'availability_exceptions_limit_reached' as const },
    );
  }
  return toException(row);
}

/**
 * The tenant's exceptions by first day: those that apply to `resourceId` (the tenant's, its
 * locations' and its own), or one `location`'s own, or all of them; only those reaching `from` to
 * `to` when given. Keyset-paginated by `after` (the last one's id).
 */
export async function listAvailabilityExceptions(
  sql: StoreSql,
  params: {
    tenantRef: string;
    resourceId?: string;
    location?: string;
    from?: string;
    to?: string;
    limit?: number;
    after?: string;
  },
): Promise<SlotlockAvailabilityException[]> {
  const limit = params.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST) {
    throw invalidException(`The limit must be 1-${MAX_LIST}`);
  }
  for (const day of [params.from, params.to]) {
    if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw invalidException('Dates must be YYYY-MM-DD');
  }
  if (params.resourceId !== undefined && !UUID.test(params.resourceId)) return [];
  if (params.location !== undefined && !LOCATION_REF.test(params.location)) return [];
  if (params.after !== undefined && !UUID.test(params.after)) throw invalidException('The cursor is not an id');
  const resourceId = params.resourceId ?? null;
  const location = params.location ?? null;
  const rows = await sql<ExceptionRow[]>`
    WITH cursor AS (
      SELECT starts_on, id FROM slotlock.availability_exceptions
       WHERE tenant_ref = ${params.tenantRef} AND id = ${params.after ?? null}::uuid
    ), target AS (
      SELECT resource.id, CASE WHEN resource.location_ref IS NULL THEN '{}'::text[]
                               ELSE slotlock.location_path(resource.tenant_ref, resource.location_ref) END AS refs
        FROM slotlock.resources resource
       WHERE resource.tenant_ref = ${params.tenantRef} AND resource.id = ${resourceId}::uuid
    )
    SELECT ${sql.unsafe(EXCEPTION_COLUMNS)} FROM slotlock.availability_exceptions exception
     WHERE exception.tenant_ref = ${params.tenantRef}
       AND (${resourceId}::uuid IS NULL OR EXISTS (
             SELECT 1 FROM target
              WHERE exception.resource_id = target.id
                 OR (exception.resource_id IS NULL AND exception.location_ref IS NULL)
                 OR exception.location_ref = ANY (target.refs)))
       AND (${location}::text IS NULL OR exception.location_ref = ${location})
       AND (${params.from ?? null}::date IS NULL OR exception.ends_on >= ${params.from ?? null}::date)
       AND (${params.to ?? null}::date IS NULL OR exception.starts_on <= ${params.to ?? null}::date)
       AND (${params.after ?? null}::uuid IS NULL
            OR EXISTS (SELECT 1 FROM cursor
                        WHERE (exception.starts_on, exception.id) > (cursor.starts_on, cursor.id)))
     ORDER BY exception.starts_on, exception.id
     LIMIT ${limit}`;
  return rows.map(toException);
}

export async function deleteAvailabilityException(
  sql: StoreSql,
  params: { tenantRef: string; id: string },
): Promise<boolean> {
  if (!UUID.test(params.id)) return false;
  const rows = await sql`
    DELETE FROM slotlock.availability_exceptions
     WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}::uuid
    RETURNING id`;
  return rows.length > 0;
}

/**
 * Each resource's exceptions that reach local days from `from` to `to` (`YYYY-MM-DD`), ranked as the
 * evaluator applies them: the tenant's (0), each location's from the outermost in, the resource's
 * own (1000).
 */
export async function rankedExceptions(
  sql: StoreSql,
  resourceIds: readonly string[],
  days: { from: string; to?: string },
): Promise<Map<string, SlotlockRankedException[]>> {
  const found = new Map<string, SlotlockRankedException[]>();
  const ids = resourceIds.filter((id) => UUID.test(id));
  if (ids.length === 0) return found;
  const rows = await sql<
    { resource_id: string; starts_on: string; ends_on: string; outcome: SlotlockExceptionOutcome; hours: unknown; rank: number }[]
  >`
    SELECT resource.id::text AS resource_id,
           to_char(exception.starts_on, 'YYYY-MM-DD') AS starts_on,
           to_char(exception.ends_on, 'YYYY-MM-DD') AS ends_on,
           exception.outcome, exception.hours,
           CASE WHEN exception.resource_id IS NOT NULL THEN 1000
                WHEN exception.location_ref IS NOT NULL
                  THEN 1000 - array_position(path.refs, exception.location_ref)
                ELSE 0 END AS rank
      FROM slotlock.resources resource
      CROSS JOIN LATERAL (
        SELECT CASE WHEN resource.location_ref IS NULL THEN '{}'::text[]
                    ELSE slotlock.location_path(resource.tenant_ref, resource.location_ref) END AS refs
      ) path
      JOIN slotlock.availability_exceptions exception
        ON exception.tenant_ref = resource.tenant_ref
       AND (exception.resource_id = resource.id
            OR (exception.resource_id IS NULL AND exception.location_ref IS NULL)
            OR exception.location_ref = ANY (path.refs))
     WHERE resource.id = ANY (${ids}::uuid[])
       AND exception.ends_on >= ${days.from}::date
       AND (${days.to ?? null}::date IS NULL OR exception.starts_on <= ${days.to ?? null}::date)
     ORDER BY resource.id, rank, exception.created_at, exception.id`;
  for (const row of rows) {
    const ranked: SlotlockRankedException = {
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      outcome: row.outcome,
      rank: Number(row.rank),
      ...(row.outcome === 'open' ? { hours: storedExceptionWindows(row.hours) } : {}),
    };
    found.set(row.resource_id, [...(found.get(row.resource_id) ?? []), ranked]);
  }
  return found;
}

/**
 * Replace the exceptions an import of one resource's VAVAILABILITY made with `ranges`. Refuses as
 * createAvailabilityException does.
 */
export async function replaceImportedExceptions(
  sql: StoreSql,
  params: {
    tenantRef: string;
    resourceId: string;
    ranges: readonly { startsOn: string; endsOn: string; outcome: SlotlockExceptionOutcome; hours?: SlotlockExceptionWindow[] }[];
  },
): Promise<number> {
  if (!UUID.test(params.resourceId)) throw notFound('resource_not_found', 'Slotlock has no such resource');
  await sql`
    DELETE FROM slotlock.availability_exceptions
     WHERE tenant_ref = ${params.tenantRef} AND resource_id = ${params.resourceId}::uuid
       AND source = 'vavailability'`;
  for (const range of params.ranges) {
    await createAvailabilityException(sql, {
      tenantRef: params.tenantRef,
      resourceId: params.resourceId,
      startsOn: range.startsOn,
      endsOn: range.endsOn,
      outcome: range.outcome,
      ...(range.hours ? { hours: range.hours } : {}),
      label: range.outcome === 'closed' ? 'Closed (imported hours)' : 'Special hours (imported hours)',
      source: 'vavailability',
      sourceUid: `vavailability:${range.startsOn}`,
    });
  }
  return params.ranges.length;
}

/** A holiday calendar imported into closures (RFC 0004 B1): a pasted or uploaded one, or a subscription. */
export interface SlotlockHolidayCalendar {
  id: string;
  /** Unique at its scope: importing under the same name replaces what that calendar said. */
  name: string;
  location?: string;
  resourceId?: string;
  /** A subscription's https URL, imported again by maintenance by `nextImportAt`. */
  url?: string;
  importedAt?: Date;
  nextImportAt?: Date;
  /** Why the last import of a subscription failed; cleared by the next that works. */
  lastError?: string;
  /** Its closures. */
  closures: number;
  createdAt: Date;
}

/** What one import of a holiday calendar did. */
export interface SlotlockHolidayImport {
  calendar: SlotlockHolidayCalendar;
  /** Holidays added or updated. */
  imported: number;
  /** Closures this calendar made that it no longer names in the import's span, deleted. */
  removed: number;
}

/** How long a subscription waits between imports, and after a failed one. */
export const SLOTLOCK_HOLIDAY_REIMPORT_DAYS = 30;
export const SLOTLOCK_HOLIDAY_RETRY_HOURS = 24;
/** Holiday calendars a tenant may keep. */
export const SLOTLOCK_MAX_HOLIDAY_CALENDARS = 50;

type HolidayCalendarRow = {
  id: string;
  name: string;
  location_ref: string | null;
  resource_id: string | null;
  url: string | null;
  imported_at: Date | null;
  next_import_at: Date | null;
  last_error: string | null;
  closures: number;
  created_at: Date;
};

const HOLIDAY_CALENDAR_COLUMNS = `calendar.id, calendar.name, calendar.location_ref, calendar.resource_id,
  calendar.url, calendar.imported_at, calendar.next_import_at, calendar.last_error, calendar.created_at,
  (SELECT count(*)::int FROM slotlock.availability_exceptions closure
    WHERE closure.calendar_id = calendar.id AND closure.tenant_ref = calendar.tenant_ref) AS closures`;

function toHolidayCalendar(row: HolidayCalendarRow): SlotlockHolidayCalendar {
  return {
    id: row.id,
    name: row.name,
    ...(row.location_ref !== null ? { location: row.location_ref } : {}),
    ...(row.resource_id !== null ? { resourceId: row.resource_id } : {}),
    ...(row.url !== null ? { url: row.url } : {}),
    ...(row.imported_at !== null ? { importedAt: row.imported_at } : {}),
    ...(row.next_import_at !== null ? { nextImportAt: row.next_import_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    closures: Number(row.closures),
    createdAt: row.created_at,
  };
}

/** A calendar's name: 1-200 characters, spaces folded. */
function calendarName(value: string): string {
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length < 1 || [...name].length > MAX_LABEL) {
    throw Object.assign(new Error(`A holiday calendar's name is 1-${MAX_LABEL} characters`), {
      code: 'invalid_holiday_calendar' as const,
    });
  }
  return name;
}

/** A subscription's URL: https, no credentials, at most 2,048 bytes. */
function calendarUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Object.assign(new Error('The calendar URL is not a URL'), { code: 'invalid_holiday_calendar' as const });
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || Buffer.byteLength(parsed.href) > 2_048) {
    throw Object.assign(new Error('The calendar URL must be https, without credentials, at most 2,048 bytes'), {
      code: 'invalid_holiday_calendar' as const,
    });
  }
  return parsed.href;
}

/**
 * Import a holiday calendar's days off as closures at its scope (the tenant, a location or a
 * resource), as the calendar named `name` there: each holiday added or updated by its UID, then
 * the closures this calendar made earlier that it no longer names between `span.from` and
 * `span.to` deleted, so a holiday it dropped goes too. A closure imported before calendars were
 * kept, with the UID of one it names, becomes this calendar's. With `url`, the calendar is a
 * subscription maintenance imports again every SLOTLOCK_HOLIDAY_REIMPORT_DAYS; without, it stops
 * being one. Refuses `invalid_holiday_calendar`, `location_not_found`, `resource_not_found`,
 * `holiday_calendars_limit_reached` and `availability_exceptions_limit_reached`.
 */
export async function importHolidayCalendar(
  sql: StoreSql,
  params: {
    tenantRef: string;
    location?: string;
    resourceId?: string;
    name: string;
    url?: string;
    holidays: readonly SlotlockHoliday[];
    span: { from: string; to: string };
  },
): Promise<SlotlockHolidayImport> {
  if (params.location !== undefined && params.resourceId !== undefined) {
    throw invalidException('A holiday calendar is for a location or a resource, not both');
  }
  const name = calendarName(params.name);
  const url = params.url === undefined ? null : calendarUrl(params.url);
  if (params.location !== undefined) {
    const [place] = LOCATION_REF.test(params.location)
      ? await sql<{ ref: string }[]>`
          SELECT ref FROM slotlock.locations
           WHERE tenant_ref = ${params.tenantRef} AND ref = ${params.location} FOR KEY SHARE`
      : [];
    if (!place) throw notFound('location_not_found', 'Slotlock has no such location');
  }
  if (params.resourceId !== undefined) {
    const [resource] = UUID.test(params.resourceId)
      ? await sql<{ id: string }[]>`
          SELECT id FROM slotlock.resources
           WHERE tenant_ref = ${params.tenantRef} AND id = ${params.resourceId}::uuid FOR KEY SHARE`
      : [];
    if (!resource) throw notFound('resource_not_found', 'Slotlock has no such resource');
  }
  const location = params.location ?? null;
  const resourceId = params.resourceId ?? null;
  const [calendar] = await sql<{ id: string }[]>`
    INSERT INTO slotlock.holiday_calendars (tenant_ref, location_ref, resource_id, name, url, imported_at, next_import_at)
    SELECT ${params.tenantRef}, ${location}, ${resourceId}::uuid, ${name}, ${url}, statement_timestamp(),
           CASE WHEN ${url}::text IS NULL THEN NULL
                ELSE statement_timestamp() + make_interval(days => ${SLOTLOCK_HOLIDAY_REIMPORT_DAYS}) END
     WHERE (SELECT count(*) FROM slotlock.holiday_calendars WHERE tenant_ref = ${params.tenantRef})
             < ${SLOTLOCK_MAX_HOLIDAY_CALENDARS}
        OR EXISTS (
             SELECT 1 FROM slotlock.holiday_calendars
              WHERE tenant_ref = ${params.tenantRef}
                AND COALESCE(location_ref, '') = COALESCE(${location}::text, '')
                AND COALESCE(resource_id::text, '') = COALESCE(${resourceId}::text, '')
                AND name = ${name})
    ON CONFLICT (tenant_ref, (COALESCE(location_ref, '')), (COALESCE(resource_id::text, '')), name)
    DO UPDATE SET url = EXCLUDED.url, imported_at = EXCLUDED.imported_at,
                  next_import_at = EXCLUDED.next_import_at, last_error = NULL
    RETURNING id`;
  if (!calendar) {
    throw Object.assign(new Error(`Slotlock keeps at most ${SLOTLOCK_MAX_HOLIDAY_CALENDARS} holiday calendars a tenant`), {
      code: 'holiday_calendars_limit_reached' as const,
    });
  }
  const uids: string[] = [];
  for (const holiday of params.holidays) {
    const sourceUid = `ics:${holiday.uid}`;
    uids.push(sourceUid);
    await createAvailabilityException(sql, {
      tenantRef: params.tenantRef,
      ...(params.location !== undefined ? { location: params.location } : {}),
      ...(params.resourceId !== undefined ? { resourceId: params.resourceId } : {}),
      startsOn: holiday.startsOn,
      endsOn: holiday.endsOn,
      outcome: 'closed',
      label: holiday.label,
      source: 'ics',
      sourceUid,
      calendarId: calendar.id,
    });
  }
  // What this calendar said before and no longer says, in the span it was read for.
  const removed = await sql`
    DELETE FROM slotlock.availability_exceptions
     WHERE tenant_ref = ${params.tenantRef} AND calendar_id = ${calendar.id}::uuid
       AND ends_on >= ${params.span.from}::date AND starts_on <= ${params.span.to}::date
       AND NOT (source_uid = ANY(${uids}::text[]))`;
  const [row] = await sql<HolidayCalendarRow[]>`
    SELECT ${sql.unsafe(HOLIDAY_CALENDAR_COLUMNS)} FROM slotlock.holiday_calendars calendar
     WHERE calendar.tenant_ref = ${params.tenantRef} AND calendar.id = ${calendar.id}::uuid`;
  return { calendar: toHolidayCalendar(row as HolidayCalendarRow), imported: params.holidays.length, removed: removed.count };
}

/** The tenant's holiday calendars, by scope and name. */
export async function listHolidayCalendars(sql: StoreSql, params: { tenantRef: string }): Promise<SlotlockHolidayCalendar[]> {
  const rows = await sql<HolidayCalendarRow[]>`
    SELECT ${sql.unsafe(HOLIDAY_CALENDAR_COLUMNS)} FROM slotlock.holiday_calendars calendar
     WHERE calendar.tenant_ref = ${params.tenantRef}
     ORDER BY calendar.location_ref NULLS FIRST, calendar.resource_id NULLS FIRST, calendar.name
     LIMIT ${SLOTLOCK_MAX_HOLIDAY_CALENDARS}`;
  return rows.map(toHolidayCalendar);
}

/** Delete a holiday calendar and its closures. Null for one the tenant does not have. */
export async function deleteHolidayCalendar(
  sql: StoreSql,
  params: { tenantRef: string; id: string },
): Promise<{ closures: number } | null> {
  if (!UUID.test(params.id)) return null;
  const [found] = await sql<{ closures: number }[]>`
    SELECT (SELECT count(*)::int FROM slotlock.availability_exceptions
             WHERE tenant_ref = ${params.tenantRef} AND calendar_id = ${params.id}::uuid) AS closures
      FROM slotlock.holiday_calendars
     WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}::uuid
       FOR UPDATE`;
  if (!found) return null;
  // Its closures go with it (ON DELETE CASCADE).
  await sql`DELETE FROM slotlock.holiday_calendars WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}::uuid`;
  return { closures: Number(found.closures) };
}

/** Subscriptions due to be imported again, the longest waiting first. */
export async function dueHolidayCalendars(
  sql: StoreSql,
  params: { tenantRef: string; limit: number },
): Promise<SlotlockHolidayCalendar[]> {
  // Each is put off as a failure would put it off before it is read, so a pass that never finishes
  // one (a process stopped on it) does not try it again at once, and two passes do not both read it.
  // Importing it sets its next import; a failure says why.
  const rows = await sql<HolidayCalendarRow[]>`
    UPDATE slotlock.holiday_calendars calendar
       SET next_import_at = statement_timestamp() + make_interval(hours => ${SLOTLOCK_HOLIDAY_RETRY_HOURS})
     WHERE calendar.id IN (
             SELECT id FROM slotlock.holiday_calendars
              WHERE tenant_ref = ${params.tenantRef} AND next_import_at <= statement_timestamp()
              ORDER BY next_import_at, id
              LIMIT ${params.limit}
              FOR UPDATE SKIP LOCKED)
    RETURNING ${sql.unsafe(HOLIDAY_CALENDAR_COLUMNS)}`;
  return rows.map(toHolidayCalendar).sort((left, right) => left.id.localeCompare(right.id));
}

/** Note why a subscription's import failed, and try again in SLOTLOCK_HOLIDAY_RETRY_HOURS. */
export async function noteHolidayCalendarFailure(
  sql: StoreSql,
  params: { tenantRef: string; id: string; error: string },
): Promise<void> {
  if (!UUID.test(params.id)) return;
  const error = [...params.error.replace(/\s+/g, ' ').trim()].slice(0, 500).join('') || 'The import failed';
  await sql`
    UPDATE slotlock.holiday_calendars
       SET last_error = ${error},
           next_import_at = statement_timestamp() + make_interval(hours => ${SLOTLOCK_HOLIDAY_RETRY_HOURS})
     WHERE tenant_ref = ${params.tenantRef} AND id = ${params.id}::uuid AND url IS NOT NULL`;
}
