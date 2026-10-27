// A tenant reaches every event on its resources, whichever key booked it: an event an agent key
// created is listed and read by id across owners, and the tenant cancels it by id without that key
// (revoked, say) and without charging the key's quota. Skipped without DATABASE_URL.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const d = (iso: string) => new Date(iso);
// An agent key's owner namespace, as the agent backend derives it from the key's subject.
const AGENT = `agent:${'a'.repeat(64)}`;
const window = { start: d('2027-03-01T00:00:00Z'), end: d('2027-03-08T00:00:00Z') };

describe.skipIf(!url)("a tenant's events across owners (real Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenants: string[] = [];

  beforeAll(async () => {
    sql = postgres(url as string, { max: 12, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    if (tenants.length > 0) {
      await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref IN ${sql(tenants)}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref IN ${sql(tenants)}`;
    }
    await sql.end();
  });

  async function freshTenant(target: SlotlockStore = store) {
    const tenantRef = `owners-${crypto.randomUUID()}`;
    tenants.push(tenantRef);
    const resource = await target.createResource({
      tenantRef,
      externalRef: `vehicle-${crypto.randomUUID()}`,
      timezone: 'UTC',
    });
    return { tenantRef, resourceId: resource.id };
  }

  async function bookEvent(
    target: SlotlockStore,
    tenantRef: string,
    resourceId: string,
    ownerRef: string | undefined,
    day: number,
  ) {
    const put = await target.putCalendarEvent({
      tenantRef,
      ...(ownerRef === undefined ? {} : { ownerRef }),
      externalRef: `event-${crypto.randomUUID()}`,
      idempotencyKey: `create-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: d(`2027-03-0${day}T09:00:00Z`),
      end: d(`2027-03-0${day}T10:00:00Z`),
      timezone: 'UTC',
      summary: 'Collection',
    });
    if (!put.ok) throw new Error(`event fixture failed: ${put.code}`);
    return put;
  }

  it("lists and reads every owner's events, and only the asked owner's without allOwners", async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const internal = await bookEvent(store, tenantRef, resourceId, undefined, 1);
    const agent = await bookEvent(store, tenantRef, resourceId, AGENT, 2);
    const other = await freshTenant();
    await bookEvent(store, other.tenantRef, other.resourceId, AGENT, 3);

    // Before: the tenant's own (internal) listing never shows what the agent key booked.
    const internalOnly = await store.listCalendarEvents({ tenantRef, resourceId, window });
    expect(internalOnly.map((event) => event.id)).toEqual([internal.eventId]);

    const all = await store.listCalendarEvents({ tenantRef, resourceId, window, allOwners: true });
    expect(all.map((event) => [event.id, event.ownerRef])).toEqual([
      [internal.eventId, 'internal'],
      [agent.eventId, AGENT],
    ]);
    // Keyset pages across owners.
    const [first] = await store.listCalendarEvents({
      tenantRef,
      resourceId,
      window,
      allOwners: true,
      limit: 1,
    });
    expect(first?.id).toBe(internal.eventId);
    const rest = await store.listCalendarEvents({
      tenantRef,
      resourceId,
      window,
      allOwners: true,
      ...(first ? { after: { start: first.start, id: first.id } } : {}),
    });
    expect(rest.map((event) => event.id)).toEqual([agent.eventId]);
    // Asking for one owner and every owner at once is a caller bug.
    await expect(
      store.listCalendarEvents({ tenantRef, resourceId, window, ownerRef: AGENT, allOwners: true }),
    ).rejects.toMatchObject({ code: 'invalid_identity' });

    const read = await store.getCalendarEventById({ tenantRef, eventId: agent.eventId });
    expect(read).toMatchObject({ id: agent.eventId, ownerRef: AGENT, revision: 1, resourceId });
    // Another tenant's event, an unknown id and a malformed one read as absent.
    await expect(
      store.getCalendarEventById({ tenantRef: other.tenantRef, eventId: agent.eventId }),
    ).resolves.toBeNull();
    await expect(
      store.getCalendarEventById({ tenantRef, eventId: crypto.randomUUID() }),
    ).resolves.toBeNull();
    await expect(
      store.getCalendarEventById({ tenantRef, eventId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'invalid_identity' });
  });

  it("cancels an agent key's event by id, frees its time, and replays a retry", async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const agent = await bookEvent(store, tenantRef, resourceId, AGENT, 2);
    const busy = { start: d('2027-03-02T00:00:00Z'), end: d('2027-03-03T00:00:00Z') };
    expect((await store.getFreeBusy({ tenantRef, resourceId, window: busy })).busy).toHaveLength(1);

    const command = {
      tenantRef,
      eventId: agent.eventId,
      idempotencyKey: `admin-cancel-${crypto.randomUUID()}`,
      expectedRevision: 1,
    };
    // A stale revision, another resource and another tenant are refused before anything changes.
    await expect(
      store.cancelCalendarEventById({ ...command, expectedRevision: 2 }),
    ).resolves.toEqual({ ok: false, code: 'revision_conflict', currentRevision: 1 });
    await expect(
      store.cancelCalendarEventById({ ...command, expectedResourceId: crypto.randomUUID() }),
    ).resolves.toEqual({ ok: false, code: 'event_not_found' });
    const other = await freshTenant();
    await expect(
      store.cancelCalendarEventById({ ...command, tenantRef: other.tenantRef }),
    ).resolves.toEqual({ ok: false, code: 'event_not_found' });
    await expect(
      store.cancelCalendarEventById({ ...command, eventId: 'not-a-uuid' }),
    ).resolves.toEqual({ ok: false, code: 'invalid_identity' });

    const cancelled = await store.cancelCalendarEventById({
      ...command,
      expectedResourceId: resourceId,
    });
    expect(cancelled).toEqual({
      ok: true,
      eventId: agent.eventId,
      externalRef: agent.externalRef,
      revision: 2,
      idempotent: false,
    });
    expect((await store.getFreeBusy({ tenantRef, resourceId, window: busy })).busy).toEqual([]);
    await expect(
      store.getCalendarEvent({ tenantRef, ownerRef: AGENT, externalRef: agent.externalRef }),
    ).resolves.toBeNull();
    // The cancellation is the agent identity's: its tombstone stops that key re-creating it.
    await expect(
      store.putCalendarEvent({
        tenantRef,
        ownerRef: AGENT,
        externalRef: agent.externalRef,
        idempotencyKey: `recreate-${crypto.randomUUID()}`,
        expectedRevision: 0,
        resourceId,
        start: d('2027-03-02T09:00:00Z'),
        end: d('2027-03-02T10:00:00Z'),
        timezone: 'UTC',
        summary: 'Collection',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'event_cancelled', currentRevision: 2 });

    // The same command again replays; the same key for another command is a conflict.
    await expect(
      store.cancelCalendarEventById({ ...command, expectedResourceId: resourceId }),
    ).resolves.toEqual({
      ...cancelled,
      idempotent: true,
    });
    await expect(
      store.cancelCalendarEventById({ ...command, expectedRevision: 2 }),
    ).resolves.toEqual({ ok: false, code: 'idempotency_conflict' });
    // A new command on the cancelled event finds nothing to cancel.
    await expect(
      store.cancelCalendarEventById({ ...command, idempotencyKey: `again-${crypto.randomUUID()}` }),
    ).resolves.toEqual({ ok: false, code: 'event_not_found' });
  });

  it("records the tenant's cancel in its own namespace, never charging the key's quota", async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const agent = await bookEvent(store, tenantRef, resourceId, AGENT, 4);
    const idempotencyKey = `admin-cancel-${crypto.randomUUID()}`;
    await expect(
      store.cancelCalendarEventById({
        tenantRef,
        eventId: agent.eventId,
        idempotencyKey,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ ok: true, revision: 2 });
    const commands = await sql<{ owner_ref: string; idempotency_key: string }[]>`
      SELECT owner_ref, idempotency_key FROM slotlock.calendar_event_commands
       WHERE tenant_ref = ${tenantRef} AND operation = 'cancel'`;
    expect(commands).toEqual([{ owner_ref: 'internal', idempotency_key: idempotencyKey }]);
    // The key's own create is its only command: its quota is as it was.
    const [own] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock.calendar_event_commands
       WHERE tenant_ref = ${tenantRef} AND owner_ref = ${AGENT}`;
    expect(own?.count).toBe(1);
  });

  it('lets exactly one of many racing cancels of one revision win, and races an owner update', async () => {
    const { tenantRef, resourceId } = await freshTenant();
    const agent = await bookEvent(store, tenantRef, resourceId, AGENT, 5);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.cancelCalendarEventById({
          tenantRef,
          eventId: agent.eventId,
          idempotencyKey: `race-${crypto.randomUUID()}`,
          expectedRevision: 1,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const result of results) {
      if (!result.ok) expect(result.code).toBe('event_not_found');
    }
    const [tombstone] = await sql<{ revision: string }[]>`
      SELECT revision FROM slotlock.calendar_event_tombstones
       WHERE tenant_ref = ${tenantRef} AND owner_ref = ${AGENT}`;
    expect(Number(tombstone?.revision)).toBe(2);

    // The tenant's cancel and the key's own update serialize on the event: one of them wins.
    const contested = await bookEvent(store, tenantRef, resourceId, AGENT, 6);
    const [cancel, update] = await Promise.all([
      store.cancelCalendarEventById({
        tenantRef,
        eventId: contested.eventId,
        idempotencyKey: `race-cancel-${crypto.randomUUID()}`,
        expectedRevision: 1,
      }),
      store.putCalendarEvent({
        tenantRef,
        ownerRef: AGENT,
        externalRef: contested.externalRef,
        idempotencyKey: `race-update-${crypto.randomUUID()}`,
        expectedRevision: 1,
        resourceId,
        start: d('2027-03-06T11:00:00Z'),
        end: d('2027-03-06T12:00:00Z'),
        timezone: 'UTC',
        summary: 'Moved',
      }),
    ]);
    expect([cancel.ok, update.ok].filter(Boolean)).toHaveLength(1);
    const live = await store.getCalendarEventById({ tenantRef, eventId: contested.eventId });
    const occupied = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock.reservations
       WHERE calendar_event_id = ${contested.eventId}`;
    if (cancel.ok) {
      expect(live).toBeNull();
      expect(occupied[0]?.count).toBe(0);
    } else {
      expect(live?.revision).toBe(2);
      expect(occupied[0]?.count).toBe(1);
    }
  });
});
