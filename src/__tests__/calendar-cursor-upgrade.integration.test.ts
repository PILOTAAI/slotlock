// A stored series rolled from a cursor Slotlock 0.1 kept beside it. 0.1 read a zoned occurrence as
// UTC beside the series' UTC UNTIL, so the cursor it kept for this Berlin series had already ended
// at the occurrence UNTIL names (1 February, 09:00 Berlin); resumed, that hour was never
// materialized and a booking took it. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim();
// What 0.1's expandCalendarEventSeries kept for this series and [2027-01-27, 2027-03-01].
const CURSOR_FROM_0_1 = {
  v: 1,
  ical: '2.2.1',
  key: '55c3c64437d7709ca212e3c7758c1c0c0668bdeb2d715af111223e5e967668a4',
  position: 1800864000000,
  last: [2027, 1, 25, 9, 0, 0, false],
  complete: false,
  iterator: {
    last: [2027, 2, 1, 9, 0, 0, false],
    by_data: { BYSECOND: [0], BYMINUTE: [0], BYHOUR: [9], BYMONTHDAY: [4], BYDAY: ['MO'] },
    by_indices: {
      BYSECOND: 0,
      BYMINUTE: 0,
      BYHOUR: 0,
      BYDAY: 0,
      BYMONTH: 0,
      BYWEEKNO: 0,
      BYMONTHDAY: 0,
    },
    days: [],
    days_index: 0,
    occurrence_number: 4,
    completed: true,
  },
};

describe.skipIf(!url)('a stored series rolled from a cursor 0.1 kept (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantRef = `cursor-upgrade-${randomUUID()}`;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => undefined });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    await sql.end();
  });

  it.each([
    ['the cursor this version left', false],
    ['the cursor 0.1 left', true],
  ])('from %s, 1 February 09:00 Berlin stays occupied', async (_name, from01) => {
    const resourceId = (
      await store.createResource({
        externalRef: `van-${randomUUID()}`,
        tenantRef,
        timezone: 'Europe/Berlin',
      })
    ).id;
    const put = await store.putCalendarEvent({
      tenantRef,
      externalRef: `handover-${randomUUID()}`,
      idempotencyKey: `put-${randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: new Date('2027-01-04T08:00:00Z'),
      end: new Date('2027-01-04T09:00:00Z'),
      timezone: 'Europe/Berlin',
      summary: 'Weekly handover',
      recurrence: { rrule: 'FREQ=WEEKLY;UNTIL=20270201T080000Z' },
      materializationWindow: {
        start: new Date('2027-01-27T00:00:00Z'),
        end: new Date('2027-01-31T00:00:00Z'),
      },
    });
    expect(put).toMatchObject({ ok: true });
    const [row] = await sql<{ id: string; recurrence_cursor: { key: string } | null }[]>`
      SELECT id, recurrence_cursor FROM slotlock.calendar_events WHERE resource_id = ${resourceId}`;
    expect(row?.recurrence_cursor?.key).toMatch(/^[0-9a-f]{64}$/);
    if (from01) {
      await sql`UPDATE slotlock.calendar_events SET recurrence_cursor = ${sql.json(CURSOR_FROM_0_1)}
                 WHERE id = ${row?.id as string}`;
    }
    await store.rollCalendarEventHorizon({
      tenantRef,
      window: { start: new Date('2027-01-28T00:00:00Z'), end: new Date('2027-03-01T00:00:00Z') },
    });
    const booking = await store.createReservation({
      resourceId,
      start: new Date('2027-02-01T08:00:00Z'),
      end: new Date('2027-02-01T09:00:00Z'),
    });
    expect(booking).toMatchObject({ ok: false, code: 'overlap' });
    // The series' own cursor has another key than the one 0.1 gave it.
    expect(row?.recurrence_cursor?.key).not.toBe(CURSOR_FROM_0_1.key);
  });
});
