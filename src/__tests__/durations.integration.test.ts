// Durations and hires across days (RFC 0004 B3) against real Postgres: rules set over REST, hires
// found with slotlock_find_available_ranges and booked by an agent, refused outside pick-up times,
// a two-day turnaround kept, and a search that names no length taking the usual one. Skipped
// without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type SlotlockAgentPrincipal,
  createSlotlockAgentServer,
  invokeSlotlockAgentOperation,
} from '../agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EIGHT_TO_SIX = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 8 * 60, durationMinutes: 10 * 60 }];

describe.skipIf(!url)('durations and hires (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  let agentBackend: ReturnType<typeof createSlotlockStoreAgentBackend>;
  const tenantRef = `durations-${randomUUID()}`;
  // A Friday well ahead, in UTC.
  const friday = (() => {
    const day = Date.UTC(new Date().getUTCFullYear() + 1, 4, 1);
    return day + (((5 - new Date(day).getUTCDay()) + 7) % 7) * DAY;
  })();
  const iso = (ms: number) => new Date(ms).toISOString();
  const principals: Record<string, SlotlockAgentPrincipal> = {
    admin: { subject: 'person-admin', tenantRef, scopes: ['read', 'write', 'admin'] },
  };
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
  const agent = (operation: string, input: Record<string, unknown>) =>
    invokeSlotlockAgentOperation({
      operation: operation as never,
      input,
      request: new Request(BASE),
      options: {
        backend: agentBackend,
        authenticate: async () => ({ subject: 'rental-agent', tenantRef, scopes: ['read', 'write'] }),
        authorize: async () => true,
      },
    }) as Promise<{ ok: boolean; status?: number; code?: string; data?: Record<string, unknown> }>;
  const book = (resourceId: string, start: number, end: number, key = randomUUID()) =>
    agent('slotlock_create_event', {
      resource_id: resourceId,
      starts_at: iso(start),
      ends_at: iso(end),
      timezone: 'UTC',
      idempotency_key: key,
    });
  const resource = async (ref: string) =>
    (await store.withTenant(tenantRef, (tenant) => tenant.createResource({ tenantRef, externalRef: ref, timezone: 'UTC' }))).id;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    // Writes are judged against the store's default hours, searches against the backend's: the same.
    store = createSlotlockStore(sql, { defaultAvailabilityRules: EIGHT_TO_SIX });
    await store.applySchema();
    agentBackend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => EIGHT_TO_SIX });
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

  it('finds hires across days in a pool, books one, and keeps its pick-up times and turnaround', async () => {
    const cars = [await resource('car-a'), await resource('car-b')];
    for (const id of cars) await call('PUT', `/v1/resources/${id}/pool`, { pool: 'compact' });
    const rules = await call('PUT', '/v1/pools/compact/booking-rules', {
      rules: {
        pickup_times: [{ start_minutes: 9 * 60, duration_minutes: 3 * 60 }],
        return_times: [{ start_minutes: 9 * 60, duration_minutes: 3 * 60 }],
        turnaround_minutes: 2 * 1_440,
        min_duration_minutes: 1_440,
        enforce_hours: true,
      },
    });
    expect(rules.status).toBe(200);
    const search = () =>
      agent('slotlock_find_available_ranges', {
        pool: 'compact',
        pickup_start: iso(friday + 7 * HOUR),
        pickup_end: iso(friday + 17 * HOUR),
        days: 3,
      });
    const found = await search();
    expect(found.ok).toBe(true);
    expect(found.data?.coverage).toMatchObject({ certainty: 'certain' });
    expect(found.data?.ranges).toEqual(
      [...cars].sort().map((id) => ({ resource_id: id, start: iso(friday + 9 * HOUR), end: iso(friday + 3 * DAY + 9 * HOUR) })),
    );
    expect(found.data?.selected_resource_ids).toEqual([...cars].sort());

    const [first] = found.data?.ranges as { resource_id: string; start: string; end: string }[];
    const taken = first as { resource_id: string; start: string; end: string };
    const booked = await book(taken.resource_id, Date.parse(taken.start), Date.parse(taken.end));
    expect(booked).toMatchObject({ ok: true });
    const after = await search();
    expect((after.data?.ranges as { resource_id: string }[]).map((range) => range.resource_id)).toEqual(
      cars.filter((id) => id !== taken.resource_id),
    );
    // Two days' turnaround after Monday 09:00: Tuesday is still taken.
    const tuesday = friday + 4 * DAY;
    expect(await book(taken.resource_id, tuesday + 10 * HOUR, tuesday + 5 * DAY + 10 * HOUR)).toMatchObject({
      ok: false,
      code: 'overlap',
    });
    // A pick-up outside the pick-up times, a return outside the return times, a hire too short.
    const other = cars.find((id) => id !== taken.resource_id) as string;
    expect(await book(other, friday + 13 * HOUR, friday + 3 * DAY + 10 * HOUR)).toMatchObject({
      ok: false,
      code: 'booking_rule_pickup_time',
    });
    expect(await book(other, friday + 10 * HOUR, friday + 3 * DAY + 15 * HOUR)).toMatchObject({
      ok: false,
      code: 'booking_rule_return_time',
    });
    expect(await book(other, friday + 10 * HOUR, friday + 14 * HOUR)).toMatchObject({
      ok: false,
      code: 'booking_rule_min_duration',
    });
    // A return window instead of a number of days: the earliest return it allows.
    const returned = await agent('slotlock_find_available_ranges', {
      resource_ids: [other],
      pickup_start: iso(friday + 9 * HOUR),
      pickup_end: iso(friday + 12 * HOUR),
      return_start: iso(friday + 2 * DAY),
      return_end: iso(friday + 2 * DAY + 20 * HOUR),
    });
    expect(returned.data?.ranges).toEqual([
      { resource_id: other, start: iso(friday + 9 * HOUR), end: iso(friday + 2 * DAY + 9 * HOUR) },
    ]);
    expect(
      (await agent('slotlock_find_available_ranges', { resource_ids: [other], pickup_start: iso(friday), pickup_end: iso(friday + HOUR) }))
        .code,
    ).toBe('invalid_arguments');
  });

  it('finds slots across days where the hours hold a hire at its ends, and offers them for a refused pick-up', async () => {
    const van = await resource('van-ends');
    const truck = await resource('truck-whole');
    expect(
      (await call('PUT', `/v1/resources/${van}/booking-rules`, {
        rules: { enforce_hours: true, hours_apply: 'ends', pickup_times: [{ start_minutes: 9 * 60, duration_minutes: 3 * 60 }] },
      })).status,
    ).toBe(200);
    expect((await call('PUT', `/v1/resources/${truck}/booking-rules`, { rules: { enforce_hours: true, hours_apply: 'whole' } })).status).toBe(200);
    const twoDays = 2 * 1_440;
    const slots = await agent('slotlock_find_available_slots', {
      resource_ids: [van],
      start: iso(friday),
      end: iso(friday + 6 * DAY),
      duration_minutes: twoDays,
      limit: 2,
    });
    // Each from a pick-up time, ending inside the hours (08:00-18:00) two days later.
    expect(slots.data?.slots).toEqual([
      { resource_id: van, start: iso(friday + 9 * HOUR), end: iso(friday + 2 * DAY + 9 * HOUR) },
      { resource_id: van, start: iso(friday + 2 * DAY + 9 * HOUR), end: iso(friday + 4 * DAY + 9 * HOUR) },
    ]);
    expect(
      (await agent('slotlock_find_next_available', { resource_ids: [van], start: iso(friday), end: iso(friday + 6 * DAY), duration_minutes: twoDays }))
        .data,
    ).toMatchObject({ resource_id: van, start: iso(friday + 9 * HOUR), end: iso(friday + 2 * DAY + 9 * HOUR) });
    // A pick-up outside the pick-up times is refused with the earliest hires of its length after it.
    const refused = (await book(van, friday + 13 * HOUR, friday + 2 * DAY + 13 * HOUR)) as { ok: boolean; code?: string; alternatives?: unknown[] };
    expect(refused).toMatchObject({ ok: false, code: 'booking_rule_pickup_time' });
    expect(refused.alternatives?.[0]).toEqual({ resource_id: van, start: iso(friday + DAY + 9 * HOUR), end: iso(friday + 3 * DAY + 9 * HOUR) });
    expect(await book(van, friday + 9 * HOUR, friday + 2 * DAY + 9 * HOUR)).toMatchObject({ ok: true });
    // Held wholly to its hours, a two-day hire fits nowhere, in the search as in the write.
    expect(
      (await agent('slotlock_find_available_slots', { resource_ids: [truck], start: iso(friday), end: iso(friday + 6 * DAY), duration_minutes: twoDays, limit: 2 }))
        .data?.slots,
    ).toEqual([]);
    expect(await book(truck, friday + 9 * HOUR, friday + 2 * DAY + 9 * HOUR)).toMatchObject({ ok: false, code: 'booking_rule_outside_hours' });
  });

  it('offers the usual length when a search names none, and only allowed lengths', async () => {
    const desk = await resource('desk-1');
    const bare = await resource('desk-2');
    await call('PUT', `/v1/resources/${desk}/booking-rules`, {
      rules: { allowed_durations: [30, 60], default_duration_minutes: 30 },
    });
    const window = { start: iso(friday + 8 * HOUR), end: iso(friday + 10 * HOUR) };
    const usual = await agent('slotlock_find_available_slots', { resource_ids: [desk], ...window, limit: 2 });
    expect(usual.data?.slots).toEqual([
      { resource_id: desk, start: iso(friday + 8 * HOUR), end: iso(friday + 8.5 * HOUR) },
      { resource_id: desk, start: iso(friday + 8.5 * HOUR), end: iso(friday + 9 * HOUR) },
    ]);
    expect(
      (await agent('slotlock_find_next_available', { resource_ids: [desk], ...window })).data,
    ).toMatchObject({ start: iso(friday + 8 * HOUR), end: iso(friday + 8.5 * HOUR) });
    expect(await agent('slotlock_find_available_slots', { resource_ids: [bare], ...window })).toMatchObject({
      ok: false,
      code: 'duration_required',
    });
    expect(
      (await agent('slotlock_find_available_slots', { resource_ids: [desk], ...window, duration_minutes: 45 })).data?.slots,
    ).toEqual([]);
    expect(await book(desk, friday + 8 * HOUR, friday + 8.75 * HOUR)).toMatchObject({
      ok: false,
      code: 'booking_rule_duration_not_allowed',
    });
    const read = await call('GET', `/v1/resources/${desk}`);
    expect((read.body.resource as Record<string, unknown>).booking_rules).toEqual({
      allowed_durations: [30, 60],
      default_duration_minutes: 30,
    });
  });
});
