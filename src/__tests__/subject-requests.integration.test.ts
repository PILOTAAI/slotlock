// Requests about one person (RFC 0004 D3) and the audit log over the API (D2), against real
// Postgres: what an export lists, what an erasure takes out and what it leaves (the bookings, as time
// taken), by email, holder, contact and reference; and GET /v1/audit with its plan gate. Skipped
// without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer } from '../agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];
const KEY_ID = '00000000-0000-4000-8000-00000000d3d3';

describe.skipIf(!url)('requests about one person (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const tenantRef = `subjects-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    admin: { subject: 'person-admin', tenantRef, scopes: ['read', 'write', 'admin'], keyId: KEY_ID },
  };
  const day = Date.UTC(new Date().getUTCFullYear() + 1, 2, 3);
  const at = (hour: number) => new Date(day + hour * HOUR).toISOString();
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: 'Bearer admin', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const resource = async (ref: string) =>
    ((await call('POST', '/v1/resources', { external_ref: ref, timezone: 'UTC' })).body.resource as { id: string }).id;
  const records = (body: Record<string, unknown>) => body.records as Record<string, Record<string, unknown>[]>;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql, { defaultAvailabilityRules: ALL_DAY });
    await store.applySchema();
    const agentBackend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => ALL_DAY });
    server = createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      backend: agentBackend,
      authenticate: async (request) => principals[request.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
      application: {
        backend: createSlotlockStoreApplicationBackend(store, { agentBackend }),
        authorize: async ({ principal }) => principal.scopes?.includes('admin') === true,
      },
    });
  });

  afterAll(async () => {
    await sql`DELETE FROM slotlock.tenant_plans WHERE tenant_ref = ${tenantRef}`;
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('exports and erases a person by email: contacts, attendance and organizing, keeping the bookings', async () => {
    const room = await resource('room-email');
    expect((await call('PUT', '/v1/contacts/customer-42', { email: 'Ada@Example.com', name: 'Ada' })).status).toBe(200);
    expect((await call('PUT', '/v1/contacts/customer-43', { email: 'bob@example.com' })).status).toBe(200);
    expect(
      (await call('PUT', '/v1/reservations/booking-ada', { resource_id: room, start: at(9), end: at(10), revision: 1, contact_ref: 'customer-42' })).status,
    ).toBe(200);
    const event = await store.withTenant(tenantRef, (tenant) =>
      tenant.putCalendarEvent({
        tenantRef, externalRef: 'meeting', idempotencyKey: 'meeting-1', expectedRevision: 0, resourceId: room,
        start: new Date(at(11)), end: new Date(at(12)), timezone: 'UTC', summary: 'Planning',
        organizer: { email: 'ada@example.com', name: 'Ada' },
        attendees: [{ email: 'ADA@example.com', name: 'Ada' }, { email: 'bob@example.com', name: 'Bob' }],
      }),
    );
    expect(event.ok).toBe(true);
    const eventId = (event as { eventId: string }).eventId;

    // Exactly one identifier.
    expect((await call('POST', '/v1/subjects/export', {})).status).toBe(400);
    expect((await call('POST', '/v1/subjects/export', { email: 'ada@example.com', holder: 'x' })).status).toBe(400);

    const exported = await call('POST', '/v1/subjects/export', { email: 'ada@EXAMPLE.com' });
    expect(exported.status).toBe(200);
    const found = records(exported.body);
    expect(exported.body.truncated).toBe(false);
    expect(found.contacts?.map((row) => row.ref)).toEqual(['customer-42']);
    expect(found.contacts?.[0]).not.toHaveProperty('tenant_ref');
    expect(found.reservations?.map((row) => row.external_ref)).toEqual(['booking-ada']);
    // Kept as written (Slotlock lowercases addresses), and matched without case.
    expect(found.calendar_event_attendees?.map((row) => row.email)).toEqual(['ada@example.com']);
    // The event's time and title, and its organizer because that is them; never Bob.
    expect(found.calendar_events).toHaveLength(1);
    expect(found.calendar_events?.[0]).toMatchObject({ id: eventId, summary: 'Planning', organizer: { email: 'ada@example.com' } });
    expect(JSON.stringify(found)).not.toContain('bob@example.com');
    expect(found.outbox?.length).toBeGreaterThan(0);
    expect(found.outbox?.every((change) => (change.data as Record<string, unknown>).contact_ref === 'customer-42')).toBe(true);

    // A dry run changes nothing.
    const dry = await call('POST', '/v1/subjects/erase', { email: 'ada@example.com', dry_run: true });
    expect(dry).toMatchObject({ status: 200, body: { dry_run: true, erased: { contacts: 1 } } });
    expect(records(await (await call('POST', '/v1/subjects/export', { email: 'ada@example.com' })).body).contacts).toHaveLength(1);

    const erased = await call('POST', '/v1/subjects/erase', { email: 'ada@example.com' });
    expect(erased.status).toBe(200);
    expect(erased.body.erased).toMatchObject({ contacts: 1, reservations: 1, calendar_event_attendees: 1, calendar_events: 1 });
    expect((erased.body.erased as Record<string, number>).outbox).toBeGreaterThan(0);

    // The booking stays, as time taken, naming no one; Bob and his contact stay.
    const booking = await call('GET', '/v1/reservations/booking-ada');
    expect(booking.status).toBe(200);
    expect((booking.body.reservation as Record<string, unknown>).contact_ref ?? null).toBeNull();
    expect((await call('PUT', '/v1/reservations/other', { resource_id: room, start: at(9), end: at(10), revision: 1 })).status).toBe(409);
    expect((await call('GET', '/v1/contacts/customer-42')).status).toBe(404);
    expect((await call('GET', '/v1/contacts/customer-43')).status).toBe(200);
    const [kept] = await sql<{ organizer: unknown; attendees: { email: string }[]; revision: string }[]>`
      SELECT organizer, attendees, revision::text FROM slotlock.calendar_events WHERE id = ${eventId}`;
    expect(kept).toMatchObject({ organizer: null, attendees: [{ email: 'bob@example.com', name: 'Bob' }], revision: '1' });
    expect(
      (await sql`SELECT email FROM slotlock.calendar_event_attendees WHERE event_id = ${eventId}`).map((row) => row.email),
    ).toEqual(['bob@example.com']);
    // The history no longer names their contact, and no change was written for the erasure.
    const [named] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} AND data ->> 'contact_ref' = 'customer-42'`;
    expect(named?.n).toBe(0);
    const empty = records((await call('POST', '/v1/subjects/export', { email: 'ada@example.com' })).body);
    expect(Object.values(empty).every((rows) => rows.length === 0)).toBe(true);
    // Erasing again changes nothing.
    const again = await call('POST', '/v1/subjects/erase', { email: 'ada@example.com' });
    expect(Object.values(again.body.erased as Record<string, number>).every((rows) => rows === 0)).toBe(true);
  });

  it('erases a holder: waitlist entries go, holds and the history keep one name that is no one', async () => {
    const van = await resource('van-holder');
    expect((await call('PUT', '/v1/reservations/blocker', { resource_id: van, start: at(14), end: at(15), revision: 1 })).status).toBe(200);
    const joined = await call('POST', '/v1/waitlist', { resource_id: van, start: at(14), end: at(15), holder_ref: 'holder-ada' });
    expect(joined.status).toBe(200);
    // The blocker goes: the entry is offered a hold of the time, held for holder-ada.
    expect((await call('DELETE', '/v1/reservations/blocker?revision=2')).status).toBe(200);
    await store.withTenant(tenantRef, (tenant) => tenant.offerWaitlist({ tenantRef }));
    const exported = records((await call('POST', '/v1/subjects/export', { holder: 'holder-ada' })).body);
    expect(exported.waitlist_entries).toHaveLength(1);
    expect(exported.reservations?.map((row) => row.status)).toEqual(['held']);
    expect(exported.outbox?.length).toBeGreaterThan(0);

    const erased = await call('POST', '/v1/subjects/erase', { holder: 'holder-ada' });
    expect(erased.status).toBe(200);
    expect(erased.body.erased).toMatchObject({ waitlist_entries: 1, reservations: 1 });
    const [hold] = await sql<{ holder_ref: string }[]>`
      SELECT holder_ref FROM slotlock.reservations WHERE resource_id = ${van} AND status = 'held'`;
    expect(hold?.holder_ref).toMatch(/^erased-[0-9a-f]{32}$/);
    const changes = await sql<{ holder: string }[]>`
      SELECT DISTINCT data ->> 'holder_ref' AS holder FROM slotlock.outbox
       WHERE tenant_ref = ${tenantRef} AND data ? 'holder_ref'`;
    expect(changes.map((row) => row.holder)).toEqual([hold?.holder_ref]);
    // The time is still held.
    expect((await call('PUT', '/v1/reservations/late', { resource_id: van, start: at(14), end: at(15), revision: 1 })).status).toBe(409);
  });

  it('erases a booking reference: the booking and its history keep their time under an erased name', async () => {
    const desk = await resource('desk-reference');
    expect((await call('PUT', '/v1/reservations/order-ada-7', { resource_id: desk, start: at(16), end: at(17), revision: 1 })).status).toBe(200);
    expect((await call('PUT', '/v1/reservations/order-ada-7', { resource_id: desk, start: at(17), end: at(18), revision: 2 })).status).toBe(200);
    expect((await call('PUT', '/v1/reservations/order-ada-8', { resource_id: desk, start: at(19), end: at(20), revision: 1 })).status).toBe(200);
    expect((await call('DELETE', '/v1/reservations/order-ada-8?revision=2')).status).toBe(200);

    const exported = records((await call('POST', '/v1/subjects/export', { reference: 'order-ada-7' })).body);
    expect(exported.reservations).toHaveLength(1);
    expect(exported.outbox?.length).toBeGreaterThanOrEqual(2);

    const erased = await call('POST', '/v1/subjects/erase', { reference: 'order-ada-7' });
    expect(erased.body.erased).toMatchObject({ reservations: 1 });
    expect((erased.body.erased as Record<string, number>).outbox).toBeGreaterThanOrEqual(2);
    expect((await call('GET', '/v1/reservations/order-ada-7')).status).toBe(404);
    const [renamed] = await sql<{ external_ref: string }[]>`
      SELECT external_ref FROM slotlock.reservations WHERE resource_id = ${desk} AND calendar_event_id IS NULL`;
    expect(renamed?.external_ref).toMatch(/^erased-[0-9a-f]{32}$/);
    const subjects = await sql<{ subject: string; reference: string }[]>`
      SELECT DISTINCT subject, data ->> 'reference' AS reference FROM slotlock.outbox
       WHERE tenant_ref = ${tenantRef} AND resource_id = ${desk} AND type LIKE 'reservation.%' AND subject <> 'order-ada-8'`;
    expect(subjects).toEqual([{ subject: renamed?.external_ref, reference: renamed?.external_ref }]);
    // Its history is read under the new name; the time stays taken, and the old name is free.
    const history = await call('GET', `/v1/reservations/${renamed?.external_ref}/history`);
    expect(history.status).toBe(200);
    expect((history.body.history as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect((await call('PUT', '/v1/reservations/clash', { resource_id: desk, start: at(17), end: at(18), revision: 1 })).status).toBe(409);
    expect((await call('PUT', '/v1/reservations/order-ada-7', { resource_id: desk, start: at(21), end: at(22), revision: 1 })).status).toBe(200);

    // An ended booking's tombstone is renamed too.
    const ended = await call('POST', '/v1/subjects/erase', { reference: 'order-ada-8' });
    expect(ended.body.erased).toMatchObject({ reservation_tombstones: 1, reservations: 0 });
  });

  it('reads the audit log over the API, with the erasure recorded without the person, and checks its chain', async () => {
    const page = await call('GET', '/v1/audit?action=subject.erased');
    expect(page.status).toBe(200);
    const events = page.body.events as Record<string, unknown>[];
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[0]).toMatchObject({ action: 'subject.erased', actor_type: 'api_key', actor_ref: `api_key:${KEY_ID}`, target_type: 'subject' });
    expect(events[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(events);
    for (const named of ['ada@example.com', 'holder-ada', 'order-ada-7', 'customer-42']) expect(text).not.toContain(named);
    expect(events.map((event) => (event.metadata as Record<string, unknown>).by)).toEqual(['reference', 'reference', 'holder', 'email', 'email']);

    // Pages follow the cursor, newest first, without repeating one.
    const first = await call('GET', '/v1/audit?limit=2');
    const second = await call('GET', `/v1/audit?limit=2&cursor=${String(first.body.next_cursor)}`);
    const ids = [...(first.body.events as { id: string }[]), ...(second.body.events as { id: string }[])].map((event) => event.id);
    expect(new Set(ids).size).toBe(4);
    expect(await call('GET', '/v1/audit/verify')).toMatchObject({ status: 200, body: { checked: 5, broken_at: null } });

    // Where hosted plans apply, the Team plan's.
    await sql`SELECT slotlock.set_tenant_plan(${tenantRef}::text, 'developer', 'active', 100, 100, 10, NULL, NULL, NULL)`;
    expect(await call('GET', '/v1/audit')).toMatchObject({ status: 403, body: { error: { code: 'team_plan_required' } } });
    await sql`SELECT slotlock.set_tenant_plan(${tenantRef}::text, 'team', 'active', 500, 100, 25, NULL, NULL, NULL)`;
    expect((await call('GET', '/v1/audit')).status).toBe(200);
    await sql`SELECT slotlock.set_tenant_plan(${tenantRef}::text, 'team', 'canceled', 500, 100, 25, NULL, NULL, NULL)`;
    expect((await call('GET', '/v1/audit')).status).toBe(403);
  });
});
