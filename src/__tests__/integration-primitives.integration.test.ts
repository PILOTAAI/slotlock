// What integrations build on (RFC 0004 P3) against real Postgres: busy time a calendar reports
// without its events, contacts and the per-booking notify flag, holds that wait for payment, and
// event reminders put on the feed once each. Skipped without DATABASE_URL.
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

describe.skipIf(!url)('integration primitives (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const tenantRef = `primitives-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    admin: { subject: 'person-admin', tenantRef, scopes: ['read', 'write', 'admin'] },
  };
  const day = Date.UTC(new Date().getUTCFullYear() + 1, 1, 2);
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
  const feed = async (type: string) =>
    sql<{ subject: string; data: Record<string, unknown> }[]>`
      SELECT subject, data FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} AND type = ${type} ORDER BY id`;
  const resource = async (ref: string) =>
    ((await call('POST', '/v1/resources', { external_ref: ref, timezone: 'UTC' })).body.resource as { id: string }).id;

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
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it("keeps a calendar's busy time, refuses bookings over it, and reports a booking in its way once", async () => {
    const van = await resource('van-busy');
    expect((await call('PUT', '/v1/reservations/early', { resource_id: van, start: at(8), end: at(9), revision: 1 })).status).toBe(200);
    const busyPath = `/v1/resources/${van}/coverage/google%3Avan/busy`;
    const put = (revision: number, busy: { start: string; end: string }[], window = { start: at(0), end: at(24) }) =>
      call('PUT', busyPath, { ...window, revision, busy });

    // Overlapping and touching intervals merge; the one over the booking is a conflict.
    const first = await put(1, [
      { start: at(8), end: at(8.5) },
      { start: at(12), end: at(13) },
      { start: at(13), end: at(14) },
      { start: at(30), end: at(31) },
    ]);
    expect(first).toEqual({ status: 200, body: { revision: 1, replayed: false, busy: 2, conflicts: 1 } });
    const conflicts = await feed('coverage.conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ data: { reference: 'early', resource_id: van } });
    expect(Date.parse(conflicts[0]?.data.busy_start as string)).toBe(Date.parse(at(8)));
    // Named as every coverage change is: by the source's source_id, never the source.
    expect(conflicts[0]?.subject).toMatch(/^src_[0-9a-f]{32}$/);
    expect(conflicts[0]?.data.source_id).toBe(conflicts[0]?.subject);
    expect(JSON.stringify(conflicts[0]?.data)).not.toContain('google');

    // Free/busy counts it; a booking over it is refused, as over an event.
    const freeBusy = await store.getFreeBusy({ tenantRef, resourceId: van, window: { start: new Date(at(0)), end: new Date(at(24)) } });
    expect(freeBusy.busy.map((busy) => [busy.start.toISOString(), busy.end.toISOString()])).toEqual([
      [at(8), at(9)],
      [at(12), at(14)],
    ]);
    expect((await call('PUT', '/v1/reservations/clash', { resource_id: van, start: at(13), end: at(15), revision: 1 })).body).toMatchObject({
      error: { code: 'overlap' },
    });
    expect((await call('POST', '/v1/holds', { resource_id: van, start: at(12.5), end: at(13.5), ttl_seconds: 60 })).body).toMatchObject({
      error: { code: 'overlap' },
    });

    // A replay changes nothing; the next read, still busy over the booking, does not report it again.
    expect((await put(1, [])).body).toMatchObject({ replayed: true, conflicts: 0 });
    expect((await put(2, [{ start: at(8), end: at(8.5) }])).body).toEqual({ revision: 2, replayed: false, busy: 1, conflicts: 0 });
    expect(await feed('coverage.conflict')).toHaveLength(1);
    expect((await call('PUT', '/v1/reservations/clash', { resource_id: van, start: at(13), end: at(15), revision: 1 })).status).toBe(200);

    // A narrower window keeps what the source said outside it.
    expect((await put(3, [], { start: at(8.25), end: at(10) })).body).toMatchObject({ busy: 0 });
    const [kept] = await sql<{ spans: string[] }[]>`
      SELECT array_agg(starts_at::text || '/' || ends_at::text ORDER BY starts_at) AS spans
        FROM slotlock.source_busy WHERE resource_id = ${van}`;
    expect(kept?.spans).toHaveLength(1);
    expect((await put(4, [{ start: at(1), end: at(0) }])).status).toBe(400);
    expect((await put(2, [])).body).toMatchObject({ error: { code: 'stale_revision' } });

    // Retiring the source forgets its busy time.
    expect((await call('DELETE', `/v1/resources/${van}/coverage/google%3Avan`)).body).toEqual({ deleted: true });
    const [left] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.source_busy WHERE resource_id = ${van}`;
    expect(left?.count).toBe(0);
  });

  it('names whom to tell on a booking, and forgets the person with their contact', async () => {
    const room = await resource('room-contact');
    const contact = await call('PUT', '/v1/contacts/customer-42', {
      name: 'Ada',
      email: 'ada@example.com',
      phone: '+447700900123',
      consent: { email: true, sms: false },
      locale: 'en-GB',
    });
    expect(contact).toMatchObject({ status: 200, body: { created: true, contact: { contact_ref: 'customer-42', consent: { email: true, sms: false } } } });
    expect((await call('PUT', '/v1/contacts/customer-42', { email: 'ada@example.org' })).body).toMatchObject({
      created: false,
      contact: { email: 'ada@example.org', phone: null, consent: {} },
    });
    expect((await call('PUT', '/v1/contacts/bad', { phone: '07700 900123' })).status).toBe(400);

    const booked = await call('PUT', '/v1/reservations/bk-tell', {
      resource_id: room,
      start: at(10),
      end: at(11),
      revision: 1,
      contact_ref: 'customer-42',
      notify: false,
    });
    expect(booked.body.reservation).toMatchObject({ contact_ref: 'customer-42', notify: false });
    const [created] = (await feed('reservation.created')).filter((change) => change.subject === 'bk-tell');
    expect(created?.data).toMatchObject({ contact_ref: 'customer-42', notify: false });
    // Moved without them: as sent, it names no one and may be told.
    await call('PUT', '/v1/reservations/bk-tell', { resource_id: room, start: at(10), end: at(11), revision: 2, contact_ref: 'customer-42' });
    expect((await call('GET', '/v1/reservations/bk-tell')).body.reservation).not.toHaveProperty('notify');

    expect((await call('DELETE', '/v1/contacts/customer-42')).body).toEqual({ deleted: true, bookings: 1 });
    expect((await call('GET', '/v1/contacts/customer-42')).status).toBe(404);
    expect((await call('GET', '/v1/reservations/bk-tell')).body.reservation).not.toHaveProperty('contact_ref');
    expect((await call('DELETE', '/v1/contacts/customer-42')).body).toEqual({ deleted: false, bookings: 0 });
  });

  it('confirms a hold that waits for payment only once it is paid', async () => {
    const desk = await resource('desk-pay');
    expect((await call('POST', '/v1/holds', { resource_id: desk, start: at(9), end: at(10), ttl_seconds: 3_600, payment_required: true })).status).toBe(400);
    const held = (await call('POST', '/v1/holds', { resource_id: desk, start: at(9), end: at(10), ttl_seconds: 900, payment_required: true })).body
      .hold as { id: string; payment_required: boolean; payment_ref: string | null };
    expect(held).toMatchObject({ payment_required: true, payment_ref: null, paid_at: null });
    expect((await call('POST', `/v1/holds/${held.id}/confirm`, {})).body).toMatchObject({ error: { code: 'payment_required' } });

    const paid = await call('POST', `/v1/holds/${held.id}/paid`, { payment_ref: 'pi_123' });
    expect(paid.body).toMatchObject({ replayed: false, hold: { payment_ref: 'pi_123', paid_at: expect.any(String) } });
    expect((await call('POST', `/v1/holds/${held.id}/paid`, { payment_ref: 'pi_123' })).body).toMatchObject({ replayed: true });
    expect((await call('POST', `/v1/holds/${held.id}/paid`, { payment_ref: 'pi_999' })).body).toMatchObject({ error: { code: 'payment_conflict' } });
    expect((await feed('hold.paid')).map((change) => change.data)).toEqual([expect.objectContaining({ id: held.id, payment_ref: 'pi_123' })]);
    expect((await call('POST', `/v1/holds/${held.id}/confirm`, {})).status).toBe(200);
    expect((await call('POST', `/v1/holds/${held.id}/paid`, { payment_ref: 'pi_123' })).status).toBe(404);

    const free = (await call('POST', '/v1/holds', { resource_id: desk, start: at(11), end: at(12), ttl_seconds: 900 })).body.hold as { id: string };
    expect(free).not.toHaveProperty('payment_required');
    expect((await call('POST', `/v1/holds/${free.id}/paid`, { payment_ref: 'pi_1' })).body).toMatchObject({ error: { code: 'payment_not_required' } });

    // Paid after it lapsed: refused, so the integrator refunds.
    const lapsing = (await call('POST', '/v1/holds', { resource_id: desk, start: at(13), end: at(14), ttl_seconds: 60, payment_required: true })).body
      .hold as { id: string };
    await sql`UPDATE slotlock.reservations SET expires_at = statement_timestamp() - interval '1 second' WHERE id = ${lapsing.id}`;
    expect((await call('POST', `/v1/holds/${lapsing.id}/paid`, { payment_ref: 'pi_2' })).body).toMatchObject({ error: { code: 'hold_expired' } });
  });

  it("puts each event reminder that comes due on the feed once, and again when the event moves", async () => {
    const studio = await store.withTenant(tenantRef, (tenant) => tenant.createResource({ tenantRef, externalRef: 'studio', timezone: 'UTC' }));
    // Events start on whole seconds.
    const now = Math.floor(Date.now() / 1_000) * 1_000;
    const soon = (minutes: number) => new Date(now + minutes * 60_000);
    const write = (ref: string, revision: number, startIn: number, notify = true) =>
      store.withTenant(tenantRef, (tenant) =>
        tenant.putCalendarEvent({
          tenantRef,
          externalRef: ref,
          resourceId: studio.id,
          expectedRevision: revision,
          idempotencyKey: `${ref}-${revision}`,
          start: soon(startIn),
          end: soon(startIn + 30),
          timezone: 'UTC',
          summary: 'Session',
          // An email reminder is for someone.
          attendees: [{ email: 'guest@example.com' }],
          reminders: [
            { action: 'display', minutesBeforeStart: 60 },
            { action: 'email', minutesBeforeStart: 24 * 60 * 2 },
          ],
          ...(notify ? {} : { notify: false }),
        }),
      );
    const told = await write('session', 0, 30);
    expect(told).toMatchObject({ ok: true });
    expect((await write('quiet', 0, 120, false)).ok).toBe(true);
    const maintain = async () => (await call('POST', '/v1/maintenance', {})).body.reminders_due;

    // Due 30 minutes ago; the two-day one was due over a day ago, and the quiet event says nothing.
    expect(await maintain()).toBe(1);
    expect(await maintain()).toBe(0);
    const [due] = await feed('reminder.due');
    expect(due).toMatchObject({ subject: (told as { eventId: string }).eventId, data: { ordinal: 0, action: 'display', minutes_before_start: 60 } });

    // Moved: due at another time, said again.
    expect((await write('session', 1, 40)).ok).toBe(true);
    expect(await maintain()).toBe(1);
    expect(await feed('reminder.due')).toHaveLength(2);
  });
});
