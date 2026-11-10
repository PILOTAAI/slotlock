// Reading busy time from each kind of calendar, and writing bookings back (RFC 0004 C1, C4). Only
// times are read and written: never a title, attendee or description, from either side.
import { createHash } from 'node:crypto';
import type { Interval } from './slotlock-api.js';

/** A calendar that could not be read: why, as the provider put it (a 401, a missing calendar). */
export class ProviderError extends Error {
  constructor(
    readonly reason: string,
    readonly status: number | null = null,
  ) {
    super(reason);
    this.name = 'ProviderError';
  }
}

/** The longest window one provider request reads; longer ones are read in parts. */
export const PROVIDER_WINDOW_MS = 60 * 24 * 60 * 60 * 1_000;

/** `window` in parts of at most PROVIDER_WINDOW_MS, in order. */
export function windowParts(window: Interval): Interval[] {
  const parts: Interval[] = [];
  for (let start = window.start.getTime(); start < window.end.getTime(); start += PROVIDER_WINDOW_MS) {
    parts.push({ start: new Date(start), end: new Date(Math.min(start + PROVIDER_WINDOW_MS, window.end.getTime())) });
  }
  return parts;
}

async function providerJson(send: typeof fetch, url: string, init: RequestInit, what: string): Promise<Record<string, unknown>> {
  const response = await send(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error as { message?: unknown; code?: unknown } | string | undefined;
    const detail = typeof error === 'string' ? error : typeof error?.code === 'string' ? error.code : String(error?.message ?? '');
    throw new ProviderError(`${what} answered HTTP ${response.status}${detail ? ` (${detail})` : ''}`, response.status);
  }
  return body;
}

function interval(start: unknown, end: unknown): Interval | null {
  const from = new Date(String(start));
  const to = new Date(String(end));
  return Number.isFinite(from.getTime()) && Number.isFinite(to.getTime()) && to > from ? { start: from, end: to } : null;
}

/** Google Calendar's freeBusy for one calendar (`primary`, or a calendar id) over `window`. */
export async function readGoogleBusy(params: {
  accessToken: string;
  calendarId: string;
  window: Interval;
  fetch?: typeof fetch;
}): Promise<Interval[]> {
  const busy: Interval[] = [];
  for (const part of windowParts(params.window)) {
    const body = await providerJson(
      params.fetch ?? fetch,
      'https://www.googleapis.com/calendar/v3/freeBusy',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${params.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          timeMin: part.start.toISOString(),
          timeMax: part.end.toISOString(),
          items: [{ id: params.calendarId }],
        }),
      },
      'Google freeBusy',
    );
    const calendar = (body.calendars as Record<string, { busy?: unknown[]; errors?: { reason?: string }[] }> | undefined)?.[
      params.calendarId
    ];
    if (!calendar) throw new ProviderError('Google freeBusy did not answer for the calendar');
    if (calendar.errors?.length) throw new ProviderError(`Google freeBusy: ${calendar.errors[0]?.reason ?? 'error'}`);
    for (const entry of calendar.busy ?? []) {
      const read = interval((entry as { start?: unknown }).start, (entry as { end?: unknown }).end);
      if (read) busy.push(read);
    }
  }
  return busy;
}

/** What Microsoft's schedule statuses mean: tentative and away are busy; working elsewhere is not. */
const MICROSOFT_BUSY = new Set(['busy', 'tentative', 'oof']);

/** Microsoft Graph getSchedule for one mailbox (an address, or `me` for the signed-in one). */
export async function readMicrosoftBusy(params: {
  accessToken: string;
  schedule: string;
  window: Interval;
  fetch?: typeof fetch;
}): Promise<Interval[]> {
  const busy: Interval[] = [];
  const utc = (date: Date) => ({ dateTime: date.toISOString().replace(/Z$/, ''), timeZone: 'UTC' });
  for (const part of windowParts(params.window)) {
    const body = await providerJson(
      params.fetch ?? fetch,
      'https://graph.microsoft.com/v1.0/me/calendar/getSchedule',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${params.accessToken}`,
          'content-type': 'application/json',
          prefer: 'outlook.timezone="UTC"',
        },
        body: JSON.stringify({
          schedules: [params.schedule],
          startTime: utc(part.start),
          endTime: utc(part.end),
          availabilityViewInterval: 15,
        }),
      },
      'Microsoft getSchedule',
    );
    const [schedule] = (body.value as { error?: { message?: string }; scheduleItems?: unknown[] }[] | undefined) ?? [];
    if (!schedule) throw new ProviderError('Microsoft getSchedule did not answer for the mailbox');
    if (schedule.error) throw new ProviderError(`Microsoft getSchedule: ${schedule.error.message ?? 'error'}`);
    for (const item of schedule.scheduleItems ?? []) {
      const entry = item as { status?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
      if (!MICROSOFT_BUSY.has(entry.status ?? '')) continue;
      // Asked for in UTC; Graph leaves off the zone designator.
      const read = interval(`${entry.start?.dateTime ?? ''}Z`, `${entry.end?.dateTime ?? ''}Z`);
      if (read) busy.push(read);
    }
  }
  return busy;
}

/** How an iCalendar feed is read: slotlock's parseICalendarFeed, passed in. */
export type ICalendarFeedParser = (
  text: string,
  calendarTimezone?: string,
  window?: Interval,
) => {
  changes: { start: Date | null; end: Date | null; busy: boolean; deleted: boolean }[];
  refused: unknown[];
};

/** The most an iCalendar feed may be, as slotlock reads it. */
const MAX_ICS_BYTES = 2_000_000;

/**
 * The busy time of an iCalendar URL over `window`, through `fetch` (pass slotlock's
 * createSlotlockGuardedFetch for a URL a tenant gave: it refuses private addresses). A series the
 * parser refuses makes the whole read fail, since its time is unknown.
 */
export async function readIcsBusy(params: {
  url: string;
  window: Interval;
  parse: ICalendarFeedParser;
  calendarTimezone?: string;
  fetch?: typeof fetch;
}): Promise<Interval[]> {
  const url = new URL(params.url.replace(/^webcal:/i, 'https:'));
  if (url.protocol !== 'https:') throw new ProviderError('An iCalendar URL must be https');
  const response = await (params.fetch ?? fetch)(url, {
    headers: { accept: 'text/calendar' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ProviderError(`The calendar URL answered HTTP ${response.status}`, response.status);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_ICS_BYTES) throw new ProviderError('The calendar is over 2 MB');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_ICS_BYTES) throw new ProviderError('The calendar is over 2 MB');
  const read = params.parse(text, params.calendarTimezone, params.window);
  if (read.refused.length > 0) {
    throw new ProviderError(`${read.refused.length} series in the calendar could not be read, so its time is unknown`);
  }
  return read.changes
    .filter((change) => change.busy && !change.deleted && change.start && change.end)
    .map((change) => ({ start: change.start as Date, end: change.end as Date }));
}

/** Writes one booking's time to a calendar and keeps it there (RFC 0004 C4). */
export interface CalendarWriter {
  create(params: { calendarId: string; interval: Interval; title: string; bookingKey: string }): Promise<string>;
  update(params: { calendarId: string; eventId: string; interval: Interval }): Promise<void>;
  /** Deleting one already gone is not an error. */
  remove(params: { calendarId: string; eventId: string }): Promise<void>;
}

/** Google Calendar events, as the connected account. */
export function googleWriter(accessToken: () => Promise<string>, send: typeof fetch = fetch): CalendarWriter {
  const events = (calendarId: string) =>
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const headers = async () => ({ authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' });
  const times = (interval: Interval) => ({
    start: { dateTime: interval.start.toISOString() },
    end: { dateTime: interval.end.toISOString() },
  });
  return {
    async create(params) {
      // An id of our own (base32hex), the same for the same booking: a retried insert answers 409,
      // never a second event.
      const id = createHash('sha256').update(`${params.calendarId}\n${params.bookingKey}`).digest('hex');
      const response = await send(events(params.calendarId), {
        method: 'POST',
        headers: await headers(),
        body: JSON.stringify({
          id,
          summary: params.title,
          transparency: 'opaque',
          ...times(params.interval),
          extendedProperties: { private: { slotlockBooking: params.bookingKey } },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 409) {
        // Made by an earlier try: put it at this time.
        await this.update({ calendarId: params.calendarId, eventId: id, interval: params.interval });
        return id;
      }
      if (!response.ok) throw new ProviderError(`Google events.insert answered HTTP ${response.status}`, response.status);
      return id;
    },
    async update(params) {
      await providerJson(
        send,
        `${events(params.calendarId)}/${encodeURIComponent(params.eventId)}`,
        { method: 'PATCH', headers: await headers(), body: JSON.stringify(times(params.interval)) },
        'Google events.patch',
      );
    },
    async remove(params) {
      const response = await send(`${events(params.calendarId)}/${encodeURIComponent(params.eventId)}`, {
        method: 'DELETE',
        headers: await headers(),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok && response.status !== 404 && response.status !== 410) {
        throw new ProviderError(`Google events.delete answered HTTP ${response.status}`, response.status);
      }
    },
  };
}

/** Microsoft 365 events, as the connected account (`primary` is its default calendar). */
export function microsoftWriter(accessToken: () => Promise<string>, send: typeof fetch = fetch): CalendarWriter {
  const graph = 'https://graph.microsoft.com/v1.0/me';
  const headers = async () => ({ authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' });
  const times = (interval: Interval) => ({
    start: { dateTime: interval.start.toISOString().replace(/Z$/, ''), timeZone: 'UTC' },
    end: { dateTime: interval.end.toISOString().replace(/Z$/, ''), timeZone: 'UTC' },
  });
  return {
    async create(params) {
      const path = params.calendarId === 'primary' ? `${graph}/events` : `${graph}/calendars/${encodeURIComponent(params.calendarId)}/events`;
      const body = await providerJson(
        send,
        path,
        {
          method: 'POST',
          headers: await headers(),
          body: JSON.stringify({ subject: params.title, showAs: 'busy', ...times(params.interval), transactionId: params.bookingKey }),
        },
        'Microsoft events create',
      );
      if (typeof body.id !== 'string') throw new ProviderError('Microsoft events create answered no id');
      return body.id;
    },
    async update(params) {
      await providerJson(
        send,
        `${graph}/events/${encodeURIComponent(params.eventId)}`,
        { method: 'PATCH', headers: await headers(), body: JSON.stringify(times(params.interval)) },
        'Microsoft events update',
      );
    },
    async remove(params) {
      const response = await send(`${graph}/events/${encodeURIComponent(params.eventId)}`, {
        method: 'DELETE',
        headers: await headers(),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok && response.status !== 404) {
        throw new ProviderError(`Microsoft events delete answered HTTP ${response.status}`, response.status);
      }
    },
  };
}
