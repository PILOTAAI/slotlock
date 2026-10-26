// The application API on the real store and PostgreSQL, over REST. The connection is a superuser,
// which row-level security never filters, so every cross-tenant refusal here comes from the
// backend's own tenant checks, not from RLS; the self-host test serves it as a role RLS does filter.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer } from '../agent-server.js';
import {
  createSlotlockStoreAgentBackend,
  createSlotlockStoreApplicationBackend,
} from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim();
const BASE = 'http://localhost/slotlock';

describe.skipIf(!url)('the application API on the real store', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantA = `app-a-${randomUUID()}`;
  const tenantB = `app-b-${randomUUID()}`;
  const tenantCapped = `app-cap-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    a: { subject: 'app-a', tenantRef: tenantA, scopes: ['read', 'write', 'admin'] },
    b: { subject: 'app-b', tenantRef: tenantB, scopes: ['admin'] },
    agent: { subject: 'agent-a', tenantRef: tenantA, scopes: ['read', 'write'] },
    capped: { subject: 'app-cap', tenantRef: tenantCapped, scopes: ['admin'] },
  };

  // The capped tenant's server lets a tenant have two resources; the others', a hundred.
  const server = (maxTenantResources: number) =>
    createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] }),
      authenticate: async (request) => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
        return principals[token] ?? null;
      },
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
      application: {
        backend: createSlotlockStoreApplicationBackend(store, { maxTenantResources }),
        authorize: async ({ principal }) => principal.scopes?.includes('admin') === true,
      },
    });

  const call = async (who: string, method: string, path: string, body?: unknown) => {
    const response = await server(who === 'capped' ? 2 : 100).fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${who}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const refused = (status: number, code: string) => ({ status, body: { error: { code } } });

  const day = (offset: number, time = '00:00:00') =>
    `${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T${time}.000Z`;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => undefined });
    store = createSlotlockStore(sql);
    await store.applySchema();
    await store.applyTenantRls();
  });

  afterAll(async () => {
    for (const tenant of [tenantA, tenantB, tenantCapped]) {
      await sql`DELETE FROM slotlock.calendar_coverage WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.reservation_tombstones WHERE tenant_ref = ${tenant}`;
      await sql`
        DELETE FROM slotlock.reservations
         WHERE resource_id IN (SELECT id FROM slotlock.resources WHERE tenant_ref = ${tenant})`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenant}`;
    }
    await sql.end();
  });

  it('creates a resource once per reference, sets its hours, and shows another tenant none of it', async () => {
    const created = await call('a', 'POST', '/v1/resources', { external_ref: 'van-1', timezone: 'Europe/London' });
    expect(created).toEqual({
      status: 200,
      body: {
        resource: {
          id: expect.any(String),
          external_ref: 'van-1',
          timezone: 'Europe/London',
          availability: null,
        },
      },
    });
    const id = created.body.resource.id as string;
    // Again, with another zone: the same resource, updated.
    const again = await call('a', 'POST', '/v1/resources', { external_ref: 'van-1', timezone: 'Europe/Paris' });
    expect(again.body.resource).toMatchObject({ id, timezone: 'Europe/Paris' });
    expect((await call('a', 'POST', '/v1/resources', { external_ref: 'van-1' })).body.resource).toMatchObject({
      id,
      timezone: 'UTC',
    });
    expect(await call('a', 'POST', '/v1/resources', { external_ref: 'van-2', timezone: 'Mars/Olympus' })).toEqual(
      refused(400, 'invalid_timezone'),
    );

    const rules = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', start_minutes: 540, duration_minutes: 480 }];
    const set = await call('a', 'PUT', `/v1/resources/${id}/availability`, { rules });
    expect(set).toEqual({ status: 200, body: { resource: { ...again.body.resource, timezone: 'UTC', availability: rules } } });
    expect((await call('a', 'GET', `/v1/resources/${id}`)).body.resource.availability).toEqual(rules);
    expect(
      await call('a', 'PUT', `/v1/resources/${id}/availability`, {
        rules: [{ rrule: 'FREQ=DAILY', start_minutes: 540, duration_minutes: 60 }],
      }),
    ).toMatchObject({ status: 400, body: { error: { code: expect.stringMatching(/^invalid_/) } } });
    expect((await call('a', 'PUT', `/v1/resources/${id}/availability`, { rules: [] })).body.resource.availability).toEqual([]);
    expect((await call('a', 'PUT', '/v1/availability', { rules: null })).body).toEqual({ resources_updated: 1 });
    expect((await call('a', 'GET', `/v1/resources/${id}`)).body.resource.availability).toBeNull();

    // Tenant B sees nothing of A's resource and cannot change it, by id or with an id that is no id.
    expect(await call('b', 'GET', `/v1/resources/${id}`)).toEqual(refused(404, 'resource_not_found'));
    expect(await call('b', 'PUT', `/v1/resources/${id}/availability`, { rules })).toEqual(
      refused(404, 'resource_not_found'),
    );
    expect(await call('b', 'GET', '/v1/resources/not-a-uuid')).toEqual(refused(404, 'resource_not_found'));
    expect((await call('b', 'PUT', '/v1/availability', { rules })).body).toEqual({ resources_updated: 0 });
    expect((await call('a', 'GET', `/v1/resources/${id}`)).body.resource.availability).toBeNull();
    // B's resource with A's reference is B's own.
    const theirs = await call('b', 'POST', '/v1/resources', { external_ref: 'van-1' });
    expect(theirs.body.resource.id).not.toBe(id);

    // The agent key of tenant A has no admin scope.
    expect(await call('agent', 'GET', `/v1/resources/${id}`)).toEqual(refused(403, 'forbidden'));
    expect(await call('agent', 'POST', '/v1/resources', { external_ref: 'van-9' })).toEqual(refused(403, 'forbidden'));
  });

  it('caps the resources a tenant creates, and still updates one it has', async () => {
    expect((await call('capped', 'POST', '/v1/resources', { external_ref: 'one' })).status).toBe(200);
    expect((await call('capped', 'POST', '/v1/resources', { external_ref: 'two' })).status).toBe(200);
    expect(await call('capped', 'POST', '/v1/resources', { external_ref: 'three' })).toEqual(
      refused(409, 'resource_limit_reached'),
    );
    const updated = await call('capped', 'POST', '/v1/resources', { external_ref: 'two', timezone: 'Asia/Tokyo' });
    expect(updated).toMatchObject({ status: 200, body: { resource: { external_ref: 'two', timezone: 'Asia/Tokyo' } } });
  });

  it('holds, confirms and releases time in one tenant only', async () => {
    const resource = (await call('a', 'POST', '/v1/resources', { external_ref: 'hold-van' })).body.resource;
    const window = { resource_id: resource.id, start: day(10, '09:00:00'), end: day(10, '10:00:00') };
    const held = await call('a', 'POST', '/v1/holds', { ...window, ttl_seconds: 600, source: 'checkout' });
    expect(held).toEqual({
      status: 200,
      body: {
        hold: {
          id: expect.any(String),
          resource_id: resource.id,
          start: window.start,
          end: window.end,
          expires_at: expect.any(String),
          source: 'checkout',
        },
      },
    });
    const expiresIn = Date.parse(held.body.hold.expires_at) - Date.now();
    expect(expiresIn).toBeGreaterThan(590_000);
    expect(expiresIn).toBeLessThan(610_000);
    const holdId = held.body.hold.id as string;

    // The window is taken, for another hold and for a reservation.
    expect(await call('a', 'POST', '/v1/holds', { ...window, ttl_seconds: 60 })).toEqual(refused(409, 'overlap'));
    expect(
      await call('a', 'PUT', '/v1/reservations/booking-over-hold', { ...window, revision: 1 }),
    ).toEqual(refused(409, 'overlap'));

    // Tenant B can neither hold on A's resource nor confirm or release A's hold.
    expect(await call('b', 'POST', '/v1/holds', { ...window, ttl_seconds: 60 })).toEqual(
      refused(404, 'resource_not_found'),
    );
    expect(await call('b', 'POST', `/v1/holds/${holdId}/confirm`, {})).toEqual(refused(404, 'hold_not_found'));
    expect(await call('b', 'DELETE', `/v1/holds/${holdId}`)).toEqual({ status: 200, body: { released: false } });
    expect(await call('a', 'POST', '/v1/holds', { ...window, ttl_seconds: 60 })).toEqual(refused(409, 'overlap'));

    const confirmed = await call('a', 'POST', `/v1/holds/${holdId}/confirm`, {});
    expect(confirmed).toEqual({
      status: 200,
      body: {
        reservation: {
          id: holdId,
          resource_id: resource.id,
          // A confirmed hold is a booking whose reference is its own id.
          reservation_ref: holdId,
          start: window.start,
          end: window.end,
          buffer_after_minutes: 0,
          revision: 1,
          source: 'checkout',
        },
      },
    });
    // A retried confirm answers the same reservation; a confirmed hold is no longer released.
    expect(await call('a', 'POST', `/v1/holds/${holdId}/confirm`, {})).toEqual(confirmed);
    expect(await call('b', 'POST', `/v1/holds/${holdId}/confirm`, {})).toEqual(refused(404, 'hold_not_found'));
    expect(await call('a', 'DELETE', `/v1/holds/${holdId}`)).toEqual({ status: 200, body: { released: false } });
    // It is cancelled by that reference like any booking, after which its window books again.
    expect(await call('a', 'DELETE', `/v1/reservations/${holdId}?revision=2`)).toEqual({
      status: 200,
      body: { cancelled: true, revision: 2 },
    });
    expect(
      (await call('a', 'PUT', `/v1/reservations/after-hold-${randomUUID()}`, { ...window, revision: 1 }))
        .status,
    ).toBe(200);

    // Release frees the window at once; releasing again, or an id that is no hold, changes nothing.
    const later = { ...window, start: day(11, '09:00:00'), end: day(11, '10:00:00') };
    const second = (await call('a', 'POST', '/v1/holds', { ...later, ttl_seconds: 600 })).body.hold.id as string;
    expect(await call('a', 'DELETE', `/v1/holds/${second}`)).toEqual({ status: 200, body: { released: true } });
    expect(await call('a', 'DELETE', `/v1/holds/${second}`)).toEqual({ status: 200, body: { released: false } });
    expect(await call('a', 'DELETE', '/v1/holds/not-a-hold')).toEqual({ status: 200, body: { released: false } });
    expect(await call('a', 'POST', '/v1/holds/not-a-hold/confirm', {})).toEqual(refused(404, 'hold_not_found'));
    expect((await call('a', 'POST', '/v1/holds', { ...later, ttl_seconds: 600 })).status).toBe(200);

    // An expired hold (by the database's clock) is not confirmed, and no longer blocks.
    const third = { ...window, start: day(12, '09:00:00'), end: day(12, '10:00:00') };
    const expiring = (await call('a', 'POST', '/v1/holds', { ...third, ttl_seconds: 600 })).body.hold.id as string;
    await sql`UPDATE slotlock.reservations SET expires_at = now() - interval '1 second' WHERE id = ${expiring}`;
    expect(await call('a', 'POST', `/v1/holds/${expiring}/confirm`, {})).toEqual(refused(409, 'hold_expired'));
    expect((await call('a', 'POST', '/v1/holds', { ...third, ttl_seconds: 60 })).status).toBe(200);
  });

  it('books, replays, moves and cancels a reservation by its reference and revision', async () => {
    const resource = (await call('a', 'POST', '/v1/resources', { external_ref: 'booking-van' })).body.resource;
    const ref = `BK-${randomUUID()}`;
    const path = `/v1/reservations/${encodeURIComponent(ref)}`;
    const booking = {
      resource_id: resource.id,
      start: day(20, '09:00:00'),
      end: day(22, '09:00:00'),
      buffer_after_minutes: 60,
      revision: 1,
      source: 'booking-site',
    };
    const created = await call('a', 'PUT', path, booking);
    expect(created).toEqual({
      status: 200,
      body: {
        reservation: {
          id: expect.any(String),
          resource_id: resource.id,
          reservation_ref: ref,
          start: booking.start,
          end: booking.end,
          buffer_after_minutes: 60,
          revision: 1,
          source: 'booking-site',
        },
        replayed: false,
      },
    });
    expect(await call('a', 'PUT', path, booking)).toEqual({ status: 200, body: { ...created.body, replayed: true } });
    // A reservation is not a hold: neither confirmed again as one nor released.
    const reservationId = created.body.reservation.id as string;
    expect(await call('a', 'POST', `/v1/holds/${reservationId}/confirm`, {})).toEqual(refused(404, 'hold_not_found'));
    expect(await call('a', 'DELETE', `/v1/holds/${reservationId}`)).toEqual({ status: 200, body: { released: false } });
    // The buffer keeps the hour after it busy.
    expect(
      await call('a', 'POST', '/v1/holds', {
        resource_id: resource.id,
        start: day(22, '09:30:00'),
        end: day(22, '10:30:00'),
        ttl_seconds: 60,
      }),
    ).toEqual(refused(409, 'overlap'));
    // Another reference over it overlaps; the same reference at a different revision-1 payload conflicts.
    expect(await call('a', 'PUT', `/v1/reservations/other-${randomUUID()}`, booking)).toEqual(refused(409, 'overlap'));
    expect((await call('a', 'PUT', path, { ...booking, end: day(23, '09:00:00') })).status).toBe(409);

    // Tenant B cannot book on A's resource, and its own reference with the same text is its own.
    expect(await call('b', 'PUT', path, booking)).toEqual(refused(404, 'resource_not_found'));

    const moved = await call('a', 'PUT', path, { ...booking, start: day(24, '09:00:00'), end: day(25, '09:00:00'), revision: 2 });
    expect(moved.body).toMatchObject({ reservation: { start: day(24, '09:00:00'), revision: 2 }, replayed: false });
    expect(await call('a', 'PUT', path, { ...booking, revision: 2 })).toMatchObject({ status: 409 });
    expect(await call('a', 'PUT', path, { ...booking, revision: 9 })).toMatchObject({ status: 409 });
    // The old window is free again.
    expect(
      (await call('a', 'POST', '/v1/holds', { resource_id: resource.id, start: booking.start, end: booking.end, ttl_seconds: 60 }))
        .status,
    ).toBe(200);

    expect(await call('a', 'DELETE', `${path}?revision=3`)).toEqual({ status: 200, body: { cancelled: true, revision: 3 } });
    expect(await call('a', 'DELETE', `${path}?revision=4`)).toMatchObject({ status: 409 });
    // The tombstone keeps a delayed booking from bringing it back.
    expect(await call('a', 'PUT', path, booking)).toMatchObject({ status: 409 });
    // A reference that never booked can be cancelled ahead of a booking that arrives late.
    const early = `/v1/reservations/never-${randomUUID()}`;
    expect(await call('a', 'DELETE', `${early}?revision=2`)).toEqual({ status: 200, body: { cancelled: false, revision: 2 } });
    expect(await call('a', 'PUT', early, { ...booking, start: day(30, '09:00:00'), end: day(30, '10:00:00') })).toMatchObject({
      status: 409,
    });
  });

  it('records calendar coverage forward only, on the tenant\'s own resources', async () => {
    const resource = (await call('a', 'POST', '/v1/resources', { external_ref: 'coverage-van' })).body.resource;
    const source = 'ics:https://calendar.example.com/fleet.ics';
    const path = `/v1/resources/${resource.id}/coverage/${encodeURIComponent(source)}`;
    const window = { start: day(0), end: day(90) };
    expect(await call('a', 'PUT', path, { ...window, revision: 1 })).toEqual({
      status: 200,
      body: { revision: 1, replayed: false },
    });
    expect(await call('a', 'PUT', path, { ...window, revision: 1 })).toEqual({
      status: 200,
      body: { revision: 1, replayed: true },
    });
    expect((await call('a', 'PUT', path, { ...window, revision: 2 })).body).toEqual({ revision: 2, replayed: false });
    expect(await call('a', 'PUT', path, { ...window, revision: 1 })).toMatchObject({ status: 409 });
    expect(await call('b', 'PUT', path, { ...window, revision: 3 })).toEqual(refused(404, 'resource_not_found'));
    const [row] = await sql<{ tenant_ref: string; revision: string }[]>`
      SELECT tenant_ref, revision::text FROM slotlock.calendar_coverage
       WHERE resource_id = ${resource.id} AND source = ${source}`;
    expect(row).toEqual({ tenant_ref: tenantA, revision: '2' });
  });

  it("runs maintenance for the caller's tenant", async () => {
    expect(await call('a', 'POST', '/v1/maintenance', {})).toEqual({
      status: 200,
      body: { extended: 0, conflicts: 0, refused: 0, pruned: 0, capped: false },
    });
    expect(await call('agent', 'POST', '/v1/maintenance', {})).toEqual(refused(403, 'forbidden'));
  });
});
