// Contention at scale (RFC 0004 A7) against real Postgres: 100 REST clients, each its own agent,
// race for one slot at once. The exclusion constraint decides: exactly one books it, the other 99
// are answered 409 overlap with alternatives, and none is a server error. Each answer comes back in
// under a second, or, on a runner too slow to show that, the race costs no more than it does on a
// fast one, measured against a control (below). Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockAgentServer } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const CLIENTS = 100;
const HOUR = 3_600_000;
/** RFC 0004 A7: every client answered within this, at the 99th percentile. */
const BOUND_MS = 1_000;
/**
 * The race's p99 over the control's, the same clients asking the same server for the next free
 * hour instead. Measured on 2026-11-12, as the median of five pairs: 4.3 to 4.6 on 4, 2 and 1 CPUs
 * and on 2 CPUs shared with two busy loops, while the race itself took 0.45 to 1.3 s. A booking path
 * 20 ms slower per attempt gave 11 to 16; one that holds a single lock for 10 ms of each attempt, 7.4
 * to 13. Each also missed the bound itself, on 2 CPUs and on 4.
 */
const MAX_RATIO = 6;
/** Past this the race fails, however slow the runner: something hangs. */
const CEILING_MS = 5_000;
const p99 = (ms: number[]) => [...ms].sort((a, b) => a - b)[Math.ceil(ms.length * 0.99) - 1] as number;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

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
  /** The control: as many clients at once, through the same server and pool, asking for the next free hour. */
  const control = (resourceId: string) => {
    const query = new URLSearchParams({
      resource_ids: resourceId,
      start: new Date(base).toISOString(),
      end: new Date(base + 48 * HOUR).toISOString(),
      duration_minutes: '60',
    });
    return Promise.all(
      Array.from({ length: CLIENTS }, async (_, index) => {
        const started = performance.now();
        const response = await server.fetch(
          new Request(`https://example.com/v1/next-available?${query.toString()}`, {
            headers: { authorization: `Bearer control-${index}` },
          }),
        );
        expect(response.status).toBe(200);
        await response.json();
        return performance.now() - started;
      }),
    );
  };
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

  // The bound is the machine's as much as Slotlock's: about 0.45 s on 4 CPUs, 0.7 s on 2 and 1.3 s
  // on 1. A shared CI runner can be that slow for a whole job, which no retry outlasts. So a race
  // that misses the bound is timed again beside the control, in alternate rounds that share the
  // runner's moments: a slow runner slows both alike, while a slower race path (a lock, a round
  // trip, a retry) slows only the race and fails the ratio. A short pause still gets another race.
  // Its time limit covers a first race and three pairs at the ceiling.
  it('answers every client within a second at the 99th percentile', { retry: 2, timeout: 60_000 }, async () => {
    const answers = await race(await resource(), `timed-${randomUUID().slice(0, 8)}`);
    const first = p99(answers.map(({ ms }) => ms));
    if (first < BOUND_MS) return;
    const races: number[] = [];
    const ratios: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const van = await resource();
      const controlled = p99(await control(van));
      const raced = p99((await race(van, `paired-${randomUUID().slice(0, 8)}`)).map(({ ms }) => ms));
      races.push(raced);
      ratios.push(raced / controlled);
    }
    const seen =
      `p99 ${Math.round(first)} ms missed ${BOUND_MS} ms; beside the control: ` +
      `${races.map(Math.round).join(', ')} ms, ${ratios.map((r) => r.toFixed(2)).join(', ')} times its p99`;
    expect(median(ratios), seen).toBeLessThanOrEqual(MAX_RATIO);
    expect(median(races), seen).toBeLessThan(CEILING_MS);
  });
});
