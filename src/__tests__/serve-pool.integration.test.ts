// `slotlock serve`'s one pool of 10 connections, which every tenant shares: one tenant's creates
// waiting on its own tenant-limit lock behind a 2,000-occurrence series held every connection, and
// another tenant's trivial transaction waited about a second for one (2026-10-26 security audit,
// serve-pool). The store is built as serve builds it, and driven as the agent backend drives it.
// Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLOTLOCK_DEFAULT_LIMITS } from '../config.js';
import { slotlockTenantLockKey } from '../ddl.js';
import { createSlotlockServeStore } from '../self-host.js';
import { type SlotlockStore, calendarEventRollingHorizon, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WRITE = { isolation: 'read committed' } as const;

describe.skipIf(!url)("serve's shared pool under one tenant's lock waits (real Postgres)", () => {
  let owner: ReturnType<typeof postgres>;
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenants: string[] = [];

  beforeAll(async () => {
    owner = postgres(url as string, { max: 2, onnotice: () => {} });
    await createSlotlockStore(owner).applySchema();
    // serve's pool (POOL_SIZE) and its store.
    sql = postgres(url as string, { max: 10, onnotice: () => {}, connect_timeout: 10 });
    store = createSlotlockServeStore(sql, SLOTLOCK_DEFAULT_LIMITS.caps);
  });

  afterAll(async () => {
    for (const tenantRef of tenants) await createSlotlockStore(owner).eraseTenant({ tenantRef });
    await sql.end();
    await owner.end();
  });

  function freshTenant(): string {
    const tenantRef = `pool-${randomUUID()}`;
    tenants.push(tenantRef);
    return tenantRef;
  }

  async function resource(tenantRef: string): Promise<string> {
    return (
      await store.withTenant(tenantRef, (tenant) =>
        tenant.createResource({ tenantRef, externalRef: `car-${randomUUID()}`, timezone: 'UTC' }),
      )
    ).id;
  }

  async function timeTransaction(tenantRef: string): Promise<number> {
    const started = performance.now();
    await store.withTenant(tenantRef, async () => 1);
    return performance.now() - started;
  }

  it("answers another tenant's transaction at once while one tenant's creates queue behind its 2,000-occurrence series", { timeout: 120_000 }, async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    // An agent key's owner, so each write takes the owner-quota lock as well as the events limit's.
    const ownerRef = `agent:${'b'.repeat(64)}`;
    const seriesResource = await resource(tenantA);
    const singlesResource = await resource(tenantA);
    await resource(tenantB);
    await timeTransaction(tenantB);
    const horizon = calendarEventRollingHorizon();
    const start = new Date(horizon.start.getTime() + 2 * DAY_MS);

    let seriesDone = false;
    const series = store
      .withTenant(
        tenantA,
        (tenant) =>
          tenant.putCalendarEvent({
            tenantRef: tenantA,
            ownerRef,
            externalRef: 'series',
            idempotencyKey: 'series',
            expectedRevision: 0,
            resourceId: seriesResource,
            start,
            end: new Date(start.getTime() + HOUR_MS / 2),
            timezone: 'UTC',
            summary: 'series',
            transparency: 'opaque',
            recurrence: { rrule: 'FREQ=DAILY;BYHOUR=0,2,4,6,8,10,12,14,16,18,20,22;COUNT=2000' },
            materializationWindow: horizon,
          }),
        WRITE,
      )
      .finally(() => {
        seriesDone = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const singles = Array.from({ length: 12 }, (_, index) => {
      const at = new Date(start.getTime() + (index + 1) * DAY_MS + HOUR_MS / 4);
      const end = new Date(at.getTime() + HOUR_MS / 4);
      return store.withTenant(
        tenantA,
        (tenant) =>
          tenant.putCalendarEvent({
            tenantRef: tenantA,
            ownerRef,
            externalRef: `single-${index}`,
            idempotencyKey: `single-${index}`,
            expectedRevision: 0,
            resourceId: singlesResource,
            start: at,
            end,
            timezone: 'UTC',
            summary: 'single',
            materializationWindow: { start: at, end },
          }),
        WRITE,
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Started while tenant A's series still holds its locks.
    expect(seriesDone).toBe(false);
    expect(await timeTransaction(tenantB)).toBeLessThan(150);
    expect((await series).ok).toBe(true);
    expect((await Promise.all(singles)).every((put) => put.ok)).toBe(true);
  });

  it("runs as many of one tenant's transactions at once as SLOTLOCK_LIMITS tenant_transactions says", async () => {
    const tenantRef = freshTenant();
    for (const [caps, expected] of [
      [SLOTLOCK_DEFAULT_LIMITS.caps, 2],
      [{ ...SLOTLOCK_DEFAULT_LIMITS.caps, tenant_transactions: 1 }, 1],
      [{ ...SLOTLOCK_DEFAULT_LIMITS.caps, tenant_transactions: 5 }, 5],
    ] as const) {
      const target = createSlotlockServeStore(sql, caps);
      let running = 0;
      let most = 0;
      await Promise.all(
        Array.from({ length: 8 }, () =>
          target.withTenant(tenantRef, async (tenant) => {
            running += 1;
            most = Math.max(most, running);
            await tenant.isTenantSuspended({ tenantRef });
            await new Promise((resolve) => setTimeout(resolve, 50));
            running -= 1;
          }),
        ),
      );
      expect(most).toBe(expected);
    }
  });

  it('refuses a transaction that waits on a lock past the lock timeout with lock_timeout', { timeout: 30_000 }, async () => {
    const tenantRef = freshTenant();
    await resource(tenantRef);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Suspension and erasure hold the tenant's lock this way.
    const holder = owner.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${slotlockTenantLockKey(tenantRef)}, 0))`;
      locked();
      await released;
    });
    await holding;
    const started = performance.now();
    try {
      await expect(store.withTenant(tenantRef, async () => 1)).rejects.toMatchObject({
        code: 'lock_timeout',
      });
    } finally {
      release();
      await holder;
    }
    expect(performance.now() - started).toBeLessThan(10_000);
    // The connection went back to the pool usable.
    expect(await store.withTenant(tenantRef, async () => 1)).toBe(1);
  });
});
