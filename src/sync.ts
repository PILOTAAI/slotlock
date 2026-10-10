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

const MAX_ICAL_INPUT_BYTES = 2_000_000;
const MAX_ICAL_OCCURRENCES = 2_000;
const MAX_ICAL_COMPONENTS = 2_000;
const MAX_ICAL_EXCEPTIONS_PER_SERIES = 1_000;
const MAX_ICAL_WORK = 4_000;
const MAX_ICAL_WINDOW_MS = 367 * 24 * 60 * 60 * 1000;
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

/**
 * A recurrence rule as RFC 5545 §3.3.10 writes it, in ical.js's canonical spelling, or `null`.
 * ical.js accepts more than it should: it drops unknown parts, lets a repeated part replace the
 * first, reads `COUNT=3X` as 3 and `COUNT=0` as no count at all. So every part must be one RFC 5545
 * names, appear once and match its grammar, with FREQ present and never UNTIL and COUNT together.
 */
export function canonicalRecurrenceRule(rule: string): string | null {
  const text = rule.trim().toUpperCase();
  if (!text || text.length > 2_000) return null;
  const seen = new Set<string>();
  for (const part of text.split(';')) {
    const equals = part.indexOf('=');
    const key = part.slice(0, equals);
    const pattern = RECUR_RULE_PARTS.get(key);
    if (equals <= 0 || !pattern || seen.has(key) || !pattern.test(part.slice(equals + 1))) {
      return null;
    }
    seen.add(key);
  }
  if (!seen.has('FREQ') || (seen.has('UNTIL') && seen.has('COUNT'))) return null;
  try {
    return ICAL.Recur.fromString(text).toString();
  } catch {
    return null;
  }
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

/** Parse VEVENTs with the standards library; event content is deliberately discarded. */
export function parseICalendarChanges(
  input: string,
  calendarTimezone?: string,
  expansionWindow?: ICalendarExpansionWindow,
): ExternalCalendarChange[] {
  try {
    // Bound work before ical.js allocates and normalizes the full component tree. The parsed-tree
    // check below remains authoritative; this cheap standards-shaped count is an early DoS guard.
    if (
      Buffer.byteLength(input, 'utf8') > MAX_ICAL_INPUT_BYTES ||
      (input.match(/^BEGIN:VEVENT\r?$/gim)?.length ?? 0) > MAX_ICAL_COMPONENTS
    ) {
      throw new CalendarContractError('invalid_icalendar');
    }
    const root = new ICAL.Component(ICAL.parse(input));
    const embeddedTimezone = root.getFirstPropertyValue('x-wr-timezone');
    const defaultTimezone =
      calendarTimezone?.trim() ||
      (typeof embeddedTimezone === 'string' ? embeddedTimezone.trim() : '') ||
      undefined;
    const components = root.getAllSubcomponents('vevent');
    if (components.length > MAX_ICAL_COMPONENTS) {
      throw new CalendarContractError('invalid_icalendar');
    }
    const events = components.map((component) => new ICAL.Event(component));
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
      if (master) for (const exception of exceptions) master.relateException(exception);
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
        start: calendarTimeValue(startValue, startProperty?.getParameter('tzid'), defaultTimezone),
        end: calendarTimeValue(
          endValue,
          endProperty?.getParameter('tzid') ?? startProperty?.getParameter('tzid'),
          defaultTimezone,
        ),
        status,
        transparent: transparency === 'transparent',
        sequence: Number(component.getFirstPropertyValue('sequence') ?? 0),
      };
      if (recurrenceValue) {
        change.recurrenceId = calendarTimeValue(
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
        if (remainingWork < 0) throw new CalendarContractError('invalid_icalendar');
        const recurrenceProperty = exception.component.getFirstProperty('recurrence-id');
        const startProperty = exception.component.getFirstProperty('dtstart');
        const originalStart = calendarTimeValue(
          exception.recurrenceId,
          recurrenceProperty?.getParameter('tzid'),
          defaultTimezone,
        );
        const movedStart = calendarTimeValue(
          exception.startDate,
          startProperty?.getParameter('tzid'),
          defaultTimezone,
        );
        const backwardShiftMs = originalStart.getTime() - movedStart.getTime();
        if (backwardShiftMs > MAX_EXCEPTION_BACKWARD_SHIFT_MS) {
          throw new CalendarContractError('invalid_icalendar');
        }
        maxBackwardExceptionShiftMs = Math.max(maxBackwardExceptionShiftMs, backwardShiftMs);
      }
      const recurrenceScanEndMs = expansionWindow.end.getTime() + maxBackwardExceptionShiftMs;
      const iterator = event.iterator();
      while (true) {
        remainingWork -= 1;
        if (remainingWork < 0) throw new CalendarContractError('invalid_icalendar');
        const occurrence = iterator.next();
        if (!occurrence) break;
        const occurrenceStart = calendarTimeValue(
          occurrence,
          event.component.getFirstProperty('dtstart')?.getParameter('tzid'),
          defaultTimezone,
        );
        if (occurrenceStart.getTime() >= recurrenceScanEndMs) break;
        const details = event.getOccurrenceDetails(occurrence);
        const start = calendarTimeValue(
          details.startDate,
          details.item.component.getFirstProperty('dtstart')?.getParameter('tzid'),
          defaultTimezone,
        );
        const end = calendarTimeValue(
          details.endDate,
          details.item.component.getFirstProperty('dtend')?.getParameter('tzid') ??
            details.item.component.getFirstProperty('dtstart')?.getParameter('tzid'),
          defaultTimezone,
        );
        if (end > expansionWindow.start && start < expansionWindow.end) {
          changes.push(
            normalizeEvent(details.item, details.startDate, details.endDate, occurrence),
          );
          if (changes.length > MAX_ICAL_OCCURRENCES) {
            throw new CalendarContractError('invalid_icalendar');
          }
        }
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
    if (
      Buffer.byteLength(input, 'utf8') > MAX_ICAL_INPUT_BYTES ||
      (input.match(/^BEGIN:VEVENT\r?$/gim)?.length ?? 0) > MAX_ICAL_COMPONENTS
    ) {
      throw new CalendarContractError('invalid_icalendar');
    }
    const root = new ICAL.Component(ICAL.parse(input));
    const embeddedTimezone = root.getFirstPropertyValue('x-wr-timezone');
    const defaultTimezone =
      calendarTimezone?.trim() ||
      (typeof embeddedTimezone === 'string' ? embeddedTimezone.trim() : '') ||
      undefined;
    const components = root.getAllSubcomponents('vevent');
    if (components.length > MAX_ICAL_COMPONENTS) {
      throw new CalendarContractError('invalid_icalendar');
    }
    const masters = new Map<string, ICAL.Event>();
    const exceptionsByUid = new Map<string, ICAL.Event[]>();
    for (const component of components) {
      const event = new ICAL.Event(component);
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
        start: calendarTimeValue(
          event.startDate,
          startProperty?.getParameter('tzid'),
          defaultTimezone,
        ),
        end: calendarTimeValue(
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
              recurrenceId: calendarTimeValue(
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
          const recurrenceId = calendarTimeValue(
            exception.recurrenceId,
            recurrenceProperty?.getParameter('tzid') ?? startProperty?.getParameter('tzid'),
            defaultTimezone,
          );
          const cancelled =
            String(exception.component.getFirstPropertyValue('status') ?? '').toLowerCase() ===
            'cancelled';
          const parsedException: CalendarRecurrenceException = { recurrenceId };
          if (cancelled) parsedException.cancelled = true;
          const replacementStart = calendarTimeValue(
            exception.startDate,
            exception.component.getFirstProperty('dtstart')?.getParameter('tzid'),
            defaultTimezone,
          );
          const replacementEnd = calendarTimeValue(
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

/** Expand one trusted event into bounded, exception-aware materialization intervals. */
export function expandCalendarEventOccurrences(
  input: CalendarEventContent,
  window: ICalendarExpansionWindow,
): CalendarEventOccurrence[] {
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
    if (event.end <= window.start || event.start >= window.end) return [];
    return [{ recurrenceId: event.start.toISOString(), start: event.start, end: event.end }];
  }
  if (window.end.getTime() - window.start.getTime() > MAX_ICAL_WINDOW_MS) {
    throw new CalendarContractError('invalid_icalendar');
  }
  const uid = `event-${createHash('sha256')
    .update(`${event.start.toISOString()}|${event.summary}`)
    .digest('hex')}@slotlock.local`;
  const parsed = parseICalendarChanges(
    emitITipCalendar({ ...event, uid, sequence: 0 }, 'PUBLISH'),
    event.timezone,
    window,
  );
  return parsed
    .filter((change) => !change.deleted && change.start && change.end)
    .map((change) => ({
      recurrenceId: change.recurrenceId ?? change.start?.toISOString() ?? '',
      start: change.start as Date,
      end: change.end as Date,
    }))
    .sort((left, right) => left.start.getTime() - right.start.getTime());
}
