// What the sync keeps, in its own schema (`slotlock_sync`), apart from Slotlock's (RFC 0004 D1):
// each tenant's Slotlock key, each connected account, which calendar feeds which resource, the
// bookings written back, how far it read the change feed, and the OAuth flows under way. Secrets
// are kept sealed (seal.ts); an OAuth state only as its SHA-256.
import type { Sql } from 'postgres';
import type { Interval } from './slotlock-api.js';

export type SyncProviderKind = 'google' | 'microsoft' | 'ics';

export interface SyncTenant {
  tenantRef: string;
  /** The tenant's Slotlock admin key, sealed for `tenant:<tenantRef>`. */
  sealedApiKey: string;
  /** Where its change feed was read to, for write-back. */
  cursor: string | null;
}

export interface SyncConnection {
  id: string;
  tenantRef: string;
  provider: SyncProviderKind;
  /** Whose calendar it is, for people to tell connections apart (an address, or the URL's host). */
  account: string;
  /** Its secret, sealed for its tenant and id: OAuth tokens as JSON, or an iCalendar URL. */
  sealed: string;
  /** Write confirmed bookings back to the calendar (Google and Microsoft only). */
  writeBack: boolean;
  createdAt?: Date;
}

export interface SyncMapping {
  id: string;
  tenantRef: string;
  connectionId: string;
  /** The provider's calendar (`primary`, an id, or a mailbox address); `feed` for iCalendar. */
  calendarId: string;
  resourceId: string;
  /** The coverage source it records as on the resource, unique there. */
  source: string;
  /** The last coverage revision recorded; 0 before the first. */
  revision: number;
  lastSyncedAt: Date | null;
  lastError: string | null;
  /** Not to be read before this: the provider asked to wait, or reads keep failing. */
  retryAt: Date | null;
  /** Failed reads in a row, for backing off. */
  failures: number;
}

/** A booking written to a mapped calendar: where, and at what time, so the sync knows its own. */
export interface SyncWriteBack {
  mappingId: string;
  /** `reservation:<id>` or `event:<id>`. */
  bookingKey: string;
  /** A reservation's reference, for reporting it; null for an event. */
  bookingRef: string | null;
  providerEventId: string;
  start: Date;
  end: Date;
  /** What was last reported of it changed in the calendar (so it is reported once); null in step. */
  drift: string | null;
}

/** An OAuth flow under way: kept until the person comes back, at most ten minutes. */
export interface SyncOAuthState {
  /** SHA-256 of the state sent to the provider, hex. */
  stateHash: string;
  tenantRef: string;
  provider: 'google' | 'microsoft';
  /** The PKCE verifier, sealed for `oauth:<stateHash>`. */
  sealedVerifier: string;
  writeBack: boolean;
  /**
   * SHA-256 (hex) of the secret the browser that started the flow was given in a cookie: the
   * flow is finished only in that browser.
   */
  browserHash: string;
  expiresAt: Date;
}

export interface SyncStore {
  putTenant(tenant: SyncTenant): Promise<void>;
  getTenant(tenantRef: string): Promise<SyncTenant | null>;
  listTenants(): Promise<SyncTenant[]>;
  setCursor(tenantRef: string, cursor: string | null): Promise<void>;
  putConnection(connection: SyncConnection): Promise<void>;
  /**
   * Keep a connection's tokens sealed anew (a refresh), only while it is still there: false for
   * one disconnected meanwhile, which stays gone.
   */
  resealConnection(id: string, sealed: string): Promise<boolean>;
  getConnection(id: string): Promise<SyncConnection | null>;
  listConnections(tenantRef: string): Promise<SyncConnection[]>;
  /** Forget a connection, its mappings and what they wrote back. */
  deleteConnection(id: string): Promise<boolean>;
  putMapping(mapping: SyncMapping): Promise<void>;
  getMapping(id: string): Promise<SyncMapping | null>;
  listMappings(filter?: { tenantRef?: string; resourceId?: string; connectionId?: string }): Promise<SyncMapping[]>;
  recordSync(
    mappingId: string,
    result: { revision?: number; at: Date; error: string | null; retryAt?: Date | null; failures?: number },
  ): Promise<void>;
  getWriteBack(mappingId: string, bookingKey: string): Promise<SyncWriteBack | null>;
  putWriteBack(writeBack: SyncWriteBack): Promise<void>;
  deleteWriteBack(mappingId: string, bookingKey: string): Promise<void>;
  /** The write-backs of a mapping that meet `window`, or all of them without one. */
  listWriteBacks(mappingId: string, window?: Interval): Promise<SyncWriteBack[]>;
  putOAuthState(state: SyncOAuthState): Promise<void>;
  /** Take a flow's state once: deleted as it is read; null when unknown or expired. */
  takeOAuthState(stateHash: string, now: Date): Promise<SyncOAuthState | null>;
  /** Use a connect link once: true the first time its id is claimed, false after. */
  claimLink(linkId: string, expiresAt: Date): Promise<boolean>;
}

/** A store in memory, for tests and a single process that may forget. */
export function createMemorySyncStore(): SyncStore {
  const tenants = new Map<string, SyncTenant>();
  const connections = new Map<string, SyncConnection>();
  const mappings = new Map<string, SyncMapping>();
  const writeBacks = new Map<string, SyncWriteBack>();
  const states = new Map<string, SyncOAuthState>();
  const usedLinks = new Set<string>();
  const key = (mappingId: string, bookingKey: string) => `${mappingId}\n${bookingKey}`;
  const copy = <T extends object>(value: T | undefined): T | null => (value ? { ...value } : null);
  return {
    async putTenant(tenant) {
      tenants.set(tenant.tenantRef, { ...tenant });
    },
    async getTenant(tenantRef) {
      return copy(tenants.get(tenantRef));
    },
    async listTenants() {
      return [...tenants.values()].map((tenant) => ({ ...tenant }));
    },
    async setCursor(tenantRef, cursor) {
      const tenant = tenants.get(tenantRef);
      if (tenant) tenant.cursor = cursor;
    },
    async putConnection(connection) {
      connections.set(connection.id, { ...connection, createdAt: connection.createdAt ?? new Date() });
    },
    async resealConnection(id, sealed) {
      const connection = connections.get(id);
      if (!connection) return false;
      connections.set(id, { ...connection, sealed });
      return true;
    },
    async getConnection(id) {
      return copy(connections.get(id));
    },
    async listConnections(tenantRef) {
      return [...connections.values()].filter((connection) => connection.tenantRef === tenantRef).map((connection) => ({ ...connection }));
    },
    async deleteConnection(id) {
      for (const mapping of [...mappings.values()].filter((each) => each.connectionId === id)) {
        mappings.delete(mapping.id);
        for (const [entry, writeBack] of writeBacks) if (writeBack.mappingId === mapping.id) writeBacks.delete(entry);
      }
      return connections.delete(id);
    },
    async putMapping(mapping) {
      mappings.set(mapping.id, { ...mapping });
    },
    async getMapping(id) {
      return copy(mappings.get(id));
    },
    async listMappings(filter = {}) {
      return [...mappings.values()]
        .filter((mapping) => filter.tenantRef === undefined || mapping.tenantRef === filter.tenantRef)
        .filter((mapping) => filter.resourceId === undefined || mapping.resourceId === filter.resourceId)
        .filter((mapping) => filter.connectionId === undefined || mapping.connectionId === filter.connectionId)
        .map((mapping) => ({ ...mapping }));
    },
    async recordSync(mappingId, result) {
      const mapping = mappings.get(mappingId);
      if (!mapping) return;
      if (result.revision !== undefined) mapping.revision = result.revision;
      mapping.lastSyncedAt = result.at;
      mapping.lastError = result.error;
      if (result.retryAt !== undefined) mapping.retryAt = result.retryAt;
      if (result.failures !== undefined) mapping.failures = result.failures;
    },
    async getWriteBack(mappingId, bookingKey) {
      return copy(writeBacks.get(key(mappingId, bookingKey)));
    },
    async putWriteBack(writeBack) {
      writeBacks.set(key(writeBack.mappingId, writeBack.bookingKey), { ...writeBack });
    },
    async deleteWriteBack(mappingId, bookingKey) {
      writeBacks.delete(key(mappingId, bookingKey));
    },
    async listWriteBacks(mappingId, window) {
      return [...writeBacks.values()]
        .filter((writeBack) => writeBack.mappingId === mappingId)
        .filter((writeBack) => !window || (writeBack.start < window.end && writeBack.end > window.start))
        .map((writeBack) => ({ ...writeBack }));
    },
    async putOAuthState(state) {
      states.set(state.stateHash, { ...state });
    },
    async takeOAuthState(stateHash, now) {
      const state = states.get(stateHash);
      states.delete(stateHash);
      return state && state.expiresAt > now ? { ...state } : null;
    },
    async claimLink(linkId) {
      if (usedLinks.has(linkId)) return false;
      usedLinks.add(linkId);
      return true;
    },
  };
}

/** The schema the Postgres store keeps: run it as the schema's owner, once per release. */
export const SLOTLOCK_SYNC_DDL = `
CREATE SCHEMA IF NOT EXISTS slotlock_sync;
CREATE TABLE IF NOT EXISTS slotlock_sync.tenants (
  tenant_ref text PRIMARY KEY CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500),
  sealed_api_key text NOT NULL,
  cursor text
);
CREATE TABLE IF NOT EXISTS slotlock_sync.connections (
  id uuid PRIMARY KEY,
  tenant_ref text NOT NULL REFERENCES slotlock_sync.tenants (tenant_ref) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft', 'ics')),
  account text NOT NULL CHECK (char_length(account) BETWEEN 1 AND 320),
  sealed text NOT NULL,
  write_back boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connections_tenant_idx ON slotlock_sync.connections (tenant_ref);
CREATE TABLE IF NOT EXISTS slotlock_sync.mappings (
  id uuid PRIMARY KEY,
  tenant_ref text NOT NULL,
  connection_id uuid NOT NULL REFERENCES slotlock_sync.connections (id) ON DELETE CASCADE,
  calendar_id text NOT NULL CHECK (char_length(calendar_id) BETWEEN 1 AND 2048),
  resource_id uuid NOT NULL,
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 200),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_synced_at timestamptz,
  last_error text,
  retry_at timestamptz,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  UNIQUE (tenant_ref, resource_id, source)
);
CREATE INDEX IF NOT EXISTS mappings_resource_idx ON slotlock_sync.mappings (tenant_ref, resource_id);
CREATE INDEX IF NOT EXISTS mappings_connection_idx ON slotlock_sync.mappings (connection_id);
CREATE TABLE IF NOT EXISTS slotlock_sync.write_backs (
  mapping_id uuid NOT NULL REFERENCES slotlock_sync.mappings (id) ON DELETE CASCADE,
  booking_key text NOT NULL CHECK (char_length(booking_key) BETWEEN 1 AND 600),
  booking_ref text,
  provider_event_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  drift text,
  PRIMARY KEY (mapping_id, booking_key)
);
CREATE INDEX IF NOT EXISTS write_backs_time_idx ON slotlock_sync.write_backs (mapping_id, starts_at, ends_at);
CREATE TABLE IF NOT EXISTS slotlock_sync.oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  tenant_ref text NOT NULL REFERENCES slotlock_sync.tenants (tenant_ref) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  sealed_verifier text NOT NULL,
  write_back boolean NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON slotlock_sync.oauth_states (expires_at);
-- The browser a flow was started in: it is finished only there.
ALTER TABLE slotlock_sync.oauth_states ADD COLUMN IF NOT EXISTS browser_hash text NOT NULL DEFAULT '';
-- Connect links used: each is followed once.
CREATE TABLE IF NOT EXISTS slotlock_sync.used_links (
  link_id text PRIMARY KEY CHECK (link_id ~ '^[A-Za-z0-9_-]{16,64}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS used_links_expiry_idx ON slotlock_sync.used_links (expires_at);
`;

/** A store in PostgreSQL (postgres.js), in schema slotlock_sync: apply SLOTLOCK_SYNC_DDL first. */
export function createPostgresSyncStore(sql: Sql): SyncStore & { applySchema(): Promise<void> } {
  type MappingRow = {
    id: string;
    tenant_ref: string;
    connection_id: string;
    calendar_id: string;
    resource_id: string;
    source: string;
    revision: string | number;
    last_synced_at: Date | null;
    last_error: string | null;
    retry_at: Date | null;
    failures: number;
  };
  const mapping = (row: MappingRow): SyncMapping => ({
    id: row.id,
    tenantRef: row.tenant_ref,
    connectionId: row.connection_id,
    calendarId: row.calendar_id,
    resourceId: row.resource_id,
    source: row.source,
    revision: Number(row.revision),
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    retryAt: row.retry_at,
    failures: Number(row.failures),
  });
  const MAPPING_COLUMNS = sql.unsafe(
    'id, tenant_ref, connection_id, calendar_id, resource_id, source, revision, last_synced_at, last_error, retry_at, failures',
  );
  type WriteBackRow = {
    mapping_id: string;
    booking_key: string;
    booking_ref: string | null;
    provider_event_id: string;
    starts_at: Date;
    ends_at: Date;
    drift: string | null;
  };
  const writeBack = (row: WriteBackRow): SyncWriteBack => ({
    mappingId: row.mapping_id,
    bookingKey: row.booking_key,
    bookingRef: row.booking_ref,
    providerEventId: row.provider_event_id,
    start: row.starts_at,
    end: row.ends_at,
    drift: row.drift,
  });
  const WRITE_BACK_COLUMNS = sql.unsafe('mapping_id, booking_key, booking_ref, provider_event_id, starts_at, ends_at, drift');
  type TenantRow = { tenant_ref: string; sealed_api_key: string; cursor: string | null };
  const tenant = (row: TenantRow): SyncTenant => ({ tenantRef: row.tenant_ref, sealedApiKey: row.sealed_api_key, cursor: row.cursor });
  type ConnectionRow = {
    id: string;
    tenant_ref: string;
    provider: SyncProviderKind;
    account: string;
    sealed: string;
    write_back: boolean;
    created_at: Date;
  };
  const connection = (row: ConnectionRow): SyncConnection => ({
    id: row.id,
    tenantRef: row.tenant_ref,
    provider: row.provider,
    account: row.account,
    sealed: row.sealed,
    writeBack: row.write_back,
    createdAt: row.created_at,
  });
  return {
    async applySchema() {
      await sql.unsafe(SLOTLOCK_SYNC_DDL);
    },
    async putTenant(value) {
      await sql`
        INSERT INTO slotlock_sync.tenants (tenant_ref, sealed_api_key, cursor)
        VALUES (${value.tenantRef}, ${value.sealedApiKey}, ${value.cursor})
        ON CONFLICT (tenant_ref) DO UPDATE SET sealed_api_key = EXCLUDED.sealed_api_key, cursor = EXCLUDED.cursor`;
    },
    async getTenant(tenantRef) {
      const [row] = await sql<TenantRow[]>`SELECT tenant_ref, sealed_api_key, cursor FROM slotlock_sync.tenants WHERE tenant_ref = ${tenantRef}`;
      return row ? tenant(row) : null;
    },
    async listTenants() {
      return (await sql<TenantRow[]>`SELECT tenant_ref, sealed_api_key, cursor FROM slotlock_sync.tenants ORDER BY tenant_ref`).map(tenant);
    },
    async setCursor(tenantRef, cursor) {
      await sql`UPDATE slotlock_sync.tenants SET cursor = ${cursor} WHERE tenant_ref = ${tenantRef}`;
    },
    async putConnection(value) {
      await sql`
        INSERT INTO slotlock_sync.connections (id, tenant_ref, provider, account, sealed, write_back)
        VALUES (${value.id}, ${value.tenantRef}, ${value.provider}, ${value.account}, ${value.sealed}, ${value.writeBack})
        ON CONFLICT (id) DO UPDATE SET account = EXCLUDED.account, sealed = EXCLUDED.sealed, write_back = EXCLUDED.write_back`;
    },
    async resealConnection(id, sealed) {
      const updated = await sql`UPDATE slotlock_sync.connections SET sealed = ${sealed} WHERE id = ${id} RETURNING id`;
      return updated.length === 1;
    },
    async getConnection(id) {
      const [row] = await sql<ConnectionRow[]>`
        SELECT id, tenant_ref, provider, account, sealed, write_back, created_at FROM slotlock_sync.connections WHERE id = ${id}`;
      return row ? connection(row) : null;
    },
    async listConnections(tenantRef) {
      return (
        await sql<ConnectionRow[]>`
          SELECT id, tenant_ref, provider, account, sealed, write_back, created_at FROM slotlock_sync.connections
           WHERE tenant_ref = ${tenantRef} ORDER BY created_at, id`
      ).map(connection);
    },
    async deleteConnection(id) {
      const rows = await sql<{ id: string }[]>`DELETE FROM slotlock_sync.connections WHERE id = ${id} RETURNING id`;
      return rows.length > 0;
    },
    async putMapping(value) {
      await sql`
        INSERT INTO slotlock_sync.mappings (id, tenant_ref, connection_id, calendar_id, resource_id, source, revision,
                                            last_synced_at, last_error, retry_at, failures)
        VALUES (${value.id}, ${value.tenantRef}, ${value.connectionId}, ${value.calendarId}, ${value.resourceId}, ${value.source},
                ${value.revision}, ${value.lastSyncedAt}, ${value.lastError}, ${value.retryAt}, ${value.failures})
        ON CONFLICT (id) DO UPDATE SET calendar_id = EXCLUDED.calendar_id, revision = EXCLUDED.revision`;
    },
    async getMapping(id) {
      const [row] = await sql<MappingRow[]>`SELECT ${MAPPING_COLUMNS} FROM slotlock_sync.mappings WHERE id = ${id}`;
      return row ? mapping(row) : null;
    },
    async listMappings(filter = {}) {
      const rows = await sql<MappingRow[]>`
        SELECT ${MAPPING_COLUMNS} FROM slotlock_sync.mappings
         WHERE (${filter.tenantRef ?? null}::text IS NULL OR tenant_ref = ${filter.tenantRef ?? null})
           AND (${filter.resourceId ?? null}::uuid IS NULL OR resource_id = ${filter.resourceId ?? null}::uuid)
           AND (${filter.connectionId ?? null}::uuid IS NULL OR connection_id = ${filter.connectionId ?? null}::uuid)
         ORDER BY tenant_ref, id`;
      return rows.map(mapping);
    },
    async recordSync(mappingId, result) {
      await sql`
        UPDATE slotlock_sync.mappings
           SET revision = COALESCE(${result.revision ?? null}::bigint, revision),
               last_synced_at = ${result.at}, last_error = ${result.error},
               retry_at = CASE WHEN ${result.retryAt === undefined} THEN retry_at ELSE ${result.retryAt ?? null}::timestamptz END,
               failures = COALESCE(${result.failures ?? null}::int, failures)
         WHERE id = ${mappingId}`;
    },
    async getWriteBack(mappingId, bookingKey) {
      const [row] = await sql<WriteBackRow[]>`
        SELECT ${WRITE_BACK_COLUMNS} FROM slotlock_sync.write_backs WHERE mapping_id = ${mappingId} AND booking_key = ${bookingKey}`;
      return row ? writeBack(row) : null;
    },
    async putWriteBack(value) {
      await sql`
        INSERT INTO slotlock_sync.write_backs (mapping_id, booking_key, booking_ref, provider_event_id, starts_at, ends_at, drift)
        VALUES (${value.mappingId}, ${value.bookingKey}, ${value.bookingRef}, ${value.providerEventId}, ${value.start}, ${value.end}, ${value.drift})
        ON CONFLICT (mapping_id, booking_key) DO UPDATE
           SET booking_ref = EXCLUDED.booking_ref, provider_event_id = EXCLUDED.provider_event_id,
               starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, drift = EXCLUDED.drift`;
    },
    async deleteWriteBack(mappingId, bookingKey) {
      await sql`DELETE FROM slotlock_sync.write_backs WHERE mapping_id = ${mappingId} AND booking_key = ${bookingKey}`;
    },
    async listWriteBacks(mappingId, window) {
      const rows = window
        ? await sql<WriteBackRow[]>`
            SELECT ${WRITE_BACK_COLUMNS} FROM slotlock_sync.write_backs
             WHERE mapping_id = ${mappingId} AND starts_at < ${window.end} AND ends_at > ${window.start}`
        : await sql<WriteBackRow[]>`SELECT ${WRITE_BACK_COLUMNS} FROM slotlock_sync.write_backs WHERE mapping_id = ${mappingId}`;
      return rows.map(writeBack);
    },
    async putOAuthState(state) {
      // Flows long abandoned go as new ones start.
      await sql`DELETE FROM slotlock_sync.oauth_states WHERE expires_at < now()`;
      await sql`
        INSERT INTO slotlock_sync.oauth_states (state_hash, tenant_ref, provider, sealed_verifier, write_back, browser_hash, expires_at)
        VALUES (${state.stateHash}, ${state.tenantRef}, ${state.provider}, ${state.sealedVerifier}, ${state.writeBack},
                ${state.browserHash}, ${state.expiresAt})`;
    },
    async takeOAuthState(stateHash, now) {
      const [row] = await sql<
        {
          state_hash: string;
          tenant_ref: string;
          provider: 'google' | 'microsoft';
          sealed_verifier: string;
          write_back: boolean;
          browser_hash: string;
          expires_at: Date;
        }[]
      >`DELETE FROM slotlock_sync.oauth_states WHERE state_hash = ${stateHash}
        RETURNING state_hash, tenant_ref, provider, sealed_verifier, write_back, browser_hash, expires_at`;
      if (!row || row.expires_at <= now) return null;
      return {
        stateHash: row.state_hash,
        tenantRef: row.tenant_ref,
        provider: row.provider,
        sealedVerifier: row.sealed_verifier,
        writeBack: row.write_back,
        browserHash: row.browser_hash,
        expiresAt: row.expires_at,
      };
    },
    async claimLink(linkId, expiresAt) {
      await sql`DELETE FROM slotlock_sync.used_links WHERE expires_at < now()`;
      const claimed = await sql`
        INSERT INTO slotlock_sync.used_links (link_id, expires_at) VALUES (${linkId}, ${expiresAt})
        ON CONFLICT (link_id) DO NOTHING RETURNING link_id`;
      return claimed.length === 1;
    },
  };
}
