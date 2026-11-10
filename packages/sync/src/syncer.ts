// The sync itself (RFC 0004 C1, C4). Reading: each mapped calendar's busy time over the coming
// window goes to Slotlock as its source's busy time, at the next coverage revision, less the
// bookings this sync wrote there itself. Writing back: each confirmed booking on a mapped resource
// is kept on the calendars that write back, moved and removed with it. Slotlock stays the source of
// truth: a booking's event moved or deleted in the calendar is reported as the source's failure,
// and the time it moved to comes back as busy, which Slotlock reports as a conflict where it meets
// a booking. Nothing a provider says changes a booking.
import { randomUUID } from 'node:crypto';
import {
  type OAuthClient,
  type OAuthProvider,
  type OAuthTokens,
  OAuthError,
  beginAuthorization,
  exchangeCode,
  refreshTokens,
} from './oauth.js';
import {
  type CalendarWriter,
  type ICalendarFeedParser,
  ProviderError,
  googleWriter,
  microsoftWriter,
  readGoogleBusy,
  readIcsBusy,
  readMicrosoftBusy,
} from './providers.js';
import { type SealKeys, open, seal } from './seal.js';
import {
  type Interval,
  type SlotlockChange,
  type SlotlockSyncApi,
  SlotlockApiError,
  createSlotlockSyncApi,
} from './slotlock-api.js';
import type { SyncConnection, SyncMapping, SyncProviderKind, SyncStore, SyncTenant } from './store.js';

export interface SyncerOptions {
  store: SyncStore;
  keys: SealKeys;
  /** Slotlock's REST root (without /v1). */
  slotlockUrl: string;
  /** OAuth apps, for the providers offered. */
  clients?: { google?: OAuthClient; microsoft?: OAuthClient };
  /** slotlock's parseICalendarFeed, for iCalendar URLs. */
  parseICalendar?: ICalendarFeedParser;
  /** For providers and Slotlock. */
  fetch?: typeof fetch;
  /** For iCalendar URLs a tenant gave: pass slotlock's createSlotlockGuardedFetch(). */
  icsFetch?: typeof fetch;
  /** How far ahead busy time is read, in days (1-367, default 60). */
  windowDays?: number;
  /** The title of a booking written back: never the booking's own (default `Busy`). */
  writeBackTitle?: string;
  now?: () => Date;
}

/** What one mapping's sync did. */
export type MappingSyncResult =
  | { ok: true; mappingId: string; busy: number; conflicts: number; drifted: string[] }
  | { ok: false; mappingId: string; error: string };

const DAY_MS = 24 * 60 * 60 * 1_000;

/** `busy` less each of `own` that it covers whole: what the sync wrote is not someone else's time. */
export function withoutOwn(busy: Interval[], own: Interval[]): Interval[] {
  let left = busy.map((interval) => ({ ...interval }));
  for (const mine of own) {
    const next: Interval[] = [];
    for (const interval of left) {
      if (mine.end <= interval.start || mine.start >= interval.end) {
        next.push(interval);
        continue;
      }
      if (mine.start > interval.start) next.push({ start: interval.start, end: mine.start });
      if (mine.end < interval.end) next.push({ start: mine.end, end: interval.end });
    }
    left = next;
  }
  return left;
}

/** Whether `interval` is busy throughout in `busy`. */
function coveredBy(interval: Interval, busy: Interval[]): boolean {
  let reached = interval.start.getTime();
  for (const each of [...busy].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    if (each.start.getTime() > reached) break;
    reached = Math.max(reached, each.end.getTime());
    if (reached >= interval.end.getTime()) return true;
  }
  return reached >= interval.end.getTime();
}

export function createSyncer(options: SyncerOptions) {
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const windowDays = options.windowDays ?? 60;
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 367) {
    throw new RangeError('windowDays must be a whole number from 1 to 367');
  }
  const title = options.writeBackTitle ?? 'Busy';

  async function api(tenantRef: string): Promise<SlotlockSyncApi> {
    const tenant = await options.store.getTenant(tenantRef);
    if (!tenant) throw new Error(`No Slotlock key is kept for tenant ${tenantRef}`);
    return createSlotlockSyncApi({
      baseUrl: options.slotlockUrl,
      apiKey: open(options.keys, tenant.sealedApiKey, `tenant:${tenantRef}`),
      fetch: send,
    });
  }

  function oauthClient(provider: OAuthProvider): OAuthClient {
    const client = options.clients?.[provider];
    if (!client) throw new Error(`No OAuth app is configured for ${provider}`);
    return client;
  }

  /** A connection's access token, refreshed (and sealed again) when it has expired. */
  async function accessToken(connection: SyncConnection): Promise<string> {
    const context = `connection:${connection.id}`;
    const tokens = JSON.parse(open(options.keys, connection.sealed, context)) as Omit<OAuthTokens, 'expiresAt'> & {
      expiresAt: string;
    };
    if (Date.parse(tokens.expiresAt) > now().getTime()) return tokens.accessToken;
    if (!tokens.refreshToken) throw new ProviderError('The connection has no refresh token: connect it again');
    const fresh = await refreshTokens(oauthClient(connection.provider as OAuthProvider), tokens.refreshToken, send);
    connection.sealed = seal(options.keys, JSON.stringify(fresh), context);
    await options.store.putConnection(connection);
    return fresh.accessToken;
  }

  function writer(connection: SyncConnection): CalendarWriter | null {
    if (!connection.writeBack) return null;
    const token = () => accessToken(connection);
    if (connection.provider === 'google') return googleWriter(token, send);
    if (connection.provider === 'microsoft') return microsoftWriter(token, send);
    return null;
  }

  async function readBusy(connection: SyncConnection, mapping: SyncMapping, window: Interval): Promise<Interval[]> {
    if (connection.provider === 'ics') {
      if (!options.parseICalendar) throw new Error('parseICalendar is needed for iCalendar URLs');
      const url = open(options.keys, connection.sealed, `connection:${connection.id}`);
      return readIcsBusy({ url, window, parse: options.parseICalendar, fetch: options.icsFetch ?? send });
    }
    const token = await accessToken(connection);
    return connection.provider === 'google'
      ? readGoogleBusy({ accessToken: token, calendarId: mapping.calendarId, window, fetch: send })
      : readMicrosoftBusy({ accessToken: token, schedule: mapping.calendarId, window, fetch: send });
  }

  /** Read one mapping's calendar and record what it says in Slotlock. */
  async function syncMapping(which: SyncMapping | string): Promise<MappingSyncResult> {
    const id = typeof which === 'string' ? which : which.id;
    // As stored now: its revision moves on with every sync.
    const mapping = await options.store.getMapping(id);
    if (!mapping) return { ok: false, mappingId: id, error: 'mapping_not_found' };
    const at = now();
    const window = { start: at, end: new Date(at.getTime() + windowDays * DAY_MS) };
    const slotlock = await api(mapping.tenantRef);
    const connection = await options.store.getConnection(mapping.connectionId);
    if (!connection) return { ok: false, mappingId: mapping.id, error: 'connection_not_found' };
    let busy: Interval[];
    try {
      busy = await readBusy(connection, mapping, window);
    } catch (error) {
      const message = error instanceof ProviderError || error instanceof OAuthError ? error.message : 'The calendar could not be read';
      // Coverage stays as it was, and goes stale if this goes on: time is then unproven, not free.
      await slotlock.recordFailure({ resourceId: mapping.resourceId, source: mapping.source, error: message }).catch(() => {});
      await options.store.recordSync(mapping.id, { at, error: message });
      return { ok: false, mappingId: mapping.id, error: message };
    }
    const own = await options.store.listWriteBacks(mapping.id, window);
    // A booking's event no longer where it was written: moved or deleted in the calendar.
    const drifted = own.filter((written) => !coveredBy(written, busy)).map((written) => written.bookingKey);
    const theirs = withoutOwn(busy, own);
    const put = (revision: number) =>
      slotlock.putSourceBusy({ resourceId: mapping.resourceId, source: mapping.source, window, revision, busy: theirs });
    let recorded = await put(mapping.revision + 1).catch((error: unknown) => {
      if (error instanceof SlotlockApiError && ['revision_conflict', 'stale_revision', 'idempotency_conflict'].includes(error.code)) {
        return null;
      }
      throw error;
    });
    // Out of step with Slotlock (a restore, a second sync, a revision already recorded): carry on
    // from Slotlock's revision.
    if (recorded === null || recorded.replayed) {
      recorded = await put((await slotlock.coverageRevision({ resourceId: mapping.resourceId, source: mapping.source })) + 1);
    }
    let error: string | null = null;
    if (drifted.length > 0) {
      error = `Changed in the calendar, not in Slotlock: ${drifted.length} booking(s) written back (${drifted.slice(0, 5).join(', ')})`;
      await slotlock.recordFailure({ resourceId: mapping.resourceId, source: mapping.source, error });
    }
    await options.store.recordSync(mapping.id, { revision: recorded.revision, at, error });
    return { ok: true, mappingId: mapping.id, busy: recorded.busy, conflicts: recorded.conflicts, drifted };
  }

  /** Keep one change's booking on the calendars of its resource that write back. */
  async function writeBack(tenantRef: string, change: SlotlockChange): Promise<number> {
    const data = change.data;
    const resourceId = typeof data.resource_id === 'string' ? data.resource_id : null;
    const id = typeof data.id === 'string' ? data.id : null;
    if (!resourceId || !id) return 0;
    let bookingKey: string;
    let action: 'put' | 'remove';
    if (change.type === 'reservation.created' || change.type === 'reservation.updated' || change.type === 'hold.confirmed') {
      [bookingKey, action] = [`reservation:${id}`, 'put'];
    } else if (change.type === 'reservation.cancelled' || change.type === 'reservation.no_show') {
      [bookingKey, action] = [`reservation:${id}`, 'remove'];
    } else if (change.type === 'event.created' || change.type === 'event.updated') {
      // A series is not written back; nor time the event leaves free, or a cancelled one.
      const busy = data.recurring !== true && data.transparency !== 'transparent' && data.status !== 'cancelled';
      [bookingKey, action] = [`event:${id}`, busy ? 'put' : 'remove'];
    } else if (change.type === 'event.cancelled') {
      [bookingKey, action] = [`event:${id}`, 'remove'];
    } else {
      return 0;
    }
    const interval = { start: new Date(String(data.start)), end: new Date(String(data.end)) };
    // A move to another resource takes it off the calendars of the one it left.
    const before = data.before as { resource_id?: unknown } | undefined;
    const left = typeof before?.resource_id === 'string' && before.resource_id !== resourceId ? before.resource_id : null;
    let written = 0;
    for (const [resource, todo] of [
      [resourceId, action],
      ...(left ? ([[left, 'remove']] as const) : []),
    ] as const) {
      for (const mapping of await options.store.listMappings({ tenantRef, resourceId: resource })) {
        const connection = await options.store.getConnection(mapping.connectionId);
        const calendar = connection ? writer(connection) : null;
        if (!calendar) continue;
        const existing = await options.store.getWriteBack(mapping.id, bookingKey);
        if (todo === 'remove') {
          if (!existing) continue;
          await calendar.remove({ calendarId: mapping.calendarId, eventId: existing.providerEventId });
          await options.store.deleteWriteBack(mapping.id, bookingKey);
        } else if (existing) {
          if (existing.start.getTime() === interval.start.getTime() && existing.end.getTime() === interval.end.getTime()) continue;
          await calendar.update({ calendarId: mapping.calendarId, eventId: existing.providerEventId, interval });
          await options.store.putWriteBack({ ...existing, ...interval });
        } else {
          const providerEventId = await calendar.create({ calendarId: mapping.calendarId, interval, title, bookingKey });
          await options.store.putWriteBack({ mappingId: mapping.id, bookingKey, providerEventId, ...interval });
        }
        written += 1;
      }
    }
    return written;
  }

  return {
    /** Start connecting a Google or Microsoft account: send the person to `url`. */
    beginConnection(provider: OAuthProvider, connectOptions: { writeBack: boolean; loginHint?: string }) {
      return beginAuthorization(oauthClient(provider), connectOptions);
    },

    /**
     * Finish connecting: the code the person came back with, and the verifier kept from
     * beginConnection (check their `state` first). Keeps the tokens sealed; returns the connection.
     */
    async finishConnection(params: {
      tenantRef: string;
      provider: OAuthProvider;
      account: string;
      code: string;
      verifier: string;
      writeBack: boolean;
    }): Promise<SyncConnection> {
      const tokens = await exchangeCode(oauthClient(params.provider), { code: params.code, verifier: params.verifier }, send);
      const id = randomUUID();
      const connection: SyncConnection = {
        id,
        tenantRef: params.tenantRef,
        provider: params.provider,
        account: params.account,
        sealed: seal(options.keys, JSON.stringify(tokens), `connection:${id}`),
        writeBack: params.writeBack,
      };
      await options.store.putConnection(connection);
      return connection;
    },

    /** Connect an iCalendar URL (read only): kept sealed, since such URLs often carry a token. */
    async connectIcs(params: { tenantRef: string; url: string }): Promise<SyncConnection> {
      const url = new URL(params.url.replace(/^webcal:/i, 'https:'));
      if (url.protocol !== 'https:') throw new TypeError('An iCalendar URL must be https');
      const id = randomUUID();
      const connection: SyncConnection = {
        id,
        tenantRef: params.tenantRef,
        provider: 'ics',
        account: url.hostname,
        sealed: seal(options.keys, url.toString(), `connection:${id}`),
        writeBack: false,
      };
      await options.store.putConnection(connection);
      return connection;
    },

    /** Keep a tenant's Slotlock key (an admin key: it records coverage), sealed. */
    async putTenant(params: { tenantRef: string; apiKey: string }): Promise<void> {
      const existing = await options.store.getTenant(params.tenantRef);
      const tenant: SyncTenant = {
        tenantRef: params.tenantRef,
        sealedApiKey: seal(options.keys, params.apiKey, `tenant:${params.tenantRef}`),
        cursor: existing?.cursor ?? null,
      };
      await options.store.putTenant(tenant);
    },

    /** Feed a resource from one of a connection's calendars. */
    async mapCalendar(params: { connectionId: string; calendarId: string; resourceId: string }): Promise<SyncMapping> {
      const connection = await options.store.getConnection(params.connectionId);
      if (!connection) throw new Error('connection_not_found');
      const kind: SyncProviderKind = connection.provider;
      const calendar = kind === 'ics' ? 'feed' : params.calendarId;
      const mapping: SyncMapping = {
        id: randomUUID(),
        tenantRef: connection.tenantRef,
        connectionId: connection.id,
        calendarId: calendar,
        resourceId: params.resourceId,
        source: `${kind}:${connection.id.slice(0, 8)}/${calendar}`.slice(0, 200),
        revision: 0,
        lastSyncedAt: null,
        lastError: null,
      };
      await options.store.putMapping(mapping);
      return mapping;
    },

    syncMapping,

    /** Sync every mapping, one at a time; one that fails does not stop the rest. */
    async syncAll(): Promise<MappingSyncResult[]> {
      const results: MappingSyncResult[] = [];
      for (const mapping of await options.store.listMappings()) {
        try {
          results.push(await syncMapping(mapping.id));
        } catch (error) {
          results.push({ ok: false, mappingId: mapping.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return results;
    },

    writeBack,

    /**
     * Read each tenant's change feed on from where it stopped and write back what changed. A change
     * that fails stops that tenant's read there, to be tried again next time.
     */
    async writeBackChanges(): Promise<{ written: number; failed: string[] }> {
      let written = 0;
      const failed: string[] = [];
      for (const tenant of await options.store.listTenants()) {
        try {
          const slotlock = await api(tenant.tenantRef);
          let cursor = tenant.cursor;
          for (let pages = 0; pages < 20; pages++) {
            const page = await slotlock.listChanges(cursor);
            // Each change is written back idempotently, so a page read again after a failure
            // repeats nothing; the cursor moves only past a page done whole.
            for (const change of page.changes) written += await writeBack(tenant.tenantRef, change);
            cursor = page.next;
            await options.store.setCursor(tenant.tenantRef, cursor);
            if (page.changes.length === 0) break;
          }
        } catch {
          failed.push(tenant.tenantRef);
        }
      }
      return { written, failed };
    },
  };
}
