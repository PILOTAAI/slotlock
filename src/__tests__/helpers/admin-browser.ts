// What the admin console's end-to-end tests share (admin-console and admin-cms integration tests):
// a software passkey, a fake GitHub sign-in, and a browser that keeps cookies, passes Cloudflare
// Access and sends the console's own Origin on every POST.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { expect } from 'vitest';
import type { SlotlockAdmin } from '../../admin/app.js';

export const ORIGIN = 'https://admin.slotlock.test';
export const RP_ID = 'admin.slotlock.test';
export const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest();
export const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

// ---------- A software passkey: ES256, user verified, attestation "none" ----------
function cborHead(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 256) return [(major << 5) | 24, length];
  return [(major << 5) | 25, length >> 8, length & 0xff];
}
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;
function cbor(value: Cbor): number[] {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return [...cborHead(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...cborHead(2, value.length), ...value];
  const out = cborHead(5, value.size);
  for (const [key, item] of value) out.push(...cbor(key), ...cbor(item));
  return out;
}

export class SoftwarePasskey {
  readonly id = randomBytes(32);
  private readonly key: KeyObject;
  private readonly cose: Uint8Array;
  counter = 0;
  constructor(readonly origin = ORIGIN, readonly rpId = RP_ID) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = Uint8Array.from(
      cbor(
        new Map<number, Cbor>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x as string, 'base64url')],
          [-3, Buffer.from(jwk.y as string, 'base64url')],
        ]),
      ),
    );
  }
  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }
  private header(flags: number) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    return Buffer.concat([sha(this.rpId), Buffer.from([flags]), count]);
  }
  create(challenge: string) {
    const length = Buffer.from([this.id.length >> 8, this.id.length & 0xff]);
    const authData = Buffer.concat([this.header(0x45), Buffer.alloc(16), length, this.id, this.cose]);
    const attestation = Uint8Array.from(
      cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])),
    );
    return { id: b64u(this.id), attestationObject: b64u(attestation), clientDataJSON: b64u(this.clientData('webauthn.create', challenge)) };
  }
  get(challenge: string, { advance = true } = {}) {
    if (advance) this.counter += 1;
    const authData = this.header(0x05);
    const clientDataJSON = this.clientData('webauthn.get', challenge);
    const signature = sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), this.key);
    return { id: b64u(this.id), authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) };
  }
}


// ---------- A fake GitHub ----------
/**
 * A fake GitHub for sign-in: an OAuth code is a person's key in `people`; profiles answer by login
 * and id. Anything else it is not given answers 500, unless `other` answers it first.
 */
export function createGithubSignInFetch(
  people: Record<string, { id: number; login: string }>,
  profiles: Record<string, { id: number; login: string; type: string }>,
  other?: (input: string | URL | Request, init?: RequestInit) => Promise<Response | null>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
  const answered = other ? await other(input, init) : null;
  if (answered) return answered;
  const target = String(input instanceof Request ? input.url : input);
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (target === 'https://github.com/login/oauth/access_token') {
    const body = JSON.parse(String(init?.body)) as { code: string; code_verifier?: string; client_secret: string };
    if (body.client_secret !== 'client-secret' || !body.code_verifier) return reply({ error: 'bad_verification_code' });
    return people[body.code] ? reply({ access_token: `token-${body.code}` }) : reply({ error: 'bad_verification_code' });
  }
  if (target === 'https://api.github.com/user') {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const person = people[auth.replace('Bearer token-', '')];
    return person ? reply(person) : reply({ message: 'Bad credentials' }, 401);
  }
  const byLogin = /^https:\/\/api\.github\.com\/users\/([^/]+)$/.exec(target)?.[1];
  if (byLogin) return profiles[byLogin] ? reply(profiles[byLogin]) : reply({ message: 'Not Found' }, 404);
  const byId = /^https:\/\/api\.github\.com\/user\/(\d+)$/.exec(target)?.[1];
  if (byId) {
    const found = [...Object.values(profiles), ...Object.values(people)].find((p) => String(p.id) === byId);
    return found ? reply({ type: 'User', ...found }) : reply({ message: 'Not Found' }, 404);
  }
  return reply({ message: 'unexpected' }, 500);
}) as typeof fetch;
}

// ---------- A browser: cookies, Access, and our own origin on every POST ----------
export class Browser {
  readonly jar = new Map<string, string>();
  constructor(private readonly admin: () => SlotlockAdmin, public access = 'ok') {}
  async request(path: string, init: RequestInit & { origin?: string | null } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.access) headers.set('cf-access-jwt-assertion', this.access);
    if (this.jar.size) headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const method = init.method ?? 'GET';
    if (method === 'POST' && init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
    const response = await this.admin().fetch(new Request(`${ORIGIN}${path}`, { ...init, method, headers, redirect: 'manual' }));
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = (pair ?? '').indexOf('=');
      const name = (pair ?? '').slice(0, index);
      const value = (pair ?? '').slice(index + 1);
      if (/Max-Age=0/.test(line) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }
  json(path: string, body: unknown, extra: Record<string, string> = { 'x-slotlock-admin': '1' }) {
    return this.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  }
  /** GitHub sign-in through to the callback; returns where the console sent the browser next. */
  async signIn(code: string): Promise<Response> {
    const start = await this.request('/sign-in/github');
    expect(start.status).toBe(303);
    const authorize = new URL(start.headers.get('location') ?? '');
    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/callback`);
    expect(authorize.searchParams.has('scope')).toBe(false);
    const state = authorize.searchParams.get('state') ?? '';
    return this.request(`/callback?${new URLSearchParams({ code, state }).toString()}`);
  }
  async createPasskey(passkey: SoftwarePasskey, extra: Record<string, unknown> = {}) {
    const options = await this.json('/passkey/options', { purpose: 'create' });
    if (options.status !== 200) return options;
    const { challenge } = (await options.json()) as { challenge: string };
    return this.json('/passkey/register', { name: 'Test key', ...passkey.create(challenge), ...extra });
  }
  async usePasskey(passkey: SoftwarePasskey, advance = true) {
    const options = await this.json('/passkey/options', { purpose: 'get' });
    expect(options.status).toBe(200);
    const { challenge } = (await options.json()) as { challenge: string };
    return this.json('/passkey/verify', passkey.get(challenge, { advance }));
  }
}

