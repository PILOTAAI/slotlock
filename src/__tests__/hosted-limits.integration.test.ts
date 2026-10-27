// `slotlock serve` as the hosted service runs it, against real Postgres on a real socket: the
// request limits that are its only rate limit (the edge is Cloudflare Free), the key-lookup queue
// under a flood of made-up keys, one tenant's recurring writes beside another tenant's reads, and
// the log line that counts refusals. Each case reproduces a flood from the 2026-10-24 readiness
// audit (SEC-1/SURF-1/PROD-8/HOST-3/GAP4-2, SEC-2/SURF-2, SEC-3/GAP4-4, SEC-4) that every request
// answered without a limit before this. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLOTLOCK_A2A_PROTOCOL_VERSION, SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION } from '../agent-server.js';
import { slotlockCalendarResourceUri } from '../agent-server.js';
import { type SlotlockEnv, runSlotlockCli } from '../self-host.js';
import { SseReader, modernRequest } from './helpers/modern-mcp.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const openApi = JSON.parse(readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')) as {
  components: { schemas: { Error: unknown } };
};
/** The audit's crafted rule: never an occurrence, so expansion runs to its step and time budget. */
const COSTLY_RULE = 'FREQ=DAILY;INTERVAL=9999;BYMONTH=2;BYMONTHDAY=29';
const HOUR_MS = 3_600_000;

/**
 * Midnight UTC `days` after today, plus `hours`: inside the 367-day horizon, where a write on a
 * resource with a series is not refused as recurrence_not_materialized. Each case keeps to days of
 * its own, since cases share the tenants' resources.
 */
function soon(days: number, hours = 0): Date {
  const today = new Date();
  return new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) +
      (days * 24 + hours) * HOUR_MS,
  );
}

/** An RFC 3339 UTC timestamp to the second, as the API takes it. */
function at(date: Date): string {
  return date.toISOString().replace('.000', '');
}

function output() {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => chunks.push(chunk),
    text: () => chunks.join(''),
    events: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function eventually<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Answer {
  status: number;
  headers: Headers;
  body: unknown;
  ms: number;
}

/** One request with fetch, read whole. */
async function call(
  origin: string,
  method: string,
  path: string,
  options: { key?: string | undefined; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const started = performance.now();
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}),
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: kept as text.
  }
  return { status: response.status, headers: response.headers, body, ms: performance.now() - started };
}

/**
 * Many requests at once over node:http with a bounded socket pool, so a flood of a thousand or more
 * reaches the server without the client's own listen backlog refusing connections.
 */
function rawGet(
  agent: Agent,
  origin: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; retryAfter: string | null }> {
  const target = new URL(path, origin);
  return new Promise((resolve) => {
    const sent = httpRequest(
      { host: target.hostname, port: target.port, path: target.pathname, agent, headers, timeout: 60_000 },
      (response) => {
        response.resume();
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            retryAfter: (response.headers['retry-after'] as string | undefined) ?? null,
          }),
        );
      },
    );
    sent.on('timeout', () => sent.destroy(new Error('timeout')));
    sent.on('error', () => resolve({ status: 0, retryAfter: null }));
    sent.end();
  });
}

/** The middle value: one stall of a loaded runner moves the largest sample, not this. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] as number) + upper) / 2;
}

function tally(statuses: number[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

/** A made-up key that passes the format and checksum check, as anyone can mint (SEC-2). */
async function madeUpKey(): Promise<string> {
  const { generateSlotlockApiKey } = await import('../api-keys.js');
  return generateSlotlockApiKey().key;
}

describe.skipIf(!url)('hosted serve limits (real Postgres, real socket)', () => {
  const role = `slotlock_hosted_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenants = {
    a: `hosted-a-${randomUUID()}`,
    b: `hosted-b-${randomUUID()}`,
  };
  /** Tenants a case makes for itself, removed with the rest. */
  const extraTenants: string[] = [];
  const keys: Record<string, string> = {};
  const resources: Record<string, string> = {};
  let admin: ReturnType<typeof postgres>;
  let base: SlotlockEnv;

  async function cli(argv: string[], env: SlotlockEnv) {
    const stdout = output();
    const stderr = output();
    const code = await runSlotlockCli(argv, {
      env,
      stdout,
      stderr,
      signal: new AbortController().signal,
    });
    expect(stderr.events().filter(({ level }) => level === 'error')).toEqual([]);
    expect(code).toBe(0);
    return stdout;
  }

  async function serve(extra: SlotlockEnv = {}) {
    const stdout = output();
    const stderr = output();
    const shutdown = new AbortController();
    const done = runSlotlockCli(['serve'], {
      env: { ...base, ...extra },
      stdout,
      stderr,
      signal: shutdown.signal,
    });
    const listening = await eventually(
      () =>
        stdout.events().find(({ event }) => event === 'listening') ??
        (stderr.text() ? (() => {
          throw new Error(stderr.text());
        })() : undefined),
    );
    return {
      origin: listening.address as string,
      listening,
      stdout,
      stderr,
      async stop() {
        shutdown.abort();
        expect(await done).toBe(0);
      },
    };
  }

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    const applicationUrl = new URL(url as string);
    applicationUrl.username = role;
    applicationUrl.password = password;
    base = {
      DATABASE_URL: applicationUrl.href,
      SLOTLOCK_MIGRATE_DATABASE_URL: url,
      HOST: '127.0.0.1',
      PORT: '0',
      SLOTLOCK_PUBLIC_URL: 'http://localhost:8080',
    };
    await cli(['migrate'], base);
    for (const [name, tenantRef] of Object.entries(tenants)) {
      const env = { ...base, SLOTLOCK_TENANT: tenantRef };
      const resource = await cli(['resource', 'add', `vehicle-${name}`, '--timezone', 'UTC'], env);
      resources[name] = JSON.parse(resource.text()).id as string;
      for (const [label, scope] of [
        ['admin', 'read,write,admin'],
        ['second', 'read,write'],
      ] as const) {
        const created = await cli(['key', 'create', `${name}-${label}`, '--scope', scope], env);
        keys[`${name}-${label}`] = JSON.parse(created.text()).key as string;
      }
    }
  });

  afterAll(async () => {
    const refs = [...Object.values(tenants), ...extraTenants];
    await admin`DELETE FROM slotlock.resources WHERE tenant_ref IN ${admin(refs)}`;
    await admin`DELETE FROM slotlock.api_keys WHERE tenant_ref IN ${admin(refs)}`;
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('answers a flood of 2,000 GETs with 429 rate_limited, Retry-After and the RateLimit fields (SEC-1)', async () => {
    const server = await serve();
    try {
      const statuses: number[] = [];
      let refused: Answer | undefined;
      let allowed: Answer | undefined;
      const started = performance.now();
      for (let index = 0; index < 2_000; index += 1) {
        const answer = await call(server.origin, 'GET', '/v1/resources', { key: keys['a-admin'] });
        statuses.push(answer.status);
        if (answer.status === 429) refused ??= answer;
        else allowed ??= answer;
      }
      const seconds = (performance.now() - started) / 1_000;
      const counts = tally(statuses);
      // At most the per-tenant read budget got through: 40 at once, then 20 a second.
      expect(counts['200'] ?? 0).toBeLessThanOrEqual(40 + Math.ceil(20 * seconds) + 1);
      expect(counts['429']).toBeGreaterThan(1_000);
      expect(Object.keys(counts).sort()).toEqual(['200', '429']);

      expect(refused?.body).toEqual(expect.objectContaining({ status: 429, code: 'rate_limited', error: { code: 'rate_limited' } }));
      // The body is openapi.json's Error.
      expect(openApi.components.schemas.Error).toMatchObject({
        required: expect.arrayContaining(['type', 'status', 'code', 'error']),
        properties: { error: { required: ['code'], properties: { code: { type: 'string' } } } },
      });
      const retryAfter = Number(refused?.headers.get('retry-after'));
      expect(Number.isInteger(retryAfter) && retryAfter >= 1).toBe(true);
      // draft-ietf-httpapi-ratelimit-headers-11: RateLimit `"<policy>";r=<remaining>;t=<seconds>`
      // and RateLimit-Policy `"<policy>";q=<quota>;w=<window seconds>`. Retry-After is not earlier
      // than the end of the effective window (§6).
      const limit = /^"([a-z_]+)";r=0;t=(\d+)$/.exec(refused?.headers.get('ratelimit') ?? '');
      expect(limit, refused?.headers.get('ratelimit') ?? 'no RateLimit field').not.toBeNull();
      expect(retryAfter).toBeGreaterThanOrEqual(Number(limit?.[2]));
      expect(refused?.headers.get('ratelimit-policy')).toMatch(
        new RegExp(`^"${limit?.[1]}";q=\\d+;w=\\d+$`),
      );
      expect(allowed?.headers.get('ratelimit')).toMatch(/^"[a-z_]+";r=\d+;t=\d+$/);
    } finally {
      await server.stop();
    }
  }, 120_000);

  it("answers a flood of 300 application writes with 429 from the application's own write budget (SEC-1, SURF-1, PROD-8)", async () => {
    const server = await serve({ SLOTLOCK_LIMITS: 'address=off' });
    try {
      const statuses: number[] = [];
      const policies = new Set<string>();
      const started = performance.now();
      for (let index = 0; index < 300; index += 1) {
        const answer = await call(server.origin, 'POST', '/v1/resources', {
          key: keys['a-admin'],
          body: { external_ref: `flood-${index}-${randomUUID()}`, timezone: 'UTC' },
        });
        statuses.push(answer.status);
        if (answer.status === 429) {
          policies.add(/^"([a-z_]+)"/.exec(answer.headers.get('ratelimit') ?? '')?.[1] ?? '');
        }
      }
      const seconds = (performance.now() - started) / 1_000;
      const counts = tally(statuses);
      expect(counts['200'] ?? 0).toBeLessThanOrEqual(20 + Math.ceil(5 * seconds) + 1);
      expect(counts['429']).toBeGreaterThan(200);
      expect([...policies]).toEqual(['app_write']);
      // The tenant's agents keep their own budget while the application's is spent.
      const agentWrite = await call(server.origin, 'POST', '/v1/events', {
        key: keys['a-admin'],
        body: {
          resource_id: resources.a,
          starts_at: at(soon(40, 9)),
          ends_at: at(soon(40, 10)),
          timezone: 'UTC',
          idempotency_key: `after-flood-${randomUUID()}`,
        },
      });
      expect(agentWrite.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  it('limits each key, its tenant and the whole server separately', async () => {
    const server = await serve({ SLOTLOCK_LIMITS: 'address=off,key_read=2/m:2,tenant_read=3/m:3' });
    try {
      const get = async (key: string) => {
        const answer = await call(server.origin, 'GET', '/v1/resources', { key });
        return answer.status === 429
          ? `429 ${/^"([a-z_]+)"/.exec(answer.headers.get('ratelimit') ?? '')?.[1]}`
          : String(answer.status);
      };
      // A key's own budget, then the tenant's: another key of the tenant gets what is left.
      expect([await get(keys['a-admin'] as string), await get(keys['a-admin'] as string)]).toEqual([
        '200',
        '200',
      ]);
      expect(await get(keys['a-admin'] as string)).toBe('429 key_read');
      expect(await get(keys['a-second'] as string)).toBe('200');
      expect(await get(keys['a-second'] as string)).toBe('429 tenant_read');
      // Another tenant has its own budget.
      expect(await get(keys['b-admin'] as string)).toBe('200');
    } finally {
      await server.stop();
    }

    // The server's write budget is shared by every tenant: two writes, whichever tenant asks.
    const writes = await serve({ SLOTLOCK_LIMITS: 'address=off,global_write=2/m:2' });
    try {
      const write = (key: string | undefined) =>
        call(writes.origin, 'POST', '/v1/resources', {
          key,
          body: { external_ref: `global-${randomUUID()}`, timezone: 'UTC' },
        });
      const first = await write(keys['b-admin']);
      expect(first.status).toBe(200);
      expect(first.headers.get('ratelimit')).toBe('"global_write";r=1;t=30');
      expect(first.headers.get('ratelimit-policy')).toBe('"global_write";q=2;w=60');
      expect((await write(keys['a-admin'])).status).toBe(200);
      const third = await write(keys['b-admin']);
      expect(third.status).toBe(429);
      expect(third.headers.get('ratelimit')).toMatch(/^"global_write";r=0;t=\d+$/);
    } finally {
      await writes.stop();
    }
  });

  it('answers MCP and A2A past the budget with their own rate-limit errors and Retry-After', async () => {
    const server = await serve({ SLOTLOCK_LIMITS: 'address=off,tenant_read=1/m:1' });
    try {
      const mcp = () =>
        call(server.origin, 'POST', '/mcp', {
          key: keys['a-admin'],
          headers: {
            'MCP-Protocol-Version': SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
            Accept: 'application/json, text/event-stream',
          },
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'slotlock_list_resources', arguments: { limit: 1 } },
          },
        });
      expect((await mcp()).status).toBe(200);
      const limited = await mcp();
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32029, message: 'Rate limit exceeded' },
      });
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(limited.headers.get('ratelimit')).toMatch(/^"(key|tenant)_read";r=0;t=\d+$/);

      const a2a = await call(server.origin, 'POST', '/a2a', {
        key: keys['a-second'],
        headers: { 'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION },
        body: {
          jsonrpc: '2.0',
          id: 'm-1',
          method: 'SendMessage',
          params: {
            message: {
              messageId: `message-${randomUUID()}`,
              role: 'ROLE_USER',
              parts: [
                { data: { skill: 'slotlock_list_resources', arguments: {} }, mediaType: 'application/json' },
              ],
            },
          },
        },
      });
      // A2A keeps its errors in the JSON-RPC envelope (A2A §9.5).
      expect(a2a.status).toBe(200);
      expect(a2a.body).toMatchObject({
        error: { code: -32029, data: [{ reason: 'RATE_LIMITED', domain: 'slotlock' }] },
      });
      expect(Number(a2a.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    } finally {
      await server.stop();
    }
  });

  it('limits each client address before any key is looked up, from a configured trusted header only', async () => {
    const server = await serve({
      SLOTLOCK_TRUSTED_PROXY_HEADER: 'CF-Connecting-IP',
      SLOTLOCK_LIMITS: 'address=5/m:5',
    });
    try {
      const from = async (address: string, key: string) =>
        (
          await call(server.origin, 'GET', '/v1/resources', {
            key,
            headers: { 'CF-Connecting-IP': address },
          })
        ).status;
      const flood: number[] = [];
      for (let index = 0; index < 8; index += 1) {
        flood.push(await from('203.0.113.7', await madeUpKey()));
      }
      expect(flood).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
      // Limited before authentication: a valid key from that address waits like the rest.
      expect(await from('203.0.113.7', keys['b-admin'] as string)).toBe(429);
      expect(await from('203.0.113.8', keys['b-admin'] as string)).toBe(200);
      // An IPv6 client is one /64: rotating the interface identifier does not buy a new budget.
      for (const address of ['2001:db8::1', '2001:db8::2', '2001:db8::3', '2001:db8::4', '2001:db8::5']) {
        expect(await from(address, keys['b-admin'] as string)).toBe(200);
      }
      expect(await from('2001:db8::ffff', keys['b-admin'] as string)).toBe(429);
      expect(await from('2001:db8:0:1::1', keys['b-admin'] as string)).toBe(200);
      // A value that is not an address is not trusted as one: the socket's address stands in.
      expect(await from('not-an-address', keys['b-admin'] as string)).toBe(200);
    } finally {
      await server.stop();
    }
    // The refusals were counted, with each client as a pseudonym rather than its address (SEC-4).
    const counted = server.stdout.events().filter(({ event }) => event === 'refusals');
    expect(counted.length).toBeGreaterThan(0);
    const totals = counted.reduce<Record<string, number>>((sum, line) => {
      for (const reason of ['auth_refused', 'rate_limited'] as const) {
        sum[reason] = (sum[reason] ?? 0) + Number(line[reason] ?? 0);
      }
      return sum;
    }, {});
    expect(totals).toEqual({ auth_refused: 5, rate_limited: 5 });
    const logged = server.stdout.text();
    for (const address of ['203.0.113.7', '2001:db8', 'not-an-address']) {
      expect(logged).not.toContain(address);
    }
    expect(counted[0]?.clients).toEqual(
      expect.arrayContaining([expect.objectContaining({ client: expect.stringMatching(/^[0-9a-f]{16}$/) })]),
    );
  });

  it('never answers a valid key 401 while a flood of made-up keys overflows the lookup queue (SEC-2)', async () => {
    const server = await serve({
      SLOTLOCK_TRUSTED_PROXY_HEADER: 'CF-Connecting-IP',
      SLOTLOCK_LIMITS: 'key_lookup_queue=16',
    });
    // Below the listen backlog macOS allows (somaxconn 128), so every connection is accepted. The
    // valid key's client has connections of its own, as another client would.
    const agent = new Agent({ keepAlive: true, maxSockets: 100 });
    const validAgent = new Agent({ keepAlive: true, maxSockets: 4 });
    try {
      const valid = { Authorization: `Bearer ${keys['a-admin']}`, 'CF-Connecting-IP': '192.0.2.10' };
      expect((await rawGet(validAgent, server.origin, '/v1/resources', valid)).status).toBe(200);
      const fakes = await Promise.all(
        Array.from({ length: 1_500 }, (_, index) => madeUpKey().then((key) => ({ key, index }))),
      );
      const flood = fakes.map(({ key, index }) =>
        rawGet(agent, server.origin, '/v1/resources', {
          Authorization: `Bearer ${key}`,
          // Every made-up key from an address of its own, so the per-address limit does not stop
          // the flood before the lookup queue.
          'CF-Connecting-IP': `198.18.${index >> 8}.${index & 255}`,
        }),
      );
      const asked: Promise<{ status: number; retryAfter: string | null }>[] = [];
      for (let round = 0; round < 20; round += 1) {
        asked.push(rawGet(validAgent, server.origin, '/v1/resources', valid));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const validAnswers = await Promise.all(asked);
      const floodAnswers = await Promise.all(flood);
      const floodStatuses = tally(floodAnswers.map(({ status }) => status));
      // Before: 401 authentication_required for nearly every call, as if the key were revoked. A
      // key that authenticated waits ahead of the made-up ones, and an overloaded server says busy.
      expect(validAnswers.map(({ status }) => status)).not.toContain(401);
      expect(validAnswers.filter(({ status }) => status === 200).length).toBeGreaterThanOrEqual(18);
      expect(
        validAnswers.every(({ status, retryAfter }) => status === 200 || (status === 503 && retryAfter === '1')),
      ).toBe(true);
      // Canary: the flood did overflow the queue, and overflow is busy with Retry-After, never 401.
      expect(floodStatuses['503'] ?? 0, JSON.stringify(floodStatuses)).toBeGreaterThan(0);
      expect(Object.keys(floodStatuses).sort()).toEqual(['401', '503']);
      expect(
        floodAnswers.filter(({ status }) => status === 503).every(({ retryAfter }) => Number(retryAfter) >= 1),
      ).toBe(true);
    } finally {
      agent.destroy();
      validAgent.destroy();
      await server.stop();
    }
    // The overflow was counted (SEC-4), apart from the made-up keys' 401s.
    const counted = server.stdout.events().filter(({ event }) => event === 'refusals');
    const sum = (reason: string) => counted.reduce((total, line) => total + Number(line[reason] ?? 0), 0);
    expect(sum('lookup_overflow')).toBeGreaterThan(0);
    expect(sum('auth_refused')).toBeGreaterThan(0);
  }, 60_000);

  it("keeps another tenant's reads fast while one tenant fires 50 costly recurring writes (SEC-3)", async () => {
    const server = await serve({ SLOTLOCK_LIMITS: 'address=off' });
    try {
      // Hosted: writes take effect at once (no confirmation round), so each write expands its rule.
      const one = await call(server.origin, 'POST', '/v1/events', {
        key: keys['a-second'],
        body: {
          resource_id: resources.a,
          starts_at: at(soon(55, 9)),
          ends_at: at(new Date(soon(55, 9).getTime() + 600_000)),
          timezone: 'UTC',
          idempotency_key: `costly-probe-${randomUUID()}`,
          recurrence_rule: COSTLY_RULE,
        },
      });
      expect([200, 400]).toContain(one.status);
      const single = one.ms;

      let sampling = true;
      const reads: number[] = [];
      const sampler = (async () => {
        while (sampling) {
          reads.push((await call(server.origin, 'GET', '/v1/resources', { key: keys['b-second'] })).ms);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const seed = randomUUID();
      const writes = await Promise.all(
        Array.from({ length: 50 }, (_, index) => {
          const start = new Date(soon(60).getTime() + index * HOUR_MS);
          return call(server.origin, 'POST', '/v1/events', {
            key: keys['a-admin'],
            body: {
              resource_id: resources.a,
              starts_at: start.toISOString().replace('.000', ''),
              ends_at: new Date(start.getTime() + 600_000).toISOString().replace('.000', ''),
              timezone: 'UTC',
              idempotency_key: `costly-${seed}-${index}`,
              recurrence_rule: COSTLY_RULE,
            },
          });
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      sampling = false;
      await sampler;

      const worst = Math.max(...reads);
      const outcomes = tally(writes.map(({ status }) => status));
      // One expansion may hold the event loop while a read waits; fifty in a row may not. Before
      // the limits the worst read waited for every write: 23 s on the audit's 1-CPU container.
      expect(worst, `worst read ${worst.toFixed(0)} ms, one write ${single.toFixed(0)} ms, ${JSON.stringify(outcomes)}`).toBeLessThan(
        Math.max(1_000, 3 * single),
      );
      expect(outcomes['429'] ?? 0).toBeGreaterThan(40);
      const refused = writes.find(({ status }) => status === 429);
      expect(refused?.body).toEqual(expect.objectContaining({ status: 429, code: 'rate_limited', error: { code: 'rate_limited' } }));
      expect(Number(refused?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    } finally {
      await server.stop();
    }
  }, 120_000);

  it("answers another tenant's recurring create and update within about one expansion while one tenant fires 50 costly writes (P11)", async () => {
    const server = await serve({ SLOTLOCK_LIMITS: 'address=off' });
    try {
      const costly = (index: number, seed: string) => {
        const start = new Date(soon(100).getTime() + index * HOUR_MS);
        return call(server.origin, 'POST', '/v1/events', {
          key: keys['a-admin'],
          body: {
            resource_id: resources.a,
            starts_at: start.toISOString().replace('.000', ''),
            ends_at: new Date(start.getTime() + 600_000).toISOString().replace('.000', ''),
            timezone: 'UTC',
            idempotency_key: `costly-${seed}-${index}`,
            recurrence_rule: COSTLY_RULE,
          },
        });
      };
      const single = (await costly(0, randomUUID())).ms;
      // Tenant B's own event, made before the burst, to update during it.
      const made = await call(server.origin, 'POST', '/v1/events', {
        key: keys['b-second'],
        body: {
          resource_id: resources.b,
          starts_at: at(soon(150, 9)),
          ends_at: at(soon(150, 10)),
          timezone: 'UTC',
          idempotency_key: `fair-made-${randomUUID()}`,
        },
      });
      expect(made.status).toBe(200);
      const event = (made.body as { event: { id: string; revision: number } }).event;

      const seed = randomUUID();
      const burst = Promise.all(Array.from({ length: 50 }, (_, index) => costly(index + 1, seed)));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const recurring = await call(server.origin, 'POST', '/v1/events', {
        key: keys['b-second'],
        body: {
          resource_id: resources.b,
          starts_at: at(soon(151, 9)),
          ends_at: at(soon(151, 10)),
          timezone: 'UTC',
          idempotency_key: `fair-recurring-${randomUUID()}`,
          recurrence_rule: 'FREQ=WEEKLY;COUNT=4',
        },
      });
      const updated = await call(server.origin, 'PATCH', `/v1/events/${encodeURIComponent(event.id)}`, {
        key: keys['b-second'],
        body: {
          expected_revision: event.revision,
          title: 'Renamed during the burst',
          idempotency_key: `fair-update-${randomUUID()}`,
        },
      });
      const outcomes = tally((await burst).map(({ status }) => status));
      const detail = `one costly write ${single.toFixed(0)} ms, create ${recurring.ms.toFixed(0)} ms, update ${updated.ms.toFixed(0)} ms, A ${JSON.stringify(outcomes)}`;
      // Before slots were shared fairly, B queued behind every one of A's waiting writes and was
      // answered 503 server_busy once it had waited two seconds.
      expect([recurring.status, updated.status], detail).toEqual([200, 200]);
      // A write of A's may be expanding when B's arrives, and B's own expansion follows it. Queued
      // behind A's writes instead, B waited the two seconds and was refused; a floor of a second
      // keeps a loaded runner's slower expansions (a 110 ms write took 416 ms) from failing it.
      expect(Math.max(recurring.ms, updated.ms), detail).toBeLessThan(Math.max(1_000, 3 * single));
      expect(outcomes['429'] ?? 0, detail).toBeGreaterThan(40);
    } finally {
      await server.stop();
    }
  }, 120_000);

  it("answers another tenant's update and reads within a few expansions while six tenants keep firing costly writes (P11, SEC-3)", async () => {
    // The verifier's cross-process probe: with a freed slot handed straight to the next waiter, one
    // of the bursting tenants' expansions ran on each turn of the event loop another tenant's request
    // needed. With six tenants and 500 ms expansions, that tenant's update took 3.3 s and its reads
    // up to 2.8 s; tenants are free on the hosted service.
    const bursting: Array<{ key: string; resource: string }> = [];
    for (let index = 0; index < 6; index += 1) {
      const tenantRef = `hosted-burst-${index}-${randomUUID()}`;
      extraTenants.push(tenantRef);
      const env = { ...base, SLOTLOCK_TENANT: tenantRef };
      const resource = await cli(['resource', 'add', `vehicle-burst-${index}`, '--timezone', 'UTC'], env);
      const key = await cli(['key', 'create', `burst-${index}`, '--scope', 'read,write'], env);
      bursting.push({
        resource: JSON.parse(resource.text()).id as string,
        key: JSON.parse(key.text()).key as string,
      });
    }
    const server = await serve({ SLOTLOCK_LIMITS: 'address=off' });
    let firing = true;
    const seed = randomUUID();
    let sent = 0;
    const costly = (tenant: { key: string; resource: string }) => {
      const index = (sent += 1);
      const start = new Date(soon(200).getTime() + index * HOUR_MS);
      return call(server.origin, 'POST', '/v1/events', {
        key: tenant.key,
        body: {
          resource_id: tenant.resource,
          starts_at: start.toISOString().replace('.000', ''),
          ends_at: new Date(start.getTime() + 600_000).toISOString().replace('.000', ''),
          timezone: 'UTC',
          idempotency_key: `burst-${seed}-${index}`,
          recurrence_rule: COSTLY_RULE,
        },
      });
    };
    const ran = new Set<number>();
    const outcomes: number[] = [];
    let burst: Promise<void>[] = [];
    try {
      const single = (await costly(bursting[0] as { key: string; resource: string })).ms;
      const made = await call(server.origin, 'POST', '/v1/events', {
        key: keys['b-second'],
        body: {
          resource_id: resources.b,
          starts_at: at(soon(260, 9)),
          ends_at: at(soon(260, 10)),
          timezone: 'UTC',
          idempotency_key: `six-made-${randomUUID()}`,
        },
      });
      expect(made.status).toBe(200);
      const event = (made.body as { event: { id: string; revision: number } }).event;
      // The server is a process of its own: B's first update and read there run code not yet
      // compiled, which a loaded runner turned into an 842 ms update (then 40 and 24 ms). Warm them
      // up untimed, before the burst.
      const warm = await call(server.origin, 'PATCH', `/v1/events/${encodeURIComponent(event.id)}`, {
        key: keys['b-second'],
        body: {
          expected_revision: event.revision,
          title: 'Warm before six tenants fire',
          idempotency_key: `six-warm-${randomUUID()}`,
        },
      });
      expect(warm.status).toBe(200);
      expect((await call(server.origin, 'GET', '/v1/resources', { key: keys['b-second'] })).status).toBe(200);
      // Each tenant keeps five costly writes in flight: one running and four waiting.
      burst = Array.from({ length: 6 * 5 }, async (_, index) => {
        const tenant = index % 6;
        while (firing) {
          const answer = await costly(bursting[tenant] as { key: string; resource: string });
          outcomes.push(answer.status);
          // The step budget refuses the crafted rule (400 invalid_event) once it has expanded it,
          // so a 400 had a slot as much as a 200 did.
          if (answer.status === 200 || answer.status === 400) ran.add(tenant);
        }
      });
      // Once each bursting tenant has had a slot, B, with one write in flight, goes first.
      await eventually(() => (ran.size === 6 ? true : undefined), 60_000);
      const reads: number[] = [];
      for (let index = 0; index < 8; index += 1) {
        reads.push((await call(server.origin, 'GET', '/v1/resources', { key: keys['b-second'] })).ms);
      }
      // Not only B's first update: each of them, although B has had a slot just before.
      const updates: Array<{ status: number; ms: number }> = [];
      let revision = (warm.body as { event: { revision: number } }).event.revision;
      for (let index = 0; index < 3; index += 1) {
        const updated = await call(server.origin, 'PATCH', `/v1/events/${encodeURIComponent(event.id)}`, {
          key: keys['b-second'],
          body: {
            expected_revision: revision,
            title: `Renamed while six tenants fire (${index + 1})`,
            idempotency_key: `six-update-${randomUUID()}`,
          },
        });
        updates.push({ status: updated.status, ms: updated.ms });
        if (updated.status !== 200) break;
        revision = (updated.body as { event: { revision: number } }).event.revision;
      }
      const detail = `one costly write ${single.toFixed(0)} ms, updates ${updates.map(({ status, ms }) => `${status} in ${ms.toFixed(0)}`).join(', ')} ms, reads ${reads.map((ms) => ms.toFixed(0)).join(', ')} ms, bursts ${JSON.stringify(tally(outcomes))}`;
      expect(updates.map(({ status }) => status), detail).toEqual([200, 200, 200]);
      for (const updated of updates) {
        // The expansion running when the update arrives, its slot's rest, and the update itself.
        // The floor of a second, as above, is for one stall of a loaded runner; starved, the
        // update waited 3.3 s.
        expect(updated.ms, detail).toBeLessThan(Math.max(1_000, 4 * single));
      }
      // A read waits for at most the expansion running when it arrives.
      expect(Math.max(...reads), detail).toBeLessThan(Math.max(1_000, 2 * single));
      // And most reads wait for none: a freed slot rests before the next expansion starts. Handed
      // straight to the next waiter instead, every read waited for one (medians of 100 to 150 ms
      // with 150 to 240 ms writes, against 8 to 9 ms resting), where the bounds above, measured
      // against a whole expansion, still passed.
      expect(median(reads), detail).toBeLessThan(Math.max(25, single / 4));
    } finally {
      firing = false;
      await Promise.all(burst);
      await server.stop();
    }
  }, 180_000);

  it("warns once when a proxy's client-address field arrives but none is trusted (HOST-3)", async () => {
    // Behind cloudflared and kamal-proxy without SLOTLOCK_TRUSTED_PROXY_HEADER, every client would
    // share the proxy's one address budget.
    const server = await serve();
    try {
      for (const address of ['203.0.113.7', '203.0.113.8']) {
        const answer = await call(server.origin, 'GET', '/v1/resources', {
          key: keys['b-second'],
          headers: { 'CF-Connecting-IP': address },
        });
        expect(answer.status).toBe(200);
      }
    } finally {
      await server.stop();
    }
    const warnings = server.stderr.events().filter(({ event }) => event === 'client_address_field_ignored');
    expect(warnings).toEqual([
      expect.objectContaining({
        level: 'warn',
        field: 'cf-connecting-ip',
        setting: 'SLOTLOCK_TRUSTED_PROXY_HEADER',
      }),
    ]);
    expect(`${server.stdout.text()}${server.stderr.text()}`).not.toContain('203.0.113.');
  });

  it("caps each tenant's live-update streams, so one tenant's keys cannot hold every slot (SURF-3)", async () => {
    const server = await serve({ SLOTLOCK_LIMITS: 'tenant_subscriptions=1' });
    const listen = async (key: string | undefined, resource: string | undefined) => {
      const request = modernRequest(
        'subscriptions/listen',
        { notifications: { resourceSubscriptions: [slotlockCalendarResourceUri(resource as string)] } },
        { headers: { Authorization: `Bearer ${key}` } },
      );
      return fetch(`${server.origin}/mcp`, {
        method: 'POST',
        headers: request.headers,
        body: await request.text(),
      });
    };
    const open: SseReader[] = [];
    try {
      const first = await listen(keys['a-admin'], resources.a);
      expect(first.status).toBe(200);
      open.push(new SseReader(first));
      expect(await open[0]?.message()).toMatchObject({
        method: 'notifications/subscriptions/acknowledged',
      });
      // Another key of the same tenant is over the tenant's share.
      const second = await listen(keys['a-second'], resources.a);
      expect(second.status).toBe(429);
      expect(await second.json()).toMatchObject({
        error: { code: -31029, message: 'Too many subscriptions' },
      });
      // Another tenant is not.
      const other = await listen(keys['b-second'], resources.b);
      expect(other.status).toBe(200);
      open.push(new SseReader(other));
      expect(await open[1]?.message()).toMatchObject({
        method: 'notifications/subscriptions/acknowledged',
      });
    } finally {
      for (const reader of open) await reader.cancel();
      await server.stop();
    }
  });

  it('caps the live-update streams the whole server holds with SLOTLOCK_LIMITS subscriptions', async () => {
    const server = await serve({ SLOTLOCK_LIMITS: 'subscriptions=1' });
    const listen = async (key: string | undefined, resource: string | undefined) => {
      const request = modernRequest(
        'subscriptions/listen',
        { notifications: { resourceSubscriptions: [slotlockCalendarResourceUri(resource as string)] } },
        { headers: { Authorization: `Bearer ${key}` } },
      );
      return fetch(`${server.origin}/mcp`, {
        method: 'POST',
        headers: request.headers,
        body: await request.text(),
      });
    };
    const open: SseReader[] = [];
    try {
      const first = await listen(keys['a-admin'], resources.a);
      expect(first.status).toBe(200);
      open.push(new SseReader(first));
      await open[0]?.message();
      // Each tenant would hold one: the other tenant takes nothing from it.
      const other = await listen(keys['b-second'], resources.b);
      expect(other.status).toBe(429);
    } finally {
      for (const reader of open) await reader.cancel();
      await server.stop();
    }
  });

  it("keeps one key below its tenant's live-update streams, so it cannot lock the tenant's other keys out", async () => {
    // The audit's confirmed medium: each key could hold four streams whatever the tenant's cap, so
    // with tenant_subscriptions at four or fewer one key (or one agent) took every one of them.
    const server = await serve({ SLOTLOCK_LIMITS: 'tenant_subscriptions=3' });
    const listen = async (key: string | undefined) => {
      const request = modernRequest(
        'subscriptions/listen',
        { notifications: { resourceSubscriptions: [slotlockCalendarResourceUri(resources.a as string)] } },
        { headers: { Authorization: `Bearer ${key}` } },
      );
      return fetch(`${server.origin}/mcp`, {
        method: 'POST',
        headers: request.headers,
        body: await request.text(),
      });
    };
    const open: SseReader[] = [];
    try {
      const statuses: number[] = [];
      for (const key of [keys['a-admin'], keys['a-admin'], keys['a-admin'], keys['a-second']]) {
        const response = await listen(key);
        statuses.push(response.status);
        if (response.status === 200) {
          const reader = new SseReader(response);
          open.push(reader);
          expect(await reader.message()).toMatchObject({
            method: 'notifications/subscriptions/acknowledged',
          });
        }
      }
      // The first key holds two of the tenant's three; the other key still gets the third.
      expect(statuses).toEqual([200, 200, 429, 200]);
      expect(server.listening).toMatchObject({ limits: { key_subscriptions: 2 } });
    } finally {
      for (const reader of open) await reader.cancel();
      await server.stop();
    }
  });

  it('lets an authenticated write take effect at once by default, as the hosted service runs (SURF-4)', async () => {
    const server = await serve();
    try {
      expect(server.listening).toMatchObject({ confirm_writes: [] });
      const created = await call(server.origin, 'POST', '/v1/events', {
        key: keys['b-second'],
        body: {
          resource_id: resources.b,
          starts_at: at(soon(300, 9)),
          ends_at: at(soon(300, 10)),
          timezone: 'UTC',
          idempotency_key: `hosted-default-${randomUUID()}`,
        },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(created.body).toMatchObject({ event: { resource_id: resources.b } });
    } finally {
      await server.stop();
    }
  });
});
