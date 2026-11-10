// The calls the sync makes to Slotlock's application API, with a tenant's admin key: it records
// coverage and busy time, records failures, reads the change feed for write-back, and nothing else.
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

export interface SlotlockSyncApi {
  putSourceBusy(params: {
    resourceId: string;
    source: string;
    window: Interval;
    revision: number;
    busy: Interval[];
  }): Promise<{ revision: number; replayed: boolean; busy: number; conflicts: number }>;
  recordFailure(params: { resourceId: string; source: string; error: string }): Promise<void>;
  /** The source's current revision on the resource, or 0 when it has recorded none. */
  coverageRevision(params: { resourceId: string; source: string }): Promise<number>;
  listChanges(cursor: string | null, limit?: number): Promise<{ changes: SlotlockChange[]; next: string }>;
}

/** Slotlock at `baseUrl` (its REST root, without /v1), as the key's tenant. */
export function createSlotlockSyncApi(options: {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): SlotlockSyncApi {
  const request = slotlockRequester(options);
  const coveragePath = (resourceId: string, source: string) =>
    `/v1/resources/${encodeURIComponent(resourceId)}/coverage/${encodeURIComponent(source)}`;
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
  };
}

/** The CloudEvents type's prefix Slotlock's feed and webhooks put before each change type. */
export const SLOTLOCK_CHANGE_TYPE_PREFIX = 'io.pylota.slotlock.';

/** A change with its type as Slotlock names it (`reservation.created`), without the prefix. */
export function withShortType(change: SlotlockChange): SlotlockChange {
  return change.type.startsWith(SLOTLOCK_CHANGE_TYPE_PREFIX)
    ? { ...change, type: change.type.slice(SLOTLOCK_CHANGE_TYPE_PREFIX.length) }
    : change;
}

/** One authenticated JSON request to Slotlock; a refusal throws SlotlockApiError. */
export function slotlockRequester(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch }) {
  const send = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
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
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      const code = (parsed.error as { code?: unknown } | undefined)?.code;
      throw new SlotlockApiError(response.status, typeof code === 'string' ? code : 'http_error');
    }
    return parsed;
  };
}
