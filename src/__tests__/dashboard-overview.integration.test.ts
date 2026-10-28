// The dashboard overview's reads against real Postgres, through the adapter the server uses: a
// tenant's agenda across its resources (bookings, events' occurrences, live holds; no other
// tenant's, no expired hold) and its latest changes, newest first. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockDashboardResources } from '../dashboard.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;

describe.skipIf(!url)('the dashboard overview (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenant = `overview-${randomUUID()}`;
  const other = `overview-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 4, 3, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR);
  const week = { start: at(0), end: at(24 * 7) };

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    for (const ref of [tenant, other]) await sql`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    await sql.end();
  });

  it("lists every resource's bookings, events and live holds by start, and only the tenant's", async () => {
    const car = await store.createResource({ tenantRef: tenant, externalRef: 'car', timezone: 'UTC' });
    const van = await store.createResource({ tenantRef: tenant, externalRef: 'van', timezone: 'UTC' });
    const theirs = await store.createResource({ tenantRef: other, externalRef: 'car', timezone: 'UTC' });

    const booked = await store.createReservation({ tenantRef: tenant, resourceId: van.id, start: at(30), end: at(32), source: 'agent' });
    expect(booked.ok).toBe(true);
    const event = await store.putCalendarEvent({
      tenantRef: tenant,
      externalRef: 'handover',
      resourceId: car.id,
      expectedRevision: 0,
      idempotencyKey: 'handover-create',
      start: at(10),
      end: at(11),
      timezone: 'UTC',
      summary: 'Handover',
    });
    expect(event.ok).toBe(true);
    const held = await store.acquireHold({ tenantRef: tenant, resourceId: car.id, start: at(50), end: at(51), ttlMs: HOUR });
    expect(held.ok).toBe(true);
    const lapsed = await store.acquireHold({ tenantRef: tenant, resourceId: van.id, start: at(60), end: at(61), ttlMs: 1_000 });
    expect(lapsed.ok).toBe(true);
    await store.createReservation({ tenantRef: other, resourceId: theirs.id, start: at(12), end: at(13) });
    // A parity shadow: a confirmed row without a tenant, on the tenant's resource. Not a booking.
    await sql`
      INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at)
      VALUES (${van.id}, ${at(70)}, ${at(71)})`;
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const adapter = createSlotlockDashboardResources(store);
    const agenda = await adapter.agenda?.(tenant, week, 50);
    expect(agenda?.map(({ kind, resourceId, summary, reference }) => ({ kind, resourceId, summary, reference }))).toEqual([
      { kind: 'event', resourceId: car.id, summary: 'Handover', reference: null },
      { kind: 'booking', resourceId: van.id, summary: null, reference: booked.ok ? booked.reservation.externalRef : null },
      { kind: 'hold', resourceId: car.id, summary: null, reference: null },
    ]);
    expect(agenda?.[1]?.source).toBe('agent');
    expect(agenda?.[2]?.expiresAt).toBeInstanceOf(Date);
    expect(await adapter.agenda?.(tenant, week, 1)).toHaveLength(1);
    expect((await adapter.agenda?.(other, week, 50))?.map(({ resourceId }) => resourceId)).toEqual([theirs.id]);
  });

  it('reads the latest changes newest first, the tenant’s only', async () => {
    const adapter = createSlotlockDashboardResources(store);
    const recent = (await adapter.recentChanges?.(tenant, 100)) ?? [];
    expect(recent.length).toBeGreaterThanOrEqual(3);
    const positions = recent.map(({ id }) => Number(id.slice(4)));
    expect(positions).toEqual([...positions].sort((a, b) => b - a));
    expect(recent.map(({ type }) => type)).toContain('event.created');
    expect(await adapter.recentChanges?.(tenant, 2)).toHaveLength(2);
    const theirs = (await adapter.recentChanges?.(other, 100)) ?? [];
    expect(theirs.every(({ id }) => !recent.some((mine) => mine.id === id))).toBe(true);
    await expect(store.listRecentChanges({ tenantRef: tenant, limit: 101 })).rejects.toMatchObject({ code: 'invalid_limit' });
  });

  it("sets rules and pools, keeps webhooks, and offers an offered entry's time on when it leaves", async () => {
    const adapter = createSlotlockDashboardResources(store);
    const car = await store.createResource({ tenantRef: tenant, externalRef: `car-${randomUUID()}`, timezone: 'UTC' });
    const ruled = await adapter.setRules?.(tenant, car.id, { minNoticeMinutes: 30, checkInMinutes: 15 });
    expect(ruled?.bookingRules).toEqual({ minNoticeMinutes: 30, checkInMinutes: 15 });
    await expect(adapter.setRules?.(tenant, car.id, { slotStepMinutes: 0 })).rejects.toMatchObject({ code: 'invalid_booking_rules' });
    expect(await adapter.setRules?.(other, car.id, null)).toBeNull();
    expect((await adapter.setPool?.(tenant, car.id, 'sedans'))?.pool).toBe('sedans');
    await expect(adapter.setPool?.(tenant, car.id, 'not a pool!')).rejects.toMatchObject({ code: 'invalid_pool' });

    const created = await adapter.webhooks?.create(tenant, 'https://hooks.example.com/slotlock', ['reservation.created']);
    expect(created).toMatchObject({ ok: true, secret: expect.stringMatching(/^whsec_/) });
    const id = created?.ok ? created.endpoint.id : '';
    expect((await adapter.webhooks?.list(tenant))?.map((endpoint) => endpoint.id)).toContain(id);
    expect(await adapter.webhooks?.list(other)).toEqual([]);
    expect(await adapter.webhooks?.remove(other, id)).toBe(false);
    expect(await adapter.webhooks?.remove(tenant, id)).toBe(true);

    // Two waiting for the same free hour: the first is offered it; when it leaves, the second is.
    const join = (holderRef: string) =>
      store.withTenant(tenant, (t) => t.joinWaitlist({ tenantRef: tenant, resourceId: car.id, start: at(100), end: at(101), holderRef }));
    const first = await join('first');
    await join('second');
    await store.withTenant(tenant, (t) => t.offerWaitlist({ tenantRef: tenant }));
    const offered = (await adapter.waitlist?.list(tenant, 10)) ?? [];
    expect(offered.map(({ status }) => status)).toEqual(['offered', 'waiting']);
    expect(await adapter.waitlist?.leave(other, first.ok ? first.entry.id : '')).toBe(false);
    expect(await adapter.waitlist?.leave(tenant, first.ok ? first.entry.id : '')).toBe(true);
    expect((await adapter.waitlist?.list(tenant, 10))?.map(({ holderRef, status }) => [holderRef, status])).toEqual([
      ['second', 'offered'],
    ]);
  });
});
