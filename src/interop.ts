// Calendar interchange in the standards' own shapes: a resource's weekly bookable hours as an
// iCalendar VAVAILABILITY (RFC 7953), read and written, and a calendar event as a JSCalendar Event
// (RFC 8984). Pure functions: the application API serves them, and an application may call them
// directly.
import ICAL from 'ical.js';
import { zonedDateTimeFields } from './timezone.js';
import type { SlotlockCalendarEvent, WeeklyAvailabilityRule } from './types.js';
import { parseAvailabilityRules } from './weekly-hours.js';

/** The longest VAVAILABILITY text `parseVAvailability` reads. */
export const SLOTLOCK_MAX_VAVAILABILITY_CHARACTERS = 65_536;
const PRODID = '-//Pylota//Slotlock//EN';
const CRLF = '\r\n';
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
/** 2024-01-07 is a Sunday: the reference week runs Sunday 7 to Saturday 13 January. */
const REFERENCE_SUNDAY = Date.UTC(2024, 0, 7);
const VAVAILABILITY_DTSTAMP = '20240101T000000Z';

function invalidAvailability(message: string): Error & { code: 'invalid_availability' } {
  return Object.assign(new Error(message), { code: 'invalid_availability' as const });
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** RFC 5545 §3.1: lines of at most 75 octets, continued with a leading space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Never split a UTF-8 sequence: back up over continuation bytes.
    while (end < bytes.length && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return parts.join(`${CRLF} `);
}

/** The first day of the reference week the rule's BYDAY names, so DTSTART is its first occurrence. */
function referenceDay(rrule: string): Date {
  const byDay = /(?:^|;)BYDAY=([^;]*)/.exec(rrule)?.[1] ?? '';
  const named = byDay.split(',').map((day) => day.slice(-2));
  const index = DAYS.findIndex((day) => named.includes(day));
  return new Date(REFERENCE_SUNDAY + Math.max(index, 0) * 86_400_000);
}

export interface EmitVAvailabilityOptions {
  /** The resource's weekly rules, in `timezone`. */
  rules: readonly WeeklyAvailabilityRule[];
  /** The IANA zone the rules are read in: every DTSTART names it as its TZID. */
  timezone: string;
  /** The VAVAILABILITY's UID; each AVAILABLE's is this with its index. */
  uid: string;
}

/**
 * A VCALENDAR with one VAVAILABILITY holding an AVAILABLE per rule: DTSTART on the rule's first day
 * in a reference week of January 2024, with the IANA zone as TZID (no VTIMEZONE: RFC 7809 lets the
 * two sides agree on IANA names), DURATION and the rule's RRULE. `[]` is a VAVAILABILITY with no
 * AVAILABLE: never bookable. CRLF line endings, folded at 75 octets.
 */
export function emitVAvailability({ rules, timezone, uid }: EmitVAvailabilityOptions): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'BEGIN:VAVAILABILITY',
    `UID:${uid}`,
    `DTSTAMP:${VAVAILABILITY_DTSTAMP}`,
  ];
  rules.forEach((rule, index) => {
    const day = referenceDay(rule.rrule);
    const hour = Math.floor(rule.startMinutes / 60);
    const minute = rule.startMinutes % 60;
    lines.push(
      'BEGIN:AVAILABLE',
      `UID:${uid}-${index}`,
      `DTSTAMP:${VAVAILABILITY_DTSTAMP}`,
      `DTSTART;TZID=${timezone}:${day.getUTCFullYear()}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}T${pad(hour)}${pad(minute)}00`,
      `DURATION:PT${rule.durationMinutes}M`,
      `RRULE:${rule.rrule}`,
      'END:AVAILABLE',
    );
  });
  lines.push('END:VAVAILABILITY', 'END:VCALENDAR');
  return `${lines.map(fold).join(CRLF)}${CRLF}`;
}

export interface ParsedVAvailability {
  /** The TZID every AVAILABLE named, `UTC` for UTC times, or null when they are all floating. */
  timezone: string | null;
  rules: WeeklyAvailabilityRule[];
}

type Component = InstanceType<typeof ICAL.Component>;

/** The one property `name` of `component`, refusing a repeat. */
function single(component: Component, name: string) {
  const properties = component.getAllProperties(name);
  if (properties.length > 1) throw invalidAvailability(`An AVAILABLE has more than one ${name.toUpperCase()}`);
  return properties[0] ?? null;
}

/**
 * Weekly rules from an iCalendar VAVAILABILITY (RFC 7953): one VAVAILABILITY, each AVAILABLE a
 * weekly RRULE with a time of day and a length. Refuses (`invalid_availability`) what weekly
 * rules cannot say: a VAVAILABILITY bounded by DTSTART or DTEND, more than one, an AVAILABLE
 * without RRULE, with RDATE, EXDATE or RECURRENCE-ID, a whole-day DTSTART, seconds, AVAILABLEs in
 * different zones, and any rule `parseAvailabilityRules` refuses. An RRULE without BYDAY takes
 * DTSTART's day, as RFC 5545 reads it.
 */
export function parseVAvailability(text: string): ParsedVAvailability {
  if (text.length > SLOTLOCK_MAX_VAVAILABILITY_CHARACTERS) {
    throw invalidAvailability(
      `The iCalendar text is longer than ${SLOTLOCK_MAX_VAVAILABILITY_CHARACTERS} characters`,
    );
  }
  let root: Component;
  try {
    root = new ICAL.Component(ICAL.parse(text) as unknown[]);
  } catch {
    throw invalidAvailability('The text is not iCalendar');
  }
  const availabilities =
    root.name === 'vavailability' ? [root] : root.getAllSubcomponents('vavailability');
  if (availabilities.length !== 1) {
    throw invalidAvailability('The iCalendar text needs exactly one VAVAILABILITY');
  }
  const availability = availabilities[0] as Component;
  if (availability.hasProperty('dtstart') || availability.hasProperty('dtend')) {
    throw invalidAvailability('A VAVAILABILITY bounded by DTSTART or DTEND cannot be weekly hours');
  }
  const zones = new Set<string | null>();
  const rules = availability.getAllSubcomponents('available').map((available, index) => {
    for (const name of ['rdate', 'exdate', 'recurrence-id']) {
      if (available.hasProperty(name)) {
        throw invalidAvailability(`AVAILABLE ${index} has ${name.toUpperCase()}: weekly hours cannot say it`);
      }
    }
    const dtstart = single(available, 'dtstart');
    const rrule = single(available, 'rrule');
    if (!dtstart || !rrule) throw invalidAvailability(`AVAILABLE ${index} needs DTSTART and RRULE`);
    const start = dtstart.getFirstValue() as InstanceType<typeof ICAL.Time>;
    if (start.isDate) throw invalidAvailability(`AVAILABLE ${index} starts on a date, not a time`);
    if (start.second !== 0) throw invalidAvailability(`AVAILABLE ${index} starts at a second`);
    const tzid = dtstart.getParameter('tzid');
    zones.add(typeof tzid === 'string' ? tzid : start.zone === ICAL.Timezone.utcTimezone ? 'UTC' : null);

    let durationMinutes: number;
    const dtend = single(available, 'dtend');
    const duration = single(available, 'duration');
    if (dtend && duration) throw invalidAvailability(`AVAILABLE ${index} has both DTEND and DURATION`);
    if (duration) {
      const seconds = (duration.getFirstValue() as InstanceType<typeof ICAL.Duration>).toSeconds();
      durationMinutes = seconds / 60;
    } else if (dtend) {
      if (dtend.getParameter('tzid') !== dtstart.getParameter('tzid')) {
        throw invalidAvailability(`AVAILABLE ${index} ends in another zone than it starts`);
      }
      // Both are wall times in one zone: their difference is the window's length on the clock.
      const end = dtend.getFirstValue() as InstanceType<typeof ICAL.Time>;
      durationMinutes = (wallSeconds(end) - wallSeconds(start)) / 60;
    } else {
      throw invalidAvailability(`AVAILABLE ${index} needs DTEND or DURATION`);
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1) {
      throw invalidAvailability(`AVAILABLE ${index} does not last a whole number of minutes`);
    }

    let value = String(rrule.getFirstValue() as InstanceType<typeof ICAL.Recur>);
    if (!/(?:^|;)BYDAY=/.test(value)) {
      value = `${value};BYDAY=${DAYS[start.dayOfWeek() - 1]}`;
    }
    return { rrule: value, startMinutes: start.hour * 60 + start.minute, durationMinutes };
  });
  if (zones.size > 1) throw invalidAvailability('The AVAILABLEs are in different time zones');
  const [timezone = null] = zones;
  return { timezone, rules: parseAvailabilityRules(rules) };
}

const wallSeconds = (time: InstanceType<typeof ICAL.Time>) =>
  Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second) / 1000;

// ---------------------------------------------------------------------------------------------
// JSCalendar (RFC 8984)
// ---------------------------------------------------------------------------------------------

/** A JSCalendar Event object (RFC 8984 §5.1): the properties Slotlock fills. */
export interface JSCalendarEvent {
  '@type': 'Event';
  uid: string;
  updated: string;
  created: string;
  sequence: number;
  prodId: string;
  title: string;
  description?: string;
  start: string;
  timeZone: string;
  duration: string;
  status: 'confirmed' | 'tentative';
  freeBusyStatus: 'free' | 'busy';
  locations?: Record<string, { '@type': 'Location'; name: string }>;
  participants?: Record<string, JSCalendarParticipant>;
  alerts?: Record<string, JSCalendarAlert>;
  recurrenceRules?: JSCalendarRecurrenceRule[];
  recurrenceOverrides?: Record<string, { excluded: true } | { start: string; duration: string }>;
  /** The RRULE the recurrence was written as, kept verbatim (RFC 8984 §3.3 vendor property). */
  'slotlock.pylota.io:rrule'?: string;
}

export interface JSCalendarParticipant {
  '@type': 'Participant';
  name?: string;
  email: string;
  sendTo: { imip: string };
  roles: Record<string, true>;
  participationStatus?: 'needs-action' | 'accepted' | 'declined' | 'tentative' | 'delegated';
  expectReply?: boolean;
}

export interface JSCalendarAlert {
  '@type': 'Alert';
  trigger: { '@type': 'OffsetTrigger'; offset: string; relativeTo: 'start' };
  action: 'display' | 'email';
}

export interface JSCalendarRecurrenceRule {
  '@type': 'RecurrenceRule';
  frequency: 'yearly' | 'monthly' | 'weekly' | 'daily' | 'hourly' | 'minutely' | 'secondly';
  interval?: number;
  firstDayOfWeek?: string;
  byDay?: { '@type': 'NDay'; day: string; nthOfPeriod?: number }[];
  byMonthDay?: number[];
  byMonth?: string[];
  byYearDay?: number[];
  byWeekNo?: number[];
  byHour?: number[];
  byMinute?: number[];
  bySecond?: number[];
  bySetPosition?: number[];
  count?: number;
  until?: string;
}

/** An instant as a LocalDateTime (RFC 8984 §1.4.4) on the wall clock of `timezone`. */
function localDateTime(instant: Date, timezone: string): string {
  const wall = zonedDateTimeFields(instant, timezone);
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
}

/** An exact length as an RFC 8984 Duration of hours, minutes and seconds. */
function exactDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (total === 0) return 'PT0S';
  return `PT${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}${seconds ? `${seconds}S` : ''}`;
}

const FREQUENCIES = new Set(['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY', 'SECONDLY']);
const NUMBER_PARTS: Record<string, keyof JSCalendarRecurrenceRule> = {
  BYMONTHDAY: 'byMonthDay',
  BYYEARDAY: 'byYearDay',
  BYWEEKNO: 'byWeekNo',
  BYHOUR: 'byHour',
  BYMINUTE: 'byMinute',
  BYSECOND: 'bySecond',
  BYSETPOS: 'bySetPosition',
};

/**
 * An RRULE as a JSCalendar RecurrenceRule (RFC 8984 §4.3.3), or null when it holds a part the
 * mapping does not know (the verbatim RRULE is exported beside it either way). A UTC UNTIL becomes
 * the wall time in `timezone`; a date UNTIL the end of that day.
 */
export function recurrenceRuleFromRRule(rrule: string, timezone: string): JSCalendarRecurrenceRule | null {
  const parts = new Map<string, string>();
  for (const part of rrule.split(';')) {
    const [key, value] = part.split('=');
    if (!key || value === undefined || parts.has(key.toUpperCase())) return null;
    parts.set(key.toUpperCase(), value);
  }
  const frequency = parts.get('FREQ');
  if (!frequency || !FREQUENCIES.has(frequency)) return null;
  const rule: JSCalendarRecurrenceRule = {
    '@type': 'RecurrenceRule',
    frequency: frequency.toLowerCase() as JSCalendarRecurrenceRule['frequency'],
  };
  const integers = (value: string) => {
    const list = value.split(',').map(Number);
    return list.every(Number.isInteger) ? list : null;
  };
  for (const [key, value] of parts) {
    if (key === 'FREQ') continue;
    if (key === 'INTERVAL' || key === 'COUNT') {
      const amount = Number(value);
      if (!Number.isInteger(amount) || amount < 1) return null;
      rule[key === 'INTERVAL' ? 'interval' : 'count'] = amount;
    } else if (key === 'WKST') {
      if (!/^(MO|TU|WE|TH|FR|SA|SU)$/.test(value)) return null;
      rule.firstDayOfWeek = value.toLowerCase();
    } else if (key === 'BYDAY') {
      const days = value.split(',').map((entry) => /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(entry));
      if (days.some((match) => match === null)) return null;
      rule.byDay = days.map((match) => {
        const [, nth, day] = match as RegExpExecArray;
        return {
          '@type': 'NDay' as const,
          day: (day as string).toLowerCase(),
          ...(nth ? { nthOfPeriod: Number(nth) } : {}),
        };
      });
    } else if (key === 'BYMONTH') {
      if (!/^\d{1,2}(,\d{1,2})*$/.test(value)) return null;
      rule.byMonth = value.split(',').map((month) => String(Number(month)));
    } else if (key in NUMBER_PARTS) {
      const list = integers(value);
      if (!list) return null;
      (rule as unknown as Record<string, number[]>)[NUMBER_PARTS[key] as string] = list;
    } else if (key === 'UNTIL') {
      const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
      if (!match) return null;
      const [, year, month, day, hour, minute, second, utc] = match;
      if (hour === undefined) rule.until = `${year}-${month}-${day}T23:59:59`;
      else if (utc) {
        rule.until = localDateTime(
          new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))),
          timezone,
        );
      } else rule.until = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
    } else {
      return null;
    }
  }
  return rule;
}

const ROLES: Record<string, Record<string, true>> = {
  chair: { attendee: true, chair: true },
  required: { attendee: true },
  optional: { attendee: true, optional: true },
  non_participant: { informational: true },
};

/**
 * A Slotlock calendar event as a JSCalendar Event (RFC 8984): its id as `uid`, its revision as
 * `sequence`, start as a LocalDateTime in its zone with an exact duration, the organizer an
 * `owner` participant, reminders `OffsetTrigger` alerts before the start, and the recurrence as
 * `recurrenceRules` with `recurrenceOverrides` keyed by each exception's original start.
 */
export function toJSCalendarEvent(event: SlotlockCalendarEvent): JSCalendarEvent {
  const output: JSCalendarEvent = {
    '@type': 'Event',
    uid: event.id,
    updated: event.updatedAt.toISOString(),
    created: event.createdAt.toISOString(),
    sequence: event.revision,
    prodId: PRODID,
    title: event.summary,
    start: localDateTime(event.start, event.timezone),
    timeZone: event.timezone,
    duration: exactDuration(event.end.getTime() - event.start.getTime()),
    status: event.status ?? 'confirmed',
    freeBusyStatus: event.transparency === 'transparent' ? 'free' : 'busy',
  };
  if (event.description !== undefined) output.description = event.description;
  if (event.location !== undefined) {
    output.locations = { l1: { '@type': 'Location', name: event.location } };
  }
  const participants: Record<string, JSCalendarParticipant> = {};
  if (event.organizer) {
    participants.p0 = {
      '@type': 'Participant',
      ...(event.organizer.name !== undefined ? { name: event.organizer.name } : {}),
      email: event.organizer.email,
      sendTo: { imip: `mailto:${event.organizer.email}` },
      roles: { owner: true },
    };
  }
  (event.attendees ?? []).forEach((attendee, index) => {
    const participant: JSCalendarParticipant = {
      '@type': 'Participant',
      ...(attendee.name !== undefined ? { name: attendee.name } : {}),
      email: attendee.email,
      sendTo: { imip: `mailto:${attendee.email}` },
      roles: ROLES[attendee.role ?? 'required'] ?? { attendee: true },
    };
    if (attendee.participationStatus !== undefined) {
      participant.participationStatus =
        attendee.participationStatus === 'needs_action' ? 'needs-action' : attendee.participationStatus;
    }
    if (attendee.rsvp !== undefined) participant.expectReply = attendee.rsvp;
    participants[`p${index + 1}`] = participant;
  });
  if (Object.keys(participants).length > 0) output.participants = participants;
  if (event.reminders && event.reminders.length > 0) {
    output.alerts = Object.fromEntries(
      event.reminders.map((reminder, index) => [
        `a${index + 1}`,
        {
          '@type': 'Alert' as const,
          trigger: {
            '@type': 'OffsetTrigger' as const,
            offset: reminder.minutesBeforeStart === 0 ? 'PT0S' : `-PT${reminder.minutesBeforeStart}M`,
            relativeTo: 'start' as const,
          },
          action: reminder.action,
        },
      ]),
    );
  }
  if (event.recurrence) {
    output['slotlock.pylota.io:rrule'] = event.recurrence.rrule;
    const rule = recurrenceRuleFromRRule(event.recurrence.rrule, event.timezone);
    if (rule) output.recurrenceRules = [rule];
    const exceptions = event.recurrence.exceptions ?? [];
    if (exceptions.length > 0) {
      output.recurrenceOverrides = Object.fromEntries(
        exceptions.map((exception) => [
          localDateTime(exception.recurrenceId, event.timezone),
          exception.cancelled || !exception.start || !exception.end
            ? { excluded: true as const }
            : {
                start: localDateTime(exception.start, event.timezone),
                duration: exactDuration(exception.end.getTime() - exception.start.getTime()),
              },
        ]),
      );
    }
  }
  return output;
}
