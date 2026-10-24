// Holds on tenant resources, from acquisition to the booking they become. A confirmed hold is a
// booking like any other: it carries its tenant and a reference (its own id), so it can be cancelled
// and moved by that reference, and rows that earlier releases confirmed without one are given one
// by the next migration. Skipped without DATABASE_URL.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const d = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;

describe.skipIf(!url)('holds and the bookings they become (real Postgres)', () => {
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
    const tenantRef = `holds-${crypto.randomUUID()}`;
    tenants.push(tenantRef);
    const resource = await store.createResource({
      tenantRef,
      externalRef: `vehicle-${crypto.randomUUID()}`,
      timezone: 'UTC',
    });
    return { tenantRef, resourceId: resource.id };
  }

  async function held(resourceId: string, start: Date, end: Date) {
    const hold = await store.acquireHold({ resourceId, start, end, ttlMs: 60_000 });
    if (!hold.ok) throw new Error(`hold fixture failed: ${hold.code}`);
    return hold.hold;
  }

  describe('a confirmed hold is a booking', () => {
    it('carries its tenant and its own id as reference, at revision 1', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const hold = await held(resourceId, d('2027-06-01T09:00:00Z'), d('2027-06-01T10:00:00Z'));
      const confirmed = await store.confirmHold(hold.id, { tenantRef });
      expect(confirmed).toEqual({
        ok: true,
        reservation: {
          id: hold.id,
          resourceId,
          tenantRef,
          externalRef: hold.id,
          start: hold.start,
          end: hold.end,
          bufferAfterMs: 0,
          revision: 1,
          source: null,
        },
      });
      // Confirming again (a retried request) answers the same booking.
      await expect(store.confirmHold(hold.id, { tenantRef })).resolves.toEqual(confirmed);
      await expect(store.confirmHold(hold.id)).resolves.toEqual(confirmed);
    });

    it('can be cancelled by its reference, after which its window books again', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const start = d('2027-06-02T09:00:00Z');
      const end = d('2027-06-02T10:00:00Z');
      const hold = await held(resourceId, start, end);
      expect((await store.confirmHold(hold.id, { tenantRef })).ok).toBe(true);
      // The audit's repro: before, cancelled:false, a stray tombstone, and the window stayed busy.
      await expect(
        store.cancelExternalReservation({ tenantRef, externalRef: hold.id, revision: 2 }),
      ).resolves.toEqual({ ok: true, cancelled: true, revision: 2 });
      const rebooked = await store.createExternalReservation({
        tenantRef,
        externalRef: `booking-${crypto.randomUUID()}`,
        resourceId,
        start,
        end,
        bufferAfterMs: 0,
        revision: 1,
      });
      expect(rebooked.ok).toBe(true);
      // A confirm retried after the cancel finds no hold.
      await expect(store.confirmHold(hold.id, { tenantRef })).resolves.toEqual({
        ok: false,
        code: 'hold_not_found',
      });
    });

    it('can be moved by its reference, which frees the window it left', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const hold = await held(resourceId, d('2027-06-03T09:00:00Z'), d('2027-06-03T10:00:00Z'));
      await store.confirmHold(hold.id, { tenantRef });
      const moved = await store.rescheduleExternalReservation({
        tenantRef,
        externalRef: hold.id,
        resourceId,
        start: d('2027-06-03T14:00:00Z'),
        end: d('2027-06-03T15:00:00Z'),
        bufferAfterMs: 0,
        revision: 2,
      });
      expect(moved).toMatchObject({
        ok: true,
        idempotent: false,
        reservation: { id: hold.id, externalRef: hold.id, revision: 2 },
      });
      const left = await store.acquireHold({
        resourceId,
        start: d('2027-06-03T09:00:00Z'),
        end: d('2027-06-03T10:00:00Z'),
        ttlMs: 60_000,
      });
      expect(left.ok).toBe(true);
    });

    it('is not confirmed under a reference a cancellation already retired', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const hold = await held(resourceId, d('2027-06-04T09:00:00Z'), d('2027-06-04T10:00:00Z'));
      // A cancel of the reference that arrived first: no booking held it, so it retires it.
      await store.cancelExternalReservation({ tenantRef, externalRef: hold.id, revision: 2 });
      await expect(store.confirmHold(hold.id, { tenantRef })).resolves.toEqual({
        ok: false,
        code: 'reservation_cancelled',
      });
      // The hold is still a hold, and can be released.
      await expect(store.releaseHold(hold.id, { tenantRef })).resolves.toEqual({
        ok: true,
        released: true,
      });
    });

    it('a racing confirm and cancel of its reference end as one of the two orders, never neither', async () => {
      for (let round = 0; round < 20; round++) {
        const { tenantRef, resourceId } = await freshTenant();
        const start = new Date(d('2027-07-01T09:00:00Z').getTime() + round * 24 * HOUR);
        const hold = await held(resourceId, start, new Date(start.getTime() + HOUR));
        const [confirmed, cancelled] = await Promise.all([
          store.confirmHold(hold.id, { tenantRef }),
          store.cancelExternalReservation({ tenantRef, externalRef: hold.id, revision: 2 }),
        ]);
        const [row] = await sql<{ status: string; tenant_ref: string | null }[]>`
          SELECT status, tenant_ref FROM slotlock.reservations WHERE id = ${hold.id}`;
        if (confirmed.ok) {
          // Confirm first: the cancel then cancels the booking.
          expect(cancelled).toEqual({ ok: true, cancelled: true, revision: 2 });
          expect(row).toBeUndefined();
        } else {
          // Cancel first: it retires the reference and the hold stays a hold.
          expect(confirmed).toEqual({ ok: false, code: 'reservation_cancelled' });
          expect(cancelled).toEqual({ ok: true, cancelled: false, revision: 2 });
          expect(row).toEqual({ status: 'held', tenant_ref: null });
        }
      }
    });

    it('a booking made with createReservation on a tenant resource is a booking too', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const created = await store.createReservation({
        resourceId,
        start: d('2027-06-05T09:00:00Z'),
        end: d('2027-06-05T10:00:00Z'),
      });
      if (!created.ok) throw new Error(`expected a booking, got ${created.code}`);
      expect(created.reservation).toMatchObject({ tenantRef, externalRef: created.reservation.id });
      await expect(
        store.cancelExternalReservation({
          tenantRef,
          externalRef: created.reservation.id,
          revision: 2,
        }),
      ).resolves.toEqual({ ok: true, cancelled: true, revision: 2 });
    });

    it('stays tenantless on a resource that has no tenant, as before', async () => {
      const resource = await store.createResource({ externalRef: `legacy-${crypto.randomUUID()}` });
      const hold = await held(resource.id, d('2027-06-06T09:00:00Z'), d('2027-06-06T10:00:00Z'));
      const confirmed = await store.confirmHold(hold.id);
      expect(confirmed).toMatchObject({
        ok: true,
        reservation: { id: hold.id, tenantRef: null, externalRef: null },
      });
      await sql`DELETE FROM slotlock.resources WHERE id = ${resource.id}`;
    });
  });

  it('the next migration gives a booking an earlier release left without a reference one, and drops a stray tombstone of it', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    // As 0.2's confirmHold left a confirmed hold, and its cancel left a tombstone for the hold id.
    const [legacy] = await sql<{ id: string }[]>`
      INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, status)
      VALUES (${resourceId}, '2027-06-07T09:00:00Z', '2027-06-07T10:00:00Z', 'confirmed')
      RETURNING id`;
    const id = legacy?.id as string;
    await sql`
      INSERT INTO slotlock.reservation_tombstones (tenant_ref, external_ref, revision)
      VALUES (${tenantRef}, ${id}, 2)`;
    // A database 0.2 migrated records no version, so the next migration runs in full.
    await sql`DROP TABLE slotlock.schema_version`;
    await store.applySchema();

    const [row] = await sql<
      { tenant_ref: string | null; external_ref: string | null; occupied_ends_at: Date }[]
    >`SELECT tenant_ref, external_ref, occupied_ends_at FROM slotlock.reservations WHERE id = ${id}`;
    expect(row).toEqual({
      tenant_ref: tenantRef,
      external_ref: id,
      occupied_ends_at: d('2027-06-07T10:00:00Z'),
    });
    await expect(
      store.cancelExternalReservation({ tenantRef, externalRef: id, revision: 2 }),
    ).resolves.toEqual({ ok: true, cancelled: true, revision: 2 });
  });
});
