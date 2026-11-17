// Passkeys (WebAuthn Level 2) as the admin console's second factor: a challenge, verifying a
// registration (attestation "none") and verifying an assertion at sign-in. Only WebCrypto and
// standard JS, so the same file runs in Node and in Cloudflare Workers.
//
// Everything an authenticator or browser sends is parsed strictly and any doubt is an error: a
// second factor that accepts a malformed response is not a second factor. Each failure throws a
// SlotlockPasskeyError whose code says which check refused it; nothing returns a partial result.
//
// What stays with the caller: issuing one challenge per ceremony and forgetting it after one use,
// checking the credential id the browser reports (rawId) against the one stored, and refusing a
// sign count that went backwards.

export type SlotlockPasskeyErrorCode =
  | 'encoding'
  | 'client_data'
  | 'type'
  | 'challenge'
  | 'origin'
  | 'rp_id'
  | 'authenticator_data'
  | 'user_presence'
  | 'user_verification'
  | 'attestation_object'
  | 'attested_data'
  | 'cbor'
  | 'cose'
  | 'algorithm'
  | 'signature'
  | 'trailing_bytes';

export class SlotlockPasskeyError extends Error {
  readonly code: SlotlockPasskeyErrorCode;

  constructor(code: SlotlockPasskeyErrorCode, message: string) {
    super(message);
    this.name = 'SlotlockPasskeyError';
    this.code = code;
  }
}

/** The COSE algorithms we accept: ES256 (every platform authenticator) and RS256 (Windows Hello). */
export type SlotlockPasskeyAlgorithm = -7 | -257;

export interface SlotlockPasskeyRegistration {
  credentialId: Uint8Array<ArrayBuffer>;
  /** The COSE_Key exactly as the authenticator sent it; store it and pass it back at sign-in. */
  publicKey: Uint8Array<ArrayBuffer>;
  algorithm: SlotlockPasskeyAlgorithm;
  signCount: number;
}

const encoder = new TextEncoder();
// fatal: malformed UTF-8 is an error rather than U+FFFD. ignoreBOM: a leading BOM stays in the
// text, so two different byte strings never decode to the same string.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ---------------------------------------------------------------------------------------------
// base64url (RFC 4648, section 5)

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SEXTETS = new Int8Array(128).fill(-1);
for (let index = 0; index < ALPHABET.length; index += 1) SEXTETS[ALPHABET.charCodeAt(index)] = index;

export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const remaining = bytes.length - index;
    const chunk =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out += ALPHABET.charAt((chunk >> 18) & 63) + ALPHABET.charAt((chunk >> 12) & 63);
    if (remaining > 1) out += ALPHABET.charAt((chunk >> 6) & 63);
    if (remaining > 2) out += ALPHABET.charAt(chunk & 63);
  }
  return out;
}

/**
 * base64url with or without padding. Anything else (standard base64's `+` and `/`, whitespace,
 * misplaced padding, non-zero leftover bits) throws, so one byte string has one accepted spelling.
 */
export function base64urlDecode(text: string): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string') throw new SlotlockPasskeyError('encoding', 'expected base64url text');
  let end = text.length;
  if (text.endsWith('=')) {
    if (text.length % 4 !== 0) throw new SlotlockPasskeyError('encoding', 'misplaced base64url padding');
    end -= text.endsWith('==') ? 2 : 1;
  }
  if (end % 4 === 1) throw new SlotlockPasskeyError('encoding', 'truncated base64url');
  const out = new Uint8Array(Math.floor((end * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (let index = 0; index < end; index += 1) {
    const code = text.charCodeAt(index);
    const sextet = code < 128 ? (SEXTETS[code] ?? -1) : -1;
    if (sextet < 0) throw new SlotlockPasskeyError('encoding', 'not base64url');
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written] = (buffer >> bits) & 0xff;
      written += 1;
    }
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0) throw new SlotlockPasskeyError('encoding', 'non-canonical base64url');
  return out;
}

/** A fresh challenge: 32 random bytes, base64url without padding. */
export function createSlotlockPasskeyChallenge(): string {
  return base64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

// ---------------------------------------------------------------------------------------------
// CBOR (RFC 8949), only what WebAuthn uses

export type SlotlockCborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array<ArrayBuffer>
  | SlotlockCborValue[]
  | SlotlockCborMap;
export type SlotlockCborMap = Map<number | string, SlotlockCborValue>;

const CBOR_MAX_DEPTH = 16;

/**
 * One CBOR data item at `offset`, and how many bytes it took, so the caller decides whether bytes
 * may follow. Definite lengths only, integers within 2^53, no tags, floats or simple values other
 * than true/false/null, map keys that are integers or text and never repeat, and nesting at most
 * 16 deep. Every length is checked against the input left before anything is allocated.
 */
export function decodeSlotlockCbor(
  bytes: Uint8Array,
  offset = 0,
): { value: SlotlockCborValue; bytesRead: number } {
  let position = offset;
  const malformed = (message: string) => new SlotlockPasskeyError('cbor', `CBOR: ${message}`);

  const argument = (info: number): number => {
    if (info < 24) return info;
    if (info === 31) throw malformed('indefinite lengths are not accepted');
    if (info > 27) throw malformed('reserved additional information');
    const size = 1 << (info - 24);
    if (size > bytes.length - position) throw malformed('truncated argument');
    let value = 0;
    for (let index = 0; index < size; index += 1) value = value * 256 + (bytes[position + index] ?? 0);
    position += size;
    if (!Number.isSafeInteger(value)) throw malformed('integer beyond 2^53');
    return value;
  };

  const item = (depth: number): SlotlockCborValue => {
    if (depth > CBOR_MAX_DEPTH) throw malformed('nested too deeply');
    const initial = bytes[position];
    if (initial === undefined) throw malformed('truncated');
    position += 1;
    const major = initial >> 5;
    const info = initial & 31;
    switch (major) {
      case 0:
        return argument(info);
      case 1:
        return -1 - argument(info);
      case 2:
      case 3: {
        const length = argument(info);
        if (length > bytes.length - position) throw malformed('string longer than the input');
        const content = bytes.slice(position, position + length);
        position += length;
        if (major === 2) return content;
        try {
          return utf8.decode(content);
        } catch {
          throw malformed('text is not UTF-8');
        }
      }
      case 4: {
        const count = argument(info);
        // Each element takes at least one byte, which caps the count before we loop on it.
        if (count > bytes.length - position) throw malformed('array longer than the input');
        const array: SlotlockCborValue[] = [];
        for (let index = 0; index < count; index += 1) array.push(item(depth + 1));
        return array;
      }
      case 5: {
        const count = argument(info);
        if (count * 2 > bytes.length - position) throw malformed('map longer than the input');
        const map: SlotlockCborMap = new Map();
        for (let index = 0; index < count; index += 1) {
          const key = item(depth + 1);
          if (typeof key !== 'number' && typeof key !== 'string') throw malformed('map key is not an integer or text');
          // A repeated key would let two parsers disagree about the value.
          if (map.has(key)) throw malformed('repeated map key');
          map.set(key, item(depth + 1));
        }
        return map;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw malformed(info === 31 ? 'unexpected break' : 'unsupported simple value or float');
      default:
        throw malformed('tags are not accepted');
    }
  };

  const value = item(1);
  return { value, bytesRead: position - offset };
}

// ---------------------------------------------------------------------------------------------
// Shared checks

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Compares without an early exit, so timing does not reveal how much of a challenge matched. */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function decodeInput(text: string, name: string): Uint8Array<ArrayBuffer> {
  try {
    return base64urlDecode(text);
  } catch {
    throw new SlotlockPasskeyError('encoding', `${name} is not base64url`);
  }
}

/** clientDataJSON (WebAuthn L2, 7.1 steps 5-12 and 7.2 steps 9-16). */
function checkClientData(
  bytes: Uint8Array,
  type: 'webauthn.create' | 'webauthn.get',
  expectedChallenge: string,
  expectedOrigin: string,
): void {
  // Checked first so a misconfigured caller fails every time, not only on a lucky match: an empty
  // or short expected challenge would make replay trivial.
  let expected: Uint8Array;
  try {
    expected = base64urlDecode(expectedChallenge);
  } catch {
    throw new SlotlockPasskeyError('challenge', 'the expected challenge is not base64url');
  }
  if (expected.length < 16) throw new SlotlockPasskeyError('challenge', 'the expected challenge is shorter than 16 bytes');
  if (typeof expectedOrigin !== 'string' || expectedOrigin === '') {
    throw new SlotlockPasskeyError('origin', 'no expected origin');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(bytes));
  } catch {
    throw new SlotlockPasskeyError('client_data', 'clientDataJSON is not UTF-8 JSON');
  }
  if (!isRecord(parsed)) throw new SlotlockPasskeyError('client_data', 'clientDataJSON is not an object');
  if (parsed.type !== type) throw new SlotlockPasskeyError('type', `clientDataJSON.type is not ${type}`);
  let presented: Uint8Array;
  try {
    presented = base64urlDecode(parsed.challenge as string);
  } catch {
    throw new SlotlockPasskeyError('challenge', 'clientDataJSON.challenge is not base64url');
  }
  if (!equalBytes(presented, expected)) throw new SlotlockPasskeyError('challenge', 'the challenge does not match');
  if (parsed.origin !== expectedOrigin) throw new SlotlockPasskeyError('origin', 'the origin does not match');
  if (parsed.crossOrigin !== undefined && typeof parsed.crossOrigin !== 'boolean') {
    throw new SlotlockPasskeyError('client_data', 'clientDataJSON.crossOrigin is not a boolean');
  }
  // The console is never embedded, so a ceremony from inside another site's frame is refused.
  if (parsed.crossOrigin === true) throw new SlotlockPasskeyError('origin', 'the ceremony ran in a cross-origin frame');
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;
const AUTH_DATA_HEADER = 37;

/** rpIdHash, flags and signCount (WebAuthn L2, 6.1). Returns the flags and the counter. */
async function checkAuthenticatorDataHeader(
  data: Uint8Array,
  rpId: string,
): Promise<{ flags: number; signCount: number }> {
  if (data.length < AUTH_DATA_HEADER) throw new SlotlockPasskeyError('authenticator_data', 'authenticator data is shorter than 37 bytes');
  if (typeof rpId !== 'string' || rpId === '') throw new SlotlockPasskeyError('rp_id', 'no RP ID');
  if (!equalBytes(data.subarray(0, 32), await sha256(encoder.encode(rpId)))) {
    throw new SlotlockPasskeyError('rp_id', 'the credential is scoped to another RP ID');
  }
  const flags = data[32] ?? 0;
  if ((flags & FLAG_UP) === 0) throw new SlotlockPasskeyError('user_presence', 'the user was not present');
  // UV is what makes the passkey a factor of its own (PIN or biometric), not just a touch.
  if ((flags & FLAG_UV) === 0) throw new SlotlockPasskeyError('user_verification', 'the user was not verified');
  const signCount = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(33, false);
  return { flags, signCount };
}

/** Skips the extensions map when ED is set, then insists the authenticator data ends there. */
function finishAuthenticatorData(data: Uint8Array, offset: number, flags: number): void {
  let position = offset;
  if (flags & FLAG_ED) {
    const extensions = decodeSlotlockCbor(data, position);
    if (!(extensions.value instanceof Map)) throw new SlotlockPasskeyError('authenticator_data', 'extensions are not a CBOR map');
    position += extensions.bytesRead;
  }
  if (position !== data.length) throw new SlotlockPasskeyError('trailing_bytes', 'bytes follow the authenticator data');
}

// ---------------------------------------------------------------------------------------------
// COSE keys (RFC 9053) and signatures

/** The JWK members we produce; a local type because the global one is DOM's, not ES2022's. */
interface PublicJwk {
  kty: 'EC' | 'RSA';
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  alg?: string;
  ext: boolean;
}

interface CoseKey {
  algorithm: SlotlockPasskeyAlgorithm;
  jwk: PublicJwk;
}

function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  return bytes.subarray(start);
}

function bitLength(bytes: Uint8Array): number {
  const trimmed = stripLeadingZeros(bytes);
  const first = trimmed[0];
  return first === undefined ? 0 : (trimmed.length - 1) * 8 + (32 - Math.clz32(first));
}

function coseBytes(map: SlotlockCborMap, label: number, what: string): Uint8Array {
  const value = map.get(label);
  if (!(value instanceof Uint8Array)) throw new SlotlockPasskeyError('cose', `COSE key has no ${what}`);
  return value;
}

function parseCoseKey(value: SlotlockCborValue): CoseKey {
  if (!(value instanceof Map)) throw new SlotlockPasskeyError('cose', 'the COSE key is not a CBOR map');
  const algorithm = value.get(3);
  const kty = value.get(1);
  if (algorithm === -7) {
    if (kty !== 2 || value.get(-1) !== 1) throw new SlotlockPasskeyError('cose', 'ES256 needs an EC2 key on P-256');
    // A private key has no business here; refusing it keeps one from ending up in storage.
    if (value.has(-4)) throw new SlotlockPasskeyError('cose', 'the COSE key holds a private key');
    const x = coseBytes(value, -2, 'x');
    const y = coseBytes(value, -3, 'y');
    if (x.length !== 32 || y.length !== 32) throw new SlotlockPasskeyError('cose', 'P-256 coordinates are 32 bytes');
    return { algorithm, jwk: { kty: 'EC', crv: 'P-256', x: base64urlEncode(x), y: base64urlEncode(y), ext: true } };
  }
  if (algorithm === -257) {
    if (kty !== 3) throw new SlotlockPasskeyError('cose', 'RS256 needs an RSA key');
    if (value.has(-3)) throw new SlotlockPasskeyError('cose', 'the COSE key holds a private key');
    const n = stripLeadingZeros(coseBytes(value, -1, 'modulus'));
    const e = stripLeadingZeros(coseBytes(value, -2, 'exponent'));
    const modulusBits = bitLength(n);
    if (modulusBits < 2048 || modulusBits > 8192) throw new SlotlockPasskeyError('cose', 'RSA modulus outside 2048-8192 bits');
    // An exponent of 1 (or an even one) would make signatures forgeable or the key invalid.
    const last = e[e.length - 1] ?? 0;
    if (e.length === 0 || e.length > 4 || (last & 1) === 0 || (e.length === 1 && last < 3)) {
      throw new SlotlockPasskeyError('cose', 'unusable RSA exponent');
    }
    return { algorithm, jwk: { kty: 'RSA', n: base64urlEncode(n), e: base64urlEncode(e), alg: 'RS256', ext: true } };
  }
  throw new SlotlockPasskeyError('algorithm', `COSE algorithm ${String(algorithm)} is not supported`);
}

async function importCoseKey(key: CoseKey): Promise<CryptoKey> {
  const parameters =
    key.algorithm === -7
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  try {
    // Import also checks the key itself, e.g. that an EC point lies on the curve.
    return await globalThis.crypto.subtle.importKey('jwk', key.jwk, parameters, false, ['verify']);
  } catch {
    throw new SlotlockPasskeyError('cose', 'the COSE key is not a usable public key');
  }
}

/**
 * An authenticator's ES256 signature is DER (SEQUENCE { r INTEGER, s INTEGER }); WebCrypto wants
 * r || s, each left-padded to 32 bytes.
 */
function derToRawSignature(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const malformed = () => new SlotlockPasskeyError('signature', 'the ES256 signature is not DER SEQUENCE { INTEGER, INTEGER }');
  // At most 2 + 2 * (2 + 33) = 72 bytes, so the SEQUENCE length is always DER's one-byte form.
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) throw malformed();
  const raw = new Uint8Array(64);
  let position = 2;
  for (const slot of [0, 32]) {
    const length = der[position + 1] ?? 0;
    if (der[position] !== 0x02 || length < 1 || length > 33 || position + 2 + length > der.length) throw malformed();
    const integer = der.subarray(position + 2, position + 2 + length);
    position += 2 + length;
    // r and s are positive: a set high bit would make the INTEGER negative.
    if (((integer[0] ?? 0) & 0x80) !== 0) throw malformed();
    const magnitude = stripLeadingZeros(integer);
    if (magnitude.length === 0 || magnitude.length > 32) throw malformed();
    raw.set(magnitude, slot + 32 - magnitude.length);
  }
  if (position !== der.length) throw malformed();
  return raw;
}

// ---------------------------------------------------------------------------------------------
// Ceremonies

/**
 * A new passkey (WebAuthn L2, 7.1). We ask for attestation "none", so the statement is not
 * verified: any fmt is accepted and attStmt is ignored. What is checked is everything that binds
 * the response to this challenge, this origin and this RP ID, plus a usable ES256 or RS256 key.
 */
export async function verifySlotlockPasskeyRegistration(input: {
  attestationObject: string;
  clientDataJSON: string;
  expectedChallenge: string;
  expectedOrigin: string;
  rpId: string;
}): Promise<SlotlockPasskeyRegistration> {
  const clientData = decodeInput(input.clientDataJSON, 'clientDataJSON');
  const attestation = decodeInput(input.attestationObject, 'attestationObject');
  checkClientData(clientData, 'webauthn.create', input.expectedChallenge, input.expectedOrigin);

  const decoded = decodeSlotlockCbor(attestation);
  if (decoded.bytesRead !== attestation.length) throw new SlotlockPasskeyError('trailing_bytes', 'bytes follow the attestation object');
  const object = decoded.value;
  if (!(object instanceof Map)) throw new SlotlockPasskeyError('attestation_object', 'the attestation object is not a CBOR map');
  const authData = object.get('authData');
  if (
    typeof object.get('fmt') !== 'string' ||
    !(object.get('attStmt') instanceof Map) ||
    !(authData instanceof Uint8Array)
  ) {
    throw new SlotlockPasskeyError('attestation_object', 'the attestation object needs fmt, attStmt and authData');
  }

  const { flags, signCount } = await checkAuthenticatorDataHeader(authData, input.rpId);
  if ((flags & FLAG_AT) === 0) throw new SlotlockPasskeyError('attested_data', 'no attested credential data');
  // attestedCredentialData: aaguid (16) || credentialIdLength (2, big-endian) || credentialId || COSE_Key
  let position = AUTH_DATA_HEADER + 16;
  if (authData.length < position + 2) throw new SlotlockPasskeyError('attested_data', 'attested credential data is truncated');
  const idLength = ((authData[position] ?? 0) << 8) | (authData[position + 1] ?? 0);
  position += 2;
  // 1023 is the Level 2 limit; it also keeps a hostile length from reaching storage.
  if (idLength < 1 || idLength > 1023 || authData.length < position + idLength) {
    throw new SlotlockPasskeyError('attested_data', 'bad credential id length');
  }
  const credentialId = authData.slice(position, position + idLength);
  position += idLength;
  const coseKey = decodeSlotlockCbor(authData, position);
  const publicKey = authData.slice(position, position + coseKey.bytesRead);
  position += coseKey.bytesRead;
  const key = parseCoseKey(coseKey.value);
  finishAuthenticatorData(authData, position, flags);
  // Imported now so a key that cannot verify anything is refused before it is stored.
  await importCoseKey(key);

  return { credentialId, publicKey, algorithm: key.algorithm, signCount };
}

/**
 * A sign-in with a stored passkey (WebAuthn L2, 7.2). The caller looks the credential up by its id,
 * passes its stored COSE key and algorithm, and then refuses a signCount that did not increase
 * (unless both are 0: many passkeys never count).
 */
export async function verifySlotlockPasskeyAssertion(input: {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  expectedChallenge: string;
  expectedOrigin: string;
  rpId: string;
  publicKey: Uint8Array;
  algorithm: SlotlockPasskeyAlgorithm;
}): Promise<{ signCount: number }> {
  const clientData = decodeInput(input.clientDataJSON, 'clientDataJSON');
  const authData = decodeInput(input.authenticatorData, 'authenticatorData');
  const signature = decodeInput(input.signature, 'signature');
  checkClientData(clientData, 'webauthn.get', input.expectedChallenge, input.expectedOrigin);

  const { flags, signCount } = await checkAuthenticatorDataHeader(authData, input.rpId);
  // An assertion never carries attested credential data; one that does is not from a conforming
  // authenticator.
  if (flags & FLAG_AT) throw new SlotlockPasskeyError('attested_data', 'an assertion carries attested credential data');
  finishAuthenticatorData(authData, AUTH_DATA_HEADER, flags);

  if (!(input.publicKey instanceof Uint8Array)) throw new SlotlockPasskeyError('cose', 'no stored public key');
  const stored = decodeSlotlockCbor(input.publicKey);
  if (stored.bytesRead !== input.publicKey.length) throw new SlotlockPasskeyError('trailing_bytes', 'bytes follow the stored COSE key');
  const key = parseCoseKey(stored.value);
  // The algorithm is stored beside the key; a mismatch means one of them is not what we stored.
  if (input.algorithm !== key.algorithm) throw new SlotlockPasskeyError('algorithm', 'the algorithm does not match the stored key');
  const cryptoKey = await importCoseKey(key);

  const signed = concatBytes(authData, await sha256(clientData));
  const verified = await globalThis.crypto.subtle
    .verify(
      key.algorithm === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' },
      cryptoKey,
      key.algorithm === -7 ? derToRawSignature(signature) : signature,
      signed,
    )
    .catch(() => false);
  if (!verified) throw new SlotlockPasskeyError('signature', 'the signature does not verify');
  return { signCount };
}
