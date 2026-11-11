// Exporting a whole tenant (RFC 0004 D3) against real Postgres, over the API: asked for, built in
// the background, read part by part; every table as kept, without secrets, the tenant or anyone
// else's rows; a large table split into parts; one at a time and five kept; deleted on request, by
// expiry, and built by maintenance when its server stopped first. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer } from '../agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { maintainSlotlockTenant } from '../maintenance.js';
import { SLOTLOCK_TENANT_EXPORT_PART_ROWS, type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];

describe.skipIf(!url)('exporting a tenant (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const tenantRef = `export-${randomUUID()}`;
  const otherRef = `export-other-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    admin: { subject: 'person-admin', tenantRef, scopes: ['read', 'write', 'admin'] },
    other: { subject: 'person-other', tenantRef: otherRef, scopes: ['read', 'write', 'admin'] },
  };
  const day = Date.UTC(new Date().getUTCFullYear() + 1, 4, 5);
  const at = (hour: number) => new Date(day + hour * HOUR).toISOString();
  const call = async (method: string, path: string, body?: unknown, as = 'admin') => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${as}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const ready = async (id: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const read = await call('GET', `/v1/tenant/exports/${id}`);
      const made = read.body.export as { status: string };
      if (made.status !== 'pending') return read.body.export as Record<string, unknown> & { parts: number; status: string };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('export never finished');
  };
  const rowsOf = async (id: string, parts: number) => {
    const tables: Record<string, Record<string, unknown>[]> = {};
    const partTables: string[] = [];
    for (let part = 1; part <= parts; part++) {
      const read = await call('GET', `/v1/tenant/exports/${id}/parts/${part}`);
      expect(read.status).toBe(200);
      const table = read.body.table as string;
      partTables.push(table);
      tables[table] = [...(tables[table] ?? []), ...(read.body.rows as Record<string, unknown>[])];
    }
    return { tables, partTables };
  };

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql, { defaultAvailabilityRules: ALL_DAY });
    await store.applySchema();
    const agentBackend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => ALL_DAY });
    server = createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      backend: agentBackend,
      authenticate: async (request) => principals[request.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
      application: {
        backend: createSlotlockStoreApplicationBackend(store, { agentBackend }),
        authorize: async ({ principal }) => principal.scopes?.includes('admin') === true,
      },
    });
  });

  afterAll(async () => {
    for (const ref of [tenantRef, otherRef]) await sql`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    await sql.end();
  });

  it('exports every table as kept, in parts, without secrets, the tenant or anyone else', async () => {
    const van = ((await call('POST', '/v1/resources', { external_ref: 'van-export', timezone: 'UTC' })).body.resource as { id: string }).id;
    expect((await call('PUT', '/v1/contacts/customer-1', { email: 'ada@example.com' })).status).toBe(200);
    expect(
      (await call('PUT', '/v1/reservations/export-booking', { resource_id: van, start: at(9), end: at(10), revision: 1, contact_ref: 'customer-1' })).status,
    ).toBe(200);
    expect((await call('POST', '/v1/webhooks', { url: 'https://hooks.example.com/slotlock' })).status).toBe(200);
    // Another tenant's data, which no export of this one holds.
    expect((await call('POST', '/v1/resources', { external_ref: 'not-yours', timezone: 'UTC' }, 'other')).status).toBe(200);
    // Enough history for its table to take more than one part.
    await sql`
      INSERT INTO slotlock.outbox (tenant_ref, type, subject, data)
      SELECT ${tenantRef}, 'reservation.created', 'bulk-' || n, jsonb_build_object('n', n)
        FROM generate_series(1, ${SLOTLOCK_TENANT_EXPORT_PART_ROWS + 10}) AS n`;

    const asked = await call('POST', '/v1/tenant/exports', {});
    expect(asked.status).toBe(200);
    const pending = asked.body.export as { id: string; status: string; requested_by: string };
    expect(pending.status).toBe('pending');
    const made = await ready(pending.id);
    expect(made).toMatchObject({ status: 'ready', error: null });
    expect(made.parts).toBeGreaterThanOrEqual(5);
    const { tables, partTables } = await rowsOf(pending.id, made.parts);
    expect(made.tables).toEqual(Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length])));

    expect(tables.resources?.map((row) => row.external_ref)).toEqual(['van-export']);
    expect(tables.reservations?.map((row) => row.external_ref)).toEqual(['export-booking']);
    expect(tables.contacts?.[0]).toMatchObject({ ref: 'customer-1', email: 'ada@example.com' });
    // A webhook's address, never its signing secret.
    expect(tables.webhook_endpoints?.[0]).toMatchObject({ url: 'https://hooks.example.com/slotlock' });
    expect(tables.webhook_endpoints?.[0]).not.toHaveProperty('secret');
    expect(tables.webhook_endpoints?.[0]).not.toHaveProperty('lease_token');
    // The history, split into parts of one table each.
    expect(tables.outbox?.length).toBeGreaterThan(SLOTLOCK_TENANT_EXPORT_PART_ROWS);
    expect(partTables.filter((table) => table === 'outbox').length).toBeGreaterThanOrEqual(2);
    // The audit log has the request itself.
    expect(tables.audit_events?.some((row) => row.action === 'export.created')).toBe(true);
    const text = JSON.stringify(tables);
    expect(text).not.toContain('"tenant_ref"');
    expect(text).not.toContain('not-yours');
    expect(text).not.toContain(otherRef);

    // Another tenant cannot read it, and a part past the last is not there.
    expect(await call('GET', `/v1/tenant/exports/${pending.id}`, undefined, 'other')).toMatchObject({
      status: 404,
      body: { error: { code: 'export_not_found' } },
    });
    expect(await call('GET', `/v1/tenant/exports/${pending.id}/parts/${made.parts + 1}`)).toMatchObject({
      status: 404,
      body: { error: { code: 'export_part_not_found' } },
    });
    expect((await call('GET', `/v1/tenant/exports/${pending.id}/parts/0`)).status).toBe(400);
  });

  it('builds one at a time, keeps five, and deletes them on request, by expiry or after the fact', async () => {
    // One a stopped server left pending: refused alongside, then built by maintenance.
    const orphan = await store.withTenant(tenantRef, (tenant) => tenant.createTenantExport({ tenantRef }));
    expect(await call('POST', '/v1/tenant/exports', {})).toMatchObject({ status: 409, body: { error: { code: 'export_in_progress' } } });
    expect(await call('GET', `/v1/tenant/exports/${orphan.id}/parts/1`)).toMatchObject({
      status: 409,
      body: { error: { code: 'export_not_ready' } },
    });
    await sql`UPDATE slotlock.tenant_exports SET created_at = now() - interval '5 minutes' WHERE id = ${orphan.id}`;
    await maintainSlotlockTenant(store, tenantRef);
    expect((await call('GET', `/v1/tenant/exports/${orphan.id}`)).body.export).toMatchObject({ status: 'ready' });

    // Five kept (the first test's, the orphan's and three more).
    for (let index = 0; index < 3; index++) {
      const made = (await call('POST', '/v1/tenant/exports', {})).body.export as { id: string };
      await ready(made.id);
    }
    expect(await call('POST', '/v1/tenant/exports', {})).toMatchObject({ status: 409, body: { error: { code: 'export_limit_reached' } } });
    const listed = (await call('GET', '/v1/tenant/exports')).body.exports as { id: string; status: string }[];
    expect(listed).toHaveLength(5);

    // Deleted on request, with its parts.
    expect(await call('DELETE', `/v1/tenant/exports/${orphan.id}`)).toMatchObject({ status: 200, body: { deleted: true } });
    expect((await call('GET', `/v1/tenant/exports/${orphan.id}`)).status).toBe(404);
    const [left] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM slotlock.tenant_export_parts WHERE export_id = ${orphan.id}`;
    expect(left?.n).toBe(0);
    // And by expiry, at maintenance.
    await sql`UPDATE slotlock.tenant_exports SET expires_at = now() - interval '1 minute' WHERE tenant_ref = ${tenantRef}`;
    await maintainSlotlockTenant(store, tenantRef);
    expect((await call('GET', '/v1/tenant/exports')).body.exports).toEqual([]);
  });
});
