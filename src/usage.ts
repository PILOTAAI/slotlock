// Usage metering (RFC 0003 part 3): how much each tenant uses the service, by UTC day, API key and
// surface. Operations are counted by the server that runs them (`createSlotlockUsageMeter`, fed by
// the agent server's `onUsage`) and recorded in batches; bookings and holds are rolled up from the
// tenant's feed by maintenance, so a write that rolled back is never counted. Counts only, never
// arguments or results. Off unless the deployment asks for it (SLOTLOCK_USAGE=on).
import { randomUUID } from 'node:crypto';
import type { SlotlockAgentUsage } from './agent-server.js';
import {
  SLOTLOCK_RECORDED_USAGE_METRICS,
  SLOTLOCK_USAGE_METRICS,
  SLOTLOCK_USAGE_RETENTION_DAYS,
} from './ddl.js';
import type { SlotlockSql } from './store.js';

export type SlotlockUsageMetric = (typeof SLOTLOCK_USAGE_METRICS)[number];
/** What a server counts and records itself; bookings, holds and resources the database counts. */
export type SlotlockRecordedUsageMetric = (typeof SLOTLOCK_RECORDED_USAGE_METRICS)[number];
export { SLOTLOCK_RECORDED_USAGE_METRICS, SLOTLOCK_USAGE_METRICS, SLOTLOCK_USAGE_RETENTION_DAYS };

/** One counted row: a tenant's count of one metric on one UTC day, by key ('' for none) and surface. */
export interface SlotlockUsageCount {
  tenantRef: string;
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
  metric: SlotlockRecordedUsageMetric;
  keyId: string;
  origin: string;
  count: number;
}

/** Rows one `slotlock.record_usage` call takes. */
const MAX_BATCH_ROWS = 10_000;
/** Batches kept for another try while the database refuses them; older ones are dropped, and said so. */
const MAX_HELD_BATCHES = 100;
/** PostgreSQL's invalid_parameter_value: record_usage refusing a batch it will never take. */
const REFUSED_FOR_GOOD = '22023';
/** Tenants whose running totals one meter keeps (`local`); past this they start again from 0. */
const MAX_TOTALS = 100_000;

export interface SlotlockUsageMeterOptions {
  /** Records one batch once per `flushId`: true when added, false when it was added before. */
  record(flushId: string, rows: readonly SlotlockUsageCount[]): Promise<boolean>;
  /** How often counts are recorded, in milliseconds (default 15,000). 0: only on `flush`. */
  intervalMs?: number;
  now?: () => number;
  /** A batch the database refused (kept for the next flush), or one dropped after too many. */
  onError?: (error: unknown) => void;
}

export interface SlotlockUsageMeter {
  /** Count one operation (the agent server's `onUsage`). Never throws, never waits. */
  count(usage: SlotlockAgentUsage): void;
  /**
   * Count something else a server sees: webhook deliveries an endpoint accepted, messages to the
   * assistant. Never throws, never waits; a count below 1 is ignored.
   */
  add(usage: {
    tenantRef: string;
    metric: Exclude<SlotlockRecordedUsageMetric, 'operations'>;
    origin: string;
    count?: number;
    keyId?: string;
  }): void;
  /**
   * Record what has been counted. A batch the database refuses is kept, with its id, and sent again
   * first next time, so a batch whose answer was lost is never added twice.
   */
  flush(): Promise<void>;
  /** Stop the timer and record what is left. */
  close(): Promise<void>;
  /** Rows counted and not yet recorded, held batches included. */
  pending(): number;
  /**
   * What this meter has counted of a tenant's metric on `fromDay` (`YYYY-MM-DD`) or later and not
   * yet recorded, batches held or being sent included, and how much of it it has counted since it
   * started: quotas.ts adds them to what the database holds.
   */
  local(
    tenantRef: string,
    metric: SlotlockRecordedUsageMetric,
    fromDay: string,
  ): { unrecorded: number; counted: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The UTC day of an instant, `YYYY-MM-DD`. */
export function slotlockUsageDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function createSlotlockUsageMeter(options: SlotlockUsageMeterOptions): SlotlockUsageMeter {
  const now = options.now ?? Date.now;
  let counted = new Map<string, SlotlockUsageCount>();
  const held: Array<{ flushId: string; rows: SlotlockUsageCount[] }> = [];
  // Rows taken from `counted` for the flush under way, until each batch is recorded or held.
  let sending: SlotlockUsageCount[] = [];
  // Everything counted since the meter started, by tenant and metric.
  let totals = new Map<string, number>();
  let running: Promise<void> = Promise.resolve();

  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // A reporter's failure changes nothing.
    }
  };

  const dropped = (rows: number, why: string) =>
    report(
      Object.assign(new Error(`Slotlock usage: ${String(rows)} counts dropped ${why}`), {
        code: 'usage_dropped' as const,
      }),
    );

  // True when recorded, or when the database refused the batch for good (record_usage's
  // invalid_parameter_value: a day it no longer takes, after an outage past the next day), which is
  // then dropped rather than held in front of every batch after it. False to try again.
  async function send(batch: { flushId: string; rows: SlotlockUsageCount[] }): Promise<boolean> {
    try {
      await options.record(batch.flushId, batch.rows);
      return true;
    } catch (error) {
      report(error);
      if ((error as { code?: unknown } | null)?.code === REFUSED_FOR_GOOD) {
        dropped(batch.rows.length, 'that the database will not take');
        return true;
      }
      return false;
    }
  }

  async function flushOnce(): Promise<void> {
    // Batches refused before go first, under their own ids.
    while (held.length > 0) {
      if (!(await send(held[0] as { flushId: string; rows: SlotlockUsageCount[] }))) return;
      held.shift();
    }
    if (counted.size === 0) return;
    const rows = [...counted.values()];
    counted = new Map();
    sending = rows;
    try {
      for (let start = 0; start < rows.length; start += MAX_BATCH_ROWS) {
        const batch = { flushId: randomUUID(), rows: rows.slice(start, start + MAX_BATCH_ROWS) };
        if (held.length > 0 || !(await send(batch))) held.push(batch);
        sending = rows.slice(start + MAX_BATCH_ROWS);
      }
    } finally {
      sending = [];
    }
    while (held.length > MAX_HELD_BATCHES) {
      const oldest = held.shift();
      dropped(oldest?.rows.length ?? 0, `after the database refused them ${String(MAX_HELD_BATCHES)} times`);
    }
  }

  const flush = () => {
    running = running.then(flushOnce, flushOnce);
    return running;
  };

  const interval = options.intervalMs ?? 15_000;
  const timer = interval > 0 ? setInterval(() => void flush(), interval) : null;
  timer?.unref?.();

  function tally(
    tenantRef: unknown,
    metric: SlotlockRecordedUsageMetric,
    keyIdGiven: unknown,
    origin: string,
    count: number,
  ) {
    try {
      if (typeof tenantRef !== 'string' || tenantRef.length === 0) return;
      if (!Number.isSafeInteger(count) || count < 1) return;
      const keyId = typeof keyIdGiven === 'string' && UUID.test(keyIdGiven) ? keyIdGiven : '';
      const day = slotlockUsageDay(now());
      const key = `${tenantRef}\0${day}\0${metric}\0${keyId}\0${origin}`;
      const found = counted.get(key);
      if (found) found.count += count;
      else counted.set(key, { tenantRef, day, metric, keyId, origin, count });
      const total = `${tenantRef}\0${metric}`;
      if (!totals.has(total) && totals.size >= MAX_TOTALS) totals = new Map();
      totals.set(total, (totals.get(total) ?? 0) + count);
    } catch {
      // Metering never changes a call.
    }
  }

  return {
    count({ principal, origin }) {
      tally(principal.tenantRef, 'operations', principal.keyId, origin, 1);
    },
    add({ tenantRef, metric, origin, count = 1, keyId }) {
      tally(tenantRef, metric, keyId, origin, count);
    },
    flush,
    async close() {
      if (timer) clearInterval(timer);
      await flush();
    },
    pending() {
      return [...counted.values()].length + held.reduce((sum, batch) => sum + batch.rows.length, 0);
    },
    local(tenantRef, metric, fromDay) {
      let unrecorded = 0;
      const add = (row: SlotlockUsageCount) => {
        if (row.tenantRef === tenantRef && row.metric === metric && row.day >= fromDay) {
          unrecorded += row.count;
        }
      };
      for (const row of counted.values()) add(row);
      for (const row of sending) add(row);
      for (const batch of held) for (const row of batch.rows) add(row);
      return { unrecorded, counted: totals.get(`${tenantRef}\0${metric}`) ?? 0 };
    },
  };
}

/** `slotlock.record_usage`: one batch of counts, once per flush id. */
export async function recordSlotlockUsage(
  sql: SlotlockSql,
  flushId: string,
  rows: readonly SlotlockUsageCount[],
): Promise<boolean> {
  const payload = rows.map((row) => ({
    tenant_ref: row.tenantRef,
    day: row.day,
    metric: row.metric,
    key_id: row.keyId,
    origin: row.origin,
    count: row.count,
  }));
  const [result] = await sql<{ added: boolean }[]>`
    SELECT slotlock.record_usage(${flushId}::uuid, ${JSON.stringify(payload)}::text::jsonb) AS added`;
  return result?.added === true;
}

/** One stored row of a tenant's usage. */
export interface SlotlockUsageRow {
  day: string;
  metric: SlotlockUsageMetric;
  keyId: string;
  origin: string;
  count: number;
}

/** The tenant's usage from `from` to `to`, UTC days inclusive (at most SLOTLOCK_USAGE_RETENTION_DAYS apart). */
export async function readSlotlockTenantUsage(
  sql: SlotlockSql,
  tenantRef: string,
  from: string,
  to: string,
): Promise<SlotlockUsageRow[]> {
  const rows = await sql<
    { day: Date | string; metric: SlotlockUsageMetric; key_id: string; origin: string; count: string | number }[]
  >`SELECT * FROM slotlock.tenant_usage(${tenantRef}::text, ${from}::date, ${to}::date)`;
  return rows.map((row) => ({
    day: typeof row.day === 'string' ? row.day.slice(0, 10) : slotlockUsageDay(row.day.getTime()),
    metric: row.metric,
    keyId: row.key_id,
    origin: row.origin,
    count: Number(row.count),
  }));
}

/**
 * Each metric's total over some rows: every metric present, 0 when unused. Resources are a count
 * each day, not something used up, so theirs is the latest day's.
 */
export function totalSlotlockUsage(rows: readonly SlotlockUsageRow[]): Record<SlotlockUsageMetric, number> {
  const totals = Object.fromEntries(SLOTLOCK_USAGE_METRICS.map((metric) => [metric, 0])) as Record<
    SlotlockUsageMetric,
    number
  >;
  let resourcesDay = '';
  for (const row of rows) {
    if (row.metric !== 'resources') totals[row.metric] += row.count;
    else if (row.day > resourcesDay) {
      resourcesDay = row.day;
      totals.resources = row.count;
    } else if (row.day === resourcesDay) totals.resources += row.count;
  }
  return totals;
}

/** Operations, bookings and holds together: one line of a usage summary. */
export type SlotlockUsageTotals = Record<SlotlockUsageMetric, number>;

/** A tenant's usage over a range, as `GET /v1/usage` and the Plan page show it. */
export interface SlotlockUsageSummary {
  totals: SlotlockUsageTotals;
  /** Each UTC day with any use, in order. */
  days: Array<{ day: string } & SlotlockUsageTotals>;
  /** Each API key with any use (`keyId` null: no key, such as the assistant), most operations first; no resources. */
  keys: Array<{ keyId: string | null } & SlotlockUsageTotals>;
  /** Each surface with any use (mcp, a2a, rest, application, dashboard-assistant, webhooks), most first; no resources. */
  surfaces: Array<{ origin: string } & SlotlockUsageTotals>;
}

/** Totals, by day, by key and by surface, from stored rows: bounded however many rows there are. */
export function summarizeSlotlockUsage(rows: readonly SlotlockUsageRow[]): SlotlockUsageSummary {
  const zero = (): SlotlockUsageTotals => totalSlotlockUsage([]);
  const days = new Map<string, SlotlockUsageTotals>();
  const keys = new Map<string, SlotlockUsageTotals>();
  const surfaces = new Map<string, SlotlockUsageTotals>();
  const add = (map: Map<string, SlotlockUsageTotals>, name: string, row: SlotlockUsageRow) => {
    const found = map.get(name) ?? zero();
    found[row.metric] += row.count;
    map.set(name, found);
  };
  for (const row of rows) {
    add(days, row.day, row);
    // A day's resource count belongs to no key or surface.
    if (row.metric === 'resources') continue;
    add(keys, row.keyId, row);
    add(surfaces, row.origin, row);
  }
  const byUse = (a: SlotlockUsageTotals, b: SlotlockUsageTotals) =>
    b.operations - a.operations ||
    b.bookings - a.bookings ||
    b.holds - a.holds ||
    b.webhook_deliveries - a.webhook_deliveries ||
    b.assistant_messages - a.assistant_messages;
  return {
    totals: totalSlotlockUsage(rows),
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, totals]) => ({ day, ...totals })),
    keys: [...keys]
      .sort(([a, x], [b, y]) => byUse(x, y) || a.localeCompare(b))
      .map(([keyId, totals]) => ({ keyId: keyId === '' ? null : keyId, ...totals })),
    surfaces: [...surfaces]
      .sort(([a, x], [b, y]) => byUse(x, y) || a.localeCompare(b))
      .map(([origin, totals]) => ({ origin, ...totals })),
  };
}

/** The range `GET /v1/usage` reads when given none: the first of this UTC month to today. */
export function slotlockUsageMonthToDate(at: number): { from: string; to: string } {
  const to = slotlockUsageDay(at);
  return { from: `${to.slice(0, 8)}01`, to };
}

/** Days from `from` to `to`, both `YYYY-MM-DD`: 0 for the same day, negative when `to` is earlier. */
export function slotlockUsageSpanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
