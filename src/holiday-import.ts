// Reading a holiday calendar to import (RFC 0004 B1), shared by the application API, the dashboard,
// the CLI and maintenance: pasted or uploaded text, or an https URL fetched before any transaction
// opens, parsed over a span of days, and named, so importing it again replaces what it said.
import { dayToDate, epochDay } from './hours.js';
import { type SlotlockHoliday, fetchHolidayCalendar, invalidHolidayCalendar, parseHolidayCalendar } from './holidays.js';

/** Where a holiday calendar comes from, and what to call it. */
export interface SlotlockHolidaySource {
  /** The iCalendar text, pasted or uploaded. */
  icalendar?: string;
  /** An https URL to fetch it from. */
  url?: string;
  /**
   * The calendar's name at its scope (1-200 characters): importing again under it replaces what
   * it said. By default the calendar's own (X-WR-CALNAME), else the URL's host and path, else
   * "Holidays".
   */
  name?: string;
  /** Keep the URL and import it again every 30 days (maintenance). Needs `url`. */
  subscribe?: boolean;
  /** The first and last days to import, `YYYY-MM-DD`; by default today and two years on. */
  from?: string;
  to?: string;
}

/** A holiday calendar read and parsed, ready for importHolidayCalendar. */
export interface SlotlockHolidayCalendarRead {
  name: string;
  holidays: SlotlockHoliday[];
  /** Events that were not all-day, cancelled, or outside the span. */
  skipped: number;
  span: { from: string; to: string };
  /** The URL to keep, for a subscription. */
  url?: string;
}

/** Days a span may cover, and the default. */
const MAX_SPAN_DAYS = 1_096;
const DEFAULT_SPAN_DAYS = 730;

/** A URL's host and path, as a calendar's name. */
function nameOfUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return [...`${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`].slice(0, 200).join('');
  } catch {
    return 'Holidays';
  }
}

/**
 * Read a holiday calendar from its text or URL (`fetcher` fetches it; without one a URL is
 * refused `holiday_url_not_served`), parse it over its span, and name it. Throws
 * `invalid_holiday_calendar` and `holiday_calendar_unreachable`.
 */
export async function readSlotlockHolidayCalendar(
  source: SlotlockHolidaySource,
  fetcher?: typeof fetch,
): Promise<SlotlockHolidayCalendarRead> {
  const given = [source.icalendar, source.url].filter((value) => value !== undefined && value !== '');
  if (given.length !== 1) throw invalidHolidayCalendar('Give the calendar as text or as a URL, one of them');
  if (source.subscribe === true && !source.url) throw invalidHolidayCalendar('Only a calendar read from a URL can be subscribed to');
  const today = Math.floor(Date.now() / 86_400_000);
  const from = source.from ?? dayToDate(today);
  const to = source.to ?? dayToDate((epochDay(from) ?? today) + DEFAULT_SPAN_DAYS);
  const first = epochDay(from);
  const last = epochDay(to);
  if (first === null || last === null || last < first || last - first > MAX_SPAN_DAYS) {
    throw invalidHolidayCalendar('from and to must be days at most three years apart');
  }
  let text: string;
  if (source.url) {
    if (!fetcher) {
      throw Object.assign(new Error('This server does not fetch calendars by URL'), { code: 'holiday_url_not_served' as const });
    }
    text = await fetchHolidayCalendar(fetcher, source.url);
  } else {
    text = source.icalendar as string;
  }
  const parsed = parseHolidayCalendar(text, { from, to });
  const name = source.name?.trim() || parsed.name || (source.url ? nameOfUrl(source.url) : 'Holidays');
  return {
    name,
    holidays: parsed.holidays,
    skipped: parsed.skipped,
    span: { from, to },
    ...(source.subscribe === true && source.url ? { url: source.url } : {}),
  };
}
