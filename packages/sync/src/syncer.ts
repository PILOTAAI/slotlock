// The sync itself (RFC 0004 C1, C4).
//
// Reading: each mapped calendar's busy time over the coming window goes to Slotlock as its source's
// busy time, at the next coverage revision, less the bookings this sync wrote there itself and finds
// where it wrote them. A calendar that fails is retried later, sooner when the provider says when.
//
// Writing back: each confirmed booking and one-off event on a mapped resource is kept on the
// calendars that write back, moved and removed with it, from the change feed; a reconciliation from
// the bookings as they are now repairs anything missed (an expired feed cursor, say).
//
// Slotlock stays the source of truth: a booking's event moved or deleted in the calendar is reported
// on Slotlock's feed as coverage.conflict (once for each change), and the time it moved to comes
// back as busy time. Nothing a provider says changes a booking.
import { createHash, randomUUID } from 'node:crypto';
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
  type ProviderCalendar,
  ProviderError,
  googleWriter,
  listGoogleCalendars,
  listMicrosoftCalendars,
  microsoftWriter,
  readGoogleBusy,
  readIcsBusy,
  readMicrosoftBusy,
  readMicrosoftCalendarBusy,
  revokeGoogleToken,
} from './providers.js';
import { type SealKeys, open, seal } from './seal.js';
import {
  type Interval,
  type SlotlockChange,
  type SlotlockResourceSummary,
  type SlotlockSyncApi,
  SlotlockApiError,
  createSlotlockSyncApi,
} from './slotlock-api.js';
import type { SyncConnection, SyncMapping, SyncStore, SyncWriteBack } from './store.js';

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
  /** How far ahead busy time is read and bookings written, in days (1-367, default 60). */
  windowDays?: number;
  /** The title of a booking written back: never the booking's own (default `Busy`). */
  writeBackTitle?: string;
  now?: () => Date;
}

/** What one mapping's sync did. */
export type MappingSyncResult =
  | { ok: true; mappingId: string; busy: number; conflicts: number; drifted: string[] }
  | { ok: false; mappingId: string; error: string; retryAt: Date | null };

const DAY_MS = 24 * 60 * 60 * 1_000;
/** How long a person has to come back from the provider. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
/** The longest wait between tries of a failing calendar. */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;
/** Written events read back in one sync, at most, to see where they went. */
const MAX_DRIFT_READS = 50;

/** `busy` less each of `own`: what the sync wrote, where it wrote it, is not someone else's time. */
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

/** The wait before trying a failing calendar again: a minute, doubling, at most six hours. */
export function backoffMs(failures: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
}

/** SHA-256 of an OAuth state, as the store keeps it. */
export function stateHash(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

/** The coverage source a mapping records as: its connection and a digest of its calendar. */
function sourceFor(connection: SyncConnection, calendarId: string): string {
  return `${connection.provider}:${connection.id}/${createHash('sha256').update(calendarId).digest('hex').slice(0, 16)}`;
}

export function createSyncer(options: SyncerOptions) {
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const windowDays = options.windowDays ?? 60;
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 367) {
    throw new RangeError('windowDays must be a whole number from 1 to 367');
  }
  const title = options.writeBackTitle ?? 'Busy';
  const window = () => {
    const at = now();
    return { start: at, end: new Date(at.getTime() + windowDays * DAY_MS) };
  };

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

  type StoredTokens = Omit<OAuthTokens, 'expiresAt'> & { expiresAt: string };
  const tokensOf = (connection: SyncConnection) =>
    JSON.parse(open(options.keys, connection.sealed, `connection:${connection.id}`)) as StoredTokens;

  /** A connection's access token, refreshed (and sealed again) when it has expired. */
  async function accessToken(connection: SyncConnection): Promise<string> {
    const tokens = tokensOf(connection);
    if (Date.parse(tokens.expiresAt) > now().getTime()) return tokens.accessToken;
    if (!tokens.refreshToken) throw new ProviderError('The connection has no refresh token: connect it again');
    const fresh = await refreshTokens(oauthClient(connection.provider as OAuthProvider), tokens.refreshToken, send);
    connection.sealed = seal(options.keys, JSON.stringify(fresh), `connection:${connection.id}`);
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

  async function readBusy(connection: SyncConnection, mapping: SyncMapping, span: Interval): Promise<Interval[]> {
    if (connection.provider === 'ics') {
      if (!options.parseICalendar) throw new Error('parseICalendar is needed for iCalendar URLs');
      const url = open(options.keys, connection.sealed, `connection:${connection.id}`);
      return readIcsBusy({ url, window: span, parse: options.parseICalendar, fetch: options.icsFetch ?? send });
    }
    const token = await accessToken(connection);
    if (connection.provider === 'google') {
      return readGoogleBusy({ accessToken: token, calendarId: mapping.calendarId, window: span, fetch: send });
    }
    // One of the account's calendars, or another mailbox (a room) by its address.
    return mapping.calendarId.includes('@')
      ? readMicrosoftBusy({ accessToken: token, schedule: mapping.calendarId, window: span, fetch: send })
      : readMicrosoftCalendarBusy({ accessToken: token, calendarId: mapping.calendarId, window: span, fetch: send });
  }

  /** What a written booking's event has become in the calendar: a signature, or null when in step. */
  async function driftOf(calendar: CalendarWriter, mapping: SyncMapping, written: SyncWriteBack) {
    const state = await calendar.read({ calendarId: mapping.calendarId, eventId: written.providerEventId });
    if (!state) return { signature: 'removed', reason: 'removed_from_calendar' as const };
    const moved = state.start.getTime() !== written.start.getTime() || state.end.getTime() !== written.end.getTime();
    if (!moved && state.busy) return null;
    return {
      signature: `${moved ? 'moved' : 'free'}:${state.start.toISOString()}/${state.end.toISOString()}`,
      reason: 'changed_in_calendar' as const,
      calendar: { start: state.start, end: state.end },
    };
  }

  /** Read one mapping's calendar and record what it says in Slotlock. */
  async function syncMapping(which: SyncMapping | string, force = false): Promise<MappingSyncResult> {
    const id = typeof which === 'string' ? which : which.id;
    // As stored now: its revision moves on with every sync.
    const mapping = await options.store.getMapping(id);
    if (!mapping) return { ok: false, mappingId: id, error: 'mapping_not_found', retryAt: null };
    const at = now();
    if (!force && mapping.retryAt && mapping.retryAt > at) {
      return { ok: false, mappingId: id, error: 'waiting', retryAt: mapping.retryAt };
    }
    const span = window();
    const slotlock = await api(mapping.tenantRef);
    const connection = await options.store.getConnection(mapping.connectionId);
    if (!connection) return { ok: false, mappingId: id, error: 'connection_not_found', retryAt: null };
    let busy: Interval[];
    try {
      busy = await readBusy(connection, mapping, span);
    } catch (error) {
      const message = error instanceof ProviderError || error instanceof OAuthError ? error.message : 'The calendar could not be read';
      const failures = mapping.failures + 1;
      const wait = error instanceof ProviderError && error.retryAfterMs !== null ? error.retryAfterMs : backoffMs(failures);
      const retryAt = new Date(at.getTime() + wait);
      // Coverage stays as it was, and goes stale if this goes on: time is then unproven, not free.
      await slotlock.recordFailure({ resourceId: mapping.resourceId, source: mapping.source, error: message }).catch(() => {});
      await options.store.recordSync(mapping.id, { at, error: message, retryAt, failures });
      return { ok: false, mappingId: mapping.id, error: message, retryAt };
    }
    // The sync's own bookings: subtracted where the calendar still has them as written; one
    // moved, removed or made free there is reported, once for each change.
    const own = await options.store.listWriteBacks(mapping.id, span);
    const calendar = writer(connection);
    const inStep: Interval[] = [];
    const drifted: string[] = [];
    let reads = 0;
    for (const written of own) {
      if (coveredBy(written, busy) || !calendar || reads >= MAX_DRIFT_READS) {
        inStep.push(written);
        if (written.drift !== null && coveredBy(written, busy)) await options.store.putWriteBack({ ...written, drift: null });
        continue;
      }
      reads += 1;
      const drift = await driftOf(calendar, mapping, written).catch(() => undefined);
      if (drift === undefined) {
        inStep.push(written);
        continue;
      }
      if (drift === null) {
        inStep.push(written);
        if (written.drift !== null) await options.store.putWriteBack({ ...written, drift: null });
        continue;
      }
      drifted.push(written.bookingKey);
      if (drift.signature === written.drift) continue;
      const [kind, bookingId] = written.bookingKey.split(':', 2) as [string, string];
      const booking = kind === 'event' ? { eventId: bookingId } : written.bookingRef ? { reservationRef: written.bookingRef } : null;
      if (booking) {
        await slotlock
          .reportConflict({
            resourceId: mapping.resourceId,
            source: mapping.source,
            booking,
            reason: drift.reason,
            ...(drift.calendar ? { calendar: drift.calendar } : {}),
          })
          // Gone from Slotlock meanwhile: write-back removes the event next.
          .catch((error: unknown) => {
            if (!(error instanceof SlotlockApiError) || error.status !== 404) throw error;
          });
      }
      await options.store.putWriteBack({ ...written, drift: drift.signature });
    }
    const theirs = withoutOwn(busy, inStep);
    const put = (revision: number) =>
      slotlock.putSourceBusy({ resourceId: mapping.resourceId, source: mapping.source, window: span, revision, busy: theirs });
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
    await options.store.recordSync(mapping.id, { revision: recorded.revision, at, error: null, retryAt: null, failures: 0 });
    return { ok: true, mappingId: mapping.id, busy: recorded.busy, conflicts: recorded.conflicts, drifted };
  }

  /** Put one booking on a mapping's calendar, or move it there; idempotent. */
  async function putOn(
    calendar: CalendarWriter,
    mapping: SyncMapping,
    booking: { key: string; reference: string | null; start: Date; end: Date },
  ): Promise<boolean> {
    const interval = { start: booking.start, end: booking.end };
    const existing = await options.store.getWriteBack(mapping.id, booking.key);
    if (existing) {
      if (existing.start.getTime() === interval.start.getTime() && existing.end.getTime() === interval.end.getTime() && existing.drift === null) {
        return false;
      }
      await calendar.update({ calendarId: mapping.calendarId, eventId: existing.providerEventId, interval });
      await options.store.putWriteBack({ ...existing, ...interval, bookingRef: booking.reference ?? existing.bookingRef, drift: null });
      return true;
    }
    const providerEventId = await calendar.create({ calendarId: mapping.calendarId, interval, title, bookingKey: booking.key });
    await options.store.putWriteBack({
      mappingId: mapping.id,
      bookingKey: booking.key,
      bookingRef: booking.reference,
      providerEventId,
      ...interval,
      drift: null,
    });
    return true;
  }

  async function removeFrom(calendar: CalendarWriter, mapping: SyncMapping, bookingKey: string): Promise<boolean> {
    const existing = await options.store.getWriteBack(mapping.id, bookingKey);
    if (!existing) return false;
    await calendar.remove({ calendarId: mapping.calendarId, eventId: existing.providerEventId });
    await options.store.deleteWriteBack(mapping.id, bookingKey);
    return true;
  }

  /** Keep one change's booking on the calendars of its resource that write back. */
  async function writeBack(tenantRef: string, change: SlotlockChange): Promise<number> {
    const data = change.data;
    const resourceId = typeof data.resource_id === 'string' ? data.resource_id : null;
    const id = typeof data.id === 'string' ? data.id : null;
    if (!resourceId || !id) return 0;
    let key: string;
    let action: 'put' | 'remove';
    if (change.type === 'reservation.created' || change.type === 'reservation.updated' || change.type === 'hold.confirmed') {
      [key, action] = [`reservation:${id}`, 'put'];
    } else if (change.type === 'reservation.cancelled' || change.type === 'reservation.no_show') {
      [key, action] = [`reservation:${id}`, 'remove'];
    } else if (change.type === 'event.created' || change.type === 'event.updated') {
      // A series is not written back; nor time the event leaves free, or a cancelled one.
      const busy = data.recurring !== true && data.transparency !== 'transparent' && data.status !== 'cancelled';
      [key, action] = [`event:${id}`, busy ? 'put' : 'remove'];
    } else if (change.type === 'event.cancelled') {
      [key, action] = [`event:${id}`, 'remove'];
    } else {
      return 0;
    }
    const booking = {
      key,
      reference: typeof data.reference === 'string' ? data.reference : null,
      start: new Date(String(data.start)),
      end: new Date(String(data.end)),
    };
    // A move to another resource takes it off the calendars of the one it left.
    const before = data.before as { resource_id?: unknown } | undefined;
    const left = typeof before?.resource_id === 'string' && before.resource_id !== resourceId ? before.resource_id : null;
    let written = 0;
    for (const [resource, todo] of [[resourceId, action], ...(left ? ([[left, 'remove']] as const) : [])] as const) {
      for (const mapping of await options.store.listMappings({ tenantRef, resourceId: resource })) {
        const connection = await options.store.getConnection(mapping.connectionId);
        const calendar = connection ? writer(connection) : null;
        if (!calendar) continue;
        const changed = todo === 'remove' ? await removeFrom(calendar, mapping, key) : await putOn(calendar, mapping, booking);
        if (changed) written += 1;
      }
    }
    return written;
  }

  /**
   * Make a write-back mapping's calendar match the resource's bookings as they are now, over the
   * coming window: missing ones written, moved ones moved, gone ones removed.
   */
  async function reconcileMapping(which: SyncMapping | string): Promise<{ written: number; removed: number; failed: number }> {
    const mapping = await options.store.getMapping(typeof which === 'string' ? which : which.id);
    const result = { written: 0, removed: 0, failed: 0 };
    if (!mapping) return result;
    const connection = await options.store.getConnection(mapping.connectionId);
    const calendar = connection ? writer(connection) : null;
    if (!calendar) return result;
    const span = window();
    const bookings = await (await api(mapping.tenantRef)).listBookings(mapping.resourceId, span);
    const keep = new Set(bookings.map((booking) => booking.key));
    for (const booking of bookings) {
      try {
        if (await putOn(calendar, mapping, booking)) result.written += 1;
      } catch {
        result.failed += 1;
      }
    }
    for (const written of await options.store.listWriteBacks(mapping.id, span)) {
      if (keep.has(written.bookingKey)) continue;
      try {
        if (await removeFrom(calendar, mapping, written.bookingKey)) result.removed += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }

  async function reconcileTenant(tenantRef: string) {
    const total = { written: 0, removed: 0, failed: 0 };
    for (const mapping of await options.store.listMappings({ tenantRef })) {
      const done = await reconcileMapping(mapping);
      total.written += done.written;
      total.removed += done.removed;
      total.failed += done.failed;
    }
    return total;
  }

  return {
    /**
     * Start connecting a Google or Microsoft account for a tenant: the URL to send the person to.
     * The flow's state is kept here (its digest, with the verifier sealed) for ten minutes.
     */
    async beginConnection(params: {
      tenantRef: string;
      provider: OAuthProvider;
      writeBack: boolean;
      /** SHA-256 (hex) of the secret the starting browser holds: finishConnection must be given it. */
      browserHash: string;
      loginHint?: string;
    }) {
      if (!(await options.store.getTenant(params.tenantRef))) throw new Error('tenant_not_found');
      const flow = beginAuthorization(oauthClient(params.provider), {
        writeBack: params.writeBack,
        ...(params.loginHint ? { loginHint: params.loginHint } : {}),
      });
      const hash = stateHash(flow.state);
      await options.store.putOAuthState({
        stateHash: hash,
        tenantRef: params.tenantRef,
        provider: params.provider,
        sealedVerifier: seal(options.keys, flow.verifier, `oauth:${hash}`),
        writeBack: params.writeBack,
        browserHash: params.browserHash,
        expiresAt: new Date(now().getTime() + OAUTH_STATE_TTL_MS),
      });
      return { url: flow.url };
    },

    /**
     * Finish connecting: the `state` and `code` the person came back with. The state is used once;
     * an unknown or expired one is refused (`oauth_state_invalid`). Keeps the tokens sealed and the
     * account's address; returns the connection and the calendars it can choose from.
     */
    async finishConnection(params: {
      state: string;
      code: string;
      /** SHA-256 (hex) of the browser's secret: a flow is finished only in the browser that began it. */
      browserHash: string;
    }): Promise<{ connection: SyncConnection; calendars: ProviderCalendar[] }> {
      const flow = await options.store.takeOAuthState(stateHash(params.state), now());
      if (!flow || !flow.browserHash || flow.browserHash !== params.browserHash) throw new Error('oauth_state_invalid');
      const verifier = open(options.keys, flow.sealedVerifier, `oauth:${flow.stateHash}`);
      const tokens = await exchangeCode(oauthClient(flow.provider), { code: params.code, verifier }, send);
      const listed =
        flow.provider === 'google' ? await listGoogleCalendars(tokens.accessToken, send) : await listMicrosoftCalendars(tokens.accessToken, send);
      const id = randomUUID();
      const connection: SyncConnection = {
        id,
        tenantRef: flow.tenantRef,
        provider: flow.provider,
        account: (listed.account ?? `${flow.provider} account`).slice(0, 320),
        sealed: seal(options.keys, JSON.stringify(tokens), `connection:${id}`),
        writeBack: flow.writeBack,
      };
      await options.store.putConnection(connection);
      return { connection, calendars: listed.calendars };
    },

    /** The calendars a connection can map: the provider's list; an iCalendar URL is one. */
    async listCalendars(connectionId: string): Promise<ProviderCalendar[]> {
      const connection = await options.store.getConnection(connectionId);
      if (!connection) throw new Error('connection_not_found');
      if (connection.provider === 'ics') return [{ id: 'feed', name: connection.account, primary: true, writable: false }];
      const token = await accessToken(connection);
      return (connection.provider === 'google' ? await listGoogleCalendars(token, send) : await listMicrosoftCalendars(token, send)).calendars;
    },

    /** The tenant's resources, for choosing where a calendar's time goes. */
    async listResources(tenantRef: string): Promise<SlotlockResourceSummary[]> {
      return (await api(tenantRef)).listResources();
    },

    /** Connect an iCalendar URL (read only): kept sealed, since such URLs often carry a token. */
    async connectIcs(params: { tenantRef: string; url: string }): Promise<SyncConnection> {
      if (!(await options.store.getTenant(params.tenantRef))) throw new Error('tenant_not_found');
      const url = new URL(params.url.replace(/^webcal:/i, 'https:'));
      if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('An iCalendar URL must be https, without credentials');
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
      await options.store.putTenant({
        tenantRef: params.tenantRef,
        sealedApiKey: seal(options.keys, params.apiKey, `tenant:${params.tenantRef}`),
        cursor: existing?.cursor ?? null,
      });
    },

    /** Feed a resource from one of a connection's calendars, and keep its bookings there if it writes back. */
    async mapCalendar(params: { connectionId: string; calendarId: string; resourceId: string }): Promise<SyncMapping> {
      const connection = await options.store.getConnection(params.connectionId);
      if (!connection) throw new Error('connection_not_found');
      const calendarId = connection.provider === 'ics' ? 'feed' : params.calendarId;
      if (!calendarId || calendarId.length > 2048) throw new TypeError('calendar_invalid');
      const source = sourceFor(connection, calendarId);
      const existing = (await options.store.listMappings({ connectionId: connection.id })).find(
        (mapping) => mapping.resourceId === params.resourceId && mapping.source === source,
      );
      if (existing) return existing;
      const mapping: SyncMapping = {
        id: randomUUID(),
        tenantRef: connection.tenantRef,
        connectionId: connection.id,
        calendarId,
        resourceId: params.resourceId,
        source,
        revision: 0,
        lastSyncedAt: null,
        lastError: null,
        retryAt: null,
        failures: 0,
      };
      await options.store.putMapping(mapping);
      return mapping;
    },

    syncMapping,

    /** Sync every mapping due, one at a time; one that fails does not stop the rest. */
    async syncAll(): Promise<MappingSyncResult[]> {
      const results: MappingSyncResult[] = [];
      for (const mapping of await options.store.listMappings()) {
        try {
          results.push(await syncMapping(mapping.id));
        } catch (error) {
          results.push({ ok: false, mappingId: mapping.id, error: error instanceof Error ? error.message : String(error), retryAt: null });
        }
      }
      return results;
    },

    writeBack,
    reconcileMapping,
    reconcileTenant,

    /**
     * Read each tenant's change feed on from where it stopped and write back what changed. A change
     * that fails stops that tenant's read there, to be tried again next time. A cursor the feed no
     * longer keeps (410 cursor_expired: the sync was down past its 30 days) is dropped, and the
     * tenant's calendars are reconciled with its bookings as they are now.
     */
    async writeBackChanges(): Promise<{ written: number; failed: string[]; reconciled: string[] }> {
      let written = 0;
      const failed: string[] = [];
      const reconciled: string[] = [];
      for (const tenant of await options.store.listTenants()) {
        try {
          const slotlock = await api(tenant.tenantRef);
          let cursor = tenant.cursor;
          for (let pages = 0; pages < 20; pages++) {
            let page: Awaited<ReturnType<SlotlockSyncApi['listChanges']>>;
            try {
              page = await slotlock.listChanges(cursor);
            } catch (error) {
              if (!(error instanceof SlotlockApiError) || error.status !== 410 || cursor === null) throw error;
              await options.store.setCursor(tenant.tenantRef, null);
              cursor = null;
              await reconcileTenant(tenant.tenantRef);
              reconciled.push(tenant.tenantRef);
              continue;
            }
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
      return { written, failed, reconciled };
    },

    /**
     * Remove a connection: the bookings it wrote are taken off its calendars, its sources retired
     * in Slotlock (their coverage and busy time go), a Google token revoked, and it is forgotten.
     * `failed` counts calendar events it could not remove (gone access, say), for a person to check.
     */
    async disconnect(connectionId: string): Promise<{ removed: number; failed: number; sources: number }> {
      const connection = await options.store.getConnection(connectionId);
      if (!connection) throw new Error('connection_not_found');
      const slotlock = await api(connection.tenantRef);
      const calendar = writer(connection);
      const result = { removed: 0, failed: 0, sources: 0 };
      for (const mapping of await options.store.listMappings({ connectionId })) {
        if (calendar) {
          for (const written of await options.store.listWriteBacks(mapping.id)) {
            try {
              await calendar.remove({ calendarId: mapping.calendarId, eventId: written.providerEventId });
              result.removed += 1;
            } catch {
              result.failed += 1;
            }
          }
        }
        if (await slotlock.deleteCoverage({ resourceId: mapping.resourceId, source: mapping.source })) result.sources += 1;
      }
      if (connection.provider === 'google') {
        const tokens = tokensOf(connection);
        await revokeGoogleToken(tokens.refreshToken ?? tokens.accessToken, send);
      }
      await options.store.deleteConnection(connectionId);
      return result;
    },
  };
}

export type Syncer = ReturnType<typeof createSyncer>;
