// The calls the sync makes to Slotlock's application API, with a tenant's admin key: it records
// coverage, busy time, failures and conflicts, reads the change feed and current bookings for
// write-back, lists resources for a person choosing where a calendar goes, and retires a source.
export interface Interval {
  start: Date;
  end: Date;
}

/** A refusal Slotlock answered: its HTTP status and error code. */
export class SlotlockApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Slotlock answered ${status} ${code}`);
    this.name = 'SlotlockApiError';
  }
}

/** One change of the feed, as GET /v1/changes serves it (a CloudEvent). */
export interface SlotlockChange {
  id: string;
  type: string;
  subject: string;
  time: string;
  data: Record<string, unknown>;
}

/** A booking on a resource as it now is: a reservation or a one-off event. */
export interface SlotlockBooking {
  /** `reservation:<id>` or `event:<id>`, as write-backs are keyed. */
  key: string;
  /** A reservation's reference; null for an event. */
  reference: string | null;
  start: Date;
  end: Date;
}

export interface SlotlockResourceSummary {
  id: string;
  externalRef: string;
  name: string | null;
}

export interface SlotlockSyncApi {
  putSourceBusy(params: {
    resourceId: string;
    source: string;
    window: Interval;
    revision: number;
    busy: Interval[];
  }): Promise<{ revision: number; replayed: boolean; busy: number; conflicts: number }>;
  recordFailure(params: { resourceId: string; source: string; error: string }): Promise<void>;
  /** A written booking changed or removed in the calendar, on the feed as coverage.conflict. */
  reportConflict(params: {
    resourceId: string;
    source: string;
    booking: { reservationRef: string } | { eventId: string };
    reason: 'changed_in_calendar' | 'removed_from_calendar';
    calendar?: Interval;
  }): Promise<void>;
  /** Retire a source: its coverage and busy time go. False when there was none. */
  deleteCoverage(params: { resourceId: string; source: string }): Promise<boolean>;
  /** The source's current revision on the resource, or 0 when it has recorded none. */
  coverageRevision(params: { resourceId: string; source: string }): Promise<number>;
  /** A page of changes; an expired cursor throws SlotlockApiError 410 cursor_expired. */
  listChanges(cursor: string | null, limit?: number): Promise<{ changes: SlotlockChange[]; next: string }>;
  /** The resource's bookings that meet `window`, as write-back keeps them (series left out). */
  listBookings(resourceId: string, window: Interval): Promise<SlotlockBooking[]>;
  /** Up to `limit` of the tenant's resources, for choosing where a calendar's time goes. */
  listResources(limit?: number): Promise<SlotlockResourceSummary[]>;
}

/** The CloudEvents type's prefix Slotlock's feed and webhooks put before each change type. */
export const SLOTLOCK_CHANGE_TYPE_PREFIX = 'io.pylota.slotlock.';

/** A change with its type as Slotlock names it (`reservation.created`), without the prefix. */
export function withShortType(change: SlotlockChange): SlotlockChange {
  return change.type.startsWith(SLOTLOCK_CHANGE_TYPE_PREFIX)
    ? { ...change, type: change.type.slice(SLOTLOCK_CHANGE_TYPE_PREFIX.length) }
    : change;
}

/** The most pages one listing reads, so a huge resource cannot keep a sync busy for ever. */
const MAX_PAGES = 50;

/** Slotlock at `baseUrl` (its REST root, without /v1), as the key's tenant. */
export function createSlotlockSyncApi(options: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): SlotlockSyncApi {
  const request = slotlockRequester(options);
  const coveragePath = (resourceId: string, source: string) =>
    `/v1/resources/${encodeURIComponent(resourceId)}/coverage/${encodeURIComponent(source)}`;
  const pages = async <T>(path: (cursor: string | null) => string, field: string): Promise<T[]> => {
    const all: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = (await request('GET', path(cursor))) as Record<string, unknown>;
      all.push(...((body[field] as T[] | undefined) ?? []));
      cursor = typeof body.next_cursor === 'string' ? body.next_cursor : null;
      if (!cursor) return all;
    }
    return all;
  };
  return {
    async putSourceBusy(params) {
      const body = await request('PUT', `${coveragePath(params.resourceId, params.source)}/busy`, {
        start: params.window.start.toISOString(),
        end: params.window.end.toISOString(),
        revision: params.revision,
        busy: params.busy.map((interval) => ({ start: interval.start.toISOString(), end: interval.end.toISOString() })),
      });
      return body as { revision: number; replayed: boolean; busy: number; conflicts: number };
    },
    async recordFailure(params) {
      await request('POST', `${coveragePath(params.resourceId, params.source)}/failure`, {
        error: params.error.slice(0, 500),
      });
    },
    async reportConflict(params) {
      await request('POST', `${coveragePath(params.resourceId, params.source)}/conflicts`, {
        ...('eventId' in params.booking ? { event_id: params.booking.eventId } : { reservation_ref: params.booking.reservationRef }),
        reason: params.reason,
        ...(params.calendar
          ? { calendar_start: params.calendar.start.toISOString(), calendar_end: params.calendar.end.toISOString() }
          : {}),
      });
    },
    async deleteCoverage(params) {
      try {
        await request('DELETE', coveragePath(params.resourceId, params.source));
        return true;
      } catch (error) {
        if (error instanceof SlotlockApiError && error.status === 404) return false;
        throw error;
      }
    },
    async coverageRevision(params) {
      const body = (await request('GET', `/v1/resources/${encodeURIComponent(params.resourceId)}/coverage`)) as {
        sources: { source: string; revision: number }[];
      };
      return body.sources.find((source) => source.source === params.source)?.revision ?? 0;
    },
    async listChanges(cursor, limit = 100) {
      const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
      const body = (await request('GET', `/v1/changes?${query}`)) as { changes: SlotlockChange[]; next_cursor: string };
      return { changes: body.changes.map(withShortType), next: body.next_cursor };
    },
    async listBookings(resourceId, window) {
      const span = { start: window.start.toISOString(), end: window.end.toISOString() };
      const id = encodeURIComponent(resourceId);
      const reservations = await pages<{ id: string; reservation_ref: string | null; start: string; end: string }>(
        (cursor) => `/v1/resources/${id}/reservations?${new URLSearchParams({ ...span, limit: '100', ...(cursor ? { cursor } : {}) })}`,
        'reservations',
      );
      const events = await pages<{
        id: string;
        starts_at: string;
        ends_at: string;
        status: string;
        transparency: string;
        recurrence_rule: string | null;
      }>(
        (cursor) =>
          `/v1/tenant/events?${new URLSearchParams({ resource_id: resourceId, ...span, limit: '100', ...(cursor ? { cursor } : {}) })}`,
        'events',
      );
      return [
        ...reservations.map((reservation) => ({
          key: `reservation:${reservation.id}`,
          reference: reservation.reservation_ref,
          start: new Date(reservation.start),
          end: new Date(reservation.end),
        })),
        // As write-back takes them: one-off, busy and not cancelled.
        ...events
          .filter((event) => !event.recurrence_rule && event.transparency !== 'transparent' && event.status !== 'cancelled')
          .map((event) => ({ key: `event:${event.id}`, reference: null, start: new Date(event.starts_at), end: new Date(event.ends_at) })),
      ];
    },
    async listResources(limit = 500) {
      const resources = await pages<{ id: string; external_ref: string; name: string | null }>(
        (cursor) => `/v1/resources?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`,
        'resources',
      );
      return resources.slice(0, limit).map((resource) => ({ id: resource.id, externalRef: resource.external_ref, name: resource.name }));
    },
  };
}

/**
 * A URL without its trailing slashes, in one pass from the end: a `/\/+$/` replace backtracks
 * quadratically on a value with many slashes not at its end.
 */
export function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

/** One authenticated JSON request to Slotlock; a refusal throws SlotlockApiError. */
export function slotlockRequester(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch }) {
  const send = options.fetch ?? fetch;
  const base = withoutTrailingSlashes(options.baseUrl);
  return async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await send(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const code = (parsed.error as { code?: unknown } | undefined)?.code;
      throw new SlotlockApiError(response.status, typeof code === 'string' ? code : 'http_error');
    }
    return parsed;
  };
}
