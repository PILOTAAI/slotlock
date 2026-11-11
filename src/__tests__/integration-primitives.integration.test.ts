// What integrations build on (RFC 0004 P3) against real Postgres: busy time a calendar reports
// without its events, contacts and the per-booking notify flag, holds that wait for payment, and
// event reminders put on the feed once each. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer, invokeSlotlockAgentOperation } from '../agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { type SlotlockStore, calendarEventRollingHorizon, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];

describe.skipIf(!url)('integration primitives (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  let agentBackend: ReturnType<typeof createSlotlockStoreAgentBackend>;
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
    agentBackend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => ALL_DAY });
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
    // So does every other read: the application API's busy list, the library's search, and the
    // waitlist, which offers only time a hold can take.
    const listed = (await call('GET', `/v1/resources/${van}/busy?start=${at(0)}&end=${at(24)}`)).body.busy as { start: string }[];
    expect(listed.map((busy) => Date.parse(busy.start))).toContain(Date.parse(at(12)));
    const searched = await store.withTenant(tenantRef, (tenant) =>
      tenant.findNextAvailableFor({
        tenantRef,
        resourceId: van,
        rules: ALL_DAY,
        searchWindow: { start: new Date(at(11)), end: new Date(at(24)) },
        durationMs: 2 * HOUR,
      }),
    );
    expect(searched?.start.toISOString()).toBe(at(14));
    const waiting = (await call('POST', '/v1/waitlist', { resource_id: van, start: at(12), end: at(16), holder_ref: 'w-1', duration_minutes: 60 })).body
      .entry as { id: string };
    await call('POST', '/v1/maintenance', {});
    const offered = ((await call('GET', '/v1/waitlist')).body.entries as { id: string; hold_id: string | null }[]).find((entry) => entry.id === waiting.id);
    const offeredHold = (await call('GET', `/v1/holds/${offered?.hold_id as string}`)).body.hold as { start: string };
    expect(Date.parse(offeredHold.start)).toBe(Date.parse(at(14)));
    await call('DELETE', `/v1/waitlist/${waiting.id}`);
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

  it("holds a calendar's busy time through a composite, at a hold's confirmation and in a series' roll, and lets it go once old", async () => {
    const hall = await resource('hall-busy');
    const roomA = await resource('room-a-busy');
    const roomB = await resource('room-b-busy');
    for (const part of [roomA, roomB]) {
      await store.withTenant(tenantRef, (tenant) => tenant.setResourceParent({ tenantRef, id: part, parentId: hall }));
    }
    const busy = (resourceId: string, start: string, end: string) =>
      call('PUT', `/v1/resources/${resourceId}/coverage/google%3Ab/busy`, { start: at(0), end: at(48), revision: 1, busy: [{ start, end }] });
    const book = (resourceId: string, ref: string, start: string, end: string) =>
      call('PUT', `/v1/reservations/${ref}`, { resource_id: resourceId, start, end, revision: 1 });

    // The whole busy keeps each part busy, in reads and writes...
    expect((await busy(hall, at(10), at(12))).status).toBe(200);
    expect((await book(roomA, 'part-under-whole', at(10), at(11))).body).toMatchObject({ error: { code: 'overlap' } });
    const roomFree = await store.getFreeBusy({ tenantRef, resourceId: roomA, window: { start: new Date(at(0)), end: new Date(at(24)) } });
    expect(roomFree.busy.map((each) => [each.start.toISOString(), each.end.toISOString()])).toEqual([[at(10), at(12)]]);
    // ...and a part busy keeps the whole busy, but not its sibling.
    expect((await busy(roomA, at(30), at(32))).status).toBe(200);
    expect((await book(hall, 'whole-over-part', at(30), at(31))).body).toMatchObject({ error: { code: 'overlap' } });
    expect((await book(roomB, 'sibling', at(30), at(31))).status).toBe(200);

    // A hold made before the busy time came is not confirmed over it.
    const desk = await resource('desk-busy');
    const held = (await call('POST', '/v1/holds', { resource_id: desk, start: at(20), end: at(21), ttl_seconds: 600 })).body.hold as { id: string };
    expect((await busy(desk, at(20), at(22))).status).toBe(200);
    expect((await call('POST', `/v1/holds/${held.id}/confirm`, {})).body).toMatchObject({ error: { code: 'overlap' } });

    // A series rolled on into reported busy time is a conflict: nothing booked over it.
    const DAY = 86_400_000;
    const room = await resource('room-roll');
    const horizon = calendarEventRollingHorizon();
    const first = new Date(horizon.start.getTime() + 2 * DAY + 10 * HOUR);
    const series = await store.withTenant(tenantRef, (tenant) =>
      tenant.putCalendarEvent({
        tenantRef, ownerRef: `agent:${'b'.repeat(64)}`, externalRef: 'daily', idempotencyKey: 'daily', expectedRevision: 0,
        resourceId: room, start: first, end: new Date(first.getTime() + HOUR), timezone: 'UTC', summary: 'Daily',
        recurrence: { rrule: 'FREQ=DAILY' }, materializationWindow: horizon, enforceBookingRules: true,
      }),
    );
    expect(series.ok).toBe(true);
    const beyond = new Date(Date.UTC(horizon.end.getUTCFullYear(), horizon.end.getUTCMonth(), horizon.end.getUTCDate()) + 5 * DAY);
    const blocked = { start: beyond, end: new Date(beyond.getTime() + 5 * DAY) };
    await store.withTenant(tenantRef, (tenant) =>
      tenant.replaceSourceBusy({ tenantRef, resourceId: room, source: 'google:room', window: blocked, revision: 1, busy: [blocked] }),
    );
    const rolled = await store.withTenant(tenantRef, (tenant) =>
      tenant.rollCalendarEventHorizon({ tenantRef, window: calendarEventRollingHorizon(new Date(Date.now() + 12 * DAY)) }),
    );
    expect(rolled).toMatchObject({ extended: 0, conflicts: 1 });
    const [over] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM slotlock.reservations booking JOIN slotlock.source_busy busy
          ON busy.resource_id = booking.resource_id AND busy.starts_at < booking.ends_at AND busy.ends_at > booking.starts_at
       WHERE booking.resource_id = ${room}`;
    expect(over?.n).toBe(0);

    // Busy time that ended a month ago goes in retention.
    await sql`UPDATE slotlock.source_busy SET starts_at = now() - interval '40 days', ends_at = now() - interval '39 days'
               WHERE resource_id = ${desk}`;
    await store.withTenant(tenantRef, (tenant) => tenant.pruneBookingRetention({ tenantRef }));
    const [left] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM slotlock.source_busy WHERE resource_id = ${desk}`;
    expect(left?.n).toBe(0);
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

    // When each channel's answer was given is kept while it stands, and changes when it does.
    await call('PUT', '/v1/contacts/consent-1', { email: 'c1@example.com', phone: '+447700900321', consent: { email: true, sms: false } });
    const first = (await call('GET', '/v1/contacts/consent-1')).body.contact as { consent_at: Record<string, string> };
    expect(Object.keys(first.consent_at).sort()).toEqual(['email', 'sms']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = (await call('PUT', '/v1/contacts/consent-1', { email: 'c1@example.com', phone: '+447700900321', consent: { email: true, sms: true } }))
      .body.contact as { consent_at: Record<string, string> };
    expect(second.consent_at.email).toBe(first.consent_at.email);
    expect(Date.parse(second.consent_at.sms as string)).toBeGreaterThan(Date.parse(first.consent_at.sms as string));
    // Listed by reference, a page at a time.
    const pageOne = (await call('GET', '/v1/contacts?limit=1')).body as { contacts: { contact_ref: string }[]; next_cursor: string | null };
    expect(pageOne.contacts.map((contact) => contact.contact_ref)).toEqual(['consent-1']);
    const pageTwo = (await call('GET', `/v1/contacts?limit=1&cursor=${pageOne.next_cursor}`)).body as { contacts: { contact_ref: string }[] };
    expect(pageTwo.contacts.map((contact) => contact.contact_ref)).toEqual(['customer-42']);

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
    // Once booked, the same payment told again is the one recorded, not a refusal to refund.
    expect((await call('POST', `/v1/holds/${held.id}/paid`, { payment_ref: 'pi_123' })).body).toMatchObject({ replayed: true });

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

    // A booking's reminders too, naming whom to tell; not for one that says to tell no one.
    const book = (ref: string, startIn: number, extra: Record<string, unknown> = {}) =>
      call('PUT', `/v1/reservations/${ref}`, {
        resource_id: studio.id,
        start: soon(startIn).toISOString(),
        end: soon(startIn + 30).toISOString(),
        revision: 1,
        contact_ref: 'guest-1',
        ...extra,
      });
    expect((await book('bk-remind', 200, { reminder_minutes: [240, 15] })).body.reservation).toMatchObject({ reminder_minutes: [240, 15] });
    expect((await book('bk-quiet', 300, { reminder_minutes: [360], notify: false })).status).toBe(200);
    expect((await book('bk-bad', 400, { reminder_minutes: [10, 10] })).status).toBe(400);
    expect(await maintain()).toBe(1);
    expect(await maintain()).toBe(0);
    const [booked] = (await feed('reminder.due')).filter((change) => change.subject === 'bk-remind');
    expect(booked?.data).toMatchObject({ reference: 'bk-remind', contact_ref: 'guest-1', minutes_before_start: 240, ordinal: 0 });

    // A reminder added, the booking not moved: what was said is not said again. Kept by its place
    // in the list, every reminder after the new one was said a second time.
    const remindedOf = async () =>
      (await feed('reminder.due')).filter((change) => change.subject === 'bk-remind').map((change) => change.data.minutes_before_start);
    const rebook = (revision: number, startIn: number, reminders: number[]) =>
      call('PUT', '/v1/reservations/bk-remind', {
        resource_id: studio.id,
        start: soon(startIn).toISOString(),
        end: soon(startIn + 30).toISOString(),
        revision,
        contact_ref: 'guest-1',
        reminder_minutes: reminders,
      });
    expect((await rebook(2, 200, [1_380, 240, 15])).status).toBe(200);
    expect(await maintain()).toBe(1);
    expect(await maintain()).toBe(0);
    expect(await remindedOf()).toEqual([240, 1_380]);
    // Moved: due at other times, said again.
    expect((await rebook(3, 210, [1_380, 240, 15])).status).toBe(200);
    expect(await maintain()).toBe(2);
    expect(await remindedOf()).toEqual([240, 1_380, 1_380, 240]);
  });
  it('checks what a hold is paid, and lets an agent hold time that waits for payment', async () => {
    const bay = await resource('bay-pay');
    const priced = (await call('POST', '/v1/holds', {
      resource_id: bay,
      start: at(9),
      end: at(10),
      ttl_seconds: 900,
      payment_required: true,
      payment: { amount_minor: 4500, currency: 'GBP' },
    })).body.hold as { id: string };
    expect(priced).toMatchObject({ payment_amount: { amount_minor: 4500, currency: 'GBP' }, paid_amount: null });
    const pay = (received?: unknown) =>
      call('POST', `/v1/holds/${priced.id}/paid`, { payment_ref: 'pi_x', ...(received ? { received } : {}) });
    expect((await pay()).body).toMatchObject({ error: { code: 'payment_amount_mismatch' } });
    expect((await pay({ amount_minor: 4499, currency: 'GBP' })).body).toMatchObject({ error: { code: 'payment_amount_mismatch' } });
    expect((await pay({ amount_minor: 4500, currency: 'EUR' })).body).toMatchObject({ error: { code: 'payment_amount_mismatch' } });
    expect((await pay({ amount_minor: 4500, currency: 'GBP' })).body).toMatchObject({ hold: { paid_amount: { amount_minor: 4500, currency: 'GBP' } } });
    expect((await call('POST', '/v1/holds', { resource_id: bay, start: at(11), end: at(12), ttl_seconds: 60, payment: { amount_minor: 1, currency: 'GBP' } })).status).toBe(400);

    const agent = (operation: string, input: Record<string, unknown>) =>
      invokeSlotlockAgentOperation({
        operation: operation as never,
        input,
        request: new Request(BASE),
        options: {
          backend: agentBackend,
          authenticate: async () => ({ subject: 'agent-pay', tenantRef, scopes: ['read', 'write'] }),
          authorize: async () => true,
        },
      }) as Promise<{ ok: boolean; code?: string; data?: Record<string, unknown> }>;
    // The price is the tenant's (hold_price), never the agent's own.
    const named = await agent('slotlock_hold_slots', {
      slots: [{ resource_id: bay, start: at(13), end: at(14) }],
      ttl_seconds: 600,
      idempotency_key: 'agent-pay-0',
      payment_required: true,
      payment: { amount_minor: 2000, currency: 'GBP' },
    });
    expect(named.data).toMatchObject({ holds: [], refused: [{ code: 'payment_price_mismatch' }] });
    expect(
      (await call('PUT', `/v1/resources/${bay}/booking-rules`, { rules: { hold_price: { amount_minor: 2000, currency: 'GBP' } } })).status,
    ).toBe(200);
    const cheap = await agent('slotlock_hold_slots', {
      slots: [{ resource_id: bay, start: at(13), end: at(14) }],
      ttl_seconds: 600,
      idempotency_key: 'agent-pay-cheap',
      payment_required: true,
      payment: { amount_minor: 1, currency: 'GBP' },
    });
    expect(cheap.data).toMatchObject({ holds: [], refused: [{ code: 'payment_price_mismatch' }] });
    // Nor can it book the priced time without a paid hold of it.
    expect(
      await agent('slotlock_create_event', {
        resource_id: bay, starts_at: at(15), ends_at: at(16), timezone: 'UTC', title: 'Unpaid', idempotency_key: 'agent-pay-direct',
      }),
    ).toMatchObject({ ok: false, code: 'payment_required' });
    // Held without naming a price, it waits for the tenant's.
    const held = await agent('slotlock_hold_slots', {
      slots: [{ resource_id: bay, start: at(13), end: at(14) }],
      ttl_seconds: 600,
      idempotency_key: 'agent-pay-1',
    });
    const hold = (held.data?.holds as { hold_id: string }[])[0];
    expect(hold).toMatchObject({ payment_required: true, payment_amount: { amount_minor: 2000, currency: 'GBP' } });
    const book = () => agent('slotlock_confirm_slot', { hold_id: hold?.hold_id, idempotency_key: 'agent-pay-book' });
    expect(await book()).toMatchObject({ ok: false, code: 'payment_required' });
    // The system the agent books for records the payment; the agent books it.
    expect((await call('POST', `/v1/holds/${hold?.hold_id}/paid`, { payment_ref: 'pi_y', received: { amount_minor: 2000, currency: 'GBP' } })).status).toBe(200);
    expect(await book()).toMatchObject({ ok: true });
    // Booked as an event, the hold's row is gone; its payment told again is still the one recorded.
    expect((await call('POST', `/v1/holds/${hold?.hold_id}/paid`, { payment_ref: 'pi_y', received: { amount_minor: 2000, currency: 'GBP' } })).body).toMatchObject({
      replayed: true,
      hold: { payment_ref: 'pi_y' },
    });
    expect((await call('POST', `/v1/holds/${hold?.hold_id}/paid`, { payment_ref: 'pi_z' })).body).toMatchObject({ error: { code: 'payment_conflict' } });
    // And the hold confirmed in place answers the same.
    expect((await call('POST', `/v1/holds/${priced.id}/confirm`, {})).status).toBe(200);
    expect((await call('POST', `/v1/holds/${priced.id}/paid`, { payment_ref: 'pi_x', received: { amount_minor: 4500, currency: 'GBP' } })).body).toMatchObject({
      replayed: true,
    });
  });
});
