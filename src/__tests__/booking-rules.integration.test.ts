// A resource's booking rules on every write path that books it, and on search, against real
// Postgres: a refused write names the rule; the turnaround is kept by the exclusion constraint; a
// slot a search offers is one a write accepts. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SlotlockAgentInvocationContext } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import type { WeeklyAvailabilityRule } from '../types.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAYS: WeeklyAvailabilityRule[] = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 9 * 60, durationMinutes: 8 * 60 },
];

/** A Monday at least a week ahead, at 00:00 UTC. */
function nextMonday(): Date {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysToMonday = (8 - new Date(midnight).getUTCDay()) % 7 || 7;
  return new Date(midnight + (daysToMonday + 7) * DAY);
}

describe.skipIf(!url)('booking rules on writes and searches (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantRef = `rules-${randomUUID()}`;
  const monday = nextMonday();
  const at = (hours: number, minutes = 0) => new Date(monday.getTime() + hours * HOUR + minutes * MINUTE);

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql, { defaultAvailabilityRules: WEEKDAYS });
    await store.applySchema();
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

  async function ruled(rules: Parameters<SlotlockStore['setResourceBookingRules']>[0]['rules']) {
    const resource = await store.createResource({
      tenantRef,
      externalRef: `van-${randomUUID()}`,
      timezone: 'UTC',
    });
    const set = await store.setResourceBookingRules({ tenantRef, id: resource.id, rules });
    expect(set?.bookingRules).toEqual(rules ?? undefined);
    return resource.id;
  }

  const book = (resourceId: string, start: Date, end: Date, externalRef = `b-${randomUUID()}`) =>
    store.createExternalReservation({
      tenantRef,
      externalRef,
      resourceId,
      start,
      end,
      bufferAfterMs: 0,
      revision: 1,
    });

  it('refuses a booking that breaks a rule, naming it, on every write path', async () => {
    const id = await ruled({ slotStepMinutes: 30, enforceHours: true, maxAdvanceDays: 60 });
    expect(await book(id, at(9, 10), at(10, 10))).toEqual({
      ok: false,
      code: 'booking_rule_violated',
      rule: 'slot_step',
    });
    expect(await book(id, at(16, 30), at(17, 30))).toMatchObject({ rule: 'outside_hours' });
    expect(await book(id, at(24 * 5 + 10), at(24 * 5 + 11))).toMatchObject({ rule: 'outside_hours' });
    expect(await book(id, at(24 * 70 + 10), at(24 * 70 + 11))).toMatchObject({ rule: 'max_advance' });
    expect(
      await store.acquireHold({ resourceId: id, start: at(9, 10), end: at(10, 10), ttlMs: 60_000 }),
    ).toMatchObject({ ok: false, code: 'booking_rule_violated', rule: 'slot_step' });
    expect(
      await store.createReservation({ resourceId: id, tenantRef, start: at(8), end: at(9) }),
    ).toMatchObject({ ok: false, code: 'booking_rule_violated', rule: 'outside_hours' });
    const placed = await book(id, at(10), at(11));
    if (!placed.ok) throw new Error(placed.code);
    expect(
      await store.rescheduleExternalReservation({
        tenantRef,
        externalRef: placed.reservation.externalRef as string,
        resourceId: id,
        start: at(10, 5),
        end: at(11, 5),
        bufferAfterMs: 0,
        revision: 2,
      }),
    ).toMatchObject({ ok: false, code: 'booking_rule_violated', rule: 'slot_step' });
  });

  it('refuses a booking inside the minimum notice, by the database clock', async () => {
    const id = await ruled({ minNoticeMinutes: 60 * 24 * 30 });
    expect(await book(id, at(10), at(11))).toMatchObject({ rule: 'min_notice' });
  });

  it('keeps the turnaround after each booking, in the database, and replays a retry', async () => {
    const id = await ruled({ turnaroundMinutes: 30 });
    const externalRef = `b-${randomUUID()}`;
    const first = await book(id, at(10), at(11), externalRef);
    if (!first.ok) throw new Error(first.code);
    expect(first.reservation.bufferAfterMs).toBe(30 * MINUTE);
    // A retry asks for no buffer, as the first request did: the same booking.
    expect(await book(id, at(10), at(11), externalRef)).toMatchObject({ ok: true, idempotent: true });
    expect(await book(id, at(11), at(12))).toMatchObject({ ok: false, code: 'overlap' });
    expect(await book(id, at(11, 30), at(12, 30))).toMatchObject({ ok: true });
  });

  it('leaves an imported event alone, and judges an agent’s event as a booking', async () => {
    const id = await ruled({ slotStepMinutes: 60, turnaroundMinutes: 15 });
    const event = (minutes: number, enforce: boolean) =>
      store.putCalendarEvent({
        tenantRef,
        externalRef: `e-${randomUUID()}`,
        idempotencyKey: `k-${randomUUID()}`,
        expectedRevision: 0,
        resourceId: id,
        start: at(13, minutes),
        end: at(14, minutes),
        timezone: 'UTC',
        summary: 'Imported',
        ...(enforce ? { enforceBookingRules: true } : {}),
      });
    expect(await event(20, false)).toMatchObject({ ok: true });
    expect(await event(40, true)).toMatchObject({
      ok: false,
      code: 'booking_rule_violated',
      rule: 'slot_step',
    });
    // On the hour, it keeps the turnaround: an event at 16:00 then one at 17:00 overlap by it.
    expect(await event(180, true)).toMatchObject({ ok: true });
    expect(await book(id, at(17), at(18))).toMatchObject({ ok: false, code: 'overlap' });
  });

  it('checks every occurrence of a series, and keeps the turnaround on the ones a roll adds', async () => {
    const id = await ruled({ enforceHours: true, turnaroundMinutes: 10 });
    const series = (startHour: number) =>
      store.putCalendarEvent({
        tenantRef,
        externalRef: `s-${randomUUID()}`,
        idempotencyKey: `k-${randomUUID()}`,
        expectedRevision: 0,
        resourceId: id,
        start: at(startHour),
        end: at(startHour + 1),
        timezone: 'UTC',
        summary: 'Daily',
        recurrence: { rrule: 'FREQ=DAILY;COUNT=7' },
        materializationWindow: { start: monday, end: new Date(monday.getTime() + 30 * DAY) },
        enforceBookingRules: true,
      });
    // Daily from Monday reaches Saturday, which has no hours.
    expect(await series(9)).toMatchObject({ ok: false, code: 'booking_rule_violated', rule: 'outside_hours' });
    const weekly = await store.putCalendarEvent({
      tenantRef,
      externalRef: `w-${randomUUID()}`,
      idempotencyKey: `k-${randomUUID()}`,
      expectedRevision: 0,
      resourceId: id,
      start: at(9),
      end: at(10),
      timezone: 'UTC',
      summary: 'Weekly',
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=3' },
      materializationWindow: { start: monday, end: new Date(monday.getTime() + 30 * DAY) },
      enforceBookingRules: true,
    });
    if (!weekly.ok) throw new Error(weekly.code);
    const buffers = await sql<{ buffer_after_ms: number }[]>`
      SELECT buffer_after_ms FROM slotlock.reservations WHERE calendar_event_id = ${weekly.eventId}`;
    expect(buffers.map((row) => Number(row.buffer_after_ms))).toEqual([10 * MINUTE, 10 * MINUTE, 10 * MINUTE]);
    const [stored] = await sql<{ buffer_after_ms: number }[]>`
      SELECT buffer_after_ms FROM slotlock.calendar_events WHERE id = ${weekly.eventId}`;
    expect(Number(stored?.buffer_after_ms)).toBe(10 * MINUTE);
  });

  it('offers in a search only a slot the write then accepts', async () => {
    const id = await ruled({ slotStepMinutes: 30, turnaroundMinutes: 30, enforceHours: true });
    expect((await book(id, at(9), at(9, 40))).ok).toBe(true);
    const slot = await store.findNextAvailableFor({
      tenantRef,
      resourceId: id,
      searchWindow: { start: monday, end: new Date(monday.getTime() + DAY) },
      durationMs: HOUR,
      rules: WEEKDAYS,
    });
    // 09:00-09:40 keeps 30 minutes after it, to 10:10; the next start on a step is 10:30.
    expect(slot).toEqual({ start: at(10, 30), end: at(11, 30) });
    if (!slot) throw new Error('no slot');
    expect(await book(id, slot.start, slot.end)).toMatchObject({ ok: true });
  });

  it('answers an agent with the rule in the code, and searches as the write judges', async () => {
    const id = await ruled({ slotStepMinutes: 60, enforceHours: true });
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => WEEKDAYS });
    const context = (operation: string): SlotlockAgentInvocationContext => ({
      principal: { subject: 'rules-agent', tenantRef },
      operation: operation as SlotlockAgentInvocationContext['operation'],
      signal: new AbortController().signal,
    });
    await expect(
      backend.createEvent(context('slotlock_create_event'), {
        resource_id: id,
        starts_at: at(10, 15).toISOString(),
        ends_at: at(11, 15).toISOString(),
        timezone: 'UTC',
        transparency: 'opaque',
        status: 'confirmed',
        idempotency_key: `k-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'booking_rule_slot_step', status: 409 });
    const next = (await backend.findNextAvailable(context('slotlock_find_next_available'), {
      resource_ids: [id],
      start: at(9, 30).toISOString(),
      end: at(24).toISOString(),
      duration_minutes: 60,
    })) as { start: string };
    expect(next.start).toBe(at(10).toISOString());
  });
});
