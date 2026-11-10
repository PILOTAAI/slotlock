// @slotlock/notify against a real Slotlock (in process, on real Postgres), with its own ledger in
// Postgres and capture channels: a booking's contact is told on the channels they agreed to, once,
// however often the feed is read; an event's attendees are told, reminded and told of its
// cancellation; notify: false tells no one; a test tenant's messages never reach a real channel.
// Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer } from '../../../src/agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../../../src/agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../../../src/store.js';
import { captureChannel, createNotifier, createPostgresLedger } from './index.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];

describe.skipIf(!url)('@slotlock/notify with Slotlock (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const tenantRef = `notify-${randomUUID()}`;
  const testTenant = `${tenantRef}~test`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    live: { subject: 'api_key:notify', tenantRef, scopes: ['read', 'write', 'admin'] },
    test: { subject: 'api_key:notify-test', tenantRef: testTenant, scopes: ['read', 'write', 'admin'] },
  };
  const send = (async (input: string | URL | Request, init?: RequestInit) =>
    server.fetch(new Request(String(input instanceof Request ? input.url : input), init))) as typeof fetch;
  const call = async (key: string, method: string, path: string, body?: unknown) => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const live = { email: captureChannel('email'), sms: captureChannel('sms'), whatsapp: captureChannel('whatsapp') };
  const inbox = { email: captureChannel('email'), sms: captureChannel('sms') };

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
    await sql`DELETE FROM slotlock_notify.sends WHERE tenant_ref IN (${tenantRef}, ${testTenant})`;
    await sql`DELETE FROM slotlock_notify.cursors WHERE tenant_ref IN (${tenantRef}, ${testTenant})`;
    for (const each of [tenantRef, testTenant]) await sql`SELECT * FROM slotlock.erase_tenant(${each}::text)`;
    await sql.end();
  });

  it('tells each person once, on the channels they agreed to, and no one when told not to', async () => {
    const ledger = createPostgresLedger(sql);
    await ledger.applySchema();
    const notifier = createNotifier({
      ledger,
      slotlockUrl: BASE,
      fetch: send,
      channels: live,
      testChannels: inbox,
      tenant: async (ref) => ({
        apiKey: ref === tenantRef ? 'live' : 'test',
        name: 'Fleet Co',
        from: { email: 'bookings@fleet.example', sms: '+447700900999', whatsapp: '+447700900998' },
      }),
    });
    const day = Date.UTC(new Date().getUTCFullYear() + 1, 3, 5);
    const at = (hour: number) => new Date(day + hour * HOUR).toISOString();
    const van = ((await call('live', 'POST', '/v1/resources', { external_ref: 'van-42', timezone: 'Europe/London', name: 'Van 42' })).body
      .resource as { id: string }).id;
    await call('live', 'PUT', '/v1/contacts/ada', { name: 'Ada', email: 'ada@example.com', phone: '+447700900123', consent: { sms: true } });
    await call('live', 'PUT', '/v1/reservations/bk-1', { resource_id: van, start: at(9), end: at(10), revision: 1, contact_ref: 'ada' });
    await call('live', 'PUT', '/v1/reservations/bk-quiet', { resource_id: van, start: at(12), end: at(13), revision: 1, contact_ref: 'ada', notify: false });

    expect(await notifier.poll(tenantRef)).toMatchObject({ sent: 2, failed: 0 });
    expect(live.email.messages).toHaveLength(1);
    expect(live.email.messages[0]).toMatchObject({ to: 'ada@example.com', from: 'bookings@fleet.example' });
    expect(live.email.messages[0]?.subject).toContain('Booked: Van 42');
    expect(live.email.messages[0]?.html).toContain('bk-1');
    expect(live.sms.messages.map((message) => message.to)).toEqual(['+447700900123']);
    expect(live.whatsapp.messages).toHaveLength(0);

    // Read again from the start: nothing is sent twice.
    await sql`DELETE FROM slotlock_notify.cursors WHERE tenant_ref = ${tenantRef}`;
    expect((await notifier.poll(tenantRef)).sent).toBe(0);

    // Moved, then cancelled: told each.
    await call('live', 'PUT', '/v1/reservations/bk-1', { resource_id: van, start: at(11), end: at(12), revision: 2, contact_ref: 'ada' });
    await call('live', 'DELETE', '/v1/reservations/bk-1?revision=3');
    await notifier.poll(tenantRef);
    expect(live.email.messages.map((message) => message.subject.split(':')[0])).toEqual(['Booked', 'Moved', 'Cancelled']);
    expect(live.email.messages[1]?.text).toContain('it was');

    // An event's attendees: booked, reminded, and told of its cancellation after it is gone.
    const soon = Math.floor(Date.now() / 1_000) * 1_000 + 20 * 60_000;
    const event = await store.withTenant(tenantRef, (tenant) =>
      tenant.putCalendarEvent({
        tenantRef,
        externalRef: 'session',
        resourceId: van,
        expectedRevision: 0,
        idempotencyKey: 'session-1',
        start: new Date(soon),
        end: new Date(soon + HOUR),
        timezone: 'Europe/London',
        summary: 'Hand-over',
        attendees: [{ email: 'bo@example.com', name: 'Bo' }],
        reminders: [{ action: 'email', minutesBeforeStart: 60 }],
      }),
    );
    expect(event.ok).toBe(true);
    await call('live', 'POST', '/v1/maintenance', {});
    await notifier.poll(tenantRef);
    const toBo = () => live.email.messages.filter((message) => message.to === 'bo@example.com').map((message) => message.subject.split(':')[0]);
    expect(toBo()).toEqual(['Booked', 'Reminder']);
    await store.withTenant(tenantRef, (tenant) =>
      tenant.cancelCalendarEvent({ tenantRef, externalRef: 'session', idempotencyKey: 'session-cancel', expectedRevision: 1 }),
    );
    await notifier.poll(tenantRef);
    expect(toBo()).toEqual(['Booked', 'Reminder', 'Cancelled']);
    const [remembered] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock_notify.event_recipients WHERE tenant_ref = ${tenantRef}`;
    expect(remembered?.count).toBe(0);
    // The ledger keeps no address.
    const [stored] = await sql<{ rows: string }[]>`SELECT string_agg(recipient, ',') AS rows FROM slotlock_notify.sends WHERE tenant_ref = ${tenantRef}`;
    expect(stored?.rows).not.toContain('@');

    // A test tenant's messages go to its inbox only.
    const testVan = ((await call('test', 'POST', '/v1/resources', { external_ref: 'van-t', timezone: 'UTC' })).body.resource as { id: string }).id;
    await call('test', 'PUT', '/v1/contacts/ada', { email: 'ada@example.com' });
    await call('test', 'PUT', '/v1/reservations/t-1', { resource_id: testVan, start: at(9), end: at(10), revision: 1, contact_ref: 'ada' });
    const before = live.email.messages.length;
    expect((await notifier.poll(testTenant)).sent).toBe(1);
    expect(inbox.email.messages).toHaveLength(1);
    expect(live.email.messages).toHaveLength(before);
  });
});
