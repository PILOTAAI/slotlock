// The request limits of `slotlock serve` without a database or a socket: client addresses as
// bucket keys, the order of the checks (the address before any lookup), the token arithmetic behind
// Retry-After and the RateLimit fields, the series-write and maintenance slots, and the refusal
// counts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_A2A_PROTOCOL_VERSION,
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentInvocationContext,
  type SlotlockAgentPrincipal,
  SlotlockAgentOperationError,
  createSlotlockAgentServer,
} from '../agent-server.js';
import { SLOTLOCK_DEFAULT_LIMITS, type SlotlockLimits } from '../config.js';
import {
  type SlotlockRefusalCounts,
  createSlotlockRequestLimits,
  slotlockClientKey,
} from '../rate-limit.js';

const PRINCIPAL: SlotlockAgentPrincipal = { subject: 'api_key:1', tenantRef: 'fleet-7' };

function limitsWith(overrides: {
  rates?: Partial<SlotlockLimits['rates']>;
  caps?: Partial<SlotlockLimits['caps']>;
}): SlotlockLimits {
  return {
    rates: { ...SLOTLOCK_DEFAULT_LIMITS.rates, ...overrides.rates },
    caps: { ...SLOTLOCK_DEFAULT_LIMITS.caps, ...overrides.caps },
  };
}

/** A clock the test moves. */
function clock() {
  let ms = 0;
  return { now: () => ms, advance: (by: number) => (ms += by) };
}

function setup(
  limits: SlotlockLimits,
  options: { trustedProxyHeader?: string; now?: () => number; signInPaths?: string[] } = {},
) {
  const lookups: string[] = [];
  const refusals: SlotlockRefusalCounts[] = [];
  const limiter = createSlotlockRequestLimits({
    limits,
    basePath: '',
    ...options,
    authenticate: async (request) => {
      lookups.push(request.headers.get('authorization') ?? '');
      return request.headers.get('authorization') === 'Bearer good' ? PRINCIPAL : null;
    },
    onRefusals: (counts) => refusals.push(counts),
  });
  // The agent server's part, in miniature: authenticate, then charge the request.
  const target = limiter.serve({
    async fetch(request) {
      const principal = await limiter.authenticate(request);
      if (!principal) return Response.json({ error: { code: 'authentication_required' } }, { status: 401 });
      if (!(await limiter.consumeRateLimit({ principal, operation: 'protocol' }))) {
        return Response.json({ error: { code: 'rate_limited' } }, { status: 429 });
      }
      return Response.json({ ok: true });
    },
  });
  return { limiter, target, lookups, refusals };
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, { headers });

function tally(statuses: number[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('client addresses', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::ffff:7f00:1', '127.0.0.1'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['[2001:DB8:0:0:ffff::9]', '2001:db8:0:0::/64'],
    ['2001:db8:0:1::1', '2001:db8:0:1::/64'],
    ['::1', '0:0:0:0::/64'],
    ['64:ff9b::192.0.2.33', '64:ff9b:0:0::/64'],
    ['fe80::1%en0', 'fe80:0:0:0::/64'],
  ])('counts %s as %s', (address, key) => {
    expect(slotlockClientKey(address)).toBe(key);
  });

  it.each(['', 'unknown', '203.0.113', '203.0.113.7:443', '2001:db8::1::2', 'example.com'])(
    'does not take %j for an address',
    (value) => {
      expect(slotlockClientKey(value)).toBeNull();
    },
  );

  it('trusts the configured field only, its last address, and the connection otherwise', async () => {
    const { target } = setup(limitsWith({ rates: { address: { perSecond: 1, burst: 1 } } }), {
      trustedProxyHeader: 'x-forwarded-for',
      now: clock().now,
    });
    const from = async (headers: Record<string, string>, remoteAddress = '10.0.0.1') =>
      (await target.fetch(get('/v1/resources', { authorization: 'Bearer good', ...headers }), { remoteAddress }))
        .status;
    // The proxy appends the address it saw; whatever the client wrote before it is not trusted.
    expect(await from({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7' })).toBe(200);
    expect(await from({ 'x-forwarded-for': '198.51.100.2, 203.0.113.7' })).toBe(429);
    expect(await from({ 'x-forwarded-for': '203.0.113.8' })).toBe(200);
    // Without the field, the connection's address; another field is not the configured one.
    expect(await from({ 'cf-connecting-ip': '192.0.2.1' })).toBe(200);
    expect(await from({ 'cf-connecting-ip': '192.0.2.2' })).toBe(429);
  });

  it("says once when a proxy's client-address field arrives while none is trusted (HOST-3)", async () => {
    // Deployed behind cloudflared and kamal-proxy without SLOTLOCK_TRUSTED_PROXY_HEADER, every client
    // is counted as the proxy's address and shares one budget: the field in each request says so.
    const ignored: string[] = [];
    const limiter = createSlotlockRequestLimits({
      limits: SLOTLOCK_DEFAULT_LIMITS,
      basePath: '',
      authenticate: async () => null,
      onIgnoredClientField: (field) => ignored.push(field),
    });
    const target = limiter.serve({ fetch: async () => new Response(null, { status: 204 }) });
    const from = (headers: Record<string, string>) =>
      target.fetch(get('/v1/resources', headers), { remoteAddress: '10.0.0.1' });
    await from({});
    expect(ignored).toEqual([]);
    await from({ 'cf-connecting-ip': '203.0.113.7' });
    await from({ 'x-forwarded-for': '203.0.113.8' });
    expect(ignored).toEqual(['cf-connecting-ip']);
    limiter.close();

    // With a field trusted, another one in a request is the client's own and nothing is said.
    const trusted = createSlotlockRequestLimits({
      limits: SLOTLOCK_DEFAULT_LIMITS,
      trustedProxyHeader: 'cf-connecting-ip',
      basePath: '',
      authenticate: async () => null,
      onIgnoredClientField: (field) => ignored.push(field),
    });
    await trusted
      .serve({ fetch: async () => new Response(null, { status: 204 }) })
      .fetch(get('/v1/resources', { 'x-forwarded-for': '203.0.113.9' }), { remoteAddress: '10.0.0.1' });
    expect(ignored).toEqual(['cf-connecting-ip']);
    trusted.close();
  });
});

describe('the address limit', () => {
  it('refuses before any key is looked up, and counts every request it lets through', async () => {
    const { target, lookups } = setup(
      limitsWith({ rates: { address: { perSecond: 1, burst: 3 } } }),
      { now: clock().now },
    );
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await target.fetch(get('/v1/resources', { authorization: `Bearer fake-${index}` }), {
        remoteAddress: '203.0.113.7',
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429, 429]);
    expect(lookups).toEqual(['Bearer fake-0', 'Bearer fake-1', 'Bearer fake-2']);
  });

  it("never counts the health check, so a flood from the proxy's address cannot fail it (HOST-3)", async () => {
    // Behind kamal-proxy without a trusted client-address field, its health checks come from the
    // same address as every proxied request; the check reuses one database query a second anyway.
    const limiter = createSlotlockRequestLimits({
      limits: limitsWith({ rates: { address: { perSecond: 1, burst: 2 } } }),
      basePath: '/slotlock',
      authenticate: async () => null,
    });
    const target = limiter.serve({ fetch: async () => new Response(null, { status: 204 }) });
    const from = (path: string, method = 'GET') =>
      target.fetch(new Request(`http://localhost${path}`, { method }), { remoteAddress: '10.0.0.9' });
    const statuses: number[] = [];
    for (const path of ['/slotlock/v1/resources', '/slotlock/v1/resources', '/slotlock/v1/resources']) {
      statuses.push((await from(path)).status);
    }
    expect(statuses).toEqual([204, 204, 429]);
    expect((await from('/slotlock/healthz')).status).toBe(204);
    expect((await from('/slotlock/healthz')).status).toBe(204);
    // Only the health check: the same path outside the base path, or another method, is counted.
    expect((await from('/healthz')).status).toBe(429);
    expect((await from('/slotlock/healthz', 'POST')).status).toBe(429);
    limiter.close();
  });

  it('looks a request up once, however often the agent server asks', async () => {
    const lookups: string[] = [];
    const limiter = createSlotlockRequestLimits({
      limits: SLOTLOCK_DEFAULT_LIMITS,
      basePath: '/slotlock',
      authenticate: async (request) => {
        lookups.push(request.url);
        return PRINCIPAL;
      },
    });
    const target = limiter.serve({
      async fetch(request) {
        await limiter.authenticate(request);
        await limiter.authenticate(request);
        // A subscription re-reads with a Request of its own: that one is looked up afresh.
        await limiter.authenticate(new Request(request.url, { headers: request.headers }));
        return new Response(null, { status: 204 });
      },
    });
    await target.fetch(get('/slotlock/mcp', { authorization: 'Bearer good' }), {
      remoteAddress: '127.0.0.1',
    });
    expect(lookups).toEqual(['http://localhost/slotlock/mcp', 'http://localhost/slotlock/mcp']);
    limiter.close();
  });

  it('answers a full lookup queue busy, with Retry-After, in the protocol of the path', async () => {
    const limiter = createSlotlockRequestLimits({
      limits: SLOTLOCK_DEFAULT_LIMITS,
      basePath: '',
      authenticate: async () => {
        throw new SlotlockAgentOperationError('server_busy', 503);
      },
    });
    const target = limiter.serve({ fetch: async () => new Response(null, { status: 204 }) });
    const busy = (path: string, headers: Record<string, string> = {}) =>
      target.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer slk_x', ...headers },
        }),
        { remoteAddress: '127.0.0.1' },
      );
    const rest = await busy('/v1/events');
    expect([rest.status, rest.headers.get('retry-after'), await rest.json()]).toEqual([
      503,
      '1',
      { error: { code: 'server_busy' } },
    ]);
    const mcp = await busy('/mcp');
    expect([mcp.status, await mcp.json()]).toEqual([
      503,
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Server is busy' } },
    ]);
    const a2a = await busy('/a2a');
    expect(a2a.status).toBe(503);
    expect(await a2a.json()).toMatchObject({ error: { data: [{ reason: 'SERVER_BUSY' }] } });
    limiter.close();
  });
});

describe('token buckets', () => {
  it('refills at the configured rate and says when the next token comes', async () => {
    const time = clock();
    const { target } = setup(
      limitsWith({
        rates: { address: null, key_read: null, tenant_read: { perSecond: 0.5, burst: 2 } },
      }),
      { now: time.now },
    );
    const ask = () => target.fetch(get('/v1/resources', { authorization: 'Bearer good' }));
    const first = await ask();
    expect(first.headers.get('ratelimit')).toBe('"tenant_read";r=1;t=2');
    expect(first.headers.get('ratelimit-policy')).toBe('"tenant_read";q=2;w=4');
    expect((await ask()).headers.get('ratelimit')).toBe('"tenant_read";r=0;t=4');
    const refused = await ask();
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('2');
    expect(refused.headers.get('ratelimit')).toBe('"tenant_read";r=0;t=2');
    time.advance(1_000);
    expect((await ask()).headers.get('retry-after')).toBe('1');
    time.advance(1_000);
    expect((await ask()).status).toBe(200);
  });

  it('takes from every bucket or from none, and names the one that frees last', async () => {
    const time = clock();
    const { target } = setup(
      limitsWith({
        rates: {
          address: null,
          key_read: { perSecond: 1, burst: 1 },
          tenant_read: { perSecond: 0.1, burst: 2 },
        },
      }),
      { now: time.now },
    );
    const ask = () => target.fetch(get('/v1/resources', { authorization: 'Bearer good' }));
    expect((await ask()).status).toBe(200);
    // The key's bucket is empty, so nothing is taken from the tenant's.
    const refused = await ask();
    expect(refused.headers.get('ratelimit')).toBe('"key_read";r=0;t=1');
    time.advance(1_000);
    // The tenant's bucket kept the token the refused request did not take.
    const third = await ask();
    expect(third.status).toBe(200);
    expect(third.headers.get('ratelimit')).toBe('"key_read";r=0;t=1');
    time.advance(1_000);
    // The key has a token again and the tenant has 0.2: the answer is the tenant's wait.
    const fourth = await ask();
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get('ratelimit')).toBe('"tenant_read";r=0;t=8');
  });

  it("counts the application API in its tenant's buckets of its own, apart from the agent tools (SURF-1)", async () => {
    const { target } = setup(
      limitsWith({
        rates: {
          address: null,
          key_read: { perSecond: 1, burst: 2 },
          key_write: { perSecond: 1, burst: 1 },
          tenant_read: { perSecond: 1, burst: 2 },
          tenant_write: { perSecond: 1, burst: 1 },
          app_read: { perSecond: 1, burst: 3 },
          app_write: { perSecond: 1, burst: 2 },
        },
      }),
      { now: clock().now },
    );
    const ask = (method: string, path: string) =>
      target.fetch(
        new Request(`http://localhost${path}`, { method, headers: { authorization: 'Bearer good' } }),
        { remoteAddress: '127.0.0.1' },
      );
    const answers: string[] = [];
    const record = async (method: string, path: string) => {
      const response = await ask(method, path);
      answers.push(`${method} ${path} ${response.status} ${response.headers.get('ratelimit')}`);
    };
    // Holds are the application's: they use its write budget, not the agents'.
    await record('POST', '/v1/holds');
    await record('POST', '/v1/holds');
    await record('POST', '/v1/holds');
    // An agent's write and reads still have all of theirs.
    await record('POST', '/v1/events');
    await record('GET', '/v1/resources');
    await record('GET', '/v1/resources');
    // The application's own read of a resource is not the agents' list of them.
    await record('GET', '/v1/resources/r1');
    expect(answers).toEqual([
      'POST /v1/holds 200 "app_write";r=1;t=1',
      'POST /v1/holds 200 "app_write";r=0;t=2',
      'POST /v1/holds 429 "app_write";r=0;t=1',
      'POST /v1/events 200 "key_write";r=0;t=1',
      'GET /v1/resources 200 "key_read";r=0;t=2',
      'GET /v1/resources 429 "key_read";r=0;t=1',
      'GET /v1/resources/r1 200 "app_read";r=0;t=3',
    ]);
  });

  it('keeps its memory bounded under a flood from ever new addresses', async () => {
    const { target } = setup(limitsWith({ rates: { address: { perSecond: 1, burst: 1 } } }), {
      now: clock().now,
    });
    const first = { remoteAddress: '10.0.0.1' };
    expect((await target.fetch(get('/manifest.json'), first)).status).toBe(401);
    expect((await target.fetch(get('/manifest.json'), first)).status).toBe(429);
    const address = (index: number) =>
      `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${(index & 255) + 1}`;
    /** Milliseconds per request for new addresses `from` to `to`. */
    const flood = async (from: number, to: number) => {
      const started = performance.now();
      for (let index = from; index <= to; index += 1) {
        await target.fetch(get('/manifest.json'), { remoteAddress: address(index) });
      }
      return (performance.now() - started) / (to - from + 1);
    };
    // Up to 100,000 keys each new address adds a bucket. Past them, room is made a tenth at a time,
    // so a new address costs about as much, not the sweep of every bucket a scan per request would.
    // A ratio, so a loaded machine slows both floods alike.
    const filling = await flood(1, 99_999);
    const past = await flood(100_000, 120_000);
    expect(past, `${past.toFixed(4)} ms a request past the cap, ${filling.toFixed(4)} before`).toBeLessThan(
      5 * filling,
    );
    // The least recently used buckets went: the first client starts afresh rather than the server
    // growing without bound, and a recent one is still counted.
    expect((await target.fetch(get('/manifest.json'), first)).status).toBe(401);
    expect((await target.fetch(get('/manifest.json'), { remoteAddress: address(120_000) })).status).toBe(
      429,
    );
  }, 60_000);
});

describe('series writes', () => {
  async function inRequest<T>(
    limiter: ReturnType<typeof createSlotlockRequestLimits>,
    work: () => Promise<T>,
  ): Promise<{ outcome: T | unknown; response: Response }> {
    let outcome: T | unknown;
    const target = limiter.serve({
      async fetch() {
        try {
          outcome = await work();
        } catch (error) {
          outcome = error;
        }
        return new Response(null, { status: 204 });
      },
    });
    const response = await target.fetch(get('/v1/events'), { remoteAddress: '127.0.0.1' });
    return { outcome, response };
  }

  it("lets one of a tenant's run, queues a few and refuses the rest, without holding another tenant", async () => {
    const limiter = createSlotlockRequestLimits({
      limits: limitsWith({ caps: { tenant_series_writes: 1, series_writes: 2 } }),
      basePath: '',
      authenticate: async () => null,
    });
    const order: string[] = [];
    let finishFirst: () => void = () => {};
    const write = (tenantRef: string, label: string, hold?: Promise<void>) =>
      inRequest(limiter, async () => {
        await limiter.admit({
          principal: { subject: 's', tenantRef },
          operation: 'slotlock_create_event',
          input: { recurrence_rule: 'FREQ=DAILY' },
        });
        order.push(label);
        await hold;
      });
    const first = write('a', 'a1', new Promise((resolve) => (finishFirst = resolve)));
    await new Promise((resolve) => setImmediate(resolve));
    const queued = [2, 3, 4, 5].map((index) => write('a', `a${index}`));
    const refused = await write('a', 'a6');
    expect(refused.outcome).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(refused.response.headers.get('ratelimit-policy')).toBe(
      '"tenant_series_writes";q=1;qu="concurrent-requests"',
    );
    expect(refused.response.headers.get('retry-after')).toBe('1');
    // Another tenant runs beside it: the server has two slots.
    await write('b', 'b1');
    expect(order).toEqual(['a1', 'b1']);
    finishFirst();
    await first;
    await Promise.all(queued);
    expect(order).toEqual(['a1', 'b1', 'a2', 'a3', 'a4', 'a5']);
    // A one-off create needs no slot.
    const oneOff = await inRequest(limiter, () =>
      limiter.admit({ principal: PRINCIPAL, operation: 'slotlock_create_event', input: {} }),
    );
    expect(oneOff.outcome).toBeUndefined();
    limiter.close();
  });

  it("hands a freed slot to the tenant that ran least recently, never to one tenant's queue first (P11)", async () => {
    const limiter = createSlotlockRequestLimits({
      limits: limitsWith({ caps: { tenant_series_writes: 1, series_writes: 1 } }),
      basePath: '',
      authenticate: async () => null,
    });
    const order: string[] = [];
    const finish: Record<string, () => void> = {};
    const write = (tenantRef: string, label: string) =>
      inRequest(limiter, async () => {
        await limiter.admit({
          principal: { subject: 's', tenantRef },
          operation: 'slotlock_update_event',
          input: {},
        });
        order.push(label);
        await new Promise<void>((resolve) => (finish[label] = resolve));
      });
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const writes = [write('a', 'a1')];
    await tick();
    // Tenant A fills its queue; tenant B and then C ask for one write each behind it.
    for (const index of [2, 3, 4, 5]) writes.push(write('a', `a${index}`));
    await tick();
    writes.push(write('b', 'b1'));
    await tick();
    writes.push(write('c', 'c1'));
    await tick();
    // A freed slot rests for as long as its write kept the event loop busy: wait for each start.
    for (const [index, label] of ['a1', 'b1', 'c1', 'a2', 'a3', 'a4', 'a5'].entries()) {
      await vi.waitFor(() => expect(order).toHaveLength(index + 1));
      expect(order.at(-1)).toBe(label);
      finish[label]?.();
    }
    await Promise.all(writes);
    // B and C each waited for one of A's writes, not for all five.
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'a3', 'a4', 'a5']);
    limiter.close();
  });

  it("serves another tenant's write after the running expansion and its slot's rest while a tenant bursts (P11)", async () => {
    // serve's order for a REST write: the protocol charge, the series slot, then an expansion that
    // holds the event loop. The verifier's probe: with first-come slots, tenant B's one update
    // waited behind every queued write of tenant A, 2.25 s and then 503 with 450 ms expansions.
    const expansionMs = 150;
    const limiter = createSlotlockRequestLimits({
      limits: limitsWith({ rates: { address: null } }),
      basePath: '',
      authenticate: async (request) => ({
        subject: `api_key:${request.headers.get('x-tenant')}`,
        tenantRef: request.headers.get('x-tenant') as string,
      }),
    });
    const target = limiter.serve({
      async fetch(request) {
        const principal = (await limiter.authenticate(request)) as SlotlockAgentPrincipal;
        if (!(await limiter.consumeRateLimit({ principal, operation: 'protocol' }))) {
          return new Response(null, { status: 429 });
        }
        try {
          await limiter.admit({ principal, operation: 'slotlock_update_event', input: {} });
        } catch (error) {
          return new Response(null, { status: (error as SlotlockAgentOperationError).status });
        }
        const until = performance.now() + expansionMs;
        while (performance.now() < until) {
          // An expansion holds the event loop.
        }
        return new Response(null, { status: 200 });
      },
    });
    const update = (tenant: string) =>
      target.fetch(
        new Request('http://localhost/v1/events/e', {
          method: 'PATCH',
          headers: { authorization: 'Bearer k', 'x-tenant': tenant },
        }),
        { remoteAddress: '203.0.113.7' },
      );
    const burst = Array.from({ length: 20 }, () => update('a'));
    const started = performance.now();
    const other = await update('b');
    const waited = performance.now() - started;
    const statuses = tally((await Promise.all(burst)).map(({ status }) => status));
    expect(other.status).toBe(200);
    // One of A's expansions may be running when B arrives, its slot then rests as long, and B's own
    // runs next: three at most.
    expect(waited, `B waited ${waited.toFixed(0)} ms; A: ${JSON.stringify(statuses)}`).toBeLessThan(
      4 * expansionMs,
    );
    expect(statuses).toEqual({ 200: 5, 429: 15 });
    limiter.close();
  });

  it("keeps another tenant's update and reads within a few expansions while six tenants burst (P11, SEC-3)", async () => {
    // The verifier's cross-process probe: a request takes several turns of the event loop before it
    // reaches a slot (its key lookup, then the query behind it), and with a freed slot handed over
    // at once, one of the bursting tenants' expansions ran on every turn. With six tenants bursting,
    // another tenant's update took 6.7 expansions and its reads up to 5.6.
    const expansionMs = 100;
    const lookupTurns = 5;
    const limiter = createSlotlockRequestLimits({
      limits: limitsWith({
        rates: {
          address: null,
          key_read: null,
          key_write: null,
          tenant_read: null,
          tenant_write: null,
          global_read: null,
          global_write: null,
        },
      }),
      basePath: '',
      authenticate: async (request) => {
        // A key lookup: round trips to the database, each a turn of the event loop.
        for (let turn = 0; turn < lookupTurns; turn += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        const tenant = request.headers.get('x-tenant') as string;
        return { subject: `api_key:${tenant}`, tenantRef: tenant };
      },
    });
    const target = limiter.serve({
      async fetch(request) {
        const principal = (await limiter.authenticate(request)) as SlotlockAgentPrincipal;
        if (request.method === 'GET') return new Response(null, { status: 200 });
        try {
          await limiter.admit({ principal, operation: 'slotlock_update_event', input: {} });
        } catch (error) {
          return new Response(null, { status: (error as SlotlockAgentOperationError).status });
        }
        const until = performance.now() + expansionMs;
        while (performance.now() < until) {
          // An expansion holds the event loop.
        }
        return new Response(null, { status: 200 });
      },
    });
    const send = (tenant: string, method: string) =>
      target.fetch(
        new Request('http://localhost/v1/events/e', {
          method,
          headers: { authorization: 'Bearer k', 'x-tenant': tenant },
        }),
        { remoteAddress: '203.0.113.7' },
      );
    let bursting = true;
    const ran = new Set<string>();
    // Six tenants, each keeping five writes in flight: one running and four waiting.
    const burst = Array.from({ length: 6 * 5 }, async (_, index) => {
      const tenant = `burst-${index % 6}`;
      while (bursting) {
        if ((await send(tenant, 'PATCH')).status === 200) ran.add(tenant);
      }
    });
    // Once each has had a slot, a tenant that has not had one lately goes ahead of all of them.
    await vi.waitFor(() => expect(ran.size).toBe(6), { timeout: 10_000, interval: 20 });
    const timed = async (method: string) => {
      const started = performance.now();
      const { status } = await send('b', method);
      return { status, ms: performance.now() - started };
    };
    const reads: number[] = [];
    for (let index = 0; index < 4; index += 1) reads.push((await timed('GET')).ms);
    const update = await timed('PATCH');
    bursting = false;
    await Promise.all(burst);
    limiter.close();
    const detail = `update ${update.ms.toFixed(0)} ms, reads ${reads.map((ms) => ms.toFixed(0)).join(', ')} ms, one expansion ${expansionMs} ms`;
    expect(update.status, detail).toBe(200);
    // The expansion running when the update arrives, the rest of its slot, and the update's own.
    expect(update.ms, detail).toBeLessThan(4 * expansionMs);
    // A read waits for at most the expansion running when it arrives.
    expect(Math.max(...reads), detail).toBeLessThan(2.5 * expansionMs);
  }, 60_000);

  it('charges an MCP or A2A write before it waits for a series slot, so one over budget is refused at once (P11)', async () => {
    // The verifier's probe: on /mcp and /a2a the protocol charge takes a read token only, so tenant
    // A's recurring create over its key_write budget waited two seconds behind tenant B's slot and
    // was then answered server_busy, and counted as a busy series write rather than a rate limit.
    let releaseB: () => void = () => {};
    const bHolds = new Promise<void>((resolve) => (releaseB = resolve));
    const counted: SlotlockRefusalCounts[] = [];
    const limits = createSlotlockRequestLimits({
      limits: limitsWith({ rates: { address: null, key_write: { perSecond: 0.001, burst: 1 } } }),
      basePath: '',
      authenticate: async (request) => {
        const tenant = request.headers.get('authorization') === 'Bearer b' ? 'b' : 'a';
        return { subject: `api_key:${tenant}`, tenantRef: `tenant-${tenant}`, scopes: ['read', 'write'] };
      },
      onRefusals: (line) => counted.push(line),
    });
    const resourceId = '00000000-0000-4000-8000-000000000001';
    const created = {
      event: {
        id: 'e1',
        resource_id: resourceId,
        starts_at: '2029-01-01T00:00:00Z',
        ends_at: '2029-01-01T00:10:00Z',
        timezone: 'UTC',
        title: null,
        description: null,
        location: null,
        organizer: null,
        attendees: [],
        reminders: [],
        status: 'confirmed',
        transparency: 'opaque',
        sequence: 0,
        revision: 1,
        recurrence_rule: 'FREQ=DAILY',
        recurrence_exceptions: [],
        recurrence_id: null,
      },
      replayed: false,
    };
    const agent = createSlotlockAgentServer({
      publicBaseUrl: 'http://localhost',
      allowInsecureLocalhost: true,
      backend: {
        async createEvent(context: SlotlockAgentInvocationContext) {
          if (context.principal.tenantRef === 'tenant-b') await bHolds;
          return created;
        },
      } as unknown as SlotlockAgentCalendarBackend,
      authenticate: limits.authenticate,
      consumeRateLimit: limits.consumeRateLimit,
      authorize: async ({ principal, operation, input }) => {
        await limits.admit({ principal, operation, input });
        return true;
      },
      health: async () => ({ ready: true, checks: [] }),
    });
    const target = limits.serve(agent);
    const create = (key: string, path: '/mcp' | '/a2a', id: number) => {
      const args = {
        resource_id: resourceId,
        starts_at: '2029-01-01T00:00:00Z',
        ends_at: '2029-01-01T00:10:00Z',
        timezone: 'UTC',
        idempotency_key: `k-${id}`,
        recurrence_rule: 'FREQ=DAILY',
      };
      const body =
        path === '/mcp'
          ? { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'slotlock_create_event', arguments: args } }
          : {
              jsonrpc: '2.0',
              id,
              method: 'SendMessage',
              params: {
                message: {
                  messageId: `message-${id}`,
                  role: 'ROLE_USER',
                  parts: [{ data: { skill: 'calendar.create_event', arguments: args }, mediaType: 'application/json' }],
                },
              },
            };
      return target.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(path === '/mcp'
              ? { 'mcp-protocol-version': '2025-06-18' }
              : { 'a2a-version': SLOTLOCK_A2A_PROTOCOL_VERSION }),
          },
          body: JSON.stringify(body),
        }),
        { remoteAddress: '127.0.0.1' },
      );
    };
    // A spends its one write token; B takes the server's only series slot and holds it.
    const first = await create('a', '/mcp', 1);
    expect(await first.text()).not.toMatch(/rate_limited|server_busy/);
    const held = create('b', '/mcp', 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const answers: Array<{ path: string; ms: number; text: string; rateLimit: string | null }> = [];
    for (const [path, id] of [['/mcp', 3], ['/a2a', 4]] as const) {
      const started = performance.now();
      const response = await create('a', path, id);
      answers.push({
        path,
        ms: performance.now() - started,
        text: await response.text(),
        rateLimit: response.headers.get('ratelimit'),
      });
    }
    releaseB();
    await held;
    limits.close();
    for (const answer of answers) {
      const detail = JSON.stringify(answer);
      expect(answer.ms, detail).toBeLessThan(500);
      expect(answer.text, detail).toMatch(/rate_limited|RATE_LIMITED/);
      expect(answer.text, detail).not.toMatch(/server_busy|SERVER_BUSY/);
      expect(answer.rateLimit, detail).toMatch(/^"key_write";r=0;t=\d+$/);
    }
    expect(counted).toEqual([expect.objectContaining({ rate_limited: 2, series_writes_busy: 0 })]);
  }, 15_000);

  it("runs the application API's maintenance in a slot of its own, never holding another tenant's update (P11)", async () => {
    // The verifier's probe: tenant A's maintenance run held the server's only series slot for the
    // whole run, up to ten batches of series, and tenant B's update waited two seconds for it and
    // was answered 503.
    const limiter = createSlotlockRequestLimits({
      limits: SLOTLOCK_DEFAULT_LIMITS,
      basePath: '',
      authenticate: async () => null,
    });
    let finishMaintenance: () => void = () => {};
    const maintenance = inRequest(limiter, async () => {
      await limiter.admit({
        principal: { subject: 'api_key:a', tenantRef: 'a' },
        operation: 'slotlock_run_maintenance',
        input: {},
      });
      await new Promise<void>((resolve) => (finishMaintenance = resolve));
    });
    await new Promise((resolve) => setImmediate(resolve));
    const started = performance.now();
    const update = await inRequest(limiter, () =>
      limiter.admit({
        principal: { subject: 'api_key:b', tenantRef: 'b' },
        operation: 'slotlock_update_event',
        input: { title: 'Renamed' },
      }),
    );
    expect(update.outcome).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
    // Another tenant's maintenance run waits for the server's maintenance slot, and is answered busy
    // once it has waited two seconds.
    const other = await inRequest(limiter, () =>
      limiter.admit({
        principal: { subject: 'api_key:c', tenantRef: 'c' },
        operation: 'slotlock_run_maintenance',
        input: {},
      }),
    );
    expect(other.outcome).toMatchObject({ code: 'server_busy', status: 503 });
    expect(other.response.headers.get('ratelimit-policy')).toBe(
      '"maintenance_runs";q=1;qu="concurrent-requests"',
    );
    finishMaintenance();
    await maintenance;
    limiter.close();
  }, 10_000);

  it('answers busy once a write has waited two seconds for the server', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate'] });
    const limiter = createSlotlockRequestLimits({
      limits: limitsWith({ caps: { tenant_series_writes: 1, series_writes: 1 } }),
      basePath: '',
      authenticate: async () => null,
    });
    const admit = (tenantRef: string) =>
      limiter.admit({
        principal: { subject: 's', tenantRef },
        operation: 'slotlock_update_event',
        input: {},
      });
    const held = inRequest(limiter, () => admit('a').then(() => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(0);
    const waiting = inRequest(limiter, () => admit('b'));
    await vi.advanceTimersByTimeAsync(2_001);
    const { outcome, response } = await waiting;
    expect(outcome).toMatchObject({ code: 'server_busy', status: 503 });
    expect(response.headers.get('ratelimit')).toBe('"series_writes";r=0');
    void held;
    limiter.close();
  });
});

describe('refusal counts', () => {
  it('logs counts with each client as a pseudonym, never its address', async () => {
    const { target, limiter, refusals } = setup(
      limitsWith({ rates: { address: { perSecond: 1, burst: 2 } } }),
      { now: clock().now },
    );
    for (const remoteAddress of ['203.0.113.7', '203.0.113.7', '203.0.113.7', '198.51.100.4']) {
      await target.fetch(get('/v1/resources', { authorization: 'Bearer fake' }), { remoteAddress });
    }
    limiter.close();
    expect(refusals).toHaveLength(1);
    const [line] = refusals;
    expect(line).toMatchObject({ auth_refused: 3, rate_limited: 1, lookup_overflow: 0 });
    expect(line?.clients).toEqual([
      { client: expect.stringMatching(/^[0-9a-f]{16}$/), refusals: 3 },
      { client: expect.stringMatching(/^[0-9a-f]{16}$/), refusals: 1 },
    ]);
    expect(JSON.stringify(refusals)).not.toMatch(/203\.0\.113|198\.51\.100|fake/);
    // Nothing more to say: no second line.
    limiter.close();
    expect(refusals).toHaveLength(1);
  });

  it('counts a full lookup queue and a body too large, each under its own reason', async () => {
    let busy = true;
    const counted: SlotlockRefusalCounts[] = [];
    const limiter = createSlotlockRequestLimits({
      limits: SLOTLOCK_DEFAULT_LIMITS,
      basePath: '',
      authenticate: async () => {
        if (busy) throw new SlotlockAgentOperationError('server_busy', 503);
        return PRINCIPAL;
      },
      onRefusals: (line) => counted.push(line),
    });
    const target = limiter.serve({
      fetch: async () => Response.json({ error: { code: 'request_too_large' } }, { status: 413 }),
    });
    const post = () =>
      target.fetch(
        new Request('http://localhost/v1/events', {
          method: 'POST',
          headers: { authorization: 'Bearer slk_x' },
        }),
        { remoteAddress: '192.0.2.1' },
      );
    expect((await post()).status).toBe(503);
    busy = false;
    expect((await post()).status).toBe(413);
    limiter.close();
    expect(counted).toEqual([
      expect.objectContaining({ lookup_overflow: 1, request_too_large: 1, auth_refused: 0 }),
    ]);
  });

  it('answers through a response whose headers are immutable', async () => {
    const limiter = createSlotlockRequestLimits({
      limits: limitsWith({ rates: { address: { perSecond: 1, burst: 1 } } }),
      basePath: '',
      authenticate: async () => PRINCIPAL,
    });
    const target = limiter.serve({
      async fetch(request) {
        await limiter.consumeRateLimit({ principal: PRINCIPAL, operation: 'protocol' });
        return Response.redirect(new URL('/elsewhere', request.url), 303);
      },
    });
    const response = await target.fetch(get('/v1/resources', { authorization: 'Bearer good' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost/elsewhere');
    expect(response.headers.get('ratelimit')).toMatch(/^"[a-z_]+";r=\d+;t=\d+$/);
    limiter.close();
  });
});
