// Time zone rules that change after a booking, against real Postgres. A new tzdata is simulated by
// moving the stored wall time, as if the rules now put the same wall time an hour later. The shift
// is reported once; with move, the event goes to its new instant, and stays where it was, reported,
// when that would overlap another booking. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;

describe.skipIf(!url)('time zone rule changes (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantRef = `zones-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 8, 1, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR);

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  async function booked(start: number, externalRef = `ev-${randomUUID()}`) {
    const resource = await store.createResource({ tenantRef, externalRef: `r-${randomUUID()}`, timezone: 'America/Winnipeg' });
    const put = await store.putCalendarEvent({
      tenantRef,
      externalRef,
      resourceId: resource.id,
      expectedRevision: 0,
      idempotencyKey: `${externalRef}-create`,
      start: at(start),
      end: at(start + 1),
      timezone: 'America/Winnipeg',
      summary: 'Pickup',
    });
    if (!put.ok) throw new Error(put.code);
    const event = await store.getCalendarEvent({ tenantRef, externalRef });
    // The rules changed: the wall time the person booked now falls an hour later.
    await sql`UPDATE slotlock.calendar_events
                 SET wall_starts_at = wall_starts_at + interval '1 hour',
                     wall_ends_at = wall_ends_at + interval '1 hour'
               WHERE id = ${event?.id as string}`;
    return { resourceId: resource.id, eventId: event?.id as string, externalRef };
  }

  const follow = (move: boolean) => store.withTenant(tenantRef, (tenant) => tenant.followZoneRules({ tenantRef, move }));

  it('keeps the wall time each event was booked for', async () => {
    const { eventId } = await booked(1);
    const [row] = await sql<{ wall: Date; zone_start: Date }[]>`
      SELECT wall_starts_at::text AS wall, slotlock.zoned_instant(wall_starts_at - interval '1 hour', timezone) AS zone_start
        FROM slotlock.calendar_events WHERE id = ${eventId}`;
    expect(row?.zone_start.getTime()).toBe(at(1).getTime());
    await sql`UPDATE slotlock.calendar_events SET zone_shift_reported_at = now() WHERE id = ${eventId}`;
  });

  it('reports a shifted event once, and leaves it where it is', async () => {
    const { eventId } = await booked(10);
    expect(await follow(false)).toEqual({ shifted: 1, moved: 0, conflicts: 0 });
    expect(await follow(false)).toEqual({ shifted: 0, moved: 0, conflicts: 0 });
    const [reported] = await store.listHistory({ tenantRef, subject: eventId, limit: 1 });
    expect(reported).toMatchObject({
      type: 'event.timezone_shifted',
      actor: 'slotlock:tzdata',
      data: { start: at(10).toISOString(), zone_start: at(11).toISOString() },
    });
    const [stays] = await sql<{ starts_at: Date }[]>`SELECT starts_at FROM slotlock.calendar_events WHERE id = ${eventId}`;
    expect(stays?.starts_at.getTime()).toBe(at(10).getTime());
  });

  it('moves it to its new instant, occupation and all, as a new revision', async () => {
    const { eventId, resourceId, externalRef } = await booked(20);
    expect(await follow(true)).toEqual({ shifted: 1, moved: 1, conflicts: 0 });
    const event = await store.getCalendarEvent({ tenantRef, externalRef });
    expect(event?.start.getTime()).toBe(at(21).getTime());
    expect(Number(event?.revision)).toBe(2);
    // The time it occupies moved with it: the old hour is free, the new one taken.
    const busy = await store.listBusy(resourceId, { start: at(19), end: at(24) }, { tenantRef });
    expect(busy.map(({ start }) => start.getTime())).toEqual([at(21).getTime()]);
    const [moved] = await store.listHistory({ tenantRef, subject: eventId, limit: 1 });
    expect(moved).toMatchObject({ type: 'event.updated', actor: 'slotlock:tzdata', data: { before: { revision: 1 } } });
  });

  it('leaves it in place and reports a conflict when the new instant is taken', async () => {
    const { eventId, resourceId } = await booked(30);
    const blocker = await store.createExternalReservation({
      tenantRef, externalRef: `blk-${randomUUID()}`, resourceId, start: at(31), end: at(32), bufferAfterMs: 0, revision: 1,
    });
    expect(blocker.ok).toBe(true);
    expect(await follow(true)).toEqual({ shifted: 1, moved: 0, conflicts: 1 });
    const [conflict] = await store.listHistory({ tenantRef, subject: eventId, limit: 1 });
    expect(conflict).toMatchObject({ type: 'event.timezone_conflict', data: { zone_start: at(31).toISOString() } });
    const [stays] = await sql<{ starts_at: Date }[]>`SELECT starts_at FROM slotlock.calendar_events WHERE id = ${eventId}`;
    expect(stays?.starts_at.getTime()).toBe(at(30).getTime());
  });
});
