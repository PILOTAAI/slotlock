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
import { SLOTLOCK_STRUCTURE_DDL } from '../ddl.js';
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
      'resource.created',
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
    expect(page.changes[5]).toMatchObject({ subject: 'BK-1', resourceId: id });
    expect(slotlockCloudEvent(page.changes[1] as never)).toMatchObject({
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
    // How old a cursor is does not matter, only whether a change after it was pruned.
    const old = Buffer.from(`2:1:1:${Date.now() - 31 * 86_400_000}`).toString('base64url');
    expect(await store.listChanges({ tenantRef, after: old })).toMatchObject({ ok: true });
    // But one 0.4 gave expires by its date, as there: 0.4 pruned by age, not in feed order, so
    // what it took is not all before any one position.
    const given = Buffer.from(`1:1:1:${Date.now() - 31 * 86_400_000}`).toString('base64url');
    expect(await store.listChanges({ tenantRef, after: given })).toEqual({ ok: false, code: 'cursor_expired' });
    const recent = Buffer.from(`1:1:1:${Date.now() - 29 * 86_400_000}`).toString('base64url');
    expect(await store.listChanges({ tenantRef, after: recent })).toMatchObject({ ok: true });
  });

  it('keeps what an enabled webhook has not received, and will not skip what one disabled missed', async () => {
    const other = `feed-keep-${randomUUID()}`;
    // The endpoint first, so it is to receive every change after it, the resource's creation too.
    const hook = await store.createWebhookEndpoint({ tenantRef: other, url: 'https://example.com/hook' });
    if (!hook.ok) throw new Error(hook.code);
    const resource = await store.createResource({ tenantRef: other, externalRef: 'v', timezone: 'UTC' });
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
    const first = await yearLong.listChanges({ tenantRef: other });
    if (!first.ok) throw new Error(first.code);
    // Its position carries when it happened, 45 days ago.
    const old = first.changes[0]?.position as string;
    expect(await yearLong.listChanges({ tenantRef: other, after: old })).toMatchObject({ ok: true });
    // However long another store keeps changes: nothing has been pruned, so it reads on too.
    expect(await store.listChanges({ tenantRef: other, after: old })).toMatchObject({ ok: true });
    // Kept a week, the change is pruned, and a cursor from before it is expired, dated now or not.
    expect(await weekLong.pruneChanges({ tenantRef: other, limit: 100 })).toBeGreaterThan(0);
    const before = Buffer.from(`1:1:1:${Date.now()}`).toString('base64url');
    expect(await weekLong.listChanges({ tenantRef: other, after: before })).toEqual({ ok: false, code: 'cursor_expired' });
    // A cursor whose change another store pruned is expired, never read past unseen; one at the
    // last change pruned is not: nothing after it went.
    for (const [index, ref] of ['R-2', 'R-3'].entries()) {
      const made = await store.createExternalReservation({
        tenantRef: other, externalRef: ref, resourceId: resource.id, start: at(72 + index), end: at(73 + index), bufferAfterMs: 0, revision: 1,
      });
      expect(made.ok).toBe(true);
    }
    const page = await yearLong.listChanges({ tenantRef: other });
    if (!page.ok) throw new Error(page.code);
    const cursor = page.changes[0]?.position as string;
    await sql`UPDATE slotlock.outbox SET occurred_at = now() - interval '10 days' WHERE tenant_ref = ${other}`;
    expect(await yearLong.listChanges({ tenantRef: other, after: cursor })).toMatchObject({ ok: true });
    expect(await weekLong.pruneChanges({ tenantRef: other, limit: 100 })).toBeGreaterThan(0);
    expect(await yearLong.listChanges({ tenantRef: other, after: cursor })).toEqual({ ok: false, code: 'cursor_expired' });
    expect(await yearLong.listChanges({ tenantRef: other, after: page.next })).toEqual({ ok: true, changes: [], next: expect.any(String) });
    // An empty feed's cursor names no change, and stays readable.
    const empty = await yearLong.listChanges({ tenantRef: `${other}-empty` });
    if (!empty.ok) throw new Error(empty.code);
    expect(await yearLong.listChanges({ tenantRef: `${other}-empty`, after: empty.next })).toMatchObject({ ok: true });
    expect(() => createSlotlockStore(sql, { retentionDays: 0 })).toThrow(/retentionDays/);
    expect(() => createSlotlockStore(sql, { retentionDays: 3_651 })).toThrow(/retentionDays/);
    await store.eraseTenant({ tenantRef: other });
  });

  it('never reads past a pruned change, however the transactions that made them interleave', async () => {
    const other = `feed-interleave-${randomUUID()}`;
    // Read while the feed is empty: the cursor is before every change still to come.
    const empty = await store.listChanges({ tenantRef: other });
    if (!empty.ok) throw new Error(empty.code);
    const resource = await store.createResource({ tenantRef: other, externalRef: 'v', timezone: 'UTC' });
    for (const [index, ref] of ['R-1', 'R-2'].entries()) {
      const made = await store.createExternalReservation({
        tenantRef: other, externalRef: ref, resourceId: resource.id, start: at(80 + index), end: at(81 + index), bufferAfterMs: 0, revision: 1,
      });
      expect(made.ok).toBe(true);
    }
    const page = await store.listChanges({ tenantRef: other });
    if (!page.ok) throw new Error(page.code);
    // After the resource's own creation.
    const [first, second] = page.changes.filter((change) => change.type === 'reservation.created');
    if (!first || !second) throw new Error('two changes expected');
    // The later change is the older: a transaction that began first and wrote last. Only a prefix
    // in feed order is pruned, so it waits for the one before it, which is still kept.
    await sql`UPDATE slotlock.outbox SET occurred_at = now() - interval '45 days'
               WHERE tenant_ref = ${other} AND id = ${second.id.slice(4)}::bigint`;
    expect(await store.pruneChanges({ tenantRef: other, limit: 100 })).toBe(0);
    // Nothing pruned: no reader is expired, the empty feed's either.
    expect(await store.listChanges({ tenantRef: other, after: first.position })).toMatchObject({ ok: true });
    const fromEmpty = await store.listChanges({ tenantRef: other, after: empty.next });
    expect(fromEmpty.ok && fromEmpty.changes.map((change) => change.subject)).toEqual([resource.id, 'R-1', 'R-2']);
    // Both old: both pruned. A reader behind either is expired; one that had read both is up to
    // date, and stays so.
    await sql`UPDATE slotlock.outbox SET occurred_at = now() - interval '45 days' WHERE tenant_ref = ${other}`;
    // With the resource's creation before them.
    expect(await store.pruneChanges({ tenantRef: other, limit: 100 })).toBe(3);
    expect(await store.listChanges({ tenantRef: other, after: first.position })).toEqual({ ok: false, code: 'cursor_expired' });
    expect(await store.listChanges({ tenantRef: other, after: empty.next })).toEqual({ ok: false, code: 'cursor_expired' });
    const current = await store.listChanges({ tenantRef: other, after: second.position });
    expect(current).toEqual({ ok: true, changes: [], next: expect.any(String) });
    if (!current.ok) throw new Error(current.code);
    expect(await store.listChanges({ tenantRef: other, after: current.next })).toMatchObject({ ok: true });
    // And it reads what comes next, as does a reader starting over.
    await store.createExternalReservation({
      tenantRef: other, externalRef: 'R-3', resourceId: resource.id, start: at(84), end: at(85), bufferAfterMs: 0, revision: 1,
    });
    const next = await store.listChanges({ tenantRef: other, after: current.next });
    expect(next.ok && next.changes.map((change) => change.subject)).toEqual(['R-3']);
    const restart = await store.listChanges({ tenantRef: other });
    expect(restart.ok && restart.changes.map((change) => change.subject)).toEqual(['R-3']);
    await store.eraseTenant({ tenantRef: other });
    expect(await sql`SELECT 1 FROM slotlock.outbox_pruned WHERE tenant_ref = ${other}`).toHaveLength(0);
  });

  it('expires a cursor past which anything deleted changes, and a reader starting over moves on', async () => {
    const other = `feed-any-${randomUUID()}`;
    const resource = await store.createResource({ tenantRef: other, externalRef: 'v', timezone: 'UTC' });
    for (const [index, ref] of ['A', 'B', 'C'].entries()) {
      await store.createExternalReservation({
        tenantRef: other, externalRef: ref, resourceId: resource.id, start: at(90 + index), end: at(91 + index), bufferAfterMs: 0, revision: 1,
      });
    }
    const page = await store.listChanges({ tenantRef: other, limit: 1 });
    if (!page.ok) throw new Error(page.code);
    // Deleted by something other than this version's maintenance (an older server's, an
    // operator's): the mark follows it all the same.
    await sql`DELETE FROM slotlock.outbox WHERE tenant_ref = ${other} AND subject = 'B'`;
    expect(await store.listChanges({ tenantRef: other, after: page.next })).toEqual({ ok: false, code: 'cursor_expired' });
    // Starting over reads from the mark: A, kept before it, is passed over (a page ending at it
    // would be expired at once), and the reader reads on from C, never expired again.
    const again = await store.listChanges({ tenantRef: other, limit: 1 });
    if (!again.ok) throw new Error(again.code);
    expect(again.changes.map((change) => change.subject)).toEqual(['C']);
    expect(await store.listChanges({ tenantRef: other, after: again.next })).toMatchObject({ ok: true, changes: [] });
    await store.eraseTenant({ tenantRef: other });
  });

  it('starts each tenant an earlier version knew at its oldest kept change, once', async () => {
    const kept = `feed-upgrade-${randomUUID()}`;
    const quiet = `feed-upgrade-quiet-${randomUUID()}`;
    const resource = await store.createResource({ tenantRef: kept, externalRef: 'v', timezone: 'UTC' });
    await store.createResource({ tenantRef: quiet, externalRef: 'v', timezone: 'UTC' });
    for (const [index, ref] of ['A', 'B'].entries()) {
      await store.createExternalReservation({
        tenantRef: kept, externalRef: ref, resourceId: resource.id, start: at(95 + index), end: at(96 + index), bufferAfterMs: 0, revision: 1,
      });
    }
    const page = await store.listChanges({ tenantRef: kept });
    if (!page.ok) throw new Error(page.code);
    const [first] = page.changes;
    if (!first) throw new Error('a change expected');
    // As an upgrade from 0.4 finds it: no marks yet. Rolled back, so the table stays as it was.
    const marks = await sql
      .begin(async (tx) => {
        await tx`DROP TABLE slotlock.outbox_pruned`;
        await tx.unsafe(SLOTLOCK_STRUCTURE_DDL);
        const seeded = await tx<{ tenant_ref: string; txid: string; id: string }[]>`
          SELECT tenant_ref, txid::text, id::text FROM slotlock.outbox_pruned
           WHERE tenant_ref IN (${kept}, ${quiet}) ORDER BY tenant_ref`;
        // Applied again, it seeds nothing more.
        await tx`DELETE FROM slotlock.outbox_pruned WHERE tenant_ref = ${quiet}`;
        await tx.unsafe(SLOTLOCK_STRUCTURE_DDL);
        const again = await tx`SELECT 1 FROM slotlock.outbox_pruned WHERE tenant_ref = ${quiet}`;
        throw Object.assign(new Error('rollback'), { seeded, again: again.length });
      })
      .catch((error: { seeded?: unknown; again?: number }) => {
        if (!error.seeded) throw error;
        return error;
      });
    const txid = Buffer.from(first.position, 'base64url').toString().split(':')[1];
    expect(marks.seeded).toEqual([
      { tenant_ref: kept, txid, id: '0' },
      { tenant_ref: quiet, txid: expect.any(String), id: '0' },
    ]);
    expect(marks.again).toBe(0);
    await store.eraseTenant({ tenantRef: kept });
    await store.eraseTenant({ tenantRef: quiet });
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
