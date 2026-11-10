// Contention at scale (RFC 0004 A7) against real Postgres: 100 REST clients, each its own agent,
// race for one slot at once. The exclusion constraint decides: exactly one books it, the other 99
// are answered 409 overlap with alternatives, and none is a server error. Each answer comes back in
// under a second. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockAgentServer } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const CLIENTS = 100;
const HOUR = 3_600_000;

describe.skipIf(!url)('100 agents racing for one slot (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const tenantRef = `race-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 6, 6);
  const slot = { starts_at: new Date(base + 10 * HOUR).toISOString(), ends_at: new Date(base + 11 * HOUR).toISOString() };

  /** Every client asks for the slot on the resource at once: each answer, and how long it took. */
  const race = (resourceId: string, round: string) =>
    Promise.all(
      Array.from({ length: CLIENTS }, async (_, index) => {
        const started = performance.now();
        const response = await server.fetch(
          new Request('https://example.com/v1/events', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${round}-${index}`,
              'content-type': 'application/json',
              'idempotency-key': `${round}-${index}-${randomUUID()}`,
            },
            body: JSON.stringify({ resource_id: resourceId, ...slot, timezone: 'UTC', title: `Racer ${index}` }),
          }),
        );
        const body = (await response.json()) as { code?: string; alternatives?: { start: string }[] };
        return { status: response.status, body, ms: performance.now() - started };
      }),
    );
  const resource = async () =>
    (await store.createResource({ tenantRef, externalRef: `van-${randomUUID()}`, timezone: 'UTC' })).id;

  beforeAll(async () => {
    // A pool as a server would have: fewer connections than clients, so requests queue for one.
    sql = postgres(url as string, { max: 20, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    server = createSlotlockAgentServer({
      publicBaseUrl: 'https://example.com',
      backend: createSlotlockStoreAgentBackend(store, {
        availabilityRules: async () => [
          { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 8 * 60, durationMinutes: 10 * 60 },
        ],
      }),
      // Each client is an agent of its own, as each would hold its own key.
      authenticate: async (request) => ({
        subject: request.headers.get('authorization')?.slice('Bearer '.length) ?? 'nobody',
        tenantRef,
        scopes: ['read', 'write'],
      }),
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
    });
    // A running server, not a cold one: its code compiled, its pool open and its statements
    // prepared, by a first race on a resource of its own.
    await race(await resource(), 'warm');
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('books one and refuses the other 99 with alternatives, never a server error', async () => {
    const van = await resource();
    const answers = await race(van, 'race');
    expect(answers.filter(({ status }) => status === 200)).toHaveLength(1);
    expect(answers.filter(({ status }) => status >= 500)).toEqual([]);
    const lost = answers.filter(({ status }) => status === 409);
    expect(lost).toHaveLength(CLIENTS - 1);
    for (const { body } of lost) {
      expect(body.code).toBe('overlap');
      // The next free hour first: the time the winner took is not among them.
      expect(body.alternatives?.[0]?.start).toBe(new Date(base + 11 * HOUR).toISOString());
    }
    // The database holds exactly one booking of the slot.
    const [held] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM slotlock.reservations WHERE resource_id = ${van}`;
    expect(held?.n).toBe(1);
  });

  // The bound is the machine's as much as Slotlock's (about 0.4 s on a 4-CPU runner): a shared
  // runner's pause gets another race before it counts.
  it('answers every client within a second at the 99th percentile', { retry: 2 }, async () => {
    const answers = await race(await resource(), `timed-${randomUUID().slice(0, 8)}`);
    const sorted = answers.map(({ ms }) => ms).sort((a, b) => a - b);
    expect(sorted[Math.ceil(sorted.length * 0.99) - 1]).toBeLessThan(1_000);
  });
});
