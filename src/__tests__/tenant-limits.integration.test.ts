// Per-tenant limits bound what one tenant can store on a shared database: live holds, bookings
// (with the cancellations that retire their references), calendar events (with the agent
// cancellations that count against them), provider coverage and resources. A write that would pass
// a limit is refused with the limit, racing writers included; what the tenant already has can still
// be revised, cancelled and released; and other tenants are unaffected. Skipped without DATABASE_URL.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, type SlotlockTenantLimits, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const d = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;
const AGENT = `agent:${'b'.repeat(64)}`;
// The nth hour of a day well inside the rolling horizon.
const slot = (n: number) => ({
  start: new Date(Date.UTC(2027, 1, 1, 0) + n * HOUR),
  end: new Date(Date.UTC(2027, 1, 1, 0) + (n + 1) * HOUR),
});

describe.skipIf(!url)('per-tenant limits (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  const tenants: string[] = [];

  beforeAll(async () => {
    sql = postgres(url as string, { max: 16, onnotice: () => {} });
    await createSlotlockStore(sql).applySchema();
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

  async function freshTenant(store: SlotlockStore) {
    const tenantRef = `limits-${crypto.randomUUID()}`;
    tenants.push(tenantRef);
    const resource = await store.createResource({
      tenantRef,
      externalRef: `vehicle-${crypto.randomUUID()}`,
      timezone: 'UTC',
    });
    return { tenantRef, resourceId: resource.id };
  }

  const limited = (tenantLimits: SlotlockTenantLimits) =>
    createSlotlockStore(sql, { tenantLimits });

  it('refuses limits that are not whole numbers from 1 to 10,000,000', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, 10_000_001]) {
      expect(() => limited({ holds: bad })).toThrow(
        expect.objectContaining({ code: 'invalid_tenant_limits' }),
      );
    }
    expect(() => limited({ holds: 1, reservations: 10_000_000 })).not.toThrow();
  });

  it('caps live holds; expired and released ones do not count, and replays still answer', async () => {
    const store = limited({ holds: 2 });
    const { tenantRef, resourceId } = await freshTenant(store);
    const hold = (n: number, extra: { ttlMs?: number; key?: string } = {}) =>
      store.acquireHold({
        tenantRef,
        resourceId,
        ...slot(n),
        ttlMs: extra.ttlMs ?? 60_000,
        ...(extra.key ? { idempotencyKey: extra.key, principalRef: 'key-1' } : {}),
      });
    const first = await hold(0, { key: 'first' });
    expect(first.ok).toBe(true);
    expect((await hold(1, { ttlMs: 50 })).ok).toBe(true);
    await expect(hold(2)).resolves.toEqual({ ok: false, code: 'hold_limit_reached', limit: 2 });
    // A retried request answers its hold at the limit too.
    await expect(hold(0, { key: 'first' })).resolves.toMatchObject({ ok: true, idempotent: true });
    // Another tenant has its own limit.
    const other = await freshTenant(store);
    await expect(
      store.acquireHold({
        tenantRef: other.tenantRef,
        resourceId: other.resourceId,
        ...slot(0),
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ ok: true });
    // The short hold expires: its place is free again.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await hold(3)).ok).toBe(true);
    await expect(hold(4)).resolves.toEqual({ ok: false, code: 'hold_limit_reached', limit: 2 });
    if (!first.ok) return;
    await store.releaseHold(first.hold.id, { tenantRef });
    expect((await hold(5)).ok).toBe(true);
  });

  it('caps bookings with their cancellations, on every path that adds one', async () => {
    const store = limited({ reservations: 2, holds: 10 });
    const { tenantRef, resourceId } = await freshTenant(store);
    const book = (n: number, externalRef = `booking-${crypto.randomUUID()}`) =>
      store.createExternalReservation({
        tenantRef,
        externalRef,
        resourceId,
        ...slot(n),
        bufferAfterMs: 0,
        revision: 1,
      });
    const kept = `booking-${crypto.randomUUID()}`;
    expect((await book(0, kept)).ok).toBe(true);
    expect((await store.createReservation({ tenantRef, resourceId, ...slot(1) })).ok).toBe(true);
    await expect(book(2)).resolves.toEqual({
      ok: false,
      code: 'reservation_limit_reached',
      limit: 2,
    });
    await expect(store.createReservation({ tenantRef, resourceId, ...slot(3) })).resolves.toEqual({
      ok: false,
      code: 'reservation_limit_reached',
      limit: 2,
    });
    const hold = await store.acquireHold({ tenantRef, resourceId, ...slot(4), ttlMs: 60_000 });
    if (!hold.ok) throw new Error(hold.code);
    await expect(store.confirmHold(hold.hold.id, { tenantRef })).resolves.toEqual({
      ok: false,
      code: 'reservation_limit_reached',
      limit: 2,
    });
    // A retired reference no booking held is a row too.
    await expect(
      store.cancelExternalReservation({
        tenantRef,
        externalRef: `never-${crypto.randomUUID()}`,
        revision: 1,
      }),
    ).resolves.toEqual({ ok: false, code: 'reservation_limit_reached', limit: 2 });
    // What the tenant has can still be moved, replayed and cancelled at the limit.
    await expect(book(0, kept)).resolves.toMatchObject({ ok: true, idempotent: true });
    await expect(
      store.rescheduleExternalReservation({
        tenantRef,
        externalRef: kept,
        resourceId,
        ...slot(5),
        bufferAfterMs: 0,
        revision: 2,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      store.cancelExternalReservation({ tenantRef, externalRef: kept, revision: 3 }),
    ).resolves.toEqual({ ok: true, cancelled: true, revision: 3 });
    // Its tombstone still counts until maintenance prunes it.
    await expect(book(6)).resolves.toEqual({
      ok: false,
      code: 'reservation_limit_reached',
      limit: 2,
    });
  });

  it('caps events of every owner with agent cancellations; the tenant’s own cancellations free a place', async () => {
    const store = limited({ events: 2 });
    const { tenantRef, resourceId } = await freshTenant(store);
    const put = (n: number, ownerRef?: string, externalRef = `event-${crypto.randomUUID()}`) =>
      store.putCalendarEvent({
        tenantRef,
        ...(ownerRef ? { ownerRef } : {}),
        externalRef,
        idempotencyKey: `put-${crypto.randomUUID()}`,
        expectedRevision: 0,
        resourceId,
        ...slot(n),
        timezone: 'UTC',
        summary: 'Collection',
      });
    const internal = await put(0);
    const agent = await put(1, AGENT);
    if (!internal.ok || !agent.ok) throw new Error('event fixtures failed');
    await expect(put(2, AGENT)).resolves.toEqual({
      ok: false,
      code: 'event_limit_reached',
      limit: 2,
    });
    await expect(put(2)).resolves.toEqual({ ok: false, code: 'event_limit_reached', limit: 2 });
    // A revision adds no event.
    await expect(
      store.putCalendarEvent({
        tenantRef,
        externalRef: internal.externalRef,
        idempotencyKey: `move-${crypto.randomUUID()}`,
        expectedRevision: 1,
        resourceId,
        ...slot(3),
        timezone: 'UTC',
        summary: 'Collection',
      }),
    ).resolves.toMatchObject({ ok: true, revision: 2 });
    // An agent's cancellation is still one of its identities: no place is freed.
    await expect(
      store.cancelCalendarEvent({
        tenantRef,
        ownerRef: AGENT,
        externalRef: agent.externalRef,
        idempotencyKey: `cancel-${crypto.randomUUID()}`,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(put(4, AGENT)).resolves.toEqual({
      ok: false,
      code: 'event_limit_reached',
      limit: 2,
    });
    // The tenant's own (provider) cancellation keeps no counted row.
    await expect(
      store.cancelCalendarEvent({
        tenantRef,
        externalRef: internal.externalRef,
        idempotencyKey: `cancel-${crypto.randomUUID()}`,
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(put(5)).resolves.toMatchObject({ ok: true });
  });

  it('caps provider coverage rows, and still advances one it has', async () => {
    const store = limited({ coverage: 1 });
    const { tenantRef, resourceId } = await freshTenant(store);
    const record = (source: string, revision: number) =>
      store.recordCalendarCoverage({
        tenantRef,
        resourceId,
        source,
        window: { start: d('2027-02-01T00:00:00Z'), end: d('2027-02-08T00:00:00Z') },
        revision,
      });
    expect((await record('ics:a', 1)).ok).toBe(true);
    await expect(record('ics:b', 1)).resolves.toEqual({
      ok: false,
      code: 'coverage_limit_reached',
      limit: 1,
    });
    await expect(record('ics:a', 2)).resolves.toMatchObject({ ok: true, revision: 2 });
  });

  it('caps resources at the lower of the store limit and the caller’s, re-creating one at the cap', async () => {
    const store = limited({ resources: 2 });
    const { tenantRef } = await freshTenant(store);
    await store.createResource({ tenantRef, externalRef: 'second', maxTenantResources: 10 });
    await expect(
      store.createResource({ tenantRef, externalRef: 'third', maxTenantResources: 10 }),
    ).rejects.toMatchObject({ code: 'resource_limit_reached', limit: 2 });
    await expect(store.createResource({ tenantRef, externalRef: 'third' })).rejects.toMatchObject({
      code: 'resource_limit_reached',
      limit: 2,
    });
    // The caller's own lower cap still holds.
    await expect(
      store.createResource({ tenantRef, externalRef: 'third', maxTenantResources: 1 }),
    ).rejects.toMatchObject({ code: 'resource_limit_reached', limit: 1 });
    await expect(store.createResource({ tenantRef, externalRef: 'second' })).resolves.toMatchObject(
      {
        externalRef: 'second',
      },
    );
    // A resource with no tenant is not a tenant's.
    const legacy = await store.createResource({ externalRef: `legacy-${crypto.randomUUID()}` });
    await sql`DELETE FROM slotlock.resources WHERE id = ${legacy.id}`;
  });

  it('holds the limits inside withTenant too', async () => {
    const store = limited({ holds: 1 });
    const { tenantRef, resourceId } = await freshTenant(store);
    const result = await store.withTenant(tenantRef, async (tenant) => {
      await tenant.acquireHold({ tenantRef, resourceId, ...slot(0), ttlMs: 60_000 });
      return tenant.acquireHold({ tenantRef, resourceId, ...slot(1), ttlMs: 60_000 });
    });
    expect(result).toEqual({ ok: false, code: 'hold_limit_reached', limit: 1 });
  });

  it('admits exactly the limit when many writers race for the last places', async () => {
    const store = limited({ holds: 5, reservations: 5, events: 3 });
    const { tenantRef, resourceId } = await freshTenant(store);
    const holds = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        store.acquireHold({ tenantRef, resourceId, ...slot(n), ttlMs: 60_000 }),
      ),
    );
    expect(holds.filter((result) => result.ok)).toHaveLength(5);
    expect(
      holds.filter((result) => !result.ok && result.code === 'hold_limit_reached'),
    ).toHaveLength(7);

    const bookings = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        store.createExternalReservation({
          tenantRef,
          externalRef: `race-${n}`,
          resourceId,
          ...slot(20 + n),
          bufferAfterMs: 0,
          revision: 1,
        }),
      ),
    );
    expect(bookings.filter((result) => result.ok)).toHaveLength(5);
    expect(
      bookings.filter((result) => !result.ok && result.code === 'reservation_limit_reached'),
    ).toHaveLength(7);

    const events = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        store.putCalendarEvent({
          tenantRef,
          ownerRef: n % 2 === 0 ? AGENT : 'internal',
          externalRef: `race-event-${n}`,
          idempotencyKey: `race-put-${n}`,
          expectedRevision: 0,
          resourceId,
          ...slot(40 + n),
          timezone: 'UTC',
          summary: 'Collection',
        }),
      ),
    );
    expect(events.filter((result) => result.ok)).toHaveLength(3);
    expect(
      events.filter((result) => !result.ok && result.code === 'event_limit_reached'),
    ).toHaveLength(7);
    const [counted] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef}`;
    expect(counted?.count).toBe(3);
  });
});
