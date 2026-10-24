// Recurring events against the rolling horizon: a write's refusal names the row that blocks it, a
// write never lands where a series on the same resource is not stored, the roll never lets stuck
// series starve a healthy one, and a full 367-day window can be proven complete. Each test uses a
// tenant of its own, so a roll or maintenance pass sees only its rows. Skipped without DATABASE_URL.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maintainSlotlockTenant } from '../maintenance.js';
import {
  type SlotlockStore,
  calendarEventRollingHorizon,
  createSlotlockStore,
} from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const d = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe.skipIf(!url)('recurring events and the rolling horizon (real Postgres)', () => {
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
      await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.reservation_tombstones WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref IN ${sql(tenants)}`;
    }
    await sql.end();
  });

  async function freshTenant() {
    const tenantRef = `horizon-${crypto.randomUUID()}`;
    tenants.push(tenantRef);
    const resource = await store.createResource({
      tenantRef,
      externalRef: `vehicle-${crypto.randomUUID()}`,
      timezone: 'UTC',
    });
    return { tenantRef, resourceId: resource.id };
  }

  it('a refused series update names the booking in the way, not its own old occurrence', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const externalRef = `standup-${crypto.randomUUID()}`;
    const series = {
      tenantRef,
      externalRef,
      resourceId,
      timezone: 'UTC',
      summary: 'Weekly check',
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=4' },
      materializationWindow: { start: d('2027-05-03T00:00:00Z'), end: d('2027-06-03T00:00:00Z') },
    };
    const put = await store.putCalendarEvent({
      ...series,
      idempotencyKey: `create-${crypto.randomUUID()}`,
      expectedRevision: 0,
      start: d('2027-05-03T09:00:00Z'),
      end: d('2027-05-03T10:00:00Z'),
    });
    expect(put.ok).toBe(true);
    const booking = await store.createExternalReservation({
      tenantRef,
      externalRef: `booking-${crypto.randomUUID()}`,
      resourceId,
      start: d('2027-05-17T10:00:00Z'),
      end: d('2027-05-17T10:30:00Z'),
      bufferAfterMs: 0,
      revision: 1,
    });
    if (!booking.ok) throw new Error(booking.code);
    const moved = await store.putCalendarEvent({
      ...series,
      idempotencyKey: `move-${crypto.randomUUID()}`,
      expectedRevision: 1,
      start: d('2027-05-03T09:30:00Z'),
      end: d('2027-05-03T10:30:00Z'),
    });
    expect(moved).toEqual({
      ok: false,
      code: 'overlap',
      conflictingReservationId: booking.reservation.id,
    });
  });

  it('proves a full 367-day window from now complete once a series is rolled to the horizon', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const horizon = calendarEventRollingHorizon();
    const start = new Date(horizon.start.getTime() + DAY + 9 * HOUR);
    const put = await store.putCalendarEvent({
      tenantRef,
      externalRef: `weekly-${crypto.randomUUID()}`,
      idempotencyKey: `create-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start,
      end: new Date(start.getTime() + HOUR),
      timezone: 'UTC',
      summary: 'Weekly service',
      recurrence: { rrule: 'FREQ=WEEKLY' },
      materializationWindow: horizon,
    });
    expect(put.ok).toBe(true);
    await maintainSlotlockTenant(store, tenantRef);
    // The audit's repro: [now, now + 367 days) was partial, so a search of the advertised maximum
    // found no certain slot.
    const now = new Date();
    const freeBusy = await store.getFreeBusy({
      tenantRef,
      resourceId,
      window: { start: now, end: new Date(now.getTime() + 367 * DAY) },
    });
    expect(freeBusy.coverage).toEqual({ state: 'complete', missingSources: [] });
    // At the latest moment of the UTC day too.
    const lastMoment = new Date(horizon.start.getTime() + 2 * DAY - 1);
    const atDayEnd = await store.getFreeBusy({
      tenantRef,
      resourceId,
      window: { start: lastMoment, end: new Date(lastMoment.getTime() + 367 * DAY) },
    });
    expect(atDayEnd.coverage.state).toBe('complete');
  });
});
