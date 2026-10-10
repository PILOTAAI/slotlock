// API keys without a database: the key format a secret scanner can verify offline, the scope each
// operation needs, and that the authenticator and the store refuse bad input before any query runs.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
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
  it('are read and write, the scopes the agent server enforces', () => {
    expect(SLOTLOCK_API_KEY_SCOPES).toEqual(['read', 'write']);
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

  it('runs at most two lookups at once, queues a bounded number and refuses the rest', async () => {
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
      authenticate(each).then((principal) => settled.push(`${index}:${principal}`)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Two run, one waits, the fourth is refused without a lookup.
    expect(authenticateKey).toHaveBeenCalledTimes(2);
    expect(settled).toEqual(['3:null']);
    pending.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authenticateKey).toHaveBeenCalledTimes(3);
    for (const finish of pending.splice(0)) finish();
    await Promise.all(outcomes);
    expect(settled.sort()).toEqual(['0:null', '1:null', '2:null', '3:null']);

    // The slots are free again.
    authenticateKey.mockResolvedValue(null);
    await authenticate(key());
    expect(authenticateKey).toHaveBeenCalledTimes(4);
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
    ['an unknown scope', { scopes: ['read', 'admin'] }, 'invalid_api_key_scopes'],
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
