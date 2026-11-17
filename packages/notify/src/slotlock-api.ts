// The calls the notifier makes to Slotlock's application API, with a tenant's admin key: it reads
// the change feed, and the contact, event and resource a change names. It writes nothing.

/** The CloudEvents type's prefix Slotlock's feed and webhooks put before each change type. */
export const SLOTLOCK_CHANGE_TYPE_PREFIX = 'io.pylota.slotlock.';

/** One change of the feed (a CloudEvent), its type without the prefix: `reservation.created`. */
export interface SlotlockChange {
  id: string;
  type: string;
  subject: string;
  time: string;
  data: Record<string, unknown>;
}

export interface SlotlockContact {
  contact_ref: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  consent: { email?: boolean; sms?: boolean; whatsapp?: boolean };
  locale: string | null;
}

export interface SlotlockEvent {
  id: string;
  resource_id: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  title: string | null;
  attendees: { address: string; name?: string | null }[];
}

export interface SlotlockResource {
  id: string;
  external_ref: string;
  name: string | null;
  timezone: string;
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

/** A change with its type as Slotlock names it, without the CloudEvents prefix. */
export function withShortType(change: SlotlockChange): SlotlockChange {
  return change.type.startsWith(SLOTLOCK_CHANGE_TYPE_PREFIX)
    ? { ...change, type: change.type.slice(SLOTLOCK_CHANGE_TYPE_PREFIX.length) }
    : change;
}

export interface SlotlockNotifyApi {
  listChanges(cursor: string | null, limit?: number): Promise<{ changes: SlotlockChange[]; next: string }>;
  /** Null when there is none (deleted: the person was forgotten). */
  getContact(ref: string): Promise<SlotlockContact | null>;
  /** Null when there is none (cancelled). */
  getEvent(id: string): Promise<SlotlockEvent | null>;
  getResource(id: string): Promise<SlotlockResource | null>;
  /** Up to `limit` of the tenant's resources. */
  listResources(limit?: number): Promise<SlotlockResource[]>;
  /** A resource's events that meet a window, every page (up to 50). */
  listEvents(resourceId: string, window: { start: Date; end: Date }): Promise<SlotlockEvent[]>;
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

/** Slotlock at `baseUrl` (its REST root, without /v1), as the key's tenant. */
export function createSlotlockNotifyApi(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): SlotlockNotifyApi {
  const send = options.fetch ?? fetch;
  const base = withoutTrailingSlashes(options.baseUrl);
  const get = async (path: string): Promise<Record<string, unknown> | null> => {
    const response = await send(`${base}${path}`, {
      headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return null;
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = (body.error as { code?: unknown } | undefined)?.code;
      throw new SlotlockApiError(response.status, typeof code === 'string' ? code : 'http_error');
    }
    return body;
  };
  return {
    async listChanges(cursor, limit = 100) {
      const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
      const body = (await get(`/v1/changes?${query}`)) as { changes: SlotlockChange[]; next_cursor: string } | null;
      if (!body) throw new SlotlockApiError(404, 'not_found');
      return { changes: body.changes.map(withShortType), next: body.next_cursor };
    },
    async getContact(ref) {
      return ((await get(`/v1/contacts/${encodeURIComponent(ref)}`))?.contact as SlotlockContact | undefined) ?? null;
    },
    async getEvent(id) {
      return ((await get(`/v1/tenant/events/${encodeURIComponent(id)}`))?.event as SlotlockEvent | undefined) ?? null;
    },
    async getResource(id) {
      return ((await get(`/v1/resources/${encodeURIComponent(id)}`))?.resource as SlotlockResource | undefined) ?? null;
    },
    async listResources(limit = 500) {
      const all: SlotlockResource[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 50 && all.length < limit; page++) {
        const body = (await get(`/v1/resources?${new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) })}`)) as {
          resources?: SlotlockResource[];
          next_cursor?: string | null;
        } | null;
        all.push(...(body?.resources ?? []));
        cursor = body?.next_cursor ?? null;
        if (!cursor) break;
      }
      return all.slice(0, limit);
    },
    async listEvents(resourceId, window) {
      const all: SlotlockEvent[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 50; page++) {
        const query = new URLSearchParams({
          resource_id: resourceId,
          start: window.start.toISOString(),
          end: window.end.toISOString(),
          limit: '100',
          ...(cursor ? { cursor } : {}),
        });
        const body = (await get(`/v1/tenant/events?${query}`)) as { events?: SlotlockEvent[]; next_cursor?: string | null } | null;
        all.push(...(body?.events ?? []));
        cursor = body?.next_cursor ?? null;
        if (!cursor) break;
      }
      return all;
    },
  };
}
