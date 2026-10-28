// An agent's holds against real Postgres: candidates held as one group, booked by hold_id (which
// frees the alternatives in the same transaction), released together, kept to their holder, and
// capped per holder. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SlotlockAgentInvocationContext } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { SLOTLOCK_MAX_HOLDS_PER_HOLDER, type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface HoldsOutput {
  group_id: string;
  holds: { hold_id: string; resource_id: string; start: string; end: string; expires_at: string }[];
  refused: { index: number; code: string }[];
}

describe.skipIf(!url)('agent holds (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let backend: ReturnType<typeof createSlotlockStoreAgentBackend>;
  const tenantRef = `agent-holds-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 2, 1, 0, 0, 0);
  const at = (day: number, hour: number) => new Date(base + day * DAY + hour * HOUR).toISOString();

  const context = (operation: string, subject = 'holds-agent'): SlotlockAgentInvocationContext => ({
    principal: { subject, tenantRef },
    operation: operation as SlotlockAgentInvocationContext['operation'],
    signal: new AbortController().signal,
  });

  const hold = (
    slots: { resource_id: string; start: string; end: string }[],
    subject?: string,
    key = `h-${randomUUID()}`,
  ) =>
    backend.holdSlots?.(context('slotlock_hold_slots', subject), {
      slots,
      ttl_seconds: 300,
      idempotency_key: key,
    }) as unknown as Promise<HoldsOutput>;

  const create = (resourceId: string, start: string, end: string, holdId?: string, subject?: string) =>
    backend.createEvent(context('slotlock_create_event', subject), {
      resource_id: resourceId,
      starts_at: start,
      ends_at: end,
      timezone: 'UTC',
      transparency: 'opaque',
      status: 'confirmed',
      idempotency_key: `e-${randomUUID()}`,
      ...(holdId ? { hold_id: holdId } : {}),
    });

  const liveHolds = async (resourceId: string) =>
    (
      await sql<{ id: string }[]>`
        SELECT id FROM slotlock.reservations
         WHERE resource_id = ${resourceId} AND status = 'held' AND expires_at > now()`
    ).map(({ id }) => id);

  async function van() {
    return (await store.createResource({ tenantRef, externalRef: `van-${randomUUID()}`, timezone: 'UTC' })).id;
  }

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    backend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] });
  });

  afterAll(async () => {
    await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.hold_commands WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.reservations WHERE resource_id IN (
                SELECT id FROM slotlock.resources WHERE tenant_ref = ${tenantRef})`;
    await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
    await sql.end();
  });

  it('holds candidates as a group, and booking one frees the others', async () => {
    const id = await van();
    const held = await hold([
      { resource_id: id, start: at(0, 9), end: at(0, 10) },
      { resource_id: id, start: at(0, 11), end: at(0, 12) },
      { resource_id: id, start: at(0, 14), end: at(0, 15) },
    ]);
    expect(held.holds).toHaveLength(3);
    expect(held.refused).toEqual([]);
    expect((await liveHolds(id)).sort()).toEqual(held.holds.map(({ hold_id }) => hold_id).sort());

    // Held time is busy for everyone else, this agent's plain create included.
    await expect(create(id, at(0, 11), at(0, 12))).rejects.toMatchObject({ code: 'overlap' });

    const chosen = held.holds[1]?.hold_id as string;
    const booked = (await create(id, at(0, 11), at(0, 12), chosen)) as { event: { id: string } };
    expect(booked.event.id).toBeTruthy();
    expect(await liveHolds(id)).toEqual([]);
    // The freed alternatives are bookable at once.
    await expect(create(id, at(0, 9), at(0, 10))).resolves.toBeTruthy();
  });

  it('answers a retry with the same holds, and refuses a taken candidate by index', async () => {
    const id = await van();
    await create(id, at(1, 9), at(1, 10));
    const key = `retry-${randomUUID()}`;
    const slots = [
      { resource_id: id, start: at(1, 9), end: at(1, 10) },
      { resource_id: id, start: at(1, 13), end: at(1, 14) },
    ];
    const first = await hold(slots, undefined, key);
    expect(first.refused).toEqual([{ index: 0, code: 'overlap' }]);
    expect(first.holds).toHaveLength(1);
    const again = await hold(slots, undefined, key);
    expect(again.group_id).toBe(first.group_id);
    expect(again.holds).toEqual(first.holds);
    expect(await liveHolds(id)).toHaveLength(1);
  });

  it("keeps a hold to its holder: another agent can neither book nor release it", async () => {
    const id = await van();
    const held = await hold([
      { resource_id: id, start: at(2, 9), end: at(2, 10) },
      { resource_id: id, start: at(2, 11), end: at(2, 12) },
    ]);
    const holdId = held.holds[0]?.hold_id as string;
    await expect(create(id, at(2, 9), at(2, 10), holdId, 'other-agent')).rejects.toMatchObject({
      code: 'hold_not_found',
      status: 404,
    });
    expect(
      await backend.releaseSlots?.(context('slotlock_release_slots', 'other-agent'), { hold_id: holdId }),
    ).toEqual({ released: false });
    expect(await liveHolds(id)).toHaveLength(2);

    // Its holder releases the whole group with one of them.
    expect(await backend.releaseSlots?.(context('slotlock_release_slots'), { hold_id: holdId })).toEqual({
      released: true,
    });
    expect(await liveHolds(id)).toEqual([]);
  });

  it('refuses a booking outside the held time, and one from an expired hold', async () => {
    const id = await van();
    const held = await hold([{ resource_id: id, start: at(3, 9), end: at(3, 10) }]);
    const holdId = held.holds[0]?.hold_id as string;
    await expect(create(id, at(3, 9), at(3, 11), holdId)).rejects.toMatchObject({
      code: 'hold_mismatch',
      status: 409,
    });
    expect(await liveHolds(id)).toEqual([holdId]);

    await sql`UPDATE slotlock.reservations SET expires_at = now() - interval '1 second' WHERE id = ${holdId}`;
    await expect(create(id, at(3, 9), at(3, 10), holdId)).rejects.toMatchObject({
      code: 'hold_not_found',
      status: 404,
    });
  });

  it('does not judge notice again when a hold is booked', async () => {
    const id = await van();
    await store.setResourceBookingRules({ tenantRef, id, rules: { minNoticeMinutes: 60 } });
    const soon = new Date(Date.now() + 2 * HOUR);
    soon.setUTCMinutes(0, 0, 0);
    const end = new Date(soon.getTime() + HOUR);
    const held = await hold([{ resource_id: id, start: soon.toISOString(), end: end.toISOString() }]);
    const holdId = held.holds[0]?.hold_id as string;
    expect(holdId).toBeTruthy();
    // Notice a plain create would now fail, by having the clock move past it.
    await store.setResourceBookingRules({ tenantRef, id, rules: { minNoticeMinutes: 600 } });
    await expect(create(id, soon.toISOString(), end.toISOString())).rejects.toMatchObject({
      code: 'booking_rule_min_notice',
    });
    await expect(create(id, soon.toISOString(), end.toISOString(), holdId)).resolves.toBeTruthy();
  });

  it(`caps one holder at ${SLOTLOCK_MAX_HOLDS_PER_HOLDER} live holds, and not an application`, async () => {
    const id = await van();
    const subject = `greedy-${randomUUID()}`;
    for (let batch = 0; batch < SLOTLOCK_MAX_HOLDS_PER_HOLDER / 5; batch++) {
      const slots = Array.from({ length: 5 }, (_, index) => ({
        resource_id: id,
        start: at(10 + batch, index * 2),
        end: at(10 + batch, index * 2 + 1),
      }));
      expect((await hold(slots, subject)).holds).toHaveLength(5);
    }
    const over = await hold([{ resource_id: id, start: at(20, 9), end: at(20, 10) }], subject);
    expect(over.refused).toEqual([{ index: 0, code: 'hold_limit_reached' }]);
    // Another agent is not counted against this one.
    expect((await hold([{ resource_id: id, start: at(20, 9), end: at(20, 10) }])).holds).toHaveLength(1);

    // A hold without a holder, as the application API takes, has no cap.
    const application = await store.acquireHold({
      tenantRef,
      principalRef: subject,
      idempotencyKey: `app-${randomUUID()}`,
      resourceId: id,
      start: new Date(at(21, 9)),
      end: new Date(at(21, 10)),
      ttlMs: 60_000,
    });
    expect(application.ok).toBe(true);
  });

  it('bounds one holder by the hours its holds hold together, and by a count the store is given', async () => {
    const id = await van();
    const tight = createSlotlockStore(sql, { maxHoldsPerHolder: 3, maxHeldHoursPerHolder: 10 });
    const holdFor = (start: string, end: string, holderRef = 'hoarder') =>
      tight.withTenant(tenantRef, (tenant) =>
        tenant.acquireHold({
          tenantRef,
          principalRef: holderRef,
          holderRef,
          idempotencyKey: `t-${randomUUID()}`,
          resourceId: id,
          start: new Date(start),
          end: new Date(end),
          ttlMs: 60_000,
        }),
      );
    // Eight hours held, then two more: ten, the limit. One hour more is refused, by time.
    expect((await holdFor(at(40, 0), at(40, 8))).ok).toBe(true);
    expect((await holdFor(at(41, 0), at(41, 2))).ok).toBe(true);
    expect(await holdFor(at(42, 0), at(42, 1))).toEqual({ ok: false, code: 'held_time_limit_reached', limit: 10 });
    // Another holder has its own.
    expect((await holdFor(at(42, 0), at(42, 1), 'other')).ok).toBe(true);
    // The count: three short holds, then a fourth refused by number.
    for (const hour of [1, 3, 5]) expect((await holdFor(at(43, hour), at(43, hour + 1), 'counted')).ok).toBe(true);
    expect(await holdFor(at(43, 8), at(43, 9), 'counted')).toEqual({ ok: false, code: 'hold_limit_reached', limit: 3 });
    // Turnaround is held too: nine hours and one after it are the ten.
    const buffered = await tight.withTenant(tenantRef, (tenant) =>
      tenant.acquireHold({
        tenantRef, principalRef: 'buffered', holderRef: 'buffered', idempotencyKey: `t-${randomUUID()}`,
        resourceId: id, start: new Date(at(44, 0)), end: new Date(at(44, 9)), bufferAfterMs: 3_600_000, ttlMs: 60_000,
      }),
    );
    expect(buffered.ok).toBe(true);
    expect(await holdFor(at(45, 0), at(45, 1), 'buffered')).toEqual({ ok: false, code: 'held_time_limit_reached', limit: 10 });
    expect(() => createSlotlockStore(sql, { maxHeldHoursPerHolder: 0 })).toThrow(/maxHeldHoursPerHolder/);
    expect(() => createSlotlockStore(sql, { maxHoldsPerHolder: 10_001 })).toThrow(/maxHoldsPerHolder/);
  });
});
