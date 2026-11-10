// @slotlock/notify against a real Slotlock (in process, on real Postgres), with its own ledger in
// Postgres and capture channels: a booking's contact is told on the channels they agreed to, once,
// however often the feed is read; an event's attendees are told, reminded and told of its
// cancellation; notify: false tells no one; a test tenant's messages never reach a real channel.
// Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer } from '../../../src/agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../../../src/agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../../../src/store.js';
import { signSlotlockWebhook } from '../../../src/webhooks.js';
import { captureChannel, createNotifier, createNotifyHttpHandler, createPostgresLedger, parseSealKeys } from './index.js';

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
  const send = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    // A cursor the feed no longer keeps, as Slotlock answers one.
    if (target.includes('cursor=expired-cursor')) {
      return new Response(JSON.stringify({ error: { code: 'cursor_expired' } }), { status: 410, headers: { 'content-type': 'application/json' } });
    }
    return server.fetch(new Request(target, init));
  }) as typeof fetch;
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
    const ledger = createPostgresLedger(sql, { keys: parseSealKeys(`k1:${randomBytes(32).toString('base64')}`) });
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

    // A booking's own reminders reach its contact, on the channels they agreed to.
    await call('live', 'PUT', '/v1/reservations/bk-remind', {
      resource_id: van,
      start: new Date(soon + 2 * HOUR).toISOString(),
      end: new Date(soon + 3 * HOUR).toISOString(),
      revision: 1,
      contact_ref: 'ada',
      reminder_minutes: [180],
    });
    await call('live', 'POST', '/v1/maintenance', {});
    await notifier.poll(tenantRef);
    expect(live.email.messages.at(-1)?.subject).toMatch(/^Reminder: Van 42/);
    expect(live.sms.messages.at(-1)?.text).toMatch(/^Reminder: Van 42/);

    // A test tenant's messages go to its inbox only.
    const testVan = ((await call('test', 'POST', '/v1/resources', { external_ref: 'van-t', timezone: 'UTC' })).body.resource as { id: string }).id;
    await call('test', 'PUT', '/v1/contacts/ada', { email: 'ada@example.com' });
    await call('test', 'PUT', '/v1/reservations/t-1', { resource_id: testVan, start: at(9), end: at(10), revision: 1, contact_ref: 'ada' });
    const before = live.email.messages.length;
    expect((await notifier.poll(testTenant)).sent).toBe(1);
    expect(inbox.email.messages).toHaveLength(1);
    expect(live.email.messages).toHaveLength(before);
  });

  it('takes signed deliveries, keeps attendees sealed, and sends nothing stale after a gap', async () => {
    const keys = parseSealKeys(`k1:${randomBytes(32).toString('base64')}`);
    const ledger = createPostgresLedger(sql, { keys });
    const mail = captureChannel('email');
    let clock = new Date();
    const notifier = createNotifier({
      ledger,
      slotlockUrl: BASE,
      fetch: send,
      channels: { email: mail },
      testChannels: {},
      now: () => clock,
      tenant: async (ref) => (ref === tenantRef ? { apiKey: 'live', name: 'Fleet Co', from: { email: 'bookings@fleet.example' } } : null),
    });
    const desk = ((await call('live', 'POST', '/v1/resources', { external_ref: 'desk-9', timezone: 'UTC' })).body.resource as { id: string }).id;
    const start = Math.floor(Date.now() / 1_000) * 1_000 + 3 * 24 * HOUR;
    // Made before the notifier first looks: its attendees are kept for its cancellation, sealed.
    expect(
      (
        await store.withTenant(tenantRef, (tenant) =>
          tenant.putCalendarEvent({
            tenantRef,
            externalRef: 'early',
            resourceId: desk,
            expectedRevision: 0,
            idempotencyKey: 'early-1',
            start: new Date(start),
            end: new Date(start + HOUR),
            timezone: 'UTC',
            summary: 'Review',
            attendees: [{ email: 'cy@example.com' }],
          }),
        )
      ).ok,
    ).toBe(true);
    expect(await notifier.rememberUpcoming(tenantRef)).toBeGreaterThan(0);
    const [kept] = await sql<{ sealed: string; expires_at: Date }[]>`
      SELECT sealed, expires_at FROM slotlock_notify.event_recipients WHERE tenant_ref = ${tenantRef}`;
    expect(kept?.sealed).not.toContain('@');
    expect(kept?.expires_at.getTime()).toBe(start + HOUR + 24 * HOUR);

    // A webhook delivery, signed with the tenant's secret: the cancellation reaches the attendee.
    const secret = `whsec_${randomBytes(32).toString('base64')}`;
    const http = createNotifyHttpHandler({ notifier, webhookSecret: async (ref) => (ref === tenantRef ? secret : null) });
    await store.withTenant(tenantRef, (tenant) =>
      tenant.cancelCalendarEvent({ tenantRef, externalRef: 'early', idempotencyKey: 'early-cancel', expectedRevision: 1 }),
    );
    const [cancelled] = await sql<{ id: string; type: string; subject: string; data: Record<string, unknown> }[]>`
      SELECT id::text, type, subject, data FROM slotlock.outbox
       WHERE tenant_ref = ${tenantRef} AND type = 'event.cancelled' ORDER BY id DESC LIMIT 1`;
    const body = JSON.stringify({
      id: `msg_${cancelled?.id}`,
      type: 'io.pylota.slotlock.event.cancelled',
      subject: cancelled?.subject,
      time: new Date().toISOString(),
      data: cancelled?.data,
    });
    const timestamp = Math.floor(Date.now() / 1_000);
    const deliver = (signature: string) =>
      http(
        new Request(`https://notify.example/webhooks/${encodeURIComponent(tenantRef)}`, {
          method: 'POST',
          headers: { 'webhook-id': `msg_${cancelled?.id}`, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature },
          body,
        }),
      );
    expect((await deliver('v1,AAAA')).status).toBe(401);
    expect((await deliver(signSlotlockWebhook({ secret, id: `msg_${cancelled?.id}`, timestamp, body }))).status).toBe(200);
    expect(mail.messages.map((message) => [message.to, message.subject.split(':')[0]])).toEqual([['cy@example.com', 'Cancelled']]);
    expect((await http(new Request('https://notify.example/webhooks/someone-else', { method: 'POST', body: '{}' }))).status).toBe(401);

    // The cursor expired while the notifier was away: read again from what the feed keeps, and
    // nothing older than a day is sent.
    await ledger.setCursor(tenantRef, 'expired-cursor');
    clock = new Date(Date.now() + 2 * 24 * HOUR);
    const caughtUp = await notifier.poll(tenantRef);
    expect(caughtUp).toMatchObject({ gap: true, sent: 0 });
    expect(caughtUp.skipped).toBeGreaterThan(0);
    expect(mail.messages).toHaveLength(1);
  });
});
