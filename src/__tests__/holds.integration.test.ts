// Holds on tenant resources, from acquisition to the booking they become. A confirmed hold is a
// booking like any other: it carries its tenant and a reference (its own id), so it can be cancelled
// and moved by that reference, and rows that earlier releases confirmed without one are given one
// by the next migration. Skipped without DATABASE_URL.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SlotlockApplicationInvocationContext } from '../application-api.js';
import { createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
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

  describe("a hold's expiry inside a caller's transaction", () => {
    // A store made from the caller's transaction runs in savepoints of it, where now() is the
    // transaction's start: a hold that expired while the transaction ran still looked live, and
    // was confirmed after its expiry.
    it('is judged at the statement, not at the start of the transaction', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const hold = await store.acquireHold({
        resourceId,
        start: d('2027-06-20T09:00:00Z'),
        end: d('2027-06-20T10:00:00Z'),
        ttlMs: 1_000,
      });
      if (!hold.ok) throw new Error(hold.code);
      const confirmed = await sql.begin(async (tx) => {
        // The transaction starts while the hold is live, then runs past its expiry.
        await tx`SELECT now()`;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return createSlotlockStore(tx).confirmHold(hold.hold.id, { tenantRef });
      });
      expect(confirmed).toEqual({ ok: false, code: 'hold_expired' });
    });

    it('starts its time to live at the statement too', async () => {
      const { resourceId } = await freshTenant();
      const acquired = await sql.begin(async (tx) => {
        await tx`SELECT now()`;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const [row] = await tx<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
        const at = row?.at as Date;
        const result = await createSlotlockStore(tx).acquireHold({
          resourceId,
          start: d('2027-06-21T09:00:00Z'),
          end: d('2027-06-21T10:00:00Z'),
          ttlMs: 60_000,
        });
        return { at, result };
      });
      if (!acquired.result.ok) throw new Error(acquired.result.code);
      // A full 60 s from when it was asked for, not from the transaction's start a second earlier.
      expect(acquired.result.hold.expiresAt.getTime() - acquired.at.getTime()).toBeGreaterThanOrEqual(59_900);
    });
  });

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

  describe('a hold names its tenant, keeps a turnaround buffer and is retried safely', () => {
    it('with tenantRef, holds only on that tenant\'s resources, whatever the connection\'s RLS', async () => {
      const a = await freshTenant();
      const b = await freshTenant();
      const window = { start: d('2027-08-01T09:00:00Z'), end: d('2027-08-01T10:00:00Z') };
      // The audit's repro ran as a superuser without RLS: a hold on another tenant's resource.
      await expect(
        store.acquireHold({ ...window, resourceId: b.resourceId, ttlMs: 60_000, tenantRef: a.tenantRef }),
      ).resolves.toEqual({ ok: false, code: 'resource_not_found' });
      await expect(
        store.createReservation({ ...window, resourceId: b.resourceId, tenantRef: a.tenantRef }),
      ).resolves.toEqual({ ok: false, code: 'resource_not_found' });
      await expect(
        store.listBusy(b.resourceId, window, { tenantRef: a.tenantRef }),
      ).rejects.toMatchObject({ code: 'resource_not_found' });
      const held = await store.acquireHold({ ...window, resourceId: b.resourceId, ttlMs: 60_000 });
      if (!held.ok) throw new Error(held.code);
      await expect(store.releaseHold(held.hold.id, { tenantRef: a.tenantRef })).resolves.toEqual({
        ok: true,
        released: false,
      });
      await expect(store.listBusy(b.resourceId, window, { tenantRef: b.tenantRef })).resolves.toEqual([
        window,
      ]);
    });

    it('answers an id the store never issues as not found, never a raw database error', async () => {
      const window = { start: d('2027-08-02T09:00:00Z'), end: d('2027-08-02T10:00:00Z') };
      await expect(
        store.acquireHold({ ...window, resourceId: 'not-a-uuid', ttlMs: 60_000 }),
      ).resolves.toEqual({ ok: false, code: 'resource_not_found' });
      await expect(
        store.acquireHold({ ...window, resourceId: crypto.randomUUID(), ttlMs: 60_000 }),
      ).resolves.toEqual({ ok: false, code: 'resource_not_found' });
      await expect(store.confirmHold('not-a-uuid')).resolves.toEqual({
        ok: false,
        code: 'hold_not_found',
      });
      await expect(store.releaseHold('not-a-uuid')).resolves.toEqual({ ok: true, released: false });
      await expect(store.listBusy('not-a-uuid', window)).rejects.toMatchObject({
        code: 'invalid_identity',
      });
    });

    it('keeps its buffer busy, keeps it when confirmed, and refuses an absurd one', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const hold = await store.acquireHold({
        resourceId,
        start: d('2027-08-03T09:00:00Z'),
        end: d('2027-08-03T10:00:00Z'),
        ttlMs: 60_000,
        bufferAfterMs: HOUR,
        tenantRef,
      });
      expect(hold).toMatchObject({ ok: true, hold: { bufferAfterMs: HOUR } });
      if (!hold.ok) return;
      // The audit's repro: a booking in the buffer hour, refused, naming the hold.
      const inBuffer = await store.createExternalReservation({
        tenantRef,
        externalRef: `booking-${crypto.randomUUID()}`,
        resourceId,
        start: d('2027-08-03T10:30:00Z'),
        end: d('2027-08-03T11:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      });
      expect(inBuffer).toEqual({ ok: false, code: 'overlap', conflictingReservationId: hold.hold.id });
      const confirmed = await store.confirmHold(hold.hold.id, { tenantRef });
      expect(confirmed).toMatchObject({ ok: true, reservation: { bufferAfterMs: HOUR } });
      await expect(
        store.listBusy(resourceId, { start: d('2027-08-03T00:00:00Z'), end: d('2027-08-04T00:00:00Z') }),
      ).resolves.toEqual([{ start: d('2027-08-03T09:00:00Z'), end: d('2027-08-03T11:00:00Z') }]);
      for (const bufferAfterMs of [-1, 1.5, Number.NaN, 31 * 24 * HOUR]) {
        await expect(
          store.acquireHold({
            resourceId,
            start: d('2027-08-04T09:00:00Z'),
            end: d('2027-08-04T10:00:00Z'),
            ttlMs: 60_000,
            bufferAfterMs,
          }),
        ).resolves.toEqual({ ok: false, code: 'invalid_buffer' });
      }
    });

    it('once expired, no longer blocks a booking or a hold in its buffer', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      // An expired 09:00-10:00 hold with a half-hour buffer, before each write in its buffer.
      const expiredHold = async (day: string) => {
        const hold = await store.acquireHold({
          resourceId,
          start: d(`${day}T09:00:00Z`),
          end: d(`${day}T10:00:00Z`),
          ttlMs: 60_000,
          bufferAfterMs: HOUR / 2,
          tenantRef,
        });
        if (!hold.ok) throw new Error(`hold fixture failed: ${hold.code}`);
        await sql`UPDATE slotlock.reservations SET expires_at = now() - interval '1 second' WHERE id = ${hold.hold.id}`;
      };
      await expiredHold('2027-08-05');
      await expect(
        store.createExternalReservation({
          tenantRef,
          externalRef: `booking-${crypto.randomUUID()}`,
          resourceId,
          start: d('2027-08-05T10:15:00Z'),
          end: d('2027-08-05T11:00:00Z'),
          bufferAfterMs: 0,
          revision: 1,
        }),
      ).resolves.toMatchObject({ ok: true });
      await expiredHold('2027-08-06');
      await expect(
        store.createReservation({
          tenantRef,
          resourceId,
          start: d('2027-08-06T10:15:00Z'),
          end: d('2027-08-06T11:00:00Z'),
        }),
      ).resolves.toMatchObject({ ok: true });
      await expiredHold('2027-08-07');
      await expect(
        store.acquireHold({
          tenantRef,
          resourceId,
          start: d('2027-08-07T10:15:00Z'),
          end: d('2027-08-07T11:00:00Z'),
          ttlMs: 60_000,
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('a retry with the same idempotency key answers the same hold; another body under it is refused', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const request = {
        resourceId,
        start: d('2027-08-05T09:00:00Z'),
        end: d('2027-08-05T10:00:00Z'),
        ttlMs: 7 * 24 * HOUR,
        tenantRef,
        principalRef: 'api_key:one',
        idempotencyKey: `hold-${crypto.randomUUID()}`,
      };
      const first = await store.acquireHold(request);
      expect(first).toMatchObject({ ok: true, idempotent: false });
      if (!first.ok) return;
      // The audit's repro: the retry of a lost response was 409 overlap against its own hold.
      await expect(store.acquireHold(request)).resolves.toEqual({ ...first, idempotent: true });
      await expect(
        store.acquireHold({ ...request, end: d('2027-08-05T11:00:00Z') }),
      ).resolves.toEqual({ ok: false, code: 'idempotency_conflict' });
      // The key is the principal's: another principal's same key is its own hold (and overlaps).
      await expect(
        store.acquireHold({ ...request, principalRef: 'api_key:two' }),
      ).resolves.toMatchObject({ ok: false, code: 'overlap', conflictingReservationId: first.hold.id });
      // A key needs a tenant and a principal to belong to.
      const { principalRef: _principal, ...unowned } = request;
      await expect(store.acquireHold(unowned)).resolves.toEqual({
        ok: false,
        code: 'invalid_identity',
      });
      const [rows] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM slotlock.reservations WHERE resource_id = ${resourceId}`;
      expect(rows?.count).toBe(1);
    });

    it('racing retries of one keyed hold make exactly one hold, and every one answers it', async () => {
      const { tenantRef, resourceId } = await freshTenant();
      const request = {
        resourceId,
        start: d('2027-08-06T09:00:00Z'),
        end: d('2027-08-06T10:00:00Z'),
        ttlMs: 60_000,
        tenantRef,
        principalRef: 'api_key:racer',
        idempotencyKey: `hold-${crypto.randomUUID()}`,
      };
      const outcomes = await Promise.all(Array.from({ length: 12 }, () => store.acquireHold(request)));
      const ids = new Set(outcomes.map((outcome) => (outcome.ok ? outcome.hold.id : outcome.code)));
      expect([...ids]).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.ok && !outcome.idempotent)).toHaveLength(1);
      const [rows] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM slotlock.reservations WHERE resource_id = ${resourceId}`;
      expect(rows?.count).toBe(1);
    });

    it('reads back a hold and a booking by id or reference in the tenant, and lists them per resource', async () => {
      const a = await freshTenant();
      const b = await freshTenant();
      const hold = await store.acquireHold({
        resourceId: a.resourceId,
        start: d('2027-08-07T09:00:00Z'),
        end: d('2027-08-07T10:00:00Z'),
        ttlMs: 60_000,
        bufferAfterMs: HOUR,
      });
      if (!hold.ok) throw new Error(hold.code);
      await expect(store.getHold({ tenantRef: a.tenantRef, holdId: hold.hold.id })).resolves.toEqual(
        hold.hold,
      );
      await expect(store.getHold({ tenantRef: b.tenantRef, holdId: hold.hold.id })).resolves.toBeNull();
      await expect(store.getHold({ tenantRef: a.tenantRef, holdId: 'not-a-uuid' })).resolves.toBeNull();

      const ref = `BK-${crypto.randomUUID()}`;
      const booked = await store.createExternalReservation({
        tenantRef: a.tenantRef,
        externalRef: ref,
        resourceId: a.resourceId,
        start: d('2027-08-08T09:00:00Z'),
        end: d('2027-08-08T10:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      });
      if (!booked.ok) throw new Error(booked.code);
      const moved = await store.rescheduleExternalReservation({
        tenantRef: a.tenantRef,
        externalRef: ref,
        resourceId: a.resourceId,
        start: d('2027-08-09T09:00:00Z'),
        end: d('2027-08-09T10:00:00Z'),
        bufferAfterMs: 0,
        revision: 2,
      });
      if (!moved.ok) throw new Error(moved.code);
      // A client that lost the move's response reads the current revision back.
      await expect(
        store.getReservation({ tenantRef: a.tenantRef, externalRef: ref }),
      ).resolves.toEqual(moved.reservation);
      await expect(store.getReservation({ tenantRef: b.tenantRef, externalRef: ref })).resolves.toBeNull();

      // The confirmed hold is a booking now, and no longer a hold.
      const confirmed = await store.confirmHold(hold.hold.id);
      if (!confirmed.ok) throw new Error(confirmed.code);
      await expect(store.getHold({ tenantRef: a.tenantRef, holdId: hold.hold.id })).resolves.toBeNull();
      const window = { start: d('2027-08-01T00:00:00Z'), end: d('2027-09-01T00:00:00Z') };
      const first = await store.listReservations({
        tenantRef: a.tenantRef,
        resourceId: a.resourceId,
        window,
        limit: 1,
      });
      expect(first).toEqual([confirmed.reservation]);
      const last = first.at(-1) as (typeof first)[number];
      await expect(
        store.listReservations({
          tenantRef: a.tenantRef,
          resourceId: a.resourceId,
          window,
          limit: 1,
          after: { start: last.start, id: last.id },
        }),
      ).resolves.toEqual([moved.reservation]);
      await expect(
        store.listReservations({ tenantRef: b.tenantRef, resourceId: a.resourceId, window }),
      ).resolves.toEqual([]);

      const live = await store.acquireHold({
        resourceId: a.resourceId,
        start: d('2027-08-10T09:00:00Z'),
        end: d('2027-08-10T10:00:00Z'),
        ttlMs: 60_000,
      });
      if (!live.ok) throw new Error(live.code);
      await expect(
        store.listHolds({ tenantRef: a.tenantRef, resourceId: a.resourceId }),
      ).resolves.toEqual([live.hold]);
    });
  });

  it('the application backend holds in the caller\'s tenant, with its buffer, and answers a keyed retry with the same hold', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const backend = createSlotlockStoreApplicationBackend(store);
    const context = (subject: string) =>
      ({
        principal: { subject, tenantRef, scopes: ['admin'] },
        operation: 'slotlock_acquire_hold',
        signal: new AbortController().signal,
      }) as SlotlockApplicationInvocationContext;
    const input = {
      resource_id: resourceId,
      start: '2027-09-01T09:00:00.000Z',
      end: '2027-09-01T10:00:00.000Z',
      ttl_seconds: 600,
      buffer_after_minutes: 30,
      idempotency_key: 'checkout-42',
    };
    const first = (await backend.acquireHold(context('api_key:a'), input)) as { hold: { id: string } };
    await expect(backend.acquireHold(context('api_key:a'), input)).resolves.toEqual(first);
    await expect(backend.acquireHold(context('api_key:b'), input)).rejects.toMatchObject({
      code: 'overlap',
    });
    await expect(
      store.listBusy(resourceId, { start: d('2027-09-01T00:00:00Z'), end: d('2027-09-02T00:00:00Z') }),
    ).resolves.toEqual([{ start: d('2027-09-01T09:00:00Z'), end: d('2027-09-01T10:30:00Z') }]);
    const [stored] = await sql<{ principal_ref: string }[]>`
      SELECT principal_ref FROM slotlock.hold_commands WHERE hold_id = ${first.hold.id}`;
    // The subject is kept as a digest, never as given.
    expect(stored?.principal_ref).toMatch(/^application:[0-9a-f]{64}$/);
  });
});
