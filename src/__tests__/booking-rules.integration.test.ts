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

  it('refuses, with 15-minute buffers and 2-hour notice, a booking 1 hour out and one that abuts another (RFC 0002 P1-4)', async () => {
    const id = await ruled({ bufferBeforeMinutes: 15, turnaroundMinutes: 15, minNoticeMinutes: 120 });
    const soon = new Date(Math.ceil((Date.now() + HOUR) / MINUTE) * MINUTE);
    expect(await book(id, soon, new Date(soon.getTime() + HOUR))).toMatchObject({
      ok: false,
      code: 'booking_rule_violated',
      rule: 'min_notice',
    });
    const first = await book(id, at(10), at(11));
    if (!first.ok) throw new Error(first.code);
    // It occupies 09:45 to 11:15 in the database.
    const [row] = await sql<{ occupied_starts_at: Date; occupied_ends_at: Date; buffer_before_ms: string }[]>`
      SELECT occupied_starts_at, occupied_ends_at, buffer_before_ms FROM slotlock.reservations
       WHERE id = ${first.reservation.id}`;
    expect(row).toMatchObject({ occupied_starts_at: at(9, 45), occupied_ends_at: at(11, 15) });
    expect(Number(row?.buffer_before_ms)).toBe(15 * MINUTE);
    // Abutting it either side, or 15 minutes off (one buffer, not both), is refused.
    for (const [start, end] of [
      [at(11), at(12)],
      [at(9), at(10)],
      [at(11, 15), at(12, 15)],
      [at(8, 45), at(9, 45)],
    ] as const) {
      expect(await book(id, start, end), start.toISOString()).toMatchObject({
        ok: false,
        code: 'overlap',
        conflictingReservationId: first.reservation.id,
      });
    }
    // Both buffers apart: the earlier one's trailing and the later one's leading.
    expect(await book(id, at(11, 30), at(12, 30))).toMatchObject({ ok: true });
    expect(await book(id, at(8, 30), at(9, 30))).toMatchObject({ ok: true });
    // A hold and a move keep it too.
    expect(
      await store.acquireHold({ resourceId: id, start: at(12, 30), end: at(13), ttlMs: 60_000 }),
    ).toMatchObject({ ok: false, code: 'overlap' });
    expect(
      await store.rescheduleExternalReservation({
        tenantRef,
        externalRef: first.reservation.externalRef as string,
        resourceId: id,
        start: at(9, 45),
        end: at(10, 15),
        bufferAfterMs: 0,
        revision: 2,
      }),
    ).toMatchObject({ ok: false, code: 'overlap' });
  });

  it('refuses a leading-buffer overlap in the database itself, whatever wrote the row', async () => {
    const id = await ruled(null);
    const insert = (start: Date, end: Date, bufferBeforeMs: number) => sql`
      INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, buffer_before_ms)
      VALUES (${id}, ${start}, ${end}, ${bufferBeforeMs})`;
    await insert(at(10), at(11), 0);
    // 11:00-12:00 keeping 1 minute before it reaches into 10:00-11:00.
    await expect(insert(at(11), at(12), MINUTE)).rejects.toMatchObject({ code: '23P01' });
    await insert(at(11, 1), at(12), MINUTE);
    // The occupied start is the trigger's, not the writer's.
    await expect(sql`
      UPDATE slotlock.reservations SET occupied_starts_at = starts_at
       WHERE resource_id = ${id} AND buffer_before_ms > 0`).rejects.toMatchObject({ code: '23514' });
    await expect(insert(at(13), at(14), 24 * HOUR + 1)).rejects.toMatchObject({ code: '23514' });
    // Nor may it be cleared: a NULL occupied start reads as the start, dropping the buffer.
    await expect(sql`
      UPDATE slotlock.reservations SET occupied_starts_at = NULL
       WHERE resource_id = ${id} AND buffer_before_ms > 0`).rejects.toMatchObject({ code: '23514' });
    // Free/busy reads the occupied time: the 11:00-11:01 lead is busy too.
    expect(await store.getFreeBusy({ tenantRef, resourceId: id, window: { start: at(9), end: at(13) } })).toMatchObject({
      busy: [{ start: at(10), end: at(12) }],
    });
  });

  it('starts bookings on an offset step in the resource’s zone, on writes and searches', async () => {
    const resource = await store.createResource({ tenantRef, externalRef: `van-${randomUUID()}`, timezone: 'Asia/Kolkata' });
    await store.setResourceBookingRules({
      tenantRef,
      id: resource.id,
      rules: { slotStepMinutes: 30, stepOffsetMinutes: 15 },
    });
    // 15:15 in Kolkata (UTC+05:30) is 09:45 UTC; 15:30 there is 10:00 UTC.
    expect(await book(resource.id, at(9, 45), at(10, 45))).toMatchObject({ ok: true });
    expect(await book(resource.id, at(12), at(13))).toMatchObject({ rule: 'slot_step' });
    const slot = await store.findNextAvailableFor({
      tenantRef,
      resourceId: resource.id,
      searchWindow: { start: at(10, 50), end: at(16) },
      durationMs: HOUR,
      rules: [{ rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 0, durationMinutes: 24 * 60 }],
    });
    // 16:20 there is past 16:15, so 16:45 local: 11:15 UTC.
    expect(slot).toEqual({ start: at(11, 15), end: at(12, 15) });
  });

  it('offers in a search only slots a write accepts, over several configurations (property)', async () => {
    const configurations = [
      { slotStepMinutes: 30, stepOffsetMinutes: 15, bufferBeforeMinutes: 15, turnaroundMinutes: 15 },
      { bufferBeforeMinutes: 30, enforceHours: true },
      { slotStepMinutes: 20, stepOffsetMinutes: 10, bufferBeforeMinutes: 25, turnaroundMinutes: 5 },
      { slotStepMinutes: 60, bufferBeforeMinutes: 45 },
    ];
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => WEEKDAYS });
    const context: SlotlockAgentInvocationContext = {
      principal: { subject: 'rules-agent', tenantRef },
      operation: 'slotlock_find_next_available' as SlotlockAgentInvocationContext['operation'],
      signal: new AbortController().signal,
    };
    for (const rules of configurations) {
      const id = await ruled(rules);
      // Someone else's bookings, written without the rules (an import, say), leave odd gaps.
      for (const [start, end] of [
        [at(10, 5), at(10, 50)],
        [at(12, 40), at(13, 10)],
        [at(15, 25), at(15, 35)],
      ] as const) {
        await sql`INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at) VALUES (${id}, ${start}, ${end})`;
      }
      let booked = 0;
      for (let round = 0; round < 12; round++) {
        const minutes = [25, 40, 60, 90][round % 4] as number;
        const label = JSON.stringify({ rules, round });
        const slot = await store.findNextAvailableFor({
          tenantRef,
          resourceId: id,
          searchWindow: { start: at(9), end: at(17) },
          durationMs: minutes * MINUTE,
          rules: WEEKDAYS,
        });
        const agent = (await backend.findNextAvailable(context, {
          resource_ids: [id],
          start: at(9).toISOString(),
          end: at(17).toISOString(),
          duration_minutes: minutes,
        })) as { start: string | null };
        expect(agent.start, label).toBe(slot?.start.toISOString() ?? null);
        if (!slot) break;
        expect(await book(id, slot.start, slot.end), label).toMatchObject({ ok: true });
        booked += 1;
      }
      expect(booked, JSON.stringify(rules)).toBeGreaterThan(1);
    }
  });

  it('keeps the leading buffer on an agent’s event and on the occurrences a roll adds', async () => {
    const id = await ruled({ bufferBeforeMinutes: 20 });
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
    const buffers = await sql<{ buffer_before_ms: number }[]>`
      SELECT buffer_before_ms FROM slotlock.reservations WHERE calendar_event_id = ${weekly.eventId}`;
    expect(buffers.map((row) => Number(row.buffer_before_ms))).toEqual([20 * MINUTE, 20 * MINUTE, 20 * MINUTE]);
    const [stored] = await sql<{ buffer_before_ms: number }[]>`
      SELECT buffer_before_ms FROM slotlock.calendar_events WHERE id = ${weekly.eventId}`;
    expect(Number(stored?.buffer_before_ms)).toBe(20 * MINUTE);
    expect(await book(id, at(8, 30), at(8, 50))).toMatchObject({ ok: false, code: 'overlap' });
    expect(await book(id, at(8, 20), at(8, 40))).toMatchObject({ ok: true });
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

  it('books only in time every sync covering the resource has read lately, when certainty is required', async () => {
    const id = await ruled({ requireCertain: true });
    // No sync covers it: nothing is unproven.
    expect(await book(id, at(9), at(10))).toMatchObject({ ok: true });
    const covered = await store.recordCalendarCoverage({
      tenantRef,
      resourceId: id,
      source: 'google:fleet',
      window: { start: at(0), end: at(24) },
      revision: 1,
    });
    expect(covered.ok).toBe(true);
    expect(await book(id, at(10), at(11))).toMatchObject({ ok: true });
    // Past what the sync read: it may hide a booking there.
    expect(await book(id, at(30), at(31))).toMatchObject({
      ok: false,
      code: 'booking_rule_violated',
      rule: 'uncertain',
    });
    const agentBackend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => WEEKDAYS });
    const context = (operation: string): SlotlockAgentInvocationContext => ({
      principal: { subject: 'rules-agent', tenantRef },
      operation: operation as SlotlockAgentInvocationContext['operation'],
      signal: new AbortController().signal,
    });
    await expect(
      agentBackend.createEvent(context('slotlock_create_event'), {
        resource_id: id,
        starts_at: at(30).toISOString(),
        ends_at: at(31).toISOString(),
        timezone: 'UTC',
        idempotency_key: `k-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ code: 'booking_rule_uncertain', status: 409 });

    // Searches as the write judges: inside the read window a slot, past it none, called uncertain.
    const search = (start: Date, end: Date) =>
      agentBackend.findNextAvailable(context('slotlock_find_next_available'), {
        resource_ids: [id],
        start: start.toISOString(),
        end: end.toISOString(),
        duration_minutes: 60,
      }) as Promise<{ start: string | null; coverage: { certainty: string } }>;
    expect(await search(at(11), at(17))).toMatchObject({ start: at(11).toISOString(), coverage: { certainty: 'certain' } });
    expect(await search(at(33), at(41))).toMatchObject({ start: null, coverage: { certainty: 'uncertain' } });

    // A sync not read for a day leaves even what it covered unproven.
    await sql`UPDATE slotlock.calendar_coverage SET observed_at = now() - interval '25 hours'
               WHERE resource_id = ${id}`;
    expect(await book(id, at(12), at(13))).toMatchObject({ ok: false, rule: 'uncertain' });

    // Without the rule, the same stale sync does not stop a write.
    await store.setResourceBookingRules({ tenantRef, id, rules: null });
    expect(await book(id, at(12), at(13))).toMatchObject({ ok: true });
  });

  it("searches the store as it writes under requireCertain, and lets a retired sync go", async () => {
    const id = await ruled({ requireCertain: true, turnaroundMinutes: 60 });
    const covered = await store.recordCalendarCoverage({
      tenantRef,
      resourceId: id,
      source: 'google:pool',
      window: { start: at(0), end: at(24) },
      revision: 1,
    });
    expect(covered.ok).toBe(true);
    const search = (start: Date, end: Date) =>
      store.findNextAvailableFor({
        tenantRef,
        resourceId: id,
        rules: WEEKDAYS,
        searchWindow: { start, end },
        durationMs: HOUR,
      });
    // Inside what the sync read, a slot the write then takes.
    const slot = await search(at(9), at(17));
    expect(slot).toEqual({ start: at(9), end: at(10) });
    if (!slot) throw new Error('no slot');
    expect(await book(id, slot.start, slot.end)).toMatchObject({ ok: true });
    // Past it, none offered, and a write there is refused alike; free/busy says incomplete.
    expect(await search(at(33), at(41))).toBeNull();
    expect(await book(id, at(33), at(34))).toMatchObject({ ok: false, rule: 'uncertain' });
    expect(
      (await store.getFreeBusy({ tenantRef, resourceId: id, window: { start: at(33), end: at(41) } })).coverage.state,
    ).not.toBe('complete');
    // The turnaround must lie in read time too: a booking ending at the edge is refused.
    expect(await book(id, at(22, 30), at(23, 30))).toMatchObject({ ok: false, rule: 'uncertain' });

    // A sync that covers only a sliver blocks everything else, until it is retired.
    await store.recordCalendarCoverage({
      tenantRef,
      resourceId: id,
      source: 'old-sync',
      window: { start: at(0), end: at(1) },
      revision: 1,
    });
    expect(await book(id, at(14), at(15))).toMatchObject({ ok: false, rule: 'uncertain' });
    expect(await store.deleteCoverage({ tenantRef, resourceId: id, source: 'old-sync' })).toBe(true);
    expect(await store.deleteCoverage({ tenantRef, resourceId: id, source: 'old-sync' })).toBe(false);
    expect(await store.deleteCoverage({ tenantRef: `${tenantRef}-other`, resourceId: id, source: 'google:pool' })).toBe(false);
    expect(await book(id, at(14), at(15))).toMatchObject({ ok: true });
  });
});
