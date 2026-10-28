// The event feed against real Postgres: every change to holds, bookings and events is appended in
// its own transaction, read in an order no late commit can skip, and delivered to webhooks signed
// as Standard Webhooks (checked with its reference library), at least once per webhook-id and in
// order, through a worker that stops mid-batch. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import {
  createSlotlockWebhookSender,
  deliverSlotlockWebhooks,
  slotlockCloudEvent,
} from '../webhooks.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;

interface Received {
  id: string;
  type: string;
  subject: string;
}

describe.skipIf(!url)('the event feed (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: Server;
  let endpoint: string;
  const received: Received[] = [];
  let answer: (index: number) => number = () => 200;
  let secret = '';
  const tenantRef = `feed-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 4, 3, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR);

  beforeAll(async () => {
    sql = postgres(url as string, { max: 6, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const status = answer(received.length);
        if (status === 200) {
          // Throws unless the signature, id and timestamp are what Standard Webhooks expects.
          const event = new Webhook(secret).verify(body, request.headers as Record<string, string>) as Received;
          expect(request.headers['content-type']).toBe('application/cloudevents+json');
          received.push({ id: request.headers['webhook-id'] as string, type: event.type, subject: event.subject });
        }
        response.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  async function van() {
    return (await store.createResource({ tenantRef, externalRef: `van-${randomUUID()}`, timezone: 'UTC' })).id;
  }

  async function changes(after?: string) {
    const page = await store.listChanges({ tenantRef, ...(after ? { after } : {}), limit: 500 });
    if (!page.ok) throw new Error(page.code);
    return page;
  }

  it('records each change to holds, bookings and events, without titles', async () => {
    const start = (await changes()).next;
    const id = await van();
    const held = await store.acquireHold({ tenantRef, resourceId: id, start: at(1), end: at(2), ttlMs: 60_000 });
    if (!held.ok) throw new Error(held.code);
    await store.confirmHold(held.hold.id, { tenantRef });
    const other = await store.acquireHold({ tenantRef, resourceId: id, start: at(3), end: at(4), ttlMs: 60_000 });
    if (!other.ok) throw new Error(other.code);
    await store.releaseHold(other.hold.id, { tenantRef });
    const booked = await store.createExternalReservation({
      tenantRef, externalRef: 'BK-1', resourceId: id, start: at(5), end: at(6), bufferAfterMs: 0, revision: 1,
    });
    expect(booked.ok).toBe(true);
    await store.rescheduleExternalReservation({
      tenantRef, externalRef: 'BK-1', resourceId: id, start: at(7), end: at(8), bufferAfterMs: 0, revision: 2,
    });
    await store.cancelExternalReservation({ tenantRef, externalRef: 'BK-1', revision: 3 });
    const event = await store.putCalendarEvent({
      tenantRef,
      externalRef: 'ev-1',
      resourceId: id,
      expectedRevision: 0,
      idempotencyKey: 'ev-1-create',
      start: at(10),
      end: at(11),
      timezone: 'UTC',
      summary: 'Private handover for Ms Example',
    });
    expect(event.ok).toBe(true);

    const page = await changes(start);
    expect(page.changes.map((change) => change.type)).toEqual([
      'hold.created',
      'hold.confirmed',
      'hold.created',
      'hold.released',
      'reservation.created',
      'reservation.updated',
      'reservation.cancelled',
      'event.created',
    ]);
    const created = page.changes.find((change) => change.type === 'event.created');
    expect(created?.data).toMatchObject({ resource_id: id, revision: 1, transparency: 'opaque' });
    expect(JSON.stringify(page.changes)).not.toContain('Ms Example');
    expect(page.changes[4]).toMatchObject({ subject: 'BK-1', resourceId: id });
    expect(slotlockCloudEvent(page.changes[0] as never)).toMatchObject({
      specversion: '1.0',
      type: 'io.pylota.slotlock.hold.created',
      source: `/slotlock/resources/${id}`,
    });
    // Following the cursor from the last one finds nothing new.
    expect((await changes(page.next)).changes).toEqual([]);
  });

  it('never lets a transaction that commits late fall behind a position a reader passed', async () => {
    const id = await van();
    const start = (await changes()).next;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let begun!: () => void;
    const started = new Promise<void>((resolve) => {
      begun = resolve;
    });
    // The first transaction takes its id first and commits last.
    const early = sql.begin(async (tx) => {
      await tx`SELECT pg_current_xact_id()`;
      begun();
      await gate;
      await tx`INSERT INTO slotlock.reservations (resource_id, tenant_ref, external_ref, starts_at, ends_at, occupied_ends_at)
                VALUES (${id}, ${tenantRef}, 'late', ${at(20)}, ${at(21)}, ${at(21)})`;
    });
    await started;
    await store.createExternalReservation({
      tenantRef, externalRef: 'prompt', resourceId: id, start: at(22), end: at(23), bufferAfterMs: 0, revision: 1,
    });
    // The prompt one has committed, but a reader does not pass the open transaction before it.
    const meanwhile = await changes(start);
    expect(meanwhile.changes).toEqual([]);
    release();
    await early;
    expect((await changes(meanwhile.next)).changes.map((change) => change.subject)).toEqual(['late', 'prompt']);
  });

  it('delivers in order, signed, again after a worker stops mid-batch, and disables an endpoint that is gone', async () => {
    const created = await store.createWebhookEndpoint({ tenantRef, url: endpoint, eventTypes: ['reservation.created'] });
    if (!created.ok) throw new Error(created.code);
    secret = created.secret;
    expect((await store.listWebhookEndpoints({ tenantRef })).map((hook) => hook.url)).toContain(endpoint);
    const id = await van();
    for (const n of [1, 2, 3]) {
      await store.createExternalReservation({
        tenantRef, externalRef: `W-${n}`, resourceId: id, start: at(30 + n), end: at(31 + n), bufferAfterMs: 0, revision: 1,
      });
    }
    const send = createSlotlockWebhookSender({ allowPrivateNetworks: true, timeoutMs: 5_000 });

    // The worker dies after the second POST: its claim is never settled.
    let calls = 0;
    const dying = async (request: Parameters<typeof send>[0]) => {
      calls++;
      if (calls === 3) throw new Error('worker killed');
      return send(request);
    };
    await expect(
      deliverSlotlockWebhooks({
        feed: { ...store, settleWebhookDelivery: async () => { throw new Error('worker killed'); } },
        tenantRef,
        send: dying,
        leaseMs: 1_000,
      }),
    ).rejects.toThrow('worker killed');
    expect(received.map((delivery) => delivery.subject)).toEqual(['W-1', 'W-2']);

    // Once the lease runs out another worker sends from the start of the claim, with the same ids.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const pass = await deliverSlotlockWebhooks({ feed: store, tenantRef, send });
    expect(pass).toEqual({ delivered: 3, failed: 0 });
    expect(received.map((delivery) => delivery.subject)).toEqual(['W-1', 'W-2', 'W-1', 'W-2', 'W-3']);
    expect(new Set(received.map((delivery) => delivery.id)).size).toBe(3);
    expect(received.every((delivery) => delivery.type === 'io.pylota.slotlock.reservation.created')).toBe(true);
    expect(await deliverSlotlockWebhooks({ feed: store, tenantRef, send })).toEqual({ delivered: 0, failed: 0 });

    // A failure is retried later, not now; 410 disables the endpoint and the feed says so.
    answer = () => 503;
    await store.createExternalReservation({
      tenantRef, externalRef: 'W-4', resourceId: id, start: at(40), end: at(41), bufferAfterMs: 0, revision: 1,
    });
    expect(await deliverSlotlockWebhooks({ feed: store, tenantRef, send })).toEqual({ delivered: 0, failed: 1 });
    expect(await deliverSlotlockWebhooks({ feed: store, tenantRef, send })).toEqual({ delivered: 0, failed: 0 });
    const [failing] = await store.listWebhookEndpoints({ tenantRef });
    expect(failing).toMatchObject({ attempts: 1, lastStatus: 503, disabledAt: null });
    await sql`UPDATE slotlock.webhook_endpoints SET next_attempt_at = now() WHERE tenant_ref = ${tenantRef}`;
    answer = () => 410;
    expect(await deliverSlotlockWebhooks({ feed: store, tenantRef, send })).toEqual({ delivered: 0, failed: 1 });
    const [gone] = await store.listWebhookEndpoints({ tenantRef });
    expect(gone).toMatchObject({ disabledReason: 'gone' });
    expect(gone?.disabledAt).toBeInstanceOf(Date);
    const tail = await changes();
    expect(tail.changes.at(-1)).toMatchObject({ type: 'webhook.disabled', data: { reason: 'gone', last_status: 410 } });
    // The id alone: the feed goes to the tenant's other endpoints, and a URL can carry a token.
    expect(tail.changes.at(-1)?.data).not.toHaveProperty('url');

    // Enabled again, it carries on from where it stopped.
    answer = () => 200;
    await store.enableWebhookEndpoint({ tenantRef, id: gone?.id as string });
    expect(await deliverSlotlockWebhooks({ feed: store, tenantRef, send })).toEqual({ delivered: 1, failed: 0 });
    expect(received.at(-1)?.subject).toBe('W-4');
  });

  it('refuses a URL that is not https or a private address, a bad cursor, and an old one', async () => {
    expect(await store.createWebhookEndpoint({ tenantRef, url: 'http://example.com/hook' })).toEqual({
      ok: false,
      code: 'invalid_webhook_url',
    });
    expect(await store.createWebhookEndpoint({ tenantRef, url: 'https://example.com/h', eventTypes: ['nope'] })).toEqual({
      ok: false,
      code: 'invalid_event_types',
    });
    await expect(
      createSlotlockWebhookSender()({ url: 'https://127.0.0.1/hook', headers: {}, body: '{}' }),
    ).rejects.toMatchObject({ code: 'webhook_private_address' });
    await expect(
      createSlotlockWebhookSender()({ url: 'https://localhost:1/hook', headers: {}, body: '{}' }),
    ).rejects.toMatchObject({ code: 'webhook_private_address' });
    expect(await store.listChanges({ tenantRef, after: 'not-a-cursor!' })).toEqual({ ok: false, code: 'invalid_cursor' });
    const old = Buffer.from(`1:1:1:${Date.now() - 31 * 86_400_000}`).toString('base64url');
    expect(await store.listChanges({ tenantRef, after: old })).toEqual({ ok: false, code: 'cursor_expired' });
  });

  it('keeps what an enabled webhook has not received, and will not skip what one disabled missed', async () => {
    const other = `feed-keep-${randomUUID()}`;
    const resource = await store.createResource({ tenantRef: other, externalRef: 'v', timezone: 'UTC' });
    const hook = await store.createWebhookEndpoint({ tenantRef: other, url: 'https://example.com/hook' });
    if (!hook.ok) throw new Error(hook.code);
    await store.createExternalReservation({
      tenantRef: other, externalRef: 'K-1', resourceId: resource.id, start: at(60), end: at(61), bufferAfterMs: 0, revision: 1,
    });
    await sql`UPDATE slotlock.outbox SET occurred_at = now() - interval '30 days' WHERE tenant_ref = ${other}`;
    // Past the retention, but the enabled webhook has not had it: it stays.
    expect(await store.pruneChanges({ tenantRef: other, limit: 100 })).toBe(0);
    // Disabled long ago, the change it missed is pruned, and enabling it would skip it unseen.
    await sql`UPDATE slotlock.webhook_endpoints
                 SET disabled_at = now() - interval '20 days'
               WHERE tenant_ref = ${other}`;
    expect(await store.pruneChanges({ tenantRef: other, limit: 100 })).toBeGreaterThan(0);
    expect(await store.enableWebhookEndpoint({ tenantRef: other, id: hook.endpoint.id })).toEqual({
      code: 'changes_pruned',
    });
    // Its last webhook gone, the tenant is off the list servers deliver for.
    const listed = async () =>
      (await sql<{ t: string }[]>`SELECT slotlock.webhook_tenants(${null}::text) AS t`).map(({ t }) => t);
    expect(await listed()).toContain(other);
    expect(await store.deleteWebhookEndpoint({ tenantRef: other, id: hook.endpoint.id })).toEqual({ deleted: true });
    expect(await listed()).not.toContain(other);
    await store.eraseTenant({ tenantRef: other });
  });

  it('keeps history as long as the store is told, and reaches back as far', async () => {
    const other = `feed-retain-${randomUUID()}`;
    const resource = await store.createResource({ tenantRef: other, externalRef: 'v', timezone: 'UTC' });
    await store.createExternalReservation({
      tenantRef: other, externalRef: 'R-1', resourceId: resource.id, start: at(70), end: at(71), bufferAfterMs: 0, revision: 1,
    });
    await sql`UPDATE slotlock.outbox SET occurred_at = now() - interval '45 days' WHERE tenant_ref = ${other}`;
    const yearLong = createSlotlockStore(sql, { retentionDays: 365 });
    const weekLong = createSlotlockStore(sql, { retentionDays: 7 });
    // Kept a year, a 45-day-old change stays, and a cursor from then still reads.
    expect(await yearLong.pruneChanges({ tenantRef: other, limit: 100 })).toBe(0);
    const old = Buffer.from(`1:1:1:${Date.now() - 45 * 86_400_000}`).toString('base64url');
    expect(await yearLong.listChanges({ tenantRef: other, after: old })).toMatchObject({ ok: true });
    expect(await store.listChanges({ tenantRef: other, after: old })).toEqual({ ok: false, code: 'cursor_expired' });
    // Kept a week, an 8-day-old cursor is expired, and the change is pruned.
    const week = Buffer.from(`1:1:1:${Date.now() - 8 * 86_400_000}`).toString('base64url');
    expect(await weekLong.listChanges({ tenantRef: other, after: week })).toEqual({ ok: false, code: 'cursor_expired' });
    expect(await weekLong.pruneChanges({ tenantRef: other, limit: 100 })).toBeGreaterThan(0);
    expect(() => createSlotlockStore(sql, { retentionDays: 0 })).toThrow(/retentionDays/);
    expect(() => createSlotlockStore(sql, { retentionDays: 3_651 })).toThrow(/retentionDays/);
    await store.eraseTenant({ tenantRef: other });
  });

  it('is erased with the tenant', async () => {
    const other = `feed-erase-${randomUUID()}`;
    const resource = await store.createResource({ tenantRef: other, externalRef: 'v', timezone: 'UTC' });
    await store.createExternalReservation({
      tenantRef: other, externalRef: 'E-1', resourceId: resource.id, start: at(50), end: at(51), bufferAfterMs: 0, revision: 1,
    });
    await store.createWebhookEndpoint({ tenantRef: other, url: 'https://example.com/hook' });
    const erased = await store.eraseTenant({ tenantRef: other });
    expect(erased.rows).toMatchObject({ outbox: expect.any(Number), webhook_endpoints: 1 });
    expect(erased.rows.outbox).toBeGreaterThan(0);
    const left = await sql`SELECT 1 FROM slotlock.outbox WHERE tenant_ref = ${other}
                           UNION ALL SELECT 1 FROM slotlock.webhook_endpoints WHERE tenant_ref = ${other}`;
    expect(left).toHaveLength(0);
    expect(await sql`SELECT slotlock.webhook_tenants(${null}::text) AS t`).not.toContainEqual({ t: other });
  });
});
