// Waitlists and check-in against real Postgres: freed time is offered to waiting entries in the order
// they joined, on a resource or the first free member of a pool, as a hold for the waiter; bookings
// left unclaimed past their check-in window are released, and only those made once the rule was set.
// Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SlotlockApplicationInvocationContext } from '../application-api.js';
import type { SlotlockAgentInvocationContext } from '../agent-server.js';
import {
  createSlotlockStoreAgentBackend,
  createSlotlockStoreApplicationBackend,
} from '../agent-store-backend.js';
import { maintainSlotlockTenant } from '../maintenance.js';
import { SLOTLOCK_MAX_WAITLIST_PER_HOLDER, type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;
const MINUTE = 60_000;

describe.skipIf(!url)('waitlists and check-in (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let application: ReturnType<typeof createSlotlockStoreApplicationBackend>;
  const tenantRef = `waitlist-${randomUUID()}`;
  const otherTenant = `waitlist-other-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 6, 1, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR);
  const context = (operation: string, tenant = tenantRef): SlotlockApplicationInvocationContext => ({
    principal: { subject: 'app', tenantRef: tenant, scopes: ['admin'] },
    operation: operation as SlotlockApplicationInvocationContext['operation'],
    signal: new AbortController().signal,
  });
  const resource = async (pool?: string) => {
    const created = await store.createResource({ tenantRef, externalRef: `w-${randomUUID()}`, timezone: 'UTC' });
    if (pool) await store.setResourcePool({ tenantRef, id: created.id, pool });
    return created.id;
  };
  const book = async (resourceId: string, start: Date, end: Date, externalRef = `bk-${randomUUID()}`) => {
    const booked = await store.createExternalReservation({
      tenantRef,
      externalRef,
      resourceId,
      start,
      end,
      bufferAfterMs: 0,
      revision: 1,
    });
    expect(booked.ok).toBe(true);
    return externalRef;
  };
  const join = (params: { resourceId?: string; pool?: string; start: Date; end: Date; holderRef: string }) =>
    store.withTenant(tenantRef, (tenant) => tenant.joinWaitlist({ tenantRef, ...params }));
  const offer = () => store.withTenant(tenantRef, (tenant) => tenant.offerWaitlist({ tenantRef }));
  const entries = (filter: { resourceId?: string; pool?: string } = {}) =>
    store.withTenant(tenantRef, (tenant) => tenant.listWaitlist({ tenantRef, ...filter }));
  const changes = async (type: string) =>
    sql<{ subject: string; data: Record<string, unknown>; actor: string | null }[]>`
      SELECT subject, data, actor FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} AND type = ${type}
       ORDER BY id`;

  /** As if check-in was asked for on `resources` two hours ago, and `bookings` made an hour ago. */
  const backdate = async (resources: string[], bookings: string[]) => {
    await sql`
      UPDATE slotlock.resources SET check_in_since = now() - interval '2 hours'
       WHERE id = ANY(${sql.array(resources)}::uuid[])`;
    await sql`
      UPDATE slotlock.reservations SET created_at = now() - interval '1 hour'
       WHERE tenant_ref = ${tenantRef} AND external_ref = ANY(${sql.array(bookings)}::text[])`;
  };

  beforeAll(async () => {
    sql = postgres(url as string, { max: 10, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    application = createSlotlockStoreApplicationBackend(store);
  });

  afterAll(async () => {
    for (const tenant of [tenantRef, otherTenant]) await sql`SELECT * FROM slotlock.erase_tenant(${tenant}::text)`;
    await sql.end();
  });

  it('offers a freed window to the first who waited, then to the next when the offer is let go', async () => {
    const van = await resource();
    const taken = await book(van, at(9), at(17));
    const first = await join({ resourceId: van, start: at(10), end: at(12), holderRef: 'first' });
    const second = await join({ resourceId: van, start: at(10), end: at(12), holderRef: 'second' });
    expect(first.ok && second.ok).toBe(true);
    // Nothing free yet: nothing offered.
    expect(await offer()).toMatchObject({ offered: 0, expired: 0 });

    // The cancel offers at once, without waiting for maintenance.
    expect(
      await application.cancelReservation(context('slotlock_cancel_reservation'), { reservation_ref: taken, revision: 2 }),
    ).toEqual({ cancelled: true, revision: 2 });
    const [offered, waiting] = await entries({ resourceId: van });
    expect(offered).toMatchObject({ holderRef: 'first', status: 'offered', offeredResourceId: van });
    expect(waiting).toMatchObject({ holderRef: 'second', status: 'waiting', holdId: null });
    const hold = await store.getHold({ tenantRef, holdId: offered?.holdId as string });
    expect(hold).toMatchObject({ start: at(10), end: at(12) });
    expect(await changes('waitlist.offered')).toEqual([
      expect.objectContaining({
        subject: offered?.id,
        actor: 'slotlock:maintenance',
        data: expect.objectContaining({ hold_id: offered?.holdId, resource_id: van, holder_ref: 'first' }),
      }),
    ]);

    // The first lets the offer go: the second is offered the same time.
    expect(
      await application.releaseHold(context('slotlock_release_hold'), { hold_id: offered?.holdId as string }),
    ).toEqual({ released: true });
    expect((await entries({ resourceId: van }))[1]).toMatchObject({ holderRef: 'second', status: 'offered' });
  });

  it('offers what an agent or an application frees at once: a released hold, a deleted or moved event, a moved booking', async () => {
    const agent = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] });
    const as = (operation: string): SlotlockAgentInvocationContext => ({
      principal: { subject: 'agent', tenantRef },
      operation: operation as SlotlockAgentInvocationContext['operation'],
      signal: new AbortController().signal,
    });
    const event = async (resourceId: string) =>
      (await agent.createEvent(as('slotlock_create_event'), {
        resource_id: resourceId,
        starts_at: at(9).toISOString(),
        ends_at: at(17).toISOString(),
        timezone: 'UTC',
        idempotency_key: `e-${randomUUID()}`,
      })) as { event: { id: string; revision: number } };
    const wait = async (resourceId: string) => {
      const joined = await join({ resourceId, start: at(10), end: at(12), holderRef: `w-${randomUUID()}` });
      expect(joined.ok).toBe(true);
      expect((await entries({ resourceId }))[0]?.status).toBe('waiting');
    };
    const offeredOn = async (resourceId: string) => (await entries({ resourceId }))[0]?.status;

    const held = await resource();
    const holds = (await agent.holdSlots?.(as('slotlock_hold_slots'), {
      slots: [{ resource_id: held, start: at(9).toISOString(), end: at(17).toISOString() }],
      ttl_seconds: 600,
      idempotency_key: `h-${randomUUID()}`,
    })) as unknown as { holds: { hold_id: string }[] };
    await wait(held);
    await agent.releaseSlots?.(as('slotlock_release_slots'), { hold_id: holds.holds[0]?.hold_id as string });
    expect(await offeredOn(held)).toBe('offered');

    const deleted = await resource();
    const gone = await event(deleted);
    await wait(deleted);
    await agent.deleteEvent(as('slotlock_delete_event'), {
      event_id: gone.event.id,
      expected_revision: gone.event.revision,
      idempotency_key: `d-${randomUUID()}`,
    });
    expect(await offeredOn(deleted)).toBe('offered');

    const moved = await resource();
    const shifted = await event(moved);
    await wait(moved);
    await agent.updateEvent(as('slotlock_update_event'), {
      event_id: shifted.event.id,
      expected_revision: shifted.event.revision,
      resource_id: moved,
      starts_at: at(13).toISOString(),
      ends_at: at(17).toISOString(),
      timezone: 'UTC',
      idempotency_key: `u-${randomUUID()}`,
    });
    expect(await offeredOn(moved)).toBe('offered');

    const rebooked = await resource();
    const booking = await book(rebooked, at(9), at(17));
    await wait(rebooked);
    await application.putReservation(context('slotlock_put_reservation'), {
      resource_id: rebooked,
      reservation_ref: booking,
      start: at(13).toISOString(),
      end: at(17).toISOString(),
      buffer_after_minutes: 0,
      revision: 2,
    });
    expect(await offeredOn(rebooked)).toBe('offered');
  });

  it('offers a pool entry the first member that comes free', async () => {
    const [a, b] = [await resource('suv'), await resource('suv')];
    const onA = await book(a as string, at(30), at(40));
    await book(b as string, at(30), at(40));
    expect(await join({ pool: 'suv', start: at(31), end: at(33), holderRef: 'pooled' })).toMatchObject({ ok: true });
    expect(await offer()).toMatchObject({ offered: 0, expired: 0 });
    await store.cancelExternalReservation({ tenantRef, externalRef: onA, revision: 2 });
    // Maintenance offers what a cancel elsewhere freed.
    const pass = await maintainSlotlockTenant(store, tenantRef);
    expect(pass.waitlistOffers).toBe(1);
    expect(await entries({ pool: 'suv' })).toEqual([
      expect.objectContaining({ pool: 'suv', resourceId: null, status: 'offered', offeredResourceId: a }),
    ]);
  });

  it('offers an entry once however many passes race', async () => {
    const van = await resource();
    const taken = await book(van, at(100), at(110));
    for (const holderRef of ['r1', 'r2', 'r3']) {
      expect((await join({ resourceId: van, start: at(101 + Number(holderRef[1])), end: at(102 + Number(holderRef[1])), holderRef })).ok).toBe(true);
    }
    await store.cancelExternalReservation({ tenantRef, externalRef: taken, revision: 2 });
    const passes = await Promise.all(Array.from({ length: 6 }, () => offer()));
    expect(passes.reduce((sum, pass) => sum + pass.offered, 0)).toBe(3);
    const listed = await entries({ resourceId: van });
    expect(listed.map(({ status }) => status)).toEqual(['offered', 'offered', 'offered']);
    expect(new Set(listed.map(({ holdId }) => holdId)).size).toBe(3);
  }, 30_000);

  it('expires entries whose window started, refuses what it cannot wait for, and caps a holder', async () => {
    const van = await resource();
    const joined = await join({ resourceId: van, start: at(50), end: at(51), holderRef: 'late' });
    expect(joined.ok).toBe(true);
    const id = joined.ok ? joined.entry.id : '';
    await sql`UPDATE slotlock.waitlist_entries SET starts_at = now() - interval '1 minute' WHERE id = ${id}`;
    expect((await offer()).expired).toBe(1);
    expect((await entries({ resourceId: van }))[0]?.status).toBe('expired');
    expect((await changes('waitlist.expired')).map(({ subject }) => subject)).toContain(id);

    expect(await join({ resourceId: randomUUID(), start: at(50), end: at(51), holderRef: 'x' })).toEqual({
      ok: false,
      code: 'resource_not_found',
    });
    expect(await join({ pool: 'nobody', start: at(50), end: at(51), holderRef: 'x' })).toEqual({
      ok: false,
      code: 'pool_not_found',
    });
    expect(await join({ resourceId: van, start: at(51), end: at(50), holderRef: 'x' })).toEqual({
      ok: false,
      code: 'invalid_window',
    });
    expect(await join({ resourceId: van, start: at(0), end: at(24 * 32), holderRef: 'x' })).toEqual({
      ok: false,
      code: 'invalid_window',
    });
    for (let n = 0; n < SLOTLOCK_MAX_WAITLIST_PER_HOLDER; n++) {
      expect((await join({ resourceId: van, start: at(60 + n), end: at(61 + n), holderRef: 'busy' })).ok).toBe(true);
    }
    expect(await join({ resourceId: van, start: at(90), end: at(91), holderRef: 'busy' })).toEqual({
      ok: false,
      code: 'waitlist_limit_reached',
    });
  });

  it("shows another tenant none of the waitlist, and lets only the tenant's own entry go", async () => {
    const van = await resource();
    const joined = await join({ resourceId: van, start: at(70), end: at(71), holderRef: 'mine' });
    const id = joined.ok ? joined.entry.id : '';
    const theirs = await application.listWaitlist(context('slotlock_list_waitlist', otherTenant), { limit: 100 });
    expect(theirs).toEqual({ entries: [] });
    expect(await application.leaveWaitlist(context('slotlock_leave_waitlist', otherTenant), { entry_id: id })).toEqual({
      left: false,
    });
    await expect(
      application.joinWaitlist(context('slotlock_join_waitlist', otherTenant), {
        resource_id: van,
        start: at(70).toISOString(),
        end: at(71).toISOString(),
        holder_ref: 'intruder',
      }),
    ).rejects.toMatchObject({ code: 'resource_not_found', status: 404 });
    expect(await application.leaveWaitlist(context('slotlock_leave_waitlist'), { entry_id: id })).toEqual({ left: true });
  });

  it('releases a booking left unclaimed past its check-in window, and only one made once asked', async () => {
    const desk = await resource();
    const now = Date.now();
    // Made before the rule: kept, though unclaimed.
    const before = await book(desk, new Date(now - 40 * MINUTE), new Date(now - 35 * MINUTE + HOUR));
    await store.setResourceBookingRules({ tenantRef, id: desk, rules: { checkInMinutes: 15 } });
    const desk2 = await resource();
    await store.setResourceBookingRules({ tenantRef, id: desk2, rules: { checkInMinutes: 15 } });
    const desk3 = await resource();
    await store.setResourceBookingRules({ tenantRef, id: desk3, rules: { checkInMinutes: 15 } });
    const desk4 = await resource();
    await store.setResourceBookingRules({ tenantRef, id: desk4, rules: { checkInMinutes: 15 } });
    const unclaimed = await book(desk2, new Date(now - 20 * MINUTE), new Date(now + HOUR));
    const claimed = await book(desk3, new Date(now - 20 * MINUTE), new Date(now + HOUR));
    const early = await book(desk4, new Date(now - 5 * MINUTE), new Date(now + HOUR));
    // Booked an hour ago, once the rules asked for check-in two hours ago.
    await backdate([desk2, desk3, desk4], [unclaimed, claimed, early]);
    expect(
      await application.checkInReservation(context('slotlock_check_in_reservation'), { reservation_ref: claimed }),
    ).toMatchObject({ reference: claimed, checked_in_at: expect.any(String) });
    // Setting the rules again keeps the time check-in was first asked for.
    await store.setResourceBookingRules({ tenantRef, id: desk, rules: { checkInMinutes: 15, turnaroundMinutes: 5 } });

    const pass = await maintainSlotlockTenant(store, tenantRef);
    expect(pass.noShows).toBe(1);
    expect(await store.getReservation({ tenantRef, externalRef: unclaimed })).toBeNull();
    for (const kept of [before, claimed, early]) {
      expect(await store.getReservation({ tenantRef, externalRef: kept })).not.toBeNull();
    }
    expect(await changes('reservation.no_show')).toEqual([
      expect.objectContaining({
        subject: unclaimed,
        data: expect.objectContaining({ resource_id: desk2, revision: 2, check_in_minutes: 15 }),
      }),
    ]);
    expect((await changes('reservation.checked_in')).map(({ subject }) => subject)).toEqual([claimed]);
    // The reference is retired: a late create cannot bring it back at the old revision.
    expect(
      await store.createExternalReservation({
        tenantRef,
        externalRef: unclaimed,
        resourceId: desk2,
        start: new Date(now - 20 * MINUTE),
        end: new Date(now + HOUR),
        bufferAfterMs: 0,
        revision: 1,
      }),
    ).toMatchObject({ ok: false });

    // Clearing the rule stops releases; check-in after the end, or of nothing, is refused.
    await store.setResourceBookingRules({ tenantRef, id: desk4, rules: null });
    expect((await sql`SELECT check_in_since FROM slotlock.resources WHERE id = ${desk4}`)[0]?.check_in_since).toBeNull();
    const past = await book(desk3, at(-24 * 400), at(-24 * 400 + 1));
    await expect(
      application.checkInReservation(context('slotlock_check_in_reservation'), { reservation_ref: past }),
    ).rejects.toMatchObject({ code: 'reservation_ended', status: 409 });
    await expect(
      application.checkInReservation(context('slotlock_check_in_reservation'), { reservation_ref: 'no-such' }),
    ).rejects.toMatchObject({ code: 'reservation_not_found', status: 404 });
  });

  // What the independent review reproduced, each kept as a test.
  describe('under load and races', () => {
    const fullPool = async (pool: string, members: number) => {
      const ids: string[] = [];
      for (let n = 0; n < members; n++) ids.push(await resource(pool));
      await sql`
        INSERT INTO slotlock.reservations (resource_id, tenant_ref, external_ref, starts_at, ends_at)
        SELECT id, ${tenantRef}, 'full-' || id, ${at(200)}, ${at(400)} FROM unnest(${sql.array(ids)}::uuid[]) AS id`;
      return ids;
    };

    it('tries no hold on a pool that is full, so a pass holds a handful of locks, not thousands', async () => {
      await fullPool('crowded', 100);
      for (let n = 0; n < 10; n++) {
        expect((await join({ pool: 'crowded', start: at(210 + n), end: at(211 + n), holderRef: `crowd-${n}` })).ok).toBe(true);
      }
      const { result, locks } = await sql.begin(async (tx) => {
        const result = await createSlotlockStore(tx).offerWaitlist({ tenantRef });
        const [held] = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_locks
           WHERE pid = pg_backend_pid() AND locktype = 'transactionid'`;
        return { result, locks: held?.count ?? 0 };
      });
      expect(result.offered).toBe(0);
      // Before: two per refused hold, 2,000 for this pass.
      expect(locks).toBeLessThan(20);
    }, 120_000);

    it('offers an entry whose window is free however many older ones wait', async () => {
      const full = await resource();
      await book(full, at(300), at(310));
      for (let n = 0; n < 120; n++) {
        const joined = await join({ resourceId: full, start: at(301), end: at(302), holderRef: `queue-${n % 6}-${Math.floor(n / 6)}` });
        expect(joined.ok).toBe(true);
      }
      const free = await resource();
      expect((await join({ resourceId: free, start: at(301), end: at(302), holderRef: 'late' })).ok).toBe(true);
      const pass = await maintainSlotlockTenant(store, tenantRef);
      expect(pass.waitlistOffers).toBeGreaterThanOrEqual(1);
      expect((await entries({ resourceId: free }))[0]?.status).toBe('offered');
    }, 120_000);

    it('lets an offer go with the entry that leaves, even mid-offer', async () => {
      const van = await resource();
      const joined = await join({ resourceId: van, start: at(320), end: at(321), holderRef: 'leaver' });
      const id = joined.ok ? joined.entry.id : '';
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked = () => {};
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // Stalls the offer's hold, after it has read and locked the entry.
      const blocker = sql.begin(async (tx) => {
        await tx`SELECT id FROM slotlock.resources WHERE id = ${van} FOR UPDATE`;
        locked();
        await gate;
      });
      await isLocked;
      const pending = offer();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const leaving = store.withTenant(tenantRef, (tenant) => tenant.leaveWaitlist({ tenantRef, id }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await blocker;
      await pending;
      expect(await leaving).toBe(true);
      expect(await sql`SELECT 1 FROM slotlock.waitlist_entries WHERE id = ${id}`).toHaveLength(0);
      expect(
        await sql`SELECT 1 FROM slotlock.reservations WHERE resource_id = ${van} AND status = 'held'`,
      ).toHaveLength(0);
    }, 30_000);

    it('opens check-in an hour before the start, and a move to another start clears it', async () => {
      const desk = await resource();
      await store.setResourceBookingRules({ tenantRef, id: desk, rules: { checkInMinutes: 15 } });
      const now = Date.now();
      const ref = await book(desk, new Date(now + 72 * HOUR), new Date(now + 73 * HOUR));
      await expect(
        application.checkInReservation(context('slotlock_check_in_reservation'), { reservation_ref: ref }),
      ).rejects.toMatchObject({ code: 'check_in_not_open', status: 409 });
      const soon = await book(desk, new Date(now + 30 * MINUTE), new Date(now + 90 * MINUTE));
      expect(await store.checkInReservation({ tenantRef, externalRef: soon })).toMatchObject({ ok: true });
      // Moved to a start that passed 20 minutes ago: no longer claimed, so released.
      const moved = await store.rescheduleExternalReservation({
        tenantRef,
        externalRef: soon,
        resourceId: desk,
        start: new Date(now - 20 * MINUTE),
        end: new Date(now + 30 * MINUTE),
        bufferAfterMs: 0,
        revision: 2,
      });
      expect(moved.ok).toBe(true);
      await backdate([desk], [soon]);
      const released = await store.withTenant(tenantRef, (tenant) => tenant.releaseNoShows({ tenantRef }));
      expect(released).toBe(1);
      expect(await store.getReservation({ tenantRef, externalRef: soon })).toBeNull();
    });

    it("gives a walk-in made after its start its own check-in window", async () => {
      const desk = await resource();
      await store.setResourceBookingRules({ tenantRef, id: desk, rules: { checkInMinutes: 15 } });
      const now = Date.now();
      const walkIn = await book(desk, new Date(now - 30 * MINUTE), new Date(now + HOUR));
      expect(await store.withTenant(tenantRef, (tenant) => tenant.releaseNoShows({ tenantRef }))).toBe(0);
      expect(await store.getReservation({ tenantRef, externalRef: walkIn })).not.toBeNull();
    });

    it("refuses, in the database, an entry on another tenant's resource", async () => {
      const theirs = await store.createResource({ tenantRef: otherTenant, externalRef: `x-${randomUUID()}`, timezone: 'UTC' });
      await expect(sql`
        INSERT INTO slotlock.waitlist_entries (tenant_ref, resource_id, starts_at, ends_at, holder_ref, offer_ttl_ms)
        VALUES (${tenantRef}, ${theirs.id}, ${at(1)}, ${at(2)}, 'intruder', 900000)`).rejects.toMatchObject({
        code: '23503',
      });
    });
  });
});
