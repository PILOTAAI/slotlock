// Request budgets shared by every server through PostgreSQL (SLOTLOCK_SHARED_LIMITS): the bucket
// function never gives out more tokens than it has, however many servers race for them; two
// servers' limiters allow a tenant its budget once between them, not once each; and a database
// that cannot be reached leaves each server's own budget in charge. Skipped without DATABASE_URL.
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SlotlockAgentPrincipal } from '../agent-server.js';
import { SLOTLOCK_DEFAULT_LIMITS, type SlotlockLimits, type SlotlockRate } from '../config.js';
import { createSlotlockRequestLimits } from '../rate-limit.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('shared request budgets (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 20, onnotice: () => {} });
    await createSlotlockStore(sql).applySchema();
  });

  afterAll(async () => {
    await sql.end();
  });

  const take = async (bucket: string, rate: SlotlockRate) => {
    const digest = createHash('sha256').update(bucket).digest('hex');
    const [row] = await sql<{ taken: boolean }[]>`
      SELECT slotlock.take_rate_token(${digest}, ${rate.perSecond}, ${rate.burst}) AS taken`;
    return row?.taken === true;
  };

  it('gives twenty racing takes of a five-token bucket exactly five', async () => {
    const bucket = `race-${randomUUID()}`;
    const taken = await Promise.all(Array.from({ length: 20 }, () => take(bucket, { perSecond: 0.001, burst: 5 })));
    expect(taken.filter(Boolean)).toHaveLength(5);
  });

  function server(principal: SlotlockAgentPrincipal, limits: SlotlockLimits, shared?: { take: typeof take }) {
    const limiter = createSlotlockRequestLimits({
      limits,
      basePath: '',
      authenticate: async () => principal,
      ...(shared ? { shared } : {}),
    });
    return limiter.serve({
      async fetch() {
        if (!(await limiter.consumeRateLimit({ principal, operation: 'protocol' }))) {
          return Response.json({ error: { code: 'rate_limited' } }, { status: 429 });
        }
        return Response.json({ ok: true });
      },
    });
  }

  it('allows a tenant its budget once across two servers, and each its own when the database is away', async () => {
    const principal = { subject: 'api_key:1', tenantRef: `shared-${randomUUID()}` };
    const limits: SlotlockLimits = {
      rates: { ...SLOTLOCK_DEFAULT_LIMITS.rates, tenant_read: { perSecond: 0.001, burst: 4 } },
      caps: SLOTLOCK_DEFAULT_LIMITS.caps,
    };
    const statuses = async (servers: ReturnType<typeof server>[]) => {
      const codes: number[] = [];
      for (let round = 0; round < 3; round++) {
        for (const target of servers) {
          const response = await target.fetch(new Request('http://localhost/v1/resources', { headers: { authorization: 'Bearer k' } }), {
            remoteAddress: '203.0.113.7',
          });
          codes.push(response.status);
        }
      }
      return codes.sort();
    };
    // Each server alone would allow 4: the two together allow 4, not 8 (6 asked).
    expect(await statuses([server(principal, limits, { take }), server(principal, limits, { take })])).toEqual([
      200, 200, 200, 200, 429, 429,
    ]);
    const away = { take: async () => Promise.reject(new Error('connection refused')) };
    const other = { ...principal, tenantRef: `shared-${randomUUID()}` };
    expect(await statuses([server(other, limits, away), server(other, limits, away)])).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
  });
});
