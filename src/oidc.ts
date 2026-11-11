// OpenID Connect for teams' single sign-on (teams phase 5.3), and for Google's sign-in: an ID
// token checked as OpenID Connect Core 1.0 §3.1.3.7 says, its keys from the issuer's JWKS, and
// every URL a team's Owner can influence fetched as hostile (OWASP's SSRF guidance). WebCrypto
// only, so the same code runs on a Worker and on Node.
//
// What it refuses, and why:
// - `alg: none` and every HMAC algorithm: an HS256 token would make the client secret a signing key.
// - A key whose type, curve or `use` does not fit the token's algorithm, and RSA keys under 2048 bits.
// - An issuer that is not exactly the one configured, an audience without the client (or, with
//   others, an `azp` that is not it), an expired token (60 seconds' skew), one not yet valid, one
//   issued more than 5 minutes ago or more than 60 seconds ahead, and a nonce that is not the one
//   sent.

/** The algorithms Slotlock verifies: RSA PKCS#1 v1.5, RSA-PSS and ECDSA P-256, all with SHA-256. */
export const SLOTLOCK_OIDC_ALGORITHMS = Object.freeze(['RS256', 'PS256', 'ES256'] as const);
export type SlotlockOidcAlgorithm = (typeof SLOTLOCK_OIDC_ALGORITHMS)[number];

/** Why an ID token was refused (never shown with the token). */
export type SlotlockIdTokenRefusal =
  | 'malformed'
  | 'algorithm'
  | 'key'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'expired'
  | 'not_yet_valid'
  | 'issued_at'
  | 'nonce'
  | 'subject';

const SKEW_SECONDS = 60;
const ISSUED_WITHIN_SECONDS = 300;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** RFC 4648 base64url, without padding, to bytes; null when it is not that. */
export function slotlockBase64UrlBytes(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** Bytes as RFC 4648 base64url, without padding. */
export function slotlockBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function jsonOf(part: string): Record<string, unknown> | null {
  const bytes = slotlockBase64UrlBytes(part);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(textDecoder.decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isAlgorithm = (value: unknown): value is SlotlockOidcAlgorithm =>
  typeof value === 'string' && (SLOTLOCK_OIDC_ALGORITHMS as readonly string[]).includes(value);

/** A JWK as an issuer publishes it. */
export interface SlotlockJwk {
  kty?: unknown;
  kid?: unknown;
  use?: unknown;
  alg?: unknown;
  n?: unknown;
  e?: unknown;
  crv?: unknown;
  x?: unknown;
  y?: unknown;
}

/**
 * A published key as a verification key for `alg`, or null when it does not fit it: RSA (at least
 * 2048 bits) for RS256 and PS256, EC P-256 for ES256; `use`, when given, `sig`; `alg`, when given,
 * the token's.
 */
export async function importSlotlockJwk(jwk: SlotlockJwk, alg: SlotlockOidcAlgorithm): Promise<CryptoKey | null> {
  if (jwk.use !== undefined && jwk.use !== 'sig') return null;
  if (jwk.alg !== undefined && jwk.alg !== alg) return null;
  try {
    if (alg === 'ES256') {
      if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
      return await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    }
    if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return null;
    const modulus = slotlockBase64UrlBytes(jwk.n);
    // The modulus's significant bytes: 256 or more is 2048 bits or more.
    const significant = modulus ? modulus.length - (modulus.findIndex((byte) => byte !== 0) === -1 ? modulus.length : modulus.findIndex((byte) => byte !== 0)) : 0;
    if (significant < 256) return null;
    const algorithm = alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'RSA-PSS', hash: 'SHA-256' };
    return await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true }, algorithm, false, ['verify']);
  } catch {
    return null;
  }
}

/** Finds the key a token names: by issuer's JWKS and key id (see createSlotlockJwksCache). */
export type SlotlockKeyLookup = (kid: string | null, alg: SlotlockOidcAlgorithm) => Promise<CryptoKey | null>;

/** What an ID token is checked against. */
export interface SlotlockIdTokenExpectation {
  /** The exact issuer, or the exact spellings one issuer documents (Google has two). */
  issuers: readonly string[];
  clientId: string;
  /** The algorithms this issuer may sign with: a subset of SLOTLOCK_OIDC_ALGORITHMS. */
  algorithms: readonly SlotlockOidcAlgorithm[];
  keys: SlotlockKeyLookup;
  nonce: string;
  /** Milliseconds since the epoch. */
  now: number;
}

/** An ID token checked: its claims, all of them, for the caller to read what it needs. */
export type SlotlockIdTokenResult = { claims: Record<string, unknown> } | { refusal: SlotlockIdTokenRefusal };

function constantTimeEqual(a: string, b: string): boolean {
  const left = textEncoder.encode(a);
  const right = textEncoder.encode(b);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/** Check an ID token: its signature first, then its claims, in OpenID Connect Core's order. */
export async function verifySlotlockIdToken(token: string, expected: SlotlockIdTokenExpectation): Promise<SlotlockIdTokenResult> {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 16_384) return { refusal: 'malformed' };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = jsonOf(headerPart);
  const claims = jsonOf(payloadPart);
  const signature = slotlockBase64UrlBytes(signaturePart);
  if (!header || !claims || !signature) return { refusal: 'malformed' };
  // Only the algorithms this issuer was set up with, from the three Slotlock verifies: never none,
  // never an HMAC.
  if (!isAlgorithm(header.alg) || !expected.algorithms.includes(header.alg)) return { refusal: 'algorithm' };
  if (header.crit !== undefined) return { refusal: 'malformed' };
  const alg = header.alg;
  const key = await expected.keys(typeof header.kid === 'string' ? header.kid : null, alg);
  if (!key) return { refusal: 'key' };
  const signed = textEncoder.encode(`${headerPart}.${payloadPart}`);
  const algorithm =
    alg === 'RS256'
      ? { name: 'RSASSA-PKCS1-v1_5' }
      : alg === 'PS256'
        ? { name: 'RSA-PSS', saltLength: 32 }
        : { name: 'ECDSA', hash: 'SHA-256' };
  if (alg === 'ES256' && signature.length !== 64) return { refusal: 'signature' };
  let valid = false;
  try {
    valid = await crypto.subtle.verify(algorithm, key, signature, signed);
  } catch {
    valid = false;
  }
  if (!valid) return { refusal: 'signature' };
  if (typeof claims.iss !== 'string' || !expected.issuers.includes(claims.iss)) return { refusal: 'issuer' };
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(expected.clientId)) return { refusal: 'audience' };
  if ((audience.length > 1 || claims.azp !== undefined) && claims.azp !== expected.clientId) return { refusal: 'audience' };
  const seconds = expected.now / 1000;
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS <= seconds) return { refusal: 'expired' };
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - SKEW_SECONDS > seconds)) {
    return { refusal: 'not_yet_valid' };
  }
  if (claims.iat !== undefined) {
    if (typeof claims.iat !== 'number' || claims.iat > seconds + SKEW_SECONDS || claims.iat < seconds - ISSUED_WITHIN_SECONDS - SKEW_SECONDS) {
      return { refusal: 'issued_at' };
    }
  }
  if (typeof claims.nonce !== 'string' || !constantTimeEqual(claims.nonce, expected.nonce)) return { refusal: 'nonce' };
  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 255) return { refusal: 'subject' };
  return { claims };
}

/** Why a URL an Owner gave, or a document fetched from one, was refused. */
export class SlotlockOidcFetchError extends Error {
  constructor(
    readonly code: 'url' | 'redirect' | 'status' | 'type' | 'size' | 'json' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'SlotlockOidcFetchError';
  }
}

const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/;
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet', '.corp'];

/**
 * Whether a URL is one Slotlock fetches for a team: https on the default port, a host name (never
 * an IP literal), never localhost, a single label, or a private-use suffix; no credentials.
 */
export function slotlockOidcUrlAllowed(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return null;
  if (IP_LITERAL.test(host) || host === 'localhost' || !host.includes('.') || host.endsWith('.')) return null;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
  return url;
}

/**
 * GET a JSON document from a URL an Owner influenced: refused unless slotlockOidcUrlAllowed; no
 * redirect followed (any 3xx refuses); 5 seconds; 256 KB; a JSON content type. On Node, pass a
 * fetch that refuses private addresses (webhooks.ts createSlotlockGuardedFetch).
 */
export async function slotlockFetchOidcJson(
  value: string,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ body: Record<string, unknown>; maxAge: number | null }> {
  const url = slotlockOidcUrlAllowed(value);
  if (!url) throw new SlotlockOidcFetchError('url', 'the URL must be https on a public host name');
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const maxBytes = options.maxBytes ?? 262_144;
  let response: Response;
  try {
    response = await fetchImpl(url.href, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    });
  } catch {
    throw new SlotlockOidcFetchError('network', 'the URL did not answer');
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new SlotlockOidcFetchError('redirect', 'the URL redirected');
  }
  if (!response.ok) throw new SlotlockOidcFetchError('status', `the URL answered HTTP ${response.status}`);
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type !== 'application/json' && !type.endsWith('+json')) throw new SlotlockOidcFetchError('type', 'the URL did not answer JSON');
  const body = await slotlockReadJsonBody(response, maxBytes);
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1]);
  return { body, maxAge: Number.isFinite(maxAge) ? maxAge : null };
}

/**
 * A JSON object answered by a host an Owner chose, read to at most maxBytes (the declared length
 * first, then as it streams), so a provider cannot make the server buffer an endless answer.
 */
export async function slotlockReadJsonBody(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SlotlockOidcFetchError('size', 'the answer is too large');
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SlotlockOidcFetchError('size', 'the answer is too large');
      }
      chunks.push(chunk);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SlotlockOidcFetchError('json', 'the answer is not JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new SlotlockOidcFetchError('json', 'the answer is not a JSON object');
  return body as Record<string, unknown>;
}

/** An issuer's endpoints, as its discovery document gave them when an Owner saved the connection. */
export interface SlotlockOidcProvider {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  algorithms: SlotlockOidcAlgorithm[];
  /** RFC 9207: the issuer returns `iss` with the code, and Slotlock then checks it. */
  issParameter: boolean;
}

/**
 * An issuer's discovery document (OpenID Connect Discovery 1.0): its `issuer` must be exactly the
 * one entered, its endpoints https on public host names, and it must sign with an algorithm Slotlock
 * verifies.
 */
export async function discoverSlotlockOidc(issuer: string, options: { fetch?: typeof fetch } = {}): Promise<SlotlockOidcProvider> {
  if (!slotlockOidcUrlAllowed(issuer)) throw new SlotlockOidcFetchError('url', 'the issuer must be https on a public host name');
  const { body } = await slotlockFetchOidcJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, options);
  if (body.issuer !== issuer) throw new SlotlockOidcFetchError('json', 'the discovery document names another issuer');
  const endpoints = [body.authorization_endpoint, body.token_endpoint, body.jwks_uri];
  if (!endpoints.every((endpoint) => typeof endpoint === 'string' && slotlockOidcUrlAllowed(endpoint))) {
    throw new SlotlockOidcFetchError('url', 'the discovery document names an endpoint that is not https on a public host name');
  }
  const advertised = Array.isArray(body.id_token_signing_alg_values_supported) ? body.id_token_signing_alg_values_supported : ['RS256'];
  const algorithms = SLOTLOCK_OIDC_ALGORITHMS.filter((alg) => advertised.includes(alg));
  if (algorithms.length === 0) throw new SlotlockOidcFetchError('json', 'the issuer signs with no algorithm Slotlock verifies (RS256, PS256, ES256)');
  return {
    issuer,
    authorizationEndpoint: body.authorization_endpoint as string,
    tokenEndpoint: body.token_endpoint as string,
    jwksUri: body.jwks_uri as string,
    algorithms,
    issParameter: body.authorization_response_iss_parameter_supported === true,
  };
}

/** Microsoft's consumer-account tenant (MSA): never a team's. */
const ENTRA_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * An Entra ID tenant's v2.0 issuer, pinned to its GUID: never `common`, `organizations`,
 * `consumers`, a domain name or the consumer tenant, so the multi-tenant `{tenantid}` issuer never
 * exists in Slotlock. Null when the tenant is not one.
 */
export function slotlockEntraIssuer(tenant: string): string | null {
  const id = tenant.trim().toLowerCase();
  if (!GUID.test(id) || id === ENTRA_CONSUMER_TENANT) return null;
  return `https://login.microsoftonline.com/${id}/v2.0`;
}

/** Google's issuer, in the two spellings it documents. */
export const SLOTLOCK_GOOGLE_ISSUERS = Object.freeze(['https://accounts.google.com', 'accounts.google.com']);

interface CachedJwks {
  keys: SlotlockJwk[];
  fetchedAt: number;
  until: number;
  lastFetch: number;
  inflight: Promise<void> | null;
}

/**
 * Issuers' keys, by JWKS URL: kept for the answer's max-age (5 minutes to 24 hours). A key id not
 * among them is fetched again at most once a minute per URL, one fetch at a time; while the URL
 * fails, a set fetched within 24 hours still serves the keys it holds. At most `maxUrls` URLs and 20
 * keys each are kept, only the fields verifying needs: the URLs are Owners' to choose.
 */
export function createSlotlockJwksCache(options: {
  fetchJson?: (url: string) => Promise<{ body: Record<string, unknown>; maxAge: number | null }>;
  fetch?: typeof fetch;
  now?: () => number;
  /** How many JWKS URLs are kept (100): the least recently used goes first. */
  maxUrls?: number;
}) {
  const now = options.now ?? Date.now;
  const maxUrls = options.maxUrls ?? 100;
  const fetchJson = options.fetchJson ?? ((url: string) => slotlockFetchOidcJson(url, options.fetch ? { fetch: options.fetch } : {}));
  const cache = new Map<string, CachedJwks>();
  const imported = new Map<string, CryptoKey>();

  /** Mark a URL as just used; past maxUrls, forget the least recently used and its imported keys. */
  function touch(url: string, entry: CachedJwks): void {
    cache.delete(url);
    cache.set(url, entry);
    while (cache.size > maxUrls) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
      for (const name of [...imported.keys()]) if (name.startsWith(`${oldest} `)) imported.delete(name);
    }
  }

  async function refresh(url: string, entry: CachedJwks | undefined): Promise<CachedJwks | undefined> {
    const current = entry ?? { keys: [], fetchedAt: 0, until: 0, lastFetch: 0, inflight: null };
    if (!entry) touch(url, current);
    if (!current.inflight) {
      current.lastFetch = now();
      current.inflight = (async () => {
        try {
          const { body, maxAge } = await fetchJson(url);
          // Only what verifying needs, of at most 20 keys: never the whole answer.
          const fields = ['kty', 'kid', 'use', 'alg', 'n', 'e', 'crv', 'x', 'y'] as const;
          const keys = Array.isArray(body.keys)
            ? (body.keys.filter((key) => typeof key === 'object' && key !== null).slice(0, 20) as SlotlockJwk[]).map((jwk) => {
                const kept: SlotlockJwk = {};
                for (const field of fields) if (typeof jwk[field] === 'string') kept[field] = jwk[field];
                return kept;
              })
            : [];
          const lifetime = Math.min(Math.max((maxAge ?? 3_600) * 1000, 300_000), 86_400_000);
          current.keys = keys;
          current.fetchedAt = now();
          current.until = now() + lifetime;
          for (const name of [...imported.keys()]) if (name.startsWith(`${url} `)) imported.delete(name);
        } catch {
          // A failed fetch keeps what was there; the caller decides whether it is too old.
        } finally {
          current.inflight = null;
        }
      })();
    }
    await current.inflight;
    return cache.get(url);
  }

  async function keyFrom(url: string, entry: CachedJwks, kid: string | null, alg: SlotlockOidcAlgorithm): Promise<CryptoKey | null> {
    if (now() - entry.fetchedAt > 86_400_000) return null;
    const candidates = entry.keys.filter((jwk) => (kid === null ? true : jwk.kid === kid));
    // Without a key id, only a set of one key names it.
    if (kid === null && candidates.length !== 1) return null;
    const jwk = candidates[0];
    if (!jwk) return null;
    const name = `${url} ${String(jwk.kid ?? '')} ${alg}`;
    const cached = imported.get(name);
    if (cached) return cached;
    const key = await importSlotlockJwk(jwk, alg);
    if (key) imported.set(name, key);
    return key;
  }

  return {
    /** The key `kid` names at `url` for `alg`, or null. */
    async key(url: string, kid: string | null, alg: SlotlockOidcAlgorithm): Promise<CryptoKey | null> {
      let entry = cache.get(url);
      if (entry) touch(url, entry);
      if (!entry || entry.until <= now()) entry = await refresh(url, entry);
      if (!entry) return null;
      const found = await keyFrom(url, entry, kid, alg);
      if (found) return found;
      // An unknown key id: the issuer may have rotated. Once a minute at most.
      if (now() - entry.lastFetch < 60_000) return null;
      entry = await refresh(url, entry);
      return entry ? keyFrom(url, entry, kid, alg) : null;
    },
    /** A lookup bound to one JWKS URL, for verifySlotlockIdToken. */
    lookup(url: string): SlotlockKeyLookup {
      return (kid, alg) => this.key(url, kid, alg);
    },
  };
}

export type SlotlockJwksCache = ReturnType<typeof createSlotlockJwksCache>;

/**
 * Seals and opens a team's client secret: AES-256-GCM under a key derived (HKDF-SHA-256) from
 * SLOTLOCK_SSO_SECRET, a random 12-byte IV each time, and the team and connection as associated
 * data, so a sealed secret moved to another row does not open.
 */
export function createSlotlockSecretBox(secret: string) {
  if (secret.length < 32) throw new Error('Slotlock SSO: the secret must be at least 32 characters');
  let derived: Promise<CryptoKey> | null = null;
  const key = () => {
    derived ??= crypto.subtle
      .importKey('raw', textEncoder.encode(secret), 'HKDF', false, ['deriveKey'])
      .then((material) =>
        crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: textEncoder.encode('slotlock-sso-v1'), info: textEncoder.encode('client-secret') },
          material,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      );
    return derived;
  };
  return {
    async seal(plaintext: string, associated: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: textEncoder.encode(associated) }, await key(), textEncoder.encode(plaintext));
      return `v1.${slotlockBase64Url(iv)}.${slotlockBase64Url(new Uint8Array(sealed))}`;
    },
    async open(sealed: string, associated: string): Promise<string | null> {
      const [version, ivText, bodyText, ...rest] = sealed.split('.');
      const iv = slotlockBase64UrlBytes(ivText ?? '');
      const body = slotlockBase64UrlBytes(bodyText ?? '');
      if (version !== 'v1' || rest.length > 0 || !iv || iv.length !== 12 || !body) return null;
      try {
        const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: textEncoder.encode(associated) }, await key(), body);
        return new TextDecoder().decode(opened);
      } catch {
        return null;
      }
    },
  };
}

export type SlotlockSecretBox = ReturnType<typeof createSlotlockSecretBox>;
