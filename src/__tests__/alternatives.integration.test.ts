// Alternatives with a refusal (RFC 0004 A1), through the operation boundary every protocol shares,
// against real Postgres: a taken time answers the earliest free times of the same length on the
// same resource, the same pool, or the same bundle. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type SlotlockAgentPrincipal,
  createSlotlockAgentServer,
  invokeSlotlockAgentOperation,
  slotlockMcpToolResult,
} from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import type { WeeklyAvailabilityRule } from '../types.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;
const EVERY_DAY = (startHour: number, hours: number): WeeklyAvailabilityRule[] => [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: startHour * 60, durationMinutes: hours * 60 },
];

describe.skipIf(!url)('alternatives with a refusal (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let backend: ReturnType<typeof createSlotlockStoreAgentBackend>;
  const tenantRef = `alternatives-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 4, 3, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR).toISOString();
  const principal = (subject = 'alt-agent'): SlotlockAgentPrincipal => ({
    subject,
    tenantRef,
    scopes: ['read', 'write'],
  });
  const call = (operation: string, input: Record<string, unknown>, subject?: string) =>
    invokeSlotlockAgentOperation({
      operation,
      input,
      request: new Request('https://example.com'),
      options: { backend, authenticate: async () => principal(subject), authorize: async () => true },
    }) as Promise<
      | { ok: true; data: Record<string, unknown> }
      | { ok: false; code: string; status: number; alternatives?: { resource_id: string; start: string; end: string; resource_ids?: string[] }[] }
    >;
  const create = (resourceId: string, start: number, end: number, subject?: string) =>
    call(
      'slotlock_create_event',
      {
        resource_id: resourceId,
        starts_at: at(start),
        ends_at: at(end),
        timezone: 'UTC',
        title: 'Handover',
        idempotency_key: `e-${randomUUID()}`,
      },
      subject,
    );

  async function resource(pool?: string) {
    const created = await store.createResource({ tenantRef, externalRef: `r-${randomUUID()}`, timezone: 'UTC' });
    if (pool) await store.setResourcePool({ tenantRef, id: created.id, pool });
    return created.id;
  }

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    backend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => EVERY_DAY(8, 10) });
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('answers a taken time with the earliest free times of the same length on the same resource', async () => {
    const van = await resource();
    // Busy 9-10 and 11-12; hours are 08:00-18:00 each day.
    expect((await create(van, 9, 10, 'other')).ok).toBe(true);
    expect((await create(van, 11, 12, 'other')).ok).toBe(true);
    const refused = await create(van, 9, 10);
    expect(refused).toMatchObject({ ok: false, code: 'overlap' });
    if (refused.ok) return;
    expect(refused.alternatives).toEqual([
      { resource_id: van, start: at(10), end: at(11) },
      { resource_id: van, start: at(12), end: at(13) },
      { resource_id: van, start: at(13), end: at(14) },
    ]);
    // Each one books: they are what a search would offer, not guesses.
    expect((await create(van, 10, 11)).ok).toBe(true);
  });

  it('offers times a booking rule allows when a rule refuses the one asked for', async () => {
    const room = await resource();
    await store.setResourceBookingRules({ tenantRef, id: room, rules: { slotStepMinutes: 60 } });
    const refused = await call('slotlock_create_event', {
      resource_id: room,
      starts_at: new Date(base + 9.5 * HOUR).toISOString(),
      ends_at: new Date(base + 10.5 * HOUR).toISOString(),
      timezone: 'UTC',
      idempotency_key: `e-${randomUUID()}`,
    });
    expect(refused).toMatchObject({ ok: false, code: 'booking_rule_slot_step' });
    if (refused.ok) return;
    expect(refused.alternatives?.[0]).toEqual({ resource_id: room, start: at(10), end: at(11) });
    for (const alternative of refused.alternatives ?? []) {
      expect(new Date(alternative.start).getUTCMinutes()).toBe(0);
    }
  });

  it('answers a refused bundle with times when every resource is free together', async () => {
    const car = await resource();
    const driver = await resource();
    expect((await create(car, 9, 10, 'other')).ok).toBe(true);
    expect((await create(driver, 10, 11, 'other')).ok).toBe(true);
    const refused = await call('slotlock_book_together', {
      resource_ids: [car, driver],
      starts_at: at(9),
      ends_at: at(10),
      timezone: 'UTC',
      idempotency_key: `b-${randomUUID()}`,
    });
    expect(refused).toMatchObject({ ok: false, code: 'overlap' });
    if (refused.ok) return;
    expect(refused.alternatives?.[0]).toMatchObject({ start: at(11), end: at(12) });
    expect([...(refused.alternatives?.[0]?.resource_ids ?? [])].sort()).toEqual([car, driver].sort());
  });

  it('answers a full pool with times when any member is free', async () => {
    const pool = `bike-${randomUUID().slice(0, 8)}`;
    const first = await resource(pool);
    const second = await resource(pool);
    expect((await create(first, 9, 11, 'other')).ok).toBe(true);
    expect((await create(second, 9, 10, 'other')).ok).toBe(true);
    const refused = await call('slotlock_book_pool', {
      pool,
      starts_at: at(9),
      ends_at: at(10),
      timezone: 'UTC',
      idempotency_key: `p-${randomUUID()}`,
    });
    expect(refused).toMatchObject({ ok: false, code: 'pool_full' });
    if (refused.ok) return;
    expect(refused.alternatives?.[0]).toMatchObject({ start: at(10), end: at(11), resource_ids: [second] });
  });

  it('gives each held candidate refused for its time its own alternatives', async () => {
    const van = await resource();
    expect((await create(van, 14, 15, 'other')).ok).toBe(true);
    const held = await call('slotlock_hold_slots', {
      slots: [
        { resource_id: van, start: at(14), end: at(15) },
        { resource_id: van, start: at(16), end: at(17) },
      ],
      ttl_seconds: 60,
      idempotency_key: `h-${randomUUID()}`,
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    const refused = held.data.refused as { index: number; code: string; alternatives?: { start: string }[] }[];
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ index: 0, code: 'overlap' });
    // 15-16 is free; 16-17 is the candidate just held.
    expect(refused[0]?.alternatives?.[0]).toMatchObject({ start: at(15) });
    expect(refused[0]?.alternatives?.map(({ start }) => start)).not.toContain(at(16));
  });

  it('gives no alternatives for a refusal another time cannot answer', async () => {
    const refused = await call('slotlock_create_event', {
      resource_id: randomUUID(),
      starts_at: at(9),
      ends_at: at(10),
      timezone: 'UTC',
      idempotency_key: `e-${randomUUID()}`,
    });
    expect(refused).toMatchObject({ ok: false, status: 404 });
    expect(refused).not.toHaveProperty('alternatives');
  });

  it('carries the alternatives on MCP, REST and A2A alike', async () => {
    const van = await resource();
    expect((await create(van, 9, 10, 'other')).ok).toBe(true);
    const refused = await create(van, 9, 10);
    if (refused.ok) throw new Error('expected a refusal');
    const mcp = slotlockMcpToolResult(refused);
    const text = (mcp.content[0] as { text: string }).text;
    expect(JSON.parse(text).error.alternatives[0]).toEqual({ resource_id: van, start: at(10), end: at(11) });

    const server = createSlotlockAgentServer({
      publicBaseUrl: 'https://example.com',
      backend,
      authenticate: async () => principal(),
      authorize: () => true,
      rest: true,
    } as never);
    const response = await server.fetch(
      new Request('https://example.com/v1/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x', 'idempotency-key': `r-${randomUUID()}` },
        body: JSON.stringify({ resource_id: van, starts_at: at(9), ends_at: at(10), timezone: 'UTC' }),
      }),
    );
    expect(response.status).toBe(409);
    const problem = (await response.json()) as { code: string; alternatives: { start: string }[] };
    expect(problem.code).toBe('overlap');
    expect(problem.alternatives[0]?.start).toBe(at(10));
  });
});
