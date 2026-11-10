// Usage metering (RFC 0003 part 3): how much each tenant uses the service, by UTC day, API key and
// surface. Operations are counted by the server that runs them (`createSlotlockUsageMeter`, fed by
// the agent server's `onUsage`) and recorded in batches; bookings and holds are rolled up from the
// tenant's feed by maintenance, so a write that rolled back is never counted. Counts only, never
// arguments or results. Off unless the deployment asks for it (SLOTLOCK_USAGE=on).
import { randomUUID } from 'node:crypto';
import type { SlotlockAgentUsage } from './agent-server.js';
import { SLOTLOCK_USAGE_METRICS, SLOTLOCK_USAGE_RETENTION_DAYS } from './ddl.js';
import type { SlotlockSql } from './store.js';

export type SlotlockUsageMetric = (typeof SLOTLOCK_USAGE_METRICS)[number];
export { SLOTLOCK_USAGE_METRICS, SLOTLOCK_USAGE_RETENTION_DAYS };

/** One counted row: a tenant's operations on one UTC day, by key ('' for none) and surface. */
export interface SlotlockUsageCount {
  tenantRef: string;
  /** The UTC day, `YYYY-MM-DD`. */
  day: string;
  keyId: string;
  origin: string;
  count: number;
}

/** Rows one `slotlock.record_usage` call takes. */
const MAX_BATCH_ROWS = 10_000;
/** Batches kept for another try while the database refuses them; older ones are dropped, and said so. */
const MAX_HELD_BATCHES = 100;

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
   * Record what has been counted. A batch the database refuses is kept, with its id, and sent again
   * first next time, so a batch whose answer was lost is never added twice.
   */
  flush(): Promise<void>;
  /** Stop the timer and record what is left. */
  close(): Promise<void>;
  /** Rows counted and not yet recorded, held batches included. */
  pending(): number;
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
  let running: Promise<void> = Promise.resolve();

  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch {
      // A reporter's failure changes nothing.
    }
  };

  async function send(batch: { flushId: string; rows: SlotlockUsageCount[] }): Promise<boolean> {
    try {
      await options.record(batch.flushId, batch.rows);
      return true;
    } catch (error) {
      report(error);
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
    for (let start = 0; start < rows.length; start += MAX_BATCH_ROWS) {
      const batch = { flushId: randomUUID(), rows: rows.slice(start, start + MAX_BATCH_ROWS) };
      if (held.length > 0 || !(await send(batch))) held.push(batch);
    }
    while (held.length > MAX_HELD_BATCHES) {
      const dropped = held.shift();
      report(
        Object.assign(
          new Error(
            `Slotlock usage: ${String(dropped?.rows.length ?? 0)} counts dropped after the database refused them ${String(MAX_HELD_BATCHES)} times`,
          ),
          { code: 'usage_dropped' as const },
        ),
      );
    }
  }

  const flush = () => {
    running = running.then(flushOnce, flushOnce);
    return running;
  };

  const interval = options.intervalMs ?? 15_000;
  const timer = interval > 0 ? setInterval(() => void flush(), interval) : null;
  timer?.unref?.();

  return {
    count({ principal, origin }) {
      try {
        const tenantRef = principal.tenantRef;
        if (typeof tenantRef !== 'string' || tenantRef.length === 0) return;
        const keyId = typeof principal.keyId === 'string' && UUID.test(principal.keyId) ? principal.keyId : '';
        const day = slotlockUsageDay(now());
        const key = `${tenantRef}\0${day}\0${keyId}\0${origin}`;
        const found = counted.get(key);
        if (found) found.count += 1;
        else counted.set(key, { tenantRef, day, keyId, origin, count: 1 });
      } catch {
        // Metering never changes a call.
      }
    },
    flush,
    async close() {
      if (timer) clearInterval(timer);
      await flush();
    },
    pending() {
      return [...counted.values()].length + held.reduce((sum, batch) => sum + batch.rows.length, 0);
    },
  };
}

/** `slotlock.record_usage`: one batch of operation counts, once per flush id. */
export async function recordSlotlockUsage(
  sql: SlotlockSql,
  flushId: string,
  rows: readonly SlotlockUsageCount[],
): Promise<boolean> {
  const payload = rows.map((row) => ({
    tenant_ref: row.tenantRef,
    day: row.day,
    metric: 'operations',
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

/** Each metric's total over some rows: every metric present, 0 when unused. */
export function totalSlotlockUsage(rows: readonly SlotlockUsageRow[]): Record<SlotlockUsageMetric, number> {
  const totals = Object.fromEntries(SLOTLOCK_USAGE_METRICS.map((metric) => [metric, 0])) as Record<
    SlotlockUsageMetric,
    number
  >;
  for (const row of rows) totals[row.metric] += row.count;
  return totals;
}
