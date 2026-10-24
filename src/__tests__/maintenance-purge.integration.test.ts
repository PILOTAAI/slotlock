// Maintenance deletes what a tenant no longer needs: holds past their expiry (which nothing else
// removes unless a rival writes over their time), and keyed hold answers and references retired by
// a cancel no booking held, older than the retention window. A cancelled booking's tombstone is
// kept, so its reference is never booked again. It deletes only that tenant's, and nothing live.
// Skipped without DATABASE_URL.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maintainSlotlockTenant } from '../maintenance.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 60 * 60 * 1000;
const slot = (n: number) => ({
  start: new Date(Date.UTC(2027, 1, 1, 0) + n * HOUR),
  end: new Date(Date.UTC(2027, 1, 1, 0) + (n + 1) * HOUR),
});

describe.skipIf(!url)('maintenance purge and booking retention (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenants: string[] = [];

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    if (tenants.length > 0) {
      await sql`DELETE FROM slotlock.reservation_tombstones WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref IN ${sql(tenants)}`;
    }
    await sql.end();
  });

  async function freshTenant() {
    const tenantRef = `purge-${crypto.randomUUID()}`;
    tenants.push(tenantRef);
    const resource = await store.createResource({
      tenantRef,
      externalRef: `vehicle-${crypto.randomUUID()}`,
      timezone: 'UTC',
    });
    return { tenantRef, resourceId: resource.id };
  }

  const heldRows = async (resourceId: string) => {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock.reservations
       WHERE resource_id = ${resourceId} AND status = 'held'`;
    return row?.count ?? 0;
  };

  it("purges a tenant's expired holds and keeps its live ones and other tenants'", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    for (let n = 0; n < 30; n++) {
      const hold = await store.acquireHold({
        tenantRef: a.tenantRef,
        resourceId: a.resourceId,
        ...slot(n),
        ttlMs: 50,
      });
      expect(hold.ok).toBe(true);
    }
    const live = await store.acquireHold({
      tenantRef: a.tenantRef,
      resourceId: a.resourceId,
      ...slot(40),
      ttlMs: 600_000,
    });
    expect(live.ok).toBe(true);
    await store.acquireHold({
      tenantRef: b.tenantRef,
      resourceId: b.resourceId,
      ...slot(0),
      ttlMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Before: the audit's repro, every expired hold still stored.
    expect(await heldRows(a.resourceId)).toBe(31);

    const result = await maintainSlotlockTenant(store, a.tenantRef);
    expect(result).toMatchObject({ pruned: 30, capped: false });
    expect(await heldRows(a.resourceId)).toBe(1);
    expect(await heldRows(b.resourceId)).toBe(1);
    if (!live.ok) return;
    await expect(
      store.getHold({ tenantRef: a.tenantRef, holdId: live.hold.id }),
    ).resolves.toMatchObject({
      id: live.hold.id,
    });
  });

  it('works in bounded batches and says when there is more', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    for (let n = 0; n < 5; n++) {
      await store.acquireHold({ tenantRef, resourceId, ...slot(n), ttlMs: 50 });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(store.pruneBookingRetention({ tenantRef, limit: 3 })).resolves.toEqual({
      expiredHoldsDeleted: 3,
      holdCommandsDeleted: 0,
      tombstonesDeleted: 0,
      hasMore: true,
    });
    await expect(store.pruneBookingRetention({ tenantRef, limit: 3 })).resolves.toMatchObject({
      expiredHoldsDeleted: 2,
      hasMore: false,
    });
    await expect(store.pruneBookingRetention({ tenantRef, limit: 0 })).rejects.toMatchObject({
      code: 'invalid_limit',
    });
    await expect(
      store.pruneBookingRetention({ tenantRef, retentionDays: 0 }),
    ).rejects.toMatchObject({
      code: 'invalid_retention_window',
    });
  });

  it('prunes hold answers and retired references past the window, and keeps recent ones', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const keyed = await store.acquireHold({
      tenantRef,
      resourceId,
      ...slot(0),
      ttlMs: 600_000,
      idempotencyKey: 'old-key',
      principalRef: 'key-1',
    });
    expect(keyed.ok).toBe(true);
    await store.acquireHold({
      tenantRef,
      resourceId,
      ...slot(1),
      ttlMs: 600_000,
      idempotencyKey: 'new-key',
      principalRef: 'key-1',
    });
    for (const externalRef of ['old-ref', 'new-ref']) {
      const cancelled = await store.cancelExternalReservation({
        tenantRef,
        externalRef,
        revision: 1,
      });
      expect(cancelled.ok).toBe(true);
    }
    const [tombstone] = await sql<{ cancelled_at: Date }[]>`
      SELECT cancelled_at FROM slotlock.reservation_tombstones
       WHERE tenant_ref = ${tenantRef} AND external_ref = 'new-ref'`;
    expect(Date.now() - (tombstone?.cancelled_at.getTime() ?? 0)).toBeLessThan(60_000);
    await sql`
      UPDATE slotlock.hold_commands SET created_at = now() - interval '31 days'
       WHERE tenant_ref = ${tenantRef} AND idempotency_key = 'old-key'`;
    await sql`
      UPDATE slotlock.reservation_tombstones SET cancelled_at = now() - interval '31 days'
       WHERE tenant_ref = ${tenantRef} AND external_ref = 'old-ref'`;

    await expect(store.pruneBookingRetention({ tenantRef })).resolves.toEqual({
      expiredHoldsDeleted: 0,
      holdCommandsDeleted: 1,
      tombstonesDeleted: 1,
      hasMore: false,
    });
    const refs = await sql<{ external_ref: string }[]>`
      SELECT external_ref FROM slotlock.reservation_tombstones WHERE tenant_ref = ${tenantRef}`;
    expect(refs.map((row) => row.external_ref)).toEqual(['new-ref']);
    // Neither reference held a booking. The pruned one books afresh; the recent one is still retired.
    const book = (externalRef: string, n: number) =>
      store.createExternalReservation({
        tenantRef,
        externalRef,
        resourceId,
        ...slot(n),
        bufferAfterMs: 0,
        revision: 1,
      });
    await expect(book('old-ref', 10)).resolves.toMatchObject({ ok: true });
    await expect(book('new-ref', 11)).resolves.toEqual({
      ok: false,
      code: 'reservation_cancelled',
    });
    // The hold itself is untouched: only its answer to a retry is gone.
    if (!keyed.ok) return;
    await expect(store.getHold({ tenantRef, holdId: keyed.hold.id })).resolves.not.toBeNull();
  });

  it("keeps a cancelled booking's tombstone past the window, so a late create never books it again", async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const externalRef = `booking-${crypto.randomUUID()}`;
    const create = (n: number) =>
      store.createExternalReservation({
        tenantRef,
        externalRef,
        resourceId,
        ...slot(n),
        bufferAfterMs: 0,
        revision: 1,
      });
    await expect(create(0)).resolves.toMatchObject({ ok: true });
    await expect(
      store.cancelExternalReservation({ tenantRef, externalRef, revision: 2 }),
    ).resolves.toEqual({ ok: true, cancelled: true, revision: 2 });
    // The verifier's repro: aged past the window and pruned, the reference booked again.
    await sql`
      UPDATE slotlock.reservation_tombstones SET cancelled_at = now() - interval '400 days'
       WHERE tenant_ref = ${tenantRef}`;
    await expect(maintainSlotlockTenant(store, tenantRef)).resolves.toMatchObject({ pruned: 0 });
    await expect(store.pruneBookingRetention({ tenantRef, retentionDays: 1 })).resolves.toEqual({
      expiredHoldsDeleted: 0,
      holdCommandsDeleted: 0,
      tombstonesDeleted: 0,
      hasMore: false,
    });
    await expect(create(1)).resolves.toEqual({ ok: false, code: 'reservation_cancelled' });
    await expect(
      store.cancelExternalReservation({ tenantRef, externalRef, revision: 2 }),
    ).resolves.toEqual({ ok: true, cancelled: false, revision: 2 });
  });

  it('gives a booking an older server confirmed without its tenant the tenant and its own reference', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    // As a 0.2 server still serving after the migration writes a confirmed hold: no tenant, no
    // reference, and a cancel of its id already tried (a stray tombstone).
    const [legacy] = await sql<{ id: string }[]>`
      INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, status)
      VALUES (${resourceId}, ${slot(3).start}, ${slot(3).end}, 'confirmed')
      RETURNING id`;
    const id = legacy?.id as string;
    await expect(
      store.cancelExternalReservation({ tenantRef, externalRef: id, revision: 2 }),
    ).resolves.toEqual({ ok: true, cancelled: false, revision: 2 });
    await expect(maintainSlotlockTenant(store, tenantRef)).resolves.toMatchObject({
      capped: false,
    });
    const [row] = await sql<{ tenant_ref: string | null; external_ref: string | null }[]>`
      SELECT tenant_ref, external_ref FROM slotlock.reservations WHERE id = ${id}`;
    expect(row).toEqual({ tenant_ref: tenantRef, external_ref: id });
    await expect(
      store.cancelExternalReservation({ tenantRef, externalRef: id, revision: 2 }),
    ).resolves.toEqual({ ok: true, cancelled: true, revision: 2 });
  });

  it('skips a hold a writer holds instead of waiting for it', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const hold = await store.acquireHold({ tenantRef, resourceId, ...slot(0), ttlMs: 50 });
    if (!hold.ok) throw new Error(hold.code);
    await new Promise((resolve) => setTimeout(resolve, 150));
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const writer = sql.begin(async (tx) => {
      await tx`SELECT id FROM slotlock.reservations WHERE id = ${hold.hold.id} FOR UPDATE`;
      locked();
      await released;
    });
    await isLocked;
    try {
      await expect(store.pruneBookingRetention({ tenantRef })).resolves.toMatchObject({
        expiredHoldsDeleted: 0,
      });
    } finally {
      release();
      await writer;
    }
    await expect(store.pruneBookingRetention({ tenantRef })).resolves.toMatchObject({
      expiredHoldsDeleted: 1,
    });
  });
});
