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

// #region holds
export async function holdBookAndFollow(store: SlotlockStore, tenantRef: string, resourceId: string) {
  // Inside withTenant: outside it the application role's row-level security shows no rows.
  const booked = await store.withTenant(tenantRef, async (tenant) => {
    // Hold a window for ten minutes while the customer pays, then turn it into a booking.
    const held = await tenant.acquireHold({
      tenantRef,
      resourceId,
      start: new Date('2027-04-05T09:00:00Z'),
      end: new Date('2027-04-05T10:00:00Z'),
      ttlMs: 10 * 60_000,
    });
    if (!held.ok) throw new Error(`not held: ${held.code}`);
    const confirmed = await tenant.confirmHold(held.hold.id, { tenantRef });
    if (!confirmed.ok) throw new Error(`hold not confirmed: ${confirmed.code}`);

    // A booking your own system already has, by its reference there: revision 1 creates it.
    const imported = await tenant.createExternalReservation({
      tenantRef,
      externalRef: 'BK-43',
      resourceId,
      start: new Date('2027-04-05T11:00:00Z'),
      end: new Date('2027-04-05T12:00:00Z'),
      bufferAfterMs: 15 * 60_000,
      revision: 1,
    });
    if (!imported.ok) throw new Error(`BK-43 not booked: ${imported.code}`);
    return { booking: confirmed.reservation, imported: imported.reservation };
  });

  // What changed, oldest first, once committed: so in a withTenant of its own. Poll again with
  // `after: feed.next`.
  const feed = await store.withTenant(tenantRef, (tenant) =>
    tenant.listChanges({ tenantRef, limit: 100 }),
  );
  if (!feed.ok) throw new Error(`feed not read: ${feed.code}`);
  return { ...booked, feed };
}
// #endregion holds
