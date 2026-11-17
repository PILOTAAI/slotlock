// Composite resources (RFC 0003 G8), against real Postgres as the serving role: a hall of two
// rooms, where a booking of the hall conflicts with either room, the rooms never with each other,
// and free/busy says so, all held by PostgreSQL's exclusion constraint. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, calendarEventRollingHorizon, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('composite resources (real Postgres, application role)', () => {
  const role = `slotlock_composite_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const password = randomBytes(24).toString('hex');
  const tenantRef = `composite-${randomUUID()}`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const ids: Record<string, string> = {};
  const day = new Date(Date.now() + 2 * 86_400_000);
  day.setUTCHours(0, 0, 0, 0);
  const at = (hour: number, hours = 1) => ({
    start: new Date(day.getTime() + hour * 3_600_000),
    end: new Date(day.getTime() + (hour + hours) * 3_600_000),
  });
  const hold = (resource: string, hour: number, ttlMs = 600_000) =>
    store.withTenant(tenantRef, (tenant) =>
      tenant.acquireHold({ tenantRef, resourceId: ids[resource] as string, ...at(hour), ttlMs }),
    );

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, {
      max: 4,
      onnotice: () => {},
    });
    store = createSlotlockStore(application);
    await store.withTenant(tenantRef, async (tenant) => {
      for (const ref of ['hall', 'room-a', 'room-b', 'other']) {
        ids[ref] = (await tenant.createResource({ tenantRef, externalRef: ref, timezone: 'UTC' })).id;
      }
    });
  });

  afterAll(async () => {
    await admin`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('makes rooms parts of the hall, one level deep', async () => {
    const parted = await store.withTenant(tenantRef, async (tenant) => [
      await tenant.setResourceParent({ tenantRef, id: ids['room-a'] as string, parentId: ids.hall as string }),
      await tenant.setResourceParent({ tenantRef, id: ids['room-b'] as string, parentId: ids.hall as string }),
    ]);
    expect(parted.map((room) => [room?.parentId, room?.partIndex])).toEqual([
      [ids.hall, 0],
      [ids.hall, 1],
    ]);
    // On the feed: the room's resource.updated with its parent before and after.
    const [change] = await admin<{ data: { before: { parent: string | null }; after: { parent: string | null } } }[]>`
      SELECT data FROM slotlock.outbox
       WHERE tenant_ref = ${tenantRef} AND resource_id = ${ids['room-a'] as string} AND type = 'resource.updated'
       ORDER BY id DESC LIMIT 1`;
    expect(change?.data).toMatchObject({ before: { parent: null }, after: { parent: ids.hall } });
    const refused = (id: string, parentId: string | null) =>
      store.withTenant(tenantRef, (tenant) => tenant.setResourceParent({ tenantRef, id, parentId }));
    // A part has no parts, and a parent is no part.
    await expect(refused(ids.other as string, ids['room-a'] as string)).rejects.toMatchObject({ code: 'composite_too_deep' });
    await expect(refused(ids.hall as string, ids.other as string)).rejects.toMatchObject({ code: 'composite_too_deep' });
    await expect(refused(ids.other as string, randomUUID())).rejects.toMatchObject({ code: 'parent_not_found' });
    expect(await refused(randomUUID(), ids.hall as string)).toBeNull();
  });

  it('keeps the whole and its parts apart, and never two parts', async () => {
    const roomA = await hold('room-a', 10);
    expect(roomA).toMatchObject({ ok: true });
    expect(await hold('room-b', 10)).toMatchObject({ ok: true });
    // The hall as a whole, while a room is held: refused, naming a room's booking in the way.
    const blocked = await hold('hall', 10);
    expect(blocked).toMatchObject({ ok: false, code: 'overlap', conflictingReservationId: expect.any(String) });
    expect([ids['room-a'], ids['room-b']]).toContain(
      (await admin`SELECT resource_id::text AS id FROM slotlock.reservations WHERE id = ${(blocked as { conflictingReservationId: string }).conflictingReservationId}`)[0]?.id,
    );
    expect(roomA.ok).toBe(true);
    const whole = await hold('hall', 12);
    expect(whole).toMatchObject({ ok: true });
    expect(await hold('room-a', 12)).toMatchObject({
      ok: false,
      code: 'overlap',
      conflictingReservationId: (whole as { hold: { id: string } }).hold.id,
    });
    expect(await hold('room-b', 12)).toMatchObject({ ok: false });
    // A resource outside the composite is untouched.
    expect(await hold('other', 12)).toMatchObject({ ok: true });
  });

  it("shows each part the whole's bookings, and the whole its parts'", async () => {
    const busy = async (resource: string) =>
      (
        await store.withTenant(tenantRef, (tenant) =>
          tenant.getFreeBusy({ tenantRef, resourceId: ids[resource] as string, window: { start: at(9).start, end: at(14).end } }),
        )
      ).busy.map((slot) => [slot.start.toISOString(), slot.end.toISOString()]);
    const iso = (hour: number) => [at(hour).start.toISOString(), at(hour).end.toISOString()];
    expect(await busy('room-a')).toEqual([iso(10), iso(12)]);
    expect(await busy('hall')).toEqual(expect.arrayContaining([iso(10), iso(12)]));
    expect(await busy('other')).toEqual([iso(12)]);
  });

  it('frees the whole when the parts let go, and refuses to change the composite while booked', async () => {
    await expect(
      store.withTenant(tenantRef, (tenant) => tenant.setResourceParent({ tenantRef, id: ids['room-b'] as string, parentId: null })),
    ).rejects.toMatchObject({ code: 'composite_busy' });
    // Released holds take their claims with them.
    const holds = await admin<{ id: string }[]>`
      SELECT id::text FROM slotlock.reservations WHERE resource_id IN (${ids['room-a'] as string}, ${ids['room-b'] as string})`;
    for (const { id } of holds) {
      await store.withTenant(tenantRef, (tenant) => tenant.releaseHold(id, { tenantRef }));
    }
    expect(await hold('hall', 10)).toMatchObject({ ok: true });
    // An expired hold on a part is reaped by the whole's booking, as on the resource itself.
    const short = await hold('room-a', 16, 1_000);
    expect(short).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await hold('hall', 16)).toMatchObject({ ok: true });
    // Every claim is the tenant's and no other's.
    expect(
      (await admin`SELECT count(*)::int AS n FROM slotlock.composite_claims WHERE tenant_ref <> ${tenantRef}
                    AND resource_id = ${ids.hall as string}`)[0],
    ).toEqual({ n: 0 });
  });

  it("writes a series on the whole in one pass: reaps a part's expired hold, and is refused by a live one", async () => {
    const series = (externalRef: string, hour: number) =>
      store.withTenant(tenantRef, (tenant) =>
        tenant.putCalendarEvent({
          tenantRef,
          externalRef,
          idempotencyKey: externalRef,
          expectedRevision: 0,
          resourceId: ids.hall as string,
          start: at(hour).start,
          end: at(hour).end,
          timezone: 'UTC',
          summary: externalRef,
          recurrence: { rrule: 'FREQ=DAILY;COUNT=3' },
          materializationWindow: calendarEventRollingHorizon(),
        }),
      );
    // An expired hold on a part, under the series' second occurrence: reaped, as one write's would be.
    const expired = await store.withTenant(tenantRef, (tenant) =>
      tenant.acquireHold({ tenantRef, resourceId: ids['room-b'] as string, ...at(24 + 20), ttlMs: 1_000 }),
    );
    expect(expired).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const written = await series('evening', 20);
    expect(written).toMatchObject({ ok: true, occurrenceCount: 3 });
    expect(
      (await admin`SELECT count(*)::int AS n FROM slotlock.reservations WHERE id = ${(expired as { hold: { id: string } }).hold.id}`)[0],
    ).toEqual({ n: 0 });
    expect(
      (await admin`SELECT count(*)::int AS n FROM slotlock.composite_claims claim
                     JOIN slotlock.calendar_event_occurrences occurrence ON occurrence.reservation_id = claim.reservation_id
                    WHERE claim.resource_id = ${ids.hall as string} AND claim.span = '[0,)'::int4range`)[0],
    ).toEqual({ n: 3 });
    // A live hold on a part, under a later series' third occurrence: the whole series is refused.
    const live = await hold('room-a', 48 + 22);
    expect(live).toMatchObject({ ok: true });
    expect(await series('late', 22)).toMatchObject({
      ok: false,
      code: 'overlap',
      conflictingReservationId: (live as { hold: { id: string } }).hold.id,
    });
  });
});
