// Holiday calendars (RFC 0004 B1): an iCalendar file of days off (a public-holiday feed, a
// company's closures) read as closures. Each all-day VEVENT closes the local days it covers;
// recurring ones are expanded over a bounded span. Timed events are not days off and are skipped.
import { isIP } from 'node:net';
import ICAL from 'ical.js';
import { SLOTLOCK_MAX_EXCEPTION_DAYS, dayToDate, epochDay } from './hours.js';
import { type BoundedICalendar, CalendarExpansionLimitError, parseBoundedICalendar } from './sync.js';
import { isPrivateAddress } from './webhooks.js';

/** The longest holiday calendar Slotlock reads: a megabyte. */
export const SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES = 1_048_576;
/** Closures one import may make. */
export const SLOTLOCK_MAX_HOLIDAY_DAYS = 1_000;
/** How long Slotlock waits for a holiday calendar URL. */
const FETCH_TIMEOUT_MS = 10_000;
const MAX_LABEL = 200;
/** Steps through one recurring event's occurrences, and through all of a calendar's. */
const MAX_STEPS_PER_EVENT = 5_000;
const MAX_STEPS_PER_CALENDAR = 20_000;
const REPEATS_TOO_MUCH = 'The calendar repeats too much to read: give its holidays from a later start';
/**
 * Recurring events one calendar may hold. Each costs ical.js work besides the steps the budget
 * charges (src/sync.ts), so a megabyte of them took about half a second however cheap their rules.
 */
const MAX_RECURRING_EVENTS = 1_000;
/**
 * Repeats a calendar of days off has no use for, refused before they are expanded: ical.js steps a
 * DAILY rule day by day until it finds a day of the month or year that may never come (February
 * 30), and never returns; a rule more often than daily cannot name whole days.
 */
const SUB_DAILY = new Set(['SECONDLY', 'MINUTELY', 'HOURLY']);
const DAILY_FILTERS = ['BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO'];

/** Why a recurrence rule cannot be read here, or null when it can. */
function unreadableRule(rule: unknown): string | null {
  const recur = rule as { freq?: unknown; parts?: Record<string, unknown> } | null;
  const freq = String(recur?.freq ?? '').toUpperCase();
  if (SUB_DAILY.has(freq)) return `it repeats ${freq.toLowerCase()}, and a holiday is a whole day`;
  if (freq === 'DAILY' && DAILY_FILTERS.some((part) => recur?.parts?.[part] !== undefined)) {
    return 'it repeats daily on days of the month or year: repeat it monthly or yearly instead';
  }
  return null;
}

export interface SlotlockHoliday {
  /** The event's UID, with the day for each occurrence of a recurring one: importing again matches it. */
  uid: string;
  startsOn: string;
  endsOn: string;
  label: string;
}

export interface ParsedHolidayCalendar {
  holidays: SlotlockHoliday[];
  /** Events that were not all-day, cancelled, or outside the span. */
  skipped: number;
  /** The calendar's own name (X-WR-CALNAME), when it gives one: at most 200 characters. */
  name?: string;
}

export function invalidHolidayCalendar(message: string): Error & { code: 'invalid_holiday_calendar' } {
  return Object.assign(new Error(message), { code: 'invalid_holiday_calendar' as const });
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');
const dateOf = (time: InstanceType<typeof ICAL.Time>) => `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}`;

/**
 * The days off an iCalendar text names from `from` to `to` (`YYYY-MM-DD`, inclusive): each all-day
 * VEVENT, from DTSTART to the day before DTEND (one day without DTEND or DURATION), and each
 * occurrence of a recurring one. Refuses (`invalid_holiday_calendar`) text that is not iCalendar,
 * more than SLOTLOCK_MAX_HOLIDAY_DAYS holidays, one longer than SLOTLOCK_MAX_EXCEPTION_DAYS, and a
 * calendar that takes more work to read than a calendar feed may (src/sync.ts parseBoundedICalendar).
 * That work is counted in steps, not time, so a calendar is read or refused the same way anywhere,
 * on the Worker too.
 */
export function parseHolidayCalendar(text: string, span: { from: string; to: string }): ParsedHolidayCalendar {
  try {
    return readHolidayCalendar(text, span);
  } catch (error) {
    // Past the parse's budget, wherever ical.js spent it: building an expansion (a YEARLY rule that
    // never occurs walks every year to 20000 before its first step), stepping one, or reading a
    // zone the calendar defines. Counting occurrences alone let one 150-byte event hold the server
    // for seconds, and a megabyte of them for hours.
    if (error instanceof CalendarExpansionLimitError) throw invalidHolidayCalendar(REPEATS_TOO_MUCH);
    throw error;
  }
}

function readHolidayCalendar(text: string, span: { from: string; to: string }): ParsedHolidayCalendar {
  if (Buffer.byteLength(text) > SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES) {
    throw invalidHolidayCalendar('The calendar is larger than a megabyte');
  }
  const first = epochDay(span.from);
  const last = epochDay(span.to);
  if (first === null || last === null || last < first) throw invalidHolidayCalendar('The span is not a range of days');
  // Read with a calendar feed's bounds (src/sync.ts), so that ical.js does bounded work on any
  // text, and every recurring event's expansion, built and stepped, is charged to one budget.
  let calendar: BoundedICalendar;
  try {
    calendar = parseBoundedICalendar(text);
  } catch (error) {
    if (error instanceof CalendarExpansionLimitError) throw invalidHolidayCalendar('The calendar takes too much work to read');
    throw invalidHolidayCalendar('The text is not iCalendar');
  }
  const root = calendar.root;
  if (root.name !== 'vcalendar') throw invalidHolidayCalendar('The text is not a VCALENDAR');
  const holidays: SlotlockHoliday[] = [];
  let skipped = 0;
  let steps = 0;
  let recurring = 0;
  const vevents = root.getAllSubcomponents('vevent');
  // Each series' overrides, found once: ical.js otherwise looks through every event for each
  // event, so a calendar of many events took minutes.
  const overrides = new Map<string, InstanceType<typeof ICAL.Component>[]>();
  for (const component of vevents) {
    if (!component.hasProperty('recurrence-id')) continue;
    const uid = String(component.getFirstPropertyValue('uid') ?? '');
    overrides.set(uid, [...(overrides.get(uid) ?? []), component]);
  }
  const add = (holiday: SlotlockHoliday) => {
    holidays.push(holiday);
    if (holidays.length > SLOTLOCK_MAX_HOLIDAY_DAYS) {
      throw invalidHolidayCalendar(`The calendar names more than ${SLOTLOCK_MAX_HOLIDAY_DAYS} holidays in the span`);
    }
  };
  for (const component of vevents) {
    // An override of one occurrence is read with its series.
    if (component.hasProperty('recurrence-id')) continue;
    const event = new ICAL.Event(component, {
      exceptions: overrides.get(String(component.getFirstPropertyValue('uid') ?? '')) ?? [],
    });
    const start = event.startDate;
    const status = String(component.getFirstPropertyValue('status') ?? '').toUpperCase();
    if (!start || !start.isDate || status === 'CANCELLED') {
      skipped++;
      continue;
    }
    const uid = String(component.getFirstPropertyValue('uid') ?? '').slice(0, 300);
    const summary = String(component.getFirstPropertyValue('summary') ?? '').replace(/\s+/g, ' ').trim();
    const label = [...(summary || 'Holiday')].slice(0, MAX_LABEL).join('');
    const end = event.endDate;
    const startDay = epochDay(dateOf(start)) as number;
    // DTEND is the day after the last; without one an all-day event is its one day.
    const length = end && end.isDate ? Math.max(1, (epochDay(dateOf(end)) as number) - startDay) : 1;
    if (length > SLOTLOCK_MAX_EXCEPTION_DAYS) {
      throw invalidHolidayCalendar(`"${label}" lasts more than ${SLOTLOCK_MAX_EXCEPTION_DAYS} days`);
    }
    const occurrence = (day: number, key: string) => {
      const lastDay = day + length - 1;
      if (lastDay < first || day > last) {
        skipped++;
        return;
      }
      add({ uid: key, startsOn: dayToDate(day), endsOn: dayToDate(lastDay), label });
    };
    if (!event.isRecurring()) {
      occurrence(startDay, uid || `${dateOf(start)}:${label}`);
      continue;
    }
    if (++recurring > MAX_RECURRING_EVENTS) {
      throw invalidHolidayCalendar(`The calendar has more than ${MAX_RECURRING_EVENTS} recurring events`);
    }
    for (const rule of component.getAllProperties('rrule')) {
      const why = unreadableRule(rule.getFirstValue());
      if (why) throw invalidHolidayCalendar(`"${label}" cannot be read: ${why}`);
    }
    try {
      const iterator = calendar.expand(event);
      for (let next = iterator.next(), own = 0; next && own < MAX_STEPS_PER_EVENT; next = iterator.next(), own++) {
        steps += 1;
        if (steps > MAX_STEPS_PER_CALENDAR) throw invalidHolidayCalendar(REPEATS_TOO_MUCH);
        const day = epochDay(dateOf(next)) as number;
        if (day > last) break;
        if (day + length - 1 < first) continue;
        occurrence(day, `${uid || label}:${dateOf(next)}`);
      }
    } catch (error) {
      if ((error as { code?: unknown }).code === 'invalid_holiday_calendar') throw error;
      // Past the budget: refused as repeating too much (parseHolidayCalendar).
      if (error instanceof CalendarExpansionLimitError) throw error;
      // ical.js refusing a rule it cannot follow.
      throw invalidHolidayCalendar(`"${label}" repeats in a way that cannot be read`);
    }
  }
  const given = String(root.getFirstPropertyValue('x-wr-calname') ?? '').replace(/\s+/g, ' ').trim();
  const name = [...given].slice(0, MAX_LABEL).join('');
  return { holidays, skipped, ...(name ? { name } : {}) };
}

/**
 * Whether a URL's host names this machine or a private network by itself: `localhost`, or an IP
 * literal isPrivateAddress refuses (loopback, private, link-local and the like).
 */
function namesPrivateHost(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isIP(host) !== 0 && isPrivateAddress(host);
}

/**
 * The text at a holiday calendar's URL: `https` only, through `fetch` (give it the guarded fetch, so
 * a name resolving to a private address is refused too), at most SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES,
 * within ten seconds. Refuses `invalid_holiday_calendar` for anything else, and for a URL naming
 * `localhost` or a private IP address whatever `fetch` is; `holiday_calendar_unreachable` when it
 * cannot be read.
 */
export async function fetchHolidayCalendar(fetcher: typeof fetch, url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidHolidayCalendar('The calendar URL is not a URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw invalidHolidayCalendar('The calendar URL must be https, without credentials');
  }
  // Refused here, not only by the guarded fetch serve passes, so an embedder whose fetch checks no
  // address (the dashboard Worker's own) never sends a member's URL to a private network.
  if (namesPrivateHost(parsed)) throw invalidHolidayCalendar('The calendar URL names a private address');
  const unreachable = (message: string) =>
    Object.assign(new Error(message), { code: 'holiday_calendar_unreachable' as const });
  let response: Response;
  try {
    response = await fetcher(parsed.href, {
      headers: { accept: 'text/calendar' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'private_address') {
      throw invalidHolidayCalendar('The calendar URL names a private address');
    }
    throw unreachable('The calendar URL could not be read');
  }
  if (!response.ok) throw unreachable(`The calendar URL answered ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES) throw invalidHolidayCalendar('The calendar is larger than a megabyte');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let read: Awaited<ReturnType<typeof reader.read>>;
    try {
      read = await reader.read();
    } catch {
      // Cut off while its body was read (the timeout, or the connection reset).
      throw unreachable('The calendar URL could not be read');
    }
    const { done, value } = read;
    if (done) break;
    size += value.byteLength;
    if (size > SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES) {
      await reader.cancel();
      throw invalidHolidayCalendar('The calendar is larger than a megabyte');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
