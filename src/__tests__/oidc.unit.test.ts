// ID tokens, keys, discovery and sealed secrets for teams' single sign-on (oidc.ts). Tokens are
// signed with node:crypto, a second implementation, and checked with WebCrypto as a Worker would.
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  type SlotlockJwk,
  createSlotlockJwksCache,
  createSlotlockSecretBox,
  discoverSlotlockOidc,
  importSlotlockJwk,
  slotlockEntraIssuer,
  slotlockFetchOidcJson,
  slotlockOidcUrlAllowed,
  verifySlotlockIdToken,
} from '../oidc.js';

const ISSUER = 'https://idp.acme-sso.com/oauth2/default';
const CLIENT = '0oa1clientid';
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const seconds = Math.floor(NOW / 1000);

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
// A 1024-bit RSA public key, fixed here: the verifier must refuse it before any
// signature is checked (none is made with it, so no weak key is generated here).
const SMALL_RSA_JWK: SlotlockJwk = { kty: 'RSA', n: 'y2_zejn4NrYjxYhlqs_GX-IoqjXqlEOBuKZeXd1CMaxGipnY3b1ILXVpz4tpWbB3GJis0Qov9guuAYOYeE3Xio2ITiCvpDkeTf5slFMnygs9q60tSylMgPus91YGwlGwA2o9K7yJFNebtHVMNQmFvmaIYFOTUCimANTjWNXKuzs', e: 'AQAB' };
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwkOf = (key: typeof rsa.publicKey, kid: string, extra: Record<string, unknown> = {}): SlotlockJwk => ({ ...key.export({ format: 'jwk' }), kid, ...extra });

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(
  claims: Record<string, unknown>,
  options: { alg?: string; kid?: string; key?: typeof rsa.privateKey; header?: Record<string, unknown> } = {},
): string {
  const alg = options.alg ?? 'RS256';
  const head = part({ alg, kid: options.kid ?? 'k1', typ: 'JWT', ...options.header });
  const body = part(claims);
  const input = Buffer.from(`${head}.${body}`);
  const key = options.key ?? rsa.privateKey;
  let signature: Buffer;
  if (alg === 'RS256') signature = sign('sha256', input, key);
  else if (alg === 'PS256') signature = sign('sha256', input, { key, padding: 6, saltLength: 32 });
  else if (alg === 'ES256') signature = sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' });
  else if (alg === 'HS256') signature = createHmac('sha256', 'the-client-secret').update(input).digest();
  else signature = Buffer.alloc(0);
  return `${head}.${body}.${signature.toString('base64url')}`;
}
const good = (extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: CLIENT,
  sub: '00u1abc',
  exp: seconds + 600,
  iat: seconds - 5,
  nonce: 'n-0123456789',
  ...extra,
});

function expectation(keys: Record<string, SlotlockJwk>, extra: Partial<Parameters<typeof verifySlotlockIdToken>[1]> = {}) {
  return {
    issuers: [ISSUER],
    clientId: CLIENT,
    algorithms: ['RS256', 'PS256', 'ES256'] as const,
    keys: async (kid: string | null, alg: 'RS256' | 'PS256' | 'ES256') => {
      const jwk = kid === null ? undefined : keys[kid];
      return jwk ? importSlotlockJwk(jwk, alg) : null;
    },
    nonce: 'n-0123456789',
    now: NOW,
    ...extra,
  };
}
const keys = { k1: jwkOf(rsa.publicKey, 'k1'), e1: jwkOf(ec.publicKey, 'e1') };

describe('verifySlotlockIdToken', () => {
  it('accepts a valid token, and refuses it with one payload byte changed', async () => {
    const valid = token(good());
    expect(await verifySlotlockIdToken(valid, expectation(keys))).toMatchObject({ claims: { sub: '00u1abc' } });
    const [head, body, signature] = valid.split('.') as [string, string, string];
    const changed = Buffer.from(body, 'base64url');
    changed[changed.length - 2] = (changed[changed.length - 2] as number) ^ 1;
    expect(await verifySlotlockIdToken(`${head}.${changed.toString('base64url')}.${signature}`, expectation(keys))).toMatchObject({
      refusal: expect.stringMatching(/signature|malformed/),
    });
  });

  it('verifies PS256 and ES256 too', async () => {
    expect(await verifySlotlockIdToken(token(good(), { alg: 'PS256' }), expectation(keys))).toHaveProperty('claims');
    expect(await verifySlotlockIdToken(token(good(), { alg: 'ES256', kid: 'e1', key: ec.privateKey }), expectation(keys))).toHaveProperty('claims');
  });

  it("refuses an attacker's key under a published key id, none, HMAC, and algorithms outside the issuer's", async () => {
    expect(await verifySlotlockIdToken(token(good(), { key: attacker.privateKey }), expectation(keys))).toEqual({ refusal: 'signature' });
    expect(await verifySlotlockIdToken(token(good(), { alg: 'none' }), expectation(keys))).toEqual({ refusal: 'algorithm' });
    expect(await verifySlotlockIdToken(token(good(), { alg: 'HS256' }), expectation(keys))).toEqual({ refusal: 'algorithm' });
    expect(await verifySlotlockIdToken(token(good(), { alg: 'PS256' }), expectation(keys, { algorithms: ['RS256'] }))).toEqual({ refusal: 'algorithm' });
    expect(await verifySlotlockIdToken(token(good(), { header: { crit: ['exp'] } }), expectation(keys))).toEqual({ refusal: 'malformed' });
  });

  it("refuses keys that don't fit: an EC key for RS256, use enc, another alg, RSA under 2048 bits", async () => {
    expect(await importSlotlockJwk(jwkOf(ec.publicKey, 'x'), 'RS256')).toBeNull();
    expect(await importSlotlockJwk(jwkOf(rsa.publicKey, 'x', { use: 'enc' }), 'RS256')).toBeNull();
    expect(await importSlotlockJwk(jwkOf(rsa.publicKey, 'x', { alg: 'PS256' }), 'RS256')).toBeNull();
    expect(await importSlotlockJwk({ ...SMALL_RSA_JWK, kid: 'x' }, 'RS256')).toBeNull();
    expect(await importSlotlockJwk(jwkOf(rsa.publicKey, 'x', { use: 'sig', alg: 'RS256' }), 'RS256')).not.toBeNull();
    const weak = { k1: { ...SMALL_RSA_JWK, kid: 'k1' } };
    expect(await verifySlotlockIdToken(token(good()), expectation(weak))).toEqual({ refusal: 'key' });
  });

  it('holds the issuer, audience and azp exactly', async () => {
    for (const iss of [`${ISSUER}/`, ISSUER.toUpperCase(), ISSUER.replace('https:', 'http:'), 'https://evil.example/oauth2/default']) {
      expect(await verifySlotlockIdToken(token(good({ iss })), expectation(keys)), iss).toEqual({ refusal: 'issuer' });
    }
    expect(await verifySlotlockIdToken(token(good({ aud: 'another' })), expectation(keys))).toEqual({ refusal: 'audience' });
    expect(await verifySlotlockIdToken(token(good({ aud: [CLIENT, 'another'] })), expectation(keys))).toEqual({ refusal: 'audience' });
    expect(await verifySlotlockIdToken(token(good({ aud: [CLIENT, 'another'], azp: 'another' })), expectation(keys))).toEqual({ refusal: 'audience' });
    expect(await verifySlotlockIdToken(token(good({ aud: [CLIENT, 'another'], azp: CLIENT })), expectation(keys))).toHaveProperty('claims');
  });

  it('holds the times and the nonce', async () => {
    expect(await verifySlotlockIdToken(token(good({ exp: seconds - 61 })), expectation(keys))).toEqual({ refusal: 'expired' });
    expect(await verifySlotlockIdToken(token(good({ exp: seconds - 30 })), expectation(keys))).toHaveProperty('claims');
    expect(await verifySlotlockIdToken(token(good({ nbf: seconds + 120 })), expectation(keys))).toEqual({ refusal: 'not_yet_valid' });
    expect(await verifySlotlockIdToken(token(good({ iat: seconds - 400 })), expectation(keys))).toEqual({ refusal: 'issued_at' });
    expect(await verifySlotlockIdToken(token(good({ iat: seconds + 120 })), expectation(keys))).toEqual({ refusal: 'issued_at' });
    expect(await verifySlotlockIdToken(token(good({ nonce: 'other' })), expectation(keys))).toEqual({ refusal: 'nonce' });
    const { nonce: _nonce, ...without } = good();
    expect(await verifySlotlockIdToken(token(without), expectation(keys))).toEqual({ refusal: 'nonce' });
    expect(await verifySlotlockIdToken(token(good({ sub: '' })), expectation(keys))).toEqual({ refusal: 'subject' });
    expect(await verifySlotlockIdToken('a.b', expectation(keys))).toEqual({ refusal: 'malformed' });
  });
});

describe('the JWKS cache', () => {
  it('fetches an unknown key id once a minute at most, one fetch at a time, and serves a stale set while the issuer is down', async () => {
    let clock = NOW;
    let published: SlotlockJwk[] = [keys.k1];
    let down = false;
    const fetchJson = vi.fn(async () => {
      if (down) throw new Error('down');
      return { body: { keys: published }, maxAge: 3600 };
    });
    const cache = createSlotlockJwksCache({ fetchJson, now: () => clock });
    const url = 'https://idp.acme-sso.com/keys';
    // Concurrent first requests: one fetch.
    const found = await Promise.all([cache.key(url, 'k1', 'RS256'), cache.key(url, 'k1', 'RS256')]);
    expect(found.every(Boolean)).toBe(true);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    // A rotated key, a minute later: one more fetch, then found.
    clock += 61_000;
    const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
    published = [keys.k1, jwkOf(rotated.publicKey, 'k2')];
    expect(await cache.key(url, 'k2', 'RS256')).not.toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(2);
    // Another unknown id within the minute: no fetch.
    expect(await cache.key(url, 'k3', 'RS256')).toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(2);
    // Expired, and the issuer is down: known keys still serve for a day, unknown ones fail.
    clock += 2 * 3_600_000;
    down = true;
    expect(await cache.key(url, 'k1', 'RS256')).not.toBeNull();
    clock += 70_000;
    expect(await cache.key(url, 'k9', 'RS256')).toBeNull();
    clock += 86_400_000;
    expect(await cache.key(url, 'k1', 'RS256')).toBeNull();
  });
});

describe('URLs an Owner gives', () => {
  it('fetches only https on a public host name', () => {
    for (const url of [
      'http://idp.acme-sso.com',
      'https://10.0.0.5/x',
      'https://[::1]/x',
      'https://169.254.169.254/latest',
      'https://localhost/x',
      'https://idp.internal/x',
      'https://idp.local/x',
      'https://intranet/x',
      'https://idp.acme-sso.com:8443/x',
      'https://user:pass@idp.acme-sso.com/x',
    ]) {
      expect(slotlockOidcUrlAllowed(url), url).toBeNull();
    }
    expect(slotlockOidcUrlAllowed('https://login.microsoftonline.com/x')).not.toBeNull();
  });

  it('refuses redirects, non-JSON, large answers and dead ends', async () => {
    const answer = (response: Response) => vi.fn(async () => response) as unknown as typeof fetch;
    const url = 'https://idp.acme-sso.com/.well-known/openid-configuration';
    await expect(slotlockFetchOidcJson(url, { fetch: answer(new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/' } })) })).rejects.toMatchObject({ code: 'redirect' });
    await expect(slotlockFetchOidcJson(url, { fetch: answer(new Response('<html>', { headers: { 'content-type': 'text/html' } })) })).rejects.toMatchObject({ code: 'type' });
    await expect(slotlockFetchOidcJson(url, { fetch: answer(new Response('x'.repeat(300_000), { headers: { 'content-type': 'application/json' } })) })).rejects.toMatchObject({ code: 'size' });
    await expect(slotlockFetchOidcJson(url, { fetch: vi.fn(async () => { throw new Error('timeout'); }) as unknown as typeof fetch })).rejects.toMatchObject({ code: 'network' });
    const manual = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return Response.json({ a: 1 });
    }) as unknown as typeof globalThis.fetch;
    expect((await slotlockFetchOidcJson(url, { fetch: manual })).body).toEqual({ a: 1 });
  });

  it('discovers an issuer only when its document names it exactly', async () => {
    const document = {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/v1/authorize`,
      token_endpoint: `${ISSUER}/v1/token`,
      jwks_uri: `${ISSUER}/v1/keys`,
      id_token_signing_alg_values_supported: ['RS256', 'HS256'],
      authorization_response_iss_parameter_supported: true,
    };
    const serve = (body: unknown) => vi.fn(async () => Response.json(body)) as unknown as typeof fetch;
    expect(await discoverSlotlockOidc(ISSUER, { fetch: serve(document) })).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/v1/authorize`,
      tokenEndpoint: `${ISSUER}/v1/token`,
      jwksUri: `${ISSUER}/v1/keys`,
      algorithms: ['RS256'],
      issParameter: true,
    });
    await expect(discoverSlotlockOidc(ISSUER, { fetch: serve({ ...document, issuer: `${ISSUER}/` }) })).rejects.toThrow('another issuer');
    await expect(discoverSlotlockOidc(ISSUER, { fetch: serve({ ...document, jwks_uri: 'http://idp.acme-sso.com/keys' }) })).rejects.toThrow('endpoint');
    await expect(discoverSlotlockOidc(ISSUER, { fetch: serve({ ...document, id_token_signing_alg_values_supported: ['HS256'] }) })).rejects.toThrow('no algorithm');
    await expect(discoverSlotlockOidc('https://10.0.0.5/realms/x', { fetch: serve(document) })).rejects.toMatchObject({ code: 'url' });
  });

  it("pins Entra to one tenant's GUID", () => {
    expect(slotlockEntraIssuer('72F988BF-86F1-41AF-91AB-2D7CD011DB47')).toBe('https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0');
    for (const tenant of ['common', 'organizations', 'consumers', 'contoso.onmicrosoft.com', '9188040d-6c67-4c5b-b112-36a304b66dad', '{tenantid}']) {
      expect(slotlockEntraIssuer(tenant), tenant).toBeNull();
    }
  });
});

describe('sealed client secrets', () => {
  it('opens only under the row it was sealed for, and never shows the secret', async () => {
    const box = createSlotlockSecretBox('k'.repeat(40));
    const sealed = await box.seal('the-client-secret-value', 'team:a|conn:1|v1');
    expect(sealed).not.toContain('the-client-secret');
    expect(sealed).toMatch(/^v1\./);
    expect(await box.open(sealed, 'team:a|conn:1|v1')).toBe('the-client-secret-value');
    expect(await box.open(sealed, 'team:b|conn:1|v1')).toBeNull();
    expect(await createSlotlockSecretBox('j'.repeat(40)).open(sealed, 'team:a|conn:1|v1')).toBeNull();
    expect(await box.seal('same', 'x')).not.toBe(await box.seal('same', 'x'));
    expect(() => createSlotlockSecretBox('short')).toThrow('32 characters');
  });

  it('keeps at most maxUrls key sets, the least recently used going first', async () => {
    const fetched: string[] = [];
    const cache = createSlotlockJwksCache({
      maxUrls: 2,
      now: () => 1_000_000,
      fetchJson: async (url) => {
        fetched.push(url);
        return { body: { keys: [{ kty: 'RSA', kid: 'k', n: 'AQAB', e: 'AQAB' }] }, maxAge: 3_600 };
      },
    });
    for (const url of ['https://a.example.com/keys', 'https://b.example.com/keys', 'https://a.example.com/keys', 'https://c.example.com/keys']) {
      await cache.key(url, 'missing', 'RS256');
    }
    // a was used after b, so b went when c came; a is still held.
    await cache.key('https://a.example.com/keys', 'missing', 'RS256');
    await cache.key('https://b.example.com/keys', 'missing', 'RS256');
    expect(fetched).toEqual(['https://a.example.com/keys', 'https://b.example.com/keys', 'https://c.example.com/keys', 'https://b.example.com/keys']);
  });
});
