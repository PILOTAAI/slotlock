// Live updates from the change feed against real Postgres (RFC 0002 P1-5): no NOTIFY anywhere (it
// would serialize every outbox commit on the cluster-wide notify lock); the tenant's reader polls its
// own feed, at most once a second when idle; and an MCP subscriber hears of a booking within 1.5 s,
// with no 10-second re-read. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSlotlockAgentServer, slotlockCalendarResourceUri } from '../agent-server.js';
import {
  createSlotlockStoreAgentBackend,
  createSlotlockStoreChangeSource,
} from '../agent-store-backend.js';
import { SLOTLOCK_CORE_DDL, SLOTLOCK_STRUCTURE_DDL } from '../ddl.js';
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

  it('takes no NOTIFY lock: the DDL has no pg_notify, and applying it drops a leftover trigger', async () => {
    for (const ddl of [SLOTLOCK_CORE_DDL, SLOTLOCK_STRUCTURE_DDL]) {
      expect(ddl).not.toMatch(/pg_notify|\bNOTIFY\b/);
    }
    // What a database that applied the pre-release NOTIFY trigger still has.
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION slotlock.outbox_notify() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN PERFORM pg_catalog.pg_notify('slotlock_feed_leftover', ''); RETURN NULL; END $f$;
      CREATE OR REPLACE TRIGGER slotlock_outbox_notify
        AFTER INSERT ON slotlock.outbox REFERENCING NEW TABLE AS added
        FOR EACH STATEMENT EXECUTE FUNCTION slotlock.outbox_notify();`);
    const leftovers = async () => [
      ...(await sql`SELECT tgname FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'slotlock.outbox'::regclass AND tgname = 'slotlock_outbox_notify'`),
      ...(await sql`SELECT proname FROM pg_catalog.pg_proc
        WHERE pronamespace = 'slotlock'::regnamespace AND proname = 'outbox_notify'`),
    ];
    expect(await leftovers()).toHaveLength(2);
    await store.applySchema();
    expect(await leftovers()).toEqual([]);
  });

  it('announces a booking to an MCP subscriber within 1.5 s by polling, at most one feed query a second when idle', async () => {
    const vanA = await van(tenantA);
    const otherA = await van(tenantA);
    const source = createSlotlockStoreChangeSource(store, sql);
    let feedQueries = 0;
    const changes: typeof source = {
      head: (tenantRef) => source.head(tenantRef),
      listChanges: (params) => {
        feedQueries += 1;
        return source.listChanges(params);
      },
    };
    const server = createSlotlockAgentServer({
      publicBaseUrl: 'http://localhost/slotlock',
      allowInsecureLocalhost: true,
      allowedOrigins: ['http://localhost'],
      backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] }),
      authenticate: async () => ({ subject: 'live-test', tenantRef: tenantA }),
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      subscriptions: { pollIntervalMs: 300_000, changes },
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

    // Idle, the tenant's reader polls its feed at most once a second (one indexed query).
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    feedQueries = 0;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(feedQueries).toBeGreaterThanOrEqual(2);
    expect(feedQueries).toBeLessThanOrEqual(4);

    // A booking of another of the tenant's vans is read from the feed and announces nothing.
    await book(tenantA, otherA, 2);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(messages).toEqual([]);

    const booked = Date.now();
    await book(tenantA, vanA, 3);
    await vi.waitFor(() => expect(messages).toHaveLength(1), { timeout: 1_500, interval: 20 });
    expect(Date.now() - booked).toBeLessThan(1_500);
    expect(messages[0]).toMatchObject({
      method: 'notifications/resources/updated',
      params: { uri: slotlockCalendarResourceUri(vanA) },
    });
    await stream.cancel();
    await server.shutdown();
  }, 15_000);
});
