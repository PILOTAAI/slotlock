// The store's next-available search answers only from what it can prove: a resource of the
// caller's tenant (another tenant's, or one that does not exist, is not found), time whose coverage
// is complete (a series not stored that far, or a provider calendar not read that far, gives no
// slot), and a slot whose turnaround buffer is free as well. Skipped without DATABASE_URL.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const d = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;
const WEEKDAYS = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 9 * 60, durationMinutes: 8 * 60 },
];

describe.skipIf(!url)('store next-available search (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenants: string[] = [];

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    if (tenants.length > 0) {
      await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.calendar_coverage WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref IN ${sql(tenants)}`;
    }
    await sql.end();
  });

  async function freshTenant(timezone = 'UTC') {
    const tenantRef = `next-${crypto.randomUUID()}`;
    tenants.push(tenantRef);
    const resource = await store.createResource({
      tenantRef,
      externalRef: `vehicle-${crypto.randomUUID()}`,
      timezone,
    });
    return { tenantRef, resourceId: resource.id };
  }

  async function book(tenantRef: string, resourceId: string, start: string, end: string) {
    const booked = await store.createExternalReservation({
      tenantRef,
      externalRef: `booking-${crypto.randomUUID()}`,
      resourceId,
      start: d(start),
      end: d(end),
      bufferAfterMs: 0,
      revision: 1,
    });
    if (!booked.ok) throw new Error(`booking fixture failed: ${booked.code}`);
  }

  const week = { start: d('2027-06-07T00:00:00Z'), end: d('2027-06-12T00:00:00Z') };

  it("answers resource_not_found for another tenant's resource, an unknown id and a malformed one", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    // B's resource booked solid for the week.
    await book(b.tenantRef, b.resourceId, '2027-06-07T00:00:00Z', '2027-06-12T00:00:00Z');
    await expect(
      store.findNextAvailableFor({
        tenantRef: b.tenantRef,
        resourceId: b.resourceId,
        rules: WEEKDAYS,
        searchWindow: week,
        durationMs: HOUR,
      }),
    ).resolves.toBeNull();
    // The audit's repro: A was offered a slot on B's fully booked resource, and on a random id.
    for (const resourceId of [b.resourceId, crypto.randomUUID(), 'not-a-uuid']) {
      await expect(
        store.findNextAvailableFor({
          tenantRef: a.tenantRef,
          resourceId,
          rules: WEEKDAYS,
          searchWindow: week,
          durationMs: HOUR,
        }),
      ).rejects.toMatchObject({ code: 'resource_not_found' });
    }
  });

  it('gives no slot where a recurring series is not stored, as free/busy says', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    // A daily 09:00-17:00 series stored for Monday only.
    const put = await store.putCalendarEvent({
      tenantRef,
      externalRef: `shift-${crypto.randomUUID()}`,
      idempotencyKey: `create-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: d('2027-06-07T09:00:00Z'),
      end: d('2027-06-07T17:00:00Z'),
      timezone: 'UTC',
      summary: 'Shift',
      recurrence: { rrule: 'FREQ=DAILY' },
      materializationWindow: { start: d('2027-06-07T00:00:00Z'), end: d('2027-06-08T00:00:00Z') },
    });
    expect(put.ok).toBe(true);
    const freeBusy = await store.getFreeBusy({ tenantRef, resourceId, window: week });
    expect(freeBusy.coverage.state).toBe('partial');
    // Before: Tuesday 09:00, time the series' unstored occurrence occupies.
    await expect(
      store.findNextAvailableFor({
        tenantRef,
        resourceId,
        rules: WEEKDAYS,
        searchWindow: week,
        durationMs: HOUR,
      }),
    ).resolves.toBeNull();
    // Inside what is stored the answer is certain: Monday is busy all day.
    await expect(
      store.findNextAvailableFor({
        tenantRef,
        resourceId,
        rules: WEEKDAYS,
        searchWindow: { start: d('2027-06-07T00:00:00Z'), end: d('2027-06-08T00:00:00Z') },
        durationMs: HOUR,
      }),
    ).resolves.toBeNull();
  });

  it('gives no slot while a required provider calendar is not read that far', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const source = 'ics:https://calendar.example.com/fleet.ics';
    const recorded = await store.recordCalendarCoverage({
      tenantRef,
      resourceId,
      source,
      window: { start: d('2027-06-07T00:00:00Z'), end: d('2027-06-09T00:00:00Z') },
      revision: 1,
    });
    expect(recorded.ok).toBe(true);
    const search = {
      tenantRef,
      resourceId,
      rules: WEEKDAYS,
      durationMs: HOUR,
      requiredSources: [source],
    };
    await expect(store.findNextAvailableFor({ ...search, searchWindow: week })).resolves.toBeNull();
    await expect(
      store.findNextAvailableFor({
        ...search,
        searchWindow: { start: d('2027-06-07T00:00:00Z'), end: d('2027-06-09T00:00:00Z') },
      }),
    ).resolves.toEqual({ start: d('2027-06-07T09:00:00Z'), end: d('2027-06-07T10:00:00Z') });
  });

  it('offers only a slot whose turnaround buffer is free too, past the bookable hours included', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const rules = [
      { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 9 * 60, durationMinutes: 4 * 60 },
    ];
    await book(tenantRef, resourceId, '2027-08-02T09:00:00Z', '2027-08-02T10:00:00Z');
    await book(tenantRef, resourceId, '2027-08-02T11:00:00Z', '2027-08-02T12:00:00Z');
    const search = {
      tenantRef,
      resourceId,
      rules,
      searchWindow: { start: d('2027-08-02T00:00:00Z'), end: d('2027-08-03T00:00:00Z') },
      durationMs: HOUR,
    };
    // Without a buffer, the hour between the bookings.
    await expect(store.findNextAvailableFor(search)).resolves.toEqual({
      start: d('2027-08-02T10:00:00Z'),
      end: d('2027-08-02T11:00:00Z'),
    });
    // The audit's repro: that slot booked with an hour's buffer overlaps the 11:00 booking.
    await expect(store.findNextAvailableFor({ ...search, bufferAfterMs: HOUR })).resolves.toEqual({
      start: d('2027-08-02T12:00:00Z'),
      end: d('2027-08-02T13:00:00Z'),
    });
    // A booking just after the hours (and after the search window) takes the last slot's buffer.
    await book(tenantRef, resourceId, '2027-08-02T13:30:00Z', '2027-08-02T14:00:00Z');
    await expect(
      store.findNextAvailableFor({ ...search, bufferAfterMs: HOUR }),
    ).resolves.toBeNull();
    const slot = await store.findNextAvailableFor({
      ...search,
      searchWindow: { start: d('2027-08-02T00:00:00Z'), end: d('2027-08-02T13:15:00Z') },
      bufferAfterMs: 15 * 60 * 1000,
    });
    expect(slot).toEqual({ start: d('2027-08-02T12:00:00Z'), end: d('2027-08-02T13:00:00Z') });
    if (!slot) return;
    // What the search offers, a booking with that buffer takes.
    const booked = await store.createExternalReservation({
      tenantRef,
      externalRef: `booking-${crypto.randomUUID()}`,
      resourceId,
      start: slot.start,
      end: slot.end,
      bufferAfterMs: 15 * 60 * 1000,
      revision: 1,
    });
    expect(booked.ok).toBe(true);
  });

  it("uses the resource's own hours when no rules are given, and none when it has none", async () => {
    const { tenantRef, resourceId } = await freshTenant('Europe/London');
    const search = { tenantRef, resourceId, searchWindow: week, durationMs: HOUR };
    await expect(store.findNextAvailableFor(search)).resolves.toBeNull();
    await store.setResourceAvailability({ tenantRef, id: resourceId, rules: WEEKDAYS });
    // 09:00 London in June is 08:00Z.
    await expect(store.findNextAvailableFor(search)).resolves.toEqual({
      start: d('2027-06-07T08:00:00Z'),
      end: d('2027-06-07T09:00:00Z'),
    });
  });

  it('searches a resource with no tenant only when asked for the tenantless namespace', async () => {
    const legacy = await store.createResource({ externalRef: `legacy-${crypto.randomUUID()}` });
    const { tenantRef } = await freshTenant();
    try {
      const search = {
        resourceId: legacy.id,
        rules: WEEKDAYS,
        searchWindow: week,
        durationMs: HOUR,
      };
      await expect(store.findNextAvailableFor({ ...search, tenantRef: null })).resolves.toEqual({
        start: d('2027-06-07T09:00:00Z'),
        end: d('2027-06-07T10:00:00Z'),
      });
      await expect(store.findNextAvailableFor({ ...search, tenantRef })).rejects.toMatchObject({
        code: 'resource_not_found',
      });
    } finally {
      await sql`DELETE FROM slotlock.resources WHERE id = ${legacy.id}`;
    }
  });
});
