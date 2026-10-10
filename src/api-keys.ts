// API keys: per-tenant bearer credentials a person creates, scopes and revokes for MCP and A2A
// clients. A key is shown once, when it is created; the database keeps only its SHA-256 digest, so
// neither a backup nor a statement log holds a usable credential. An unsalted digest is safe to look
// a key up by because the key is about 238 random bits, not a password a person chose.
//
// The serving role reaches slotlock.api_keys only through the schema's SECURITY DEFINER functions
// (ddl.ts). It can create, list and revoke a tenant's keys and resolve a presented digest; it cannot
// read a digest, revive a revoked key or move a key to another tenant.
import { createHash, randomBytes } from 'node:crypto';
import type { SlotlockAgentOperation, SlotlockAgentPrincipal } from './agent-server.js';
import { SLOTLOCK_API_KEY_ACTIVE_LIMIT, SLOTLOCK_API_KEY_RETAINED_LIMIT } from './ddl.js';
import type { SlotlockSql } from './store.js';

export { SLOTLOCK_API_KEY_ACTIVE_LIMIT, SLOTLOCK_API_KEY_RETAINED_LIMIT };

/** `read` covers the operations that only look; `write` the ones that change a calendar. */
export const SLOTLOCK_API_KEY_SCOPES = Object.freeze(['read', 'write'] as const);
export type SlotlockApiKeyScope = (typeof SLOTLOCK_API_KEY_SCOPES)[number];

/** Every key starts with this, so a person or a secret scanner can tell what it is. */
export const SLOTLOCK_API_KEY_PREFIX = 'slk_';
/** The longest a key may live: ten years. A key without an expiry lives until it is revoked. */
export const SLOTLOCK_API_KEY_MAX_LIFETIME_DAYS = 3_650;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 40 base62 characters carry about 238 random bits. */
const RANDOM_CHARACTERS = 40;
/** A 32-bit checksum fits in 6 base62 digits (62^6 > 2^32). */
const CHECKSUM_CHARACTERS = 6;
/** What lists show: the prefix and 8 random characters, enough to recognise a key, not to use it. */
const DISPLAY_CHARACTERS = SLOTLOCK_API_KEY_PREFIX.length + 8;
const KEY_PATTERN = /^slk_[0-9A-Za-z]{46}$/;
/** The largest byte below 256 that is a multiple of 62, so `byte % 62` is unbiased below it. */
const UNBIASED_BYTE_LIMIT = 248;
const MAX_NAME_CHARACTERS = 100;
const MAX_CREATOR_BYTES = 200;
/** The agent server refuses a principal whose tenant is longer. */
const MAX_TENANT_BYTES = 500;
const DAY_MS = 86_400_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The scope each operation needs. A record over every operation, so one a later release adds does
 * not compile until it is given a scope here.
 */
const OPERATION_SCOPES: Readonly<Record<SlotlockAgentOperation, SlotlockApiKeyScope>> =
  Object.freeze({
    slotlock_list_resources: 'read',
    slotlock_get_free_busy: 'read',
    slotlock_find_next_available: 'read',
    slotlock_create_event: 'write',
    slotlock_get_event: 'read',
    slotlock_list_events: 'read',
    slotlock_update_event: 'write',
    slotlock_delete_event: 'write',
  });

export function slotlockApiKeyScopeFor(operation: SlotlockAgentOperation): SlotlockApiKeyScope {
  return OPERATION_SCOPES[operation];
}

/** A key as lists show it. The key itself is never stored and so never listed. */
export interface SlotlockApiKey {
  id: string;
  tenantRef: string;
  name: string;
  /** `slk_` and the next 8 characters of the key. */
  prefix: string;
  scopes: SlotlockApiKeyScope[];
  /** Who created it, as the caller recorded it (`cli`, `github:<id>`), or null. */
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  /** When the key last authenticated, to the minute. */
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** What an active key authenticates as. */
export interface SlotlockApiKeyIdentity {
  id: string;
  tenantRef: string;
  scopes: SlotlockApiKeyScope[];
}

export interface CreateSlotlockApiKeyInput {
  tenantRef: string;
  /** What the person calls it, 1-100 characters without control characters. */
  name: string;
  scopes: readonly SlotlockApiKeyScope[];
  /** Omit for a key that lives until it is revoked. At most ten years ahead. */
  expiresAt?: Date;
  createdBy?: string;
}

export interface SlotlockApiKeyStore {
  /**
   * Create a key and return it with its listing. `key` is the only copy there will ever be: show it
   * to the person once and drop it. Fails with `api_key_limit_reached` when the tenant holds
   * SLOTLOCK_API_KEY_ACTIVE_LIMIT active keys or SLOTLOCK_API_KEY_RETAINED_LIMIT keys in all.
   */
  create(input: CreateSlotlockApiKeyInput): Promise<{ key: string; apiKey: SlotlockApiKey }>;
  /** The tenant's keys, revoked and expired ones included, newest first. */
  list(input: { tenantRef: string }): Promise<SlotlockApiKey[]>;
  /**
   * Revoke one of the tenant's keys and return it; null when the tenant has no key with that id.
   * Revoking a revoked key returns it unchanged. Nothing un-revokes a key.
   */
  revoke(input: { tenantRef: string; id: string }): Promise<SlotlockApiKey | null>;
  /** Resolve a presented key to its tenant and scopes; null unless it is active. */
  authenticate(key: string): Promise<SlotlockApiKeyIdentity | null>;
  /** Tenant erasure: delete every key the tenant holds and return how many there were. */
  erase(input: { tenantRef: string }): Promise<number>;
}

function invalid(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function assertTenantRef(tenantRef: string): void {
  if (
    typeof tenantRef !== 'string' ||
    tenantRef.length === 0 ||
    tenantRef !== tenantRef.trim() ||
    Buffer.byteLength(tenantRef, 'utf8') > MAX_TENANT_BYTES ||
    hasControlCharacter(tenantRef)
  ) {
    throw invalid(
      'invalid_tenant_ref',
      `Slotlock tenant reference must be 1-${MAX_TENANT_BYTES} bytes, unpadded, without control characters`,
    );
  }
}

function canonicalScopes(scopes: readonly string[]): SlotlockApiKeyScope[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.some((scope) => !(SLOTLOCK_API_KEY_SCOPES as readonly string[]).includes(scope))
  ) {
    throw invalid(
      'invalid_api_key_scopes',
      `Slotlock API key scopes must be a non-empty list of ${SLOTLOCK_API_KEY_SCOPES.join(', ')}`,
    );
  }
  return SLOTLOCK_API_KEY_SCOPES.filter((scope) => scopes.includes(scope));
}

function randomBase62(length: number): string {
  let characters = '';
  while (characters.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < UNBIASED_BYTE_LIMIT && characters.length < length) characters += BASE62[byte % 62];
    }
  }
  return characters;
}

function checksum(random: string): string {
  let value = createHash('sha256').update(random, 'utf8').digest().readUInt32BE(0);
  let digits = '';
  for (let index = 0; index < CHECKSUM_CHARACTERS; index += 1) {
    digits = `${BASE62[value % 62]}${digits}`;
    value = Math.floor(value / 62);
  }
  return digits;
}

/** The SHA-256 of the whole key: the only form of it the database sees. */
export function slotlockApiKeyDigest(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * Whether `value` has the shape of a key and a matching checksum: `slk_`, 40 random base62
 * characters, then 6 base62 characters of the first 32 bits of their SHA-256. A scanner can verify a
 * found key offline the same way; the server refuses a mistyped one without a lookup.
 */
export function isSlotlockApiKey(value: string): boolean {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) return false;
  const start = SLOTLOCK_API_KEY_PREFIX.length;
  const random = value.slice(start, start + RANDOM_CHARACTERS);
  return value.slice(start + RANDOM_CHARACTERS) === checksum(random);
}

/** A new key with the prefix lists show and the digest the database keeps. */
export function generateSlotlockApiKey(): { key: string; prefix: string; digest: Buffer } {
  const random = randomBase62(RANDOM_CHARACTERS);
  const key = `${SLOTLOCK_API_KEY_PREFIX}${random}${checksum(random)}`;
  return { key, prefix: key.slice(0, DISPLAY_CHARACTERS), digest: slotlockApiKeyDigest(key) };
}

/** The credential of an `Authorization: Bearer <credential>` header, or undefined. */
export function slotlockBearerCredential(request: Request): string | undefined {
  return /^Bearer +(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
}

interface ApiKeyRow {
  key_id: string;
  key_tenant_ref: string;
  key_name: string;
  key_prefix: string;
  key_scopes: string[];
  key_created_by: string | null;
  key_created_at: Date;
  key_expires_at: Date | null;
  key_last_used_at: Date | null;
  key_revoked_at: Date | null;
}

const knownScopes = (scopes: readonly string[]): SlotlockApiKeyScope[] =>
  SLOTLOCK_API_KEY_SCOPES.filter((scope) => scopes.includes(scope));

function apiKeyFrom(row: ApiKeyRow): SlotlockApiKey {
  return {
    id: row.key_id,
    tenantRef: row.key_tenant_ref,
    name: row.key_name,
    prefix: row.key_prefix,
    scopes: knownScopes(row.key_scopes),
    createdBy: row.key_created_by,
    createdAt: row.key_created_at,
    expiresAt: row.key_expires_at,
    lastUsedAt: row.key_last_used_at,
    revokedAt: row.key_revoked_at,
  };
}

/**
 * API keys in the `slotlock` schema, through the connection's role. Every input is checked here
 * before a query runs; the functions and the table's constraints check the same rules again.
 */
export function createSlotlockApiKeyStore(sql: SlotlockSql): SlotlockApiKeyStore {
  return {
    async create(input) {
      assertTenantRef(input.tenantRef);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (
        name.length === 0 ||
        Array.from(name).length > MAX_NAME_CHARACTERS ||
        hasControlCharacter(name)
      ) {
        throw invalid(
          'invalid_api_key_name',
          `Slotlock API key name must be 1-${MAX_NAME_CHARACTERS} characters without control characters`,
        );
      }
      const scopes = canonicalScopes(input.scopes);
      const expiresAt = input.expiresAt;
      if (
        expiresAt !== undefined &&
        (!(expiresAt instanceof Date) ||
          !Number.isFinite(expiresAt.getTime()) ||
          expiresAt.getTime() <= Date.now() ||
          expiresAt.getTime() > Date.now() + SLOTLOCK_API_KEY_MAX_LIFETIME_DAYS * DAY_MS)
      ) {
        throw invalid(
          'invalid_api_key_expiry',
          `Slotlock API key expiry must be in the future and at most ${SLOTLOCK_API_KEY_MAX_LIFETIME_DAYS} days away`,
        );
      }
      const createdBy = input.createdBy;
      if (
        createdBy !== undefined &&
        (typeof createdBy !== 'string' ||
          createdBy.length === 0 ||
          Buffer.byteLength(createdBy, 'utf8') > MAX_CREATOR_BYTES ||
          hasControlCharacter(createdBy))
      ) {
        throw invalid(
          'invalid_api_key_creator',
          `Slotlock API key creator must be 1-${MAX_CREATOR_BYTES} bytes without control characters`,
        );
      }
      const { key, prefix, digest } = generateSlotlockApiKey();
      // Scopes travel as one string: postgres.js binds `sql.array` as text[] only once the pool
      // has fetched the server's array types, which the first query on a new pool precedes.
      const [row] = await sql<ApiKeyRow[]>`
        SELECT * FROM slotlock.create_api_key(
          ${input.tenantRef}::text,
          ${name}::text,
          ${prefix}::text,
          ${digest}::bytea,
          pg_catalog.string_to_array(${scopes.join(',')}::text, ','),
          ${expiresAt ?? null}::timestamptz,
          ${createdBy ?? null}::text
        )`;
      if (!row) {
        throw invalid(
          'api_key_limit_reached',
          `Slotlock allows ${SLOTLOCK_API_KEY_ACTIVE_LIMIT} active and ${SLOTLOCK_API_KEY_RETAINED_LIMIT} kept API keys per tenant; revoke one first`,
        );
      }
      return { key, apiKey: apiKeyFrom(row) };
    },

    async list({ tenantRef }) {
      assertTenantRef(tenantRef);
      const rows = await sql<ApiKeyRow[]>`
        SELECT * FROM slotlock.list_api_keys(${tenantRef}::text)`;
      return rows.map(apiKeyFrom);
    },

    async revoke({ tenantRef, id }) {
      assertTenantRef(tenantRef);
      if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return null;
      const [row] = await sql<ApiKeyRow[]>`
        SELECT * FROM slotlock.revoke_api_key(${tenantRef}::text, ${id}::uuid)`;
      return row ? apiKeyFrom(row) : null;
    },

    async authenticate(key) {
      if (!isSlotlockApiKey(key)) return null;
      const [row] = await sql<{ key_id: string; key_tenant_ref: string; key_scopes: string[] }[]>`
        SELECT * FROM slotlock.authenticate_api_key(${slotlockApiKeyDigest(key)}::bytea)`;
      if (!row) return null;
      return { id: row.key_id, tenantRef: row.key_tenant_ref, scopes: knownScopes(row.key_scopes) };
    },

    async erase({ tenantRef }) {
      assertTenantRef(tenantRef);
      const [row] = await sql<{ erased: string }[]>`
        SELECT slotlock.erase_api_keys(${tenantRef}::text) AS erased`;
      return Number(row?.erased ?? 0);
    },
  };
}

/**
 * Bearer authentication by API key: a request carrying an active key is that key's principal,
 * `api_key:<id>` in the key's own tenant with its scopes, for `authorize` to check. A value that is
 * not a well-formed key is anonymous without a lookup.
 */
export function createSlotlockApiKeyAuthenticator(
  keys: Pick<SlotlockApiKeyStore, 'authenticate'>,
): (request: Request) => Promise<SlotlockAgentPrincipal | null> {
  return async (request) => {
    const presented = slotlockBearerCredential(request);
    if (presented === undefined || !isSlotlockApiKey(presented)) return null;
    const identity = await keys.authenticate(presented);
    if (!identity) return null;
    return {
      subject: `api_key:${identity.id}`,
      tenantRef: identity.tenantRef,
      scopes: identity.scopes,
    };
  };
}
