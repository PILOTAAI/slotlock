// Secrets at rest (RFC 0004 C1): provider tokens, a calendar URL that carries a token, and the
// tenant's Slotlock key are kept sealed with AES-256-GCM. Each seal names its key, so keys rotate:
// new seals use the current key and old ones open with theirs. The context (what the secret
// belongs to) is bound as associated data, so a sealed value copied to another row does not open.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SealKeys {
  /** The key new seals use. */
  current: string;
  /** Every key that may open a seal, by id: 32 bytes each. */
  keys: ReadonlyMap<string, Buffer>;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Keys from `id:base64,id:base64`, the first the current one (an environment variable, say). Each
 * must be 32 random bytes: `openssl rand -base64 32`.
 */
export function parseSealKeys(spec: string): SealKeys {
  const keys = new Map<string, Buffer>();
  let current: string | undefined;
  for (const part of spec.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const separator = part.indexOf(':');
    const id = part.slice(0, separator);
    const key = Buffer.from(part.slice(separator + 1), 'base64');
    if (separator < 1 || !KEY_ID.test(id) || key.length !== 32 || keys.has(id)) {
      throw new TypeError('Seal keys are id:base64 pairs of 32-byte keys, ids unique, separated by commas');
    }
    keys.set(id, key);
    current ??= id;
  }
  if (current === undefined) throw new TypeError('At least one seal key is needed');
  return { current, keys };
}

/** `plaintext` sealed for `context`: `v1.<key id>.<iv>.<ciphertext>.<tag>`, base64url. */
export function seal(keys: SealKeys, plaintext: string, context: string): string {
  const key = keys.keys.get(keys.current);
  if (!key) throw new TypeError('The current seal key is missing');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', keys.current, iv, ciphertext, cipher.getAuthTag()]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** What `seal` sealed for `context`. Throws when it was sealed for another, altered, or its key is gone. */
export function open(keys: SealKeys, sealed: string, context: string): string {
  const [version, keyId, iv, ciphertext, tag, ...rest] = sealed.split('.');
  const key = keyId === undefined ? undefined : keys.keys.get(keyId);
  if (version !== 'v1' || !key || iv === undefined || ciphertext === undefined || tag === undefined || rest.length > 0) {
    throw new TypeError('Not a seal these keys open');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
