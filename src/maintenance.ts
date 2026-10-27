// Maintenance: extend recurring events to the rolling horizon and prune what the retention window no
// longer needs (README, Operations). Every tenant needs it at least daily. One pass is
// maintainSlotlockTenant; startSlotlockMaintenance runs passes for the tenants a server serves, one
// tenant at a time, with a PostgreSQL advisory lock per tenant so several servers never repeat each
// other's work. Row-level security hides other tenants from the role a server runs as, so a server
// maintains the tenants it is configured with and the ones whose keys it has served.
import type { Sql } from 'postgres';
import { ignoreRejection } from './hooks.js';
import { type SlotlockStore, calendarEventRollingHorizon } from './store.js';
import type { CalendarHorizonRollCursor, CalendarHorizonRollResult } from './types.js';

export interface SlotlockMaintenanceResult {
  /** Recurring events whose stored occurrences now reach the horizon. */
  extended: number;
  /** Series that could not extend because an occurrence would overlap a booking. */
  conflicts: number;
  /** Series over the expansion budget, or whose roll failed otherwise; they keep their old coverage. */
  refused: number;
  /**
   * Expired holds and the answers kept for keyed ones, and past the retention window event
   * idempotency answers, agents' event cancellations, booking references retired with no
   * booking and feed changes, deleted. A cancelled booking's tombstone stays.
   */
  pruned: number;
  /**
   * Future one-off events whose wall time now falls at another instant (time zone rules changed):
   * reported on the feed, or moved with `followZoneRules` (store.followZoneRules).
   */
  zoneShifts: number;
  /** More was left than one pass does: run another. */
  capped: boolean;
  /**
   * The roll stopped before the series it had put back: series it has not tried since may still
   * extend, so another pass should follow at once.
   */
  rollPending: boolean;
}

/**
 * One maintenance pass for a tenant: roll its recurring events to the rolling horizon, then purge
 * its expired holds with their answers and prune its events' and bookings' bookkeeping past the
 * retention window, each in at most `batches` batches (1-100, default 10), every batch its own
 * transaction. Aborting `signal` stops it between batches with the signal's reason.
 */
export async function maintainSlotlockTenant(
  store: SlotlockStore,
  tenantRef: string,
  options: { batches?: number; signal?: AbortSignal; followZoneRules?: boolean } = {},
): Promise<SlotlockMaintenanceResult> {
  const batches = options.batches ?? 10;
  if (!(Number.isSafeInteger(batches) && batches >= 1 && batches <= 100)) {
    throw new RangeError('batches must be a whole number from 1 to 100');
  }
  const window = calendarEventRollingHorizon();
  let extended = 0;
  let conflicts = 0;
  let refused = 0;
  let rollCapped = true;
  let after: CalendarHorizonRollCursor | null = null;
  // A roll that fails does not stop the pruning: expired holds are purged all the same, and the
  // roll's error is thrown after.
  let rollFailure: { error: unknown } | null = null;
  try {
    for (let batch = 0; batch < batches; batch++) {
      options.signal?.throwIfAborted();
      const from: CalendarHorizonRollCursor | null = after;
      const roll: CalendarHorizonRollResult = await store.withTenant(tenantRef, (tenant) =>
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
      const prune = await store.withTenant(tenantRef, (tenant) =>
        tenant.pruneCalendarEventRetention({ tenantRef }),
      );
      pruned += prune.commandsDeleted + prune.tombstonesDeleted;
      eventsLeft = prune.hasMore;
    }
    if (bookingsLeft) {
      const prune = await store.withTenant(tenantRef, (tenant) =>
        tenant.pruneBookingRetention({ tenantRef }),
      );
      pruned += prune.expiredHoldsDeleted + prune.holdCommandsDeleted + prune.tombstonesDeleted;
      bookingsLeft = prune.hasMore;
    }
    if (changesLeft) {
      const deleted = await store.withTenant(tenantRef, (tenant) =>
        tenant.pruneChanges({ tenantRef, limit: CHANGE_PRUNE_BATCH }),
      );
      pruned += deleted;
      changesLeft = deleted === CHANGE_PRUNE_BATCH;
    }
  }
  options.signal?.throwIfAborted();
  const zones = await store.withTenant(tenantRef, (tenant) =>
    tenant.followZoneRules({ tenantRef, move: options.followZoneRules === true }),
  );
  if (rollFailure) throw rollFailure.error;
  return {
    extended,
    conflicts,
    refused,
    pruned,
    zoneShifts: zones.shifted,
    capped: rollCapped || eventsLeft || bookingsLeft || changesLeft,
    rollPending: rollCapped && after !== null && (after.rollRetryAt ?? null) === null,
  };
}

/** Feed changes past the retention deleted per batch. */
const CHANGE_PRUNE_BATCH = 1_000;

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
  /** How often each tenant is maintained, at most a day. */
  intervalMs: number;
  /** Tenants remembered; the one served longest ago is forgotten first. Default 10,000. */
  maxTenants?: number;
  /** Batches of each task per pass (maintainSlotlockTenant). */
  batches?: number;
  /** A pass that ran: counts only, never the tenant. Not awaited; what it throws is ignored. */
  onPass?: (result: SlotlockMaintenanceResult) => void;
  /**
   * A pass that failed. The scheduler carries on with the next tenant. Not awaited; what it throws,
   * or its promise rejects with, is ignored.
   */
  onError?: (error: unknown) => void;
}

const DAY_MS = 86_400_000;

export function startSlotlockMaintenance(
  options: SlotlockMaintenanceSchedulerOptions,
): SlotlockMaintenanceScheduler {
  const { intervalMs } = options;
  if (!(Number.isSafeInteger(intervalMs) && intervalMs >= 1_000 && intervalMs <= DAY_MS)) {
    throw new RangeError('intervalMs must be from one second to one day');
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
              signal: controller.signal,
            }),
          );
          recordPass(tenantRef, Date.now());
          if (result) {
            try {
              ignoreRejection(options.onPass?.(result));
            } catch {
              // Reporting must never stop maintenance, or make a pass that ran look failed.
            }
            // A capped pass that got somewhere goes round again at once, as does one whose roll
            // stopped before the series it had put back: each series it could not extend is now
            // behind every one it has not tried (the store puts it there), so the next pass meets
            // new ones, and however many are stuck, each is met once before a healthy one is
            // reached. A pass that reached the series put back waits for the next interval: they
            // take turns there, and the next pass reaches anything new before them.
            const progressed = result.extended + result.pruned > 0;
            again = result.capped && (progressed || result.rollPending);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          recordPass(tenantRef, Date.now());
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
  const tick = () => {
    for (const tenantRef of [...pinned.keys(), ...served.keys()]) {
      if (due(tenantRef)) enqueue(tenantRef);
    }
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
    },
  };
}
