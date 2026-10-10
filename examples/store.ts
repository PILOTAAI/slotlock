// Application traffic, as the non-owner NOBYPASSRLS role that `deploySlotlock` granted.
// #region connect
import { type SlotlockStore, createSlotlockStore } from 'slotlock';
import postgres from 'postgres';

export function openSlotlock(applicationUrl: string) {
  const sql = postgres(applicationUrl, { max: 10 });
  return { sql, store: createSlotlockStore(sql) };
}
// #endregion connect

// #region book
export async function bookHandover(store: SlotlockStore, tenantRef: string) {
  return store.withTenant(tenantRef, async (tenant) => {
    const vehicle = await tenant.createResource({
      tenantRef,
      externalRef: 'vehicle-42',
      timezone: 'Europe/London',
    });
    const handover = await tenant.putCalendarEvent({
      tenantRef,
      externalRef: 'handover-BK-42',
      idempotencyKey: 'booking-BK-42-create',
      expectedRevision: 0,
      resourceId: vehicle.id,
      start: new Date('2027-03-29T09:00:00Z'),
      end: new Date('2027-03-29T10:00:00Z'),
      timezone: 'Europe/London',
      summary: 'Vehicle handover',
      organizer: { email: 'fleet@example.com', name: 'Fleet Desk' },
      attendees: [{ email: 'renter@example.com', participationStatus: 'needs_action', rsvp: true }],
      reminders: [{ action: 'display', minutesBeforeStart: 30 }],
    });
    if (!handover.ok) throw new Error(`handover not booked: ${handover.code}`);

    const freeBusy = await tenant.getFreeBusy({
      tenantRef,
      resourceId: vehicle.id,
      window: { start: new Date('2027-03-29T00:00:00Z'), end: new Date('2027-03-30T00:00:00Z') },
    });
    return { vehicle, handover, freeBusy };
  });
}
// #endregion book

// #region recurring
export async function scheduleWeeklyInspection(
  store: SlotlockStore,
  tenantRef: string,
  resourceId: string,
) {
  return store.withTenant(tenantRef, (tenant) =>
    tenant.putCalendarEvent({
      tenantRef,
      externalRef: 'inspection-vehicle-42',
      idempotencyKey: 'inspection-vehicle-42-create',
      expectedRevision: 0,
      resourceId,
      start: new Date('2027-03-30T07:00:00Z'),
      end: new Date('2027-03-30T08:00:00Z'),
      timezone: 'Europe/London',
      summary: 'Weekly inspection',
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=8' },
      materializationWindow: {
        start: new Date('2027-03-30T00:00:00Z'),
        end: new Date('2027-05-30T00:00:00Z'),
      },
    }),
  );
}
// #endregion recurring
