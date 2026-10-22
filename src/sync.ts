import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import { zonedDateTimeToUtc } from './timezone.js';
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
const MAX_ICAL_WINDOW_MS = 367 * 24 * 60 * 60 * 1000;
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
 * Steps ical.js may take, in one parse, looking for occurrences. RecurIterator.next() searches for a
 * SECONDLY to WEEKLY rule's next occurrence one step (second, minute, hour, day or week) at a time
 * with no limit, and gives up on a MONTHLY or YEARLY one only when whole months or years fail (not
 * when one matches a part the rule then rules out), so a rule that never occurs
 * (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`, `FREQ=DAILY;INTERVAL=7;BYDAY=TU` from a Monday, or
 * `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYDAY=MO`) held the whole process, and one that almost never
 * does held it for minutes. A real rule takes one to five steps an occurrence (a yearly date written
 * as a daily rule, 365), and MAX_ICAL_WORK bounds the occurrences.
 */
const MAX_ICAL_STEPS = 50_000;
/**
 * And the time a whole parse may take, from before ical.js reads the text to the last occurrence: a
 * step costs from a microsecond (a daily rule) to a millisecond (a WEEKLY rule with a huge INTERVAL,
 * which ical.js walks a day at a time), so a count alone does not bound it, and ical.js does work no
 * step is charged for (relating an exception for every later occurrence reads its time, and so its
 * zone, as the event is built). A busy feed within MAX_ICAL_WORK takes about a fifth of a second
 * (thirty fifth-Monday series since 2000); one stored series' window, a few tens of milliseconds.
 */
const MAX_ICAL_EXPANSION_MS = 1_000;

/** How much one parse may search, in steps and in milliseconds. */
interface ExpansionLimits {
  steps: number;
  ms: number;
}

/** A feed, and a stored series as maintenance rolls it. */
const FEED_LIMITS: ExpansionLimits = { steps: MAX_ICAL_STEPS, ms: MAX_ICAL_EXPANSION_MS };

/**
 * One event as it is written or asked about (expandCalendarEventOccurrences): half of a feed's, so
 * a DAILY or rarer series written today still fits when the roll searches it again from its start
 * for decades (that search grows about a step a day as the window moves; the roll resumes from a
 * cursor instead whenever it has one), and an ordinary series, a few milliseconds, stays far from
 * the time limit however loaded the machine.
 */
const EVENT_LIMITS: ExpansionLimits = {
  steps: MAX_ICAL_STEPS / 2,
  ms: MAX_ICAL_EXPANSION_MS / 2,
};

/** RDATE and EXDATE values one event may list: ical.js sorts them in as it reads them. */
const MAX_ICAL_DATES_PER_EVENT = MAX_ICAL_EXCEPTIONS_PER_SERIES;
/** And a whole feed: each value is a time ical.js resolves, its zone looked up among the feed's. */
const MAX_ICAL_DATES_PER_FEED = 20 * MAX_ICAL_DATES_PER_EVENT;
/**
 * The furthest one step of a SECONDLY to WEEKLY rule may move, in days: about a century. ical.js
 * moves it a day at a time (RecurIterator#increment_monthday) inside one step, which is charged
 * once: `FREQ=DAILY;INTERVAL=1000000000` spent 97 seconds in its second step. A century is 36,600
 * days, about 4 ms.
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
 * The RecurIterator methods a step is charged on. Every step of a search, whatever the frequency,
 * ends in exactly one `next_second` (`next_year`, `next_month`, `next_week` and `next_day` each call
 * `next_hour`, which calls `next_minute`, which calls `next_second`); `expand_year_days` is a YEARLY
 * rule's scan of one year for matching days, which the constructor repeats as far as the year 20000.
 */
const ICAL_STEP_METHODS = ['next_second', 'expand_year_days'] as const;

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

function validTimezone(timezone: string): string {
  const normalized = timezone.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > 255) {
    throw new CalendarContractError('invalid_icalendar');
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: normalized }).format(0);
  } catch {
    throw new CalendarContractError('invalid_icalendar');
  }
  return normalized;
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

/**
 * A recurrence rule as RFC 5545 §3.3.10 writes it, in ical.js's canonical spelling, or `null`.
 * ical.js accepts more than it should: it drops unknown parts, lets a repeated part replace the
 * first, reads `COUNT=3X` as 3 and `COUNT=0` as no count at all. So every part must be one RFC 5545
 * names, appear once and match its grammar, with FREQ present and never UNTIL and COUNT together,
 * and the parts RFC 5545 forbids for a frequency (BYWEEKNO but YEARLY, BYYEARDAY with DAILY, WEEKLY
 * or MONTHLY, BYMONTHDAY with WEEKLY, a numbered BYDAY but MONTHLY or YEARLY) are refused.
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
    return ICAL.Recur.fromString(text).toString();
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
  if (canonical === null) return false;
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

function normalizeRecurrence(
  input: CalendarRecurrence | undefined,
): CalendarRecurrence | undefined {
  if (!input) return undefined;
  const rrule = input.rrule.trim().toUpperCase();
  if (
    !rrule ||
    Buffer.byteLength(rrule, 'utf8') > 4_096 ||
    /[\r\n]/.test(rrule) ||
    !rrule.startsWith('FREQ=')
  ) {
    throw new CalendarContractError('invalid_icalendar');
  }
  try {
    ICAL.Recur.fromString(rrule);
  } catch {
    throw new CalendarContractError('invalid_icalendar');
  }
  const exceptions = normalizeExceptions(input.exceptions);
  const recurrence: CalendarRecurrence = { rrule };
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
  const recurrence = normalizeRecurrence(input.recurrence);
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

function calendarTimeValue(
  value: unknown,
  propertyTimezone: unknown,
  calendarTimezone: string | undefined,
): Date {
  if (!value || typeof value !== 'object' || !('toJSDate' in value)) {
    throw new CalendarContractError('invalid_icalendar');
  }
  const time = value as CalendarTimeValue;
  const zone = typeof propertyTimezone === 'string' ? propertyTimezone.trim() : '';
  const valueZone = time.zone?.tzid?.trim() ?? '';
  if (zone === 'UTC' || valueZone === 'UTC') return time.toJSDate();

  // ical.js intentionally frames floating values as local JS dates. A server process has no
  // legitimate local calendar zone, so resolve wall-clock fields against provider metadata.
  const timezone = zone || calendarTimezone;
  if (timezone) {
    try {
      return zonedDateTimeToUtc(
        {
          year: time.year,
          month: time.month,
          day: time.day,
          hour: time.isDate ? 0 : time.hour,
          minute: time.isDate ? 0 : time.minute,
          second: time.isDate ? 0 : time.second,
        },
        timezone,
      );
    } catch {
      // A standards-compliant embedded VTIMEZONE may use a private TZID that Intl does not know.
      // ical.js resolves that definition itself; an undeclared TZID remains `floating` and cannot
      // reach this fallback.
      if (zone && valueZone === zone && valueZone !== 'floating' && valueZone !== 'local') {
        const resolved = time.toJSDate();
        if (Number.isFinite(resolved.getTime())) return resolved;
      }
      throw new CalendarContractError('invalid_icalendar');
    }
  }
  if (valueZone && valueZone !== 'floating' && valueZone !== 'local') return time.toJSDate();
  throw new CalendarContractError('invalid_icalendar');
}

/**
 * What one parse may spend: steps searching for occurrences, and time from its start. The time is
 * checked at every step and after every piece of ical.js work the parse does, so work that takes no
 * steps is stopped at the next check.
 */
class RecurrenceBudget {
  private steps: number;
  private readonly started = performance.now();

  constructor(private readonly limits: ExpansionLimits) {
    this.steps = limits.steps;
  }

  /** Throw once the parse has run longer than its limit. */
  check(): void {
    if (performance.now() - this.started > this.limits.ms) expansionLimit();
  }

  /**
   * Run one piece of ical.js work, then check the time: building an event's expansion, its next
   * occurrence, or reading a time, which can expand a feed's own time zone.
   */
  search<T>(work: () => T): T {
    const result = work();
    this.check();
    return result;
  }

  /** Charge one step, throwing past either limit. */
  charge(): void {
    this.steps -= 1;
    if (this.steps < 0) expansionLimit();
    this.check();
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
  for (const name of ICAL_STEP_METHODS) {
    const step = inherited[name];
    if (typeof step !== 'function') throw new CalendarContractError('invalid_icalendar');
    own[name] = function (this: unknown, ...args: unknown[]) {
      budget.charge();
      return step.apply(this, args);
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
): ICAL.RecurExpansion {
  for (const property of event.component.getAllProperties('rrule')) {
    budgetRule(property.getFirstValue(), Budgeted);
  }
  const expansion = event.iterator();
  const iterators = (expansion as unknown as { ruleIterators?: unknown }).ruleIterators;
  if (!Array.isArray(iterators) || !iterators.every((iterator) => iterator instanceof Budgeted)) {
    throw new CalendarContractError('invalid_icalendar');
  }
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

/**
 * Refuse a VEVENT that ical.js would spend unbounded work reading, before anything reads its end:
 * a DURATION, or a DTEND after its DTSTART, longer than MAX_ICAL_STEP_DAYS (ical.js adds a span to
 * a time a month at a time, Time#adjust, and `DURATION:PT99999999999999999999S` held the process),
 * a negative DURATION, or more RDATE and EXDATE values than MAX_ICAL_DATES_PER_EVENT. Returns how
 * many it lists, for the feed's own limit.
 */
function boundComponent(component: ICAL.Component): number {
  const maxMs = MAX_ICAL_STEP_DAYS * 24 * 60 * 60 * 1000;
  for (const property of component.getAllProperties('duration')) {
    const duration = property.getFirstValue();
    if (!(duration instanceof ICAL.Duration)) throw new CalendarContractError('invalid_icalendar');
    if (duration.isNegative || duration.toSeconds() * 1000 > maxMs) expansionLimit();
  }
  const start = component.getFirstPropertyValue('dtstart');
  const end = component.getFirstPropertyValue('dtend');
  if (start instanceof ICAL.Time && end instanceof ICAL.Time) {
    // The fields ignore zones, so allow the day they can be out by.
    if (Math.abs(fieldsMs(end) - fieldsMs(start)) > maxMs + 24 * 60 * 60 * 1000) expansionLimit();
  }
  let dates = 0;
  for (const name of ['rdate', 'exdate']) {
    for (const property of component.getAllProperties(name)) dates += valueCount(property);
  }
  if (dates > MAX_ICAL_DATES_PER_EVENT) expansionLimit();
  return dates;
}

/** Bound every VEVENT of a feed, and the date values of all of them together. */
function boundComponents(components: ICAL.Component[], budget: RecurrenceBudget): void {
  let dates = 0;
  for (const component of components) {
    dates += boundComponent(component);
    if (dates > MAX_ICAL_DATES_PER_FEED) expansionLimit();
    budget.check();
  }
}

/**
 * The feed's VEVENTs as ical.js events, each related to no exception yet. Left to itself, ical.js
 * relates every VEVENT with a RECURRENCE-ID in the calendar to every series, whatever its UID, by
 * local time, so one series' cancelled 09:00 cancelled every other series' 09:00 that day; the
 * parsers relate each series' own exceptions themselves.
 */
function feedEvents(components: ICAL.Component[], budget: RecurrenceBudget): ICAL.Event[] {
  return components.map((component) => {
    const event = new ICAL.Event(component, { exceptions: [] });
    budget.check();
    return event;
  });
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
}

/**
 * Charge the time of each expansion of the feed's own zones, and keep one copy of their changes.
 * Whenever ical.js reads a year past what it has expanded a zone to, it expands every observance
 * again from its start and appends all of them to what it already had: 1,000 date values in years
 * six apart, sorted inside one call, expanded a zone of 3,000 changes 1,000 times into 3 million
 * (26 to 35 seconds, 650 MB). Each expansion starts again from DTSTART, so emptying the list first
 * leaves the same changes, once. If ical.js no longer expands zones this way, the feed is refused.
 */
function budgetTimezoneCoverage(root: ICAL.Component, budget: RecurrenceBudget): void {
  for (const component of root.getAllSubcomponents('vtimezone')) {
    const tzid = component.getFirstPropertyValue('tzid');
    if (typeof tzid !== 'string') continue;
    const zone = root.getTimeZoneByID(tzid) as unknown as TimezoneCoverage | null;
    if (!zone) continue;
    const ensure = zone._ensureCoverage;
    if (typeof ensure !== 'function') throw new CalendarContractError('invalid_icalendar');
    zone._ensureCoverage = function (this: TimezoneCoverage, year: number) {
      if (this.changes.length > 0 && this.expandedUntilYear >= year) return;
      budget.check();
      this.changes = [];
      ensure.call(this, year);
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
  return createHash('sha256')
    .update(
      JSON.stringify([
        SERIES_CURSOR_FORMAT,
        ICAL_JS_VERSION,
        (starts[0] as ICAL.Property).toICALString(),
        (rules[0] as ICAL.Property).toICALString(),
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
  return expansion;
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

/** Parse VEVENTs with the standards library; event content is deliberately discarded. */
export function parseICalendarChanges(
  input: string,
  calendarTimezone?: string,
  expansionWindow?: ICalendarExpansionWindow,
): ExternalCalendarChange[] {
  return parseCalendarChanges(input, calendarTimezone, expansionWindow, FEED_LIMITS);
}

function parseCalendarChanges(
  input: string,
  calendarTimezone: string | undefined,
  expansionWindow: ICalendarExpansionWindow | undefined,
  limits: ExpansionLimits,
  series?: SeriesResume,
): ExternalCalendarChange[] {
  try {
    // Bound work before ical.js allocates and normalizes the full component tree. The parsed-tree
    // checks below remain authoritative; these cheap standards-shaped counts are an early DoS guard.
    boundInput(input);
    const budget = new RecurrenceBudget(limits);
    const root = new ICAL.Component(ICAL.parse(input));
    budget.check();
    let Budgeted: typeof ICAL.RecurIterator | undefined;
    const budgeted = () => (Budgeted ??= budgetedRecurIterator(budget));
    budgetTimezoneRules(root, budgeted);
    budgetTimezoneCoverage(root, budget);
    const timeValue = (value: unknown, zone: unknown, fallback: string | undefined) =>
      budget.search(() => calendarTimeValue(value, zone, fallback));
    const embeddedTimezone = root.getFirstPropertyValue('x-wr-timezone');
    const defaultTimezone =
      calendarTimezone?.trim() ||
      (typeof embeddedTimezone === 'string' ? embeddedTimezone.trim() : '') ||
      undefined;
    const components = root.getAllSubcomponents('vevent');
    if (components.length > MAX_ICAL_COMPONENTS) {
      throw new CalendarContractError('invalid_icalendar');
    }
    boundComponents(components, budget);
    const events = feedEvents(components, budget);
    const masters = new Map<string, ICAL.Event>();
    const exceptionsByUid = new Map<string, ICAL.Event[]>();
    for (const event of events) {
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
    for (const [uid, exceptions] of exceptionsByUid) {
      const master = masters.get(uid);
      if (!master) continue;
      for (const exception of exceptions) {
        // An exception for this and every later occurrence (RANGE=THISANDFUTURE) is placed by its
        // time, which reads its zone.
        master.relateException(exception);
        budget.check();
      }
    }

    const normalizeEvent = (
      event: ICAL.Event,
      startValue: unknown,
      endValue: unknown,
      recurrenceValue?: unknown,
    ): ExternalCalendarChange => {
      const component = event.component;
      const startProperty = component.getFirstProperty('dtstart');
      const endProperty = component.getFirstProperty('dtend');
      const recurrenceProperty = component.getFirstProperty('recurrence-id');
      const status = String(component.getFirstPropertyValue('status') ?? 'confirmed').toLowerCase();
      const transparency = String(
        component.getFirstPropertyValue('transp') ?? 'opaque',
      ).toLowerCase();
      const change: ExternalCalendarChangeInput = {
        externalId: event.uid,
        start: timeValue(startValue, startProperty?.getParameter('tzid'), defaultTimezone),
        end: timeValue(
          endValue,
          endProperty?.getParameter('tzid') ?? startProperty?.getParameter('tzid'),
          defaultTimezone,
        ),
        status,
        transparent: transparency === 'transparent',
        sequence: Number(component.getFirstPropertyValue('sequence') ?? 0),
      };
      if (recurrenceValue) {
        change.recurrenceId = timeValue(
          recurrenceValue,
          recurrenceProperty?.getParameter('tzid') ?? startProperty?.getParameter('tzid'),
          defaultTimezone,
        ).toISOString();
      }
      return normalizeExternalCalendarChange(change);
    };

    const changes: ExternalCalendarChange[] = [];
    let remainingWork = MAX_ICAL_WORK;
    for (const event of events) {
      if (event.isRecurrenceException() && masters.has(event.uid)) continue;
      if (!event.isRecurring()) {
        changes.push(
          normalizeEvent(event, event.startDate, event.endDate, event.recurrenceId ?? undefined),
        );
        continue;
      }
      if (
        !expansionWindow ||
        !Number.isFinite(expansionWindow.start.getTime()) ||
        !Number.isFinite(expansionWindow.end.getTime()) ||
        expansionWindow.end <= expansionWindow.start ||
        expansionWindow.end.getTime() - expansionWindow.start.getTime() > MAX_ICAL_WINDOW_MS
      ) {
        throw new CalendarContractError('invalid_icalendar');
      }
      let maxBackwardExceptionShiftMs = 0;
      for (const exception of exceptionsByUid.get(event.uid) ?? []) {
        remainingWork -= 1;
        if (remainingWork < 0) expansionLimit();
        const recurrenceProperty = exception.component.getFirstProperty('recurrence-id');
        const startProperty = exception.component.getFirstProperty('dtstart');
        const originalStart = timeValue(
          exception.recurrenceId,
          recurrenceProperty?.getParameter('tzid'),
          defaultTimezone,
        );
        const movedStart = timeValue(
          exception.startDate,
          startProperty?.getParameter('tzid'),
          defaultTimezone,
        );
        const backwardShiftMs = originalStart.getTime() - movedStart.getTime();
        if (backwardShiftMs > MAX_EXCEPTION_BACKWARD_SHIFT_MS) {
          throw new CalendarContractError('invalid_icalendar');
        }
        // ical.js moves the occurrence by the shift a month at a time (Time#adjust).
        if (-backwardShiftMs > MAX_ICAL_STEP_DAYS * 24 * 60 * 60 * 1000) expansionLimit();
        maxBackwardExceptionShiftMs = Math.max(maxBackwardExceptionShiftMs, backwardShiftMs);
      }
      const recurrenceScanEndMs = expansionWindow.end.getTime() + maxBackwardExceptionShiftMs;
      // A stored series (the only master) resumes from its cursor when the cursor is this series'
      // and stands where the window needs nothing before it, and leaves one for the next window.
      const key = series && masters.size === 1 ? seriesKey(event.component) : null;
      const kept = key === null ? null : readSeriesCursor(series?.cursor, key);
      const usable =
        kept !== null && series !== undefined && kept.position <= series.resumeLimitMs
          ? kept
          : null;
      const startZone = event.component.getFirstProperty('dtstart')?.getParameter('tzid');
      // The occurrences in the window from `resume` (or the start), and the cursor to keep; null
      // when `resume` does not fit this series.
      const expand = (resume: CalendarSeriesCursor | null) => {
        const iterator = budget.search(() =>
          resume
            ? resumedExpansion(event, budgeted(), resume)
            : budgetedExpansion(event, budgeted()),
        );
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
        const found: ExternalCalendarChange[] = [];
        let position = resume?.position;
        let snapshot = resume;
        let leaving = key !== null;
        while (true) {
          remainingWork -= 1;
          if (remainingWork < 0) expansionLimit();
          // Before the next step, everything the iterator has passed may end before the window:
          // then this is where the next expansion can start.
          if (leaving && key !== null && series && position !== undefined) {
            if (position <= series.resumeLimitMs)
              snapshot = snapshotSeries(iterator, key, position);
            else leaving = false;
          }
          const occurrence = budget.search(() => iterator.next());
          if (!occurrence) break;
          const occurrenceStart = timeValue(occurrence, startZone, defaultTimezone);
          position = occurrenceStart.getTime();
          if (occurrenceStart.getTime() >= recurrenceScanEndMs) break;
          const details = event.getOccurrenceDetails(occurrence);
          const start = timeValue(
            details.startDate,
            details.item.component.getFirstProperty('dtstart')?.getParameter('tzid'),
            defaultTimezone,
          );
          const end = timeValue(
            details.endDate,
            details.item.component.getFirstProperty('dtend')?.getParameter('tzid') ??
              details.item.component.getFirstProperty('dtstart')?.getParameter('tzid'),
            defaultTimezone,
          );
          if (end > expansionWindow.start && start < expansionWindow.end) {
            found.push(
              normalizeEvent(details.item, details.startDate, details.endDate, occurrence),
            );
            if (changes.length + found.length > MAX_ICAL_OCCURRENCES) expansionLimit();
          }
        }
        return { found, snapshot };
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
      if (series && key !== null) {
        series.resumed = resumed;
        series.left = keptSeriesCursor(expanded.snapshot);
      }
    }
    return changes;
  } catch (error) {
    if (error instanceof CalendarContractError) throw error;
    throw new CalendarContractError('invalid_icalendar');
  }
}

function requiredEventText(value: string, code: CalendarContractError['code']): string {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > MAX_TRUSTED_SUMMARY_BYTES) {
    throw new CalendarContractError(code);
  }
  return normalized;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(value: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(value)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: (values.hour ?? 0) % 24,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
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
    property.setValue(ICAL.Time.fromData({ ...partsInZone(value, timezone), isDate: false }));
  }
  component.addProperty(property);
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
  addDateTimeProperty(component, 'dtstart', params.event.start, params.event.timezone);
  addDateTimeProperty(component, 'dtend', params.event.end, params.event.timezone);
  if (params.recurrenceId) {
    addDateTimeProperty(component, 'recurrence-id', params.recurrenceId, params.event.timezone);
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
    calendar.addSubcomponent(eventComponent(masterParams));
    for (const exception of event.recurrence?.exceptions ?? []) {
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
        recurrenceId: exception.recurrenceId,
      };
      const exceptionStatus = exception.cancelled ? 'cancelled' : status;
      if (exceptionStatus !== undefined) exceptionParams.status = exceptionStatus;
      calendar.addSubcomponent(eventComponent(exceptionParams));
    }
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
    budget.check();
    let Budgeted: typeof ICAL.RecurIterator | undefined;
    budgetTimezoneRules(root, () => (Budgeted ??= budgetedRecurIterator(budget)));
    budgetTimezoneCoverage(root, budget);
    const timeValue = (value: unknown, zone: unknown, fallback: string | undefined) =>
      budget.search(() => calendarTimeValue(value, zone, fallback));
    const embeddedTimezone = root.getFirstPropertyValue('x-wr-timezone');
    const defaultTimezone =
      calendarTimezone?.trim() ||
      (typeof embeddedTimezone === 'string' ? embeddedTimezone.trim() : '') ||
      undefined;
    const components = root.getAllSubcomponents('vevent');
    if (components.length > MAX_ICAL_COMPONENTS) {
      throw new CalendarContractError('invalid_icalendar');
    }
    boundComponents(components, budget);
    const masters = new Map<string, ICAL.Event>();
    const exceptionsByUid = new Map<string, ICAL.Event[]>();
    for (const event of feedEvents(components, budget)) {
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
    const trusted: TrustedICalendarEvent[] = [];
    for (const [uid, event] of masters) {
      const component = event.component;
      const startProperty = component.getFirstProperty('dtstart');
      const endProperty = component.getFirstProperty('dtend');
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
      const contentInput: CalendarEventContent = {
        start: timeValue(event.startDate, startProperty?.getParameter('tzid'), defaultTimezone),
        end: timeValue(
          event.endDate,
          endProperty?.getParameter('tzid') ?? startProperty?.getParameter('tzid'),
          defaultTimezone,
        ),
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
        const exceptions: CalendarRecurrenceException[] = [];
        for (const exdateProperty of component.getAllProperties('exdate')) {
          for (const exdate of exdateProperty.getValues()) {
            if (exceptions.length >= MAX_ICAL_EXCEPTIONS_PER_SERIES) {
              throw new CalendarContractError('invalid_icalendar');
            }
            exceptions.push({
              recurrenceId: timeValue(
                exdate,
                exdateProperty.getParameter('tzid') ?? startProperty?.getParameter('tzid'),
                defaultTimezone,
              ),
              cancelled: true,
            });
          }
        }
        for (const exception of exceptionsByUid.get(uid) ?? []) {
          if (exceptions.length >= MAX_ICAL_EXCEPTIONS_PER_SERIES) {
            throw new CalendarContractError('invalid_icalendar');
          }
          const recurrenceProperty = exception.component.getFirstProperty('recurrence-id');
          const range = recurrenceProperty?.getFirstParameter('range');
          if (range) throw new CalendarContractError('invalid_icalendar');
          const recurrenceId = timeValue(
            exception.recurrenceId,
            recurrenceProperty?.getParameter('tzid') ?? startProperty?.getParameter('tzid'),
            defaultTimezone,
          );
          const cancelled =
            String(exception.component.getFirstPropertyValue('status') ?? '').toLowerCase() ===
            'cancelled';
          const parsedException: CalendarRecurrenceException = { recurrenceId };
          if (cancelled) parsedException.cancelled = true;
          const replacementStart = timeValue(
            exception.startDate,
            exception.component.getFirstProperty('dtstart')?.getParameter('tzid'),
            defaultTimezone,
          );
          const replacementEnd = timeValue(
            exception.endDate,
            exception.component.getFirstProperty('dtend')?.getParameter('tzid') ??
              exception.component.getFirstProperty('dtstart')?.getParameter('tzid'),
            defaultTimezone,
          );
          if (
            replacementStart.getTime() !== recurrenceId.getTime() ||
            replacementEnd.getTime() - replacementStart.getTime() !==
              contentInput.end.getTime() - contentInput.start.getTime()
          ) {
            parsedException.start = replacementStart;
            parsedException.end = replacementEnd;
          }
          exceptions.push(parsedException);
        }
        contentInput.recurrence = {
          rrule: allDay ? allDayRecurrenceRule(rrule.toString(), timezone) : rrule.toString(),
          exceptions,
        };
      } else if (
        component.getAllProperties('exdate').length > 0 ||
        (exceptionsByUid.get(uid)?.length ?? 0) > 0
      ) {
        throw new CalendarContractError('invalid_icalendar');
      }
      const content = normalizeCalendarEventContent(contentInput);
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
    if (error instanceof CalendarContractError) throw error;
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
  const uid = `event-${createHash('sha256')
    .update(`${event.start.toISOString()}|${event.summary}`)
    .digest('hex')}@slotlock.local`;
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
  const series: SeriesResume = { cursor, resumeLimitMs, left: null, resumed: false, resumeOnly };
  const parsed = parseCalendarChanges(
    emitITipCalendar({ ...event, uid, sequence: 0 }, 'PUBLISH'),
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
