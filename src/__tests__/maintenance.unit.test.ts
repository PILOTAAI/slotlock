// Maintenance: one pass per tenant (roll the horizon, then prune), a per-tenant lock so servers
// never repeat each other's work, and the scheduler `slotlock serve` runs. Stand-ins for the store
// and the connection record every call; the real ones run in self-host.integration.test.ts.
import type { Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SlotlockMaintenanceResult,
  maintainSlotlockTenant,
  startSlotlockMaintenance,
  withSlotlockMaintenanceLock,
} from '../maintenance.js';
import type { SlotlockStore } from '../store.js';
import type {
  BookingRetentionResult,
  CalendarEventRetentionResult,
  CalendarHorizonRollResult,
} from '../types.js';

// The timers a test runs on, before startSlotlockMaintenance's tests fake them.
const realSetTimeout = globalThis.setTimeout;

const DONE_ROLL: CalendarHorizonRollResult = {
  examined: 0,
  extended: 0,
  conflicts: 0,
  conflictEventIds: [],
  refused: 0,
  refusedEventIds: [],
  hasMore: false,
  next: null,
};
const DONE_PRUNE: CalendarEventRetentionResult = { commandsDeleted: 0, tombstonesDeleted: 0, hasMore: false };
const DONE_PURGE: BookingRetentionResult = {
  expiredHoldsDeleted: 0,
  holdCommandsDeleted: 0,
  tombstonesDeleted: 0,
  hasMore: false,
};
const cursor = (n: number) => ({ materializedEndsAt: new Date(Date.UTC(2027, 0, n)), eventId: `event-${n}` });

/** A store whose tenants answer from queues of results, then with nothing left to do. */
function fakeStore() {
  const rolls = new Map<string, CalendarHorizonRollResult[]>();
  const prunes = new Map<string, CalendarEventRetentionResult[]>();
  const purges = new Map<string, BookingRetentionResult[]>();
  const calls: {
    tenantRef: string;
    task: 'roll' | 'prune' | 'purge';
    params: Record<string, unknown>;
  }[] = [];
  let gate: Promise<void> | null = null;
  const store = {
    async withTenant(tenantRef: string, callback: (tenant: unknown) => Promise<unknown>) {
      if (gate) await gate;
      return callback({
        async rollCalendarEventHorizon(params: Record<string, unknown>) {
          calls.push({ tenantRef, task: 'roll', params });
          const failure = rolls.get(tenantRef)?.[0];
          if (failure && 'fail' in failure) throw (failure as { fail: Error }).fail;
          return rolls.get(tenantRef)?.shift() ?? DONE_ROLL;
        },
        async pruneCalendarEventRetention(params: Record<string, unknown>) {
          calls.push({ tenantRef, task: 'prune', params });
          return prunes.get(tenantRef)?.shift() ?? DONE_PRUNE;
        },
        async pruneBookingRetention(params: Record<string, unknown>) {
          calls.push({ tenantRef, task: 'purge', params });
          return purges.get(tenantRef)?.shift() ?? DONE_PURGE;
        },
      });
    },
  } as unknown as SlotlockStore;
  return {
    store,
    calls,
    roll: (tenantRef: string, ...results: CalendarHorizonRollResult[]) => rolls.set(tenantRef, results),
    prune: (tenantRef: string, ...results: CalendarEventRetentionResult[]) => prunes.set(tenantRef, results),
    purge: (tenantRef: string, ...results: BookingRetentionResult[]) => purges.set(tenantRef, results),
    fail: (tenantRef: string, error: Error) =>
      rolls.set(tenantRef, [{ fail: error } as unknown as CalendarHorizonRollResult]),
    /** Hold every pass until the returned function is called. */
    pause() {
      let open = () => undefined as void;
      gate = new Promise<void>((resolve) => {
        open = () => {
          gate = null;
          resolve();
        };
      });
      return open;
    },
  };
}

/** A connection whose advisory locks live in `held`, shared by every "server" given the same set. */
function fakeSql(held = new Set<string>()) {
  const log: string[] = [];
  let reserved = 0;
  const sql = {
    async reserve() {
      reserved += 1;
      const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?');
        const key = String(values[0]);
        if (text.includes('pg_try_advisory_lock')) {
          if (held.has(key)) return [{ locked: false }];
          held.add(key);
          log.push(`lock ${key}`);
          return [{ locked: true }];
        }
        if (text.includes('pg_advisory_unlock')) {
          held.delete(key);
          log.push(`unlock ${key}`);
          return [{ pg_advisory_unlock: true }];
        }
        throw new Error(`unexpected query: ${text}`);
      };
      return Object.assign(query, {
        release: () => {
          reserved -= 1;
          log.push('release');
        },
      });
    },
  } as unknown as Sql;
  return { sql, held, log, reserved: () => reserved };
}

const result = (overrides: Partial<SlotlockMaintenanceResult> = {}): SlotlockMaintenanceResult => ({
  extended: 0,
  conflicts: 0,
  refused: 0,
  pruned: 0,
  capped: false,
  ...overrides,
});

describe('maintainSlotlockTenant', () => {
  it('pages the roll with each batch\'s next, then prunes until nothing is left, and sums both', async () => {
    const fake = fakeStore();
    fake.roll(
      'fleet',
      { ...DONE_ROLL, examined: 3, extended: 2, conflicts: 1, hasMore: true, next: cursor(1) },
      { ...DONE_ROLL, examined: 2, extended: 1, refused: 1, refusedEventIds: ['e'], next: null },
    );
    fake.prune('fleet', { commandsDeleted: 100, tombstonesDeleted: 0, hasMore: true }, { commandsDeleted: 4, tombstonesDeleted: 3, hasMore: false });
    expect(await maintainSlotlockTenant(fake.store, 'fleet')).toEqual(
      result({ extended: 3, conflicts: 1, refused: 1, pruned: 107 }),
    );
    expect(fake.calls.map(({ task, params }) => [task, params.after ?? null])).toEqual([
      ['roll', null],
      ['roll', cursor(1)],
      ['prune', null],
      ['purge', null],
      ['prune', null],
    ]);
    // One rolling window for the whole pass, and always the tenant it was given.
    const windows = fake.calls.filter(({ task }) => task === 'roll').map(({ params }) => params.window);
    expect(windows[1]).toBe(windows[0]);
    expect(new Set(fake.calls.map(({ tenantRef, params }) => `${tenantRef}/${params.tenantRef}`))).toEqual(
      new Set(['fleet/fleet']),
    );
  });

  it('purges expired holds and prunes booking bookkeeping alongside, counting them as pruned', async () => {
    const fake = fakeStore();
    fake.purge(
      'fleet',
      { expiredHoldsDeleted: 100, holdCommandsDeleted: 2, tombstonesDeleted: 1, hasMore: true },
      { expiredHoldsDeleted: 20, holdCommandsDeleted: 0, tombstonesDeleted: 0, hasMore: false },
    );
    expect(await maintainSlotlockTenant(fake.store, 'fleet')).toEqual(result({ pruned: 123 }));
    expect(fake.calls.map(({ task, params }) => [task, params.tenantRef])).toEqual([
      ['roll', 'fleet'],
      ['prune', 'fleet'],
      ['purge', 'fleet'],
      ['purge', 'fleet'],
    ]);
    const capped = fakeStore();
    capped.purge('fleet', { ...DONE_PURGE, expiredHoldsDeleted: 100, hasMore: true });
    expect(await maintainSlotlockTenant(capped.store, 'fleet', { batches: 1 })).toEqual(
      result({ pruned: 100, capped: true }),
    );
  });

  it('stops each task after `batches` and says there is more', async () => {
    const fake = fakeStore();
    fake.roll('fleet', ...[1, 2, 3].map((n) => ({ ...DONE_ROLL, extended: 1, hasMore: true, next: cursor(n) })));
    expect(await maintainSlotlockTenant(fake.store, 'fleet', { batches: 2 })).toEqual(
      result({ extended: 2, capped: true }),
    );
    const prunes = fakeStore();
    prunes.prune('fleet', ...[1, 2].map(() => ({ commandsDeleted: 5, tombstonesDeleted: 0, hasMore: true })));
    expect(await maintainSlotlockTenant(prunes.store, 'fleet', { batches: 1 })).toEqual(
      result({ pruned: 5, capped: true }),
    );
  });

  it.each([0, 101, 1.5, Number.NaN])('refuses %s batches before any work', async (batches) => {
    const fake = fakeStore();
    await expect(maintainSlotlockTenant(fake.store, 'fleet', { batches })).rejects.toThrow(RangeError);
    expect(fake.calls).toEqual([]);
  });

  it('stops between batches once its signal aborts, with the signal\'s reason', async () => {
    const fake = fakeStore();
    const controller = new AbortController();
    const reason = new Error('shutting down');
    fake.roll('fleet', { ...DONE_ROLL, hasMore: true, next: cursor(1) });
    const store = {
      withTenant: async (tenantRef: string, callback: (tenant: unknown) => Promise<unknown>) => {
        const value = await fake.store.withTenant(tenantRef, callback as never);
        controller.abort(reason);
        return value;
      },
    } as unknown as SlotlockStore;
    await expect(maintainSlotlockTenant(store, 'fleet', { signal: controller.signal })).rejects.toBe(reason);
    expect(fake.calls).toHaveLength(1);
    await expect(maintainSlotlockTenant(fake.store, 'fleet', { signal: controller.signal })).rejects.toBe(reason);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('withSlotlockMaintenanceLock', () => {
  it('runs the work holding the tenant\'s lock on a connection of its own, then lets both go', async () => {
    const { sql, log, reserved } = fakeSql();
    expect(await withSlotlockMaintenanceLock(sql, 'fleet', async () => 'done')).toBe('done');
    expect(log).toEqual(['lock slotlock.maintenance:fleet', 'unlock slotlock.maintenance:fleet', 'release']);
    expect(reserved()).toBe(0);
  });

  it('runs nothing while another server holds the lock, and still returns the connection', async () => {
    const { sql, held, log, reserved } = fakeSql(new Set(['slotlock.maintenance:fleet']));
    const work = vi.fn(async () => 'done');
    expect(await withSlotlockMaintenanceLock(sql, 'fleet', work)).toBeUndefined();
    expect(work).not.toHaveBeenCalled();
    expect(held.has('slotlock.maintenance:fleet')).toBe(true);
    expect(log).toEqual(['release']);
    expect(reserved()).toBe(0);
    // Another tenant's lock is its own.
    expect(await withSlotlockMaintenanceLock(sql, 'other', async () => 'done')).toBe('done');
  });

  it('unlocks and returns the connection when the work fails', async () => {
    const { sql, held, log, reserved } = fakeSql();
    const failure = new Error('roll failed');
    await expect(
      withSlotlockMaintenanceLock(sql, 'fleet', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(held.size).toBe(0);
    expect(log).toEqual(['lock slotlock.maintenance:fleet', 'unlock slotlock.maintenance:fleet', 'release']);
    expect(reserved()).toBe(0);
  });
});

describe('startSlotlockMaintenance', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.UTC(2027, 0, 1) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let queued passes run to the end. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  };
  const HOUR = 3_600_000;
  const tenantsMaintained = (fake: ReturnType<typeof fakeStore>) =>
    fake.calls.filter(({ task }) => task === 'prune').map(({ tenantRef }) => tenantRef);

  it.each([0, 999, 86_400_001, 1.5])('refuses an interval of %s ms', (intervalMs) => {
    const fake = fakeStore();
    expect(() =>
      startSlotlockMaintenance({ store: fake.store, sql: fakeSql().sql, tenants: [], intervalMs }),
    ).toThrow(RangeError);
  });

  it('maintains its tenants at once, one at a time, then each again every interval', async () => {
    const fake = fakeStore();
    const onPass = vi.fn();
    const scheduler = startSlotlockMaintenance({
      store: fake.store,
      sql: fakeSql().sql,
      tenants: ['fleet-a', 'fleet-b'],
      intervalMs: HOUR,
      onPass,
    });
    await settle();
    expect(tenantsMaintained(fake)).toEqual(['fleet-a', 'fleet-b']);
    expect(onPass).toHaveBeenCalledTimes(2);
    expect(onPass).toHaveBeenCalledWith(result());

    await vi.advanceTimersByTimeAsync(HOUR - 60_000);
    expect(tenantsMaintained(fake)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(tenantsMaintained(fake)).toEqual(['fleet-a', 'fleet-b', 'fleet-a', 'fleet-b']);
    await scheduler.close();
  });

  it('adds a tenant it serves, once per interval however often it is served', async () => {
    const fake = fakeStore();
    const scheduler = startSlotlockMaintenance({
      store: fake.store,
      sql: fakeSql().sql,
      tenants: [],
      intervalMs: HOUR,
    });
    await settle();
    expect(tenantsMaintained(fake)).toEqual([]);
    for (let i = 0; i < 5; i++) scheduler.touch('github:42');
    await settle();
    scheduler.touch('github:42');
    await settle();
    expect(tenantsMaintained(fake)).toEqual(['github:42']);
    await vi.advanceTimersByTimeAsync(HOUR);
    await settle();
    expect(tenantsMaintained(fake)).toEqual(['github:42', 'github:42']);
    await scheduler.close();
  });

  it('goes round again at once while a capped pass gets somewhere, and waits when it does not', async () => {
    const fake = fakeStore();
    // Ten batches of one extended series, then the rest: two passes back to back.
    fake.roll('fleet', ...Array.from({ length: 12 }, (_, n) => ({ ...DONE_ROLL, extended: 1, hasMore: true, next: cursor(n + 1) })));
    // Another tenant whose only due series are ones it cannot extend: capped, but no progress. The
    // store puts those behind the rest, so it goes round once more to reach what lies behind them,
    // and then waits: a store that kept answering the same ones never loops.
    fake.roll('stuck', ...Array.from({ length: 30 }, (_, n) => ({ ...DONE_ROLL, refused: 1, hasMore: true, next: cursor(n + 1) })));
    const onPass = vi.fn();
    const scheduler = startSlotlockMaintenance({
      store: fake.store,
      sql: fakeSql().sql,
      tenants: ['fleet', 'stuck'],
      intervalMs: HOUR,
      onPass,
    });
    await settle();
    await settle();
    expect(onPass.mock.calls.map(([pass]) => pass)).toEqual([
      result({ extended: 10, capped: true }),
      result({ refused: 10, capped: true }),
      result({ extended: 2 }),
      result({ refused: 10, capped: true }),
    ]);
    await settle();
    expect(onPass).toHaveBeenCalledTimes(4);
    await scheduler.close();
  });

  it('reports a failed pass, carries on with the next tenant, and survives a failing reporter', async () => {
    const fake = fakeStore();
    const failure = new Error('connection reset');
    fake.fail('broken', failure);
    const onError = vi.fn(() => {
      throw new Error('the logger is down');
    });
    const onPass = vi.fn();
    const scheduler = startSlotlockMaintenance({
      store: fake.store,
      sql: fakeSql().sql,
      tenants: ['broken', 'fine'],
      intervalMs: HOUR,
      onPass,
      onError,
    });
    await settle();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(onPass).toHaveBeenCalledTimes(1);
    expect(tenantsMaintained(fake)).toEqual(['fine']);
    // The failed tenant waits for the next interval rather than failing in a loop.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(onError).toHaveBeenCalledTimes(1);
    await scheduler.close();
  });

  it('lets a reporter that throws or rejects change nothing', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      const fake = fakeStore();
      fake.fail('broken', new Error('connection reset'));
      const onError = vi.fn(async () => {
        throw new Error('the logger is down');
      });
      // The first pass's report throws, the second's rejects.
      const onPass = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('the metrics sink is down');
        })
        .mockImplementationOnce(async () => {
          throw new Error('the metrics sink is down');
        });
      const scheduler = startSlotlockMaintenance({
        store: fake.store,
        sql: fakeSql().sql,
        tenants: ['fine', 'broken', 'also-fine'],
        intervalMs: HOUR,
        onPass,
        onError,
      });
      await settle();
      await new Promise((resolve) => realSetTimeout(resolve, 20));
      // Only the pass that failed is reported as failed.
      expect({
        passes: onPass.mock.calls.length,
        failures: onError.mock.calls.length,
        maintained: tenantsMaintained(fake),
        unhandled,
      }).toEqual({ passes: 2, failures: 1, maintained: ['fine', 'also-fine'], unhandled: [] });
      await scheduler.close();
    } finally {
      process.off('unhandledRejection', record);
    }
  });

  it('skips a tenant another server is maintaining until the next interval', async () => {
    const fake = fakeStore();
    const held = new Set(['slotlock.maintenance:fleet']);
    const onPass = vi.fn();
    const scheduler = startSlotlockMaintenance({
      store: fake.store,
      sql: fakeSql(held).sql,
      tenants: ['fleet'],
      intervalMs: HOUR,
      onPass,
    });
    await settle();
    expect(fake.calls).toEqual([]);
    expect(onPass).not.toHaveBeenCalled();
    held.clear();
    scheduler.touch('fleet');
    await settle();
    expect(fake.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(HOUR);
    await settle();
    expect(tenantsMaintained(fake)).toEqual(['fleet']);
    await scheduler.close();
  });

  it('forgets the tenant served longest ago past maxTenants, never a configured one', async () => {
    const fake = fakeStore();
    const scheduler = startSlotlockMaintenance({
      store: fake.store,
      sql: fakeSql().sql,
      tenants: ['pinned'],
      intervalMs: HOUR,
      maxTenants: 2,
    });
    for (const tenant of ['a', 'b', 'c']) scheduler.touch(tenant);
    scheduler.touch('b');
    await settle();
    expect(tenantsMaintained(fake).sort()).toEqual(['a', 'b', 'c', 'pinned']);
    // A new tenant past the limit forgets the one served longest ago: a; then c.
    scheduler.touch('d');
    await settle();
    await vi.advanceTimersByTimeAsync(HOUR);
    await settle();
    expect(tenantsMaintained(fake).slice(5).sort()).toEqual(['b', 'd', 'pinned']);
    await scheduler.close();
  });

  it('closes by stopping the pass in progress and waiting for it, and starts nothing after', async () => {
    const fake = fakeStore();
    const open = fake.pause();
    const onPass = vi.fn();
    const onError = vi.fn();
    const scheduler = startSlotlockMaintenance({
      store: fake.store,
      sql: fakeSql().sql,
      tenants: ['fleet', 'next'],
      intervalMs: HOUR,
      onPass,
      onError,
    });
    await settle();
    let closed = false;
    const closing = scheduler.close().then(() => {
      closed = true;
    });
    await settle();
    expect(closed).toBe(false);
    open();
    await closing;
    expect(onPass).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    scheduler.touch('later');
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(tenantsMaintained(fake)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
