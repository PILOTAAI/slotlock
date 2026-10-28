// Live updates from the change feed against real Postgres (RFC 0002 P1-5): a commit that appends to
// a tenant's feed NOTIFYs that tenant's channel only, with no payload; the store's change source
// reads the tenant's own feed under row-level security; and an MCP subscriber hears of a booking
// within a short bound, with no 10-second re-read. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSlotlockAgentServer, slotlockCalendarResourceUri } from '../agent-server.js';
import {
  createSlotlockStoreAgentBackend,
  createSlotlockStoreChangeSource,
  slotlockChangeChannel,
} from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { SseReader, modernRequest } from './helpers/modern-mcp.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;

describe.skipIf(!url)('live updates from the change feed (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantA = `live-a-${randomUUID()}`;
  const tenantB = `live-b-${randomUUID()}`;
  // Tomorrow, on the hour: inside a subscription's 30-day window.
  const base = Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR;
  const at = (hour: number) => new Date(base + hour * HOUR);

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    for (const tenantRef of [tenantA, tenantB]) {
      await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    }
    await sql.end();
  });

  const van = async (tenantRef: string) =>
    (await store.createResource({ tenantRef, externalRef: `van-${randomUUID()}`, timezone: 'UTC' }))
      .id;
  const book = async (tenantRef: string, resourceId: string, hour: number) => {
    const booked = await store.createExternalReservation({
      tenantRef,
      externalRef: `BK-${randomUUID()}`,
      resourceId,
      start: at(hour),
      end: at(hour + 1),
      bufferAfterMs: 0,
      revision: 1,
    });
    if (!booked.ok) throw new Error(booked.code);
  };

  it("wakes only the tenant whose feed grew, with no payload, and reads only that tenant's changes", async () => {
    const vanA = await van(tenantA);
    const vanB = await van(tenantB);
    const source = createSlotlockStoreChangeSource(store, sql);
    const payloads: string[] = [];
    const listening = await sql.listen(slotlockChangeChannel(tenantA), (payload) => payloads.push(payload));
    const wakes = { a: 0, b: 0 };
    const stopA = await source.watch?.(tenantA, () => {
      wakes.a += 1;
    });
    const stopB = await source.watch?.(tenantB, () => {
      wakes.b += 1;
    });
    // Each listener wakes once when it starts listening.
    await vi.waitFor(() => expect(wakes).toEqual({ a: 1, b: 1 }));
    const headA = await source.head(tenantA);
    const headB = await source.head(tenantB);

    await book(tenantA, vanA, 1);
    await vi.waitFor(() => expect(wakes.a).toBe(2), { timeout: 2_000 });
    expect(payloads).toEqual(['']);
    const pageA = await source.listChanges({ tenantRef: tenantA, after: headA, limit: 500 });
    expect(pageA).toMatchObject({ ok: true, changes: [{ resourceId: vanA }] });

    // Tenant b's feed is unchanged and its listener was never woken by tenant a's commit.
    const pageB = await source.listChanges({ tenantRef: tenantB, after: headB, limit: 500 });
    expect(pageB).toMatchObject({ ok: true, changes: [] });
    expect(wakes.b).toBe(1);

    await book(tenantB, vanB, 1);
    await vi.waitFor(() => expect(wakes.b).toBe(2), { timeout: 2_000 });
    expect(wakes.a).toBe(2);
    await stopA?.();
    await stopB?.();
    await listening.unlisten();
  });

  it('announces a booking to an MCP subscriber within two seconds, with the re-read at five minutes', async () => {
    const vanA = await van(tenantA);
    const otherA = await van(tenantA);
    const server = createSlotlockAgentServer({
      publicBaseUrl: 'http://localhost/slotlock',
      allowInsecureLocalhost: true,
      allowedOrigins: ['http://localhost'],
      backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] }),
      authenticate: async () => ({ subject: 'live-test', tenantRef: tenantA }),
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      subscriptions: { pollIntervalMs: 300_000, changes: createSlotlockStoreChangeSource(store, sql) },
    });
    const stream = new SseReader(
      await server.fetch(
        modernRequest('subscriptions/listen', {
          notifications: { resourceSubscriptions: [slotlockCalendarResourceUri(vanA)] },
        }),
      ),
    );
    expect(await stream.message()).toMatchObject({
      method: 'notifications/subscriptions/acknowledged',
    });
    const messages: Record<string, unknown>[] = [];
    void (async () => {
      for (;;) {
        const message = await stream.message();
        if (message === null) return;
        messages.push(message);
      }
    })();

    // A booking of another of the tenant's vans is read from the feed and announces nothing.
    await book(tenantA, otherA, 2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(messages).toEqual([]);

    const booked = Date.now();
    await book(tenantA, vanA, 3);
    await vi.waitFor(() => expect(messages).toHaveLength(1), { timeout: 2_000, interval: 20 });
    expect(Date.now() - booked).toBeLessThan(2_000);
    expect(messages[0]).toMatchObject({
      method: 'notifications/resources/updated',
      params: { uri: slotlockCalendarResourceUri(vanA) },
    });
    await stream.cancel();
    await server.shutdown();
  });
});
