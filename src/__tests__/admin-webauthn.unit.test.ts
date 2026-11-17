import { describe, expect, it } from 'vitest';
import {
  SlotlockPasskeyError,
  base64urlDecode,
  base64urlEncode,
  createSlotlockPasskeyChallenge,
  decodeSlotlockCbor,
  verifySlotlockPasskeyAssertion,
  verifySlotlockPasskeyRegistration,
} from '../admin/webauthn.js';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const ORIGIN = 'https://admin.slotlock.example';
const RP_ID = 'admin.slotlock.example';
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;
const ED = 0x80;

// Buffer, not the module's own base64url, so the fixtures do not share a bug with the code.
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64url'));

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const sha256 = async (data: Uint8Array<ArrayBuffer>) => new Uint8Array(await subtle.digest('SHA-256', data));

// ---------- A tiny CBOR encoder: definite lengths, just what authenticators send ----------

/** Bytes spliced in as they are, to build CBOR the encoder would never write. */
class RawCbor {
  constructor(readonly bytes: Uint8Array) {}
}
type Cbor = number | string | boolean | null | Uint8Array | RawCbor | Cbor[] | Map<Cbor, Cbor>;

function cborHead(major: number, value: number): Uint8Array<ArrayBuffer> {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value < 0x100) return Uint8Array.of((major << 5) | 24, value);
  if (value < 0x10000) return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  return Uint8Array.of((major << 5) | 26, value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

function cbor(value: Cbor): Uint8Array<ArrayBuffer> {
  if (value instanceof RawCbor) return concat(value.bytes);
  if (value === false) return Uint8Array.of(0xf4);
  if (value === true) return Uint8Array.of(0xf5);
  if (value === null) return Uint8Array.of(0xf6);
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const text = encoder.encode(value);
    return concat(cborHead(3, text.length), text);
  }
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  if (Array.isArray(value)) return concat(cborHead(4, value.length), ...value.map(cbor));
  return concat(cborHead(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]));
}

// ---------- Test authenticators ----------

interface TestKey {
  algorithm: -7 | -257;
  cose: Uint8Array<ArrayBuffer>;
  /** What the authenticator would send: DER for ES256, PKCS#1 v1.5 for RS256. */
  sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
  /** ES256 only: WebCrypto's raw r || s, which an authenticator never sends. */
  signRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
}

/** DER INTEGER for an unsigned big-endian value: minimal, with a 0x00 when the high bit is set. */
function derInteger(value: Uint8Array): Uint8Array<ArrayBuffer> {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  let content = value.subarray(start);
  if (((content[0] ?? 0) & 0x80) !== 0) content = concat(Uint8Array.of(0), content);
  return concat(Uint8Array.of(0x02, content.length), content);
}

/** WebCrypto signs ECDSA as raw r || s; authenticators send SEQUENCE { r, s }. */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = concat(derInteger(raw.subarray(0, 32)), derInteger(raw.subarray(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

async function es256Key(): Promise<TestKey> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  const cose = cbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, unb64(jwk.x as string)],
      [-3, unb64(jwk.y as string)],
    ]),
  );
  const signRaw = async (data: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data));
  return { algorithm: -7, cose, signRaw, sign: async (data) => rawToDer(await signRaw(data)) };
}

async function rs256Key(): Promise<TestKey> {
  const pair = await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  const cose = cbor(
    new Map<Cbor, Cbor>([
      [1, 3],
      [3, -257],
      [-1, unb64(jwk.n as string)],
      [-2, unb64(jwk.e as string)],
    ]),
  );
  const sign = async (data: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, data));
  return { algorithm: -257, cose, sign, signRaw: sign };
}

// Generated once: RSA key generation is the slow part of this file.
const keys = { es256: es256Key(), rs256: rs256Key() };

async function authenticatorData(options: {
  rpId?: string;
  flags: number;
  signCount: number;
  tail?: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
  const counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, options.signCount);
  return concat(
    await sha256(encoder.encode(options.rpId ?? RP_ID)),
    Uint8Array.of(options.flags),
    counter,
    options.tail ?? new Uint8Array(0),
  );
}

/** aaguid (zeros, as for attestation "none") || credentialIdLength || credentialId || COSE_Key */
function attestedCredentialData(credentialId: Uint8Array, cose: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(new Uint8Array(16), Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff), credentialId, cose);
}

const clientDataJSON = (fields: Record<string, unknown>) => encoder.encode(JSON.stringify(fields));

async function registration(
  key: TestKey,
  options: {
    client?: Record<string, unknown>;
    rpId?: string;
    flags?: number;
    signCount?: number;
    /** Replaces everything after the 37-byte header. */
    tail?: (credentialId: Uint8Array) => Uint8Array;
    attestationObject?: (authData: Uint8Array) => Uint8Array;
  } = {},
) {
  const challenge = createSlotlockPasskeyChallenge();
  const credentialId = globalThis.crypto.getRandomValues(new Uint8Array(20));
  const authData = await authenticatorData({
    ...(options.rpId ? { rpId: options.rpId } : {}),
    flags: options.flags ?? UP | UV | AT,
    signCount: options.signCount ?? 0,
    tail: options.tail?.(credentialId) ?? attestedCredentialData(credentialId, key.cose),
  });
  const attestationObject =
    options.attestationObject?.(authData) ??
    cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
  return {
    credentialId,
    input: {
      attestationObject: b64(attestationObject),
      clientDataJSON: b64(
        clientDataJSON({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false, ...options.client }),
      ),
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      rpId: RP_ID,
    },
  };
}

async function assertion(
  key: TestKey,
  options: {
    client?: Record<string, unknown>;
    rpId?: string;
    flags?: number;
    signCount?: number;
    tail?: Uint8Array;
    raw?: boolean;
  } = {},
) {
  const challenge = createSlotlockPasskeyChallenge();
  const client = clientDataJSON({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false, ...options.client });
  const authData = await authenticatorData({
    ...(options.rpId ? { rpId: options.rpId } : {}),
    flags: options.flags ?? UP | UV,
    signCount: options.signCount ?? 7,
    ...(options.tail ? { tail: options.tail } : {}),
  });
  const signed = concat(authData, await sha256(client));
  const signature = options.raw ? await key.signRaw(signed) : await key.sign(signed);
  return {
    authenticatorData: b64(authData),
    clientDataJSON: b64(client),
    signature: b64(signature),
    expectedChallenge: challenge,
    expectedOrigin: ORIGIN,
    rpId: RP_ID,
    publicKey: key.cose as Uint8Array,
    algorithm: key.algorithm,
  };
}

/** The base64url string with its bytes changed by `change`. */
function tamper(text: string, change: (bytes: Uint8Array) => Uint8Array | void): string {
  const bytes = unb64(text);
  return b64(change(bytes) ?? bytes);
}

async function refused(promise: Promise<unknown>): Promise<SlotlockPasskeyError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SlotlockPasskeyError);
  return error as SlotlockPasskeyError;
}

const refusal = async (promise: Promise<unknown>): Promise<string> => (await refused(promise)).code;

describe('base64url and challenges', () => {
  it('makes 32-byte random challenges, base64url without padding', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const challenge = createSlotlockPasskeyChallenge();
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(unb64(challenge)).toHaveLength(32);
      seen.add(challenge);
    }
    expect(seen.size).toBe(50);
  });

  it('round-trips every length and accepts padding', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
      const text = base64urlEncode(bytes);
      expect(text).toBe(b64(bytes));
      expect(base64urlDecode(text)).toEqual(bytes);
      expect(base64urlDecode(Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_'))).toEqual(bytes);
    }
  });

  it('refuses anything that is not one canonical base64url spelling', () => {
    for (const text of ['ab+c', 'ab/c', 'ab c', 'abc=d', 'ab=', 'a===', 'abcde', 'AB', 'AAB=', 'abc\n']) {
      expect(() => base64urlDecode(text), text).toThrow(SlotlockPasskeyError);
    }
  });
});

describe('CBOR decoder', () => {
  it('decodes what WebAuthn uses and says how many bytes it read', () => {
    const encoded = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], [-2, Uint8Array.of(1, 2)], [1, [true, false, null, 4294967295]]]));
    const { value, bytesRead } = decodeSlotlockCbor(concat(encoded, Uint8Array.of(0x00, 0x01)));
    expect(bytesRead).toBe(encoded.length);
    expect(value).toEqual(new Map<unknown, unknown>([['fmt', 'none'], [-2, Uint8Array.of(1, 2)], [1, [true, false, null, 4294967295]]]));
    // 8-byte arguments, up to 2^53 - 1.
    expect(decodeSlotlockCbor(Uint8Array.of(0x1b, 0, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)).value).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ['an indefinite-length map', [0xbf, 0x61, 0x61, 0x01, 0xff], /indefinite/],
    ['an indefinite-length array', [0x9f, 0x01, 0xff], /indefinite/],
    ['an indefinite-length byte string', [0x5f, 0x41, 0x01, 0xff], /indefinite/],
    ['a lone break', [0xff], /break/],
    ['a tag', [0xc0, 0x60], /tags/],
    ['a float', [0xf9, 0x3c, 0x00], /float/],
    ['undefined', [0xf7], /simple value/],
    ['reserved additional information', [0x1c], /reserved/],
    ['an integer beyond 2^53', [0x1b, 0, 0x20, 0, 0, 0, 0, 0, 0], /2\^53/],
    ['a length beyond the input', [0x5a, 0xff, 0xff, 0xff, 0xff, 0x00], /longer than the input/],
    ['an array count beyond the input', [0x9b, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff], /longer than the input/],
    ['a map count beyond the input', [0xa2, 0x01, 0x01], /longer than the input/],
    ['a truncated argument', [0x19, 0x01], /truncated/],
    ['a truncated array', [0x82, 0x41, 0x00], /truncated/],
    ['text that is not UTF-8', [0x62, 0xc3, 0x28], /UTF-8/],
    ['a repeated map key', [0xa2, 0x01, 0x01, 0x01, 0x02], /repeated/],
    ['a byte string map key', [0xa1, 0x41, 0x00, 0x01], /map key/],
    ['empty input', [], /truncated/],
  ])('refuses %s', (_name, bytes, message) => {
    let caught: unknown = null;
    try {
      decodeSlotlockCbor(Uint8Array.from(bytes));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SlotlockPasskeyError);
    expect((caught as SlotlockPasskeyError).code).toBe('cbor');
    expect((caught as SlotlockPasskeyError).message).toMatch(message);
  });

  it('allows 16 levels of nesting and refuses a 17th', () => {
    const nested = (depth: number) => Uint8Array.from([...Array<number>(depth - 1).fill(0x81), 0x80]);
    expect(decodeSlotlockCbor(nested(16)).bytesRead).toBe(16);
    expect(() => decodeSlotlockCbor(nested(17))).toThrow(/nested too deeply/);
  });
});

describe.each([
  ['ES256', 'es256', -7],
  ['RS256', 'rs256', -257],
] as const)('%s passkey', (_name, which, algorithm) => {
  it('registers, then signs in, returning the key and the sign counts', async () => {
    const key = await keys[which];
    const created = await registration(key, { signCount: 3 });
    const registered = await verifySlotlockPasskeyRegistration(created.input);
    expect(registered.credentialId).toEqual(created.credentialId);
    expect(registered.publicKey).toEqual(key.cose);
    expect(registered.algorithm).toBe(algorithm);
    expect(registered.signCount).toBe(3);

    // Several sign-ins, so ES256 meets r and s with and without a 0x00 sign byte in their DER.
    for (let signCount = 4; signCount < 12; signCount += 1) {
      const input = await assertion(key, { signCount });
      const verified = await verifySlotlockPasskeyAssertion({
        ...input,
        publicKey: registered.publicKey,
        algorithm: registered.algorithm,
      });
      expect(verified).toEqual({ signCount });
    }
  });

  it('accepts padded base64url and a signCount of 0', async () => {
    const key = await keys[which];
    const pad = (text: string) => text + '='.repeat((4 - (text.length % 4)) % 4);
    const created = await registration(key);
    const registered = await verifySlotlockPasskeyRegistration({
      ...created.input,
      attestationObject: pad(created.input.attestationObject),
      clientDataJSON: pad(created.input.clientDataJSON),
    });
    expect(registered.signCount).toBe(0);
    const input = await assertion(key, { signCount: 0 });
    const verified = await verifySlotlockPasskeyAssertion({
      ...input,
      authenticatorData: pad(input.authenticatorData),
      signature: pad(input.signature),
      expectedChallenge: pad(input.expectedChallenge),
    });
    expect(verified.signCount).toBe(0);
  });

  it('skips authenticator extensions when ED is set', async () => {
    const key = await keys[which];
    const extensions = cbor(new Map<Cbor, Cbor>([['credProtect', 2]]));
    const created = await registration(key, {
      flags: UP | UV | AT | ED,
      tail: (credentialId) => concat(attestedCredentialData(credentialId, key.cose), extensions),
    });
    expect((await verifySlotlockPasskeyRegistration(created.input)).publicKey).toEqual(key.cose);
    const input = await assertion(key, { flags: UP | UV | ED, tail: extensions });
    expect(await verifySlotlockPasskeyAssertion(input)).toEqual({ signCount: 7 });
  });

  it('refuses a tampered signature', async () => {
    const key = await keys[which];
    const input = await assertion(key);
    // The last byte is the end of s (ES256) or of the RSA signature: still well-formed, now wrong.
    const signature = tamper(input.signature, (bytes) => {
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
    });
    expect(await refusal(verifySlotlockPasskeyAssertion({ ...input, signature }))).toBe('signature');
  });

  it('refuses tampered authenticator data', async () => {
    const key = await keys[which];
    const input = await assertion(key, { signCount: 7 });
    // A replayed response with its counter bumped past the stored one.
    const authenticatorData = tamper(input.authenticatorData, (bytes) => {
      bytes[36] = 100;
    });
    expect(await refusal(verifySlotlockPasskeyAssertion({ ...input, authenticatorData }))).toBe('signature');
  });

  it('refuses a signature for different client data', async () => {
    const key = await keys[which];
    const first = await assertion(key);
    const second = await assertion(key);
    expect(
      await refusal(verifySlotlockPasskeyAssertion({ ...second, signature: first.signature, authenticatorData: first.authenticatorData })),
    ).toBe('signature');
  });

  it('refuses an algorithm that does not match the stored key', async () => {
    const key = await keys[which];
    const input = await assertion(key);
    const other = algorithm === -7 ? -257 : -7;
    expect(await refusal(verifySlotlockPasskeyAssertion({ ...input, algorithm: other }))).toBe('algorithm');
  });
});

describe('registration refusals', () => {
  it.each([
    ['another origin', { origin: 'https://evil.example' }, 'origin'],
    ['a subdomain origin', { origin: 'https://x.admin.slotlock.example' }, 'origin'],
    ['another challenge', { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'challenge'],
    ['a challenge that is not base64url', { challenge: 'not base64!' }, 'challenge'],
    ['no challenge', { challenge: undefined }, 'challenge'],
    ['an assertion type', { type: 'webauthn.get' }, 'type'],
    ['a cross-origin frame', { crossOrigin: true }, 'origin'],
    ['a crossOrigin that is not a boolean', { crossOrigin: 'false' }, 'client_data'],
  ])('refuses %s in clientDataJSON', async (_name, client, code) => {
    const created = await registration(await keys.es256, { client });
    expect(await refusal(verifySlotlockPasskeyRegistration(created.input))).toBe(code);
  });

  it('refuses clientDataJSON that is not a JSON object', async () => {
    const created = await registration(await keys.es256);
    for (const text of ['not json', '[]', 'null', '"webauthn.create"']) {
      const clientDataJSON = b64(encoder.encode(text));
      expect(await refusal(verifySlotlockPasskeyRegistration({ ...created.input, clientDataJSON }))).toBe('client_data');
    }
    const latin1 = b64(Uint8Array.of(0x7b, 0xff, 0x7d));
    expect(await refusal(verifySlotlockPasskeyRegistration({ ...created.input, clientDataJSON: latin1 }))).toBe('client_data');
  });

  it('refuses an expected challenge too short to be one', async () => {
    const created = await registration(await keys.es256, { client: { challenge: '' } });
    expect(await refusal(verifySlotlockPasskeyRegistration({ ...created.input, expectedChallenge: '' }))).toBe('challenge');
  });

  it('refuses a credential for another RP ID', async () => {
    const created = await registration(await keys.es256, { rpId: 'slotlock.example' });
    expect(await refusal(verifySlotlockPasskeyRegistration(created.input))).toBe('rp_id');
    const ours = await registration(await keys.es256);
    expect(await refusal(verifySlotlockPasskeyRegistration({ ...ours.input, rpId: 'evil.example' }))).toBe('rp_id');
  });

  it('refuses a ceremony without user presence or user verification', async () => {
    const absent = await registration(await keys.es256, { flags: UV | AT });
    expect(await refusal(verifySlotlockPasskeyRegistration(absent.input))).toBe('user_presence');
    const unverified = await registration(await keys.es256, { flags: UP | AT });
    expect(await refusal(verifySlotlockPasskeyRegistration(unverified.input))).toBe('user_verification');
  });

  it('refuses authenticator data without attested credential data', async () => {
    const created = await registration(await keys.es256, { flags: UP | UV });
    expect(await refusal(verifySlotlockPasskeyRegistration(created.input))).toBe('attested_data');
  });

  it('refuses a credential id of 0 or more than 1023 bytes, or one longer than the data', async () => {
    const key = await keys.es256;
    for (const credentialId of [new Uint8Array(0), new Uint8Array(1024)]) {
      const created = await registration(key, { tail: () => attestedCredentialData(credentialId, key.cose) });
      expect(await refusal(verifySlotlockPasskeyRegistration(created.input))).toBe('attested_data');
    }
    const truncated = await registration(key, {
      tail: () => concat(new Uint8Array(16), Uint8Array.of(0x00, 0x40), new Uint8Array(10)),
    });
    expect(await refusal(verifySlotlockPasskeyRegistration(truncated.input))).toBe('attested_data');
  });

  it('refuses an unsupported COSE algorithm', async () => {
    // An Ed25519 key (OKP, EdDSA): valid COSE, not one we accept.
    const ed25519 = cbor(new Map<Cbor, Cbor>([[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(32)]]));
    const created = await registration(await keys.es256, { tail: (id) => attestedCredentialData(id, ed25519) });
    expect(await refusal(verifySlotlockPasskeyRegistration(created.input))).toBe('algorithm');
  });

  it('refuses malformed or unusable COSE keys', async () => {
    const key = await keys.es256;
    const ec2 = (entries: [Cbor, Cbor][]) => cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], ...entries]));
    const thirtyTwo = () => globalThis.crypto.getRandomValues(new Uint8Array(32));
    const valid = decodeSlotlockCbor(key.cose).value as Map<number, Uint8Array>;
    const bad = [
      ec2([[-2, new Uint8Array(31)], [-3, thirtyTwo()]]),
      ec2([[-2, thirtyTwo()]]),
      // 32-byte coordinates that are not a point on P-256.
      ec2([[-2, new Uint8Array(32).fill(1)], [-3, new Uint8Array(32).fill(2)]]),
      ec2([[-2, valid.get(-2) as Uint8Array], [-3, valid.get(-3) as Uint8Array], [-4, thirtyTwo()]]),
      cbor(new Map<Cbor, Cbor>([[1, 3], [3, -7], [-1, 1], [-2, thirtyTwo()], [-3, thirtyTwo()]])),
      cbor(new Map<Cbor, Cbor>([[1, 3], [3, -257], [-1, new Uint8Array(128).fill(0xff)], [-2, Uint8Array.of(1, 0, 1)]])),
      cbor(new Map<Cbor, Cbor>([[1, 3], [3, -257], [-1, new Uint8Array(256).fill(0xff)], [-2, Uint8Array.of(1)]])),
      cbor([1, 2, 3]),
    ];
    for (const cose of bad) {
      const created = await registration(key, { tail: (id) => attestedCredentialData(id, cose) });
      expect(await refusal(verifySlotlockPasskeyRegistration(created.input))).toBe('cose');
    }
  });

  it('refuses bytes after the COSE key, the extensions or the attestation object', async () => {
    const key = await keys.es256;
    const afterKey = await registration(key, {
      tail: (id) => concat(attestedCredentialData(id, key.cose), Uint8Array.of(0x00)),
    });
    expect(await refusal(verifySlotlockPasskeyRegistration(afterKey.input))).toBe('trailing_bytes');
    const afterExtensions = await registration(key, {
      flags: UP | UV | AT | ED,
      tail: (id) => concat(attestedCredentialData(id, key.cose), cbor(new Map()), Uint8Array.of(0x00)),
    });
    expect(await refusal(verifySlotlockPasskeyRegistration(afterExtensions.input))).toBe('trailing_bytes');
    const afterObject = await registration(key);
    const attestationObject = b64(concat(unb64(afterObject.input.attestationObject), Uint8Array.of(0xf6)));
    expect(await refusal(verifySlotlockPasskeyRegistration({ ...afterObject.input, attestationObject }))).toBe('trailing_bytes');
  });

  it('refuses ED set without an extensions map', async () => {
    const key = await keys.es256;
    const missing = await registration(key, { flags: UP | UV | AT | ED });
    expect(await refusal(verifySlotlockPasskeyRegistration(missing.input))).toBe('cbor');
    const notMap = await registration(key, {
      flags: UP | UV | AT | ED,
      tail: (id) => concat(attestedCredentialData(id, key.cose), cbor([1])),
    });
    expect(await refusal(verifySlotlockPasskeyRegistration(notMap.input))).toBe('authenticator_data');
  });

  it('refuses an indefinite-length attestation object', async () => {
    const created = await registration(await keys.es256, {
      attestationObject: (authData) =>
        concat(Uint8Array.of(0xbf), cbor('fmt'), cbor('none'), cbor('attStmt'), cbor(new Map()), cbor('authData'), cbor(authData), Uint8Array.of(0xff)),
    });
    expect(await refusal(verifySlotlockPasskeyRegistration(created.input))).toBe('cbor');
  });

  it('refuses an indefinite-length COSE key', async () => {
    const key = await keys.es256;
    const definite = key.cose;
    // Same entries, but opened with 0xbf and closed with a break.
    const indefinite = concat(Uint8Array.of(0xbf), definite.subarray(1), Uint8Array.of(0xff));
    const created = await registration(key, { tail: (id) => attestedCredentialData(id, indefinite) });
    expect(await refusal(verifySlotlockPasskeyRegistration(created.input))).toBe('cbor');
  });

  it('refuses an attestation object without fmt, attStmt or authData', async () => {
    const shapes: ((authData: Uint8Array) => Cbor)[] = [
      (authData) => new Map<Cbor, Cbor>([['attStmt', new Map()], ['authData', authData]]),
      (authData) => new Map<Cbor, Cbor>([['fmt', 'none'], ['authData', authData]]),
      () => new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()]]),
      (authData) => new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', b64(authData)]]),
      (authData) => [authData],
    ];
    for (const shape of shapes) {
      const created = await registration(await keys.es256, { attestationObject: (authData) => cbor(shape(authData)) });
      expect(await refusal(verifySlotlockPasskeyRegistration(created.input))).toBe('attestation_object');
    }
  });

  it('accepts any attestation format, as it does not verify the statement', async () => {
    const created = await registration(await keys.es256, {
      attestationObject: (authData) =>
        cbor(new Map<Cbor, Cbor>([['fmt', 'packed'], ['attStmt', new Map<Cbor, Cbor>([['alg', -7], ['sig', new Uint8Array(70)]])], ['authData', authData]])),
    });
    expect((await verifySlotlockPasskeyRegistration(created.input)).algorithm).toBe(-7);
  });

  it('refuses input that is not base64url', async () => {
    const created = await registration(await keys.es256);
    expect(await refusal(verifySlotlockPasskeyRegistration({ ...created.input, attestationObject: 'a+b/' }))).toBe('encoding');
  });
});

describe('assertion refusals', () => {
  it.each([
    ['another origin', { origin: 'http://admin.slotlock.example' }, 'origin'],
    ['another challenge', { challenge: createSlotlockPasskeyChallenge() }, 'challenge'],
    ['a registration type', { type: 'webauthn.create' }, 'type'],
    ['a cross-origin frame', { crossOrigin: true }, 'origin'],
  ])('refuses %s in clientDataJSON', async (_name, client, code) => {
    const input = await assertion(await keys.es256, { client });
    expect(await refusal(verifySlotlockPasskeyAssertion(input))).toBe(code);
  });

  it('refuses a credential for another RP ID', async () => {
    const input = await assertion(await keys.es256, { rpId: 'evil.example' });
    expect(await refusal(verifySlotlockPasskeyAssertion(input))).toBe('rp_id');
  });

  it('refuses a sign-in without user presence or user verification', async () => {
    const key = await keys.es256;
    expect(await refusal(verifySlotlockPasskeyAssertion(await assertion(key, { flags: UV })))).toBe('user_presence');
    expect(await refusal(verifySlotlockPasskeyAssertion(await assertion(key, { flags: UP })))).toBe('user_verification');
  });

  it('refuses short authenticator data, attested data, and trailing bytes', async () => {
    const key = await keys.es256;
    const input = await assertion(key);
    const short = b64(unb64(input.authenticatorData).subarray(0, 36));
    expect(await refusal(verifySlotlockPasskeyAssertion({ ...input, authenticatorData: short }))).toBe('authenticator_data');
    expect(await refusal(verifySlotlockPasskeyAssertion(await assertion(key, { flags: UP | UV | AT })))).toBe('attested_data');
    expect(await refusal(verifySlotlockPasskeyAssertion(await assertion(key, { tail: Uint8Array.of(0) })))).toBe('trailing_bytes');
  });

  it('refuses a stored key with bytes after it', async () => {
    const input = await assertion(await keys.es256);
    const publicKey = concat(input.publicKey, Uint8Array.of(0x00));
    expect(await refusal(verifySlotlockPasskeyAssertion({ ...input, publicKey }))).toBe('trailing_bytes');
  });

  it("refuses WebCrypto's raw r || s, which no authenticator sends", async () => {
    const input = await assertion(await keys.es256, { raw: true });
    const error = await refused(verifySlotlockPasskeyAssertion(input));
    expect(error.code).toBe('signature');
    expect(error.message).toMatch(/DER/);
  });

  it.each([
    ['a SET instead of a SEQUENCE', [0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]],
    ['a SEQUENCE length that disagrees', [0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]],
    ['a long-form length', [0x30, 0x81, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]],
    ['a BIT STRING instead of an INTEGER', [0x30, 0x06, 0x03, 0x01, 0x01, 0x02, 0x01, 0x01]],
    ['a negative INTEGER', [0x30, 0x06, 0x02, 0x01, 0x81, 0x02, 0x01, 0x01]],
    ['a zero-length INTEGER', [0x30, 0x05, 0x02, 0x00, 0x02, 0x01, 0x01]],
    ['an INTEGER of zero', [0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01]],
    ['an INTEGER wider than 32 bytes', [0x30, 0x26, 0x02, 0x21, 0x01, ...Array<number>(32).fill(1), 0x02, 0x01, 0x01]],
    ['an INTEGER running past the end', [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x05, 0x01]],
    ['a third element', [0x30, 0x09, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]],
    ['one INTEGER', [0x30, 0x03, 0x02, 0x01, 0x01]],
    ['nothing', []],
  ])('refuses malformed DER: %s', async (_name, der) => {
    const input = await assertion(await keys.es256);
    const signature = b64(Uint8Array.from(der));
    const error = await refused(verifySlotlockPasskeyAssertion({ ...input, signature }));
    expect(error.code).toBe('signature');
    // Refused by the DER parser itself, not only because the result failed to verify.
    expect(error.message).toMatch(/DER/);
  });
});
