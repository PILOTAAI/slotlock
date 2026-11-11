// Holiday calendars (RFC 0004 B1): an iCalendar file of days off (a public-holiday feed, a
// company's closures) read as closures. Each all-day VEVENT closes the local days it covers;
// recurring ones are expanded over a bounded span. Timed events are not days off and are skipped.
import ICAL from 'ical.js';
import { SLOTLOCK_MAX_EXCEPTION_DAYS, dayToDate, epochDay } from './hours.js';

/** The longest holiday calendar Slotlock reads: a megabyte. */
export const SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES = 1_048_576;
/** Closures one import may make. */
export const SLOTLOCK_MAX_HOLIDAY_DAYS = 1_000;
/** How long Slotlock waits for a holiday calendar URL. */
const FETCH_TIMEOUT_MS = 10_000;
const MAX_LABEL = 200;

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
 * more than SLOTLOCK_MAX_HOLIDAY_DAYS holidays, and one longer than SLOTLOCK_MAX_EXCEPTION_DAYS.
 */
export function parseHolidayCalendar(text: string, span: { from: string; to: string }): ParsedHolidayCalendar {
  if (Buffer.byteLength(text) > SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES) {
    throw invalidHolidayCalendar('The calendar is larger than a megabyte');
  }
  const first = epochDay(span.from);
  const last = epochDay(span.to);
  if (first === null || last === null || last < first) throw invalidHolidayCalendar('The span is not a range of days');
  let root: InstanceType<typeof ICAL.Component>;
  try {
    root = new ICAL.Component(ICAL.parse(text) as unknown[]);
  } catch {
    throw invalidHolidayCalendar('The text is not iCalendar');
  }
  if (root.name !== 'vcalendar') throw invalidHolidayCalendar('The text is not a VCALENDAR');
  const holidays: SlotlockHoliday[] = [];
  let skipped = 0;
  const add = (holiday: SlotlockHoliday) => {
    holidays.push(holiday);
    if (holidays.length > SLOTLOCK_MAX_HOLIDAY_DAYS) {
      throw invalidHolidayCalendar(`The calendar names more than ${SLOTLOCK_MAX_HOLIDAY_DAYS} holidays in the span`);
    }
  };
  for (const component of root.getAllSubcomponents('vevent')) {
    // An override of one occurrence is read with its series.
    if (component.hasProperty('recurrence-id')) continue;
    const event = new ICAL.Event(component);
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
    const iterator = event.iterator();
    for (let next = iterator.next(), steps = 0; next && steps < 5_000; next = iterator.next(), steps++) {
      const day = epochDay(dateOf(next)) as number;
      if (day > last) break;
      if (day + length - 1 < first) continue;
      occurrence(day, `${uid || label}:${dateOf(next)}`);
    }
  }
  const given = String(root.getFirstPropertyValue('x-wr-calname') ?? '').replace(/\s+/g, ' ').trim();
  const name = [...given].slice(0, MAX_LABEL).join('');
  return { holidays, skipped, ...(name ? { name } : {}) };
}

/**
 * The text at a holiday calendar's URL: `https` only, through `fetch` (give it the guarded fetch, so
 * a private address is refused), at most SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES, within ten seconds.
 * Refuses `invalid_holiday_calendar` for anything else, and `holiday_calendar_unreachable` when it
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
    const { done, value } = await reader.read();
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
