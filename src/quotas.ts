// Monthly quotas (RFC 0003 part 3): each hosted plan allows so many operations and bookings a UTC
// calendar month (plans.ts SLOTLOCK_PLAN_QUOTAS). The server checks each operation against them as
// it is authorized: past the operations quota every operation is refused, past the bookings quota
// only those that can make a booking, so a tenant can still read and cancel. A refusal is
// `quota_exceeded` (429) with Retry-After at the month's end (rate-limit.ts renders it), and at 80%
// and 100% of each quota the tenant's feed records `usage.threshold_reached` once.
//
// What a check counts: the database's month so far (slotlock.tenant_quota_usage: the usage recorded,
// and the bookings in the feed not yet rolled up), read at most every 30 seconds, and every 2 near
// the stop; plus this server's operations the database does not hold yet (the usage meter's), and
// the booking operations it ran since the read. Other servers' operations of the last 15 seconds or
// so are not seen, so a busy tenant can go a little past its stop; never by more than that.
// Off unless the deployment asks for it (SLOTLOCK_QUOTAS=on, with SLOTLOCK_USAGE=on).
import { type SlotlockAgentOperation, SlotlockAgentOperationError } from './agent-server.js';
import type { SlotlockApplicationOperation } from './application-api.js';
import { SLOTLOCK_QUOTA_METRICS, SLOTLOCK_QUOTA_NOTICE_PERCENTS } from './ddl.js';
import { SLOTLOCK_PLAN_QUOTAS, type SlotlockPlan } from './plans.js';
import type { SlotlockSql } from './store.js';
import type { SlotlockRecordedUsageMetric } from './usage.js';

export { SLOTLOCK_QUOTA_METRICS, SLOTLOCK_QUOTA_NOTICE_PERCENTS };
export type SlotlockQuotaMetric = (typeof SLOTLOCK_QUOTA_METRICS)[number];

/**
 * The operations that can make a booking (a reservation, an event, a confirmed hold) or hold a slot
 * for one: refused once the bookings quota is used up. Everything else, reads and cancellations
 * included, runs until the operations quota is.
 */
export const SLOTLOCK_BOOKING_OPERATIONS: readonly (SlotlockAgentOperation | SlotlockApplicationOperation)[] =
  Object.freeze([
    'slotlock_hold_slots',
    'slotlock_book_together',
    'slotlock_book_pool',
    'slotlock_create_event',
    'slotlock_acquire_hold',
    'slotlock_confirm_hold',
    'slotlock_put_reservation',
  ]);

/**
 * Operations a quota never refuses, though each still counts: reading the month's usage, so a
 * tenant can always see where it stands, and erasing the tenant, which no allowance may hold up.
 */
export const SLOTLOCK_QUOTA_EXEMPT_OPERATIONS: readonly SlotlockApplicationOperation[] = Object.freeze([
  'slotlock_get_usage',
  'slotlock_erase_tenant',
]);

/** How long a tenant's plan and counts are trusted, and how long near its stop. */
const REFRESH_MS = 30_000;
const NEAR_STOP_REFRESH_MS = 2_000;
/** The share of a stop past which counts are read again at NEAR_STOP_REFRESH_MS. */
const NEAR_STOP = 0.9;
/** Tenants one server remembers; past this the least recently checked tenth is dropped. */
const MAX_TENANTS = 50_000;

/** A tenant's operations and bookings so far this month, as the database holds them. */
export interface SlotlockQuotaUse {
  operations: number;
  bookings: number;
}

/** One quota of a tenant this month. */
export interface SlotlockQuotaStanding {
  metric: SlotlockQuotaMetric;
  /** The plan's quota. */
  quota: number;
  /** Where use is refused: the quota, or past it on a plan that allows a margin (Developer 110%). */
  stop: number;
  used: number;
  /** The month's first day, `YYYY-MM-DD` (UTC). */
  periodStart: string;
  /** When the month ends and the counts start again (the next month's first instant, UTC). */
  resetsAt: Date;
}

export type SlotlockQuotaCheck =
  /** `standings` is empty for a tenant with no plan, which no quota binds. */
  | { ok: true; standings: SlotlockQuotaStanding[] }
  | { ok: false; exceeded: SlotlockQuotaStanding; standings: SlotlockQuotaStanding[] };

/** A share of a quota the tenant reached, to note once (slotlock.note_usage_threshold). */
export interface SlotlockQuotaNotice {
  tenantRef: string;
  metric: SlotlockQuotaMetric;
  percent: (typeof SLOTLOCK_QUOTA_NOTICE_PERCENTS)[number];
  used: number;
  quota: number;
  /** The month's first day, `YYYY-MM-DD`. */
  periodStart: string;
}

export interface SlotlockQuotasOptions {
  /** The tenant's plan, or null when it has none (then no quota binds it). */
  plan(tenantRef: string): Promise<SlotlockPlan | null>;
  /** The tenant's operations and bookings from `fromDay` (`YYYY-MM-DD`) until now. */
  used(tenantRef: string, fromDay: string): Promise<SlotlockQuotaUse>;
  /**
   * What this server counted and has not recorded yet (the usage meter's `local`). Without it, only
   * what the database holds is counted.
   */
  local?(
    tenantRef: string,
    metric: SlotlockRecordedUsageMetric,
    fromDay: string,
  ): { unrecorded: number; counted: number };
  /** Note a share reached; the database sends each once. Not awaited; a failure is tried again. */
  notice?(notice: SlotlockQuotaNotice): Promise<unknown>;
  /** A plan or count that could not be read (the check then lets the operation run), or a notice. */
  onError?(error: unknown): void;
  /** Milliseconds since the epoch, for tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface SlotlockQuotas {
  /**
   * Where the tenant stands against its quotas, and whether `operation` may run. Never throws: a
   * plan or count it cannot read lets the operation run, on the last counts it read if any.
   */
  check(args: {
    tenantRef: string;
    operation: SlotlockAgentOperation | SlotlockApplicationOperation;
  }): Promise<SlotlockQuotaCheck>;
}

interface Entry {
  plan: SlotlockPlan | null;
  periodStart: string;
  /** When the read began, by `now`. */
  at: number;
  used: SlotlockQuotaUse;
  /** The meter's unrecorded operations and running total when the read began. */
  unrecorded: number;
  countedAtRead: number;
  /** Booking operations this server let run since the read began. */
  bookingsSinceRead: number;
}

/** The month an instant falls in: its first day and the next month's first instant, UTC. */
export function slotlockQuotaPeriod(at: number): { periodStart: string; resetsAt: Date } {
  const date = new Date(at);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return {
    periodStart: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
    resetsAt: new Date(Date.UTC(year, month + 1, 1)),
  };
}

export function createSlotlockQuotas(options: SlotlockQuotasOptions): SlotlockQuotas {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const reading = new Map<string, Promise<Entry | null>>();
  const noted = new Set<string>();

  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // A reporter's failure changes nothing.
    }
  };

  async function read(tenantRef: string, periodStart: string): Promise<Entry | null> {
    const at = now();
    const local = options.local?.(tenantRef, 'operations', periodStart) ?? { unrecorded: 0, counted: 0 };
    try {
      const plan = await options.plan(tenantRef);
      const used = plan ? await options.used(tenantRef, periodStart) : { operations: 0, bookings: 0 };
      const entry: Entry = {
        plan,
        periodStart,
        at,
        used: { operations: Number(used.operations) || 0, bookings: Number(used.bookings) || 0 },
        unrecorded: local.unrecorded,
        countedAtRead: local.counted,
        bookingsSinceRead: 0,
      };
      if (!entries.has(tenantRef) && entries.size >= MAX_TENANTS) {
        for (const key of [...entries.keys()].slice(0, Math.ceil(MAX_TENANTS / 10))) entries.delete(key);
      }
      entries.delete(tenantRef);
      entries.set(tenantRef, entry);
      return entry;
    } catch (error) {
      report(error);
      return null;
    }
  }

  function standingsOf(tenantRef: string, entry: Entry, resetsAt: Date): SlotlockQuotaStanding[] {
    if (!entry.plan) return [];
    const quotas = SLOTLOCK_PLAN_QUOTAS[entry.plan];
    const local = options.local?.(tenantRef, 'operations', entry.periodStart);
    // The read's unrecorded operations, and every one this meter counted since.
    const operations =
      entry.used.operations +
      entry.unrecorded +
      Math.max(0, (local?.counted ?? entry.countedAtRead) - entry.countedAtRead);
    const bookings = entry.used.bookings + entry.bookingsSinceRead;
    const standing = (metric: SlotlockQuotaMetric, used: number): SlotlockQuotaStanding => ({
      metric,
      quota: quotas[metric],
      stop: Math.floor((quotas[metric] * quotas.stopPercent) / 100),
      used,
      periodStart: entry.periodStart,
      resetsAt,
    });
    return [standing('operations', operations), standing('bookings', bookings)];
  }

  function notify(tenantRef: string, standings: readonly SlotlockQuotaStanding[]) {
    if (!options.notice) return;
    for (const standing of standings) {
      for (const percent of SLOTLOCK_QUOTA_NOTICE_PERCENTS) {
        if (standing.used * 100 < standing.quota * percent) continue;
        const key = `${tenantRef}\0${standing.periodStart}\0${standing.metric}\0${percent}`;
        if (noted.has(key)) continue;
        if (noted.size >= MAX_TENANTS) noted.clear();
        noted.add(key);
        try {
          options
            .notice({
              tenantRef,
              metric: standing.metric,
              percent,
              used: standing.used,
              quota: standing.quota,
              periodStart: standing.periodStart,
            })
            .catch((error: unknown) => {
              // Tried again at the next check that finds the share reached.
              noted.delete(key);
              report(error);
            });
        } catch (error) {
          noted.delete(key);
          report(error);
        }
      }
    }
  }

  return {
    async check({ tenantRef, operation }) {
      const at = now();
      const { periodStart, resetsAt } = slotlockQuotaPeriod(at);
      let entry = entries.get(tenantRef);
      const fresh = (found: Entry) => {
        if (found.periodStart !== periodStart) return false;
        const age = at - found.at;
        if (age < 0 || age >= REFRESH_MS) return false;
        if (age < NEAR_STOP_REFRESH_MS) return true;
        // Near a stop, the counts are read again sooner: the estimate since the read is rougher.
        return !standingsOf(tenantRef, found, resetsAt).some(
          (standing) => standing.used >= standing.stop * NEAR_STOP,
        );
      };
      if (!entry || !fresh(entry)) {
        let pending = reading.get(tenantRef);
        if (!pending) {
          pending = read(tenantRef, periodStart).finally(() => reading.delete(tenantRef));
          reading.set(tenantRef, pending);
        }
        const read_ = await pending;
        // A read that failed keeps the last counts of this month, if any; else nothing binds.
        if (read_) entry = read_;
        else if (entry?.periodStart !== periodStart) return { ok: true, standings: [] };
      }
      if (!entry) return { ok: true, standings: [] };
      const standings = standingsOf(tenantRef, entry, resetsAt);
      // Bookings are noticed as the database last counted them, never on the estimate since.
      notify(
        tenantRef,
        standings.map((standing) =>
          standing.metric === 'bookings' ? { ...standing, used: entry.used.bookings } : standing,
        ),
      );
      if ((SLOTLOCK_QUOTA_EXEMPT_OPERATIONS as readonly string[]).includes(operation)) {
        return { ok: true, standings };
      }
      const [operations, bookings] = standings;
      if (operations && operations.used >= operations.stop) {
        return { ok: false, exceeded: operations, standings };
      }
      const booking = SLOTLOCK_BOOKING_OPERATIONS.includes(operation);
      if (booking && bookings && bookings.used >= bookings.stop) {
        return { ok: false, exceeded: bookings, standings };
      }
      if (booking && entry.plan) entry.bookingsSinceRead += 1;
      return { ok: true, standings };
    },
  };
}

/** `slotlock.tenant_quota_usage`: the tenant's operations and bookings from `fromDay` until now. */
export async function readSlotlockQuotaUse(
  sql: SlotlockSql,
  tenantRef: string,
  fromDay: string,
): Promise<SlotlockQuotaUse> {
  const [row] = await sql<{ operations: string; bookings: string }[]>`
    SELECT operations, bookings FROM slotlock.tenant_quota_usage(${tenantRef}::text, ${fromDay}::date)`;
  return { operations: Number(row?.operations ?? 0), bookings: Number(row?.bookings ?? 0) };
}

/** `slotlock.note_usage_threshold`: true when this was the first notice of that share this month. */
export async function noteSlotlockQuotaThreshold(
  sql: SlotlockSql,
  notice: SlotlockQuotaNotice,
): Promise<boolean> {
  const [row] = await sql<{ noted: boolean }[]>`
    SELECT slotlock.note_usage_threshold(
      ${notice.tenantRef}::text, ${notice.periodStart}::date, ${notice.metric}::text,
      ${notice.percent}::integer, ${notice.used}::bigint, ${notice.quota}::bigint) AS noted`;
  return row?.noted === true;
}

/** The refusal of an operation over a quota: `quota_exceeded` (429), naming the quota and its reset. */
export function slotlockQuotaRefusal(exceeded: SlotlockQuotaStanding): SlotlockAgentOperationError {
  return new SlotlockAgentOperationError('quota_exceeded', 429, {
    metric: exceeded.metric,
    quota: String(exceeded.quota),
    stop: String(exceeded.stop),
    used: String(exceeded.used),
    resets_at: exceeded.resetsAt.toISOString(),
  });
}

/** The answer's fields for a tenant's quotas: RateLimit list members, and Retry-After when refused. */
export function slotlockQuotaFields(
  standings: readonly SlotlockQuotaStanding[],
  at: number,
): { rateLimit: string[]; policy: string[]; retryAfter: number } {
  const rateLimit: string[] = [];
  const policy: string[] = [];
  let retryAfter = 1;
  for (const standing of standings) {
    const name = `${standing.metric}_month`;
    const seconds = Math.max(1, Math.ceil((standing.resetsAt.getTime() - at) / 1_000));
    const window = Math.round(
      (standing.resetsAt.getTime() - Date.parse(`${standing.periodStart}T00:00:00Z`)) / 1_000,
    );
    rateLimit.push(`"${name}";r=${Math.max(0, standing.stop - standing.used)};t=${seconds}`);
    policy.push(`"${name}";q=${standing.stop};w=${window}`);
    retryAfter = Math.max(retryAfter, seconds);
  }
  return { rateLimit, policy, retryAfter };
}
