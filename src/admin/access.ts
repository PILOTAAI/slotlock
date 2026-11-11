// Cloudflare Access as the admin console's front door: every request carries the JWT Access signed
// for the person it let through (the Cf-Access-Jwt-Assertion header), and the console checks it
// itself rather than trusting that the request came through Access. Docs:
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
//
// Only WebCrypto and standard JS, so it runs in Node and in Workers. verify() never throws: any
// doubt about a token, or about Access's keys, is a refusal (null).
import { base64urlDecode } from './webauthn.js';

export interface SlotlockAccessIdentity {
  email: string;
  sub: string;
}

export interface SlotlockAccessVerifierOptions {
  /** The Zero Trust team domain, e.g. `example.cloudflareaccess.com`: a bare lowercase host. */
  teamDomain: string;
  /** The Access application's AUD tag (lowercase hex). */
  audience: string;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch, as Date.now(). */
  now?: () => number;
}

export interface SlotlockAccessVerifier {
  verify(request: Request): Promise<SlotlockAccessIdentity | null>;
}

/** Clock skew we tolerate between Cloudflare's edge and this host, on exp, nbf and iat. */
const LEEWAY_SECONDS = 60;
const KEYS_TTL_MS = 10 * 60 * 1000;
/** The fewest milliseconds between two fetches of the keys that a token (unknown kid) or a failure can cause. */
const REFETCH_INTERVAL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_KEYS_BODY_LENGTH = 256 * 1024;

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const AUDIENCE = /^[0-9a-f]{16,128}$/;
// JWS compact serialization is unpadded base64url (RFC 7515, 2).
const SEGMENT = /^[A-Za-z0-9_-]+$/;

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeJsonSegment(segment: string): unknown {
  return JSON.parse(utf8.decode(base64urlDecode(segment)));
}

export function createSlotlockAccessVerifier(options: SlotlockAccessVerifierOptions): SlotlockAccessVerifier {
  const { teamDomain, audience } = options;
  // Checked up front: a typo here would otherwise only show as every request being refused, or
  // (with a scheme or path) as fetching keys from somewhere unintended.
  if (typeof teamDomain !== 'string' || !HOST.test(teamDomain)) {
    throw new Error('Cloudflare Access teamDomain must be a bare lowercase host, e.g. example.cloudflareaccess.com');
  }
  if (typeof audience !== 'string' || !AUDIENCE.test(audience)) {
    throw new Error("Cloudflare Access audience must be the application's AUD tag (lowercase hex)");
  }
  const issuer = `https://${teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  // Bound, because Workers refuses a fetch called without globalThis as `this`.
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());

  let keys: { byKid: Map<string, CryptoKey>; until: number } | null = null;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let lastFailure = Number.NEGATIVE_INFINITY;

  /**
   * Reads Access's keys. A failure keeps whatever was cached (still subject to its own expiry) and
   * holds off retries for REFETCH_INTERVAL_MS, so an outage neither wipes good keys nor turns every
   * request into a fetch. No in-flight promise is shared between requests: Workers does not let one
   * request wait on another's I/O.
   */
  async function loadKeys(at: number): Promise<void> {
    lastAttempt = at;
    try {
      const response = await fetchImpl(certsUrl, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status !== 200) throw new Error(`Access keys answered HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_KEYS_BODY_LENGTH) throw new Error('Access keys answer is too large');
      const body: unknown = JSON.parse(text);
      if (!isRecord(body) || !Array.isArray(body.keys)) throw new Error('Access keys answer has no keys');
      const byKid = new Map<string, CryptoKey>();
      for (const jwk of body.keys) {
        // Access signs with RSA; anything else in the set is not a key for these tokens.
        if (!isRecord(jwk) || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || jwk.kid === '') continue;
        if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string' || byKid.has(jwk.kid)) continue;
        if ((jwk.alg !== undefined && jwk.alg !== 'RS256') || (jwk.use !== undefined && jwk.use !== 'sig')) continue;
        const key = await globalThis.crypto.subtle
          .importKey(
            'jwk',
            { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
          )
          .catch(() => null);
        if (key) byKid.set(jwk.kid, key);
      }
      // An empty set would be cached as "every token is unknown" for ten minutes; treat it as a failure.
      if (byKid.size === 0) throw new Error('Access keys answer has no usable RSA key');
      keys = { byKid, until: at + KEYS_TTL_MS };
    } catch {
      lastFailure = at;
    }
  }

  async function keyFor(kid: string): Promise<CryptoKey | null> {
    const at = now();
    const cached = keys;
    if (cached && at < cached.until) {
      const key = cached.byKid.get(kid);
      if (key) return key;
      // An unknown kid may be a rotation we have not seen yet, so look again, but at most once a
      // minute: made-up kids must not turn every request into a fetch.
      if (at - lastAttempt < REFETCH_INTERVAL_MS) return null;
    } else if (at - lastFailure < REFETCH_INTERVAL_MS) {
      return null;
    }
    await loadKeys(at);
    const loaded = keys;
    return loaded && at < loaded.until ? (loaded.byKid.get(kid) ?? null) : null;
  }

  /** The person a token names, if its claims hold at `at`; the signature is checked separately. */
  function identityFrom(payload: Record<string, unknown>, at: number): SlotlockAccessIdentity | null {
    const seconds = at / 1000;
    if (payload.iss !== issuer) return null;
    const audiences = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
    if (!audiences.includes(audience)) return null;
    const { exp } = payload;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || seconds >= exp + LEEWAY_SECONDS) return null;
    for (const notBefore of [payload.nbf, payload.iat]) {
      if (notBefore === undefined) continue;
      if (typeof notBefore !== 'number' || !Number.isFinite(notBefore) || notBefore > seconds + LEEWAY_SECONDS) return null;
    }
    // Service tokens carry no email (and an empty sub): the console is for people.
    const { email, sub } = payload;
    if (typeof email !== 'string' || email === '' || typeof sub !== 'string' || sub === '') return null;
    return { email, sub };
  }

  async function check(request: Request): Promise<SlotlockAccessIdentity | null> {
    // Headers.get is case-insensitive.
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token || token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) return null;
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeJsonSegment(encodedHeader);
    const payload = decodeJsonSegment(encodedPayload);
    // Only RS256: never `none`, and never HS256, which would treat the public key as a shared secret.
    // `crit` names extensions we would have to understand, so a token with it is refused.
    if (!isRecord(header) || header.alg !== 'RS256' || header.crit !== undefined) return null;
    if (typeof header.kid !== 'string' || header.kid === '' || !isRecord(payload)) return null;
    // Claims before keys: a stale or foreign token is refused without touching the network.
    const identity = identityFrom(payload, now());
    if (!identity) return null;
    const key = await keyFor(header.kid);
    if (!key) return null;
    const verified = await globalThis.crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64urlDecode(encodedSignature),
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
    );
    return verified ? identity : null;
  }

  return {
    async verify(request: Request): Promise<SlotlockAccessIdentity | null> {
      try {
        return await check(request);
      } catch {
        return null;
      }
    },
  };
}
