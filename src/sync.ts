import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import {
  type WallTimeChoice,
  type ZonedDateTimeFields,
  canonicalTimeZoneName,
  createTimeZoneConverter,
  utcFrame,
  wallFrameToInstant,
  ZONE_OFFSET_REACH_MS,
  type ZoneTransition,
  zonedDateTimeFields,
  zonedDateTimeToUtc,
  zonedOffsetMinutes,
  zoneOffsetChangeReads,
  zoneOffsetDay,
  zoneTransitions,
} from './timezone.js';
import type {
  CalendarAttendee,
  CalendarAttendeeRole,
  CalendarEventContent,
  CalendarEventOccurrence,
  CalendarOrganizer,
  CalendarParticipationStatus,
  CalendarRecurrence,
  CalendarRecurrenceException,
  CalendarReminder,
  TrustedICalendarEvent,
} from './types.js';

export type ExternalCalendarStatus = 'confirmed' | 'tentative' | 'cancelled';

export interface ExternalCalendarChangeInput {
  externalId: string;
  recurrenceId?: string | null;
  start?: Date | string | null;
  end?: Date | string | null;
  status?: ExternalCalendarStatus | string | null;
  transparent?: boolean;
  sequence?: number | null;
  title?: string | null;
}

/** Provider-neutral, content-minimised change consumed by every Slotlock sync adapter. */
export interface ExternalCalendarChange {
  externalId: string;
  recurrenceId?: string;
  start: Date | null;
  end: Date | null;
  deleted: boolean;
  busy: boolean;
  revision: number;
}

export interface ICalendarEvent extends Omit<CalendarEventContent, 'timezone' | 'status'> {
  uid: string;
  timezone?: string;
  sequence?: number;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  updatedAt?: Date;
}

export type ITipMethod = 'PUBLISH' | 'REQUEST' | 'REPLY' | 'CANCEL';

export interface ICalendarExpansionWindow {
  start: Date;
  end: Date;
}

/** The most text one feed may be, in UTF-8 bytes. */
export const MAX_ICAL_INPUT_BYTES = 2_000_000;
const MAX_ICAL_OCCURRENCES = 2_000;
const MAX_ICAL_COMPONENTS = 2_000;
const MAX_ICAL_EXCEPTIONS_PER_SERIES = 1_000;
const MAX_ICAL_WORK = 4_000;
// Up to SLOTLOCK_MATERIALIZATION_WINDOW_DAYS: a 367-day search from any moment of the day, plus the
// day before.
const MAX_ICAL_WINDOW_MS = 369 * 24 * 60 * 60 * 1000;
/**
 * A feed's own VTIMEZONEs, their observances, and the RDATE values those list. ical.js re-expands
 * every observance whenever it reads a later year and scans them all for each unknown TZID, so
 * large counts exhaust memory and time.
 */
const MAX_ICAL_TIMEZONES = 100;
/**
 * The name and parameters of one property, before its value. ical.js searches from each parameter
 * to the end of the line, so cost is quadratic in the parameter count.
 */
const MAX_ICAL_PROPERTY_HEAD_BYTES = 8_192;
const MAX_ICAL_PROPERTY_PARAMETERS = 100;
const MAX_ICAL_TIMEZONE_OBSERVANCES = 1_000;
const MAX_ICAL_TIMEZONE_DATES = 2_000;
/**
 * Work ical.js may do in one parse looking for occurrences, in steps of about a microsecond.
 * RecurIterator.next() searches a SECONDLY to WEEKLY rule one step at a time with no limit, and a
 * MONTHLY or YEARLY one gives up only when whole periods fail, so a rule that never occurs
 * (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`) would hold the process. Only this count decides, never a
 * clock, so a calendar is read or refused the same way however loaded the machine
 * (ICAL_STEP_CHARGES).
 */
const MAX_ICAL_STEPS = 500_000;

/** How much one parse may search, in steps. */
interface ExpansionLimits {
  steps: number;
}

const FEED_LIMITS: ExpansionLimits = { steps: MAX_ICAL_STEPS };

/**
 * One event as written or asked about (expandCalendarEventOccurrences): a tenth of a feed's, so a
 * write is refused within about a tenth of a second whatever its rule, and a series written today
 * still fits when the roll searches it again from its start (it resumes from a cursor when it has
 * one).
 */
const EVENT_LIMITS: ExpansionLimits = { steps: 50_000 };

/** RDATE and EXDATE values one event may list: ical.js sorts them in as it reads them. */
const MAX_ICAL_DATES_PER_EVENT = MAX_ICAL_EXCEPTIONS_PER_SERIES;
/** RRULEs one event may list: every step of its expansion compares each one's next time. */
const MAX_ICAL_RULES_PER_EVENT = 8;
/** And a whole feed: each value is a time ical.js resolves, its zone looked up among the feed's. */
const MAX_ICAL_DATES_PER_FEED = 20 * MAX_ICAL_DATES_PER_EVENT;
/**
 * The furthest one step of a SECONDLY to WEEKLY rule may move, in days: about a century. ical.js
 * moves a day at a time inside one step (RecurIterator#increment_monthday); the days are charged
 * (ICAL_STEP_CHARGES).
 */
const MAX_ICAL_STEP_DAYS = 36_600;
const MAX_ICAL_INTERVAL: Readonly<Record<string, number>> = {
  SECONDLY: MAX_ICAL_STEP_DAYS * 86_400,
  MINUTELY: MAX_ICAL_STEP_DAYS * 1_440,
  HOURLY: MAX_ICAL_STEP_DAYS * 24,
  DAILY: MAX_ICAL_STEP_DAYS,
  WEEKLY: Math.floor(MAX_ICAL_STEP_DAYS / 7),
};
/**
 * The RecurIterator methods charged, and what each call costs in steps of about a microsecond
 * (measured on ical.js 2.2.1, with the costliest rule shapes each method serves). Every search step
 * ends in exactly one `next_second` (the coarser `next_*` methods call down to it) followed by a
 * check of the rule's parts. `ruleDayOfWeek` is charged per BYDAY value compared;
 * `increment_monthday` per day walked; `expand_year_days` and `expand_by_day` per day listed.
 * Outlook writes every zone's observances from 1601 as `BYMONTH` with one numbered `BYDAY`: about
 * 6,000 steps per zone.
 */
const ICAL_STEP_CHARGES: Readonly<Record<string, StepCharge>> = {
  next_second: { before: () => 3 },
  ruleDayOfWeek: { before: () => 1 },
  increment_monthday: {
    before: (days) => (typeof days === 'number' && days > 0 ? days / 5 : 1),
  },
  expand_year_days: {
    before: () => 3,
    after: (iterator) => listedDays((iterator as { days?: unknown }).days) / 8,
  },
  expand_by_day: { before: () => 0, after: (_iterator, days) => listedDays(days) / 2 },
};

/**
 * What Slotlock's own work on what ical.js finds costs, in the same steps: each occurrence passed;
 * each wall-time/instant conversion (half a step in an IANA zone, one and a half in a feed-defined
 * zone); and each instant Intl is asked for to read a day of an IANA zone's offsets, the first time
 * a budget reads that day.
 */
const OCCURRENCE_STEPS = 1;
/** Each further RRULE whose next time an expansion step compares, choosing among them. */
const RULE_SCAN_STEPS = 1;
const ZONE_READ_STEPS = { conversion: 0.5, ownZone: 1.5, intl: 5 } as const;
/**
 * Each change ical.js lists when it expands one of the feed's own zones (Timezone#_ensureCoverage):
 * it adjusts and sorts every one, about 0.4 µs each. The zone's rule steps are charged besides.
 */
const ZONE_CHANGE_STEPS = 0.4;

/**
 * What one RecurIterator method costs: charged before it runs from its arguments, and after from
 * the days it listed (at most a year's worth).
 */
interface StepCharge {
  before: (...args: unknown[]) => number;
  after?: (iterator: unknown, result: unknown) => number;
}

/** How many days a list holds, or a whole year's when ical.js no longer gives one. */
function listedDays(days: unknown): number {
  return Array.isArray(days) ? days.length : 366;
}

/**
 * The ical.js release whose RecurIterator/RecurExpansion state a series cursor holds; only that
 * release is known to continue it exactly, so a cursor another release wrote is ignored. A test
 * pins this to the installed package: upgrading ical.js means rechecking cursor state.
 */
export const ICAL_JS_VERSION = '2.2.1';
const SERIES_CURSOR_FORMAT = 1;
/** The most a cursor may take as JSON; a bigger one is not kept (its series is searched from the start). */
const MAX_SERIES_CURSOR_BYTES = 16_384;
/**
 * ical.js adds the series' length in wall-clock time, so a clock change can move an unmoved
 * occurrence's end by a few hours; a day covers every zone.
 */
const OCCURRENCE_END_SLACK_MS = 24 * 60 * 60 * 1000;
const BY_PARTS = new Set([
  'BYSECOND',
  'BYMINUTE',
  'BYHOUR',
  'BYDAY',
  'BYMONTHDAY',
  'BYYEARDAY',
  'BYWEEKNO',
  'BYMONTH',
  'BYSETPOS',
]);

/** A time's fields as ical.js holds them: year, month, day, hour, minute, second, a date or not. */
type CursorTime = [number, number, number, number, number, number, boolean];

/**
 * Where one expansion of a stored series stopped, as plain JSON stored beside it: ical.js's
 * iterator state just before the first occurrence the next window may need.
 */
export interface CalendarSeriesCursor {
  readonly v: typeof SERIES_CURSOR_FORMAT;
  readonly ical: string;
  /** The series' DTSTART and RRULE as ical.js read them, hashed: everything the iterator follows. */
  readonly key: string;
  /** The start, in ms, of the last occurrence the iterator had passed. */
  readonly position: number;
  readonly last: CursorTime;
  readonly complete: boolean;
  readonly iterator: {
    readonly last: CursorTime;
    readonly by_data: Readonly<Record<string, readonly (string | number)[]>>;
    readonly by_indices: Readonly<Record<string, number>>;
    readonly days: readonly number[];
    readonly days_index: number;
    readonly occurrence_number: number;
    readonly completed: boolean;
  };
}

/** One expansion of a stored series, and where the next one may resume. */
export interface CalendarSeriesExpansion {
  occurrences: CalendarEventOccurrence[];
  /** Keep this beside the series for its next expansion; `null` when there is nowhere to resume. */
  cursor: CalendarSeriesCursor | null;
  /** Whether this expansion resumed from the cursor it was given rather than the series' start. */
  resumed: boolean;
}

/** What expanding one stored series is given and leaves behind. */
interface SeriesResume {
  cursor: unknown;
  /**
   * The latest occurrence start a cursor may stand after: every occurrence up to it (moved or not)
   * ends before the window.
   */
  resumeLimitMs: number;
  left: CalendarSeriesCursor | null;
  resumed: boolean;
  /** Refuse rather than search from the start when the cursor cannot be used. */
  resumeOnly: boolean;
  /**
   * A stored series' own instants. Its text gives DTSTART's wall time and zone, which an instant in
   * a repeated hour does not survive (01:15 GMT on 25 October 2026 reads back as 01:15 BST).
   */
  stored?: { start: Date; end: Date; exceptions: CalendarRecurrenceException[] };
  /** Collect here, rather than refuse, the stored exceptions that name no occurrence. */
  unmatched?: Set<number>;
}

/** The parts of ical.js's RecurIterator a cursor keeps (the fields its `toJSON` drops included). */
interface IteratorState {
  last: ICAL.Time;
  by_data: Record<string, unknown>;
  by_indices: Record<string, number>;
  days: number[];
  days_index: number;
  occurrence_number: number;
  completed: boolean;
}

/** The parts of ical.js's RecurExpansion a cursor keeps or checks. */
interface ExpansionState {
  ruleIterators: unknown[];
  ruleDates: unknown[];
  exDates: unknown[];
  last: ICAL.Time;
  complete: boolean;
}
const MAX_EXCEPTION_BACKWARD_SHIFT_MS = MAX_ICAL_WINDOW_MS;
const MAX_TRUSTED_TEXT_BYTES = 16_384;
const MAX_TRUSTED_SUMMARY_BYTES = 4_096;
const MAX_TRUSTED_ATTENDEES = 100;
const MAX_TRUSTED_REMINDERS = 20;
const MAX_REMINDER_MINUTES = 366 * 24 * 60;

export class CalendarContractError extends Error {
  constructor(
    readonly code: 'invalid_external_identity' | 'invalid_external_interval' | 'invalid_icalendar',
  ) {
    super(code);
    this.name = 'CalendarContractError';
  }
}

/**
 * A calendar that needs more work than Slotlock does to read or expand it. Still
 * `invalid_icalendar` to callers; the horizon roll counts these and skips the series.
 */
export class CalendarExpansionLimitError extends CalendarContractError {
  constructor() {
    super('invalid_icalendar');
    this.name = 'CalendarExpansionLimitError';
  }
}

function expansionLimit(): never {
  throw new CalendarExpansionLimitError();
}

function requiredIdentity(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    Buffer.byteLength(normalized, 'utf8') > 1024 ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new CalendarContractError('invalid_external_identity');
  }
  return normalized;
}

function optionalIdentity(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredIdentity(value);
}

function instant(value: Date | string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  // Years 1-9999: what an RFC 3339 date-time can write.
  const year = parsed.getUTCFullYear();
  if (!Number.isFinite(parsed.getTime()) || year < 1 || year > 9999) {
    throw new CalendarContractError('invalid_external_interval');
  }
  return parsed;
}

/**
 * Trimmed, line breaks LF. Tab and LF are kept (ical.js escapes LF); other control characters are
 * refused: ical.js leaves a bare CR as is, and a reader splitting lines on it would see a new
 * property.
 */
function boundedText(value: string, maxBytes: number, required: boolean): string | undefined {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (
    (required && !normalized) ||
    Buffer.byteLength(normalized, 'utf8') > maxBytes ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(normalized)
  ) {
    throw new CalendarContractError('invalid_icalendar');
  }
  return normalized || undefined;
}

/**
 * An IANA name in one spelling (canonicalTimeZoneName). A UTC offset such as `+05:00` is refused:
 * RFC 5545 §3.2.19 wants a VTIMEZONE for each TZID, and an offset has no rules.
 */
function validTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > 255) {
    throw new CalendarContractError('invalid_icalendar');
  }
  try {
    return canonicalTimeZoneName(normalized);
  } catch {
    throw new CalendarContractError('invalid_icalendar');
  }
}

function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    Buffer.byteLength(normalized, 'utf8') > 320 ||
    !/^[^\s@]+@[^\s@]+$/.test(normalized)
  ) {
    throw new CalendarContractError('invalid_icalendar');
  }
  return normalized;
}

function normalizeOrganizer(input: CalendarOrganizer | undefined): CalendarOrganizer | undefined {
  if (!input) return undefined;
  const organizer: CalendarOrganizer = { email: normalizeEmail(input.email) };
  const name = input.name ? boundedText(input.name, 1_024, false) : undefined;
  if (name) organizer.name = name;
  return organizer;
}

const ATTENDEE_ROLES = new Set<CalendarAttendeeRole>([
  'chair',
  'required',
  'optional',
  'non_participant',
]);
const PARTICIPATION_STATUSES = new Set<CalendarParticipationStatus>([
  'needs_action',
  'accepted',
  'declined',
  'tentative',
  'delegated',
]);

function normalizeAttendees(input: CalendarAttendee[] | undefined): CalendarAttendee[] {
  if (!input) return [];
  if (input.length > MAX_TRUSTED_ATTENDEES) {
    throw new CalendarContractError('invalid_icalendar');
  }
  const seen = new Set<string>();
  return input.map((candidate) => {
    const email = normalizeEmail(candidate.email);
    if (seen.has(email)) throw new CalendarContractError('invalid_icalendar');
    seen.add(email);
    const attendee: CalendarAttendee = { email };
    const name = candidate.name ? boundedText(candidate.name, 1_024, false) : undefined;
    if (name) attendee.name = name;
    if (candidate.role !== undefined) {
      if (!ATTENDEE_ROLES.has(candidate.role)) {
        throw new CalendarContractError('invalid_icalendar');
      }
      attendee.role = candidate.role;
    }
    if (candidate.participationStatus !== undefined) {
      if (!PARTICIPATION_STATUSES.has(candidate.participationStatus)) {
        throw new CalendarContractError('invalid_icalendar');
      }
      attendee.participationStatus = candidate.participationStatus;
    }
    if (candidate.rsvp !== undefined) attendee.rsvp = candidate.rsvp;
    return attendee;
  });
}

function normalizeReminders(input: CalendarReminder[] | undefined): CalendarReminder[] {
  if (!input) return [];
  if (input.length > MAX_TRUSTED_REMINDERS) {
    throw new CalendarContractError('invalid_icalendar');
  }
  return input.map((candidate) => {
    if (
      (candidate.action !== 'display' && candidate.action !== 'email') ||
      !Number.isSafeInteger(candidate.minutesBeforeStart) ||
      candidate.minutesBeforeStart < 0 ||
      candidate.minutesBeforeStart > MAX_REMINDER_MINUTES
    ) {
      throw new CalendarContractError('invalid_icalendar');
    }
    return { action: candidate.action, minutesBeforeStart: candidate.minutesBeforeStart };
  });
}

function normalizeExceptions(
  input: CalendarRecurrenceException[] | undefined,
): CalendarRecurrenceException[] {
  if (!input) return [];
  if (input.length > MAX_ICAL_EXCEPTIONS_PER_SERIES) {
    throw new CalendarContractError('invalid_icalendar');
  }
  const seen = new Set<number>();
  return input.map((candidate) => {
    const recurrenceId = instant(candidate.recurrenceId);
    if (recurrenceId.getUTCMilliseconds() !== 0) {
      throw new CalendarContractError('invalid_icalendar');
    }
    if (seen.has(recurrenceId.getTime())) throw new CalendarContractError('invalid_icalendar');
    seen.add(recurrenceId.getTime());
    const cancelled = candidate.cancelled === true;
    if ((candidate.start === undefined) !== (candidate.end === undefined)) {
      throw new CalendarContractError('invalid_icalendar');
    }
    const exception: CalendarRecurrenceException = { recurrenceId };
    if (cancelled) exception.cancelled = true;
    if (candidate.start !== undefined && candidate.end !== undefined) {
      const start = instant(candidate.start);
      const end = instant(candidate.end);
      if (end <= start || start.getUTCMilliseconds() !== 0 || end.getUTCMilliseconds() !== 0) {
        throw new CalendarContractError('invalid_external_interval');
      }
      exception.start = start;
      exception.end = end;
    } else if (!cancelled) {
      throw new CalendarContractError('invalid_icalendar');
    }
    return exception;
  });
}

const WEEKDAY = '(?:SU|MO|TU|WE|TH|FR|SA)';
const list = (item: string) => new RegExp(`^${item}(?:,${item})*$`);
/** RFC 5545 §3.3.10, one pattern per rule part. */
const RECUR_RULE_PARTS: ReadonlyMap<string, RegExp> = new Map([
  ['FREQ', /^(?:SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)$/],
  ['UNTIL', /^\d{8}(?:T\d{6}Z?)?$/],
  ['COUNT', /^[1-9]\d{0,5}$/],
  ['INTERVAL', /^[1-9]\d{0,5}$/],
  ['BYSECOND', list('\\d{1,2}')],
  ['BYMINUTE', list('\\d{1,2}')],
  ['BYHOUR', list('\\d{1,2}')],
  ['BYDAY', list(`(?:[+-]?\\d{1,2})?${WEEKDAY}`)],
  ['BYMONTHDAY', list('[+-]?\\d{1,2}')],
  ['BYYEARDAY', list('[+-]?\\d{1,3}')],
  ['BYWEEKNO', list('[+-]?\\d{1,2}')],
  ['BYMONTH', list('\\d{1,2}')],
  ['BYSETPOS', list('[+-]?\\d{1,3}')],
  ['WKST', new RegExp(`^${WEEKDAY}$`)],
]);

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MIN_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** The numeric BY parts, which RFC 5545 §3.3.10 reads as sets and ical.js walks in written order. */
const NUMERIC_BY_PARTS = [
  'BYSECOND',
  'BYMINUTE',
  'BYHOUR',
  'BYMONTHDAY',
  'BYYEARDAY',
  'BYWEEKNO',
  'BYMONTH',
  'BYSETPOS',
];

/**
 * Sort and dedupe a rule's numeric BY lists. RFC 5545 §3.3.10 reads each as a set, but ical.js
 * 2.2.1 walks BYHOUR, BYMINUTE, BYSECOND and BYMONTH in written order (`FREQ=DAILY;BYHOUR=17,8`
 * gave 17:00 then an earlier 08:00).
 */
function sortRuleParts(recur: ICAL.Recur): void {
  const parts = recur.parts as Record<string, unknown[]>;
  for (const name of NUMERIC_BY_PARTS) {
    const values = parts[name];
    if (!Array.isArray(values)) continue;
    parts[name] = [...new Set(values)].sort((a, b) => Number(a) - Number(b));
  }
}

/**
 * Why ical.js 2.2.1 would expand `recur` other than RFC 5545 §3.3.10 says, or null. Each refusal is
 * a shape found wrong against a brute-force reading of the RFC (the tests' rrule-oracle):
 * - BYWEEKNO;
 * - a two-digit BYDAY ordinal (read by its last digit);
 * - BYSETPOS other than with FREQ=MONTHLY and BYDAY alone;
 * - BYMONTH with FREQ=MONTHLY;
 * - a negative BYMONTHDAY except with FREQ=MONTHLY and no BYDAY;
 * - BYMONTHDAY with FREQ=YEARLY but no BYMONTH, naming only days its months lack, or a day one can
 *   lack with COUNT or BYDAY;
 * - with FREQ=YEARLY, BYYEARDAY with BYMONTH or BYMONTHDAY, and a numbered BYDAY with BYMONTHDAY;
 * - BYHOUR with HOURLY, BYMINUTE or BYSECOND with MINUTELY, and any of the three with MONTHLY or
 *   YEARLY;
 * - FREQ=SECONDLY, which nothing Slotlock reads needs.
 */
function recurShapeProblem(recur: ICAL.Recur): string | null {
  const parts = recur.parts as Record<string, (number | string)[] | undefined>;
  const freq = recur.freq;
  if (freq === 'SECONDLY') return 'FREQ=SECONDLY';
  if (parts.BYWEEKNO) return 'BYWEEKNO';
  if (parts.BYDAY?.some((day) => /\d\d/.test(String(day)))) return 'a BYDAY ordinal of two digits';
  if (parts.BYSETPOS && !(freq === 'MONTHLY' && parts.BYDAY && !parts.BYMONTHDAY)) {
    return 'BYSETPOS other than with FREQ=MONTHLY and BYDAY';
  }
  if (freq === 'MONTHLY' && parts.BYMONTH) return 'BYMONTH with FREQ=MONTHLY';
  const monthDays = parts.BYMONTHDAY?.map(Number);
  if (monthDays?.some((day) => day < 0) && !(freq === 'MONTHLY' && !parts.BYDAY)) {
    return 'a negative BYMONTHDAY other than with FREQ=MONTHLY and no BYDAY';
  }
  if (freq === 'YEARLY' && parts.BYYEARDAY && (parts.BYMONTH || monthDays)) {
    return 'BYYEARDAY with BYMONTH or BYMONTHDAY and FREQ=YEARLY';
  }
  if (freq === 'YEARLY' && monthDays && parts.BYDAY?.some((day) => /\d/.test(String(day)))) {
    return 'a numbered BYDAY with BYMONTHDAY and FREQ=YEARLY';
  }
  if (freq === 'YEARLY' && monthDays) {
    const months = parts.BYMONTH?.map(Number);
    if (!months) return 'BYMONTHDAY with FREQ=YEARLY and no BYMONTH';
    if (!months.some((month) => monthDays.some((day) => day <= (MONTH_DAYS[month - 1] ?? 0)))) {
      return 'a BYMONTHDAY none of its BYMONTH months has';
    }
    if (
      (recur.count != null || parts.BYDAY) &&
      months.some((month) => monthDays.some((day) => day > (MIN_MONTH_DAYS[month - 1] ?? 0)))
    ) {
      return 'COUNT or BYDAY with a BYMONTHDAY one of its BYMONTH months can lack';
    }
  }
  if (freq === 'HOURLY' && parts.BYHOUR) return 'BYHOUR with FREQ=HOURLY';
  if (freq === 'MINUTELY' && (parts.BYMINUTE || parts.BYSECOND)) {
    return 'BYMINUTE or BYSECOND with FREQ=MINUTELY';
  }
  if (
    (freq === 'MONTHLY' || freq === 'YEARLY') &&
    (parts.BYHOUR || parts.BYMINUTE || parts.BYSECOND)
  ) {
    return `BYHOUR, BYMINUTE or BYSECOND with FREQ=${freq}`;
  }
  return null;
}

/**
 * Why a rule cannot be expanded from this DTSTART, or null. FREQ=YEARLY with no BYMONTHDAY, BYDAY
 * or BYYEARDAY takes DTSTART's day, and ical.js moves a missing day into the next month (29
 * February to 1 March) instead of skipping the year; yearlyDays filters those, but COUNT has
 * already counted them.
 */
function seriesShapeProblem(
  recur: ICAL.Recur,
  start: { month: number; day: number },
): string | null {
  return recur.count != null && yearlyDays(recur, start) !== null
    ? 'COUNT with a yearly DTSTART on a day one of its months can lack'
    : null;
}

/**
 * The months and days a FREQ=YEARLY rule's occurrences fall on when it names a day a month can lack
 * (29 February, 31 April), or null. ical.js 2.2.1 moves such a day into the next month where RFC
 * 5545 §3.3.10 ignores it.
 */
function yearlyDays(
  recur: ICAL.Recur,
  start: { month: number; day: number },
): { months: Set<number>; days: Set<number> } | null {
  const parts = recur.parts as Record<string, (number | string)[] | undefined>;
  if (recur.freq !== 'YEARLY' || parts.BYDAY || parts.BYYEARDAY) return null;
  const days = parts.BYMONTHDAY?.map(Number) ?? [start.day];
  const months = parts.BYMONTH?.map(Number) ?? [start.month];
  return months.some((month) => days.some((day) => day > (MIN_MONTH_DAYS[month - 1] ?? 0)))
    ? { months: new Set(months), days: new Set(days) }
    : null;
}

/**
 * Why Slotlock refuses `rule`, in words, or null when it expands it: not RFC 5545 §3.3.10 as
 * canonicalRecurrenceRule reads it, or a shape ical.js expands wrongly (recurShapeProblem).
 */
export function recurrenceRuleProblem(rule: string): string | null {
  const canonical = canonicalRecurrenceRule(rule);
  if (canonical === null) return 'not a recurrence rule as RFC 5545 writes it';
  return recurShapeProblem(ICAL.Recur.fromString(canonical));
}

/**
 * A recurrence rule in ical.js's canonical spelling, or `null`. ical.js is too lenient (it drops
 * unknown parts, lets a repeated part win, reads `COUNT=3X` as 3 and `COUNT=0` as none), so every
 * part must be RFC 5545's, appear once and match its grammar, with FREQ present, never UNTIL with
 * COUNT, and no part RFC 5545 forbids for the frequency. Numeric BY lists come back sorted
 * (sortRuleParts).
 */
export function canonicalRecurrenceRule(rule: string): string | null {
  const text = rule.trim().toUpperCase();
  if (!text || text.length > 2_000) return null;
  const parts = new Map<string, string>();
  for (const part of text.split(';')) {
    const equals = part.indexOf('=');
    const key = part.slice(0, equals);
    const value = part.slice(equals + 1);
    const pattern = RECUR_RULE_PARTS.get(key);
    if (equals <= 0 || !pattern || parts.has(key) || !pattern.test(value)) return null;
    parts.set(key, value);
  }
  const freq = parts.get('FREQ');
  if (!freq || (parts.has('UNTIL') && parts.has('COUNT'))) return null;
  if (parts.has('BYWEEKNO') && freq !== 'YEARLY') return null;
  if (parts.has('BYYEARDAY') && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return null;
  if (parts.has('BYMONTHDAY') && freq === 'WEEKLY') return null;
  const numberedDay = /\d/.test(parts.get('BYDAY') ?? '');
  if (numberedDay && (!['MONTHLY', 'YEARLY'].includes(freq) || parts.has('BYWEEKNO'))) return null;
  try {
    const recur = ICAL.Recur.fromString(text);
    sortRuleParts(recur);
    return recur.toString();
  } catch {
    return null;
  }
}

/**
 * A rule Slotlock books from an agent: valid, daily or less often, and able to occur. ical.js
 * searches sub-daily rules step by step with no limit, so one that never occurs
 * (`BYMONTH=2;BYMONTHDAY=30`) would hold the process forever.
 */
export function isBookableRecurrenceRule(rule: string): boolean {
  const canonical = canonicalRecurrenceRule(rule);
  if (canonical === null || recurrenceRuleProblem(canonical) !== null) return false;
  const parts = new Map(canonical.split(';').map((part) => part.split('=') as [string, string]));
  const freq = parts.get('FREQ') as string;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return false;
  const monthDays = parts.get('BYMONTHDAY');
  if (freq !== 'DAILY' || monthDays === undefined) return true;
  const months = (parts.get('BYMONTH') ?? '1,2,3,4,5,6,7,8,9,10,11,12').split(',').map(Number);
  const days = monthDays.split(',').map((day) => Math.abs(Number(day)));
  return months.some((month) =>
    days.some((day) => day >= 1 && day <= (MONTH_DAYS[month - 1] ?? 0)),
  );
}

/**
 * A stored series' rule: bookable for this start, in canonical spelling. A DATE UNTIL becomes the
 * UTC instant its day ends in the event's zone: RFC 5545 §3.3.10 wants a zoned DTSTART's UNTIL in
 * UTC, inclusive; midnight UTC would lose the last day east of UTC.
 */
function normalizeRecurrence(
  input: CalendarRecurrence | undefined,
  start: Date,
  timezone: string,
): CalendarRecurrence | undefined {
  if (!input) return undefined;
  const written = input.rrule.trim().toUpperCase();
  if (
    !written ||
    Buffer.byteLength(written, 'utf8') > 4_096 ||
    /[\r\n]/.test(written) ||
    !written.startsWith('FREQ=') ||
    !isBookableRecurrenceRule(written)
  ) {
    throw new CalendarContractError('invalid_icalendar');
  }
  const recur = ICAL.Recur.fromString(canonicalRecurrenceRule(written) as string);
  if (seriesShapeProblem(recur, zonedDateTimeFields(start, timezone)) !== null) {
    throw new CalendarContractError('invalid_icalendar');
  }
  if (recur.until?.isDate) {
    const { year, month, day } = recur.until;
    const nextDay = utcFrame(year, month, day + 1, 0, 0, 0, 0);
    const end = zonedDateTimeToUtc(
      {
        year: nextDay.getUTCFullYear(),
        month: nextDay.getUTCMonth() + 1,
        day: nextDay.getUTCDate(),
      },
      timezone,
    );
    recur.until = ICAL.Time.fromJSDate(new Date(end.getTime() - 1000), true);
  }
  const exceptions = normalizeExceptions(input.exceptions);
  const recurrence: CalendarRecurrence = { rrule: recur.toString() };
  if (exceptions.length > 0) recurrence.exceptions = exceptions;
  return recurrence;
}

/** Validate, clone and bound trusted event content before persistence or serialization. */
export function normalizeCalendarEventContent(input: CalendarEventContent): CalendarEventContent {
  const start = instant(input.start);
  const end = instant(input.end);
  if (end <= start) throw new CalendarContractError('invalid_external_interval');
  if (start.getUTCMilliseconds() !== 0 || end.getUTCMilliseconds() !== 0) {
    throw new CalendarContractError('invalid_icalendar');
  }
  const summary = boundedText(input.summary, MAX_TRUSTED_SUMMARY_BYTES, true);
  if (!summary) throw new CalendarContractError('invalid_icalendar');
  const normalized: CalendarEventContent = {
    start,
    end,
    timezone: validTimezone(input.timezone),
    summary,
  };
  const description = input.description
    ? boundedText(input.description, MAX_TRUSTED_TEXT_BYTES, false)
    : undefined;
  const location = input.location
    ? boundedText(input.location, MAX_TRUSTED_TEXT_BYTES, false)
    : undefined;
  if (description) normalized.description = description;
  if (location) normalized.location = location;
  const status = input.status ?? 'confirmed';
  if (status !== 'confirmed' && status !== 'tentative') {
    throw new CalendarContractError('invalid_icalendar');
  }
  normalized.status = status;
  const transparency = input.transparency ?? 'opaque';
  if (transparency !== 'opaque' && transparency !== 'transparent') {
    throw new CalendarContractError('invalid_icalendar');
  }
  normalized.transparency = transparency;
  const organizer = normalizeOrganizer(input.organizer);
  if (organizer) normalized.organizer = organizer;
  const attendees = normalizeAttendees(input.attendees);
  if (attendees.length > 0) normalized.attendees = attendees;
  const reminders = normalizeReminders(input.reminders);
  if (reminders.some((reminder) => reminder.action === 'email') && attendees.length === 0) {
    throw new CalendarContractError('invalid_icalendar');
  }
  if (reminders.length > 0) normalized.reminders = reminders;
  const recurrence = normalizeRecurrence(input.recurrence, start, normalized.timezone);
  if (recurrence) normalized.recurrence = recurrence;
  return normalized;
}

export function normalizeExternalCalendarChange(
  input: ExternalCalendarChangeInput,
): ExternalCalendarChange {
  const externalId = requiredIdentity(input.externalId);
  const recurrenceId = optionalIdentity(input.recurrenceId);
  const deleted = input.status?.toLowerCase() === 'cancelled';
  let start: Date | null = null;
  let end: Date | null = null;
  if (input.start !== null && input.start !== undefined) start = instant(input.start);
  if (input.end !== null && input.end !== undefined) end = instant(input.end);
  if ((!deleted && (!start || !end)) || (start && !end) || (!start && end)) {
    throw new CalendarContractError('invalid_external_interval');
  }
  if (start && end && end.getTime() <= start.getTime()) {
    throw new CalendarContractError('invalid_external_interval');
  }
  const revision =
    Number.isSafeInteger(input.sequence) && Number(input.sequence) >= 0
      ? Number(input.sequence)
      : 0;
  const change: ExternalCalendarChange = {
    externalId,
    start,
    end,
    deleted,
    busy: !deleted && input.transparent !== true,
    revision,
  };
  if (recurrenceId !== undefined) change.recurrenceId = recurrenceId;
  return change;
}

interface CalendarTimeValue {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  isDate: boolean;
  zone?: { tzid?: string };
  toJSDate(): Date;
}

/**
 * How one zone's wall times map to instants and back: an IANA zone through Intl, a feed-defined
 * VTIMEZONE, or UTC. Milliseconds; a wall time framed as UTC.
 */
interface ZoneReader {
  /** The instant a wall time names: in a fold and a gap as `choice` says (RFC 5545 §3.3.5 default). */
  toInstant(wallFrameMs: number, choice?: WallTimeChoice): number;
  /** The wall time an instant reads as. */
  toWall(instantMs: number): number;
  /** The IANA zone whose offsets it reads from Intl (timezone.ts keeps them a month at a time). */
  zone?: string;
}

const UTC_READER: ZoneReader = { toInstant: (wall) => wall, toWall: (instant) => instant };
const intlReaders = new Map<string, ZoneReader>();

function intlReader(timezone: string): ZoneReader {
  let reader = intlReaders.get(timezone);
  if (reader) return reader;
  const converter = createTimeZoneConverter(timezone);
  reader = {
    zone: timezone,
    toInstant: (wall, choice) => converter.wallFrameToUtc(wall, choice).getTime(),
    toWall: (instant) => {
      const fields = zonedDateTimeFields(new Date(instant), timezone);
      return utcFrame(
        fields.year,
        fields.month,
        fields.day,
        fields.hour,
        fields.minute,
        fields.second,
        0,
      ).getTime();
    },
  };
  // Feeds can name unknown zones freely, so the cache is emptied rather than grown without bound.
  if (intlReaders.size >= 256) intlReaders.clear();
  intlReaders.set(timezone, reader);
  return reader;
}

/** An observance change of a VTIMEZONE, as ical.js keeps it: when (UTC fields), and the offsets. */
interface TimezoneChange {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  utcOffset: number;
  prevUtcOffset: number;
}

/**
 * A zone only the calendar defines, read from its own observances. ical.js reads wall times in such
 * a zone with `want_daylight = false; // TODO` (timezone.js), mishandling folds and gaps; here
 * offsets come from the changes ical.js expands, and wall times are read as in any other zone
 * (wallFrameToInstant).
 */
function vtimezoneReader(zone: ICAL.Timezone): ZoneReader {
  const known = vtimezoneReaders.get(zone);
  if (known) return known;
  const coverage = zone as unknown as TimezoneCoverage & { changes: TimezoneChange[] };
  let changes: TimezoneChange[] | undefined;
  let starts: number[] = [];
  const offsetAt = (instant: number) => {
    const year = new Date(instant).getUTCFullYear();
    if (typeof coverage._ensureCoverage !== 'function') {
      throw new CalendarContractError('invalid_icalendar');
    }
    coverage._ensureCoverage(year + 1);
    if (coverage.changes !== changes) {
      changes = coverage.changes;
      starts = changes.map((change) =>
        utcFrame(
          change.year,
          change.month,
          change.day,
          change.hour,
          change.minute,
          change.second,
          0,
        ).getTime(),
      );
    }
    const list = changes;
    if (list.length === 0) return 0;
    // The last change at or before the instant; before the first, the offset it changed from.
    let low = 0;
    let high = starts.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((starts[middle] as number) <= instant) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const change = list[found === -1 ? 0 : found] as TimezoneChange;
    return (found === -1 ? change.prevUtcOffset : change.utcOffset) * 1000;
  };
  const reader: ZoneReader = {
    toInstant: (wall, choice) => wallFrameToInstant(wall, offsetAt, choice),
    toWall: (instant) => instant + offsetAt(instant),
  };
  vtimezoneReaders.set(zone, reader);
  return reader;
}

const vtimezoneReaders = new WeakMap<ICAL.Timezone, ZoneReader>();

/**
 * The zone a calendar time is read in: UTC, the IANA zone its TZID (or the calendar's zone, for a
 * floating time) names, or the calendar's own VTIMEZONE. A floating time with no calendar zone, or
 * an unknown TZID, is refused: a server has no local zone.
 */
function zoneReader(
  value: unknown,
  propertyTimezone: unknown,
  calendarTimezone: string | undefined,
): ZoneReader {
  if (!value || typeof value !== 'object' || !('toJSDate' in value)) {
    throw new CalendarContractError('invalid_icalendar');
  }
  const time = value as CalendarTimeValue;
  const zone = typeof propertyTimezone === 'string' ? propertyTimezone.trim() : '';
  const valueZone = time.zone?.tzid?.trim() ?? '';
  if (zone === 'UTC' || valueZone === 'UTC') return UTC_READER;
  const timezone = zone || calendarTimezone?.trim();
  const own = time.zone instanceof ICAL.Timezone ? time.zone : undefined;
  const defined = valueZone !== 'floating' && valueZone !== 'local' && own?.component;
  if (timezone) {
    if (isKnownTimezone(timezone)) return intlReader(timezone);
    // A compliant VTIMEZONE may use a private TZID Intl does not know.
    if (zone && valueZone === zone && defined && own) return vtimezoneReader(own);
    throw new CalendarContractError('invalid_icalendar');
  }
  if (own instanceof IntlTimezone) return intlReader(own.tzid.trim());
  if (defined && own) return vtimezoneReader(own);
  throw new CalendarContractError('invalid_icalendar');
}

/** A calendar time's wall-clock fields (a date's midnight), framed as UTC. */
function wallFrameOf(value: unknown): number {
  const time = value as CalendarTimeValue;
  return utcFrame(
    time.year,
    time.month,
    time.day,
    time.isDate ? 0 : time.hour,
    time.isDate ? 0 : time.minute,
    time.isDate ? 0 : time.second,
    0,
  ).getTime();
}

/**
 * Where a DURATION from `start` ends, RFC 5545 §3.3.6: weeks and days on the calendar first, then
 * hours, minutes and seconds elapsed. PT48H is always 48 hours; P2D may be 47 or 49.
 */
function durationEnd(
  reader: ZoneReader,
  startWall: number,
  start: number,
  duration: ICAL.Duration,
): number {
  const days = duration.weeks * 7 + duration.days;
  const ms = ((duration.hours * 60 + duration.minutes) * 60 + duration.seconds) * 1000;
  return (days > 0 ? reader.toInstant(startWall + days * 24 * 60 * 60 * 1000) : start) + ms;
}

/**
 * Every RRULE value written inside a VEVENT, as written: ical.js's parsed form has lost what it
 * misreads (`COUNT=0`, `COUNT=3X`, a second FREQ). VTIMEZONE rules are left out.
 */
function veventRuleTexts(input: string): string[] {
  const rules: string[] = [];
  const open: string[] = [];
  for (const line of unfoldedLines(input)) {
    const component = componentLine(line);
    if (component?.kind === 'begin') open.push(component.name);
    else if (component?.kind === 'end') open.pop();
    else if (open.at(-1) === 'vevent' && /^rrule[;:]/i.test(line)) {
      const { end } = icalendarPropertyHead(line, {});
      rules.push(line.slice(end + 1));
    }
  }
  return rules;
}

/**
 * The instant a calendar time names (zoneReader), per RFC 5545 §3.3.5 (first instant of a repeated
 * time, a skipped time moved forward), charged to `budget` when given. ical.js would frame a
 * floating value as a local JS date.
 */
function calendarTimeValue(
  value: unknown,
  propertyTimezone: unknown,
  calendarTimezone: string | undefined,
  budget?: RecurrenceBudget,
): Date {
  const shared = zoneReader(value, propertyTimezone, calendarTimezone);
  const reader = budget ? budget.zoneReader(shared) : shared;
  const instant = reader.toInstant(wallFrameOf(value));
  if (!Number.isFinite(instant)) throw new CalendarContractError('invalid_icalendar');
  return new Date(instant);
}

/** The TZID of a time ical.js reads in a zone (a VTIMEZONE's, an IntlTimezone, UTC); else none. */
function ownZone(value: unknown): string | undefined {
  if (!(value instanceof ICAL.Time)) return undefined;
  const tzid = value.zone?.tzid;
  return tzid && tzid !== 'floating' && tzid !== 'local' ? tzid : undefined;
}

/**
 * What one parse may spend: steps searching (ICAL_STEP_CHARGES), reading each occurrence, and
 * reading times in their zones.
 */
class RecurrenceBudget {
  private steps: number;
  /** Each zone's readers as this budget charges them, so a parse's readers stay one per zone. */
  private readonly readers = new Map<ZoneReader, ZoneReader>();
  /**
   * Which days of each IANA zone's offsets this budget has paid for: UTC day `d`'s midnight as
   * `2d`, its changes as `2d + 1` (zoneOffsetDay).
   */
  private readonly read = new Map<string, Set<number>>();

  constructor(limits: ExpansionLimits) {
    this.steps = limits.steps;
  }

  /** Charge `steps`, throwing once the parse has spent more than its limit. */
  charge(steps: number): void {
    this.steps -= steps;
    if (this.steps < 0) expansionLimit();
  }

  /** `reader`, with every conversion it makes charged here (chargeZoneRead). */
  zoneReader(reader: ZoneReader): ZoneReader {
    if (reader === UTC_READER) return reader;
    const known = this.readers.get(reader);
    if (known) return known;
    const zone = reader.zone;
    const charged: ZoneReader = {
      toInstant: (wall, choice) => {
        this.chargeZoneRead(zone, wall - ZONE_OFFSET_REACH_MS, wall + ZONE_OFFSET_REACH_MS);
        return reader.toInstant(wall, choice);
      },
      toWall: (instant) => {
        this.chargeZoneRead(zone, instant, instant);
        return reader.toWall(instant);
      },
    };
    if (zone !== undefined) charged.zone = zone;
    this.readers.set(reader, charged);
    return charged;
  }

  /**
   * Charge one conversion in `zone` reading offsets from `fromMs` to `toMs` (at most three UTC
   * days), plus the days not yet paid for. The process caches offsets, but each parse pays as if it
   * read them now, so a refusal never depends on what ran before.
   */
  chargeZoneRead(zone: string | undefined, fromMs: number, toMs: number): void {
    // No IANA zone: a feed-defined one (UTC's is never charged).
    if (zone === undefined) {
      this.charge(ZONE_READ_STEPS.ownZone);
      return;
    }
    this.charge(ZONE_READ_STEPS.conversion);
    let paid = this.read.get(zone);
    if (!paid) {
      paid = new Set();
      this.read.set(zone, paid);
    }
    const first = zoneOffsetDay(fromMs);
    const last = zoneOffsetDay(toMs);
    // Not a time: the conversion refuses it.
    if (!Number.isFinite(first) || !Number.isFinite(last)) return;
    const pay = (key: number, reads: () => number) => {
      if (paid.has(key)) return;
      paid.add(key);
      this.charge(reads() * ZONE_READ_STEPS.intl);
    };
    for (let day = first; day <= last; day++) {
      pay(2 * day, () => 1);
      pay(2 * day + 2, () => 1);
      pay(2 * day + 1, () => zoneOffsetChangeReads(zone, day));
    }
  }
}

/**
 * A RecurIterator subclass for one parse whose every step is charged to `budget` and throws past
 * it. The constructor's own scans run through these methods, so they are charged too. ical.js
 * itself is untouched; if a new ical.js drops a charged method, every recurring event is refused
 * rather than expanded unbounded.
 */
function budgetedRecurIterator(budget: RecurrenceBudget): typeof ICAL.RecurIterator {
  class BudgetedRecurIterator extends ICAL.RecurIterator {}
  const inherited = ICAL.RecurIterator.prototype as unknown as Record<string, unknown>;
  const own = BudgetedRecurIterator.prototype as unknown as Record<string, unknown>;
  for (const [name, cost] of Object.entries(ICAL_STEP_CHARGES)) {
    const step = inherited[name];
    if (typeof step !== 'function') throw new CalendarContractError('invalid_icalendar');
    own[name] = function (this: unknown, ...args: unknown[]) {
      budget.charge(cost.before(...args));
      const result = step.apply(this, args);
      if (cost.after) budget.charge(cost.after(this, result));
      return result;
    };
  }
  return BudgetedRecurIterator;
}

/**
 * Make `rule` build `Budgeted` iterators, or refuse it (not a parsed rule, or a step longer than
 * MAX_ICAL_STEP_DAYS).
 */
function budgetRule(rule: unknown, Budgeted: typeof ICAL.RecurIterator): void {
  if (!(rule instanceof ICAL.Recur)) throw new CalendarContractError('invalid_icalendar');
  const maxInterval = MAX_ICAL_INTERVAL[rule.freq];
  if (maxInterval !== undefined && rule.interval > maxInterval) expansionLimit();
  rule.iterator = (start) => new Budgeted({ rule, dtstart: start });
}

/**
 * `event.iterator()` with every rule iterator built as `Budgeted`. RecurExpansion takes its first
 * step at once, so the rules are changed before it is called; wrapping afterwards would leave that
 * step unbounded.
 */
function budgetedExpansion(
  event: ICAL.Event,
  Budgeted: typeof ICAL.RecurIterator,
  budget: RecurrenceBudget,
  start?: ICAL.Time,
): ICAL.RecurExpansion {
  for (const property of event.component.getAllProperties('rrule')) {
    budgetRule(property.getFirstValue(), Budgeted);
  }
  const expansion = event.iterator(start);
  const iterators = (expansion as unknown as { ruleIterators?: unknown }).ruleIterators;
  if (!Array.isArray(iterators) || !iterators.every((iterator) => iterator instanceof Budgeted)) {
    throw new CalendarContractError('invalid_icalendar');
  }
  return withEveryRule(expansion, budget);
}

/**
 * `expansion`, choosing among its RRULE iterators correctly: ical.js 2.2.1's
 * RecurExpansion#_nextRecurrenceIter removes the wrong iterator by index once a rule ends, losing
 * occurrences of multi-RRULE series.
 */
function withEveryRule(
  expansion: ICAL.RecurExpansion,
  budget: RecurrenceBudget,
): ICAL.RecurExpansion {
  const state = expansion as unknown as ExpansionState & { _nextRecurrenceIter?: unknown };
  if (typeof state._nextRecurrenceIter !== 'function') {
    throw new CalendarContractError('invalid_icalendar');
  }
  state._nextRecurrenceIter = () => {
    const iterators = state.ruleIterators as IteratorState[];
    if (iterators.length > 1) budget.charge((iterators.length - 1) * RULE_SCAN_STEPS);
    let chosen: IteratorState | null = null;
    for (let index = 0; index < iterators.length; ) {
      const iterator = iterators[index] as IteratorState;
      if (iterator.completed) {
        iterators.splice(index, 1);
        continue;
      }
      // The earliest next time; the first of equal ones, as ical.js chose.
      if (chosen === null || chosen.last.compare(iterator.last) > 0) chosen = iterator;
      index += 1;
    }
    return chosen;
  };
  return expansion;
}

/** Counted from the raw form: reading values would make ical.js resolve each one's zone. */
function valueCount(property: ICAL.Property): number {
  return Math.max(0, property.jCal.length - 3);
}

/** Milliseconds since 1970 of a time's own fields, ignoring its zone: within a day of the instant. */
function fieldsMs(time: ICAL.Time): number {
  return Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
}

/** The day a time's own fields name: how ical.js matches a DATE EXDATE with an occurrence. */
function dayOf(time: ICAL.Time): string {
  return `${time.year}-${time.month}-${time.day}`;
}

/**
 * Milliseconds of a DATE or DATE-TIME property's first value as written, ignoring its zone; read
 * from the raw form so no zone resolves yet.
 */
function writtenFieldsMs(property: ICAL.Property | null): number | undefined {
  const value = property?.jCal[3];
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})Z?)?$/.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  return utcFrame(
    year as number,
    month as number,
    day as number,
    hour as number,
    minute as number,
    second as number,
    0,
  ).getTime();
}

/**
 * Refuse a VEVENT ical.js would spend unbounded work reading, before any time is read: a DURATION
 * or DTEND span over MAX_ICAL_STEP_DAYS (ical.js adds spans a month at a time, Time#adjust), a
 * negative DURATION, too many RDATE/EXDATE values or RRULEs. Returns how many dates it lists, for
 * the feed's own limit. It reads times only as written, since framing reads every date value.
 */
function boundComponent(component: ICAL.Component): number {
  const maxMs = MAX_ICAL_STEP_DAYS * 24 * 60 * 60 * 1000;
  for (const property of component.getAllProperties('duration')) {
    const duration = property.getFirstValue();
    if (!(duration instanceof ICAL.Duration)) throw new CalendarContractError('invalid_icalendar');
    if (duration.isNegative || duration.toSeconds() * 1000 > maxMs) expansionLimit();
  }
  const start = writtenFieldsMs(component.getFirstProperty('dtstart'));
  const end = writtenFieldsMs(component.getFirstProperty('dtend'));
  if (start !== undefined && end !== undefined) {
    // The fields ignore zones, so allow the day they can be out by.
    if (Math.abs(end - start) > maxMs + 24 * 60 * 60 * 1000) expansionLimit();
  }
  let dates = 0;
  for (const name of ['rdate', 'exdate']) {
    for (const property of component.getAllProperties(name)) dates += valueCount(property);
  }
  if (dates > MAX_ICAL_DATES_PER_EVENT) expansionLimit();
  if (component.getAllProperties('rrule').length > MAX_ICAL_RULES_PER_EVENT) expansionLimit();
  return dates;
}

/** Bound every VEVENT of a feed, and the date values of all of them together. */
function boundComponents(components: ICAL.Component[]): void {
  let dates = 0;
  for (const component of components) {
    dates += boundComponent(component);
    if (dates > MAX_ICAL_DATES_PER_FEED) expansionLimit();
  }
}

/**
 * The feed's VEVENTs as ical.js events, each related to no exception yet. ical.js relates every
 * RECURRENCE-ID in the calendar to every series by local time whatever its UID, so the parsers
 * relate each series' exceptions themselves.
 */
function feedEvents(components: ICAL.Component[]): ICAL.Event[] {
  return components.map((component) => new ICAL.Event(component, { exceptions: [] }));
}

/** Refuse a feed whose text alone shows it is past a limit, before ical.js parses it. */
function boundInput(input: string): void {
  if (
    Buffer.byteLength(input, 'utf8') > MAX_ICAL_INPUT_BYTES ||
    (input.match(/^BEGIN:VEVENT\r?$/gim)?.length ?? 0) > MAX_ICAL_COMPONENTS
  ) {
    throw new CalendarContractError('invalid_icalendar');
  }
  if ((input.match(/^BEGIN:VTIMEZONE\r?$/gim)?.length ?? 0) > MAX_ICAL_TIMEZONES) expansionLimit();
  boundPropertyHeads(input);
}

/**
 * Refuse a property whose head runs past MAX_ICAL_PROPERTY_HEAD_BYTES or
 * MAX_ICAL_PROPERTY_PARAMETERS as ical.js will read it. ical.js re-searches from every parameter,
 * so cost is count times length; this reads each character once.
 */
function boundPropertyHeads(input: string): void {
  const limits = { parameters: MAX_ICAL_PROPERTY_PARAMETERS, end: MAX_ICAL_PROPERTY_HEAD_BYTES };
  for (const head of icalendarPropertyHeads(input, limits)) {
    // A VCARD switches ical.js to vCard 3 parameters for the rest of the feed, which this count
    // does not follow; an iCalendar feed has no place for one.
    if (head.begins === 'vcard') throw new CalendarContractError('invalid_icalendar');
    if (head.end > MAX_ICAL_PROPERTY_HEAD_BYTES || head.parameters > MAX_ICAL_PROPERTY_PARAMETERS) {
      expansionLimit();
    }
  }
}

/**
 * Each line of `input` as ical.js 2.2.1's parser takes it, with the parameters it reads there
 * (parse._eachLine, with the design set picked at the first BEGIN), and for a BEGIN line the
 * component. Stops before the first BEGIN, where ical.js throws. Does not follow a VCARD's switch
 * to vCard 3 (boundPropertyHeads refuses those). With `limits`, a line's count stops once past
 * them. Exported for the tests.
 */
export function* icalendarPropertyHeads(
  input: string,
  limits?: HeadLimits,
): Generator<{ line: string; parameters: number; end: number; begins?: string }> {
  // undefined: no BEGIN yet. null: a design set without parameters, which ical.js picks for a first
  // component named like an Object property (`constructor`); it throws on the next property line.
  let params: Record<string, { multiValue?: string } | undefined> | null | undefined;
  for (const line of unfoldedLines(input)) {
    const component = componentLine(line);
    if (params === undefined) {
      if (component?.kind !== 'begin') return;
      const { param } = (ICAL.design.getDesignSet(component.name) ?? {}) as { param?: unknown };
      params =
        typeof param === 'object' && param !== null
          ? (param as Record<string, { multiValue?: string } | undefined>)
          : null;
    }
    if (params === null) {
      if (component === undefined) return;
      const head = { line, parameters: 0, end: line.indexOf(':') };
      yield component.kind === 'begin' ? { ...head, begins: component.name } : head;
      continue;
    }
    const head = icalendarPropertyHead(line, params, limits);
    yield component?.kind === 'begin'
      ? { line, ...head, begins: component.name }
      : { line, ...head };
  }
}

/**
 * A BEGIN or END line as ical.js reads one (parse._handleContentLine): no parameter before the first
 * `:`, named `begin` or `end` in any case, with the component's name lower-cased.
 */
function componentLine(line: string): { kind: 'begin' | 'end'; name: string } | undefined {
  const valuePos = line.indexOf(':');
  const paramPos = line.indexOf(';');
  if (valuePos === -1 || (paramPos !== -1 && paramPos < valuePos)) return undefined;
  const kind = line.slice(0, valuePos).toLowerCase();
  if (kind !== 'begin' && kind !== 'end') return undefined;
  return { kind, name: line.slice(valuePos + 1).toLowerCase() };
}

/**
 * Each line as ical.js 2.2.1 unfolds it (parse._eachLine): a line break, or CR LF, followed by a
 * space or tab continues the line before it; empty lines are dropped and the last is trimmed.
 */
function* unfoldedLines(input: string): Generator<string> {
  let lastPos = input.search(/[^ \t]/);
  if (lastPos === -1) return;
  let line = '';
  let pos: number;
  do {
    pos = input.indexOf('\n', lastPos) + 1;
    let newline = pos > 1 && input[pos - 2] === '\r' ? 2 : 1;
    if (pos === 0) {
      pos = input.length;
      newline = 0;
    }
    const first = input[lastPos];
    if (first === ' ' || first === '\t') {
      line += input.slice(lastPos + 1, pos - newline);
    } else {
      if (line) yield line;
      line = input.slice(lastPos, pos - newline);
    }
    lastPos = pos;
  } while (pos !== input.length);
  line = line.trim();
  if (line.length > 0) yield line;
}

/** Where a property's head is past what a feed may hold: its parameters, and where they end. */
interface HeadLimits {
  parameters: number;
  end: number;
}

/** `text.indexOf(char, from)`, reading each character once while `from` never moves back. */
function forwardSearch(text: string, char: string): (from: number) => number {
  let asked = -1;
  let found = -1;
  return (from) => {
    if (asked === -1 || from < asked || (found !== -1 && found < from)) {
      found = text.indexOf(char, from);
    }
    asked = Math.max(from, 0);
    return found;
  };
}

/**
 * How many parameters ical.js 2.2.1 reads on one unfolded line and where it stops
 * (parse._handleContentLine, then _parseParameters, step for step): a `"` opens a quoted value only
 * right after `=`, a multi-valued parameter (MEMBER, DELEGATED-TO) continues past `","`, and `:`
 * ends the parameters only where ical.js looks for one. Stops early where ical.js throws, and past
 * `limits` if given. Exported for the tests.
 */
export function icalendarPropertyHead(
  line: string,
  params: Record<string, { multiValue?: string } | undefined>,
  limits?: HeadLimits,
): { parameters: number; end: number } {
  const paramPos = line.indexOf(';');
  const valuePos = line.indexOf(':');
  if (paramPos === -1 || (valuePos !== -1 && paramPos > valuePos)) {
    return { parameters: 0, end: valuePos === -1 ? line.length : valuePos };
  }
  const text = line.slice(paramPos);
  const equals = forwardSearch(text, '=');
  const semicolon = forwardSearch(text, ';');
  const colon = forwardSearch(text, ':');
  const quote = forwardSearch(text, '"');
  let lastParam = 0;
  let pos = 0;
  let parameters = 0;
  let end = 0;
  for (;;) {
    if (limits && (parameters > limits.parameters || paramPos + end > limits.end)) break;
    pos = equals(pos + 1);
    if (pos === -1 || pos <= lastParam + 1) break;
    const name = text.slice(lastParam + 1, pos).toLowerCase();
    parameters += 1;
    const multiValue = name in params ? params[name]?.multiValue : undefined;
    if (text[pos + 1] === '"') {
      pos = quote(pos + 2);
      if (multiValue && pos !== -1) {
        while (text[pos + 1] === multiValue && text[pos + 2] === '"') pos = quote(pos + 3);
      }
      if (pos === -1) {
        end = text.length;
        break;
      }
      end = pos;
      lastParam = semicolon(pos);
      const propValuePos = colon(pos);
      if (lastParam === -1 || (propValuePos !== -1 && lastParam > propValuePos)) break;
    } else {
      const nextPos = semicolon(pos + 1);
      const propValuePos = colon(pos + 1);
      if (propValuePos !== -1 && nextPos > propValuePos) {
        end = propValuePos;
        break;
      }
      if (nextPos === -1) {
        end = propValuePos === -1 ? text.length : propValuePos;
        break;
      }
      lastParam = nextPos;
      pos = nextPos;
      end = nextPos;
    }
  }
  return { parameters, end: paramPos + end };
}

/**
 * Give every VTIMEZONE rule a budgeted iterator before any time is read: ical.js expands a zone's
 * rules whenever it converts a time in a zone Intl does not know, so a private TZID whose rule
 * never occurs would hang the first read.
 */
function budgetTimezoneRules(
  root: ICAL.Component,
  Budgeted: () => typeof ICAL.RecurIterator,
): void {
  const zones = root.getAllSubcomponents('vtimezone');
  if (zones.length > MAX_ICAL_TIMEZONES) expansionLimit();
  let observances = 0;
  let dates = 0;
  for (const zone of zones) {
    for (const observance of zone.getAllSubcomponents()) {
      observances += 1;
      for (const property of observance.getAllProperties('rdate')) dates += valueCount(property);
    }
  }
  if (observances > MAX_ICAL_TIMEZONE_OBSERVANCES || dates > MAX_ICAL_TIMEZONE_DATES) {
    expansionLimit();
  }
  for (const zone of zones) {
    for (const observance of zone.getAllSubcomponents()) {
      for (const property of observance.getAllProperties('rrule')) {
        budgetRule(property.getFirstValue(), Budgeted());
      }
    }
  }
}

/** The parts of ical.js's Timezone the bound below reads and replaces. */
interface TimezoneCoverage {
  changes: unknown[];
  expandedUntilYear: number;
  _ensureCoverage: (year: number) => void;
  utcOffset: (time: unknown) => number;
}

/**
 * Keep one copy of each feed-defined zone's changes. Whenever ical.js reads past what it expanded,
 * it re-expands every observance from its start and appends them all, growing without bound; each
 * expansion restarts from DTSTART, so emptying the list first leaves the same changes once. Each
 * expansion is charged per change (ZONE_CHANGE_STEPS), and each offset lookup as a conversion. If
 * ical.js no longer expands zones this way, the feed is refused.
 */
function budgetTimezoneCoverage(root: ICAL.Component, budget: RecurrenceBudget): void {
  for (const component of root.getAllSubcomponents('vtimezone')) {
    const tzid = component.getFirstPropertyValue('tzid');
    if (typeof tzid !== 'string') continue;
    const zone = root.getTimeZoneByID(tzid) as unknown as TimezoneCoverage | null;
    if (!zone) continue;
    const ensure = zone._ensureCoverage;
    const offset = zone.utcOffset;
    if (typeof ensure !== 'function' || typeof offset !== 'function') {
      throw new CalendarContractError('invalid_icalendar');
    }
    zone._ensureCoverage = function (this: TimezoneCoverage, year: number) {
      if (this.changes.length > 0 && this.expandedUntilYear >= year) return;
      this.changes = [];
      ensure.call(this, year);
      budget.charge(this.changes.length * ZONE_CHANGE_STEPS);
    };
    zone.utcOffset = function (this: TimezoneCoverage, time: unknown) {
      budget.charge(ZONE_READ_STEPS.ownZone);
      return offset.call(this, time);
    };
  }
}

/**
 * An untrusted calendar parsed with a feed's bounds, for a reader outside this module.
 * @internal Holds ical.js types, which do not compile in a strict consumer, so it stays out of the
 * published declarations (tsconfig.build.json stripInternal).
 */
export interface BoundedICalendar {
  root: ICAL.Component;
  /**
   * `event.iterator()`, its construction and every later step charged to the parse's one budget
   * (a feed's): throws CalendarExpansionLimitError past it, or CalendarContractError for a rule
   * that cannot be budgeted.
   */
  expand(event: ICAL.Event): ICAL.RecurExpansion;
}

/**
 * Parse untrusted iCalendar read elsewhere (holiday calendars, src/holidays.ts) under the bounds
 * parseICalendarFeed applies, so ical.js never does unbounded work on it: property heads and
 * VTIMEZONEs counted before ical.js parses, the zones' rules budgeted and every VEVENT's spans and
 * dates bounded before any time is read, and each expansion built by `expand`. It leaves the VEVENT
 * count, and whether the root is a VCALENDAR, to the caller. Throws CalendarContractError
 * (CalendarExpansionLimitError past a limit), or what ical.js throws for text it cannot parse.
 * @internal Out of the published declarations, as BoundedICalendar is.
 */
export function parseBoundedICalendar(input: string): BoundedICalendar {
  if (Buffer.byteLength(input, 'utf8') > MAX_ICAL_INPUT_BYTES) {
    throw new CalendarContractError('invalid_icalendar');
  }
  if ((input.match(/^BEGIN:VTIMEZONE\r?$/gim)?.length ?? 0) > MAX_ICAL_TIMEZONES) expansionLimit();
  boundPropertyHeads(input);
  const budget = new RecurrenceBudget(FEED_LIMITS);
  const root = new ICAL.Component(ICAL.parse(input));
  let Budgeted: typeof ICAL.RecurIterator | undefined;
  const budgeted = () => (Budgeted ??= budgetedRecurIterator(budget));
  budgetTimezoneRules(root, budgeted);
  budgetTimezoneCoverage(root, budget);
  boundComponents(root.getAllSubcomponents('vevent'));
  return { root, expand: (event) => budgetedExpansion(event, budgeted(), budget) };
}

function cursorTime(time: ICAL.Time): CursorTime {
  return [time.year, time.month, time.day, time.hour, time.minute, time.second, time.isDate];
}

function isCursorTime(value: unknown): value is CursorTime {
  if (!Array.isArray(value) || value.length !== 7 || typeof value[6] !== 'boolean') return false;
  const [year, month, day, hour, minute, second] = value as number[];
  return (
    [year, month, day, hour, minute, second].every(Number.isSafeInteger) &&
    (year as number) >= 1 &&
    (year as number) <= 9999 &&
    (month as number) >= 1 &&
    (month as number) <= 12 &&
    (day as number) >= 1 &&
    (day as number) <= 31 &&
    (hour as number) >= 0 &&
    (hour as number) <= 23 &&
    (minute as number) >= 0 &&
    (minute as number) <= 59 &&
    (second as number) >= 0 &&
    (second as number) <= 60
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The key a cursor for this series must carry, or `null` when no cursor can serve it: anything but
 * exactly one DTSTART and one RRULE (RDATE and EXDATE move state a cursor does not keep).
 */
function seriesKey(component: ICAL.Component): string | null {
  const starts = component.getAllProperties('dtstart');
  const rules = component.getAllProperties('rrule');
  if (
    starts.length !== 1 ||
    rules.length !== 1 ||
    component.hasProperty('rdate') ||
    component.hasProperty('exdate')
  ) {
    return null;
  }
  const start = starts[0] as ICAL.Property;
  const rule = rules[0] as ICAL.Property;
  // Slotlock 0.1 compared a zoned series with its UTC UNTIL as UTC, so its cursors may be off by
  // one: such a series gets a key of its own and is searched from the start.
  const zone = start.getParameter('tzid');
  const zonedUntil =
    typeof zone === 'string' &&
    zone.trim() !== 'UTC' &&
    (rule.jCal[3] as { until?: unknown } | undefined)?.until !== undefined;
  return createHash('sha256')
    .update(
      JSON.stringify([
        SERIES_CURSOR_FORMAT,
        ICAL_JS_VERSION,
        start.toICALString(),
        rule.toICALString(),
        ...(zonedUntil ? ['zoned-until'] : []),
      ]),
    )
    .digest('hex');
}

/** `value` as a cursor this code wrote for the series `key` names, or `null`. */
function readSeriesCursor(value: unknown, key: string): CalendarSeriesCursor | null {
  if (!isRecord(value)) return null;
  if (value.v !== SERIES_CURSOR_FORMAT || value.ical !== ICAL_JS_VERSION || value.key !== key) {
    return null;
  }
  if (
    !Number.isSafeInteger(value.position) ||
    !isCursorTime(value.last) ||
    typeof value.complete !== 'boolean'
  ) {
    return null;
  }
  const iterator = value.iterator;
  if (
    !isRecord(iterator) ||
    !isCursorTime(iterator.last) ||
    typeof iterator.completed !== 'boolean'
  ) {
    return null;
  }
  const { days, days_index: daysIndex, occurrence_number: occurrence } = iterator;
  if (
    !Array.isArray(days) ||
    days.length > 400 ||
    !days.every(Number.isSafeInteger) ||
    !Number.isSafeInteger(daysIndex) ||
    (daysIndex as number) < 0 ||
    ((daysIndex as number) >= days.length && daysIndex !== 0) ||
    !Number.isSafeInteger(occurrence) ||
    (occurrence as number) < 0
  ) {
    return null;
  }
  const byData = iterator.by_data;
  if (
    !isRecord(byData) ||
    !Object.entries(byData).every(
      ([part, values]) =>
        BY_PARTS.has(part) &&
        Array.isArray(values) &&
        values.length <= 400 &&
        values.every((item) => typeof item === 'string' || Number.isSafeInteger(item)),
    )
  ) {
    return null;
  }
  const byIndices = iterator.by_indices;
  if (
    !isRecord(byIndices) ||
    !Object.entries(byIndices).every(
      ([part, index]) =>
        BY_PARTS.has(part) && Number.isSafeInteger(index) && (index as number) >= 0,
    )
  ) {
    return null;
  }
  return value as unknown as CalendarSeriesCursor;
}

/** A copy of the expansion's state: what a cursor keeps when the window needs nothing before it. */
function snapshotSeries(
  expansion: ICAL.RecurExpansion,
  key: string,
  position: number,
): CalendarSeriesCursor | null {
  const state = expansion as unknown as ExpansionState;
  if (
    state.ruleIterators.length !== 1 ||
    state.ruleDates.length !== 0 ||
    state.exDates.length !== 0
  ) {
    return null;
  }
  const iterator = state.ruleIterators[0] as IteratorState;
  return {
    v: SERIES_CURSOR_FORMAT,
    ical: ICAL_JS_VERSION,
    key,
    position,
    last: cursorTime(state.last),
    complete: state.complete === true,
    iterator: {
      last: cursorTime(iterator.last),
      by_data: Object.fromEntries(
        Object.entries(iterator.by_data).map(([part, values]) => [
          part,
          Array.isArray(values) ? [...values] : values,
        ]),
      ) as Record<string, (string | number)[]>,
      by_indices: { ...iterator.by_indices },
      days: [...iterator.days],
      days_index: iterator.days_index,
      occurrence_number: iterator.occurrence_number,
      completed: iterator.completed === true,
    },
  };
}

/**
 * A snapshot as stored, or `null`: it must survive JSON whole (an `undefined` ical.js reads with
 * `in` would resume a different search) and fit.
 */
function keptSeriesCursor(snapshot: CalendarSeriesCursor | null): CalendarSeriesCursor | null {
  if (snapshot === null) return null;
  const json = JSON.stringify(snapshot);
  if (Buffer.byteLength(json, 'utf8') > MAX_SERIES_CURSOR_BYTES) return null;
  const kept = readSeriesCursor(JSON.parse(json), snapshot.key);
  if (
    kept === null ||
    Object.keys(kept.iterator.by_data).length !== Object.keys(snapshot.iterator.by_data).length ||
    Object.keys(kept.iterator.by_indices).length !==
      Object.keys(snapshot.iterator.by_indices).length
  ) {
    return null;
  }
  return kept;
}

/**
 * The expansion as `cursor` left it: RecurExpansion and its one RecurIterator rebuilt from state
 * (`initialized`, so it does not restart from DTSTART) with this parse's rule, start, zone and
 * budget.
 */
function resumedExpansion(
  event: ICAL.Event,
  Budgeted: typeof ICAL.RecurIterator,
  budget: RecurrenceBudget,
  cursor: CalendarSeriesCursor,
): ICAL.RecurExpansion | null {
  const rule = event.component.getFirstPropertyValue('rrule') as ICAL.Recur;
  budgetRule(rule, Budgeted);
  const dtstart = event.startDate;
  // A search from the start, built as ical.js builds it (its steps charged too).
  const reference = new Budgeted({ rule, dtstart }) as unknown as IteratorState;
  if (!cursorFitsRule(cursor.iterator, reference, rule)) return null;
  const time = ([year, month, day, hour, minute, second, isDate]: CursorTime) =>
    new ICAL.Time({ year, month, day, hour, minute, second, isDate }, dtstart.zone);
  const state = cursor.iterator;
  const iterator = new Budgeted({
    rule,
    dtstart,
    initialized: true,
    by_data: JSON.parse(JSON.stringify(state.by_data)),
    by_indices: { ...state.by_indices },
    days: [...state.days],
    last: time(state.last),
    occurrence_number: state.occurrence_number,
  } as unknown as ConstructorParameters<typeof ICAL.RecurIterator>[0]);
  Object.assign(iterator, { days_index: state.days_index, completed: state.completed });
  const expansion = new ICAL.RecurExpansion({
    dtstart,
    last: time(cursor.last),
    ruleIterators: [iterator],
    ruleDateInc: 0,
    exDateInc: 0,
    complete: cursor.complete,
  } as unknown as ConstructorParameters<typeof ICAL.RecurExpansion>[0]);
  const iterators = (expansion as unknown as ExpansionState).ruleIterators;
  if (iterators.length !== 1 || !(iterators[0] instanceof Budgeted)) {
    throw new CalendarContractError('invalid_icalendar');
  }
  return withEveryRule(expansion, budget);
}

/**
 * Whether a cursor's iterator state agrees with `reference`, an iterator ical.js built for the same
 * rule and start: same BY lists, indexes within them, valid days of the year, and a count and end
 * the rule allows. Anything else did not come from this rule and is not resumed (an hour of 10^9
 * would have ical.js walk it a month at a time inside one step).
 */
function cursorFitsRule(
  state: CalendarSeriesCursor['iterator'],
  reference: IteratorState,
  rule: ICAL.Recur,
): boolean {
  const expected = reference.by_data as Record<string, unknown>;
  for (const part of new Set([...Object.keys(state.by_data), ...Object.keys(expected)])) {
    const kept = state.by_data[part];
    if (part !== 'BYMONTHDAY') {
      if (JSON.stringify(kept) !== JSON.stringify(expected[part])) return false;
    } else if ((kept === undefined) !== (expected[part] === undefined)) {
      return false;
    } else if (
      kept !== undefined &&
      (kept.length > 31 ||
        new Set(kept).size !== kept.length ||
        !kept.every(
          (day) => Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 31,
        ))
    ) {
      return false;
    }
  }
  for (const [part, index] of Object.entries(state.by_indices)) {
    const values = state.by_data[part];
    if (values === undefined ? index !== 0 : index >= Math.max(values.length, 1)) return false;
  }
  // Days of the year 1-366, or -366 to -1 for a rule with BYYEARDAY alone (ical.js
  // expand_year_days).
  if (!state.days.every((day) => Number.isInteger(day) && day !== 0 && Math.abs(day) <= 366)) {
    return false;
  }
  if (rule.count != null && state.occurrence_number > rule.count) return false;
  if (state.completed && rule.count == null && rule.until == null) return false;
  return true;
}

/**
 * An IANA zone ical.js reads through Intl, for a TZID named without a VTIMEZONE (as real feeds and
 * stored series do). Otherwise ical.js reads such a time as floating and compares it with UTC
 * values as if UTC, losing UNTIL, EXDATE and RECURRENCE-ID matches. Offsets come from Slotlock's
 * converter: a gap moves forward, a fold takes its first instant.
 */
class IntlTimezone extends ICAL.Timezone {
  private readonly zone: string;
  private readonly converter: ReturnType<typeof createTimeZoneConverter>;
  /** The parse's budget, which each offset found is charged to as any conversion is. */
  private readonly budget: RecurrenceBudget;
  /** Offsets already found, by wall time: ical.js asks again at every comparison. */
  private readonly offsets = new Map<number, number>();

  constructor(tzid: string, budget: RecurrenceBudget) {
    super({ tzid });
    // A TZID is matched as written; Slotlock reads its zone trimmed.
    this.zone = tzid.trim();
    this.converter = createTimeZoneConverter(this.zone);
    this.budget = budget;
  }

  override utcOffset(time: ICAL.Time): number {
    const wall = utcFrame(time.year, time.month, time.day, time.hour, time.minute, time.second, 0);
    const wallMs = wall.getTime();
    let offset = this.offsets.get(wallMs);
    if (offset === undefined) {
      this.budget.chargeZoneRead(
        this.zone,
        wallMs - ZONE_OFFSET_REACH_MS,
        wallMs + ZONE_OFFSET_REACH_MS,
      );
      offset = Math.round((wallMs - this.converter.wallFrameToUtc(wallMs).getTime()) / 1000);
      if (this.offsets.size >= 4_096) this.offsets.clear();
      this.offsets.set(wallMs, offset);
    }
    return offset;
  }
}

/** VEVENT properties whose times ical.js compares with one another. */
const COMPARED_TIME_PROPERTIES = ['dtstart', 'dtend', 'recurrence-id', 'rdate', 'exdate'];

/** A PERIOD RDATE value, read as its start: the end (a date-time or a duration) is kept here. */
interface RecurrencePeriod {
  property: ICAL.Property;
  start: string;
  end: string;
}

const knownTimezones = new Map<string, boolean>();

/**
 * Whether Intl reads `timezone` (trimmed) as a zone. Each check builds a formatter (~30 µs) and
 * every occurrence asks again, so answers are cached and the map emptied when full.
 */
function isKnownTimezone(timezone: string): boolean {
  const name = timezone.trim();
  if (!name || Buffer.byteLength(name, 'utf8') > 255) return false;
  const known = knownTimezones.get(name);
  if (known !== undefined) return known;
  let answer: boolean;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name }).format(0);
    answer = true;
  } catch {
    answer = false;
  }
  if (knownTimezones.size >= 256) knownTimezones.clear();
  knownTimezones.set(name, answer);
  return answer;
}

/** Wall-clock fields as a jCal DATE-TIME, `2027-01-04T09:00:00`, with a `Z` when they are UTC's. */
function jCalDateTime(fields: ZonedDateTimeFields, utc = false): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const date = `${pad(fields.year, 4)}-${pad(fields.month)}-${pad(fields.day)}`;
  const time = `${pad(fields.hour)}:${pad(fields.minute)}:${pad(fields.second)}`;
  return `${date}T${time}${utc ? 'Z' : ''}`;
}

/** The instant an ical.js time names, read in its own zone; undefined when it has none. */
function zonedInstant(time: ICAL.Time): Date | undefined {
  return ownZone(time) === undefined ? undefined : new Date(time.toUnixTime() * 1000);
}

/** `value` (a jCal date-time) as the date it falls on in `timezone`; undefined if it cannot say. */
function localDateOf(value: string, tzid: unknown, timezone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z?)$/.exec(value);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const fields = { year, month, day, hour, minute, second };
  let instant: Date;
  if (match[7] === 'Z') {
    instant = utcFrame(year, month, day, hour, minute, second, 0);
  } else if (typeof tzid === 'string' && isKnownTimezone(tzid)) {
    instant = zonedDateTimeToUtc(fields, tzid.trim());
  } else {
    return value.slice(0, 10);
  }
  return jCalDateTime(zonedDateTimeFields(instant, timezone)).slice(0, 10);
}

/**
 * Prepare a calendar's events before anything reads their times, so ical.js compares them at their
 * real instants:
 * - a floating time is framed in the calendar's zone;
 * - each zone the events name that Intl knows becomes an IntlTimezone, defined by the feed or not
 *   (undefined zones are capped at MAX_ICAL_TIMEZONES);
 * - an all-day series' UTC or zoned UNTIL, EXDATE and RECURRENCE-ID become their local dates (RFC
 *   5545 wants dates);
 * - a PERIOD RDATE becomes its start, its end kept in the returned map: ical.js mis-orders periods
 *   among times;
 * - then a timed series' own times are aligned (alignSeriesTimes).
 * Every value read here was counted by boundComponents.
 */
function frameEventTimes(
  root: ICAL.Component,
  components: ICAL.Component[],
  calendarTimezone: string | undefined,
  budget: RecurrenceBudget,
): Map<ICAL.Component, RecurrencePeriod[]> {
  const timezone =
    calendarTimezone !== undefined && isKnownTimezone(calendarTimezone)
      ? calendarTimezone
      : undefined;
  const declared = new Set(
    root.getAllSubcomponents('vtimezone').map((zone) => zone.getFirstPropertyValue('tzid')),
  );
  const named = new Set<string>();
  let undeclared = 0;
  const nameZone = (tzid: string) => {
    if (named.has(tzid)) return;
    named.add(tzid);
    if (!declared.has(tzid) && ++undeclared > MAX_ICAL_TIMEZONES) expansionLimit();
  };
  const periods = new Map<ICAL.Component, RecurrencePeriod[]>();
  const allDayMasters = new Set<string>();
  for (const component of components) {
    for (const name of COMPARED_TIME_PROPERTIES) {
      for (const property of component.getAllProperties(name)) {
        const values = property.jCal.slice(3) as unknown[];
        const starts = values.map((value) => (Array.isArray(value) ? value[0] : value));
        const tzid = property.getParameter('tzid');
        if (typeof tzid === 'string') {
          nameZone(tzid);
        } else if (
          timezone &&
          (property.type === 'date-time' || property.type === 'period') &&
          starts.some((start) => typeof start === 'string' && !start.endsWith('Z'))
        ) {
          property.setParameter('tzid', timezone);
          nameZone(timezone);
        }
        if (name === 'rdate' && property.type === 'period') {
          const kept = periods.get(component) ?? [];
          for (const value of values) {
            const [start, end] = Array.isArray(value) ? value : [];
            if (typeof start !== 'string' || typeof end !== 'string') {
              throw new CalendarContractError('invalid_icalendar');
            }
            kept.push({ property, start, end });
          }
          periods.set(component, kept);
          property.resetType('date-time');
          for (const value of values) property.jCal.push((value as string[])[0]);
        }
      }
    }
    if (
      !component.hasProperty('recurrence-id') &&
      component.getFirstProperty('dtstart')?.type === 'date'
    ) {
      const uid = component.getFirstPropertyValue('uid');
      if (typeof uid === 'string') allDayMasters.add(uid);
    }
  }
  if (timezone) {
    const toDate = (property: ICAL.Property) => {
      if (property.type !== 'date-time') return;
      const tzid = property.getParameter('tzid');
      const dates = (property.jCal.slice(3) as unknown[]).map((value) =>
        typeof value === 'string' ? localDateOf(value, tzid, timezone) : undefined,
      );
      if (dates.some((date) => date === undefined)) return;
      property.resetType('date');
      property.removeParameter('tzid');
      for (const date of dates) property.jCal.push(date as string);
    };
    for (const component of components) {
      const uid = component.getFirstPropertyValue('uid');
      if (typeof uid !== 'string' || !allDayMasters.has(uid)) continue;
      if (component.hasProperty('recurrence-id')) {
        for (const property of component.getAllProperties('recurrence-id')) toDate(property);
        continue;
      }
      for (const property of component.getAllProperties('exdate')) toDate(property);
      for (const property of component.getAllProperties('rrule')) {
        const rule = property.jCal[3] as { until?: unknown } | undefined;
        if (typeof rule?.until === 'string' && rule.until.length > 10) {
          const date = localDateOf(rule.until, undefined, timezone);
          if (date !== undefined) rule.until = date;
        }
      }
    }
  }
  const cache = (root as unknown as { _timezoneCache?: Map<string, ICAL.Timezone> })._timezoneCache;
  for (const tzid of named) {
    // A zone Intl knows is read through Intl even when the feed defines it, so ical.js and Slotlock
    // never place one time in two places (a stale VTIMEZONE's rules can differ from Intl's).
    if (ICAL.TimezoneService.has(tzid) || !isKnownTimezone(tzid)) continue;
    // ical.js keeps a calendar's zones here; without it, it could not use these.
    if (!(cache instanceof Map)) throw new CalendarContractError('invalid_icalendar');
    cache.set(tzid, new IntlTimezone(tzid, budget));
  }
  alignSeriesTimes(components);
  return periods;
}

/**
 * With every zone resolving, put what ical.js compares with a timed series' times in the terms it
 * compares them in:
 * - a floating UNTIL becomes the UTC instant it names on the series' clock (RFC 5545 §3.3.10;
 *   ical.js read it as UTC);
 * - a RECURRENCE-ID in another zone becomes the same instant in UTC, which ical.js can match; a
 *   RANGE=THISANDFUTURE one becomes the series' own wall time, since ical.js moves later
 *   occurrences by the wall-clock distance from it;
 * - a DATE EXDATE of a timed series becomes the series' start time that day, so the feed and the
 *   stored series agree;
 * - an RDATE-only series gets its DTSTART as one: it is the first instance (RFC 5545 §3.8.2.4),
 *   which ical.js left out.
 */
function alignSeriesTimes(components: ICAL.Component[]): void {
  const seriesStarts = new Map<string, { time: ICAL.Time; tzid: unknown }>();
  for (const component of components) {
    if (component.hasProperty('recurrence-id')) continue;
    const uid = component.getFirstPropertyValue('uid');
    const start = component.getFirstProperty('dtstart');
    const value = start?.jCal[3];
    if (typeof uid !== 'string' || !start || typeof value !== 'string') continue;
    if (component.hasProperty('rdate') && !component.hasProperty('rrule')) {
      const parameters = { ...(start.jCal[1] as Record<string, unknown>) };
      component.addProperty(new ICAL.Property(['rdate', parameters, start.type, value]));
    }
    if (start.type !== 'date-time') continue;
    const time = ICAL.Time.fromDateTimeString(value, start);
    if (zonedInstant(time) === undefined) continue;
    seriesStarts.set(uid, { time, tzid: start.getParameter('tzid') });
    for (const property of component.getAllProperties('exdate')) {
      const days = property.jCal.slice(3) as unknown[];
      if (property.type !== 'date' || !days.every((day) => typeof day === 'string')) continue;
      property.resetType('date-time');
      const zone = start.getParameter('tzid');
      if (typeof zone === 'string') property.setParameter('tzid', zone);
      for (const day of days) property.jCal.push(`${day as string}${value.slice(10)}`);
    }
    for (const property of component.getAllProperties('rrule')) {
      const rule = property.jCal[3] as { until?: unknown } | undefined;
      const until = rule?.until;
      if (typeof until === 'string' && until.length === 10 && rule) {
        // A DATE UNTIL on a timed series names its whole day on the series' clock: up to the
        // instant before the next day begins there.
        const next = utcFrame(
          Number(until.slice(0, 4)),
          Number(until.slice(5, 7)),
          Number(until.slice(8, 10)) + 1,
          0,
          0,
          0,
          0,
        );
        // A DTSTART in UTC keeps the series' clock in UTC.
        const midnight = value.endsWith('Z')
          ? next
          : zonedInstant(
              ICAL.Time.fromDateTimeString(jCalDateTime(zonedDateTimeFields(next, 'UTC')), start),
            );
        if (midnight !== undefined) {
          rule.until = jCalDateTime(
            zonedDateTimeFields(new Date(midnight.getTime() - 1000), 'UTC'),
            true,
          );
        }
        continue;
      }
      if (typeof until !== 'string' || until.length <= 10 || until.endsWith('Z')) continue;
      const instant = zonedInstant(ICAL.Time.fromDateTimeString(until, start));
      if (instant !== undefined && rule) {
        rule.until = jCalDateTime(zonedDateTimeFields(instant, 'UTC'), true);
      }
    }
  }
  for (const component of components) {
    const uid = component.getFirstPropertyValue('uid');
    const series = typeof uid === 'string' ? seriesStarts.get(uid) : undefined;
    if (series === undefined) continue;
    for (const property of component.getAllProperties('recurrence-id')) {
      const value = property.jCal[3];
      if (property.type !== 'date-time' || typeof value !== 'string') continue;
      // In the series' own zone it is matched by its wall time as is.
      if (typeof series.tzid === 'string' && property.getParameter('tzid') === series.tzid)
        continue;
      const time = ICAL.Time.fromDateTimeString(value, property);
      const instant = zonedInstant(time);
      if (instant === undefined) continue;
      const seriesZone = series.time.zone as ICAL.Timezone;
      const zone =
        property.getParameter('range') === undefined ? ICAL.Timezone.utcTimezone : seriesZone;
      if (time.zone?.tzid === zone.tzid) continue;
      let written: string;
      if (zone.tzid === 'UTC') {
        written = jCalDateTime(zonedDateTimeFields(instant, 'UTC'), true);
      } else if (zone instanceof IntlTimezone) {
        written = jCalDateTime(zonedDateTimeFields(instant, zone.tzid.trim()));
      } else {
        // A zone the calendar defines is ical.js's to read.
        written = time.convertToZone(zone).toString();
      }
      property.resetType('date-time');
      if (zone.tzid === 'UTC') property.removeParameter('tzid');
      else property.setParameter('tzid', series.tzid as string);
      property.jCal.push(written);
    }
  }
}

/**
 * Parse VEVENTs with the standards library; event content is deliberately discarded. All or
 * nothing: a series Slotlock cannot read refuses the whole calendar, so a caller reading the result
 * as busy time never takes its time as free. parseICalendarFeed keeps the rest of the calendar
 * instead.
 */
export function parseICalendarChanges(
  input: string,
  calendarTimezone?: string,
  expansionWindow?: ICalendarExpansionWindow,
): ExternalCalendarChange[] {
  return parseCalendarChanges(input, calendarTimezone, expansionWindow, FEED_LIMITS);
}

/** A series a feed holds that Slotlock refused to read, by its UID. */
export interface ICalendarSeriesRefusal {
  uid: string;
  code: CalendarContractError['code'];
  /** Set when the series needs more work than Slotlock spends (CalendarExpansionLimitError). */
  limit?: true;
}

/** What parseICalendarFeed read: every series it could, and the ones it refused. */
export interface ICalendarFeedRead {
  changes: ExternalCalendarChange[];
  /** Their time is not known: treat it as busy, or the feed's coverage as incomplete. */
  refused: ICalendarSeriesRefusal[];
}

/**
 * parseICalendarChanges, refusing one series at a time: a series Slotlock cannot read (a
 * misexpanded rule shape, an end the clocks move before its start, DTEND with DURATION, or over
 * budget) is named in `refused` and the rest is read. A calendar that is not one (size, time zones,
 * a missing UID, a window over 367 days) is still refused whole, with CalendarContractError.
 */
export function parseICalendarFeed(
  input: string,
  calendarTimezone?: string,
  expansionWindow?: ICalendarExpansionWindow,
): ICalendarFeedRead {
  const refused: ICalendarSeriesRefusal[] = [];
  const changes = parseCalendarChanges(
    input,
    calendarTimezone,
    expansionWindow,
    FEED_LIMITS,
    undefined,
    refused,
  );
  return { changes, refused };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long an event's occurrences last, as read from its DTSTART and DTEND or DURATION. */
interface SeriesLengths {
  allDay: boolean;
  /** How DTSTART's zone reads wall times. */
  reader: ZoneReader;
  /** DTSTART's wall time as written (a date's midnight), framed as UTC. */
  startWall: number;
  /** DTSTART's instant: a stored series' own, else its wall time read per RFC 5545 §3.3.5. */
  start: number;
  /** DTEND − DTSTART as instants (RFC 5545 §3.8.5.3); absent for a DURATION or a DATE. */
  exact?: number;
  /** A DURATION's days and weeks (nominal) and the rest in milliseconds (exact), §3.3.6. */
  duration?: { days: number; ms: number };
  /** The wall-clock length: DTEND's wall time in DTSTART's zone less DTSTART's, or the DURATION. */
  wall: number;
  /** Whether it has any length: DTEND or DURATION, or a DATE (a day). */
  ends: boolean;
}

/** An override (or a stored exception) as an expansion applies it. */
interface ReadOverride {
  /** The instant of the occurrence it replaces. */
  at: number;
  /** Its own interval, exactly as written. */
  start: number;
  end: number;
  /** Its own change: busy, transparent or cancelled; null when it has no length. */
  change: ExternalCalendarChange | null;
  component: ICAL.Component;
  /** RANGE=THISANDFUTURE: it also moves every later occurrence. */
  range: boolean;
  /** Its own lengths (a series' when it has none), read in its own zone. */
  lengths: SeriesLengths;
  /** Its RECURRENCE-ID's wall time as written, framed as UTC. */
  recurrenceWall: number;
}

function parseCalendarChanges(
  input: string,
  calendarTimezone: string | undefined,
  expansionWindow: ICalendarExpansionWindow | undefined,
  limits: ExpansionLimits | RecurrenceBudget,
  series?: SeriesResume,
  refused?: ICalendarSeriesRefusal[],
): ExternalCalendarChange[] {
  try {
    // Cheap early DoS guards before ical.js builds the full tree; the parsed-tree checks below stay
    // authoritative.
    boundInput(input);
    const budget = limits instanceof RecurrenceBudget ? limits : new RecurrenceBudget(limits);
    const root = new ICAL.Component(ICAL.parse(input));
    // A bare VEVENT would read as a calendar with no events.
    if (root.name !== 'vcalendar') throw new CalendarContractError('invalid_icalendar');
    let Budgeted: typeof ICAL.RecurIterator | undefined;
    const budgeted = () => (Budgeted ??= budgetedRecurIterator(budget));
    budgetTimezoneRules(root, budgeted);
    budgetTimezoneCoverage(root, budget);
    // A time in a zone of its own is read in that zone: an RDATE may name a different zone than
    // DTSTART, and its occurrence keeps it. Every read goes through the budget.
    const timeValue = (value: unknown, zone: unknown, fallback: string | undefined) =>
      calendarTimeValue(value, ownZone(value) ?? zone, fallback, budget);
    const readerOf = (value: unknown, zone: unknown) =>
      budget.zoneReader(zoneReader(value, ownZone(value) ?? zone, defaultTimezone));
    const embeddedTimezone = root.getFirstPropertyValue('x-wr-timezone');
    const defaultTimezone =
      calendarTimezone?.trim() ||
      (typeof embeddedTimezone === 'string' ? embeddedTimezone.trim() : '') ||
      undefined;
    const components = root.getAllSubcomponents('vevent');
    if (components.length > MAX_ICAL_COMPONENTS) {
      throw new CalendarContractError('invalid_icalendar');
    }
    boundComponents(components);
    const periods = frameEventTimes(root, components, defaultTimezone, budget);
    const events = feedEvents(components);
    // A series is a master and the overrides sharing its UID, each read on its own: with `refused`,
    // an unreadable series is named there; without, it refuses the calendar.
    const groups = new Map<string, { masters: ICAL.Event[]; overrides: ICAL.Event[] }>();
    for (const event of events) {
      const uid = event.uid;
      // An event without a UID cannot be named, so it refuses the calendar either way.
      if (typeof uid !== 'string') throw new CalendarContractError('invalid_icalendar');
      const group = groups.get(uid) ?? { masters: [], overrides: [] };
      if (event.isRecurrenceException()) {
        if (group.overrides.length >= MAX_ICAL_EXCEPTIONS_PER_SERIES) {
          throw new CalendarContractError('invalid_icalendar');
        }
        group.overrides.push(event);
      } else {
        group.masters.push(event);
      }
      groups.set(uid, group);
    }

    /**
     * A change for `start` to `end` with `component`'s status, transparency and sequence, or null
     * when it has no length (RFC 5545 §3.6.1: a DATE-TIME DTSTART without DTEND or DURATION
     * occupies no time). A cancelled one still says so.
     */
    const makeChange = (
      component: ICAL.Component,
      uid: string,
      start: number,
      end: number,
      recurrenceId?: number,
    ): ExternalCalendarChange | null => {
      const status = String(component.getFirstPropertyValue('status') ?? 'confirmed').toLowerCase();
      const transparency = String(
        component.getFirstPropertyValue('transp') ?? 'opaque',
      ).toLowerCase();
      const change: ExternalCalendarChangeInput = {
        externalId: uid,
        start: new Date(start),
        end: new Date(end),
        status,
        transparent: transparency === 'transparent',
        sequence: Number(component.getFirstPropertyValue('sequence') ?? 0),
      };
      if (end === start) {
        if (status !== 'cancelled') return null;
        change.start = null;
        change.end = null;
      }
      if (recurrenceId !== undefined) change.recurrenceId = new Date(recurrenceId).toISOString();
      try {
        return normalizeExternalCalendarChange(change);
      } catch (error) {
        if (error instanceof CalendarContractError) {
          throw new CalendarContractError('invalid_icalendar');
        }
        throw error;
      }
    };

    /**
     * How long an event's occurrences last (SPEC.md, "Daylight-saving time"): DTSTART as written (a
     * stored series' own instant), DTEND as an instant per RFC 5545 §3.3.5, a DURATION per §3.3.6.
     */
    const lengthsOf = (event: ICAL.Event, anchor?: { start: Date; end: Date }): SeriesLengths => {
      const component = event.component;
      const startTime = event.startDate;
      if (!(startTime instanceof ICAL.Time)) throw new CalendarContractError('invalid_icalendar');
      const startZone = component.getFirstProperty('dtstart')?.getParameter('tzid');
      const reader = readerOf(startTime, startZone);
      const startWall = wallFrameOf(startTime);
      const start = anchor ? anchor.start.getTime() : reader.toInstant(startWall);
      const allDay = startTime.isDate;
      const endProperty = component.getFirstProperty('dtend');
      const duration = component.getFirstPropertyValue('duration');
      const base = { allDay, reader, startWall, start };
      if (endProperty) {
        const endTime = endProperty.getFirstValue();
        if (!(endTime instanceof ICAL.Time)) throw new CalendarContractError('invalid_icalendar');
        if (allDay) {
          const wall = wallFrameOf(endTime) - startWall;
          if (wall < 0) throw new CalendarContractError('invalid_icalendar');
          return { ...base, wall, ends: true };
        }
        const endZone = endProperty.getParameter('tzid') ?? startZone;
        const end = anchor
          ? anchor.end.getTime()
          : readerOf(endTime, endZone).toInstant(wallFrameOf(endTime));
        // An end the clocks moved onto or before its start is refused; an end written as its start
        // is no length.
        const sameZone = (ownZone(endTime) ?? endZone) === (ownZone(startTime) ?? startZone);
        const writtenAsStart = wallFrameOf(endTime) === startWall && sameZone;
        if (end < start || (end === start && !writtenAsStart)) {
          throw new CalendarContractError('invalid_icalendar');
        }
        // DTEND's wall time as written when in DTSTART's zone (carried to later days as written,
        // even in a skipped hour); otherwise, or for a stored series, the wall time its instant
        // reads in DTSTART's zone.
        const endWall = !anchor && sameZone ? wallFrameOf(endTime) : reader.toWall(end);
        return { ...base, exact: end - start, wall: endWall - startWall, ends: end > start };
      }
      if (duration instanceof ICAL.Duration) {
        const days = duration.weeks * 7 + duration.days;
        const ms = ((duration.hours * 60 + duration.minutes) * 60 + duration.seconds) * 1000;
        if (allDay) return { ...base, wall: (days + (ms > 0 ? 1 : 0)) * DAY_MS, ends: true };
        return {
          ...base,
          duration: { days, ms },
          wall: days * DAY_MS + ms,
          ends: days > 0 || ms > 0,
        };
      }
      // No end: a DATE-TIME occupies no time (§3.6.1), a DATE its one day.
      return allDay
        ? { ...base, wall: DAY_MS, ends: true }
        : { ...base, exact: 0, wall: 0, ends: false };
    };

    /** The exact end of an occurrence that starts at `start`, wall time `wall`: what a one-off takes. */
    const exactEnd = (lengths: SeriesLengths, reader: ZoneReader, wall: number, start: number) => {
      if (lengths.allDay) return reader.toInstant(wall + lengths.wall);
      if (lengths.duration) {
        const { days, ms } = lengths.duration;
        return (days > 0 ? reader.toInstant(wall + days * DAY_MS) : start) + ms;
      }
      return start + (lengths.exact ?? 0);
    };

    /**
     * The later of an occurrence's exact end and its wall-clock end: where clocks change inside an
     * occurrence, either reading alone leaves time free that people mean as busy.
     */
    const occurrenceEnd = (
      lengths: SeriesLengths,
      reader: ZoneReader,
      wall: number,
      start: number,
    ) => {
      const exact = exactEnd(lengths, reader, wall, start);
      if (lengths.allDay || !lengths.ends) return exact;
      return Math.max(exact, reader.toInstant(wall + lengths.wall, { fold: 'later' }));
    };

    /**
     * An override: the instant of the occurrence it replaces and its own exact interval. Without
     * DTEND or DURATION it lasts its series' length (§3.6.1 alone would leave the moved occurrence
     * free).
     */
    const readOverride = (
      override: ICAL.Event,
      uid: string,
      seriesLengths: SeriesLengths | undefined,
      seriesZone: unknown,
    ): ReadOverride => {
      const component = override.component;
      const recurrence = component.getFirstProperty('recurrence-id');
      const at = timeValue(
        override.recurrenceId,
        recurrence?.getParameter('tzid') ??
          component.getFirstProperty('dtstart')?.getParameter('tzid') ??
          seriesZone,
        defaultTimezone,
      ).getTime();
      const own = lengthsOf(override);
      const lengths =
        own.ends || !seriesLengths
          ? own
          : { ...seriesLengths, reader: own.reader, startWall: own.startWall, start: own.start };
      const end = exactEnd(lengths, own.reader, own.startWall, own.start);
      return {
        at,
        start: own.start,
        end,
        change: makeChange(component, uid, own.start, end, at),
        component,
        range: String(recurrence?.getParameter('range') ?? '').toUpperCase() === 'THISANDFUTURE',
        lengths,
        recurrenceWall: wallFrameOf(override.recurrenceId),
      };
    };

    const changes: ExternalCalendarChange[] = [];
    const overlapsWindow = (start: number, end: number) =>
      expansionWindow !== undefined &&
      end > expansionWindow.start.getTime() &&
      start < expansionWindow.end.getTime();

    /** Each PERIOD RDATE of a series, by the instant it starts: the instant it ends, exactly. */
    const periodEndsOf = (event: ICAL.Event): Map<number, number> => {
      const ends = new Map<number, number>();
      const maxMs = MAX_ICAL_STEP_DAYS * DAY_MS;
      for (const period of periods.get(event.component) ?? []) {
        const zone = period.property.getParameter('tzid');
        const start = ICAL.Time.fromDateTimeString(period.start, period.property);
        const reader = readerOf(start, zone);
        const startWall = wallFrameOf(start);
        const startMs = reader.toInstant(startWall);
        let endMs: number;
        if (/^[+-]?P/.test(period.end)) {
          const duration = ICAL.Duration.fromString(period.end);
          if (duration.isNegative || duration.toSeconds() * 1000 > maxMs) expansionLimit();
          const days = duration.weeks * 7 + duration.days;
          const ms = ((duration.hours * 60 + duration.minutes) * 60 + duration.seconds) * 1000;
          endMs = (days > 0 ? reader.toInstant(startWall + days * DAY_MS) : startMs) + ms;
        } else {
          const end = ICAL.Time.fromDateTimeString(period.end, period.property);
          if (Math.abs(fieldsMs(end) - fieldsMs(start)) > maxMs + DAY_MS) expansionLimit();
          endMs = timeValue(end, zone, defaultTimezone).getTime();
        }
        if (endMs < startMs) throw new CalendarContractError('invalid_icalendar');
        ends.set(startMs, endMs);
      }
      return ends;
    };

    /**
     * A series' EXDATEs: instants for DATE-TIME values, days for DATE values. ical.js applies them
     * as it goes, so some occurrences escaped; RFC 5545 §3.8.5.1 has every EXDATE win.
     */
    const exclusionsOf = (event: ICAL.Event) => {
      const instants = new Set<number>();
      const days = new Set<string>();
      const startZone = event.component.getFirstProperty('dtstart')?.getParameter('tzid');
      for (const property of event.component.getAllProperties('exdate')) {
        const zone = property.getParameter('tzid') ?? startZone;
        for (const value of property.getValues()) {
          if (!(value instanceof ICAL.Time)) throw new CalendarContractError('invalid_icalendar');
          if (value.isDate) days.add(dayOf(value));
          else instants.add(timeValue(value, zone, defaultTimezone).getTime());
        }
      }
      return { instants, days };
    };

    /** A one-off event and its overrides: each occupies exactly what it says, window or not. */
    const readOneOff = (uid: string, event: ICAL.Event, overrides: ReadOverride[]) => {
      const lengths = lengthsOf(event);
      const replaced = overrides.some((override) => override.at === lengths.start);
      if (!replaced) {
        const end = exactEnd(lengths, lengths.reader, lengths.startWall, lengths.start);
        const recurrenceId = event.recurrenceId ? lengths.start : undefined;
        const change = makeChange(event.component, uid, lengths.start, end, recurrenceId);
        if (change) changes.push(change);
      }
      // A server-expanded CalDAV series may send its first instance without a RECURRENCE-ID and
      // every other one with one (RFC 4791 §9.6.5): each override occupies its own time.
      for (const override of overrides) if (override.change) changes.push(override.change);
    };

    const readSeries = (uid: string, group: { masters: ICAL.Event[]; overrides: ICAL.Event[] }) => {
      if (group.masters.length > 1) throw new CalendarContractError('invalid_icalendar');
      for (const event of [...group.masters, ...group.overrides]) {
        // RFC 5545 §3.6.1: 'dtend' and 'duration' MUST NOT occur in the same eventprop.
        if (event.component.hasProperty('dtend') && event.component.hasProperty('duration')) {
          throw new CalendarContractError('invalid_icalendar');
        }
      }
      const master = group.masters[0];
      if (!master) {
        // Overrides of a series this calendar does not hold: each occupies its own interval.
        for (const override of group.overrides) {
          const read = readOverride(override, uid, undefined, undefined);
          if (read.change) changes.push(read.change);
        }
        return;
      }
      const startZone = master.component.getFirstProperty('dtstart')?.getParameter('tzid');
      if (!master.isRecurring()) {
        const lengths = lengthsOf(master);
        const overrides = group.overrides.map((override) =>
          readOverride(override, uid, lengths, startZone),
        );
        readOneOff(uid, master, overrides);
        return;
      }
      readRecurring(uid, master, group.overrides, startZone);
    };

    const readRecurring = (
      uid: string,
      event: ICAL.Event,
      overrideEvents: ICAL.Event[],
      startZone: unknown,
    ) => {
      if (
        !expansionWindow ||
        !Number.isFinite(expansionWindow.start.getTime()) ||
        !Number.isFinite(expansionWindow.end.getTime()) ||
        expansionWindow.end <= expansionWindow.start ||
        expansionWindow.end.getTime() - expansionWindow.start.getTime() > MAX_ICAL_WINDOW_MS
      ) {
        throw new CalendarContractError('invalid_icalendar');
      }
      const startTime = event.startDate;
      for (const property of event.component.getAllProperties('rrule')) {
        const recur = property.getFirstValue();
        if (!(recur instanceof ICAL.Recur)) throw new CalendarContractError('invalid_icalendar');
        if (
          recurShapeProblem(recur) !== null ||
          (startTime instanceof ICAL.Time && seriesShapeProblem(recur, startTime) !== null)
        ) {
          throw new CalendarContractError('invalid_icalendar');
        }
        sortRuleParts(recur);
      }
      // yearlyDays needs the rule to be the series' only source: ical.js mixes RDATEs and other
      // rules in, which could not be told from a moved day.
      const ruleValues = event.component.getAllProperties('rrule');
      const lacking =
        startTime instanceof ICAL.Time
          ? ruleValues.map((rule) => yearlyDays(rule.getFirstValue() as ICAL.Recur, startTime))
          : [];
      const onDays = lacking[0] ?? null;
      if (
        lacking.some((days) => days !== null) &&
        (ruleValues.length > 1 || event.component.hasProperty('rdate'))
      ) {
        throw new CalendarContractError('invalid_icalendar');
      }
      const stored = series?.stored;
      const lengths = lengthsOf(event, stored);
      const overrides: ReadOverride[] = stored
        ? stored.exceptions.map((exception) => storedOverride(uid, event, lengths, exception))
        : overrideEvents.map((override) => readOverride(override, uid, lengths, startZone));
      // Per series, so one series' age never refuses another's.
      let remainingWork = MAX_ICAL_WORK;
      let maxBackwardExceptionShiftMs = 0;
      let lastOverrideAt = Number.NEGATIVE_INFINITY;
      for (const override of overrides) {
        remainingWork -= 1;
        if (remainingWork < 0) expansionLimit();
        const backwardShiftMs = override.at - override.start;
        if (backwardShiftMs > MAX_EXCEPTION_BACKWARD_SHIFT_MS) {
          throw new CalendarContractError('invalid_icalendar');
        }
        // ical.js moves an occurrence a month at a time (Time#adjust).
        if (-backwardShiftMs > MAX_ICAL_STEP_DAYS * DAY_MS) expansionLimit();
        maxBackwardExceptionShiftMs = Math.max(maxBackwardExceptionShiftMs, backwardShiftMs);
        lastOverrideAt = Math.max(lastOverrideAt, override.at);
      }
      const recurrenceScanEndMs = expansionWindow.end.getTime() + maxBackwardExceptionShiftMs;
      // A direct override replaces its occurrence; a RANGE=THISANDFUTURE one also moves every later
      // one by its shift, with its own length.
      const byInstant = new Map(overrides.map((override) => [override.at, override]));
      const ranges = overrides
        .filter((override) => override.range)
        .sort((left, right) => left.at - right.at);
      const rangeBefore = (instant: number) => {
        let found: ReadOverride | undefined;
        for (const range of ranges) {
          if (range.at < instant) found = range;
          else break;
        }
        return found;
      };
      // A stored series (the only master) resumes from its cursor when the cursor fits and the
      // window needs nothing before it, and leaves one for the next window.
      const key = series && groups.size === 1 ? seriesKey(event.component) : null;
      const kept = key === null ? null : readSeriesCursor(series?.cursor, key);
      const usable =
        kept !== null && series !== undefined && kept.position <= series.resumeLimitMs
          ? kept
          : null;
      let periodEnds: Map<number, number> | undefined;
      let exclusions: ReturnType<typeof exclusionsOf> | undefined;
      // A feed series that repeats every so many days (one DAILY or WEEKLY RRULE, no COUNT, RDATE
      // or THISANDFUTURE override) repeats identically from DTSTART moved by whole periods, so the
      // search starts at the last such time no earlier occurrence could reach the window from: a
      // daily standup since 2014 reads like one from this year.
      let from: ICAL.Time | undefined;
      const rules = event.component.getAllProperties('rrule');
      const only = rules.length === 1 ? rules[0]?.getFirstValue() : undefined;
      if (
        !series &&
        ranges.length === 0 &&
        !event.component.hasProperty('rdate') &&
        startTime instanceof ICAL.Time &&
        only instanceof ICAL.Recur &&
        only.count == null &&
        (only.freq === 'DAILY' || only.freq === 'WEEKLY')
      ) {
        const periodMs = only.interval * (only.freq === 'WEEKLY' ? 7 : 1) * DAY_MS;
        const reachMs =
          Math.max(lengths.exact ?? 0, lengths.wall) + OCCURRENCE_END_SLACK_MS + periodMs;
        const periods = Math.floor(
          (expansionWindow.start.getTime() - reachMs - lengths.start) / periodMs,
        );
        if (periods > 0) {
          const day = new Date(lengths.startWall + periods * periodMs);
          from = startTime.clone();
          from.year = day.getUTCFullYear();
          from.month = day.getUTCMonth() + 1;
          from.day = day.getUTCDate();
        }
      }
      // The window's occurrences from `resume` (or the start) and the cursor to keep; null when
      // `resume` does not fit.
      const expand = (resume: CalendarSeriesCursor | null) => {
        const iterator = resume
          ? resumedExpansion(event, budgeted(), budget, resume)
          : budgetedExpansion(event, budgeted(), budget, from);
        if (iterator === null) return null;
        if (
          resume &&
          timeValue(
            (iterator as unknown as ExpansionState).last,
            startZone,
            defaultTimezone,
          ).getTime() !== resume.position
        ) {
          return null;
        }
        // Searched from the start, a stored series' exceptions are checked against every occurrence
        // up to the last of them, so one naming no occurrence is refused.
        const scanEndMs =
          stored && !resume
            ? Math.max(recurrenceScanEndMs, lastOverrideAt + 1)
            : recurrenceScanEndMs;
        const found: ExternalCalendarChange[] = [];
        const matched = new Set<ReadOverride>();
        let position = resume?.position;
        const seen = new Set<number>();
        let snapshot = resume;
        let leaving = key !== null;
        // Every occurrence starting before this instant has been seen (all of them once the series
        // has ended).
        let scannedTo = Number.NEGATIVE_INFINITY;
        // DTSTART is the first instance (RFC 5545 §3.8.5.3), whether or not the rule gives it.
        let first: ICAL.Time | null =
          resume === null && from === undefined && startTime instanceof ICAL.Time
            ? startTime
            : null;
        const firstAt = first ? timeValue(first, startZone, defaultTimezone).getTime() : 0;
        // One reader per zone for the whole series: RRULE occurrences are in DTSTART's zone, an
        // RDATE's in its own.
        const readers = new Map<unknown, ZoneReader>();
        const readerFor = (time: ICAL.Time) => {
          let reader = readers.get(time.zone);
          if (!reader) {
            reader = readerOf(time, startZone);
            readers.set(time.zone, reader);
          }
          return reader;
        };
        let held: ICAL.Time | null | undefined;
        while (true) {
          remainingWork -= 1;
          if (remainingWork < 0) expansionLimit();
          budget.charge(OCCURRENCE_STEPS);
          // Before the next step: if everything passed ends before the window, the next expansion
          // can start here.
          if (leaving && key !== null && series && position !== undefined && held === undefined) {
            if (position <= series.resumeLimitMs)
              snapshot = snapshotSeries(iterator, key, position);
            else leaving = false;
          }
          let occurrence: ICAL.Time | null;
          let isFirst = false;
          if (held !== undefined) {
            occurrence = held;
            held = undefined;
          } else {
            occurrence = iterator.next() ?? null;
            if (first) {
              const at = occurrence
                ? timeValue(occurrence, startZone, defaultTimezone).getTime()
                : 0;
              if (occurrence && at === firstAt) {
                isFirst = true;
                first = null;
              } else if (!occurrence || at > firstAt) {
                held = occurrence;
                occurrence = first;
                isFirst = true;
                first = null;
              }
            }
          }
          if (!occurrence) {
            scannedTo = Number.POSITIVE_INFINITY;
            break;
          }
          const reader = readerFor(occurrence);
          const wall = wallFrameOf(occurrence);
          position = reader.toInstant(wall);
          if (!Number.isFinite(position)) throw new CalendarContractError('invalid_icalendar');
          if (position >= scanEndMs) {
            scannedTo = position;
            break;
          }
          if (
            onDays &&
            !isFirst &&
            !(onDays.months.has(occurrence.month) && onDays.days.has(occurrence.day))
          ) {
            continue;
          }
          // The first instance is DTSTART's own instant: for a stored series, the instant stored.
          const at = isFirst ? lengths.start : position;
          // An instant is one occurrence however many RRULEs and RDATEs name it (RFC 5545 §3.8.5.3;
          // ical.js yields duplicates), and none where an EXDATE names it.
          if (seen.has(at)) continue;
          seen.add(at);
          if (event.component.hasProperty('exdate')) {
            exclusions ??= exclusionsOf(event);
            if (exclusions.instants.has(at) || exclusions.days.has(dayOf(occurrence))) continue;
          }
          const override = byInstant.get(at);
          if (override) {
            matched.add(override);
            if (override.change && overlapsWindow(override.start, override.end)) {
              found.push(override.change);
            }
            continue;
          }
          const periodEnd = (periodEnds ??= periodEndsOf(event)).get(position);
          const range = periodEnd === undefined ? rangeBefore(at) : undefined;
          let start = at;
          let end: number;
          let component = event.component;
          if (periodEnd !== undefined) {
            end = periodEnd;
          } else if (range) {
            // Moved by the range override's wall-clock shift in its zone (as ical.js moves it),
            // lasting the override's length.
            const shifted = wall + (range.lengths.startWall - range.recurrenceWall);
            start = range.lengths.reader.toInstant(shifted);
            end = occurrenceEnd(range.lengths, range.lengths.reader, shifted, start);
            component = range.component;
          } else {
            end = occurrenceEnd(lengths, reader, wall, start);
          }
          if (overlapsWindow(start, end)) {
            const change = makeChange(component, uid, start, end, at);
            if (change) found.push(change);
            if (changes.length + found.length > MAX_ICAL_OCCURRENCES) expansionLimit();
          }
        }
        return { found, snapshot, matched, scannedTo };
      };
      let expanded: ReturnType<typeof expand> = null;
      if (usable !== null) {
        try {
          expanded = expand(usable);
        } catch (error) {
          // A cursor ical.js cannot continue is treated as not fitting: search from the start.
          // Running out of budget is the series' own doing.
          if (error instanceof CalendarExpansionLimitError) throw error;
        }
      }
      const resumed = expanded !== null;
      if (expanded === null) {
        if (series?.resumeOnly) expansionLimit();
        expanded = expand(null);
      }
      if (expanded === null) throw new CalendarContractError('invalid_icalendar');
      changes.push(...expanded.found);
      for (const override of overrides) {
        if (expanded.matched.has(override)) continue;
        // An override whose occurrence was removed, or that names none, still occupies its own
        // interval, as the provider shows it. A stored exception naming no occurrence is refused
        // where this can tell, or collected in `series.unmatched`.
        const passed = resumed ? override.at <= (usable?.position ?? 0) : false;
        if (
          stored &&
          !passed &&
          (override.at < lengths.start || override.at < expanded.scannedTo)
        ) {
          if (!series?.unmatched) throw new CalendarContractError('invalid_icalendar');
          series.unmatched.add(override.at);
          continue;
        }
        if (override.change && overlapsWindow(override.start, override.end)) {
          changes.push(override.change);
        }
      }
      if (series && key !== null) {
        series.resumed = resumed;
        series.left = keptSeriesCursor(expanded.snapshot);
      }
    };

    const storedOverride = (
      uid: string,
      event: ICAL.Event,
      lengths: SeriesLengths,
      exception: CalendarRecurrenceException,
    ): ReadOverride => {
      const at = exception.recurrenceId.getTime();
      const start = exception.start?.getTime() ?? at;
      const end = exception.end?.getTime() ?? at + (lengths.exact ?? 0);
      // A cancelled exception is a cancellation with no time, whatever the series' status.
      const change = exception.cancelled
        ? normalizeExternalCalendarChange({
            externalId: uid,
            recurrenceId: new Date(at).toISOString(),
            status: 'cancelled',
          })
        : makeChange(event.component, uid, start, end, at);
      return {
        at,
        start,
        end,
        change,
        component: event.component,
        range: false,
        lengths,
        recurrenceWall: 0,
      };
    };

    for (const [uid, group] of groups) {
      const before = changes.length;
      try {
        readSeries(uid, group);
        separateOccurrences(changes, before, expansionWindow);
      } catch (error) {
        if (!refused || !(error instanceof CalendarContractError)) throw error;
        changes.length = before;
        const refusal: ICalendarSeriesRefusal = { uid, code: error.code };
        if (error instanceof CalendarExpansionLimitError) refusal.limit = true;
        refused.push(refusal);
      }
    }
    return changes;
  } catch (error) {
    if (error instanceof CalendarContractError) throw error;
    throw new CalendarContractError('invalid_icalendar');
  }
}

/**
 * Make one series' busy occurrences disjoint without freeing a minute: where one ends after the
 * next starts, it ends there and the next ends at the later of the two. The union rule can make
 * day-long occurrences overlap across a spring-forward, and the store's EXCLUDE constraint refuses
 * overlaps. Same-instant starts are left alone; an occurrence cut to end before the window is
 * dropped.
 */
function separateOccurrences(
  changes: ExternalCalendarChange[],
  from: number,
  window: ICalendarExpansionWindow | undefined,
): void {
  const busy = changes
    .slice(from)
    .filter((change) => change.busy && change.start !== null && change.end !== null)
    .sort((left, right) => (left.start as Date).getTime() - (right.start as Date).getTime());
  const cut = new Set<ExternalCalendarChange>();
  for (let index = 1; index < busy.length; index++) {
    const before = busy[index - 1] as ExternalCalendarChange;
    const change = busy[index] as ExternalCalendarChange;
    const start = (change.start as Date).getTime();
    const reach = (before.end as Date).getTime();
    if (reach <= start || (before.start as Date).getTime() === start) continue;
    if (reach > (change.end as Date).getTime()) change.end = new Date(reach);
    before.end = new Date(start);
    cut.add(before);
  }
  if (!window || cut.size === 0) return;
  for (let index = changes.length - 1; index >= from; index--) {
    const change = changes[index] as ExternalCalendarChange;
    if (cut.has(change) && (change.end as Date) <= window.start) changes.splice(index, 1);
  }
}

function requiredEventText(value: string, code: CalendarContractError['code']): string {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > MAX_TRUSTED_SUMMARY_BYTES) {
    throw new CalendarContractError(code);
  }
  return normalized;
}

function addDateTimeProperty(
  component: ICAL.Component,
  name: 'dtstart' | 'dtend' | 'recurrence-id',
  value: Date,
  timezone: string,
): void {
  const property = new ICAL.Property(name);
  if (timezone === 'UTC') {
    property.setValue(ICAL.Time.fromJSDate(value, true));
  } else {
    property.setParameter('tzid', timezone);
    property.setValue(
      ICAL.Time.fromData({ ...zonedDateTimeFields(value, timezone), isDate: false }),
    );
  }
  component.addProperty(property);
}

/**
 * Whether `instant`'s wall time in `timezone` names it again per RFC 5545 §3.3.5: not for the
 * second pass of a repeated hour.
 */
function wallTimeNames(instant: Date, timezone: string): boolean {
  if (timezone === 'UTC') return true;
  const named = zonedDateTimeToUtc(zonedDateTimeFields(instant, timezone), timezone);
  return named.getTime() === instant.getTime();
}

function attendeeRoleValue(role: CalendarAttendeeRole | undefined): string {
  switch (role) {
    case 'chair':
      return 'CHAIR';
    case 'optional':
      return 'OPT-PARTICIPANT';
    case 'non_participant':
      return 'NON-PARTICIPANT';
    case 'required':
    case undefined:
      return 'REQ-PARTICIPANT';
  }
}

function participationValue(status: CalendarParticipationStatus | undefined): string {
  return (status ?? 'needs_action').replace('_', '-').toUpperCase();
}

function addParticipants(
  component: ICAL.Component,
  organizer: CalendarOrganizer | undefined,
  attendees: CalendarAttendee[] | undefined,
): void {
  if (organizer) {
    const property = new ICAL.Property('organizer');
    property.setValue(`mailto:${organizer.email}`);
    if (organizer.name) property.setParameter('cn', organizer.name);
    component.addProperty(property);
  }
  for (const attendee of attendees ?? []) {
    const property = new ICAL.Property('attendee');
    property.setValue(`mailto:${attendee.email}`);
    if (attendee.name) property.setParameter('cn', attendee.name);
    property.setParameter('role', attendeeRoleValue(attendee.role));
    property.setParameter('partstat', participationValue(attendee.participationStatus));
    if (attendee.rsvp !== undefined) {
      property.setParameter('rsvp', attendee.rsvp ? 'TRUE' : 'FALSE');
    }
    component.addProperty(property);
  }
}

function addReminders(
  component: ICAL.Component,
  reminders: CalendarReminder[] | undefined,
  summary: string,
  attendees: CalendarAttendee[] | undefined,
): void {
  for (const reminder of reminders ?? []) {
    const alarm = new ICAL.Component('valarm');
    alarm.updatePropertyWithValue('action', reminder.action.toUpperCase());
    alarm.updatePropertyWithValue(
      'trigger',
      ICAL.Duration.fromSeconds(-reminder.minutesBeforeStart * 60),
    );
    alarm.updatePropertyWithValue('description', 'Calendar event reminder');
    if (reminder.action === 'email') {
      alarm.updatePropertyWithValue('summary', summary);
      for (const attendee of attendees ?? []) {
        const target = new ICAL.Property('attendee');
        target.setValue(`mailto:${attendee.email}`);
        alarm.addProperty(target);
      }
    }
    component.addSubcomponent(alarm);
  }
}

function eventComponent(params: {
  event: CalendarEventContent;
  uid: string;
  sequence: number;
  updatedAt: Date;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  recurrenceId?: Date;
  includeRecurrence?: boolean;
}): ICAL.Component {
  const component = new ICAL.Component('vevent');
  component.updatePropertyWithValue('uid', params.uid);
  component.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(params.updatedAt, true));
  component.updatePropertyWithValue('last-modified', ICAL.Time.fromJSDate(params.updatedAt, true));
  const { start, end, timezone } = params.event;
  const recurring = params.includeRecurrence === true && params.event.recurrence !== undefined;
  // DTSTART in its zone, since a series recurs at its wall time. Any other time is written in its
  // zone only where that wall time names it (wallTimeNames), else in UTC.
  addDateTimeProperty(
    component,
    'dtstart',
    start,
    recurring || wallTimeNames(start, timezone) ? timezone : 'UTC',
  );
  if (recurring && !wallTimeNames(start, timezone)) {
    // Its length as an exact DURATION (§3.3.6), since its DTSTART reads an hour early:
    // emitITipCalendar adds an override putting the first instance at its own instants.
    component.updatePropertyWithValue(
      'duration',
      ICAL.Duration.fromSeconds((end.getTime() - start.getTime()) / 1000),
    );
  } else {
    addDateTimeProperty(component, 'dtend', end, wallTimeNames(end, timezone) ? timezone : 'UTC');
  }
  if (params.recurrenceId) {
    addDateTimeProperty(component, 'recurrence-id', params.recurrenceId, 'UTC');
  }
  component.updatePropertyWithValue('summary', params.event.summary);
  if (params.event.description) {
    component.updatePropertyWithValue('description', params.event.description);
  }
  if (params.event.location) component.updatePropertyWithValue('location', params.event.location);
  component.updatePropertyWithValue('sequence', params.sequence);
  component.updatePropertyWithValue(
    'status',
    (params.status ?? params.event.status ?? 'confirmed').toUpperCase(),
  );
  component.updatePropertyWithValue(
    'transp',
    params.event.transparency === 'transparent' ? 'TRANSPARENT' : 'OPAQUE',
  );
  addParticipants(component, params.event.organizer, params.event.attendees);
  if (params.status !== 'cancelled') {
    addReminders(component, params.event.reminders, params.event.summary, params.event.attendees);
  }
  if (params.includeRecurrence && params.event.recurrence) {
    component.updatePropertyWithValue(
      'rrule',
      ICAL.Recur.fromString(params.event.recurrence.rrule),
    );
  }
  return component;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
/** How many years past its last stored time a series' VTIMEZONE lists, before its rules go on. */
const VTIMEZONE_SERIES_YEARS = 30;
/** And at most, from its first year: a longer series is left to the rules. */
const MAX_VTIMEZONE_YEARS = 60;

/** Cached: Intl answers the same for a process. */
const zoneChanges = new Map<string, ZoneTransition[]>();

/** One change a year, which one yearly rule names. */
interface ZoneRun {
  changes: ZoneTransition[];
  /** The BYDAY values that name every change of the run in its month. */
  days: string[];
  lastYear: number;
}

/**
 * A VTIMEZONE (RFC 5545 §3.6.5) for `timezone` as Intl reads it from `fromYear` to `toYear`: the
 * offset at the start, then every change. Runs of yearly changes on the same weekday rule, local
 * time and offsets become one observance with a yearly rule (UNTIL where they stop; left open if
 * still running at `toYear` after at least three years). Other changes are observances of their
 * own. Offsets are whole minutes: ical.js 2.2.1 reads no seconds (UtcOffset.fromString).
 */
function vtimezoneComponent(timezone: string, fromYear: number, toYear: number): ICAL.Component {
  const from = Date.UTC(fromYear, 0, 1);
  const key = `${timezone}|${fromYear}|${toYear}`;
  let changes = zoneChanges.get(key);
  if (!changes) {
    changes = zoneTransitions(timezone, from, Date.UTC(toYear + 1, 0, 1));
    if (zoneChanges.size >= 64) zoneChanges.clear();
    zoneChanges.set(key, changes);
  }
  const zone = new ICAL.Component('vtimezone');
  zone.updatePropertyWithValue('tzid', timezone);
  const offset = (ms: number) => ICAL.UtcOffset.fromSeconds(Math.round(ms / 60_000) * 60);
  const observance = (at: number, before: number, after: number) => {
    const component = new ICAL.Component(after > before ? 'daylight' : 'standard');
    const wall = new Date(at + before);
    component.updatePropertyWithValue(
      'dtstart',
      ICAL.Time.fromData({
        year: wall.getUTCFullYear(),
        month: wall.getUTCMonth() + 1,
        day: wall.getUTCDate(),
        hour: wall.getUTCHours(),
        minute: wall.getUTCMinutes(),
        second: wall.getUTCSeconds(),
        isDate: false,
      }),
    );
    component.updatePropertyWithValue('tzoffsetfrom', offset(before));
    component.updatePropertyWithValue('tzoffsetto', offset(after));
    zone.addSubcomponent(component);
    return component;
  };
  const initial = changes[0]?.before ?? zonedOffsetMinutes(new Date(from), timezone) * 60_000;
  observance(from - initial, initial, initial);
  const open = new Map<string, ZoneRun>();
  const runs: ZoneRun[] = [];
  for (const change of changes) {
    const wall = new Date(change.at + change.before);
    const year = wall.getUTCFullYear();
    const month = wall.getUTCMonth() + 1;
    const day = wall.getUTCDate();
    const weekday = WEEKDAYS[wall.getUTCDay()] as string;
    const days = [`${Math.ceil(day / 7)}${weekday}`];
    if (day > new Date(Date.UTC(year, month, 0)).getUTCDate() - 7) days.push(`-1${weekday}`);
    const kind = `${change.before}|${change.after}|${month}|${wall.getTime() % DAY_MS}`;
    const run = open.get(kind);
    const shared = run?.days.filter((value) => days.includes(value)) ?? [];
    if (run && run.lastYear === year - 1 && shared.length > 0) {
      run.changes.push(change);
      run.days = shared;
      run.lastYear = year;
    } else {
      const started = { changes: [change], days, lastYear: year };
      open.set(kind, started);
      runs.push(started);
    }
  }
  for (const run of runs) {
    const first = run.changes[0] as ZoneTransition;
    const last = run.changes[run.changes.length - 1] as ZoneTransition;
    const running = run.lastYear >= toYear;
    if (run.changes.length >= 3 || (run.changes.length === 2 && !running)) {
      const month = new Date(first.at + first.before).getUTCMonth() + 1;
      const until = running
        ? ''
        : `;UNTIL=${ICAL.Time.fromJSDate(new Date(last.at), true).toICALString()}`;
      observance(first.at, first.before, first.after).updatePropertyWithValue(
        'rrule',
        ICAL.Recur.fromString(`FREQ=YEARLY;BYMONTH=${month};BYDAY=${run.days[0]}${until}`),
      );
    } else {
      for (const change of run.changes) observance(change.at, change.before, change.after);
    }
  }
  return zone;
}

/** Deterministic RFC 5545 + iTIP payload, validated by the installed ical.js implementation. */
export function emitITipCalendar(input: ICalendarEvent, method: ITipMethod): string {
  try {
    const uid = requiredIdentity(input.uid);
    const sequence = input.sequence ?? 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new CalendarContractError('invalid_icalendar');
    }
    if (!new Set<ITipMethod>(['PUBLISH', 'REQUEST', 'REPLY', 'CANCEL']).has(method)) {
      throw new CalendarContractError('invalid_icalendar');
    }
    if (input.status === 'cancelled' && method !== 'CANCEL') {
      throw new CalendarContractError('invalid_icalendar');
    }
    const status = input.status === 'cancelled' || method === 'CANCEL' ? 'cancelled' : input.status;
    const contentInput: CalendarEventContent = {
      start: input.start,
      end: input.end,
      timezone: input.timezone ?? 'UTC',
      summary: input.summary,
    };
    if (input.description !== undefined) contentInput.description = input.description;
    if (input.location !== undefined) contentInput.location = input.location;
    if (status !== undefined && status !== 'cancelled') contentInput.status = status;
    if (input.transparency !== undefined) contentInput.transparency = input.transparency;
    if (input.organizer !== undefined) contentInput.organizer = input.organizer;
    if (input.attendees !== undefined) contentInput.attendees = input.attendees;
    if (input.reminders !== undefined) contentInput.reminders = input.reminders;
    if (input.recurrence !== undefined) contentInput.recurrence = input.recurrence;
    const event = normalizeCalendarEventContent(contentInput);
    if (method === 'REQUEST' && (!event.organizer || !event.attendees?.length)) {
      throw new CalendarContractError('invalid_icalendar');
    }
    if (method === 'REPLY' && (!event.organizer || event.attendees?.length !== 1)) {
      throw new CalendarContractError('invalid_icalendar');
    }

    const updatedAt = instant(input.updatedAt ?? event.start);
    if (updatedAt.getUTCMilliseconds() !== 0) {
      throw new CalendarContractError('invalid_icalendar');
    }
    const calendar = new ICAL.Component(['vcalendar', [], []]);
    calendar.updatePropertyWithValue('prodid', '-//Slotlock Project//Agent Calendar//EN');
    calendar.updatePropertyWithValue('version', '2.0');
    calendar.updatePropertyWithValue('calscale', 'GREGORIAN');
    calendar.updatePropertyWithValue('method', method);
    calendar.updatePropertyWithValue('x-wr-timezone', event.timezone);
    const masterParams: Parameters<typeof eventComponent>[0] = {
      event,
      uid,
      sequence,
      updatedAt,
      includeRecurrence: true,
    };
    if (status !== undefined) masterParams.status = status;
    const events = [eventComponent(masterParams)];
    // A series whose first instance starts in the second pass of a repeated hour has a DTSTART
    // reading as the first pass: an override puts the instance at its own instants, unless an
    // exception already does.
    const firstInstance =
      event.recurrence && !wallTimeNames(event.start, event.timezone)
        ? zonedDateTimeToUtc(zonedDateTimeFields(event.start, event.timezone), event.timezone)
        : undefined;
    const exceptions = [...(event.recurrence?.exceptions ?? [])];
    if (
      firstInstance &&
      !exceptions.some((exception) => exception.recurrenceId.getTime() === event.start.getTime())
    ) {
      exceptions.push({ recurrenceId: event.start, start: event.start, end: event.end });
    }
    for (const exception of exceptions) {
      const exceptionEvent: CalendarEventContent = { ...event };
      delete exceptionEvent.recurrence;
      if (exception.start && exception.end) {
        exceptionEvent.start = exception.start;
        exceptionEvent.end = exception.end;
      } else {
        exceptionEvent.start = exception.recurrenceId;
        exceptionEvent.end = new Date(
          exception.recurrenceId.getTime() + event.end.getTime() - event.start.getTime(),
        );
      }
      const exceptionParams: Parameters<typeof eventComponent>[0] = {
        event: exceptionEvent,
        uid,
        sequence,
        updatedAt,
        recurrenceId:
          firstInstance && exception.recurrenceId.getTime() === event.start.getTime()
            ? firstInstance
            : exception.recurrenceId,
      };
      const exceptionStatus = exception.cancelled ? 'cancelled' : status;
      if (exceptionStatus !== undefined) exceptionParams.status = exceptionStatus;
      events.push(eventComponent(exceptionParams));
    }
    // RFC 5545 §3.6.5: a VTIMEZONE covering every year the event's times fall in, and a series'
    // rule's (to its UNTIL, else thirty years on).
    const zoned = events.some((component) =>
      component.getAllProperties().some((property) => property.getParameter('tzid')),
    );
    if (zoned) {
      const times = [event.start, event.end];
      for (const exception of exceptions) {
        times.push(exception.recurrenceId);
        if (exception.start) times.push(exception.start);
        if (exception.end) times.push(exception.end);
      }
      const years = times.map((time) => time.getUTCFullYear());
      const fromYear = Math.min(...years) - 1;
      let toYear = Math.max(...years) + 1;
      if (event.recurrence) {
        const until = ICAL.Recur.fromString(event.recurrence.rrule).until;
        toYear = until ? Math.max(toYear, until.year + 1) : toYear + VTIMEZONE_SERIES_YEARS;
      }
      const lastYear = Math.min(toYear, fromYear + MAX_VTIMEZONE_YEARS);
      calendar.addSubcomponent(vtimezoneComponent(event.timezone, fromYear, lastYear));
    }
    for (const component of events) calendar.addSubcomponent(component);
    const output = `${calendar
      .toString()
      .replace(/\r?\n/g, '\r\n')
      .replace(/\r\n?$/, '')}\r\n`;
    if (Buffer.byteLength(output, 'utf8') > MAX_ICAL_INPUT_BYTES) {
      throw new CalendarContractError('invalid_icalendar');
    }
    // A real-library round trip catches an invalid property before provider delivery.
    new ICAL.Component(ICAL.parse(output));
    return output;
  } catch (error) {
    if (error instanceof CalendarContractError) throw error;
    throw new CalendarContractError('invalid_icalendar');
  }
}

/** Backwards-compatible feed helper. Cancellation maps to iTIP CANCEL. */
export function emitICalendar(input: ICalendarEvent): string {
  return emitITipCalendar(input, input.status === 'cancelled' ? 'CANCEL' : 'PUBLISH');
}

function mailAddress(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!/^mailto:/i.test(text)) throw new CalendarContractError('invalid_icalendar');
  return normalizeEmail(text.replace(/^mailto:/i, ''));
}

function optionalPropertyText(component: ICAL.Component, name: string): string | undefined {
  const value = component.getFirstPropertyValue(name);
  if (value === null || value === undefined) return undefined;
  return boundedText(String(value), MAX_TRUSTED_TEXT_BYTES, false);
}

const PARSED_ROLES: Record<string, CalendarAttendeeRole> = {
  CHAIR: 'chair',
  'REQ-PARTICIPANT': 'required',
  'OPT-PARTICIPANT': 'optional',
  'NON-PARTICIPANT': 'non_participant',
};
const PARSED_PARTICIPATION: Record<string, CalendarParticipationStatus> = {
  'NEEDS-ACTION': 'needs_action',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  TENTATIVE: 'tentative',
  DELEGATED: 'delegated',
};

function parseAttendees(component: ICAL.Component): CalendarAttendee[] {
  const properties = component.getAllProperties('attendee');
  if (properties.length > MAX_TRUSTED_ATTENDEES)
    throw new CalendarContractError('invalid_icalendar');
  return properties.map((property) => {
    const attendee: CalendarAttendee = { email: mailAddress(property.getFirstValue()) };
    const name = property.getFirstParameter('cn');
    if (name) attendee.name = requiredEventText(name, 'invalid_icalendar');
    const role = property.getFirstParameter('role');
    if (role) {
      const parsed = PARSED_ROLES[role.toUpperCase()];
      if (!parsed) throw new CalendarContractError('invalid_icalendar');
      attendee.role = parsed;
    }
    const partstat = property.getFirstParameter('partstat');
    if (partstat) {
      const parsed = PARSED_PARTICIPATION[partstat.toUpperCase()];
      if (!parsed) throw new CalendarContractError('invalid_icalendar');
      attendee.participationStatus = parsed;
    }
    const rsvp = property.getFirstParameter('rsvp');
    if (rsvp) {
      if (rsvp.toUpperCase() !== 'TRUE' && rsvp.toUpperCase() !== 'FALSE') {
        throw new CalendarContractError('invalid_icalendar');
      }
      attendee.rsvp = rsvp.toUpperCase() === 'TRUE';
    }
    return attendee;
  });
}

function parseOrganizer(component: ICAL.Component): CalendarOrganizer | undefined {
  const properties = component.getAllProperties('organizer');
  if (properties.length > 1) throw new CalendarContractError('invalid_icalendar');
  const property = properties[0];
  if (!property) return undefined;
  const organizer: CalendarOrganizer = { email: mailAddress(property.getFirstValue()) };
  const name = property.getFirstParameter('cn');
  if (name) organizer.name = requiredEventText(name, 'invalid_icalendar');
  return organizer;
}

function parseReminders(component: ICAL.Component): CalendarReminder[] {
  const alarms = component.getAllSubcomponents('valarm');
  if (alarms.length > MAX_TRUSTED_REMINDERS) throw new CalendarContractError('invalid_icalendar');
  return alarms.map((alarm) => {
    const action = String(alarm.getFirstPropertyValue('action') ?? '').toLowerCase();
    if (action !== 'display' && action !== 'email') {
      throw new CalendarContractError('invalid_icalendar');
    }
    const triggerProperty = alarm.getFirstProperty('trigger');
    const trigger = triggerProperty?.getFirstValue();
    const related = triggerProperty?.getFirstParameter('related');
    if (related && related.toUpperCase() !== 'START') {
      throw new CalendarContractError('invalid_icalendar');
    }
    if (!trigger || typeof trigger !== 'object' || !('toSeconds' in trigger)) {
      throw new CalendarContractError('invalid_icalendar');
    }
    const seconds = (trigger as { toSeconds(): number }).toSeconds();
    if (!Number.isSafeInteger(seconds) || seconds > 0 || seconds % 60 !== 0) {
      throw new CalendarContractError('invalid_icalendar');
    }
    return { action, minutesBeforeStart: Math.abs(seconds / 60) };
  });
}

/**
 * An all-day series is stored with local-midnight DATE-TIME bounds, so a DATE `UNTIL` becomes that
 * day's local midnight as DATE-TIME (RFC 5545 §3.3.10: UNTIL shares DTSTART's type, in UTC when
 * zoned): exactly the last allowed start.
 */
function allDayRecurrenceRule(rule: string, timezone: string): string {
  const recur = ICAL.Recur.fromString(rule);
  const until = recur.until;
  if (until?.isDate) {
    recur.until = ICAL.Time.fromJSDate(
      zonedDateTimeToUtc({ year: until.year, month: until.month, day: until.day }, timezone),
      true,
    );
  }
  return recur.toString();
}

/**
 * Parse full, trusted event content: deliberately a different API from parseICalendarChanges, whose
 * result can never carry summaries, participants or notes. All-day events become local-midnight
 * bounds in `calendarTimezone`, else X-WR-TIMEZONE; with neither they are refused.
 */
export function parseTrustedICalendarEvents(
  input: string,
  calendarTimezone?: string,
): TrustedICalendarEvent[] {
  try {
    boundInput(input);
    const budget = new RecurrenceBudget(FEED_LIMITS);
    const root = new ICAL.Component(ICAL.parse(input));
    if (root.name !== 'vcalendar') throw new CalendarContractError('invalid_icalendar');
    let Budgeted: typeof ICAL.RecurIterator | undefined;
    budgetTimezoneRules(root, () => (Budgeted ??= budgetedRecurIterator(budget)));
    budgetTimezoneCoverage(root, budget);
    const timeValue = (value: unknown, zone: unknown, fallback: string | undefined) =>
      calendarTimeValue(value, zone, fallback);
    const embeddedTimezone = root.getFirstPropertyValue('x-wr-timezone');
    const defaultTimezone =
      calendarTimezone?.trim() ||
      (typeof embeddedTimezone === 'string' ? embeddedTimezone.trim() : '') ||
      undefined;
    const components = root.getAllSubcomponents('vevent');
    if (components.length > MAX_ICAL_COMPONENTS) {
      throw new CalendarContractError('invalid_icalendar');
    }
    boundComponents(components);
    // Times are read as a feed's are, so a stored series occupies what the feed reports.
    frameEventTimes(root, components, defaultTimezone, budget);
    const masters = new Map<string, ICAL.Event>();
    const exceptionsByUid = new Map<string, ICAL.Event[]>();
    for (const event of feedEvents(components)) {
      if (event.isRecurrenceException()) {
        const exceptions = exceptionsByUid.get(event.uid) ?? [];
        if (exceptions.length >= MAX_ICAL_EXCEPTIONS_PER_SERIES) {
          throw new CalendarContractError('invalid_icalendar');
        }
        exceptions.push(event);
        exceptionsByUid.set(event.uid, exceptions);
      } else {
        if (masters.has(event.uid)) throw new CalendarContractError('invalid_icalendar');
        masters.set(event.uid, event);
      }
    }
    for (const uid of exceptionsByUid.keys()) {
      if (!masters.has(uid)) throw new CalendarContractError('invalid_icalendar');
    }
    // Every VEVENT's rule as written must be one RFC 5545 §3.3.10 allows: ical.js has already
    // misread some, so the text is read again.
    for (const rule of veventRuleTexts(input)) {
      if (canonicalRecurrenceRule(rule) === null) {
        throw new CalendarContractError('invalid_icalendar');
      }
    }
    for (const component of components) {
      // RFC 5545 §3.6.1: 'dtend' and 'duration' MUST NOT occur in the same eventprop.
      if (component.hasProperty('dtend') && component.hasProperty('duration')) {
        throw new CalendarContractError('invalid_icalendar');
      }
    }
    /** An event's start and end as instants: DTEND as RFC 5545 §3.3.5 reads it, DURATION §3.3.6. */
    const interval = (event: ICAL.Event, fallbackLengthMs?: number) => {
      const component = event.component;
      const startZone = component.getFirstProperty('dtstart')?.getParameter('tzid');
      const reader = zoneReader(event.startDate, startZone, defaultTimezone);
      const startWall = wallFrameOf(event.startDate);
      const start = reader.toInstant(startWall);
      const endProperty = component.getFirstProperty('dtend');
      const duration = component.getFirstPropertyValue('duration');
      let end: number;
      if (endProperty) {
        end = timeValue(
          endProperty.getFirstValue(),
          endProperty.getParameter('tzid') ?? startZone,
          defaultTimezone,
        ).getTime();
      } else if (duration instanceof ICAL.Duration && !event.startDate.isDate) {
        end = durationEnd(reader, startWall, start, duration);
      } else if (fallbackLengthMs !== undefined && !duration) {
        end = start + fallbackLengthMs;
      } else {
        end = timeValue(event.endDate, startZone, defaultTimezone).getTime();
      }
      return { reader, startWall, start, end };
    };
    const trusted: TrustedICalendarEvent[] = [];
    for (const [uid, event] of masters) {
      const component = event.component;
      const startProperty = component.getFirstProperty('dtstart');
      // An all-day event covers whole local days; its end must be a DATE too (§3.6.1), and a
      // DURATION may only count days or weeks.
      const allDay = event.startDate.isDate;
      if (event.endDate.isDate !== allDay) throw new CalendarContractError('invalid_icalendar');
      if (allDay) {
        const duration = component.getFirstPropertyValue('duration');
        if (
          duration instanceof ICAL.Duration &&
          (duration.hours !== 0 || duration.minutes !== 0 || duration.seconds !== 0)
        ) {
          throw new CalendarContractError('invalid_icalendar');
        }
      }
      const timezoneParameter = startProperty?.getParameter('tzid');
      const valueZone = (event.startDate as CalendarTimeValue).zone?.tzid;
      const timezone =
        (typeof timezoneParameter === 'string' ? timezoneParameter.trim() : '') ||
        (valueZone === 'UTC' ? 'UTC' : defaultTimezone);
      if (!timezone) throw new CalendarContractError('invalid_icalendar');
      const statusValue = String(
        component.getFirstPropertyValue('status') ?? 'confirmed',
      ).toLowerCase();
      if (!['confirmed', 'tentative', 'cancelled'].includes(statusValue)) {
        throw new CalendarContractError('invalid_icalendar');
      }
      const transparencyValue = String(
        component.getFirstPropertyValue('transp') ?? 'opaque',
      ).toLowerCase();
      if (transparencyValue !== 'opaque' && transparencyValue !== 'transparent') {
        throw new CalendarContractError('invalid_icalendar');
      }
      const own = interval(event);
      const contentInput: CalendarEventContent = {
        start: new Date(own.start),
        end: new Date(own.end),
        timezone: validTimezone(timezone),
        summary: String(component.getFirstPropertyValue('summary') ?? ''),
        transparency: transparencyValue,
      };
      if (statusValue !== 'cancelled') {
        contentInput.status = statusValue as 'confirmed' | 'tentative';
      }
      const description = optionalPropertyText(component, 'description');
      const location = optionalPropertyText(component, 'location');
      if (description) contentInput.description = description;
      if (location) contentInput.location = location;
      const organizer = parseOrganizer(component);
      if (organizer) contentInput.organizer = organizer;
      const attendees = parseAttendees(component);
      if (attendees.length > 0) contentInput.attendees = attendees;
      const reminders = parseReminders(component);
      if (reminders.length > 0) contentInput.reminders = reminders;
      const rrules = component.getAllProperties('rrule');
      if (
        rrules.length > 1 ||
        component.getAllProperties('rdate').length > 0 ||
        component.getAllProperties('exrule').length > 0
      ) {
        throw new CalendarContractError('invalid_icalendar');
      }
      const rrule = rrules[0]?.getFirstValue();
      if (rrule) {
        // A series is stored as an instant and a zone and recurs at that wall time. A DTSTART the
        // clocks skip has no instant reading as it, so storing it would shift every occurrence an
        // hour: refused.
        if (own.reader.toWall(own.start) !== own.startWall) {
          throw new CalendarContractError('invalid_icalendar');
        }
        // Later occurrences end at the first one's end wall time and last at least as long. A
        // skipped DTEND or a day-counting DURATION across a change would hold an hour the feed does
        // not, so they are refused (days only outside UTC).
        if (!allDay) {
          const endProperty = component.getFirstProperty('dtend');
          const endTime = endProperty?.getFirstValue();
          const startTime = event.startDate;
          const sameZone =
            endTime instanceof ICAL.Time &&
            (ownZone(endTime) ?? endProperty?.getParameter('tzid') ?? timezoneParameter) ===
              (ownZone(startTime) ?? timezoneParameter);
          if (sameZone && own.reader.toWall(own.end) !== wallFrameOf(endTime)) {
            throw new CalendarContractError('invalid_icalendar');
          }
          const duration = component.getFirstPropertyValue('duration');
          if (
            duration instanceof ICAL.Duration &&
            duration.weeks * 7 + duration.days > 0 &&
            own.reader !== UTC_READER
          ) {
            throw new CalendarContractError('invalid_icalendar');
          }
        }
        const lengthMs = own.end - own.start;
        const exceptions = new Map<number, CalendarRecurrenceException>();
        for (const exdateProperty of component.getAllProperties('exdate')) {
          for (const exdate of exdateProperty.getValues()) {
            if (exceptions.size >= MAX_ICAL_EXCEPTIONS_PER_SERIES) {
              throw new CalendarContractError('invalid_icalendar');
            }
            const recurrenceId = timeValue(
              exdate,
              exdateProperty.getParameter('tzid') ?? startProperty?.getParameter('tzid'),
              defaultTimezone,
            );
            exceptions.set(recurrenceId.getTime(), { recurrenceId, cancelled: true });
          }
        }
        for (const exception of exceptionsByUid.get(uid) ?? []) {
          const recurrenceProperty = exception.component.getFirstProperty('recurrence-id');
          const range = recurrenceProperty?.getFirstParameter('range');
          if (range) throw new CalendarContractError('invalid_icalendar');
          // A stored series has one transparency; an instance that differs cannot be stored as is.
          const transparency = String(
            exception.component.getFirstPropertyValue('transp') ?? 'opaque',
          ).toLowerCase();
          if (transparency !== transparencyValue) {
            throw new CalendarContractError('invalid_icalendar');
          }
          const recurrenceId = timeValue(
            exception.recurrenceId,
            recurrenceProperty?.getParameter('tzid') ?? startProperty?.getParameter('tzid'),
            defaultTimezone,
          );
          const cancelled =
            String(exception.component.getFirstPropertyValue('status') ?? '').toLowerCase() ===
            'cancelled';
          // An instance an EXDATE removes but an override describes is the override, as the
          // provider shows it; one with no end lasts its series' length.
          const parsedException: CalendarRecurrenceException = { recurrenceId };
          if (cancelled) {
            parsedException.cancelled = true;
          } else {
            const replacement = interval(exception, lengthMs);
            parsedException.start = new Date(replacement.start);
            parsedException.end = new Date(replacement.end);
          }
          exceptions.set(recurrenceId.getTime(), parsedException);
          if (exceptions.size > MAX_ICAL_EXCEPTIONS_PER_SERIES) {
            throw new CalendarContractError('invalid_icalendar');
          }
        }
        contentInput.recurrence = {
          rrule: allDay ? allDayRecurrenceRule(rrule.toString(), timezone) : rrule.toString(),
          exceptions: [...exceptions.values()],
        };
      } else if (
        component.getAllProperties('exdate').length > 0 ||
        (exceptionsByUid.get(uid)?.length ?? 0) > 0
      ) {
        throw new CalendarContractError('invalid_icalendar');
      }
      let content = normalizeCalendarEventContent(contentInput);
      // An EXDATE or cancellation naming no occurrence frees nothing (RFC 5545 §3.8.5.1), so it is
      // dropped rather than stored. A moved one naming none is busy at its own time, which a stored
      // series cannot hold.
      const recurrence = content.recurrence;
      if (recurrence?.exceptions && recurrence.exceptions.length > 0) {
        const unmatched = unmatchedExceptions(content, budget);
        const named = (exception: CalendarRecurrenceException) =>
          !unmatched.has(exception.recurrenceId.getTime());
        if (recurrence.exceptions.some((exception) => !exception.cancelled && !named(exception))) {
          throw new CalendarContractError('invalid_icalendar');
        }
        const kept = recurrence.exceptions.filter(named);
        content = {
          ...content,
          recurrence:
            kept.length > 0 ? { ...recurrence, exceptions: kept } : { rrule: recurrence.rrule },
        };
      }
      const sequence = Number(component.getFirstPropertyValue('sequence') ?? 0);
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new CalendarContractError('invalid_icalendar');
      }
      const parsed: TrustedICalendarEvent = {
        ...content,
        uid: requiredIdentity(uid),
        sequence,
      };
      if (statusValue === 'cancelled') parsed.status = 'cancelled';
      trusted.push(parsed);
    }
    return trusted;
  } catch (error) {
    if (error instanceof CalendarContractError && error.code === 'invalid_icalendar') throw error;
    throw new CalendarContractError('invalid_icalendar');
  }
}

/**
 * Expand one trusted event into bounded, exception-aware materialization intervals, within
 * EVENT_LIMITS: what a write, or a question about one, may spend.
 */
export function expandCalendarEventOccurrences(
  input: CalendarEventContent,
  window: ICalendarExpansionWindow,
): CalendarEventOccurrence[] {
  return expandOccurrences(input, window, EVENT_LIMITS, null).occurrences;
}

/**
 * The same expansion for a stored series as maintenance rolls it, within FEED_LIMITS (more than a
 * write gets), so a series accepted once keeps rolling as its search grows.
 */
export function expandStoredCalendarEventOccurrences(
  input: CalendarEventContent,
  window: ICalendarExpansionWindow,
): CalendarEventOccurrence[] {
  return expandOccurrences(input, window, FEED_LIMITS, null).occurrences;
}

/**
 * Expand a stored series, resuming from its last cursor when that cursor can vouch for everything
 * it skips, and leave a cursor for the next. Within FEED_LIMITS when maintenance rolls it
 * (`stored`), else EVENT_LIMITS. Anything a cursor cannot serve (other rule, start, zone or
 * ical.js; a window before it; something that could reach the window from before it; malformed) is
 * searched from the start.
 */
export function expandCalendarEventSeries(
  input: CalendarEventContent,
  window: ICalendarExpansionWindow,
  options: {
    cursor: unknown;
    stored: boolean;
    /** Refuse (CalendarExpansionLimitError) instead of searching from the start without a cursor. */
    resumeOnly?: boolean;
  },
): CalendarSeriesExpansion {
  return expandOccurrences(
    input,
    window,
    options.stored ? FEED_LIMITS : EVENT_LIMITS,
    options.cursor,
    options.resumeOnly === true,
  );
}

function expandOccurrences(
  input: CalendarEventContent,
  window: ICalendarExpansionWindow,
  limits: ExpansionLimits,
  cursor: unknown,
  resumeOnly = false,
): CalendarSeriesExpansion {
  try {
    return expandEventOccurrences(input, window, limits, cursor, resumeOnly);
  } catch (error) {
    // A series an earlier Slotlock stored that this one refuses is counted by the roll and keeps
    // its old coverage rather than stopping every series after it. One no Slotlock stored is an
    // error.
    if (
      limits === FEED_LIMITS &&
      error instanceof CalendarContractError &&
      !(error instanceof CalendarExpansionLimitError) &&
      storedByAnEarlierRelease(input)
    ) {
      throw new CalendarExpansionLimitError();
    }
    throw error;
  }
}

/**
 * Whether an earlier Slotlock could have stored `event`: 0.2.0 kept any rule ical.js reads starting
 * with FREQ= (`FREQ=DAILY;COUNT=0`, `FREQ=HOURLY`), in any zone Intl knows (`+05:00` included).
 */
function storedByAnEarlierRelease(event: CalendarEventContent): boolean {
  const rule = event.recurrence?.rrule;
  if (rule !== undefined) {
    if (typeof rule !== 'string') return false;
    const written = rule.trim().toUpperCase();
    if (
      !written.startsWith('FREQ=') ||
      Buffer.byteLength(written, 'utf8') > 4_096 ||
      /[\r\n]/.test(written)
    ) {
      return false;
    }
    try {
      ICAL.Recur.fromString(written);
    } catch {
      return false;
    }
  }
  if (typeof event.timezone !== 'string' || !isKnownTimezone(event.timezone)) return false;
  const { recurrence: _rule, ...rest } = event;
  try {
    normalizeCalendarEventContent({ ...rest, timezone: 'UTC' });
    normalizeExceptions(event.recurrence?.exceptions);
  } catch {
    return false;
  }
  return true;
}

/** The UID a stored series is expanded under: the store's series carry none of their own. */
function seriesUid(event: CalendarEventContent): string {
  return `event-${createHash('sha256')
    .update(`${event.start.toISOString()}|${event.summary}`)
    .digest('hex')}@slotlock.local`;
}

/**
 * The instants of a series' exceptions naming none of its occurrences, searched from its start to
 * the last of them within `budget`, as the store does on write.
 */
function unmatchedExceptions(event: CalendarEventContent, budget: RecurrenceBudget): Set<number> {
  const unmatched = new Set<number>();
  parseCalendarChanges(
    seriesCalendar(event, seriesUid(event)),
    event.timezone,
    { start: event.start, end: new Date(event.start.getTime() + DAY_MS) },
    budget,
    {
      cursor: null,
      resumeLimitMs: Number.NEGATIVE_INFINITY,
      left: null,
      resumed: false,
      resumeOnly: false,
      stored: {
        start: event.start,
        end: event.end,
        exceptions: event.recurrence?.exceptions ?? [],
      },
      unmatched,
    },
  );
  return unmatched;
}

/**
 * Why this Slotlock refuses an event an earlier one stored, or null. Maintenance counts such a
 * series as refused on every roll and leaves its old coverage. Writes nothing, so it can be run
 * over stored events before an upgrade.
 */
export function storedCalendarEventProblem(event: CalendarEventContent): string | null {
  const rule = event.recurrence?.rrule;
  const shape = rule === undefined ? null : recurrenceRuleProblem(rule);
  if (shape !== null) return shape;
  let content: CalendarEventContent;
  try {
    if (rule !== undefined) {
      const recur = ICAL.Recur.fromString(canonicalRecurrenceRule(rule) as string);
      const start = zonedDateTimeFields(event.start, validTimezone(event.timezone));
      const series = seriesShapeProblem(recur, start);
      if (series !== null) return series;
    }
    content = normalizeCalendarEventContent(event);
  } catch (error) {
    if (!(error instanceof CalendarContractError)) throw error;
    return rule === undefined
      ? 'not an event Slotlock stores'
      : 'not a rule Slotlock stores: daily or less often, able to occur, in an IANA time zone';
  }
  if (!content.recurrence?.exceptions?.length) return null;
  let unmatched: Set<number>;
  try {
    unmatched = unmatchedExceptions(content, new RecurrenceBudget(FEED_LIMITS));
  } catch (error) {
    if (error instanceof CalendarExpansionLimitError) {
      return 'its exceptions take more work to check than a roll may spend';
    }
    if (error instanceof CalendarContractError) return 'a series Slotlock cannot expand';
    throw error;
  }
  if (unmatched.size === 0) return null;
  const named = [...unmatched].sort((a, b) => a - b).map((at) => new Date(at).toISOString());
  const which =
    named.length === 1 ? 'an exception that names' : `${named.length} exceptions that name`;
  return `${which} no occurrence: ${named.join(', ')}`;
}

/**
 * The text a stored series is expanded from: DTSTART's wall time in its zone and its rule. The
 * first occurrence and exceptions go as instants instead (SeriesResume.stored): a repeated-hour
 * wall time would name the wrong one.
 */
function seriesCalendar(event: CalendarEventContent, uid: string): string {
  const calendar = new ICAL.Component(['vcalendar', [], []]);
  calendar.updatePropertyWithValue('prodid', '-//Slotlock Project//Agent Calendar//EN');
  calendar.updatePropertyWithValue('version', '2.0');
  const component = new ICAL.Component('vevent');
  component.updatePropertyWithValue('uid', uid);
  component.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(event.start, true));
  addDateTimeProperty(component, 'dtstart', event.start, event.timezone);
  addDateTimeProperty(component, 'dtend', event.end, 'UTC');
  component.updatePropertyWithValue('status', (event.status ?? 'confirmed').toUpperCase());
  component.updatePropertyWithValue(
    'transp',
    event.transparency === 'transparent' ? 'TRANSPARENT' : 'OPAQUE',
  );
  component.updatePropertyWithValue(
    'rrule',
    ICAL.Recur.fromString((event.recurrence as CalendarRecurrence).rrule),
  );
  calendar.addSubcomponent(component);
  return `${calendar.toString().replace(/\r?\n/g, '\r\n')}\r\n`;
}

function expandEventOccurrences(
  input: CalendarEventContent,
  window: ICalendarExpansionWindow,
  limits: ExpansionLimits,
  cursor: unknown,
  resumeOnly: boolean,
): CalendarSeriesExpansion {
  const event = normalizeCalendarEventContent(input);
  if (
    !Number.isFinite(window.start.getTime()) ||
    !Number.isFinite(window.end.getTime()) ||
    window.end <= window.start
  ) {
    throw new CalendarContractError('invalid_icalendar');
  }
  // A one-off event is one occurrence whatever its length, so only recurrence expansion is bounded
  // by the window cap.
  if (!event.recurrence) {
    const occurrences =
      event.end <= window.start || event.start >= window.end
        ? []
        : [{ recurrenceId: event.start.toISOString(), start: event.start, end: event.end }];
    return { occurrences, cursor: null, resumed: false };
  }
  if (window.end.getTime() - window.start.getTime() > MAX_ICAL_WINDOW_MS) {
    throw new CalendarContractError('invalid_icalendar');
  }
  const uid = seriesUid(event);
  // A cursor may stand after an occurrence only if it ends before the window: unmoved, within the
  // series' length (plus a clock change) of its start; moved, where its exception says.
  let resumeLimitMs =
    window.start.getTime() -
    (event.end.getTime() - event.start.getTime()) -
    OCCURRENCE_END_SLACK_MS;
  for (const exception of event.recurrence.exceptions ?? []) {
    if (!exception.cancelled && exception.end && exception.end > window.start) {
      resumeLimitMs = Math.min(resumeLimitMs, exception.recurrenceId.getTime() - 1000);
    }
  }
  const series: SeriesResume = {
    cursor,
    resumeLimitMs,
    left: null,
    resumed: false,
    resumeOnly,
    stored: { start: event.start, end: event.end, exceptions: event.recurrence.exceptions ?? [] },
  };
  const parsed = parseCalendarChanges(
    seriesCalendar(event, uid),
    event.timezone,
    window,
    limits,
    series,
  );
  const occurrences = parsed
    .filter((change) => !change.deleted && change.start && change.end)
    .map((change) => ({
      recurrenceId: change.recurrenceId ?? change.start?.toISOString() ?? '',
      start: change.start as Date,
      end: change.end as Date,
    }))
    .sort((left, right) => left.start.getTime() - right.start.getTime());
  return { occurrences, cursor: series.left, resumed: series.resumed };
}
