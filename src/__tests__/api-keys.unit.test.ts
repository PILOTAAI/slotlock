// API keys without a database: the key format a secret scanner can verify offline, the scope each
// operation needs, and that the authenticator and the store refuse bad input before any query runs.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SlotlockAgentOperationError, createSlotlockAgentServer } from '../agent-server.js';
import {
  SLOTLOCK_API_KEY_DEFAULT_SCOPES,
  SLOTLOCK_API_KEY_SCOPES,
  createSlotlockApiKeyAuthenticator,
  createSlotlockApiKeyStore,
  generateSlotlockApiKey,
  isSlotlockApiKey,
  slotlockApiKeyDigest,
} from '../api-keys.js';
import type { SlotlockSql } from '../store.js';

const request = (authorization?: string) =>
  new Request('http://localhost/mcp', authorization ? { headers: { authorization } } : {});

/** A connection that fails the test if anything reaches it. */
function unreachableSql(): SlotlockSql {
  const fail = () => {
    throw new Error('the database must not be queried');
  };
  return new Proxy(fail, { get: fail, apply: fail }) as unknown as SlotlockSql;
}

describe('API key format', () => {
  it('is slotlock-prefixed base62 that a scanner can verify offline', () => {
    const generated = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const { key, prefix, digest } = generateSlotlockApiKey();
      expect(key).toMatch(/^slk_[0-9A-Za-z]{46}$/);
      expect(isSlotlockApiKey(key)).toBe(true);
      expect(prefix).toBe(key.slice(0, 12));
      expect(digest).toEqual(createHash('sha256').update(key, 'utf8').digest());
      generated.add(key);
    }
    expect(generated.size).toBe(200);
  });

  it('carries a checksum, so a mistyped or truncated key is refused without a lookup', () => {
    const { key } = generateSlotlockApiKey();
    const swap = (character: string) => (character === 'a' ? 'b' : 'a');
    const mistyped = `${key.slice(0, 20)}${swap(key[20] as string)}${key.slice(21)}`;
    for (const candidate of [
      mistyped,
      key.slice(0, -1),
      `${key}0`,
      key.replace('slk_', 'sk_'),
      key.toUpperCase(),
      ` ${key}`,
      '',
    ]) {
      expect(isSlotlockApiKey(candidate), candidate).toBe(false);
    }
  });

  it('digests the whole key with SHA-256, the only form the database keeps', () => {
    const { key } = generateSlotlockApiKey();
    expect(slotlockApiKeyDigest(key)).toEqual(createHash('sha256').update(key, 'utf8').digest());
  });
});

describe('API key scopes', () => {
  it('are read and write, which the agent tools need, and admin, which the application API needs', () => {
    expect(SLOTLOCK_API_KEY_SCOPES).toEqual(['read', 'write', 'admin']);
  });

  it('give a new key read and write unless it asks for more', () => {
    expect(SLOTLOCK_API_KEY_DEFAULT_SCOPES).toEqual(['read', 'write']);
  });
});

describe('API key authentication', () => {
  it("resolves a key to its own tenant and scopes, never a request's", async () => {
    const { key } = generateSlotlockApiKey();
    const authenticateKey = vi.fn(async () => ({
      id: '6f1c2f9e-0a51-4f1c-9a43-2b8e1f0c7d11',
      tenantRef: 'fleet-7',
      scopes: ['read' as const],
    }));
    const authenticate = createSlotlockApiKeyAuthenticator({ authenticate: authenticateKey });
    await expect(authenticate(request(`Bearer ${key}`))).resolves.toEqual({
      subject: 'api_key:6f1c2f9e-0a51-4f1c-9a43-2b8e1f0c7d11',
      tenantRef: 'fleet-7',
      scopes: ['read'],
    });
    expect(authenticateKey).toHaveBeenCalledWith(key);
  });

  it('is anonymous when the store finds no active key', async () => {
    const { key } = generateSlotlockApiKey();
    const authenticate = createSlotlockApiKeyAuthenticator({ authenticate: async () => null });
    await expect(authenticate(request(`Bearer ${key}`))).resolves.toBeNull();
  });

  it('runs at most two lookups at once, queues a bounded number and answers the rest busy, never anonymous (SEC-2)', async () => {
    const pending: Array<() => void> = [];
    const authenticateKey = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          pending.push(() => resolve(null));
        }),
    );
    const authenticate = createSlotlockApiKeyAuthenticator(
      { authenticate: authenticateKey },
      { maxConcurrentLookups: 2, maxWaitingLookups: 1 },
    );
    const key = () => request(`Bearer ${generateSlotlockApiKey().key}`);
    const settled: Array<string> = [];
    const outcomes = [key(), key(), key(), key()].map((each, index) =>
      authenticate(each).then(
        (principal) => settled.push(`${index}:${principal}`),
        (error: unknown) => settled.push(`${index}:${(error as SlotlockAgentOperationError).code}`),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Two run, one waits, the fourth is answered busy without a lookup: an anonymous answer would
    // tell a client holding a valid key that its key is bad.
    expect(authenticateKey).toHaveBeenCalledTimes(2);
    expect(settled).toEqual(['3:server_busy']);
    pending.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authenticateKey).toHaveBeenCalledTimes(3);
    for (const finish of pending.splice(0)) finish();
    await Promise.all(outcomes);
    expect(settled.sort()).toEqual(['0:null', '1:null', '2:null', '3:server_busy']);

    // The slots are free again.
    authenticateKey.mockResolvedValue(null);
    await authenticate(key());
    expect(authenticateKey).toHaveBeenCalledTimes(4);
  });

  it('answers busy with a 503 the agent server and serve can tell apart from a bad key', async () => {
    const authenticate = createSlotlockApiKeyAuthenticator(
      { authenticate: () => new Promise<null>(() => {}) },
      { maxConcurrentLookups: 1, maxWaitingLookups: 0 },
    );
    void authenticate(request(`Bearer ${generateSlotlockApiKey().key}`));
    const refused = await authenticate(request(`Bearer ${generateSlotlockApiKey().key}`)).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(SlotlockAgentOperationError);
    expect(refused).toMatchObject({ code: 'server_busy', status: 503 });
  });

  it('serves a key that recently authenticated ahead of a flood of unknown keys (SEC-2)', async () => {
    // The audit's flood: 1,500 checksum-valid made-up keys in flight while a valid key asked 20
    // times, and 59 of the 60 answers were 401. Here the queue holds two, a made-up key takes the
    // one slot each time, and the valid key never waits behind the flood or is refused.
    const valid = generateSlotlockApiKey().key;
    const identity = {
      id: '6f1c2f9e-0a51-4f1c-9a43-2b8e1f0c7d11',
      tenantRef: 'fleet-7',
      scopes: ['read' as const],
    };
    const pending: Array<() => void> = [];
    const looked: string[] = [];
    const authenticateKey = vi.fn(
      (presented: string) =>
        new Promise<typeof identity | null>((resolve) => {
          looked.push(presented === valid ? 'valid' : 'fake');
          pending.push(() => resolve(presented === valid ? identity : null));
        }),
    );
    const authenticate = createSlotlockApiKeyAuthenticator(
      { authenticate: authenticateKey },
      { maxConcurrentLookups: 1, maxWaitingLookups: 2 },
    );
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    // The valid key authenticates once with nothing else in flight.
    const first = authenticate(request(`Bearer ${valid}`));
    await tick();
    pending.shift()?.();
    await expect(first).resolves.toMatchObject({ tenantRef: 'fleet-7' });

    const flood = Array.from({ length: 6 }, () =>
      authenticate(request(`Bearer ${generateSlotlockApiKey().key}`)).then(
        (principal) => principal,
        (error: unknown) => (error as SlotlockAgentOperationError).code,
      ),
    );
    await tick();
    const answers: unknown[] = [];
    for (let round = 0; round < 5; round += 1) {
      const asked = authenticate(request(`Bearer ${valid}`));
      await tick();
      // Finish whatever holds the slot; the valid key goes next, ahead of the waiting fakes.
      pending.shift()?.();
      await tick();
      pending.shift()?.();
      answers.push(await asked);
    }
    expect(answers).toEqual(Array(5).fill(expect.objectContaining({ tenantRef: 'fleet-7' })));
    for (const finish of pending.splice(0)) finish();
    await tick();
    for (const finish of pending.splice(0)) finish();
    // Past the queue the fakes were answered busy, never anonymous-then-401 for a real key.
    expect(await Promise.all(flood)).toContain('server_busy');
    expect(looked.filter((entry) => entry === 'valid')).toHaveLength(6);
  });

  it("answers a full lookup queue 503 with Retry-After on an embedder's REST, MCP and A2A, never 500 or 401 (SEC-2)", async () => {
    // Wired straight into createSlotlockAgentServer, as an embedder does without `slotlock serve`.
    // Before the agent server mapped the authenticator's busy error, every call past the queue
    // rejected `fetch` (a Node listener's 500 internal_error); before that, it was a false 401.
    const authenticate = createSlotlockApiKeyAuthenticator(
      { authenticate: () => new Promise<null>(() => {}) },
      { maxConcurrentLookups: 1, maxWaitingLookups: 0 },
    );
    const unused = vi.fn(async () => {
      throw new Error('no operation runs');
    });
    const server = createSlotlockAgentServer({
      publicBaseUrl: 'http://localhost',
      allowInsecureLocalhost: true,
      rest: true,
      backend: {
        listResources: unused,
        getFreeBusy: unused,
        findNextAvailable: unused,
        createEvent: unused,
        getEvent: unused,
        listEvents: unused,
        updateEvent: unused,
        deleteEvent: unused,
      },
      authenticate,
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
    });
    const call = (path: string, method = 'POST') =>
      server.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            authorization: `Bearer ${generateSlotlockApiKey().key}`,
            'content-type': 'application/json',
          },
          ...(method === 'POST'
            ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }
            : {}),
        }),
      );
    // The one lookup slot, held for the rest of the test.
    void call('/v1/resources', 'GET');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rest = await call('/v1/resources', 'GET');
    expect([rest.status, rest.headers.get('retry-after'), await rest.json()]).toEqual([
      503,
      '1',
      expect.objectContaining({ status: 503, code: 'server_busy', error: { code: 'server_busy' } }),
    ]);
    const mcp = await call('/mcp');
    expect([mcp.status, mcp.headers.get('retry-after'), await mcp.json()]).toEqual([
      503,
      '1',
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Server is busy' } },
    ]);
    const a2a = await call('/a2a');
    expect([a2a.status, a2a.headers.get('retry-after')]).toEqual([503, '1']);
    expect(await a2a.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, data: [{ reason: 'SERVER_BUSY', domain: 'slotlock' }] },
    });
    expect(unused).not.toHaveBeenCalled();
  });

  it('skips the lookup for a request whose client has gone while it waited', async () => {
    let release: () => void = () => {};
    const authenticateKey = vi.fn(
      () => new Promise<null>((resolve) => (release = () => resolve(null))),
    );
    const authenticate = createSlotlockApiKeyAuthenticator(
      { authenticate: authenticateKey },
      { maxConcurrentLookups: 1, maxWaitingLookups: 4 },
    );
    const first = authenticate(request(`Bearer ${generateSlotlockApiKey().key}`));
    const gone = new AbortController();
    const waiting = authenticate(
      new Request('http://localhost/mcp', {
        headers: { authorization: `Bearer ${generateSlotlockApiKey().key}` },
        signal: gone.signal,
      }),
    );
    gone.abort();
    release();
    await expect(first).resolves.toBeNull();
    await expect(waiting).resolves.toBeNull();
    expect(authenticateKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no header', undefined],
    ['another scheme', 'Basic slk_x'],
    ['a value that is not a key', `Bearer ${'f'.repeat(64)}`],
    ['a key with a bad checksum', 'Bearer slk_0000000000000000000000000000000000000000000000'],
    ['two keys', 'Bearer slk_a, Bearer slk_b'],
  ])('looks nothing up for %s', async (_case, authorization) => {
    const authenticateKey = vi.fn(async () => null);
    const authenticate = createSlotlockApiKeyAuthenticator({ authenticate: authenticateKey });
    await expect(authenticate(request(authorization))).resolves.toBeNull();
    expect(authenticateKey).not.toHaveBeenCalled();
  });
});

describe('API key store input', () => {
  const keys = createSlotlockApiKeyStore(unreachableSql());
  const valid = { tenantRef: 'fleet-7', name: 'Booking agent', scopes: ['read', 'write'] as const };

  it.each([
    ['an empty tenant', { tenantRef: '' }, 'invalid_tenant_ref'],
    ['a padded tenant', { tenantRef: ' fleet-7' }, 'invalid_tenant_ref'],
    ['a tenant with a control character', { tenantRef: 'fleet\u0000' }, 'invalid_tenant_ref'],
    ['an empty name', { name: '   ' }, 'invalid_api_key_name'],
    ['a name with a line break', { name: 'a\nb' }, 'invalid_api_key_name'],
    ['a name over 100 characters', { name: 'n'.repeat(101) }, 'invalid_api_key_name'],
    ['no scopes', { scopes: [] }, 'invalid_api_key_scopes'],
    ['an unknown scope', { scopes: ['read', 'owner'] }, 'invalid_api_key_scopes'],
    [
      'an expiry in the past',
      { expiresAt: new Date(Date.now() - 1_000) },
      'invalid_api_key_expiry',
    ],
    ['an invalid expiry', { expiresAt: new Date(Number.NaN) }, 'invalid_api_key_expiry'],
    [
      'an expiry more than ten years away',
      { expiresAt: new Date(Date.now() + 3_700 * 86_400_000) },
      'invalid_api_key_expiry',
    ],
    ['a creator over 200 bytes', { createdBy: 'c'.repeat(201) }, 'invalid_api_key_creator'],
  ])('refuses %s before any query', async (_case, overrides, code) => {
    await expect(
      keys.create({ ...valid, ...overrides } as Parameters<typeof keys.create>[0]),
    ).rejects.toMatchObject({ code });
  });

  it('answers a malformed key or key id without a query', async () => {
    await expect(keys.authenticate('not-a-key')).resolves.toBeNull();
    await expect(keys.revoke({ tenantRef: 'fleet-7', id: 'not-a-uuid' })).resolves.toBeNull();
    await expect(keys.rotate({ tenantRef: 'fleet-7', id: 'not-a-uuid' })).resolves.toBeNull();
    await expect(keys.list({ tenantRef: '' })).rejects.toMatchObject({
      code: 'invalid_tenant_ref',
    });
    await expect(keys.erase({ tenantRef: 'fleet\n7' })).rejects.toMatchObject({
      code: 'invalid_tenant_ref',
    });
  });
});
