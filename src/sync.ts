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
// The store materializes a recurring series for up to 369 days (SLOTLOCK_MATERIALIZATION_WINDOW_DAYS:
// a 367-day search from any moment of the day, plus the day before it).
const MAX_ICAL_WINDOW_MS = 369 * 24 * 60 * 60 * 1000;
/**
 * A feed's own time zones (VTIMEZONE), their STANDARD and DAYLIGHT observances, and the RDATE values
 * those list. A real feed carries one zone per zone its events use, each a few observances (a zone's
 * full history, a few hundred). ical.js expands every observance of a zone again whenever it reads a
 * later year than it has, appending all of them each time, and finds a zone by scanning them all for
 * each value whose TZID it does not know: 40,000 RDATE values ran a feed out of memory, and 20,000
 * zones held one for 31 seconds.
 */
const MAX_ICAL_TIMEZONES = 100;
/**
 * The name and parameters of one property, before its value: ical.js reads each parameter by
 * searching from it to the end of the line for the value, so 490,000 parameters on one line held a
 * parse for 7.9 seconds before anything else ran. A real property has a few parameters; a group
 * attendee listing its members, a few thousand characters.
 */
const MAX_ICAL_PROPERTY_HEAD_BYTES = 8_192;
const MAX_ICAL_PROPERTY_PARAMETERS = 100;
const MAX_ICAL_TIMEZONE_OBSERVANCES = 1_000;
const MAX_ICAL_TIMEZONE_DATES = 2_000;
/**
 * Work ical.js may do, in one parse, looking for occurrences, in steps of about a microsecond each.
 * RecurIterator.next() searches for a SECONDLY to WEEKLY rule's next occurrence one step (second,
 * minute, hour, day or week) at a time with no limit, and gives up on a MONTHLY or YEARLY one only
 * when whole months or years fail (not when one matches a part the rule then rules out), so a rule
 * that never occurs (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`, `FREQ=DAILY;INTERVAL=7;BYDAY=TU` from a
 * Monday) held the whole process, and one that almost never does held it for minutes. Only this
 * count decides, never a clock, so a calendar is read or refused the same way however loaded the
 * machine (ICAL_STEP_CHARGES says what each piece of work costs).
 *
 * A feed, and a stored series as maintenance rolls it, may take half a million: thirty series on the
 * fifth Monday of the month since 2000 take about 350,000.
 */
const MAX_ICAL_STEPS = 500_000;

/** How much one parse may search, in steps. */
interface ExpansionLimits {
  steps: number;
}

/** A feed, and a stored series as maintenance rolls it. */
const FEED_LIMITS: ExpansionLimits = { steps: MAX_ICAL_STEPS };

/**
 * One event as it is written or asked about (expandCalendarEventOccurrences): a tenth of a feed's,
 * so a write is refused within a tenth of a second whatever its rule or zone (fifty writes of one
 * that walks 9,999 days a step held a hosted server for 23 seconds when a write could search for
 * half of one), and a series written today still fits when the roll searches it again from its
 * start for decades (that search grows as the window moves; the roll resumes from a cursor instead
 * whenever it has one). A yearly date written as a daily rule fits from 1990, and from 1950 does
 * not, but rolls.
 */
const EVENT_LIMITS: ExpansionLimits = { steps: 50_000 };

/** RDATE and EXDATE values one event may list: ical.js sorts them in as it reads them. */
const MAX_ICAL_DATES_PER_EVENT = MAX_ICAL_EXCEPTIONS_PER_SERIES;
/** And a whole feed: each value is a time ical.js resolves, its zone looked up among the feed's. */
const MAX_ICAL_DATES_PER_FEED = 20 * MAX_ICAL_DATES_PER_EVENT;
/**
 * The furthest one step of a SECONDLY to WEEKLY rule may move, in days: about a century. ical.js
 * moves it a day at a time (RecurIterator#increment_monthday) inside one step:
 * `FREQ=DAILY;INTERVAL=1000000000` spent 97 seconds in its second step. The days are charged
 * (ICAL_STEP_CHARGES), and a century is 36,600 days, about 7 ms.
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
 * The RecurIterator methods work is charged on, and what each call costs, in steps of about a
 * microsecond (measured on ical.js 2.2.1 under Node 26, with the costliest rule shapes each method
 * serves). Every step of a search, whatever the frequency, ends in exactly one `next_second`
 * (`next_year`, `next_month`, `next_week` and `next_day` each call `next_hour`, which calls
 * `next_minute`, which calls `next_second`), and is followed by a check of the rule's parts: about
 * three microseconds for a DAILY rule with BYMONTH and BYMONTHDAY. `ruleDayOfWeek` reads one BYDAY value, which the
 * searches of a month and a week and the checks of a day do for every day and every value they
 * compare. `increment_monthday` walks its days one at a time, about a fifth of a microsecond each on a
 * 4-vCPU Linux runner under Node 22 (a tenth on the machine the rest was measured on).
 * `expand_year_days` lists the days of one year a YEARLY rule names, which the constructor repeats
 * as far as the year 20000: about three microseconds, and an eighth of one for each day it lists
 * and sorts (`BYMONTH` with 28 `BYMONTHDAY` values, 336 days, about 42). The days of the week
 * through a whole year, which it filters by month and day of the month, it gets from
 * `expand_by_day`: about half a microsecond for each day that lists (all seven weekdays filtered
 * to the 13th, 365 days, about 150). A scan of every day of a month for `BYSETPOS` is charged
 * through `ruleDayOfWeek`, as a day's check is. Outlook writes every zone's observances from 1601
 * as `BYMONTH` with one numbered `BYDAY`, so one zone's 430 years cost about 6,000 steps.
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
 * What Slotlock's own work on what ical.js finds costs, in the same steps: each occurrence an
 * expansion passes (its instant, exceptions and change); each conversion of a time between a zone's
 * wall clock and its instants, half a step in an IANA zone (a few lookups in the offsets timezone.ts
 * keeps a day at a time) and one and a half in a zone only the feed defines (ical.js's list of its
 * changes, searched at each lookup, as ical.js itself searches it at each step); and each instant
 * Intl is asked for to read a day of an IANA zone's offsets (two and a half microseconds on the
 * machine the rest was measured on, and with reading its parts as long again on a 4-vCPU Linux
 * runner, five steps), the first time a budget reads that day. Before these were charged, a series in a named zone ran
 * twenty times as long as the same series in UTC within the same budget.
 */
const OCCURRENCE_STEPS = 1;
const ZONE_READ_STEPS = { conversion: 0.5, ownZone: 1.5, intl: 5 } as const;
/**
 * Each change ical.js lists when it expands one of the feed's own zones (Timezone#_ensureCoverage):
 * it adjusts and sorts every one, about four tenths of a microsecond each, and the steps of the
 * zone's rules are charged besides. Uncharged, a zone at every cap read again for 1,000 later years
 * listed 3 million changes in one call, two seconds on a 4-vCPU Linux runner within the budget.
 */
const ZONE_CHANGE_STEPS = 0.4;

/**
 * What one RecurIterator method costs: charged before it runs, from its arguments, and after, from
 * the days it listed (at most a year's worth, so each call is bounded before it is charged).
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
 * The ical.js release a series cursor holds the iterator state of. A cursor is ical.js's own
 * RecurIterator and RecurExpansion state, which only that release is known to continue exactly, so
 * a cursor another release wrote is ignored and the series searched from its start. A test pins this
 * to the installed package: upgrading ical.js means checking the state these cursors keep again.
 */
export const ICAL_JS_VERSION = '2.2.1';
/** The shape of the cursor this code writes and reads. */
const SERIES_CURSOR_FORMAT = 1;
/** The most a cursor may take as JSON; a bigger one is not kept (its series is searched from the start). */
const MAX_SERIES_CURSOR_BYTES = 16_384;
/**
 * How much later than its start plus the series' length an unmoved occurrence may end: ical.js adds
 * the length in wall-clock time, so a clock change between the two moves the end by up to a few
 * hours. A day covers every zone.
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
 * Where one expansion of a stored series stopped, as plain JSON a store keeps beside it: ical.js's
 * iterator state just before the first occurrence the next window may need, so the next expansion
 * continues there rather than searching again from the series' start.
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
   * The latest occurrence start a cursor may stand after: every occurrence up to it ends before the
   * window, unmoved or wherever an exception moved it, so the window needs none of them.
   */
  resumeLimitMs: number;
  left: CalendarSeriesCursor | null;
  resumed: boolean;
  /** Refuse rather than search from the start when the cursor cannot be used. */
  resumeOnly: boolean;
  /**
   * A stored series' own instants: its first occurrence and its exceptions. Its text gives the
   * iterator DTSTART's wall time and zone, which an instant in an hour the clocks repeat does not
   * survive (01:15 GMT on 25 October 2026 read back as 01:15 BST, an hour early).
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
 * A calendar that needs more work than Slotlock does to read or expand it: steps, time, a step or a
 * span longer than a century, or more occurrences, exceptions or dates than it keeps. Still
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
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > 1024) {
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
  if (!Number.isFinite(parsed.getTime())) {
    throw new CalendarContractError('invalid_external_interval');
  }
  return parsed;
}

function boundedText(value: string, maxBytes: number, required: boolean): string | undefined {
  const normalized = value.trim();
  if ((required && !normalized) || Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw new CalendarContractError('invalid_icalendar');
  }
  return normalized || undefined;
}

/**
 * An event's zone as Slotlock keeps it: an IANA name in one spelling (canonicalTimeZoneName). A UTC
 * offset such as `+05:00` is no zone a calendar can name (RFC 5545 §3.2.19 wants a VTIMEZONE for
 * each TZID, and an offset has no rules), and is refused.
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

/** The longest each month can be, February in a leap year. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** The shortest each month can be, February in a common year. */
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
 * Put a rule's numeric BY lists in ascending order, once each. RFC 5545 §3.3.10 reads each as a set,
 * but ical.js 2.2.1 walks BYHOUR, BYMINUTE, BYSECOND and BYMONTH in the order written:
 * `FREQ=DAILY;BYHOUR=17,8` gave 17:00 and then 08:00 the same day, an hour before it.
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
 * Why ical.js 2.2.1 would expand `recur` other than RFC 5545 §3.3.10 says, or null for a rule it
 * expands correctly. Each refusal is a shape the readiness audit or a check against a brute-force
 * reading of the RFC (the tests' rrule-oracle) found it gets wrong:
 * - BYWEEKNO: unimplemented on its own, and with BYDAY it kept every week but the one named;
 * - a BYDAY ordinal of two digits: read by its last digit (`20MO` as every Monday);
 * - BYSETPOS other than with FREQ=MONTHLY and BYDAY alone: WEEKLY ignored it, others picked wrongly;
 * - BYMONTH with FREQ=MONTHLY: it walked BYMONTH from its first value whatever DTSTART's month,
 *   dropping whole months or repeating them;
 * - a negative BYMONTHDAY except with FREQ=MONTHLY and no BYDAY: compared as written with each day;
 * - BYMONTHDAY with FREQ=YEARLY but no BYMONTH (only DTSTART's month was expanded), naming only
 *   days none of its BYMONTH months has (it searched every year to 20000 for one), or a day one of
 *   them can lack with COUNT (31 April became 1 May, and was counted: yearlyDays filters it out
 *   otherwise) or with BYDAY (BYMONTH=4,5;BYMONTHDAY=30,31;BYDAY=WE missed 31 May 2034);
 * - with FREQ=YEARLY, BYYEARDAY with BYMONTH or BYMONTHDAY (it found no day at all), and a numbered
 *   BYDAY with BYMONTHDAY (counted in the year, not the month);
 * - BYHOUR with FREQ=HOURLY, BYMINUTE or BYSECOND with FREQ=MINUTELY, and any of the three with
 *   FREQ=MONTHLY or YEARLY: it repeated or dropped occurrences (it expands them correctly with
 *   DAILY and WEEKLY, and HOURLY's BYMINUTE and BYSECOND and MINUTELY's BYHOUR);
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
 * Why a rule cannot be expanded from this DTSTART, or null. FREQ=YEARLY with no BYMONTHDAY, BYDAY or
 * BYYEARDAY takes its day from DTSTART, and ical.js put a day its month lacks into the next month
 * (29 February 2024 recurred on 1 March 2025) instead of skipping that year (RFC 5545 §3.3.10).
 * yearlyDays filters those out, but COUNT has already counted them.
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
 * The months and days a FREQ=YEARLY rule's occurrences fall on, when it names a day one of its
 * months can lack (29 February, or a 31st with April), or null. ical.js 2.2.1 moves such a day into
 * the next month (29 February 2025 became 1 March) where RFC 5545 §3.3.10 ignores it, so an
 * occurrence on any other day is not one. With BYYEARDAY it picks real dates already; with BYDAY
 * such a rule is refused (recurShapeProblem).
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
 * A recurrence rule as RFC 5545 §3.3.10 writes it, in ical.js's canonical spelling, or `null`.
 * ical.js accepts more than it should: it drops unknown parts, lets a repeated part replace the
 * first, reads `COUNT=3X` as 3 and `COUNT=0` as no count at all. So every part must be one RFC 5545
 * names, appear once and match its grammar, with FREQ present and never UNTIL and COUNT together,
 * and the parts RFC 5545 forbids for a frequency (BYWEEKNO but YEARLY, BYYEARDAY with DAILY, WEEKLY
 * or MONTHLY, BYMONTHDAY with WEEKLY, a numbered BYDAY but MONTHLY or YEARLY) are refused. The
 * numeric BY lists come back in ascending order (sortRuleParts).
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
 * A rule Slotlock books from an agent: valid as RFC 5545 writes it, daily or less often, and able to
 * occur. ical.js searches day by day (or faster) for a DAILY, HOURLY, MINUTELY or SECONDLY rule's
 * next occurrence with no limit, so one that can never occur (`BYMONTH=2;BYMONTHDAY=30`), or a
 * sub-daily one that rarely does, holds the process forever.
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
 * A stored series' rule: one Slotlock books (isBookableRecurrenceRule: RFC 5545's grammar, daily or
 * less often, able to occur, a shape ical.js expands correctly) for this start, in its canonical
 * spelling. A DATE UNTIL becomes the UTC instant its day ends in the event's zone: RFC 5545
 * §3.3.10 wants a zoned DTSTART's UNTIL in UTC and reads it inclusively, and read as midnight UTC
 * it lost the last day in every zone east of UTC with a morning start.
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
 * How the wall times of one zone map to instants and back: an IANA zone through Intl, a zone only
 * the calendar's own VTIMEZONE defines through its observances, or UTC. Instants and wall times are
 * milliseconds, a wall time framed as UTC.
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
  // A feed names at most MAX_ICAL_TIMEZONES zones it does not define; the readers of all feeds
  // read are kept like the formatters behind them, emptied rather than grown without bound.
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
 * A zone only the calendar defines, read from its own observances. ical.js reads a wall time in
 * such a zone with `want_daylight = false; // TODO` (timezone.js), so a time the clocks repeat named
 * the later instant and one they skip moved back; here the offset in force at each instant comes
 * from the changes ical.js expands (UTC instants, each with the offset before and after it), and a
 * wall time is read from those as from any other zone (wallFrameToInstant).
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

/** One reader per zone a calendar defines, for as long as its parse holds the zone. */
const vtimezoneReaders = new WeakMap<ICAL.Timezone, ZoneReader>();

/**
 * The zone a calendar time is read in: UTC; the IANA zone its TZID (or else the calendar's zone, for
 * a floating time) names; or the calendar's own VTIMEZONE for a TZID Intl does not know. A floating
 * time in a calendar without a zone, or a TZID neither Intl nor the calendar defines, is refused: a
 * server process has no local zone of its own to read it in.
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
    // A standards-compliant embedded VTIMEZONE may use a private TZID that Intl does not know; an
    // undeclared TZID Intl does not know either remains `floating` and cannot reach this.
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
 * Where a DURATION from `start` (wall time `startWall`) ends exactly, RFC 5545 §3.3.6: its weeks and
 * days on the calendar first (the same wall time that many days on), then its hours, minutes and
 * seconds as elapsed time. PT48H is 48 hours however the clocks change; P2D may be 47 or 49.
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
 * The value of every RRULE written inside a VEVENT of `input`, as written: what ical.js has read
 * by then is no longer the text (it read `COUNT=0` as no count, `COUNT=3X` as 3, and the second of
 * two FREQs). A time zone's own rules (inside VTIMEZONE) are not an event's and are left out.
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
 * The instant a calendar time names (zoneReader), RFC 5545 §3.3.5's first instant of a repeated
 * time and a skipped time moved forward, charged to `budget` when one is given. ical.js frames a
 * floating value as a local JS date, which a server process has no business with.
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
 * What one parse may spend: steps searching for occurrences (ICAL_STEP_CHARGES), reading each one
 * it finds, and reading times in their zones (ZONE_READ_STEPS).
 */
class RecurrenceBudget {
  private steps: number;
  /** Each zone's readers as this budget charges them, so a parse's readers stay one per zone. */
  private readonly readers = new Map<ZoneReader, ZoneReader>();
  /**
   * What of each IANA zone's offsets this budget has paid for: the midnight that starts UTC day `d`
   * as `2d`, the changes within day `d` as `2d + 1` (zoneOffsetDay).
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
   * Charge one conversion of a time in `zone` that reads its offsets from `fromMs` to `toMs` (at
   * most three UTC days), and what of those days this budget has not paid for: each midnight, and
   * the search for each day's changes (zoneOffsetChangeReads), as Intl is asked for them with none
   * kept. The process keeps them, but a parse is charged as if it read them now, so what it refuses
   * never depends on what was read before it.
   */
  chargeZoneRead(zone: string | undefined, fromMs: number, toMs: number): void {
    // Without an IANA zone, a reader reads one only the feed defines (UTC's is never charged).
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
 * A RecurIterator subclass, made for one parse, whose every step is charged to `budget` and throws
 * past it. The constructor's own scans (for a YEARLY rule, a year with a matching day, as far as the
 * year 20000) run through these methods on the instance being built, so they are charged too.
 * ical.js itself is not changed for anything else in the process; and if a new ical.js no longer
 * has a method this charges, every recurring event is refused rather than expanded without a limit.
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
 * Make `rule` build `Budgeted` iterators, or refuse it: anything but a parsed rule, or a SECONDLY to
 * WEEKLY one whose step moves further than MAX_ICAL_STEP_DAYS.
 */
function budgetRule(rule: unknown, Budgeted: typeof ICAL.RecurIterator): void {
  if (!(rule instanceof ICAL.Recur)) throw new CalendarContractError('invalid_icalendar');
  const maxInterval = MAX_ICAL_INTERVAL[rule.freq];
  if (maxInterval !== undefined && rule.interval > maxInterval) expansionLimit();
  rule.iterator = (start) => new Budgeted({ rule, dtstart: start });
}

/**
 * `event.iterator()`, with every rule iterator built as `Budgeted`. RecurExpansion builds them from
 * the event's own RRULE values (`rule.iterator(dtstart)`) and takes the first step at once, so the
 * values are changed before it is called: wrapping its iterators afterwards left that step, the
 * one most rules that never occur stop in, unbounded.
 */
function budgetedExpansion(
  event: ICAL.Event,
  Budgeted: typeof ICAL.RecurIterator,
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
  return withEveryRule(expansion);
}

/**
 * `expansion`, choosing among its RRULEs' iterators correctly. ical.js 2.2.1's own choice
 * (RecurExpansion#_nextRecurrenceIter) drops one that has ended by index as it walks them: it
 * skipped the iterator after an ended first one, and for any other removed the one before it,
 * which had not ended, so a series with two RRULEs lost occurrences once either rule ended.
 */
function withEveryRule(expansion: ICAL.RecurExpansion): ICAL.RecurExpansion {
  const state = expansion as unknown as ExpansionState & { _nextRecurrenceIter?: unknown };
  if (typeof state._nextRecurrenceIter !== 'function') {
    throw new CalendarContractError('invalid_icalendar');
  }
  state._nextRecurrenceIter = () => {
    const iterators = state.ruleIterators as IteratorState[];
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

/**
 * How many values a property lists, read from its raw form: reading the values themselves makes
 * ical.js resolve each one's zone.
 */
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
 * Milliseconds since 1970 of a DATE or DATE-TIME property's first value as written, ignoring its
 * zone, or undefined for anything else. Read from the raw form, so nothing resolves a zone yet.
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
 * Refuse a VEVENT that ical.js would spend unbounded work reading, before anything reads its times:
 * a DURATION, or a DTEND after its DTSTART, longer than MAX_ICAL_STEP_DAYS (ical.js adds a span to
 * a time a month at a time, Time#adjust, and `DURATION:PT99999999999999999999S` held the process),
 * a negative DURATION, or more RDATE and EXDATE values than MAX_ICAL_DATES_PER_EVENT. Returns how
 * many it lists, for the feed's own limit. It reads times only as written, so it runs before the
 * times are framed: framing reads every date value, and 115,000 EXDATE values took 11 seconds.
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
 * The feed's VEVENTs as ical.js events, each related to no exception yet. Left to itself, ical.js
 * relates every VEVENT with a RECURRENCE-ID in the calendar to every series, whatever its UID, by
 * local time, so one series' cancelled 09:00 cancelled every other series' 09:00 that day; the
 * parsers relate each series' own exceptions themselves.
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
 * Refuse a property whose name and parameters run past MAX_ICAL_PROPERTY_HEAD_BYTES or list more
 * than MAX_ICAL_PROPERTY_PARAMETERS, as ical.js will read them. ical.js searches again from every
 * parameter for the next `;`, `:` and `"`, so the parameters on a line cost it their number times
 * their length; this finds them the same way, reading each character once.
 */
function boundPropertyHeads(input: string): void {
  const limits = { parameters: MAX_ICAL_PROPERTY_PARAMETERS, end: MAX_ICAL_PROPERTY_HEAD_BYTES };
  for (const head of icalendarPropertyHeads(input, limits)) {
    // A VCARD moves ical.js to the vCard 3 parameters for the rest of the feed, where TYPE takes
    // several quoted values, so what follows would be read differently than counted here. An
    // iCalendar feed has no place for one.
    if (head.begins === 'vcard') throw new CalendarContractError('invalid_icalendar');
    if (head.end > MAX_ICAL_PROPERTY_HEAD_BYTES || head.parameters > MAX_ICAL_PROPERTY_PARAMETERS) {
      expansionLimit();
    }
  }
}

/**
 * Each line of `input` as ical.js 2.2.1's parser takes it, with the parameters it reads there: the
 * lines as parse._eachLine unfolds them, read with the design set ical.js picks at the first BEGIN,
 * and for a BEGIN line the component it begins. Ends at a line before that BEGIN, where ical.js
 * throws. ical.js changes its design set in one other place: a VCARD component's first property
 * (unless it is VERSION:4.0) moves it to vCard 3's for the rest of the feed. This does not follow
 * that move; boundPropertyHeads refuses a feed with a VCARD instead. With `limits`, a line's count
 * stops once it is past them. Exported for the tests, which hold it to ical.js's own reading.
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
 * How many parameters ical.js 2.2.1 reads on one unfolded line and where it stops reading them
 * (parse._handleContentLine, then parse._parseParameters, step for step): a `"` opens a quoted value
 * only straight after `=`, a quoted value of a parameter that takes several (MEMBER, DELEGATED-TO)
 * goes on past `","`, and a `:` ends the parameters only where ical.js looks for one. ical.js throws
 * where this stops early (an empty name, an unclosed quote), and stops once past `limits` if given.
 * Exported for the tests, which hold it to ical.js's own count.
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
 * Give every rule of the feed's own time zones (VTIMEZONE STANDARD and DAYLIGHT) a budgeted
 * iterator, before any time is read. ical.js expands a zone's rule (Timezone#_expandComponent, from
 * the same rule values) whenever it converts a time in a zone Intl does not know, so a private TZID
 * whose rule never occurs held the process on a feed's first event, recurring or not.
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
 * Keep one copy of the changes of each of the feed's own zones (their rules' steps are charged by
 * budgetTimezoneRules). Whenever ical.js reads a year past what it has expanded a zone to, it expands every observance
 * again from its start and appends all of them to what it already had: 1,000 date values in years
 * six apart, sorted inside one call, expanded a zone of 3,000 changes 1,000 times into 3 million
 * (26 to 35 seconds, 650 MB). Each expansion starts again from DTSTART, so emptying the list first
 * leaves the same changes, once, and each expansion is charged for the changes it lists
 * (ZONE_CHANGE_STEPS). If ical.js no longer expands zones this way, the feed is refused.
 * And charge each offset ical.js looks up in such a zone to `budget`, as a conversion in it is: it
 * compares a series' times at every step of its search.
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
 * The key a cursor for this series must carry, or `null` for a series no cursor can serve: one that
 * is not exactly one DTSTART and one RRULE (RDATE and EXDATE values move the expansion's own state,
 * which a cursor does not keep; a stored series never has them).
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
  // Slotlock 0.1 compared a zoned series' occurrences with its UTC UNTIL as if they were UTC, so a
  // cursor it kept for one that ends may have ended an occurrence early or gone one past: such a
  // series has a key of its own now, and those cursors are searched past from the start.
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

/** The expansion's state now, copied: what a cursor would keep if the window needs nothing before it. */
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
 * A snapshot as the store will keep it, or `null`: it must survive JSON whole (a part JSON cannot
 * hold, such as an `undefined` ical.js reads with `in`, would resume a different search) and fit.
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
 * The series' expansion as `cursor` left it: ical.js's RecurExpansion and its one RecurIterator,
 * rebuilt from their state (`initialized`, so the iterator does not search again from DTSTART) with
 * this parse's rule, start and zone, and its steps charged to this parse's budget.
 */
function resumedExpansion(
  event: ICAL.Event,
  Budgeted: typeof ICAL.RecurIterator,
  cursor: CalendarSeriesCursor,
): ICAL.RecurExpansion | null {
  const rule = event.component.getFirstPropertyValue('rrule') as ICAL.Recur;
  budgetRule(rule, Budgeted);
  const dtstart = event.startDate;
  // What a search from the start begins with, built as ical.js builds it (its steps charged too).
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
  return withEveryRule(expansion);
}

/**
 * Whether a cursor's iterator state agrees with `reference`, an iterator ical.js built for the same
 * rule and start: the same BY lists (the rule's, and the start's defaults; BYMONTHDAY holds the
 * current month's days, which ical.js sets as it goes, so only its days are checked), an index
 * within each list, days of the year, and a count and an end the rule allows. Anything else is a
 * cursor no expansion of this rule left, and it is not resumed: an hour of 10^9, say, would have
 * ical.js walk it a month at a time inside one step.
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
  // Days of the year, 1-366, except that a rule with BYYEARDAY alone keeps its values as written,
  // so -366 to -1 count from the end of the year (ical.js expand_year_days).
  if (!state.days.every((day) => Number.isInteger(day) && day !== 0 && Math.abs(day) <= 366)) {
    return false;
  }
  if (rule.count != null && state.occurrence_number > rule.count) return false;
  // Only a rule that ends can have ended.
  if (state.completed && rule.count == null && rule.until == null) return false;
  return true;
}

/**
 * An IANA zone ical.js reads through Intl, for a TZID a calendar names without a VTIMEZONE (RFC
 * 5545 wants one for each; real feeds, and the series Slotlock stores, name IANA zones bare). Left
 * alone, ical.js reads such a time as floating and compares it with UTC values (an UNTIL, EXDATE,
 * RDATE or RECURRENCE-ID) as if it were UTC: a 09:00 Berlin series lost the occurrence its UNTIL
 * named, and a moved or excluded occurrence was not found. Offsets come from the converter the rest
 * of Slotlock reads wall times with: a gap moves forward, a fold takes its first instant.
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
    // A TZID is matched as written (" Europe/Berlin" is that TZID); Slotlock reads its zone trimmed.
    this.zone = tzid.trim();
    this.converter = createTimeZoneConverter(this.zone);
    this.budget = budget;
  }

  override utcOffset(time: ICAL.Time): number {
    const wall = utcFrame(time.year, time.month, time.day, time.hour, time.minute, time.second, 0);
    const wallMs = wall.getTime();
    let offset = this.offsets.get(wallMs);
    if (offset === undefined) {
      // ical.js compares a series' times at every step of its search, each in this zone.
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
 * Whether Intl reads `timezone` (trimmed) as a zone: how a feed's TZID is read, leniently. Asking
 * builds a formatter (about 30 microseconds), and every occurrence of a series asks again, so each
 * name's answer is kept: Intl gives one name the same answer for the life of a process. The map is
 * emptied when it fills, like the formatters (a feed names at most MAX_ICAL_TIMEZONES zones).
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
    // Floating: the wall time is the calendar's own, and so is its date.
    return value.slice(0, 10);
  }
  return jCalDateTime(zonedDateTimeFields(instant, timezone)).slice(0, 10);
}

/**
 * Prepare a calendar's events before anything reads their times, so ical.js compares them at their
 * real instants:
 * - a floating time is framed in the calendar's zone, the zone Slotlock reads it in;
 * - each zone the events name that Intl knows becomes an IntlTimezone, whether or not the feed
 *   defines it; a feed names no more zones it does not define than it may define
 *   (MAX_ICAL_TIMEZONES): 50,000 spellings of one zone, each a zone of its own to ical.js, took
 *   3.4 seconds;
 * - an all-day series' UTC or zoned UNTIL, EXDATE and RECURRENCE-ID become the local dates they
 *   fall on (RFC 5545 wants them as dates; a local midnight east of UTC is the day before in UTC);
 * - a PERIOD RDATE becomes its start, its end kept in the map returned, by event: ical.js orders a
 *   period among times by whether a time falls inside it, and hands back the period itself;
 * - then, every zone resolving, a timed series' own times are aligned (alignSeriesTimes).
 * Every DATE and DATE-TIME value this reads is one boundComponents has counted.
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
    // A zone Intl knows by this name is read through Intl, as calendarTimeValue reads it, even when
    // the feed defines it: ical.js read a stale VTIMEZONE's rules (standard time only) while
    // Slotlock read Intl's, so the two placed one time an hour apart and a moved occurrence was
    // found in a feed but not in the series stored from it.
    if (ICAL.TimezoneService.has(tzid) || !isKnownTimezone(tzid)) continue;
    // ical.js keeps a calendar's zones here; without it, it could not use one of these.
    if (!(cache instanceof Map)) throw new CalendarContractError('invalid_icalendar');
    cache.set(tzid, new IntlTimezone(tzid, budget));
  }
  alignSeriesTimes(components);
  return periods;
}

/**
 * With every zone resolving, put what ical.js compares with a timed series' own times in the terms
 * it compares them in:
 * - a floating UNTIL becomes the UTC instant it names on the series' clock: RFC 5545 §3.3.10 reads
 *   it as DTSTART is read, and ical.js read it as UTC, so a New York series lost its last day;
 * - a RECURRENCE-ID named in another zone becomes the same instant in UTC, which ical.js matches
 *   with an occurrence (it matched one in New York time with none); one for this and every later
 *   occurrence (RANGE=THISANDFUTURE) becomes the series' own wall time instead, since ical.js moves
 *   those by the wall-clock distance from it to the exception's start, read in the start's zone.
 * A DATE EXDATE of a timed series becomes the series' start time that day: ical.js excluded every
 * occurrence that day, and a series stored from the feed, whose exceptions are instants, excluded
 * none (most series occur once a day; one that occurs more keeps the others). And a series of
 * RDATEs with no RRULE gets its DTSTART as one: it is the first instance (RFC 5545 §3.8.2.4), which
 * ical.js left out.
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
        // A DATE UNTIL on a timed series (RFC 5545 §3.3.10 wants DTSTART's value type, and UTC for
        // a zoned one) names its whole day on the series' clock: up to the instant before the
        // next day begins there. Read as midnight UTC, it lost that day in most zones.
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
      // Named in the series' own zone, it is matched by its wall time as it stands.
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
 * nothing: a series Slotlock cannot read refuses the whole calendar, so a caller that reads the
 * result as the calendar's busy time never takes a refused series' time as free. To keep the rest
 * of a calendar when one series is refused, use parseICalendarFeed.
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
 * parseICalendarChanges, refusing one series at a time: a series Slotlock cannot read (a rule
 * shape ical.js expands wrongly, an event whose end the clocks move before its start, DTEND with
 * DURATION, or one that needs more than its budget) is named in `refused` and the rest of the
 * calendar is read. A calendar that is not one (its size, its time zones, a missing UID, a window
 * past 367 days) is still refused whole, with CalendarContractError.
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
    // Bound work before ical.js allocates and normalizes the full component tree. The parsed-tree
    // checks below remain authoritative; these cheap standards-shaped counts are an early DoS guard.
    boundInput(input);
    const budget = limits instanceof RecurrenceBudget ? limits : new RecurrenceBudget(limits);
    const root = new ICAL.Component(ICAL.parse(input));
    // A bare VEVENT (or anything else) would read as a calendar with no events.
    if (root.name !== 'vcalendar') throw new CalendarContractError('invalid_icalendar');
    let Budgeted: typeof ICAL.RecurIterator | undefined;
    const budgeted = () => (Budgeted ??= budgetedRecurIterator(budget));
    budgetTimezoneRules(root, budgeted);
    budgetTimezoneCoverage(root, budget);
    // A time read in a zone of its own (a VTIMEZONE's, or an IntlTimezone) is read in that zone: an
    // RDATE may name another zone than its series' DTSTART, and an occurrence keeps the RDATE's.
    // Every time is read through the budget, which charges its conversions.
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
    // A series is a master and the overrides (RECURRENCE-ID components) that share its UID. Each is
    // read on its own: with `refused`, a series Slotlock cannot read is named there and the rest of
    // the calendar is read; without, it refuses the calendar.
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
     * A change for `start` to `end`, with the status, transparency and sequence of `component`, or
     * null when it has no length: RFC 5545 §3.6.1 ends a DATE-TIME DTSTART without DTEND or DURATION
     * when it starts, so it occupies no time. A cancelled one still says so, with no time.
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
     * How long an event's occurrences last (SPEC.md, "Daylight-saving time"). DTSTART is read as
     * written (the store's own instant for a stored series), DTEND as an instant per RFC 5545 §3.3.5,
     * and a DURATION per §3.3.6: its days on the calendar, its hours, minutes and seconds exact.
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
        // An end the clocks moved onto its start (both in the hour they skip), or before it, is
        // refused: the event as written cannot be read. An end written as its start is no length.
        const sameZone = (ownZone(endTime) ?? endZone) === (ownZone(startTime) ?? startZone);
        const writtenAsStart = wallFrameOf(endTime) === startWall && sameZone;
        if (end < start || (end === start && !writtenAsStart)) {
          throw new CalendarContractError('invalid_icalendar');
        }
        // DTEND's wall time as written, when it is written in DTSTART's zone: one in the hour the
        // clocks skip is carried to later days as written, though its own instant reads an hour
        // later (RFC 5545 §3.3.5). In another zone, or for a stored series (instants), it is the
        // wall time its instant reads in DTSTART's zone.
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
     * The end of a generated occurrence: the later of its exact end and its wall-clock end (DTEND's
     * wall time carried to the occurrence's date, read at the later instant of an hour the clocks
     * repeat). One reading or the other leaves time free that people mean as busy wherever the clocks
     * change inside an occurrence; their union does not.
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
     * An override as Slotlock reads it: the instant of the occurrence it replaces, and its own
     * interval, exact as written. One without DTEND or DURATION lasts its series' length (RFC 5545
     * §3.6.1 alone would end it as it starts, leaving the moved occurrence free).
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
          // Bounded first, as boundComponent bounds a DURATION.
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
     * A series' EXDATEs: the instants its DATE-TIME values name, and the days its DATE values name
     * (one excludes every occurrence that day, as ical.js reads it). ical.js passes them one at a
     * time as it goes, so an occurrence after two EXDATEs it had not passed, or the second of an
     * instant both RRULE and RDATE name, escaped its EXDATE; RFC 5545 §3.8.5.1 has every EXDATE win.
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
      // A server-expanded CalDAV series may send its first instance without a RECURRENCE-ID, and
      // must send every other one with one (RFC 4791 §9.6.5): each is an override of this one-off,
      // and occupies its own time.
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
      // A yearly day some years lack is kept to the days the rule names (yearlyDays), which needs
      // the rule to be the series' only source: ical.js mixes RDATEs and other rules in, and one of
      // those on another day could not be told from a day it moved.
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
      // What one series may pass from its start, so that one series' age never refuses another's.
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
        // ical.js moved an occurrence by the shift a month at a time (Time#adjust); a range
        // override still moves every later one by it.
        if (-backwardShiftMs > MAX_ICAL_STEP_DAYS * DAY_MS) expansionLimit();
        maxBackwardExceptionShiftMs = Math.max(maxBackwardExceptionShiftMs, backwardShiftMs);
        lastOverrideAt = Math.max(lastOverrideAt, override.at);
      }
      const recurrenceScanEndMs = expansionWindow.end.getTime() + maxBackwardExceptionShiftMs;
      // A direct override replaces the occurrence it names; a RANGE=THISANDFUTURE one also moves
      // every later occurrence by its own shift, with its own length.
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
      // A stored series (the only master) resumes from its cursor when the cursor is this series'
      // and stands where the window needs nothing before it, and leaves one for the next window.
      const key = series && groups.size === 1 ? seriesKey(event.component) : null;
      const kept = key === null ? null : readSeriesCursor(series?.cursor, key);
      const usable =
        kept !== null && series !== undefined && kept.position <= series.resumeLimitMs
          ? kept
          : null;
      let periodEnds: Map<number, number> | undefined;
      let exclusions: ReturnType<typeof exclusionsOf> | undefined;
      // A feed's series that repeats every so many days (one RRULE, DAILY or WEEKLY, with no
      // COUNT, RDATE or RANGE=THISANDFUTURE override) repeats the same way from DTSTART moved a
      // whole number of its periods on the wall clock: a WEEKLY rule's weeks stay in step, a DAILY
      // rule's BY parts only limit its days. So its search starts at the last such time from which
      // no occurrence before it could reach the window (it lasts at most its wall-clock or exact
      // length and a day more), and a daily standup since 2014 is read like one from this year.
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
      // The occurrences in the window from `resume` (or the start), and the cursor to keep; null
      // when `resume` does not fit this series.
      const expand = (resume: CalendarSeriesCursor | null) => {
        const iterator = resume
          ? resumedExpansion(event, budgeted(), resume)
          : budgetedExpansion(event, budgeted(), from);
        if (iterator === null) return null;
        // The cursor stands on the occurrence it last passed: the same time, read the same way.
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
        // A stored series' exceptions are checked against every occurrence up to the last of them
        // when it is searched from its start, so one that names no occurrence is refused.
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
        // Each zone the series' times are in is read with one reader for the whole series: an
        // RRULE's occurrences are in DTSTART's zone, an RDATE's in its own.
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
          // Before the next step, everything the iterator has passed may end before the window:
          // then this is where the next expansion can start.
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
          // An instant is one occurrence however many RRULEs and RDATEs name it (RFC 5545
          // §3.8.5.3; ical.js yields it again, and a spring-forward can move a wall time onto one
          // the rule names later), and none where an EXDATE names it.
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
          // A PERIOD RDATE's occurrence ends where its period does.
          const periodEnd = (periodEnds ??= periodEndsOf(event)).get(position);
          const range = periodEnd === undefined ? rangeBefore(at) : undefined;
          let start = at;
          let end: number;
          let component = event.component;
          if (periodEnd !== undefined) {
            end = periodEnd;
          } else if (range) {
            // Moved by the range override's own shift on the wall clock, in its zone (as ical.js
            // moves it), lasting the override's length.
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
          // A cursor ical.js cannot go on from is not this series' to use, like one that does not
          // fit it: search from the start. Running out of budget is the series' own doing.
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
        // An override whose occurrence an EXDATE removes, or that names none, still occupies its
        // own interval, as the provider shows it. A stored exception that names no occurrence is
        // refused wherever this expansion could tell (before the series starts, or before the first
        // occurrence it did not reach), or collected in `series.unmatched` when that is given.
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

    /** A stored series' exception, read from its instants: they are what the store holds. */
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
 * Make one series' busy occurrences, `changes` from `from` on, disjoint without freeing a minute of
 * them: where one ends after the next starts, it ends where the next starts, and the next ends at
 * the later of the two ends. The union rule makes an occurrence of about a day or longer reach
 * into the next one where the clocks go forward (24 exact hours from midnight end at 01:00 the
 * next day), and the store holds each occurrence as a reservation under one EXCLUDE constraint,
 * which refuses two that overlap. Two that start at the same instant are left as they are. An
 * occurrence cut to end before the window is dropped: the next one holds its time there.
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
 * Whether `instant`'s wall time in `timezone` names it again as RFC 5545 §3.3.5 reads a wall time:
 * not for the second pass of an hour the clocks repeat, which reads as the first.
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
  // A series recurs at DTSTART's wall time, so its DTSTART is written in its zone. Any other time
  // is written in its zone only where that wall time names it (wallTimeNames), else in UTC: the
  // second 01:30 of the night the clocks go back reads, in its zone, as the first.
  addDateTimeProperty(
    component,
    'dtstart',
    start,
    recurring || wallTimeNames(start, timezone) ? timezone : 'UTC',
  );
  if (recurring && !wallTimeNames(start, timezone)) {
    // Its length as a DURATION, exact (RFC 5545 §3.3.6), since its DTSTART reads an hour early:
    // emitITipCalendar adds an override that puts the first instance at its own instants.
    component.updatePropertyWithValue(
      'duration',
      ICAL.Duration.fromSeconds((end.getTime() - start.getTime()) / 1000),
    );
  } else {
    addDateTimeProperty(component, 'dtend', end, wallTimeNames(end, timezone) ? timezone : 'UTC');
  }
  if (params.recurrenceId) {
    // In UTC: the instant the occurrence starts names it, wherever the clocks change.
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

/** Changes of a zone already found, by zone and years: Intl answers the same for a process. */
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
 * offset at the start of `fromYear`, then every change (zoneTransitions). Changes in consecutive
 * years on the same weekday of the same month, at the same local time and between the same
 * offsets, are one observance with a yearly rule (`BYMONTH=3;BYDAY=-1SU`), with an UNTIL where they
 * stop; one still running at `toYear` after three years at least is left open, so a reader carries
 * the zone on past `toYear` as the IANA rules do. Any other change is an observance of its own. An
 * observance starts at the local time before the change, as §3.6.5 has it, and offsets are written
 * in whole minutes: ical.js 2.2.1 reads no seconds in one (UtcOffset.fromString).
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
    // A series whose first instance starts in the second pass of an hour the clocks repeat has a
    // DTSTART that reads as the first pass: an override (keyed by that first pass) puts the
    // instance at its own instants, unless an exception already says where it is.
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
    // RFC 5545 §3.6.5: a VTIMEZONE for the zone a time names, over every year the event's times
    // fall in, and a series' rule's (to its UNTIL, else thirty years on, where its rules go on).
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
    // A real-library round trip catches an invalid decorated property before provider delivery.
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
 * An all-day series is stored with local-midnight DATE-TIME bounds, so a DATE `UNTIL` must become
 * the matching DATE-TIME: RFC 5545 §3.3.10 requires UNTIL to share DTSTART's value type, and in UTC
 * when DTSTART carries a zone. The instant chosen is that day's local midnight, which is exactly the
 * start of the last occurrence the rule allows.
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
 * Parse full, trusted event content. This is intentionally a different API from
 * parseICalendarChanges, whose return shape can never carry summaries, participants or notes.
 * All-day (DATE) events are converted to local-midnight bounds in the calendar's timezone: the
 * `calendarTimezone` argument, else the feed's X-WR-TIMEZONE; with neither they are refused.
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
    // Times are read as a feed's are, so a stored series occupies what the feed reports: zones it
    // names without defining them, floating times in the calendar's zone, all-day EXDATEs as days.
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
    // Every VEVENT's rule as written must be one RFC 5545 §3.3.10 allows: ical.js has already read
    // `COUNT=0` as no count, `COUNT=3X` as 3 and the last of two FREQs, so the text is read again.
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
      // An all-day event (DATE-valued DTSTART) covers whole local days of the calendar's zone. Its
      // end must be a DATE too (RFC 5545 §3.6.1), and a DURATION may only count days or weeks.
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
        // A series is stored as an instant and a zone, and recurs at that instant's wall time. A
        // DTSTART the clocks skip (02:30 the night 02:00 becomes 03:00, or an all-day series'
        // midnight where the clocks go forward at midnight, as in Santiago and Havana) has no
        // instant that reads as it, so storing it would move every occurrence an hour: it is
        // refused.
        if (own.reader.toWall(own.start) !== own.startWall) {
          throw new CalendarContractError('invalid_icalendar');
        }
        // Its later occurrences end on the wall clock where its first one's end instant reads, and
        // last at least as long. A DTEND the clocks skip reads an hour later than written, and a
        // DURATION that counts days lasts a day on the calendar, 23 or 25 hours across a change,
        // where the first one's instants say 24: either would hold an hour the feed does not. They
        // are refused (days only outside UTC, where every day is 24 hours).
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
          // A stored series has one transparency; an instance that differs (an opaque instance
          // of a free series, a free one of a busy series) cannot be stored as it is.
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
          // An instance an EXDATE removes but an override still describes is the override, as
          // the provider shows it. One that keeps its time (a new title, a reply) is still kept,
          // and one with no end lasts its series' length.
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
      // An EXDATE or a cancelled instance that names no occurrence frees nothing in the feed (RFC
      // 5545 §3.8.5.1), so it is dropped rather than stored, which the store refuses. A moved one
      // that names none is busy in the feed at its own time, which a stored series cannot hold.
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
    // An event the calendar gives no length or no UID is the calendar's fault, as in a feed.
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
 * The same expansion for a stored series as maintenance rolls it, within FEED_LIMITS: twice what it
 * was written within, so a series accepted once keeps rolling as its search grows.
 */
export function expandStoredCalendarEventOccurrences(
  input: CalendarEventContent,
  window: ICalendarExpansionWindow,
): CalendarEventOccurrence[] {
  return expandOccurrences(input, window, FEED_LIMITS, null).occurrences;
}

/**
 * Expand a stored series, resuming from the cursor its last expansion left when that cursor can
 * vouch for everything it skips, and leave a cursor for the next. Within FEED_LIMITS as maintenance
 * rolls it (`stored`), or EVENT_LIMITS as it is written. Whatever a cursor cannot serve (another
 * rule, start, zone or ical.js; a window starting before it; a longer event or an exception that
 * could reach the window from before it; anything malformed) is searched from the series' start.
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
    // A series stored by an earlier Slotlock that this one refuses (a rule shape it no longer
    // expands, an exception that names no occurrence, a zone written as a UTC offset) is refused as
    // maintenance rolls it, so the roll counts it and the series keeps its old coverage, rather than
    // stopping every series after it. One no Slotlock stored is an error, as it always was.
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
 * Whether a Slotlock before this one could have stored `event`. Slotlock 0.2.0 kept any rule
 * ical.js reads that starts with FREQ= (`FREQ=DAILY;COUNT=0`, `FREQ=HOURLY`), in any zone Intl
 * knows (`+05:00` included), and checked the rest of an event as this release does; a rule such as
 * `FREQ=NEVERLY`, which ical.js cannot read, it refused.
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
 * The instants of a normalized series' exceptions that name none of its occurrences, searched from
 * its start to the last of them within `budget`, as the store searches them when the series is
 * written.
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
 * Why this Slotlock refuses an event an earlier one stored, in words, or null when it expands it.
 * Maintenance counts such a series as refused on every roll and leaves it its old coverage: a rule
 * shape ical.js expands wrongly (recurrenceRuleProblem), COUNT with a yearly day some years lack, a
 * rule it no longer stores at all, or exceptions that name no occurrence (searched from the series'
 * start to the last of them, within a roll's budget). It writes nothing, so it can be run over
 * stored events before an upgrade.
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
 * The text a stored series is expanded from: its DTSTART's wall time in its zone and its rule, for
 * the iterator. Its first occurrence and its exceptions are not read back from text: a wall time
 * in an hour the clocks repeat names its first instant (RFC 5545 §3.3.5) whichever one was stored,
 * so they go to the expansion as the instants they are (SeriesResume.stored).
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
  // A one-off event is one occurrence whatever its length (a multi-year lease included), so only
  // recurrence expansion — whose work grows with the window — is bounded by the window cap.
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
  // A cursor may stand after an occurrence only if that occurrence ends before the window: unmoved,
  // within the series' length (and a clock change) of its start; moved, where its exception says.
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
