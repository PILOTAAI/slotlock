// The application API on the real store and PostgreSQL, over REST. The connection is a superuser,
// which row-level security never filters, so every cross-tenant refusal here comes from the
// backend's own tenant checks, not from RLS; the self-host test serves it as a role RLS does filter.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  const tenantErased = `app-erase-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    a: { subject: 'app-a', tenantRef: tenantA, scopes: ['read', 'write', 'admin'] },
    b: { subject: 'app-b', tenantRef: tenantB, scopes: ['admin'] },
    agent: { subject: 'agent-a', tenantRef: tenantA, scopes: ['read', 'write'] },
    capped: { subject: 'app-cap', tenantRef: tenantCapped, scopes: ['admin'] },
    erased: { subject: 'app-erase', tenantRef: tenantErased, scopes: ['admin'] },
    erasedAgent: { subject: 'agent-erase', tenantRef: tenantErased, scopes: ['read', 'write'] },
  };

  // The capped tenant's server lets a tenant have two resources; the others', a hundred.
  const server = (maxTenantResources: number, tenantErasure = false) =>
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
        backend: createSlotlockStoreApplicationBackend(store, { maxTenantResources, tenantErasure }),
        authorize: async ({ principal }) => principal.scopes?.includes('admin') === true,
      },
    });

  const call = async (
    who: string,
    method: string,
    path: string,
    body?: unknown,
    options: { headers?: Record<string, string>; tenantErasure?: boolean } = {},
  ) => {
    const response = await server(who === 'capped' ? 2 : 100, options.tenantErasure).fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${who}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...options.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  // RFC 9457 problem details, which still carry `error.code`.
  const refused = (status: number, code: string) => ({
    status,
    body: expect.objectContaining({ status, code, error: { code } }),
  });

  const day = (offset: number, time = '00:00:00') =>
    `${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T${time}.000Z`;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => undefined });
    store = createSlotlockStore(sql);
    await store.applySchema();
    await store.applyTenantRls();
  });

  afterAll(async () => {
    for (const tenant of [tenantA, tenantB, tenantCapped, tenantErased]) {
      await sql`DELETE FROM slotlock.tenant_suspensions WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${tenant}`;
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
          booking_rules: null,
          visibility: 'shared',
          archived_at: null,
          pool: null,
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

  it('holds time with a buffer after it, which stays busy until the hold ends', async () => {
    const resource = (await call('a', 'POST', '/v1/resources', { external_ref: 'buffered-hold-van' })).body.resource;
    const window = { resource_id: resource.id, start: day(13, '09:00:00'), end: day(13, '10:00:00') };
    const held = await call('a', 'POST', '/v1/holds', { ...window, ttl_seconds: 600, buffer_after_minutes: 30 });
    expect(held).toMatchObject({ status: 200, body: { hold: { start: window.start, end: window.end } } });
    // The half hour after it is taken; the time after that is not.
    const inBuffer = { ...window, start: day(13, '10:15:00'), end: day(13, '11:00:00') };
    expect(await call('a', 'POST', '/v1/holds', { ...inBuffer, ttl_seconds: 60 })).toEqual(refused(409, 'overlap'));
    expect(await call('a', 'PUT', `/v1/reservations/in-buffer-${randomUUID()}`, { ...inBuffer, revision: 1 })).toEqual(
      refused(409, 'overlap'),
    );
    const busy = await call(
      'a',
      'GET',
      `/v1/resources/${resource.id}/busy?start=${encodeURIComponent(day(13))}&end=${encodeURIComponent(day(14))}`,
    );
    expect(busy.body).toEqual({ busy: [{ start: window.start, end: day(13, '10:30:00') }] });
    expect(
      (await call('a', 'POST', '/v1/holds', { ...window, start: day(13, '10:30:00'), end: day(13, '11:00:00'), ttl_seconds: 60 }))
        .status,
    ).toBe(200);
    // Confirmed, the hold is a booking with the same buffer.
    expect((await call('a', 'POST', `/v1/holds/${held.body.hold.id}/confirm`, {})).body.reservation).toMatchObject({
      end: window.end,
      buffer_after_minutes: 30,
    });
    // Bounded as a reservation's buffer is.
    expect(
      await call('a', 'POST', '/v1/holds', { ...window, start: day(14, '09:00:00'), end: day(14, '10:00:00'), ttl_seconds: 60, buffer_after_minutes: 30 * 24 * 60 + 1 }),
    ).toEqual(refused(400, 'invalid_arguments'));
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
    expect(await call('a', 'PUT', path, { ...booking, end: day(23, '09:00:00') })).toEqual(
      refused(422, 'idempotency_conflict'),
    );

    // Tenant B cannot book on A's resource, and its own reference with the same text is its own.
    expect(await call('b', 'PUT', path, booking)).toEqual(refused(404, 'resource_not_found'));

    const moved = await call('a', 'PUT', path, { ...booking, start: day(24, '09:00:00'), end: day(25, '09:00:00'), revision: 2 });
    expect(moved.body).toMatchObject({ reservation: { start: day(24, '09:00:00'), revision: 2 }, replayed: false });
    expect(await call('a', 'PUT', path, { ...booking, revision: 2 })).toEqual(refused(422, 'idempotency_conflict'));
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
      body: { extended: 0, conflicts: 0, refused: 0, pruned: 0, zone_shifts: 0, stale_sources: 0, no_shows: 0, waitlist_offers: 0, capped: false },
    });
    expect(await call('agent', 'POST', '/v1/maintenance', {})).toEqual(refused(403, 'forbidden'));
  });

  it('creates a private resource agents never see, and archives, restores and deletes resources', async () => {
    const privateVan = await call('a', 'POST', '/v1/resources', { external_ref: 'private-van', visibility: 'private' });
    expect(privateVan.body.resource).toMatchObject({ visibility: 'private', archived_at: null });
    const id = privateVan.body.resource.id as string;
    // Created again without a visibility, it is answered as it is; with the other, refused.
    expect((await call('a', 'POST', '/v1/resources', { external_ref: 'private-van' })).body.resource).toMatchObject({
      id,
      visibility: 'private',
    });
    expect(await call('a', 'POST', '/v1/resources', { external_ref: 'private-van', visibility: 'shared' })).toEqual(
      refused(409, 'resource_visibility_conflict'),
    );
    const listedToAgent = await call('agent', 'GET', '/v1/resources?limit=100');
    expect(listedToAgent.status).toBe(200);
    expect(listedToAgent.body.resources.map((resource: { id: string }) => resource.id)).not.toContain(id);

    const shared = (await call('a', 'POST', '/v1/resources', { external_ref: `retired-van-${randomUUID()}` })).body
      .resource;
    const window = { resource_id: shared.id, start: day(40, '09:00:00'), end: day(40, '10:00:00') };
    const holdId = (await call('a', 'POST', '/v1/holds', { ...window, ttl_seconds: 600 })).body.hold.id as string;
    const archived = await call('a', 'POST', `/v1/resources/${shared.id}/archive`, {});
    expect(archived.status).toBe(200);
    const archivedAt = archived.body.resource.archived_at as string;
    expect(Date.parse(archivedAt)).toBeLessThanOrEqual(Date.now() + 1_000);
    // Archiving again keeps the first time; reading it still works; booking on it does not.
    expect((await call('a', 'POST', `/v1/resources/${shared.id}/archive`, {})).body.resource.archived_at).toBe(archivedAt);
    expect((await call('a', 'GET', `/v1/resources/${shared.id}`)).body.resource.archived_at).toBe(archivedAt);
    expect(
      await call('a', 'POST', '/v1/holds', { ...window, start: day(41, '09:00:00'), end: day(41, '10:00:00'), ttl_seconds: 60 }),
    ).toEqual(refused(409, 'resource_archived'));
    expect(await call('b', 'POST', `/v1/resources/${shared.id}/archive`, {})).toEqual(refused(404, 'resource_not_found'));
    expect(await call('b', 'POST', `/v1/resources/${shared.id}/restore`, {})).toEqual(refused(404, 'resource_not_found'));
    expect(await call('b', 'DELETE', `/v1/resources/${shared.id}`)).toEqual({ status: 200, body: { deleted: false } });

    const restored = await call('a', 'POST', `/v1/resources/${shared.id}/restore`, {});
    expect(restored.body.resource.archived_at).toBeNull();
    // The live hold keeps it in use until it is released.
    expect(await call('a', 'DELETE', `/v1/resources/${shared.id}`)).toEqual(refused(409, 'resource_in_use'));
    expect((await call('a', 'DELETE', `/v1/holds/${holdId}`)).body).toEqual({ released: true });
    expect(await call('a', 'DELETE', `/v1/resources/${shared.id}`)).toEqual({ status: 200, body: { deleted: true } });
    expect(await call('a', 'DELETE', `/v1/resources/${shared.id}`)).toEqual({ status: 200, body: { deleted: false } });
    expect(await call('a', 'DELETE', '/v1/resources/not-a-uuid')).toEqual({ status: 200, body: { deleted: false } });
    expect(await call('a', 'GET', `/v1/resources/${shared.id}`)).toEqual(refused(404, 'resource_not_found'));
    expect(await call('a', 'POST', '/v1/resources/not-a-uuid/archive', {})).toEqual(refused(404, 'resource_not_found'));
  });

  it('keys a hold by the Idempotency-Key header, and reads holds, reservations and busy time', async () => {
    const resource = (await call('a', 'POST', '/v1/resources', { external_ref: `read-van-${randomUUID()}` })).body.resource;
    const first = { resource_id: resource.id, start: day(50, '09:00:00'), end: day(50, '10:00:00'), ttl_seconds: 600 };
    const key = { headers: { 'Idempotency-Key': `checkout-${randomUUID()}` } };
    const held = await call('a', 'POST', '/v1/holds', first, key);
    expect(held.status).toBe(200);
    // The retry answers the same hold rather than overlapping it; another body under the key is refused.
    expect(await call('a', 'POST', '/v1/holds', first, key)).toEqual(held);
    expect(await call('a', 'POST', '/v1/holds', { ...first, ttl_seconds: 900 }, key)).toEqual(
      refused(422, 'idempotency_conflict'),
    );
    // Another key's same text is its own: here it overlaps the first hold.
    expect(await call('a', 'POST', '/v1/holds', first, { headers: { 'Idempotency-Key': 'other-key' } })).toEqual(
      refused(409, 'overlap'),
    );
    const holdId = held.body.hold.id as string;
    expect(await call('a', 'GET', `/v1/holds/${holdId}`)).toEqual({ status: 200, body: held.body });
    expect(await call('b', 'GET', `/v1/holds/${holdId}`)).toEqual(refused(404, 'hold_not_found'));
    expect(await call('a', 'GET', '/v1/holds/not-a-hold')).toEqual(refused(404, 'hold_not_found'));

    const second = (
      await call('a', 'POST', '/v1/holds', { ...first, start: day(51, '09:00:00'), end: day(51, '10:00:00') })
    ).body.hold;
    const pageOne = await call('a', 'GET', `/v1/resources/${resource.id}/holds?limit=1`);
    expect(pageOne.body.holds).toEqual([held.body.hold]);
    expect(pageOne.body.next_cursor).toEqual(expect.any(String));
    const pageTwo = await call(
      'a',
      'GET',
      `/v1/resources/${resource.id}/holds?limit=1&cursor=${encodeURIComponent(pageOne.body.next_cursor)}`,
    );
    expect(pageTwo.body).toEqual({ holds: [second], next_cursor: null });
    expect(await call('b', 'GET', `/v1/resources/${resource.id}/holds`)).toEqual(refused(404, 'resource_not_found'));
    expect(await call('a', 'GET', `/v1/resources/${resource.id}/holds?cursor=nonsense`)).toEqual(
      refused(400, 'invalid_cursor'),
    );

    // A confirmed hold is no longer a hold: it is the reservation with its id as reference.
    const confirmed = (await call('a', 'POST', `/v1/holds/${holdId}/confirm`, {})).body.reservation;
    expect(await call('a', 'GET', `/v1/holds/${holdId}`)).toEqual(refused(404, 'hold_not_found'));
    expect(await call('a', 'GET', `/v1/reservations/${holdId}`)).toEqual({ status: 200, body: { reservation: confirmed } });

    const ref = `BK-${randomUUID()}`;
    const booked = (
      await call('a', 'PUT', `/v1/reservations/${ref}`, {
        resource_id: resource.id,
        start: day(52, '09:00:00'),
        end: day(52, '12:00:00'),
        buffer_after_minutes: 30,
        revision: 1,
      })
    ).body.reservation;
    expect(await call('a', 'GET', `/v1/reservations/${ref}`)).toEqual({ status: 200, body: { reservation: booked } });
    expect(await call('b', 'GET', `/v1/reservations/${ref}`)).toEqual(refused(404, 'reservation_not_found'));
    const window = `start=${encodeURIComponent(day(45))}&end=${encodeURIComponent(day(60))}`;
    const listed = await call('a', 'GET', `/v1/resources/${resource.id}/reservations?${window}&limit=1`);
    expect(listed.body.reservations).toEqual([confirmed]);
    const rest = await call(
      'a',
      'GET',
      `/v1/resources/${resource.id}/reservations?${window}&limit=1&cursor=${encodeURIComponent(listed.body.next_cursor)}`,
    );
    expect(rest.body).toEqual({ reservations: [booked], next_cursor: null });
    expect(await call('a', 'GET', `/v1/resources/${resource.id}/reservations?start=${encodeURIComponent(day(45))}&end=${encodeURIComponent(day(500))}`)).toEqual(
      refused(400, 'invalid_arguments'),
    );

    // Busy time: the confirmed hold, the live second hold, and the booking with its turnaround.
    const busy = await call('a', 'GET', `/v1/resources/${resource.id}/busy?${window}`);
    expect(busy).toEqual({
      status: 200,
      body: {
        busy: [
          { start: first.start, end: first.end },
          { start: second.start, end: second.end },
          { start: day(52, '09:00:00'), end: day(52, '12:30:00') },
        ],
      },
    });
    expect(await call('b', 'GET', `/v1/resources/${resource.id}/busy?${window}`)).toEqual(
      refused(404, 'resource_not_found'),
    );

    // Cancelled, a reservation is no longer read.
    expect((await call('a', 'DELETE', `/v1/reservations/${holdId}?revision=2`)).body).toEqual({ cancelled: true, revision: 2 });
    expect(await call('a', 'GET', `/v1/reservations/${holdId}`)).toEqual(refused(404, 'reservation_not_found'));
  });

  it('lists an event whose participants have addresses an imported feed may carry', async () => {
    // The audit's probe: an invitation whose ORGANIZER was mailto:ops@localhost made every listing
    // of its window answer 500, and the event itself unreadable.
    const resource = (await call('a', 'POST', '/v1/resources', { external_ref: `feed-van-${randomUUID()}` })).body.resource;
    const put = await store.putCalendarEvent({
      tenantRef: tenantA,
      externalRef: `feed-${randomUUID()}`,
      idempotencyKey: `import-${randomUUID()}`,
      expectedRevision: 0,
      resourceId: resource.id,
      start: new Date(day(62, '12:00:00')),
      end: new Date(day(62, '13:00:00')),
      timezone: 'UTC',
      summary: 'Imported invitation',
      organizer: { email: 'ops@localhost' },
      attendees: [{ email: 'grüße@bücher.example' }],
    });
    expect(put.ok).toBe(true);
    const window = `start=${encodeURIComponent(day(61))}&end=${encodeURIComponent(day(63))}`;
    const listed = await call('a', 'GET', `/v1/tenant/events?resource_id=${resource.id}&${window}`);
    expect(listed.status).toBe(200);
    expect(listed.body.events).toMatchObject([
      { organizer: { address: 'ops@localhost' }, attendees: [{ address: 'grüße@bücher.example' }] },
    ]);
    const read = await call('a', 'GET', `/v1/tenant/events/${listed.body.events[0].id}`);
    expect(read.status).toBe(200);
  });

  it('exports hours as a VAVAILABILITY, imports one back, and exports an event as JSCalendar', async () => {
    const resource = (
      await call('a', 'POST', '/v1/resources', { external_ref: `ical-van-${randomUUID()}`, timezone: 'Europe/London' })
    ).body.resource;
    const path = `/v1/resources/${resource.id}/availability/ical`;
    // On the default there is nothing of its own to export.
    expect(await call('a', 'GET', path)).toEqual({ status: 200, body: { icalendar: null } });
    const rules = [
      { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', start_minutes: 540, duration_minutes: 480 },
      { rrule: 'FREQ=WEEKLY;BYDAY=SA', start_minutes: 600, duration_minutes: 120 },
    ];
    await call('a', 'PUT', `/v1/resources/${resource.id}/availability`, { rules });
    const exported = await call('a', 'GET', path);
    expect(exported.status).toBe(200);
    expect(exported.body.icalendar).toContain('DTSTART;TZID=Europe/London:20240108T090000');

    // Cleared, then imported from the export: the same rules.
    await call('a', 'PUT', `/v1/resources/${resource.id}/availability`, { rules: [] });
    const imported = await call('a', 'PUT', path, { icalendar: exported.body.icalendar });
    expect(imported.status).toBe(200);
    expect(imported.body.resource.availability).toEqual(rules);

    // Another zone's times would land elsewhere; another tenant has no such resource.
    const paris = (exported.body.icalendar as string).replaceAll('Europe/London', 'Europe/Paris');
    expect(await call('a', 'PUT', path, { icalendar: paris })).toEqual(refused(400, 'invalid_availability'));
    expect(await call('a', 'PUT', path, { icalendar: 'BEGIN:VCALENDAR' })).toEqual(refused(400, 'invalid_availability'));
    expect(await call('b', 'GET', path)).toEqual(refused(404, 'resource_not_found'));
    expect(await call('b', 'PUT', path, { icalendar: exported.body.icalendar })).toEqual(
      refused(404, 'resource_not_found'),
    );
    expect((await call('a', 'GET', `/v1/resources/${resource.id}`)).body.resource.availability).toEqual(rules);

    const put = await store.putCalendarEvent({
      tenantRef: tenantA,
      externalRef: `jscal-${randomUUID()}`,
      idempotencyKey: `jscal-${randomUUID()}`,
      expectedRevision: 0,
      resourceId: resource.id,
      start: new Date(day(40, '12:00:00')),
      end: new Date(day(40, '13:30:00')),
      timezone: 'UTC',
      summary: 'Handover',
      reminders: [{ action: 'display', minutesBeforeStart: 10 }],
    });
    expect(put.ok).toBe(true);
    const eventId = (put as { eventId: string }).eventId;
    const event = await call('a', 'GET', `/v1/tenant/events/${eventId}/jscalendar`);
    expect(event).toEqual({
      status: 200,
      body: {
        event: expect.objectContaining({
          '@type': 'Event',
          uid: eventId,
          sequence: 1,
          title: 'Handover',
          start: day(40, '12:00:00').slice(0, 19),
          timeZone: 'UTC',
          duration: 'PT1H30M',
          freeBusyStatus: 'busy',
          alerts: {
            a1: {
              '@type': 'Alert',
              trigger: { '@type': 'OffsetTrigger', offset: '-PT10M', relativeTo: 'start' },
              action: 'display',
            },
          },
        }),
      },
    });
    expect(await call('b', 'GET', `/v1/tenant/events/${eventId}/jscalendar`)).toEqual(refused(404, 'event_not_found'));
  });

  it('stops reading busy time at the first interval past what one read may return', async () => {
    // The audit's probe: 24,000 rows were all read into the process before the request was refused.
    const resource = (await call('a', 'POST', '/v1/resources', { external_ref: `busy-van-${randomUUID()}` })).body.resource;
    const from = new Date(day(30));
    await sql`
      INSERT INTO slotlock.reservations (resource_id, tenant_ref, external_ref, starts_at, ends_at)
      SELECT ${resource.id}, ${tenantA}, 'busy-' || n,
             ${from}::timestamptz + n * interval '1 minute',
             ${from}::timestamptz + (n + 1) * interval '1 minute'
        FROM generate_series(0, 10_049) AS n`;
    const read: number[] = [];
    const withTenant = store.withTenant.bind(store);
    const spy = vi.spyOn(store, 'withTenant').mockImplementation(((tenantRef, callback, options) =>
      withTenant(
        tenantRef,
        (tenant) =>
          callback(
            Object.assign(Object.create(tenant), {
              listBusy: async (...args: Parameters<typeof tenant.listBusy>) => {
                const busy = await tenant.listBusy(...args);
                read.push(busy.length);
                return busy;
              },
            }),
          ),
        options,
      )) as typeof store.withTenant);
    try {
      const window = `start=${encodeURIComponent(day(29))}&end=${encodeURIComponent(day(40))}`;
      expect(await call('a', 'GET', `/v1/resources/${resource.id}/busy?${window}`)).toEqual(
        refused(400, 'calendar_work_limit'),
      );
    } finally {
      spy.mockRestore();
    }
    expect(read).toEqual([10_001]);
  }, 60_000);

  it("reads and cancels any key's event, fenced to the resource it is on", async () => {
    const resource = (await call('a', 'POST', '/v1/resources', { external_ref: `event-van-${randomUUID()}` })).body.resource;
    const other = (await call('a', 'POST', '/v1/resources', { external_ref: `event-van-${randomUUID()}` })).body.resource;
    const created = await call('agent', 'POST', '/v1/events', {
      resource_id: resource.id,
      starts_at: day(60, '09:00:00'),
      ends_at: day(60, '10:00:00'),
      timezone: 'UTC',
      title: 'Handover',
      idempotency_key: `handover-${randomUUID()}`,
    });
    expect(created.status).toBe(200);
    const eventRef = created.body.event.id as string;
    // The agent's update is fenced to the resource it read the event on.
    expect(
      await call('agent', 'PATCH', `/v1/events/${encodeURIComponent(eventRef)}`, {
        expected_revision: 1,
        expected_resource_id: other.id,
        title: 'Handover, moved?',
        idempotency_key: `fence-${randomUUID()}`,
      }),
    ).toMatchObject({ status: 404 });
    const updated = await call('agent', 'PATCH', `/v1/events/${encodeURIComponent(eventRef)}`, {
      expected_revision: 1,
      expected_resource_id: resource.id,
      title: 'Handover at the depot',
      idempotency_key: `fence-${randomUUID()}`,
    });
    expect(updated.body.event).toMatchObject({ title: 'Handover at the depot', revision: 2 });

    const window = `start=${encodeURIComponent(day(59))}&end=${encodeURIComponent(day(61))}`;
    const listed = await call('a', 'GET', `/v1/tenant/events?resource_id=${resource.id}&${window}`);
    expect(listed.status).toBe(200);
    expect(listed.body.next_cursor).toBeNull();
    expect(listed.body.events).toEqual([
      {
        ...updated.body.event,
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        event_ref: eventRef,
        owner_ref: expect.stringMatching(/^agent:[0-9a-f]{64}$/),
      },
    ]);
    const eventId = listed.body.events[0].id as string;
    expect(await call('a', 'GET', `/v1/tenant/events/${eventId}`)).toEqual({
      status: 200,
      body: { event: listed.body.events[0] },
    });
    expect(await call('b', 'GET', `/v1/tenant/events/${eventId}`)).toEqual(refused(404, 'event_not_found'));
    expect(await call('b', 'GET', `/v1/tenant/events?resource_id=${resource.id}&${window}`)).toEqual(
      refused(404, 'resource_not_found'),
    );
    expect(await call('agent', 'GET', `/v1/tenant/events/${eventId}`)).toEqual(refused(403, 'forbidden'));

    const key = { headers: { 'Idempotency-Key': `cancel-${randomUUID()}` } };
    expect(
      await call('a', 'DELETE', `/v1/tenant/events/${eventId}?expected_revision=2&expected_resource_id=${other.id}`, undefined, key),
    ).toEqual(refused(404, 'event_not_found'));
    expect(await call('a', 'DELETE', `/v1/tenant/events/${eventId}?expected_revision=1`, undefined, key)).toMatchObject({
      status: 409,
    });
    const cancelled = await call(
      'a',
      'DELETE',
      `/v1/tenant/events/${eventId}?expected_revision=2&expected_resource_id=${resource.id}`,
      undefined,
      key,
    );
    expect(cancelled).toEqual({ status: 200, body: { event_id: eventId, revision: 3, cancelled: true, replayed: false } });
    expect(
      await call('a', 'DELETE', `/v1/tenant/events/${eventId}?expected_revision=2&expected_resource_id=${resource.id}`, undefined, key),
    ).toEqual({ status: 200, body: { ...cancelled.body, replayed: true } });
    expect(await call('a', 'GET', `/v1/tenant/events/${eventId}`)).toEqual(refused(404, 'event_not_found'));
    expect(await call('agent', 'GET', `/v1/events/${encodeURIComponent(eventRef)}`)).toMatchObject({ status: 404 });
  });

  it('reads its suspension, and erases itself only when allowed, confirmed and not suspended', async () => {
    expect(await call('a', 'GET', '/v1/tenant')).toEqual({
      status: 200,
      body: { tenant: { ref: tenantA, suspended: false } },
    });
    expect(await call('agent', 'GET', '/v1/tenant')).toEqual(refused(403, 'forbidden'));
    const resource = (await call('erased', 'POST', '/v1/resources', { external_ref: 'erase-van' })).body.resource;
    await call('erased', 'PUT', `/v1/reservations/erase-${randomUUID()}`, {
      resource_id: resource.id,
      start: day(70, '09:00:00'),
      end: day(70, '10:00:00'),
      revision: 1,
    });
    const confirm = { confirm_tenant_ref: tenantErased };
    expect(await call('erased', 'POST', '/v1/tenant/erase', confirm)).toEqual(refused(403, 'tenant_erasure_disabled'));
    expect(await call('erased', 'POST', '/v1/tenant/erase', { confirm_tenant_ref: tenantA }, { tenantErasure: true })).toEqual(
      refused(400, 'invalid_confirmation'),
    );
    expect(await call('erasedAgent', 'POST', '/v1/tenant/erase', confirm, { tenantErasure: true })).toEqual(
      refused(403, 'forbidden'),
    );

    // Suspended, it reads and says so, and its data is kept for the operator.
    expect(await store.suspendTenant({ tenantRef: tenantErased, reason: 'review' })).toEqual({ suspended: true });
    expect((await call('erased', 'GET', '/v1/tenant')).body).toEqual({ tenant: { ref: tenantErased, suspended: true } });
    expect(await call('erased', 'POST', '/v1/tenant/erase', confirm, { tenantErasure: true })).toEqual(
      refused(403, 'tenant_suspended'),
    );
    expect((await call('erased', 'GET', `/v1/resources/${resource.id}`)).status).toBe(200);
    await store.unsuspendTenant({ tenantRef: tenantErased });

    const erased = await call('erased', 'POST', '/v1/tenant/erase', confirm, { tenantErasure: true });
    expect(erased.status).toBe(200);
    expect(erased.body.rows).toMatchObject({ resources: 1 });
    expect(erased.body.total).toBeGreaterThanOrEqual(2);
    expect(await call('erased', 'GET', `/v1/resources/${resource.id}`)).toEqual(refused(404, 'resource_not_found'));
    expect((await call('erased', 'POST', '/v1/tenant/erase', confirm, { tenantErasure: true })).body.total).toBe(0);
    // Another tenant's resources are as they were.
    expect((await call('a', 'GET', '/v1/tenant')).status).toBe(200);
    const [row] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM slotlock.resources WHERE tenant_ref = ${tenantA}`;
    expect(Number(row?.count)).toBeGreaterThan(0);
  });
});
