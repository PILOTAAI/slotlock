// Bookings across resources against real Postgres: a bundle books every resource or none, names the
// one that refused it, replays, and two racing over the same resources in opposite orders end with
// one booked and one refused, never a deadlock. Collective search finds when n resources are free
// together, judging each as a single search does. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentInvocationContext, createSlotlockAgentServer } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import type { WeeklyAvailabilityRule } from '../types.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;
const EVERY_DAY = (startHour: number, hours: number): WeeklyAvailabilityRule[] => [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: startHour * 60, durationMinutes: hours * 60 },
];

describe.skipIf(!url)('bundles and collective search (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let backend: ReturnType<typeof createSlotlockStoreAgentBackend>;
  const tenantRef = `bundles-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 5, 1, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR).toISOString();
  const context = (operation: string, subject = 'bundle-agent'): SlotlockAgentInvocationContext => ({
    principal: { subject, tenantRef },
    operation: operation as SlotlockAgentInvocationContext['operation'],
    signal: new AbortController().signal,
  });
  const together = (resourceIds: string[], start: number, end: number, key = `b-${randomUUID()}`, subject?: string) =>
    backend.bookTogether?.(context('slotlock_book_together', subject), {
      resource_ids: resourceIds,
      starts_at: at(start),
      ends_at: at(end),
      timezone: 'UTC',
      title: 'Handover with driver',
      idempotency_key: key,
    }) as Promise<{ events: { resource_id: string; starts_at: string }[]; replayed: boolean }>;
  const create = (resourceId: string, start: number, end: number) =>
    backend.createEvent(context('slotlock_create_event', 'other-agent'), {
      resource_id: resourceId,
      starts_at: at(start),
      ends_at: at(end),
      timezone: 'UTC',
      transparency: 'opaque',
      status: 'confirmed',
      idempotency_key: `e-${randomUUID()}`,
    });
  const booked = async (resourceId: string) =>
    (await sql`SELECT 1 FROM slotlock.calendar_events WHERE resource_id = ${resourceId}`).length;

  async function resource(hours?: WeeklyAvailabilityRule[]) {
    const created = await store.createResource({ tenantRef, externalRef: `r-${randomUUID()}`, timezone: 'UTC' });
    if (hours) await store.setResourceAvailability({ tenantRef, id: created.id, rules: hours });
    return created.id;
  }

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    backend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => EVERY_DAY(0, 24) });
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('books every resource or none, names the one that refused, and replays', async () => {
    const [van, driver, trailer] = [await resource(), await resource(), await resource()];
    const key = `bundle-${randomUUID()}`;
    const first = await together([van as string, driver as string, trailer as string], 1, 2, key);
    expect(first.events.map((event) => event.resource_id).sort()).toEqual([van, driver, trailer].sort());
    expect(first.replayed).toBe(false);
    const again = await together([trailer as string, van as string, driver as string], 1, 2, key);
    expect(again).toMatchObject({ replayed: true });
    expect(again.events).toEqual(first.events);

    await create(driver as string, 4, 5);
    await expect(together([van as string, driver as string, trailer as string], 4, 5)).rejects.toMatchObject({
      code: 'overlap',
      status: 409,
      details: { resource_id: driver },
    });
    // Nothing of the refused bundle stayed: the van and trailer are free at 4-5.
    expect(await booked(van as string)).toBe(1);
    expect(await booked(trailer as string)).toBe(1);
  });

  it('ends two bundles racing in opposite orders with one booked and one refused, no deadlock', async () => {
    const ids = [await resource(), await resource(), await resource(), await resource()];
    for (let round = 0; round < 5; round++) {
      const outcomes = await Promise.allSettled([
        together([...ids], 10 + round * 2, 11 + round * 2, undefined, 'racer-a'),
        together([...ids].reverse(), 10 + round * 2, 11 + round * 2, undefined, 'racer-b'),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const refused = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ code: 'overlap' });
    }
    // Racing bundles queue on each other by design; a loaded CI runner needs more than 5 s.
  }, 30_000);

  it('finds when every resource, or any n of them, is free together, as each one judges it', async () => {
    // The van works 06-18, the driver 09-17; the trailer is booked 09-11.
    const van = await resource(EVERY_DAY(6, 12));
    const driver = await resource(EVERY_DAY(9, 8));
    const trailer = await resource();
    await create(trailer, 9, 11);
    const server = createSlotlockAgentServer({
      publicBaseUrl: 'http://localhost/slotlock',
      allowInsecureLocalhost: true,
      allowedOrigins: ['http://localhost'],
      backend,
      authenticate: async () => ({ subject: 'bundle-agent', tenantRef, scopes: ['read', 'write'] }),
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
    });
    const slots = async (needed: number, limit = 3) => {
      const query = new URLSearchParams({ start: at(0), end: at(24), duration_minutes: '120', limit: String(limit), require_free: String(needed) });
      for (const id of [van, driver, trailer]) query.append('resource_ids', id);
      const response = await server.fetch(new Request(`http://localhost/slotlock/v1/available-slots?${query}`, { headers: { Authorization: 'Bearer k' } }));
      expect(response.status).toBe(200);
      return ((await response.json()) as { slots: { start: string; resource_ids: string[] }[] }).slots;
    };
    // All three: from 11:00, when the trailer is free and the driver has started.
    const all = await slots(3);
    expect(all.map((slot) => slot.start)).toEqual([at(11), at(13), at(15)]);
    expect(all[0]?.resource_ids.sort()).toEqual([van, driver, trailer].sort());
    // Any two: the trailer alone is free from midnight; with the van, from 06:00.
    const two = await slots(2, 1);
    expect(two[0]?.start).toBe(at(6));
    expect(two[0]?.resource_ids.sort()).toEqual([van, trailer].sort());
    // More than there are: refused as an argument.
    const query = new URLSearchParams({ start: at(0), end: at(24), duration_minutes: '60', require_free: '3', resource_ids: van });
    const tooMany = await server.fetch(new Request(`http://localhost/slotlock/v1/available-slots?${query}`, { headers: { Authorization: 'Bearer k' } }));
    expect(tooMany.status).toBe(400);
  });
});
