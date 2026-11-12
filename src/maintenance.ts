// Maintenance: extend recurring events to the rolling horizon and prune what retention no longer
// needs (docs, Operations); every tenant needs it at least daily. startSlotlockMaintenance runs
// passes one tenant at a time with a per-tenant advisory lock, so servers never repeat each other's
// work. RLS hides other tenants from a server's role, so it finds them through the database's list
// of tenants with data (names only, `discover`) and maintains each in its own tenant context.
import type { Sql } from 'postgres';
import { ignoreRejection } from './hooks.js';
import {
  SLOTLOCK_MAX_WAITLIST_PER_TENANT,
  type SlotlockStore,
  type SlotlockTenantStore,
  buildSlotlockTenantExport,
  calendarEventRollingHorizon,
} from './store.js';
import type { CalendarHorizonRollCursor, CalendarHorizonRollResult } from './types.js';
import { readSlotlockHolidayCalendar } from './holiday-import.js';

export interface SlotlockMaintenanceResult {
  /** Recurring events whose stored occurrences now reach the horizon. */
  extended: number;
  /** Series that could not extend because an occurrence would overlap a booking. */
  conflicts: number;
  /** Series over the expansion budget, or whose roll failed otherwise; they keep their old coverage. */
  refused: number;
  /**
   * Rows deleted: expired holds and their keyed answers; past retention, event idempotency answers,
   * agent event cancellations, stray booking retirements and feed changes; expired assistant
   * conversations; and audit events past retention. A cancelled booking's tombstone stays.
   */
  pruned: number;
  /**
   * Future one-off events whose wall time now falls at another instant (time zone rules changed):
   * reported on the feed, or moved with `followZoneRules` (store.followZoneRules).
   */
  zoneShifts: number;
  /** Coverage sources gone stale since the last pass, now reported on the feed (`coverage.stale`). */
  staleSources: number;
  /** Bookings left unclaimed past their check-in window, released (`reservation.no_show`). */
  noShows: number;
  /** Waitlist entries whose window came free, each now holding it (`waitlist.offered`). */
  waitlistOffers: number;
  /** Approvals no one decided in time, their held time freed (`approval.expired`). */
  approvalsExpired: number;
  /** Bookings whose end has passed in the last week, now said on the feed (`reservation.completed`). */
  bookingsCompleted: number;
  /**
   * Event reminders that came due, each now on the feed once (`reminder.due`) for a sender to send
   * (RFC 0004 P3).
   */
  remindersDue: number;
  /**
   * Holiday calendar subscriptions imported again (RFC 0004 B1), with `holidayFetch`; one that
   * could not be read keeps its closures and is tried again a day later.
   */
  holidayCalendarsImported: number;
  /** More was left than one pass does: run another. */
  capped: boolean;
  /**
   * The roll stopped before the series it had deferred: others may still extend, so run another
   * pass at once.
   */
  rollPending: boolean;
}

/**
 * One maintenance pass for a tenant: roll its recurring events to the horizon, then purge expired
 * holds and prune bookkeeping past retention, each in at most `batches` batches (1-100, default
 * 10), each its own transaction. Aborting `signal` stops it between batches.
 */
export async function maintainSlotlockTenant(
  store: SlotlockStore,
  tenantRef: string,
  options: {
    batches?: number;
    signal?: AbortSignal;
    followZoneRules?: boolean;
    /**
     * Roll the tenant's committed bookings and holds up into its usage first (usage.ts), before
     * pruning can delete feed changes it has not counted. For a deployment that meters
     * (SLOTLOCK_USAGE=on).
     */
    usage?: boolean;
    /**
     * Fetches holiday calendar subscriptions due to be imported again (the guarded fetch under
     * `serve`); without it, none is.
     */
    holidayFetch?: typeof fetch;
  } = {},
): Promise<SlotlockMaintenanceResult> {
  const batches = options.batches ?? 10;
  if (!(Number.isSafeInteger(batches) && batches >= 1 && batches <= 100)) {
    throw new RangeError('batches must be a whole number from 1 to 100');
  }
  const withTenant = <T>(callback: (tenant: SlotlockTenantStore) => Promise<T>) =>
    store.withTenant(tenantRef, callback, { origin: 'maintenance' });
  if (options.usage) {
    for (let batch = 0; batch < batches; batch++) {
      options.signal?.throwIfAborted();
      const read = await withTenant((tenant) => tenant.rollUpUsage({ tenantRef, limit: USAGE_ROLL_UP_BATCH }));
      if (read < USAGE_ROLL_UP_BATCH) break;
    }
  }
  const window = calendarEventRollingHorizon();
  let extended = 0;
  let conflicts = 0;
  let refused = 0;
  let rollCapped = true;
  let after: CalendarHorizonRollCursor | null = null;
  // A failed roll does not stop the pruning; its error is thrown after.
  let rollFailure: { error: unknown } | null = null;
  try {
    for (let batch = 0; batch < batches; batch++) {
      options.signal?.throwIfAborted();
      const from: CalendarHorizonRollCursor | null = after;
      const roll: CalendarHorizonRollResult = await withTenant((tenant) =>
        tenant.rollCalendarEventHorizon({ tenantRef, window, ...(from ? { after: from } : {}) }),
      );
      extended += roll.extended;
      conflicts += roll.conflicts;
      refused += roll.refused;
      after = roll.next;
      if (!after) {
        rollCapped = false;
        break;
      }
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    rollFailure = { error };
  }
  let pruned = 0;
  let eventsLeft = true;
  let bookingsLeft = true;
  let changesLeft = true;
  for (let batch = 0; batch < batches && (eventsLeft || bookingsLeft || changesLeft); batch++) {
    options.signal?.throwIfAborted();
    if (eventsLeft) {
      const prune = await withTenant((tenant) =>
        tenant.pruneCalendarEventRetention({ tenantRef }),
      );
      pruned += prune.commandsDeleted + prune.tombstonesDeleted;
      eventsLeft = prune.hasMore;
    }
    if (bookingsLeft) {
      const prune = await withTenant((tenant) =>
        tenant.pruneBookingRetention({ tenantRef }),
      );
      pruned += prune.expiredHoldsDeleted + prune.holdCommandsDeleted + prune.tombstonesDeleted;
      bookingsLeft = prune.hasMore;
    }
    if (changesLeft) {
      const deleted = await withTenant((tenant) =>
        tenant.pruneChanges({ tenantRef, limit: CHANGE_PRUNE_BATCH }),
      );
      pruned += deleted;
      changesLeft = deleted === CHANGE_PRUNE_BATCH;
    }
  }
  options.signal?.throwIfAborted();
  // Conversations expire 2 hours after their last message (dashboard.ts).
  pruned += await withTenant((tenant) =>
    tenant.pruneAssistantConversations({ tenantRef }),
  );
  // Audit events past retention (SLOTLOCK_AUDIT_RETENTION_DAYS, 180).
  pruned += await withTenant((tenant) => tenant.pruneAuditEvents({ tenantRef }));
  // Exports past their time go; one a stopped server left pending is built now (RFC 0004 D3).
  const exports = await withTenant((tenant) => tenant.pruneTenantExports({ tenantRef }));
  pruned += exports.deleted;
  for (const exportId of exports.pending) {
    options.signal?.throwIfAborted();
    await buildSlotlockTenantExport(store, tenantRef, exportId);
  }
  const zones = await withTenant((tenant) =>
    tenant.followZoneRules({ tenantRef, move: options.followZoneRules === true }),
  );
  const staleSources = await withTenant((tenant) => tenant.reportStaleCoverage({ tenantRef }));
  // Approvals past their wait, and no-shows, first: the time they free is offered to the waitlist
  // in the same pass.
  const approvals = await withTenant((tenant) => tenant.expireApprovals({ tenantRef, limit: 100 }));
  const noShows = await withTenant((tenant) => tenant.releaseNoShows({ tenantRef }));
  // Bookings that ended since the last pass (RFC 0004 B4): no row changes, the feed says so.
  const completed = await withTenant((tenant) => tenant.completeEndedBookings({ tenantRef, limit: 500 }));
  const reminders = await withTenant((tenant) => tenant.dueReminders({ tenantRef, limit: 500 }));
  const holidays = options.holidayFetch ? await importDueHolidayCalendars(withTenant, tenantRef, options) : 0;
  // The whole waitlist in join order, a page per transaction, so a later free entry is offered
  // however many wait before it.
  let waitlistOffers = 0;
  let page: WaitlistPage | null = null;
  for (let pages = 0; pages < WAITLIST_PAGES; pages++) {
    options.signal?.throwIfAborted();
    const from: WaitlistPage | null = page;
    const offers: { offered: number; next: WaitlistPage | null } = await withTenant((tenant) =>
      tenant.offerWaitlist({ tenantRef, ...(from ? { after: from } : {}) }),
    );
    waitlistOffers += offers.offered;
    page = offers.next;
    if (!page) break;
  }
  if (rollFailure) throw rollFailure.error;
  return {
    extended,
    conflicts,
    refused,
    pruned,
    zoneShifts: zones.shifted,
    staleSources,
    noShows,
    waitlistOffers,
    approvalsExpired: approvals.expired,
    bookingsCompleted: completed,
    remindersDue: reminders,
    holidayCalendarsImported: holidays,
    capped:
      rollCapped ||
      eventsLeft ||
      bookingsLeft ||
      changesLeft ||
      approvals.expired === 100 ||
      completed === 500 ||
      reminders === 500,
    rollPending: rollCapped && after !== null && (after.rollRetryAt ?? null) === null,
  };
}

/** Holiday calendar subscriptions imported again in one pass, at most: each is a fetch. */
const HOLIDAY_IMPORTS_PER_PASS = 5;

/**
 * Import again the tenant's holiday calendar subscriptions that are due: each fetched outside any
 * transaction, then imported in one; one that cannot be read or imported keeps its closures and
 * notes why, to be tried again a day later.
 */
async function importDueHolidayCalendars(
  withTenant: <T>(work: (tenant: SlotlockTenantStore) => Promise<T>) => Promise<T>,
  tenantRef: string,
  options: { holidayFetch?: typeof fetch; signal?: AbortSignal },
): Promise<number> {
  const due = await withTenant((tenant) => tenant.dueHolidayCalendars({ tenantRef, limit: HOLIDAY_IMPORTS_PER_PASS }));
  let imported = 0;
  for (const calendar of due) {
    options.signal?.throwIfAborted();
    if (!calendar.url) continue;
    try {
      const read = await readSlotlockHolidayCalendar({ url: calendar.url, subscribe: true, name: calendar.name }, options.holidayFetch);
      await withTenant((tenant) =>
        tenant.importHolidayCalendar({
          tenantRef,
          ...(calendar.location !== undefined ? { location: calendar.location } : {}),
          ...(calendar.resourceId !== undefined ? { resourceId: calendar.resourceId } : {}),
          name: calendar.name,
          ...(read.url !== undefined ? { url: read.url } : {}),
          holidays: read.holidays,
          span: read.span,
        }),
      );
      imported++;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      await withTenant((tenant) =>
        tenant.noteHolidayCalendarFailure({
          tenantRef,
          id: calendar.id,
          error: error instanceof Error ? error.message : 'The import failed',
        }),
      );
    }
  }
  return imported;
}

type WaitlistPage = { createdAt: Date; id: string };
/** Pages of 50 that cover a tenant's whole waitlist (SLOTLOCK_MAX_WAITLIST_PER_TENANT). */
const WAITLIST_PAGES = Math.ceil(SLOTLOCK_MAX_WAITLIST_PER_TENANT / 50);

/** How often the scheduler sweeps every tenant's expired assistant conversations, at most. */
const SWEEP_INTERVAL_MS = 15 * 60_000;

/** Feed changes past the retention deleted per batch. */
const CHANGE_PRUNE_BATCH = 1_000;

/** Feed changes rolled up into usage per batch. */
const USAGE_ROLL_UP_BATCH = 5_000;

/** The advisory lock key for one tenant's maintenance (64-bit, from the tenant reference). */
const LOCK_NAMESPACE = 'slotlock.maintenance:';

/**
 * Run `work` holding the tenant's maintenance lock on a connection of its own, or return
 * `undefined` without running it when another server holds the lock.
 */
export async function withSlotlockMaintenanceLock<T>(
  sql: Sql,
  tenantRef: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const reserved = await sql.reserve();
  try {
    const key = `${LOCK_NAMESPACE}${tenantRef}`;
    const [row] = await reserved<{ locked: boolean }[]>`
      SELECT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtextextended(${key}, 0)) AS locked`;
    if (!row?.locked) return undefined;
    try {
      return await work();
    } finally {
      await reserved`SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended(${key}, 0))`;
    }
  } finally {
    reserved.release();
  }
}

export interface SlotlockMaintenanceScheduler {
  /**
   * A tenant the server just served. Unless it was maintained within the interval, it is queued
   * now, and from then on maintained every interval with the others.
   */
  touch(tenantRef: string): void;
  /** Stop: no new pass starts, and the one running finishes first. */
  close(): Promise<void>;
}

export interface SlotlockMaintenanceSchedulerOptions {
  store: SlotlockStore;
  sql: Sql;
  /** Tenants maintained from the start, whether or not a key of theirs calls. */
  tenants: readonly string[];
  /**
   * Every tenant with data (slotlock.maintenance_tenants), read at the start and once an interval;
   * each not maintained within the interval is queued, so a tenant whose keys never call is
   * maintained too. What it throws goes to onError.
   */
  discover?: () => Promise<readonly string[]>;
  /** How often each tenant is maintained, at most a day. */
  intervalMs: number;
  /** Tenants remembered; the one served longest ago is forgotten first. Default 10,000. */
  maxTenants?: number;
  /** Batches of each task per pass (maintainSlotlockTenant). */
  batches?: number;
  /** Roll each tenant's bookings and holds up into its usage, first (maintainSlotlockTenant `usage`). */
  usage?: boolean;
  /** Fetches holiday calendar subscriptions due to be imported again (maintainSlotlockTenant). */
  holidayFetch?: typeof fetch;
  /**
   * Team workspaces' verified domains looked up again (workspace-domains.ts runSlotlockDomainChecks):
   * run with each sweep, at most every quarter hour. What it throws goes to onError.
   */
  domainChecks?: () => Promise<unknown>;
  /** A pass that ran: counts only, never the tenant. Not awaited; what it throws is ignored. */
  onPass?: (result: SlotlockMaintenanceResult) => void;
  /**
   * A pass that failed. The scheduler carries on with the next tenant. Not awaited; what it throws,
   * or its promise rejects with, is ignored.
   */
  onError?: (error: unknown) => void;
  /**
   * Where passes are recorded for the admin console (RFC 0006, M11;
   * createSlotlockMaintenanceRecord): each tenant whose pass failed or ran, and once an hour that
   * passes ran, their counts. Not awaited; what it throws goes to onError.
   */
  record?: SlotlockMaintenanceRecord;
  /** How often the counts are recorded, at least a minute. Default an hour. */
  recordEveryMs?: number;
}

/** What maintenance tells the admin console (RFC 0006, M11): never a tenant's data. */
export interface SlotlockMaintenanceRecord {
  /** The tenant's pass failed, with what failed (slotlockMaintenanceError). */
  failed(tenantRef: string, error: SlotlockMaintenanceError): Promise<void>;
  /** The tenant's pass ran: a failure recorded for it is cleared. */
  ran(tenantRef: string): Promise<void>;
  /** The passes since `startedAt`, counted, never naming a tenant. */
  round(round: SlotlockMaintenanceRound): Promise<void>;
}

/** A failed pass as the console shows it: the error's class, code and message, never data. */
export interface SlotlockMaintenanceError {
  name: string;
  code: string | null;
  message: string | null;
}

/** Passes one server ran in a while: how many, how many failed, and what they did, summed. */
export interface SlotlockMaintenanceRound {
  startedAt: Date;
  passes: number;
  failed: number;
  totals: Omit<SlotlockMaintenanceResult, 'capped' | 'rollPending'>;
}

/**
 * What a failed pass records: the error's class and code as they are, and the first line of its
 * message with anything in quotes taken out (where a message would carry a value), cut to 200
 * characters.
 */
export function slotlockMaintenanceError(error: unknown): SlotlockMaintenanceError {
  if (!(error instanceof Error)) return { name: 'Error', code: null, message: null };
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error';
  const raw = (error as { code?: unknown }).code;
  const code = typeof raw === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : null;
  // The first line, cut before any pattern runs; each quoted run excludes its own opening mark, so
  // the scan stays linear however many quotes a message holds.
  const end = error.message.search(/[\r\n]/);
  const line = (end === -1 ? error.message : error.message.slice(0, end))
    .slice(0, 2000)
    .replace(/"[^"]*"|'[^']*'|`[^`]*`|“[^“”]*”|‘[^‘’]*’/g, '…')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  const characters = [...line];
  const message = characters.length > 200 ? `${characters.slice(0, 199).join('')}…` : line;
  return { name, code, message: message.length > 0 ? message : null };
}

/**
 * The record a server keeps through the serving role's functions (slotlock.note_maintenance_*).
 * On a schema from before them, nothing is recorded and nothing fails.
 */
export function createSlotlockMaintenanceRecord(sql: Sql): SlotlockMaintenanceRecord {
  const tolerate = (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === '42883' || code === '42501') return;
    throw error;
  };
  return {
    async failed(tenantRef, error) {
      await sql`SELECT slotlock.note_maintenance_failure(${tenantRef}::text, ${error.name}::text,
                  ${error.code}::text, ${error.message}::text)`.catch(tolerate);
    },
    async ran(tenantRef) {
      await sql`SELECT slotlock.note_maintenance_recovered(${tenantRef}::text)`.catch(tolerate);
    },
    async round(round) {
      const summary = { passes: round.passes, failed: round.failed, ...round.totals };
      await sql`SELECT slotlock.note_maintenance_round(${round.startedAt}::timestamptz, ${round.failed > 0}::boolean,
                  ${sql.json(summary)}::jsonb)`.catch(tolerate);
    },
  };
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function startSlotlockMaintenance(
  options: SlotlockMaintenanceSchedulerOptions,
): SlotlockMaintenanceScheduler {
  const { intervalMs } = options;
  if (!(Number.isSafeInteger(intervalMs) && intervalMs >= 1_000 && intervalMs <= DAY_MS)) {
    throw new RangeError('intervalMs must be from one second to one day');
  }
  const recordEveryMs = options.recordEveryMs ?? HOUR_MS;
  if (!(Number.isSafeInteger(recordEveryMs) && recordEveryMs >= 60_000)) {
    throw new RangeError('recordEveryMs must be at least a minute');
  }
  const maxTenants = options.maxTenants ?? 10_000;
  /** Configured tenants, never forgotten: tenant reference to when its last pass finished (0: never). */
  const pinned = new Map<string, number>(options.tenants.map((tenantRef) => [tenantRef, 0]));
  /** Served tenants, in the order last served; the oldest is forgotten past `maxTenants`. */
  const served = new Map<string, number>();
  const queue: string[] = [];
  /** Tenants waiting or in a pass: a tenant served during its own pass is not queued again. */
  const queued = new Set<string>();
  const controller = new AbortController();
  let working: Promise<void> | null = null;

  /** The passes since the last record (RFC 0006, M11). */
  const emptyTotals = (): SlotlockMaintenanceRound['totals'] => ({
    extended: 0, conflicts: 0, refused: 0, pruned: 0, zoneShifts: 0, staleSources: 0, noShows: 0,
    waitlistOffers: 0, approvalsExpired: 0, bookingsCompleted: 0, remindersDue: 0, holidayCalendarsImported: 0,
  });
  let round: SlotlockMaintenanceRound = { startedAt: new Date(), passes: 0, failed: 0, totals: emptyTotals() };
  const tally = (result: SlotlockMaintenanceResult | null) => {
    if (!result) {
      round.failed += 1;
      return;
    }
    round.passes += 1;
    for (const key of Object.keys(round.totals) as (keyof SlotlockMaintenanceRound['totals'])[]) {
      round.totals[key] += result[key];
    }
  };
  /** Record the round once it is old enough (or at once, `force`), when any pass ran in it. */
  const flushRound = (force = false) => {
    if (!options.record || (!force && Date.now() - round.startedAt.getTime() < recordEveryMs)) return;
    const done = round;
    round = { startedAt: new Date(), passes: 0, failed: 0, totals: emptyTotals() };
    if (done.passes + done.failed === 0) return;
    return recordWith((record) => record.round(done));
  };
  /** A record call: not awaited by the pass; what it throws goes to onError. */
  const recordWith = (call: (record: SlotlockMaintenanceRecord) => Promise<void>): Promise<void> | undefined => {
    const record = options.record;
    if (!record) return undefined;
    return (async () => call(record))().catch((error: unknown) => {
      try {
        ignoreRejection(options.onError?.(error));
      } catch {
        // Reporting must never stop maintenance.
      }
    });
  };

  const lastPass = (tenantRef: string) => pinned.get(tenantRef) ?? served.get(tenantRef);
  const recordPass = (tenantRef: string, finishedAt: number) => {
    if (pinned.has(tenantRef)) pinned.set(tenantRef, finishedAt);
    else if (served.has(tenantRef)) served.set(tenantRef, finishedAt);
  };
  const due = (tenantRef: string) => Date.now() - (lastPass(tenantRef) ?? 0) >= intervalMs;
  const enqueue = (tenantRef: string) => {
    if (controller.signal.aborted || queued.has(tenantRef)) return;
    queued.add(tenantRef);
    queue.push(tenantRef);
    if (!working) working = drain();
  };
  const drain = async () => {
    try {
      for (;;) {
        const tenantRef = queue.shift();
        if (tenantRef === undefined || controller.signal.aborted) return;
        let again = false;
        try {
          const result = await withSlotlockMaintenanceLock(options.sql, tenantRef, () =>
            maintainSlotlockTenant(options.store, tenantRef, {
              ...(options.batches !== undefined ? { batches: options.batches } : {}),
              ...(options.usage ? { usage: true } : {}),
              ...(options.holidayFetch ? { holidayFetch: options.holidayFetch } : {}),
              signal: controller.signal,
            }),
          );
          recordPass(tenantRef, Date.now());
          if (result) {
            tally(result);
            void recordWith((record) => record.ran(tenantRef));
            try {
              ignoreRejection(options.onPass?.(result));
            } catch {
              // Reporting must never stop maintenance, or make a pass that ran look failed.
            }
            // A capped pass that progressed, or whose roll stopped before its deferred series, goes
            // again at once: deferred series sit behind untried ones, so each stuck one is met once
            // before a healthy one is reached. A pass that reached the deferred series waits for
            // the next interval.
            const progressed = result.extended + result.pruned > 0;
            again = result.capped && (progressed || result.rollPending);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          recordPass(tenantRef, Date.now());
          tally(null);
          void recordWith((record) => record.failed(tenantRef, slotlockMaintenanceError(error)));
          try {
            ignoreRejection(options.onError?.(error));
          } catch {
            // Reporting must never stop maintenance.
          }
        } finally {
          queued.delete(tenantRef);
        }
        if (again) enqueue(tenantRef);
      }
    } finally {
      working = null;
    }
  };
  const report = (error: unknown) => {
    try {
      ignoreRejection(options.onError?.(error));
    } catch {
      // Reporting must never stop maintenance.
    }
  };
  // Expired conversations of every tenant, including those no key calls (dashboard-only): one
  // bounded sweep at most every quarter hour.
  let lastSweep = 0;
  const sweep = () => {
    if (controller.signal.aborted || Date.now() - lastSweep < Math.min(intervalMs, SWEEP_INTERVAL_MS)) return;
    lastSweep = Date.now();
    options.store.sweepAssistantConversations().catch(report);
    // Team invitations finished a month ago, with the addresses they were sent to, and sessions
    // ended a day ago.
    options.store.sweepDashboardRecords().catch(report);
    // Verified domains whose daily check (or a pending claim's hourly one) is due.
    options.domainChecks?.().catch(report);
  };
  // Every tenant with data, once an interval: those no key has called since the server started too.
  let lastDiscovery = Number.NEGATIVE_INFINITY;
  let discovering = false;
  const discover = () => {
    const list = options.discover;
    if (!list || discovering || controller.signal.aborted) return;
    if (Date.now() - lastDiscovery < intervalMs) return;
    lastDiscovery = Date.now();
    discovering = true;
    (async () => list())()
      .then((tenants) => {
        for (const tenantRef of tenants) if (due(tenantRef)) enqueue(tenantRef);
      }, report)
      .finally(() => {
        discovering = false;
      });
  };
  const tick = () => {
    for (const tenantRef of [...pinned.keys(), ...served.keys()]) {
      if (due(tenantRef)) enqueue(tenantRef);
    }
    discover();
    sweep();
    void flushRound();
  };

  const timer = setInterval(tick, Math.min(intervalMs, 60_000));
  timer.unref();
  tick();

  return {
    touch(tenantRef) {
      if (controller.signal.aborted || pinned.has(tenantRef)) {
        if (pinned.has(tenantRef) && due(tenantRef)) enqueue(tenantRef);
        return;
      }
      const previous = served.get(tenantRef);
      served.delete(tenantRef);
      served.set(tenantRef, previous ?? 0);
      while (served.size > maxTenants) {
        const forgotten = served.keys().next().value as string;
        served.delete(forgotten);
      }
      if (due(tenantRef)) enqueue(tenantRef);
    },
    async close() {
      clearInterval(timer);
      controller.abort(new Error('Slotlock maintenance stopped'));
      queue.length = 0;
      queued.clear();
      await working;
      // What ran since the last record is not lost with the server.
      await flushRound(true);
    },
  };
}
