// A stored series in a zone east of UTC keeps the occurrence its UTC UNTIL names, so that time stays
// booked: read floating, ical.js ended the series a day early and the store let a booking in.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('a stored series named in a zone east of UTC (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantRef = `zones-${randomUUID()}`;
  let resourceId: string;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    resourceId = (
      await store.createResource({
        externalRef: `van-${randomUUID()}`,
        tenantRef,
        timezone: 'Europe/Berlin',
      })
    ).id;
  });

  afterAll(async () => {
    await sql.end();
  });

  it('occupies the occurrence its UNTIL names', async () => {
    const created = await store.putCalendarEvent({
      tenantRef,
      externalRef: `hire-${randomUUID()}`,
      idempotencyKey: `put-${randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: new Date('2027-01-01T08:00:00Z'),
      end: new Date('2027-01-01T09:00:00Z'),
      timezone: 'Europe/Berlin',
      summary: 'Van out on hire',
      recurrence: { rrule: 'FREQ=DAILY;UNTIL=20270103T080000Z' },
      materializationWindow: {
        start: new Date('2027-01-01T00:00:00Z'),
        end: new Date('2027-01-10T00:00:00Z'),
      },
    });
    expect(created).toMatchObject({ ok: true, occurrenceCount: 3 });
    const booking = await store.createReservation({
      resourceId,
      start: new Date('2027-01-03T08:00:00Z'),
      end: new Date('2027-01-03T09:00:00Z'),
    });
    expect(booking).toMatchObject({ ok: false, code: 'overlap' });
  });
});
