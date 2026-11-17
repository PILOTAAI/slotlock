// Dry runs (RFC 0004 A3) against real Postgres: a write with every check, the database's
// constraints included, then undone, so nothing is stored, recorded or sent. Skipped without
// DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer, slotlockAgentTools } from '../agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import type { WeeklyAvailabilityRule } from '../types.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const EVERY_DAY: WeeklyAvailabilityRule[] = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 8 * 60, durationMinutes: 10 * 60 },
];

describe.skipIf(!url)('dry runs (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantRef = `dry-run-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 2, 9, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR).toISOString();
  const principal: SlotlockAgentPrincipal = { subject: 'dry-agent', tenantRef, scopes: ['read', 'write', 'admin'] };
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: 'Bearer t', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const count = async (rows: Promise<{ n: number }[]>) => Number((await rows)[0]?.n ?? 0);
  const stored = {
    events: () => count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef}`),
    bookings: () =>
      count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM slotlock.reservations booking
                  JOIN slotlock.resources resource ON resource.id = booking.resource_id
                 WHERE resource.tenant_ref = ${tenantRef}`),
    changes: () => count(sql<{ n: number }[]>`SELECT count(*)::int AS n FROM slotlock.outbox WHERE tenant_ref = ${tenantRef}`),
  };
  let van: string;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    server = createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => EVERY_DAY }),
      authenticate: async () => principal,
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
      application: {
        backend: createSlotlockStoreApplicationBackend(store, { tenantErasure: true }),
        authorize: async () => true,
      },
    });
    van = (await store.createResource({ tenantRef, externalRef: 'van', timezone: 'UTC' })).id;
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('answers what a booking would be, and stores, records and sends nothing', async () => {
    const before = { events: await stored.events(), changes: await stored.changes() };
    const body = { resource_id: van, starts_at: at(9), ends_at: at(10), timezone: 'UTC', title: 'Handover', dry_run: true };
    const dry = await call('POST', '/v1/events', { ...body, idempotency_key: `d-${randomUUID()}` });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dry_run: true, replayed: false, event: { resource_id: van, starts_at: at(9) } });
    expect(await stored.events()).toBe(before.events);
    expect(await stored.changes()).toBe(before.changes);
    // The time is still free: the real booking goes through.
    const real = await call('POST', '/v1/events', { ...body, dry_run: false, idempotency_key: `r-${randomUUID()}` });
    expect(real.status).toBe(200);
    expect(real.body).not.toHaveProperty('dry_run');
  });

  it('meets the database constraint as the write would, alternatives included', async () => {
    const before = await stored.events();
    const refused = await call('POST', '/v1/events', {
      resource_id: van,
      starts_at: at(9),
      ends_at: at(10),
      timezone: 'UTC',
      idempotency_key: `o-${randomUUID()}`,
      dry_run: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'overlap' });
    expect((refused.body.alternatives as { start: string }[])[0]?.start).toBe(at(10));
    expect(await stored.events()).toBe(before);
  });

  it('holds, moves and cancels nothing on a dry run', async () => {
    const bookings = await stored.bookings();
    const held = await call('POST', '/v1/slot-holds', {
      slots: [{ resource_id: van, start: at(12), end: at(13) }],
      idempotency_key: `h-${randomUUID()}`,
      dry_run: true,
    });
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({ dry_run: true, refused: [] });
    expect((held.body.holds as unknown[]).length).toBe(1);
    expect(await stored.bookings()).toBe(bookings);

    const event = (
      await call('POST', '/v1/events', { resource_id: van, starts_at: at(14), ends_at: at(15), timezone: 'UTC', idempotency_key: `m-${randomUUID()}` })
    ).body.event as { id: string; revision: number };
    const moved = await call('POST', `/v1/events/${encodeURIComponent(event.id)}/reschedule`, {
      expected_revision: event.revision,
      starts_at: at(16),
      ends_at: at(17),
      dry_run: true,
    });
    expect(moved.body).toMatchObject({ dry_run: true, event: { starts_at: at(16) } });
    // Still where it was, at its revision; a delete in the query string is undone too.
    const kept = await call('GET', `/v1/events/${encodeURIComponent(event.id)}`);
    expect(kept.body.event).toMatchObject({ starts_at: at(14), revision: event.revision });
    const cancelled = await call(
      'DELETE',
      `/v1/events/${encodeURIComponent(event.id)}?expected_revision=${event.revision}&idempotency_key=c-${randomUUID()}&dry_run=true`,
    );
    expect(cancelled.body).toMatchObject({ dry_run: true, deleted: true });
    expect((await call('GET', `/v1/events/${encodeURIComponent(event.id)}`)).status).toBe(200);
  });

  it('runs an application write as a dry run, and refuses one for what cannot be undone or a read', async () => {
    const before = await stored.bookings();
    const put = await call('PUT', '/v1/reservations/dry-booking', {
      resource_id: van,
      start: at(30),
      end: at(31),
      revision: 1,
      dry_run: true,
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ dry_run: true });
    expect(await stored.bookings()).toBe(before);
    expect((await call('POST', '/v1/tenant/erase', { confirm_tenant_ref: tenantRef, dry_run: true })).body).toMatchObject({
      code: 'dry_run_not_supported',
    });
    expect((await call('GET', `/v1/free-busy?resource_ids=${van}&start=${at(0)}&end=${at(24)}&dry_run=true`)).status).toBe(400);
  });

  it('publishes dry_run on every write, and on no read', () => {
    for (const tool of slotlockAgentTools()) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.hasOwn(properties, 'dry_run'), tool.name).toBe(!tool.annotations.readOnlyHint);
    }
  });
});
