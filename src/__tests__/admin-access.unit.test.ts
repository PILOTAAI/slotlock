import { describe, expect, it } from 'vitest';
import { createSlotlockAccessVerifier } from '../admin/access.js';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const TEAM = 'slotlock.cloudflareaccess.com';
const AUD = '4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2';
const ISSUER = `https://${TEAM}`;
const CERTS = `${ISSUER}/cdn-cgi/access/certs`;
const START = Date.UTC(2026, 10, 11, 12, 0, 0);
const MINUTE = 60_000;

const b64 = (data: Uint8Array | string) => Buffer.from(data).toString('base64url');

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: Record<string, unknown>;
}

async function signingKey(kid: string): Promise<SigningKey> {
  const pair = await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  // The shape Access serves at /cdn-cgi/access/certs.
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: 'RSA', alg: 'RS256', use: 'sig', e: jwk.e, n: jwk.n } };
}

// Generated once: RSA key generation is the slow part of this file.
const signingKeys = Promise.all([signingKey('current'), signingKey('next'), signingKey('impostor')]);

async function token(
  key: SigningKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: key.kid, typ: 'JWT' },
): Promise<string> {
  const signingInput = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  const signature = await subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, encoder.encode(signingInput));
  return `${signingInput}.${b64(new Uint8Array(signature))}`;
}

/** The claims Access puts in an application token, valid at `at` (ms). */
function claims(at: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const seconds = Math.floor(at / 1000);
  return {
    aud: [AUD],
    email: 'ops@slotlock.example',
    exp: seconds + 24 * 3600,
    iat: seconds,
    nbf: seconds,
    iss: ISSUER,
    type: 'app',
    identity_nonce: '6ei69kawdKzMIAPF',
    sub: '7335d417-61da-459d-899c-0a01c76a2f94',
    country: 'GB',
    ...overrides,
  };
}

const request = (assertion?: string, name = 'Cf-Access-Jwt-Assertion') =>
  new Request('https://admin.slotlock.example/', assertion === undefined ? {} : { headers: { [name]: assertion } });

/** Access as the verifier sees it: a clock, and a certs endpoint whose keys and health the test controls. */
function fakeAccess(served: SigningKey[]) {
  const state = {
    clock: START,
    served,
    fetches: 0,
    failure: null as null | 'network' | 'status' | 'junk',
    extraKeys: [] as Record<string, unknown>[],
  };
  const verifier = createSlotlockAccessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    now: () => state.clock,
    fetch: async (input: Parameters<typeof fetch>[0]) => {
      state.fetches += 1;
      expect(String(input)).toBe(CERTS);
      if (state.failure === 'network') throw new TypeError('fetch failed');
      if (state.failure === 'status') return new Response('upstream error', { status: 503 });
      if (state.failure === 'junk') return new Response('<html>', { status: 200 });
      return Response.json({
        keys: [...state.extraKeys, ...state.served.map((key) => key.jwk)],
        public_cert: { kid: 'current', cert: '-----BEGIN CERTIFICATE-----' },
        public_certs: [],
      });
    },
  });
  return { state, verifier };
}

describe('Cloudflare Access verifier', () => {
  it('returns the email and sub of a valid token, whatever the header case', async () => {
    const [current] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    const jwt = await token(current, claims(state.clock));
    const identity = { email: 'ops@slotlock.example', sub: '7335d417-61da-459d-899c-0a01c76a2f94' };
    expect(await verifier.verify(request(jwt))).toEqual(identity);
    expect(await verifier.verify(request(jwt, 'cf-access-jwt-assertion'))).toEqual(identity);
    expect(await verifier.verify(request(jwt, 'CF-ACCESS-JWT-ASSERTION'))).toEqual(identity);
    // Keys are cached: one fetch for all three.
    expect(state.fetches).toBe(1);
  });

  it('refuses a request without the header, or with an empty one, without fetching keys', async () => {
    const [current] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    expect(await verifier.verify(request())).toBeNull();
    expect(await verifier.verify(request(''))).toBeNull();
    expect(state.fetches).toBe(0);
  });

  it('accepts aud as a string and refuses a token for another application', async () => {
    const [current] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    expect(await verifier.verify(request(await token(current, claims(state.clock, { aud: AUD }))))).not.toBeNull();
    expect(await verifier.verify(request(await token(current, claims(state.clock, { aud: [`${AUD.slice(1)}0`] }))))).toBeNull();
    expect(await verifier.verify(request(await token(current, claims(state.clock, { aud: `${AUD}0` }))))).toBeNull();
    expect(await verifier.verify(request(await token(current, claims(state.clock, { aud: [] }))))).toBeNull();
    expect(await verifier.verify(request(await token(current, claims(state.clock, { aud: undefined }))))).toBeNull();
  });

  it('allows 60 seconds of clock skew on exp, and no more', async () => {
    const [current] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    const seconds = state.clock / 1000;
    const at = async (exp: unknown) => verifier.verify(request(await token(current, claims(state.clock, { exp, iat: seconds - 3600, nbf: seconds - 3600 }))));
    expect(await at(seconds - 30)).not.toBeNull();
    expect(await at(seconds - 59)).not.toBeNull();
    expect(await at(seconds - 60)).toBeNull();
    expect(await at(seconds - 3600)).toBeNull();
    expect(await at(undefined)).toBeNull();
    expect(await at(String(seconds + 3600))).toBeNull();
  });

  it('refuses a token not yet valid, beyond the same 60 seconds', async () => {
    const [current] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    const seconds = state.clock / 1000;
    const check = async (overrides: Record<string, unknown>) => verifier.verify(request(await token(current, claims(state.clock, overrides))));
    expect(await check({ nbf: seconds + 30, iat: seconds + 30 })).not.toBeNull();
    expect(await check({ nbf: seconds + 120 })).toBeNull();
    expect(await check({ iat: seconds + 120 })).toBeNull();
    expect(await check({ nbf: 'soon' })).toBeNull();
    // Absent nbf and iat are fine: exp still bounds the token.
    expect(await check({ nbf: undefined, iat: undefined })).not.toBeNull();
  });

  it('refuses a token from another team', async () => {
    const [current] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    for (const iss of ['https://evil.cloudflareaccess.com', `${ISSUER}/`, `http://${TEAM}`, TEAM, undefined]) {
      expect(await verifier.verify(request(await token(current, claims(state.clock, { iss }))))).toBeNull();
    }
  });

  it('refuses a token without an email or sub, as a service token has', async () => {
    const [current] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    for (const overrides of [{ email: undefined }, { email: '' }, { email: ['ops@slotlock.example'] }, { sub: undefined }, { sub: '' }]) {
      expect(await verifier.verify(request(await token(current, claims(state.clock, overrides))))).toBeNull();
    }
  });

  it('refuses alg none and HS256', async () => {
    const [current] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    const payload = b64(JSON.stringify(claims(state.clock)));
    const none = `${b64(JSON.stringify({ alg: 'none', kid: 'current' }))}.${payload}.`;
    expect(await verifier.verify(request(none))).toBeNull();
    expect(await verifier.verify(request(`${none}${b64('x')}`))).toBeNull();
    // The classic confusion: HMAC keyed with the published public key.
    const hmac = await subtle.importKey('raw', encoder.encode(JSON.stringify(current.jwk)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const hsInput = `${b64(JSON.stringify({ alg: 'HS256', kid: 'current' }))}.${payload}`;
    const hs256 = `${hsInput}.${b64(new Uint8Array(await subtle.sign('HMAC', hmac, encoder.encode(hsInput))))}`;
    expect(await verifier.verify(request(hs256))).toBeNull();
    // Even a genuine RS256 signature is refused under a header that claims another algorithm.
    expect(await verifier.verify(request(await token(current, claims(state.clock), { alg: 'RS512', kid: 'current' })))).toBeNull();
    expect(await verifier.verify(request(await token(current, claims(state.clock), { alg: 'RS256' })))).toBeNull();
    expect(await verifier.verify(request(await token(current, claims(state.clock), { alg: 'RS256', kid: 'current', crit: ['exp'] })))).toBeNull();
  });

  it('refuses a tampered payload or a signature from another key under a known kid', async () => {
    const [current, , impostor] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    const genuine = await token(current, claims(state.clock));
    const [header, , signature] = genuine.split('.');
    const forged = `${header}.${b64(JSON.stringify(claims(state.clock, { email: 'attacker@evil.example' })))}.${signature}`;
    expect(await verifier.verify(request(forged))).toBeNull();
    expect(await verifier.verify(request(await token(impostor, claims(state.clock), { alg: 'RS256', kid: 'current' })))).toBeNull();
    expect(await verifier.verify(request(genuine))).not.toBeNull();
  });

  it('refuses malformed tokens', async () => {
    const [current] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    const genuine = await token(current, claims(state.clock));
    const [header, payload, signature] = genuine.split('.') as [string, string, string];
    for (const malformed of [
      `${header}.${payload}`,
      `${genuine}.${signature}`,
      `${header}.${payload}.${signature}=`,
      `${header}.${payload}.${signature.replaceAll('-', '+').replaceAll('_', '/')}x`,
      `${header} .${payload}.${signature}`,
      `${b64('not json')}.${payload}.${signature}`,
      `${header}.${b64('[]')}.${signature}`,
      `${b64('null')}.${payload}.${signature}`,
      `${header}.${payload}.${signature}${'A'.repeat(20_000)}`,
      'Bearer x.y.z',
    ]) {
      expect(await verifier.verify(request(malformed))).toBeNull();
    }
  });

  it('picks up a rotated key by refetching on an unknown kid', async () => {
    const [current, next] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    expect(await verifier.verify(request(await token(current, claims(state.clock))))).not.toBeNull();
    expect(state.fetches).toBe(1);
    state.served = [current, next];
    state.clock += MINUTE;
    expect(await verifier.verify(request(await token(next, claims(state.clock))))).not.toBeNull();
    expect(state.fetches).toBe(2);
    expect(await verifier.verify(request(await token(current, claims(state.clock))))).not.toBeNull();
    expect(state.fetches).toBe(2);
  });

  it('refetches for unknown kids at most once a minute, then fails closed', async () => {
    const [current, next] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    expect(await verifier.verify(request(await token(current, claims(state.clock))))).not.toBeNull();
    // Right after a fetch, an unknown kid is not worth another one.
    expect(await verifier.verify(request(await token(next, claims(state.clock))))).toBeNull();
    expect(state.fetches).toBe(1);

    state.clock += MINUTE;
    expect(await verifier.verify(request(await token(next, claims(state.clock), { alg: 'RS256', kid: 'made-up' })))).toBeNull();
    expect(state.fetches).toBe(2);
    // The key appears, but the last look was under a minute ago.
    state.served = [current, next];
    state.clock += MINUTE - 1;
    expect(await verifier.verify(request(await token(next, claims(state.clock))))).toBeNull();
    expect(state.fetches).toBe(2);
    // Known kids keep working meanwhile.
    expect(await verifier.verify(request(await token(current, claims(state.clock))))).not.toBeNull();
    state.clock += 1;
    expect(await verifier.verify(request(await token(next, claims(state.clock))))).not.toBeNull();
    expect(state.fetches).toBe(3);
  });

  it('reads the keys again after ten minutes', async () => {
    const [current] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    expect(await verifier.verify(request(await token(current, claims(state.clock))))).not.toBeNull();
    state.clock += 10 * MINUTE - 1;
    expect(await verifier.verify(request(await token(current, claims(state.clock))))).not.toBeNull();
    expect(state.fetches).toBe(1);
    state.clock += 1;
    expect(await verifier.verify(request(await token(current, claims(state.clock))))).not.toBeNull();
    expect(state.fetches).toBe(2);
  });

  it.each(['network', 'status', 'junk'] as const)(
    'fails closed when the keys cannot be read (%s), and retries after a minute',
    async (failure) => {
      const [current] = await signingKeys;
      const { state, verifier } = fakeAccess([current]);
      state.failure = failure;
      expect(await verifier.verify(request(await token(current, claims(state.clock))))).toBeNull();
      expect(state.fetches).toBe(1);
      state.failure = null;
      state.clock += MINUTE - 1;
      expect(await verifier.verify(request(await token(current, claims(state.clock))))).toBeNull();
      expect(state.fetches).toBe(1);
      state.clock += 1;
      expect(await verifier.verify(request(await token(current, claims(state.clock))))).not.toBeNull();
      expect(state.fetches).toBe(2);
    },
  );

  it('keeps good keys when a refetch fails, and drops them once they expire', async () => {
    const [current, next] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    expect(await verifier.verify(request(await token(current, claims(state.clock))))).not.toBeNull();
    state.failure = 'status';
    state.clock += MINUTE;
    expect(await verifier.verify(request(await token(next, claims(state.clock))))).toBeNull();
    expect(state.fetches).toBe(2);
    expect(await verifier.verify(request(await token(current, claims(state.clock))))).not.toBeNull();
    // Past the ten minutes, with Access still failing: no stale keys.
    state.clock += 9 * MINUTE;
    expect(await verifier.verify(request(await token(current, claims(state.clock))))).toBeNull();
    expect(state.fetches).toBe(3);
  });

  it('ignores keys that are not RSA signing keys', async () => {
    const [current] = await signingKeys;
    const { state, verifier } = fakeAccess([current]);
    const ec = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    state.extraKeys = [
      { ...(await subtle.exportKey('jwk', ec.publicKey)), kid: 'ec' },
      { ...current.jwk, kid: 'encryption', use: 'enc' },
      { ...current.jwk, kid: 'rs512', alg: 'RS512' },
      { kty: 'RSA', kid: 'broken', n: 'AQAB', e: 'AQAB' },
    ];
    for (const kid of ['ec', 'encryption', 'rs512', 'broken']) {
      expect(await verifier.verify(request(await token(current, claims(state.clock), { alg: 'RS256', kid })))).toBeNull();
    }
    expect(await verifier.verify(request(await token(current, claims(state.clock))))).not.toBeNull();
  });

  it('refuses to start with a team domain or audience it could misuse', () => {
    const create = (teamDomain: string, audience = AUD) => () => createSlotlockAccessVerifier({ teamDomain, audience });
    for (const teamDomain of [
      '',
      'https://slotlock.cloudflareaccess.com',
      'slotlock.cloudflareaccess.com/',
      'slotlock.cloudflareaccess.com/cdn-cgi',
      'slotlock.cloudflareaccess.com:443',
      'Slotlock.cloudflareaccess.com',
      'localhost',
      'user@slotlock.cloudflareaccess.com',
    ]) {
      expect(create(teamDomain), teamDomain).toThrow(/teamDomain/);
    }
    for (const audience of ['', 'not-hex', AUD.toUpperCase(), 'abc']) {
      expect(create(TEAM, audience), audience).toThrow(/audience/);
    }
    expect(create(TEAM)).not.toThrow();
  });
});
