// What a resource is to agents and to its tenant over its life: a private resource (a tax-deadline
// calendar, say) is invisible to agents on every read and write while its tenant's own code uses it;
// an archived one is listed nowhere and takes no new booking but keeps its history; and one is
// deleted only once nothing live is on it. Skipped without DATABASE_URL.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SlotlockAgentInvocationContext } from '../agent-server.js';
import type { SlotlockApplicationInvocationContext } from '../application-api.js';
import {
  createSlotlockStoreAgentBackend,
  createSlotlockStoreApplicationBackend,
} from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const d = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;
const ALWAYS = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1440 },
];

describe.skipIf(!url)('resource visibility, archive and delete (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenants: string[] = [];

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
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

  function freshTenant() {
    const tenantRef = `lifecycle-${crypto.randomUUID()}`;
    tenants.push(tenantRef);
    return tenantRef;
  }

  const agentContext = (tenantRef: string, operation = 'slotlock_list_resources') =>
    ({
      principal: { subject: 'agent-a', tenantRef },
      operation,
      signal: new AbortController().signal,
    }) as unknown as SlotlockAgentInvocationContext;
  const adminContext = (tenantRef: string) =>
    ({
      principal: { subject: 'admin-a', tenantRef, scopes: ['admin'] },
      operation: 'slotlock_get_resource',
      signal: new AbortController().signal,
    }) as unknown as SlotlockApplicationInvocationContext;

  describe('a private resource', () => {
    it('is stored private and hidden from agents on every read and write, not from its tenant', async () => {
      const tenantRef = freshTenant();
      const vehicle = await store.createResource({
        tenantRef,
        externalRef: 'vehicle-1',
        timezone: 'UTC',
      });
      // As Pylota creates its HMRC tax-deadline calendar.
      const hmrc = await store.createResource({
        tenantRef,
        externalRef: 'finance:hmrc-vat:abc',
        timezone: 'Europe/London',
        visibility: 'private',
      });
      expect(hmrc.visibility).toBe('private');
      expect(vehicle.visibility).toBe('shared');
      const [stored] = await sql<{ visibility: string }[]>`
        SELECT visibility FROM slotlock.resources WHERE id = ${hmrc.id}`;
      expect(stored?.visibility).toBe('private');

      const agent = createSlotlockStoreAgentBackend(store, {
        availabilityRules: async () => ALWAYS,
      });
      // The audit's repro: the agent listed ["vehicle-1", "finance:hmrc-vat:abc"].
      const listed = (await agent.listResources(agentContext(tenantRef), { limit: 10 })) as {
        resources: { external_ref: string }[];
      };
      expect(listed.resources.map((resource) => resource.external_ref)).toEqual(['vehicle-1']);
      const describeResource = agent.describeResource as NonNullable<
        typeof agent.describeResource
      >;
      await expect(describeResource(agentContext(tenantRef), hmrc.id)).resolves.toBeNull();
      const window = { start: '2027-03-01T00:00:00.000Z', end: '2027-03-08T00:00:00.000Z' };
      const notFound = { code: 'resource_not_found' };
      await expect(
        agent.getFreeBusy(agentContext(tenantRef, 'slotlock_get_free_busy'), {
          resource_ids: [hmrc.id],
          ...window,
        }),
      ).rejects.toMatchObject(notFound);
      await expect(
        agent.findNextAvailable(agentContext(tenantRef, 'slotlock_find_next_available'), {
          resource_ids: [hmrc.id],
          ...window,
          duration_minutes: 60,
        }),
      ).rejects.toMatchObject(notFound);
      await expect(
        agent.listEvents(agentContext(tenantRef, 'slotlock_list_events'), {
          resource_ids: [hmrc.id],
          ...window,
          limit: 10,
        }),
      ).rejects.toMatchObject(notFound);
      await expect(
        agent.createEvent(agentContext(tenantRef, 'slotlock_create_event'), {
          resource_id: hmrc.id,
          starts_at: '2027-03-02T09:00:00.000Z',
          ends_at: '2027-03-02T10:00:00.000Z',
          timezone: 'UTC',
          idempotency_key: `create-${crypto.randomUUID()}`,
        }),
      ).rejects.toMatchObject(notFound);

      // The tenant's own code and its admin API see it.
      await expect(store.getResource({ tenantRef, id: hmrc.id })).resolves.toMatchObject({
        visibility: 'private',
      });
      await expect(
        store.getResource({ tenantRef, id: hmrc.id, visibility: 'shared' }),
      ).resolves.toBeNull();
      await expect(store.listResources({ tenantRef, visibility: 'private' })).resolves.toEqual([
        hmrc,
      ]);
      const admin = createSlotlockStoreApplicationBackend(store);
      await expect(
        admin.getResource(adminContext(tenantRef), { resource_id: hmrc.id }),
      ).resolves.toMatchObject({ resource: { id: hmrc.id } });
    });

    it('is not reclassified by creating it again, and a bad visibility is refused', async () => {
      const tenantRef = freshTenant();
      await store.createResource({
        tenantRef,
        externalRef: 'finance:deadlines',
        timezone: 'UTC',
        visibility: 'private',
      });
      await expect(
        store.createResource({ tenantRef, externalRef: 'finance:deadlines', timezone: 'UTC' }),
      ).rejects.toMatchObject({ code: 'resource_visibility_conflict' });
      await expect(
        store.createResource({
          tenantRef,
          externalRef: 'finance:other',
          timezone: 'UTC',
          visibility: 'secret' as 'private',
        }),
      ).rejects.toMatchObject({ code: 'invalid_visibility' });
    });

    it('holds an event to the resource its writer expects, under the event lock', async () => {
      const tenantRef = freshTenant();
      const first = await store.createResource({
        tenantRef,
        externalRef: 'van-1',
        timezone: 'UTC',
      });
      const second = await store.createResource({
        tenantRef,
        externalRef: 'van-2',
        timezone: 'UTC',
      });
      const event = {
        tenantRef,
        externalRef: `handover-${crypto.randomUUID()}`,
        resourceId: first.id,
        start: d('2027-04-01T09:00:00Z'),
        end: d('2027-04-01T10:00:00Z'),
        timezone: 'UTC',
        summary: 'Handover',
      };
      const put = await store.putCalendarEvent({
        ...event,
        idempotencyKey: `create-${crypto.randomUUID()}`,
        expectedRevision: 0,
      });
      expect(put.ok).toBe(true);
      // A writer that read the event on van-2 (it has since moved) is refused, changing nothing.
      await expect(
        store.putCalendarEvent({
          ...event,
          idempotencyKey: `move-${crypto.randomUUID()}`,
          expectedRevision: 1,
          expectedResourceId: second.id,
          summary: 'Moved',
        }),
      ).resolves.toEqual({ ok: false, code: 'resource_tenant_mismatch' });
      await expect(
        store.cancelCalendarEvent({
          tenantRef,
          externalRef: event.externalRef,
          idempotencyKey: `cancel-${crypto.randomUUID()}`,
          expectedRevision: 1,
          expectedResourceId: second.id,
        }),
      ).resolves.toEqual({ ok: false, code: 'event_not_found' });
      await expect(
        store.cancelCalendarEvent({
          tenantRef,
          externalRef: event.externalRef,
          idempotencyKey: `cancel-${crypto.randomUUID()}`,
          expectedRevision: 1,
          expectedResourceId: first.id,
        }),
      ).resolves.toMatchObject({ ok: true, revision: 2 });
      await expect(
        store.putCalendarEvent({
          ...event,
          externalRef: `other-${crypto.randomUUID()}`,
          idempotencyKey: `create-${crypto.randomUUID()}`,
          expectedRevision: 0,
          expectedResourceId: 'not-a-uuid',
        }),
      ).resolves.toEqual({ ok: false, code: 'invalid_identity' });
    });
  });

  describe('an archived resource', () => {
    it('is listed nowhere, takes no new booking, keeps its history, and comes back when restored', async () => {
      const tenantRef = freshTenant();
      const van = await store.createResource({
        tenantRef,
        externalRef: 'van-archive',
        timezone: 'UTC',
      });
      const booked = await store.createExternalReservation({
        tenantRef,
        externalRef: `booking-${crypto.randomUUID()}`,
        resourceId: van.id,
        start: d('2027-05-01T09:00:00Z'),
        end: d('2027-05-01T10:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      });
      if (!booked.ok) throw new Error(booked.code);
      const hold = await store.acquireHold({
        resourceId: van.id,
        start: d('2027-05-02T09:00:00Z'),
        end: d('2027-05-02T10:00:00Z'),
        ttlMs: 60_000,
      });
      if (!hold.ok) throw new Error(hold.code);

      const archived = await store.archiveResource({ tenantRef, id: van.id });
      expect(archived?.archivedAt).toBeInstanceOf(Date);
      // Archiving again keeps the first time.
      await expect(store.archiveResource({ tenantRef, id: van.id })).resolves.toEqual(archived);
      await expect(
        store.archiveResource({ tenantRef: freshTenant(), id: van.id }),
      ).resolves.toBeNull();
      await expect(store.listResources({ tenantRef })).resolves.toEqual([]);
      await expect(store.listResources({ tenantRef, includeArchived: true })).resolves.toEqual([
        archived,
      ]);
      const agent = createSlotlockStoreAgentBackend(store, {
        availabilityRules: async () => ALWAYS,
      });
      await expect(
        agent.listResources(agentContext(tenantRef), { limit: 10 }),
      ).resolves.toMatchObject({ resources: [] });

      const window = { start: d('2027-05-03T09:00:00Z'), end: d('2027-05-03T10:00:00Z') };
      const refused = { ok: false, code: 'resource_archived' };
      await expect(
        store.createExternalReservation({
          tenantRef,
          externalRef: `booking-${crypto.randomUUID()}`,
          resourceId: van.id,
          ...window,
          bufferAfterMs: 0,
          revision: 1,
        }),
      ).resolves.toEqual(refused);
      await expect(
        store.acquireHold({ resourceId: van.id, ...window, ttlMs: 60_000 }),
      ).resolves.toEqual(refused);
      await expect(store.createReservation({ resourceId: van.id, ...window })).resolves.toEqual(
        refused,
      );
      await expect(store.confirmHold(hold.hold.id)).resolves.toEqual(refused);
      await expect(
        store.putCalendarEvent({
          tenantRef,
          externalRef: `handover-${crypto.randomUUID()}`,
          idempotencyKey: `create-${crypto.randomUUID()}`,
          expectedRevision: 0,
          resourceId: van.id,
          ...window,
          timezone: 'UTC',
          summary: 'Handover',
        }),
      ).resolves.toEqual(refused);
      await expect(
        store.rescheduleExternalReservation({
          tenantRef,
          externalRef: booked.reservation.externalRef as string,
          resourceId: van.id,
          ...window,
          bufferAfterMs: 0,
          revision: 2,
        }),
      ).resolves.toEqual(refused);

      // Its history stays, and what is on it can still be cancelled or released.
      await expect(
        store.listReservations({
          tenantRef,
          resourceId: van.id,
          window: { start: d('2027-05-01T00:00:00Z'), end: d('2027-06-01T00:00:00Z') },
        }),
      ).resolves.toEqual([booked.reservation]);
      await expect(store.releaseHold(hold.hold.id)).resolves.toEqual({ ok: true, released: true });

      const restored = await store.restoreResource({ tenantRef, id: van.id });
      expect(restored).toMatchObject({ id: van.id });
      expect(restored?.archivedAt).toBeUndefined();
      await expect(
        store.acquireHold({ resourceId: van.id, ...window, ttlMs: 60_000 }),
      ).resolves.toMatchObject({
        ok: true,
      });
    });

    it('racing archives and bookings: a booking that commits went in before the archive', async () => {
      const tenantRef = freshTenant();
      for (let round = 0; round < 10; round++) {
        const van = await store.createResource({
          tenantRef,
          externalRef: `van-race-${round}`,
          timezone: 'UTC',
        });
        const [archived, booked] = await Promise.all([
          store.archiveResource({ tenantRef, id: van.id }),
          store.createExternalReservation({
            tenantRef,
            externalRef: `booking-${crypto.randomUUID()}`,
            resourceId: van.id,
            start: d('2027-05-10T09:00:00Z'),
            end: d('2027-05-10T10:00:00Z'),
            bufferAfterMs: 0,
            revision: 1,
          }),
        ]);
        const archivedAt = archived?.archivedAt as Date;
        if (booked.ok) {
          const [row] = await sql<{ created_at: Date }[]>`
            SELECT created_at FROM slotlock.reservations WHERE id = ${booked.reservation.id}`;
          expect((row?.created_at as Date).getTime()).toBeLessThanOrEqual(archivedAt.getTime());
        } else {
          expect(booked).toEqual({ ok: false, code: 'resource_archived' });
        }
      }
    });

    it('a hold confirmed while an archive commits becomes no booking on the archived resource', async () => {
      const tenantRef = freshTenant();
      const van = await store.createResource({
        tenantRef,
        externalRef: 'van-confirm',
        timezone: 'UTC',
      });
      const hold = await store.acquireHold({
        tenantRef,
        resourceId: van.id,
        start: d('2027-05-11T09:00:00Z'),
        end: d('2027-05-11T10:00:00Z'),
        ttlMs: 600_000,
      });
      if (!hold.ok) throw new Error(hold.code);
      // The archive's row lock is held open while the confirm runs.
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked = () => {};
      const archiving = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const archive = sql.begin(async (tx) => {
        await tx`
          UPDATE slotlock.resources SET archived_at = clock_timestamp()
           WHERE id = ${van.id} AND tenant_ref = ${tenantRef}`;
        locked();
        await gate;
      });
      await archiving;
      const confirm = store.confirmHold(hold.hold.id, { tenantRef });
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await archive;
      // Without the resource's share lock the confirm read it before the archive committed, and booked.
      await expect(confirm).resolves.toEqual({ ok: false, code: 'resource_archived' });
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM slotlock.reservations WHERE id = ${hold.hold.id}`;
      expect(row?.status).toBe('held');
    });
  });

  describe('deleting a resource', () => {
    it('is refused while something live is on it, and frees its place under the cap once done', async () => {
      const tenantRef = freshTenant();
      const van = await store.createResource({
        tenantRef,
        externalRef: 'van-delete',
        timezone: 'UTC',
        maxTenantResources: 1,
      });
      const future = new Date(Date.now() + 30 * 24 * HOUR);
      const booked = await store.createExternalReservation({
        tenantRef,
        externalRef: `booking-${crypto.randomUUID()}`,
        resourceId: van.id,
        start: future,
        end: new Date(future.getTime() + HOUR),
        bufferAfterMs: 0,
        revision: 1,
      });
      if (!booked.ok) throw new Error(booked.code);
      await expect(store.deleteResource({ tenantRef, id: van.id })).resolves.toEqual({
        ok: false,
        code: 'resource_in_use',
      });
      await store.cancelExternalReservation({
        tenantRef,
        externalRef: booked.reservation.externalRef as string,
        revision: 2,
      });
      const hold = await store.acquireHold({
        resourceId: van.id,
        start: future,
        end: new Date(future.getTime() + HOUR),
        ttlMs: 60_000,
      });
      if (!hold.ok) throw new Error(hold.code);
      await expect(store.deleteResource({ tenantRef, id: van.id })).resolves.toEqual({
        ok: false,
        code: 'resource_in_use',
      });
      await store.releaseHold(hold.hold.id);
      const series = await store.putCalendarEvent({
        tenantRef,
        externalRef: `weekly-${crypto.randomUUID()}`,
        idempotencyKey: `create-${crypto.randomUUID()}`,
        expectedRevision: 0,
        resourceId: van.id,
        start: d('2026-01-05T09:00:00Z'),
        end: d('2026-01-05T10:00:00Z'),
        timezone: 'UTC',
        summary: 'Weekly',
        recurrence: { rrule: 'FREQ=WEEKLY;COUNT=2' },
        materializationWindow: { start: d('2026-01-01T00:00:00Z'), end: d('2026-02-01T00:00:00Z') },
      });
      if (!series.ok) throw new Error(series.code);
      // A series is live whatever its dates: it is a definition, not only its stored occurrences.
      await expect(store.deleteResource({ tenantRef, id: van.id })).resolves.toEqual({
        ok: false,
        code: 'resource_in_use',
      });
      await store.cancelCalendarEvent({
        tenantRef,
        externalRef: series.externalRef,
        idempotencyKey: `cancel-${crypto.randomUUID()}`,
        expectedRevision: 1,
      });
      // A booking that is over is history: it goes with the resource.
      const past = await store.createExternalReservation({
        tenantRef,
        externalRef: `booking-${crypto.randomUUID()}`,
        resourceId: van.id,
        start: d('2025-01-01T09:00:00Z'),
        end: d('2025-01-01T10:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      });
      expect(past.ok).toBe(true);
      await expect(store.deleteResource({ tenantRef, id: van.id })).resolves.toEqual({
        ok: true,
        deleted: true,
      });
      await expect(store.deleteResource({ tenantRef, id: van.id })).resolves.toEqual({
        ok: true,
        deleted: false,
      });
      await expect(store.getResource({ tenantRef, id: van.id })).resolves.toBeNull();
      // The cap of one has room again.
      await expect(
        store.createResource({
          tenantRef,
          externalRef: 'van-next',
          timezone: 'UTC',
          maxTenantResources: 1,
        }),
      ).resolves.toMatchObject({ externalRef: 'van-next' });
    });

    it('racing deletes and bookings: never a booking on a deleted resource, never a refused delete left empty', async () => {
      const tenantRef = freshTenant();
      const future = new Date(Date.now() + 40 * 24 * HOUR);
      for (let round = 0; round < 10; round++) {
        const van = await store.createResource({
          tenantRef,
          externalRef: `van-delete-race-${round}`,
          timezone: 'UTC',
        });
        const [deleted, booked] = await Promise.all([
          store.deleteResource({ tenantRef, id: van.id }),
          store.createExternalReservation({
            tenantRef,
            externalRef: `booking-${crypto.randomUUID()}`,
            resourceId: van.id,
            start: future,
            end: new Date(future.getTime() + HOUR),
            bufferAfterMs: 0,
            revision: 1,
          }),
        ]);
        if (deleted.ok && deleted.deleted) {
          expect(booked).toEqual({ ok: false, code: 'resource_tenant_mismatch' });
        } else {
          expect(deleted).toEqual({ ok: false, code: 'resource_in_use' });
          expect(booked.ok).toBe(true);
        }
      }
    });
  });
});
