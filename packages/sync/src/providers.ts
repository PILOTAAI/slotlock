// Reading busy time from each kind of calendar, listing an account's calendars, and writing bookings
// back (RFC 0004 C1, C4). Only times are read and written: never a title, attendee or description,
// from either side. A provider that asks to slow down (429, 503) says when to try again
// (`retryAfterMs`), and the sync waits that long.
import { createHash } from 'node:crypto';
import type { Interval } from './slotlock-api.js';

/** A calendar that could not be read or written: why, and when to try again if the provider said. */
export class ProviderError extends Error {
  constructor(
    readonly reason: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(reason);
    this.name = 'ProviderError';
  }
}

/** The longest window one provider request reads; longer ones are read in parts. */
export const PROVIDER_WINDOW_MS = 60 * 24 * 60 * 60 * 1_000;

/** The most pages one Microsoft listing follows. */
const MAX_PAGES = 50;

/** `window` in parts of at most PROVIDER_WINDOW_MS, in order. */
export function windowParts(window: Interval): Interval[] {
  const parts: Interval[] = [];
  for (let start = window.start.getTime(); start < window.end.getTime(); start += PROVIDER_WINDOW_MS) {
    parts.push({ start: new Date(start), end: new Date(Math.min(start + PROVIDER_WINDOW_MS, window.end.getTime())) });
  }
  return parts;
}

/** Retry-After as milliseconds: seconds, or an HTTP date; at most a day. Null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const wait = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;
  return Number.isFinite(wait) && wait >= 0 ? Math.min(wait, 24 * 60 * 60 * 1_000) : null;
}

async function providerJson(send: typeof fetch, url: string, init: RequestInit, what: string): Promise<Record<string, unknown>> {
  const response = await send(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error as { message?: unknown; code?: unknown } | string | undefined;
    const detail = typeof error === 'string' ? error : typeof error?.code === 'string' ? error.code : String(error?.message ?? '');
    const later = response.status === 429 || response.status === 503 ? (retryAfterMs(response.headers.get('retry-after')) ?? 60_000) : null;
    throw new ProviderError(`${what} answered HTTP ${response.status}${detail ? ` (${detail.slice(0, 200)})` : ''}`, response.status, later);
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
        body: JSON.stringify({ timeMin: part.start.toISOString(), timeMax: part.end.toISOString(), items: [{ id: params.calendarId }] }),
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

/** What Microsoft's statuses mean: tentative and away are busy; free and working elsewhere are not. */
const MICROSOFT_BUSY = new Set(['busy', 'tentative', 'oof']);

const graphUtc = (date: Date) => date.toISOString().replace(/Z$/, '');

/** Follow a Graph nextLink only to Graph itself. */
function graphNext(link: unknown): string | null {
  return typeof link === 'string' && link.startsWith('https://graph.microsoft.com/v1.0/') ? link : null;
}

/**
 * The busy time of one of the signed-in account's calendars (`primary` for its default) over
 * `window`, from Graph's calendarView: times and show-as only, every page.
 */
export async function readMicrosoftCalendarBusy(params: {
  accessToken: string;
  calendarId: string;
  window: Interval;
  fetch?: typeof fetch;
}): Promise<Interval[]> {
  const send = params.fetch ?? fetch;
  const base =
    params.calendarId === 'primary'
      ? 'https://graph.microsoft.com/v1.0/me/calendar/calendarView'
      : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(params.calendarId)}/calendarView`;
  const busy: Interval[] = [];
  for (const part of windowParts(params.window)) {
    let url: string | null = `${base}?${new URLSearchParams({
      startDateTime: part.start.toISOString(),
      endDateTime: part.end.toISOString(),
      $select: 'start,end,showAs,isCancelled',
      $top: '200',
    })}`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body: Record<string, unknown> = await providerJson(
        send,
        url,
        { headers: { authorization: `Bearer ${params.accessToken}`, prefer: 'outlook.timezone="UTC"' } },
        'Microsoft calendarView',
      );
      for (const item of (body.value as unknown[] | undefined) ?? []) {
        const entry = item as { showAs?: string; isCancelled?: boolean; start?: { dateTime?: string }; end?: { dateTime?: string } };
        if (entry.isCancelled || !MICROSOFT_BUSY.has(entry.showAs ?? '')) continue;
        // Asked for in UTC; Graph leaves off the zone designator.
        const read = interval(`${entry.start?.dateTime ?? ''}Z`, `${entry.end?.dateTime ?? ''}Z`);
        if (read) busy.push(read);
      }
      url = graphNext(body['@odata.nextLink']);
    }
  }
  return busy;
}

/**
 * Microsoft Graph getSchedule for a mailbox by its address (a room, or a colleague's whose
 * free/busy the account may see). For the account's own calendars use readMicrosoftCalendarBusy.
 */
export async function readMicrosoftBusy(params: {
  accessToken: string;
  schedule: string;
  window: Interval;
  fetch?: typeof fetch;
}): Promise<Interval[]> {
  if (!/^[^\s@]+@[^\s@]+$/.test(params.schedule)) throw new ProviderError('getSchedule needs a mailbox address');
  const busy: Interval[] = [];
  for (const part of windowParts(params.window)) {
    const body = await providerJson(
      params.fetch ?? fetch,
      'https://graph.microsoft.com/v1.0/me/calendar/getSchedule',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${params.accessToken}`, 'content-type': 'application/json', prefer: 'outlook.timezone="UTC"' },
        body: JSON.stringify({
          schedules: [params.schedule],
          startTime: { dateTime: graphUtc(part.start), timeZone: 'UTC' },
          endTime: { dateTime: graphUtc(part.end), timeZone: 'UTC' },
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
      const read = interval(`${entry.start?.dateTime ?? ''}Z`, `${entry.end?.dateTime ?? ''}Z`);
      if (read) busy.push(read);
    }
  }
  return busy;
}

/** One calendar an account can choose: its id, its name as the provider shows it, and whether it is the default. */
export interface ProviderCalendar {
  id: string;
  name: string;
  primary: boolean;
  /** Whether bookings may be written to it. */
  writable: boolean;
}

/** The calendars a Google account sees free/busy for, and the account's address. */
export async function listGoogleCalendars(accessToken: string, send: typeof fetch = fetch): Promise<{ account: string | null; calendars: ProviderCalendar[] }> {
  const body = await providerJson(
    send,
    `https://www.googleapis.com/calendar/v3/users/me/calendarList?${new URLSearchParams({ minAccessRole: 'freeBusyReader', maxResults: '250' })}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
    'Google calendarList',
  );
  const items = ((body.items as unknown[] | undefined) ?? []) as { id?: string; summary?: string; primary?: boolean; accessRole?: string }[];
  const calendars = items
    .filter((item) => typeof item.id === 'string')
    .map((item) => ({
      id: item.id as string,
      name: String(item.summary ?? item.id).slice(0, 200),
      primary: item.primary === true,
      writable: item.accessRole === 'owner' || item.accessRole === 'writer',
    }));
  return { account: calendars.find((calendar) => calendar.primary)?.id ?? null, calendars };
}

/** The signed-in Microsoft account's address and calendars. */
export async function listMicrosoftCalendars(accessToken: string, send: typeof fetch = fetch): Promise<{ account: string | null; calendars: ProviderCalendar[] }> {
  const headers = { authorization: `Bearer ${accessToken}` };
  const me = await providerJson(send, 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers }, 'Microsoft me');
  const calendars: ProviderCalendar[] = [];
  let url: string | null = 'https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,isDefaultCalendar,canEdit&$top=100';
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = await providerJson(send, url, { headers }, 'Microsoft calendars');
    for (const item of (body.value as unknown[] | undefined) ?? []) {
      const calendar = item as { id?: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean };
      if (typeof calendar.id !== 'string') continue;
      calendars.push({
        id: calendar.isDefaultCalendar ? 'primary' : calendar.id,
        name: String(calendar.name ?? calendar.id).slice(0, 200),
        primary: calendar.isDefaultCalendar === true,
        writable: calendar.canEdit !== false,
      });
    }
    url = graphNext(body['@odata.nextLink']);
  }
  const address = typeof me.mail === 'string' ? me.mail : typeof me.userPrincipalName === 'string' ? me.userPrincipalName : null;
  return { account: address, calendars };
}

/** What a calendar now says of an event the sync wrote: its time and whether it is busy; null when gone. */
export interface WrittenEventState {
  start: Date;
  end: Date;
  busy: boolean;
}

/** Writes one booking's time to a calendar and keeps it there (RFC 0004 C4). */
export interface CalendarWriter {
  create(params: { calendarId: string; interval: Interval; title: string; bookingKey: string }): Promise<string>;
  update(params: { calendarId: string; eventId: string; interval: Interval }): Promise<void>;
  /** Deleting one already gone is not an error. */
  remove(params: { calendarId: string; eventId: string }): Promise<void>;
  /** What the calendar now has for the event; null when it was deleted or cancelled there. */
  read(params: { calendarId: string; eventId: string }): Promise<WrittenEventState | null>;
}

/** Google Calendar events, as the connected account. */
export function googleWriter(accessToken: () => Promise<string>, send: typeof fetch = fetch): CalendarWriter {
  const events = (calendarId: string) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const headers = async () => ({ authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' });
  const times = (interval: Interval) => ({ start: { dateTime: interval.start.toISOString() }, end: { dateTime: interval.end.toISOString() } });
  const writer: CalendarWriter = {
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
        await writer.update({ calendarId: params.calendarId, eventId: id, interval: params.interval });
        return id;
      }
      if (!response.ok) {
        const later = response.status === 429 || response.status === 503 ? (retryAfterMs(response.headers.get('retry-after')) ?? 60_000) : null;
        throw new ProviderError(`Google events.insert answered HTTP ${response.status}`, response.status, later);
      }
      return id;
    },
    async update(params) {
      await providerJson(
        send,
        `${events(params.calendarId)}/${encodeURIComponent(params.eventId)}`,
        // A cancelled event comes back as it is written again.
        { method: 'PATCH', headers: await headers(), body: JSON.stringify({ ...times(params.interval), status: 'confirmed' }) },
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
    async read(params) {
      const response = await send(
        `${events(params.calendarId)}/${encodeURIComponent(params.eventId)}?${new URLSearchParams({ fields: 'status,start,end,transparency' })}`,
        { headers: await headers(), signal: AbortSignal.timeout(20_000) },
      );
      if (response.status === 404 || response.status === 410) return null;
      if (!response.ok) throw new ProviderError(`Google events.get answered HTTP ${response.status}`, response.status);
      const body = (await response.json()) as { status?: string; transparency?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
      if (body.status === 'cancelled') return null;
      const at = interval(body.start?.dateTime, body.end?.dateTime);
      return at ? { ...at, busy: body.transparency !== 'transparent' } : null;
    },
  };
  return writer;
}

/** Microsoft 365 events, as the connected account (`primary` is its default calendar). */
export function microsoftWriter(accessToken: () => Promise<string>, send: typeof fetch = fetch): CalendarWriter {
  const graph = 'https://graph.microsoft.com/v1.0/me';
  const headers = async () => ({ authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' });
  const times = (interval: Interval) => ({
    start: { dateTime: graphUtc(interval.start), timeZone: 'UTC' },
    end: { dateTime: graphUtc(interval.end), timeZone: 'UTC' },
  });
  return {
    async create(params) {
      const path = params.calendarId === 'primary' ? `${graph}/events` : `${graph}/calendars/${encodeURIComponent(params.calendarId)}/events`;
      // transactionId makes a retried create answer the first event, not a second one.
      const body = await providerJson(
        send,
        path,
        { method: 'POST', headers: await headers(), body: JSON.stringify({ subject: params.title, showAs: 'busy', ...times(params.interval), transactionId: params.bookingKey }) },
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
    async read(params) {
      const response = await send(`${graph}/events/${encodeURIComponent(params.eventId)}?$select=start,end,showAs,isCancelled`, {
        headers: { ...(await headers()), prefer: 'outlook.timezone="UTC"' },
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new ProviderError(`Microsoft events get answered HTTP ${response.status}`, response.status);
      const body = (await response.json()) as { isCancelled?: boolean; showAs?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
      if (body.isCancelled) return null;
      const at = interval(`${body.start?.dateTime ?? ''}Z`, `${body.end?.dateTime ?? ''}Z`);
      return at ? { ...at, busy: MICROSOFT_BUSY.has(body.showAs ?? '') } : null;
    },
  };
}

/** Revoke a Google token (refresh or access) when a connection is removed. Best effort. */
export async function revokeGoogleToken(token: string, send: typeof fetch = fetch): Promise<boolean> {
  const response = await send('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  return response?.ok === true;
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
  if (!response.ok) {
    const later = response.status === 429 || response.status === 503 ? (retryAfterMs(response.headers.get('retry-after')) ?? 60_000) : null;
    throw new ProviderError(`The calendar URL answered HTTP ${response.status}`, response.status, later);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_ICS_BYTES) throw new ProviderError('The calendar is over 2 MB');
  const text = await readCapped(response, MAX_ICS_BYTES);
  const read = params.parse(text, params.calendarTimezone, params.window);
  if (read.refused.length > 0) {
    throw new ProviderError(`${read.refused.length} series in the calendar could not be read, so its time is unknown`);
  }
  return read.changes
    .filter((change) => change.busy && !change.deleted && change.start && change.end)
    .map((change) => ({ start: change.start as Date, end: change.end as Date }));
}

/** A body read up to `limit` bytes, refused past it without reading the rest. */
async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new ProviderError('The calendar is over 2 MB');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
