// What the sync keeps, in its own schema (`slotlock_sync`), apart from Slotlock's (RFC 0004 D1):
// each tenant's Slotlock key, each connected account, which calendar feeds which resource, the
// bookings written back, and how far it read the change feed. Secrets are kept sealed (seal.ts).
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
  /** Its secret, sealed for `connection:<id>`: OAuth tokens as JSON, or an iCalendar URL. */
  sealed: string;
  /** Write confirmed bookings back to the calendar (Google and Microsoft only). */
  writeBack: boolean;
}

export interface SyncMapping {
  id: string;
  tenantRef: string;
  connectionId: string;
  /** The provider's calendar (`primary`, an id, or a mailbox); the URL itself for iCalendar. */
  calendarId: string;
  resourceId: string;
  /** The coverage source it records as on the resource, unique there: `google:<account>/<calendar>`. */
  source: string;
  /** The last coverage revision recorded; 0 before the first. */
  revision: number;
  lastSyncedAt: Date | null;
  lastError: string | null;
}

/** A booking written to a mapped calendar: where, and at what time, so the sync knows its own. */
export interface SyncWriteBack {
  mappingId: string;
  /** `reservation:<id>` or `event:<id>`. */
  bookingKey: string;
  providerEventId: string;
  start: Date;
  end: Date;
}

export interface SyncStore {
  putTenant(tenant: SyncTenant): Promise<void>;
  getTenant(tenantRef: string): Promise<SyncTenant | null>;
  listTenants(): Promise<SyncTenant[]>;
  setCursor(tenantRef: string, cursor: string): Promise<void>;
  putConnection(connection: SyncConnection): Promise<void>;
  getConnection(id: string): Promise<SyncConnection | null>;
  /** Forget a connection, its mappings and what they wrote back. */
  deleteConnection(id: string): Promise<boolean>;
  putMapping(mapping: SyncMapping): Promise<void>;
  getMapping(id: string): Promise<SyncMapping | null>;
  listMappings(filter?: { tenantRef?: string; resourceId?: string }): Promise<SyncMapping[]>;
  recordSync(mappingId: string, result: { revision?: number; at: Date; error: string | null }): Promise<void>;
  getWriteBack(mappingId: string, bookingKey: string): Promise<SyncWriteBack | null>;
  putWriteBack(writeBack: SyncWriteBack): Promise<void>;
  deleteWriteBack(mappingId: string, bookingKey: string): Promise<void>;
  /** The write-backs of a mapping that meet `window`. */
  listWriteBacks(mappingId: string, window: Interval): Promise<SyncWriteBack[]>;
}

/** A store in memory, for tests and a single process that may forget. */
export function createMemorySyncStore(): SyncStore {
  const tenants = new Map<string, SyncTenant>();
  const connections = new Map<string, SyncConnection>();
  const mappings = new Map<string, SyncMapping>();
  const writeBacks = new Map<string, SyncWriteBack>();
  const key = (mappingId: string, bookingKey: string) => `${mappingId}\n${bookingKey}`;
  return {
    async putTenant(tenant) {
      tenants.set(tenant.tenantRef, { ...tenant });
    },
    async getTenant(tenantRef) {
      const tenant = tenants.get(tenantRef);
      return tenant ? { ...tenant } : null;
    },
    async listTenants() {
      return [...tenants.values()].map((tenant) => ({ ...tenant }));
    },
    async setCursor(tenantRef, cursor) {
      const tenant = tenants.get(tenantRef);
      if (tenant) tenant.cursor = cursor;
    },
    async putConnection(connection) {
      connections.set(connection.id, { ...connection });
    },
    async getConnection(id) {
      const connection = connections.get(id);
      return connection ? { ...connection } : null;
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
      const mapping = mappings.get(id);
      return mapping ? { ...mapping } : null;
    },
    async listMappings(filter = {}) {
      return [...mappings.values()]
        .filter((mapping) => (filter.tenantRef === undefined || mapping.tenantRef === filter.tenantRef))
        .filter((mapping) => (filter.resourceId === undefined || mapping.resourceId === filter.resourceId))
        .map((mapping) => ({ ...mapping }));
    },
    async recordSync(mappingId, result) {
      const mapping = mappings.get(mappingId);
      if (!mapping) return;
      if (result.revision !== undefined) mapping.revision = result.revision;
      mapping.lastSyncedAt = result.at;
      mapping.lastError = result.error;
    },
    async getWriteBack(mappingId, bookingKey) {
      const writeBack = writeBacks.get(key(mappingId, bookingKey));
      return writeBack ? { ...writeBack } : null;
    },
    async putWriteBack(writeBack) {
      writeBacks.set(key(writeBack.mappingId, writeBack.bookingKey), { ...writeBack });
    },
    async deleteWriteBack(mappingId, bookingKey) {
      writeBacks.delete(key(mappingId, bookingKey));
    },
    async listWriteBacks(mappingId, window) {
      return [...writeBacks.values()].filter(
        (writeBack) => writeBack.mappingId === mappingId && writeBack.start < window.end && writeBack.end > window.start,
      );
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
  UNIQUE (tenant_ref, resource_id, source)
);
CREATE INDEX IF NOT EXISTS mappings_resource_idx ON slotlock_sync.mappings (tenant_ref, resource_id);
CREATE TABLE IF NOT EXISTS slotlock_sync.write_backs (
  mapping_id uuid NOT NULL REFERENCES slotlock_sync.mappings (id) ON DELETE CASCADE,
  booking_key text NOT NULL CHECK (char_length(booking_key) BETWEEN 1 AND 600),
  provider_event_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  PRIMARY KEY (mapping_id, booking_key)
);
CREATE INDEX IF NOT EXISTS write_backs_time_idx ON slotlock_sync.write_backs (mapping_id, starts_at, ends_at);
`;

/** The few methods of a postgres.js `sql` this store calls. */
interface Sql {
  unsafe(query: string): Promise<unknown>;
  <T = Record<string, unknown>[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

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
  });
  type WriteBackRow = { mapping_id: string; booking_key: string; provider_event_id: string; starts_at: Date; ends_at: Date };
  const writeBack = (row: WriteBackRow): SyncWriteBack => ({
    mappingId: row.mapping_id,
    bookingKey: row.booking_key,
    providerEventId: row.provider_event_id,
    start: row.starts_at,
    end: row.ends_at,
  });
  type TenantRow = { tenant_ref: string; sealed_api_key: string; cursor: string | null };
  const tenant = (row: TenantRow): SyncTenant => ({ tenantRef: row.tenant_ref, sealedApiKey: row.sealed_api_key, cursor: row.cursor });
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
    async getConnection(id) {
      const [row] = await sql<
        { id: string; tenant_ref: string; provider: SyncProviderKind; account: string; sealed: string; write_back: boolean }[]
      >`SELECT id, tenant_ref, provider, account, sealed, write_back FROM slotlock_sync.connections WHERE id = ${id}`;
      return row
        ? { id: row.id, tenantRef: row.tenant_ref, provider: row.provider, account: row.account, sealed: row.sealed, writeBack: row.write_back }
        : null;
    },
    async deleteConnection(id) {
      const rows = await sql<{ id: string }[]>`DELETE FROM slotlock_sync.connections WHERE id = ${id} RETURNING id`;
      return rows.length > 0;
    },
    async putMapping(value) {
      await sql`
        INSERT INTO slotlock_sync.mappings (id, tenant_ref, connection_id, calendar_id, resource_id, source, revision, last_synced_at, last_error)
        VALUES (${value.id}, ${value.tenantRef}, ${value.connectionId}, ${value.calendarId}, ${value.resourceId}, ${value.source},
                ${value.revision}, ${value.lastSyncedAt}, ${value.lastError})
        ON CONFLICT (id) DO UPDATE SET calendar_id = EXCLUDED.calendar_id, revision = EXCLUDED.revision`;
    },
    async getMapping(id) {
      const [row] = await sql<MappingRow[]>`
        SELECT id, tenant_ref, connection_id, calendar_id, resource_id, source, revision, last_synced_at, last_error
          FROM slotlock_sync.mappings WHERE id = ${id}`;
      return row ? mapping(row) : null;
    },
    async listMappings(filter = {}) {
      const rows = await sql<MappingRow[]>`
        SELECT id, tenant_ref, connection_id, calendar_id, resource_id, source, revision, last_synced_at, last_error
          FROM slotlock_sync.mappings
         WHERE (${filter.tenantRef ?? null}::text IS NULL OR tenant_ref = ${filter.tenantRef ?? null})
           AND (${filter.resourceId ?? null}::uuid IS NULL OR resource_id = ${filter.resourceId ?? null}::uuid)
         ORDER BY tenant_ref, id`;
      return rows.map(mapping);
    },
    async recordSync(mappingId, result) {
      await sql`
        UPDATE slotlock_sync.mappings
           SET revision = COALESCE(${result.revision ?? null}::bigint, revision),
               last_synced_at = ${result.at}, last_error = ${result.error}
         WHERE id = ${mappingId}`;
    },
    async getWriteBack(mappingId, bookingKey) {
      const [row] = await sql<WriteBackRow[]>`
        SELECT mapping_id, booking_key, provider_event_id, starts_at, ends_at FROM slotlock_sync.write_backs
         WHERE mapping_id = ${mappingId} AND booking_key = ${bookingKey}`;
      return row ? writeBack(row) : null;
    },
    async putWriteBack(value) {
      await sql`
        INSERT INTO slotlock_sync.write_backs (mapping_id, booking_key, provider_event_id, starts_at, ends_at)
        VALUES (${value.mappingId}, ${value.bookingKey}, ${value.providerEventId}, ${value.start}, ${value.end})
        ON CONFLICT (mapping_id, booking_key) DO UPDATE
           SET provider_event_id = EXCLUDED.provider_event_id, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at`;
    },
    async deleteWriteBack(mappingId, bookingKey) {
      await sql`DELETE FROM slotlock_sync.write_backs WHERE mapping_id = ${mappingId} AND booking_key = ${bookingKey}`;
    },
    async listWriteBacks(mappingId, window) {
      const rows = await sql<WriteBackRow[]>`
        SELECT mapping_id, booking_key, provider_event_id, starts_at, ends_at FROM slotlock_sync.write_backs
         WHERE mapping_id = ${mappingId} AND starts_at < ${window.end} AND ends_at > ${window.start}`;
      return rows.map(writeBack);
    },
  };
}
