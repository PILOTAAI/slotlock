// The request limits of `slotlock serve` without a database or a socket: client addresses as
// bucket keys, the order of the checks (the address before any lookup), the token arithmetic behind
// Retry-After and the RateLimit fields, the series-write slots, and the refusal counts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SlotlockAgentPrincipal, SlotlockAgentOperationError } from '../agent-server.js';
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

  it('keeps its memory bounded under a flood from ever new addresses', async () => {
    const { target } = setup(limitsWith({ rates: { address: { perSecond: 1, burst: 1 } } }), {
      now: clock().now,
    });
    const first = { remoteAddress: '10.0.0.1' };
    expect((await target.fetch(get('/healthz'), first)).status).toBe(401);
    expect((await target.fetch(get('/healthz'), first)).status).toBe(429);
    for (let index = 0; index < 100_001; index += 1) {
      await target.fetch(get('/healthz'), {
        remoteAddress: `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`,
      });
    }
    // The oldest empty bucket went to make room: that client starts afresh rather than the
    // server growing without bound.
    expect((await target.fetch(get('/healthz'), { remoteAddress: '10.1.134.161' })).status).toBe(401);
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
