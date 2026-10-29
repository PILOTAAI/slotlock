// A coverage source's id on the feed (0.6): random, stored with the source, never derivable from the
// tenant and the source, and the same on every change about it. Upgrading renames the coverage
// changes earlier releases wrote (0.5.2's carried the source itself and its last error; 0.5.3's an
// unkeyed digest of it) in batches after the structure commits, as a deployment role forced RLS
// binds; the feed never serves one of them raw meanwhile. A database and roles of their own; skipped
// without DATABASE_URL; the connecting role must create databases and roles.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import {
  SLOTLOCK_CORE_DDL,
  SLOTLOCK_COVERAGE_CHANGE_RENAME_BATCH,
  SLOTLOCK_SCHEMA_VERSION,
  SLOTLOCK_TENANT_TABLES,
} from '../ddl.js';
import { slotlockCoverageSourceId } from '../event-feed.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { deliverSlotlockWebhooks } from '../webhooks.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const SOURCE_ID = /^src_[0-9a-f]{32}$/;

describe.skipIf(!url)('coverage source ids (real Postgres)', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_source_ids_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const application = `slotlock_app_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let admin: postgres.Sql;
  /** A superuser on the test database: it stands for rows earlier releases wrote and for inspection. */
  let superuser: postgres.Sql;
  /** The owning role, which forced RLS binds as it binds every role but a superuser. */
  let deployment: postgres.Sql;
  let ownerStore: SlotlockStore;
  let store: SlotlockStore;
  const window = { start: '2027-01-01T00:00:00Z', end: '2027-03-01T00:00:00Z' };
  const context = (tenantRef: string) =>
    ({ principal: { tenantRef, scopes: ['admin'] }, signal: new AbortController().signal }) as never;

  async function vehicle(tenantRef: string, ref = 'van') {
    const app = createSlotlockStoreApplicationBackend(store);
    const { resource } = (await app.createResource(context(tenantRef), { external_ref: ref, timezone: 'UTC' })) as {
      resource: { id: string };
    };
    return resource.id;
  }

  async function sourceIds(tenantRef: string, resourceId: string) {
    const app = createSlotlockStoreApplicationBackend(store);
    const { sources } = (await app.getCoverage(context(tenantRef), { resource_id: resourceId })) as {
      sources: { source: string; source_id: string }[];
    };
    return Object.fromEntries(sources.map(({ source, source_id }) => [source, source_id]));
  }

  async function forcedTables() {
    const rows = await superuser<{ name: string }[]>`
      SELECT rel.relname AS name FROM pg_catalog.pg_class rel
        JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'slotlock' AND rel.relforcerowsecurity ORDER BY rel.relname`;
    return rows.map(({ name }) => name);
  }

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => undefined });
    await admin.unsafe(
      `CREATE ROLE ${owner} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await admin.unsafe(
      `CREATE ROLE ${application} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await admin.unsafe(`CREATE DATABASE ${database}`);
    await admin.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    superuser = postgres(target.href, { max: 3, onnotice: () => undefined });
    deployment = postgres(Object.assign(new URL(target.href), { username: owner, password }).href, {
      max: 2,
      onnotice: () => undefined,
    });
    ownerStore = createSlotlockStore(deployment);
    await ownerStore.applySchema();
    await ownerStore.applyTenantRls();
    await ownerStore.grantApplicationRole(application);
    store = createSlotlockStore(superuser);
  });

  afterAll(async () => {
    await deployment?.end();
    await superuser?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${application}`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    await admin?.end();
  });

  it('is random per source, not the digest of the tenant and the source', async () => {
    // The audit's guess: confirmed offline against 0.5.3's digest, src_482ba2bfbabbb8b6a107b3ef.
    const guess = 'google:alice.smith@example.com';
    const app = createSlotlockStoreApplicationBackend(store);
    const tenants = [`default-${randomUUID()}`, `other-${randomUUID()}`];
    const ids: string[] = [];
    for (const tenantRef of tenants) {
      for (const ref of ['van', 'truck']) {
        const resourceId = await vehicle(tenantRef, ref);
        await app.recordCoverage(context(tenantRef), { resource_id: resourceId, source: guess, ...window, revision: 1 });
        const id = (await sourceIds(tenantRef, resourceId))[guess] as string;
        expect(id).toMatch(SOURCE_ID);
        expect(id).not.toBe(slotlockCoverageSourceId(tenantRef, guess));
        expect(id).not.toContain(slotlockCoverageSourceId(tenantRef, guess).slice(4));
        ids.push(id);
      }
    }
    expect(slotlockCoverageSourceId('default', guess)).toBe('src_482ba2bfbabbb8b6a107b3ef');
    expect(new Set(ids).size).toBe(ids.length);

    // A source deleted and recorded again is a new source: a new id.
    const tenantRef = tenants[0] as string;
    const resourceId = await vehicle(tenantRef, 'bus');
    await app.recordCoverage(context(tenantRef), { resource_id: resourceId, source: guess, ...window, revision: 1 });
    const first = (await sourceIds(tenantRef, resourceId))[guess];
    await app.deleteCoverage(context(tenantRef), { resource_id: resourceId, source: guess });
    await app.recordCoverage(context(tenantRef), { resource_id: resourceId, source: guess, ...window, revision: 1 });
    const second = (await sourceIds(tenantRef, resourceId))[guess];
    expect(second).toMatch(SOURCE_ID);
    expect(second).not.toBe(first);
  });

  it('is the same on its record, stale and delete changes, and is what getCoverage gives', async () => {
    const tenantRef = `stable-${randomUUID()}`;
    const app = createSlotlockStoreApplicationBackend(store);
    const resourceId = await vehicle(tenantRef);
    const source = `ical:https://calendar.example.com/private.ics?token=${randomUUID()}`;
    await app.recordCoverage(context(tenantRef), { resource_id: resourceId, source, ...window, revision: 1 });
    const id = (await sourceIds(tenantRef, resourceId))[source] as string;
    expect(id).toMatch(SOURCE_ID);
    await app.recordCoverage(context(tenantRef), { resource_id: resourceId, source, ...window, revision: 2 });
    await app.recordCoverageFailure(context(tenantRef), { resource_id: resourceId, source, error: `HTTP 401 from ${source}` });
    await superuser`UPDATE slotlock.calendar_coverage SET observed_at = now() - interval '2 days' WHERE tenant_ref = ${tenantRef}`;
    expect(await store.withTenant(tenantRef, (tenant) => tenant.reportStaleCoverage({ tenantRef }))).toBe(1);
    expect((await sourceIds(tenantRef, resourceId))[source]).toBe(id);
    await app.deleteCoverage(context(tenantRef), { resource_id: resourceId, source });

    const page = await store.listChanges({ tenantRef });
    if (!page.ok) throw new Error(page.code);
    const { changes } = page;
    const coverage = changes.filter(({ type }) => type.startsWith('coverage.'));
    expect(coverage.map(({ type }) => type)).toEqual(['coverage.recorded', 'coverage.stale', 'coverage.deleted']);
    for (const change of coverage) {
      expect(change.subject).toBe(id);
      expect(change.data.source_id).toBe(id);
    }
    expect(JSON.stringify(changes)).not.toContain('calendar.example.com');
  });

  it("keeps a tenant's source ids from another tenant, under calendar_coverage's forced RLS", async () => {
    const mine = `rls-${randomUUID()}`;
    const theirs = `rls-${randomUUID()}`;
    const app = createSlotlockStoreApplicationBackend(store);
    for (const tenantRef of [mine, theirs]) {
      await app.recordCoverage(context(tenantRef), {
        resource_id: await vehicle(tenantRef),
        source: 'google:fleet',
        ...window,
        revision: 1,
      });
    }
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    const served = postgres(Object.assign(target, { username: application, password }).href, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const seen = await served.begin(async (tx) => {
        await tx`SELECT set_config('slotlock.tenant_ref', ${mine}, true)`;
        return tx<{ tenant_ref: string; source_id: string }[]>`
          SELECT tenant_ref, source_id FROM slotlock.calendar_coverage`;
      });
      expect(seen.map(({ tenant_ref }) => tenant_ref)).toEqual([mine]);
      expect(seen[0]?.source_id).toMatch(SOURCE_ID);
      expect(await served`SELECT source_id FROM slotlock.calendar_coverage`).toEqual([]);
    } finally {
      await served.end();
    }
    expect(await forcedTables()).toEqual([...SLOTLOCK_TENANT_TABLES].sort());
  });

  it('renames the coverage changes earlier releases wrote, serves none of them raw, and runs again safely', async () => {
    const tenantRef = `upgrade-${randomUUID()}`;
    const app = createSlotlockStoreApplicationBackend(store);
    const resourceId = await vehicle(tenantRef);
    const live = 'ical:https://calendar.example.com/fleet.ics?token=SECRET123';
    const address = 'google:alice.smith@example.com';
    const gone = 'ical:https://calendar.example.com/old.ics?token=GONE456';
    for (const source of [live, address]) {
      await app.recordCoverage(context(tenantRef), { resource_id: resourceId, source, ...window, revision: 1 });
    }
    const hook = await store.createWebhookEndpoint({
      tenantRef,
      url: 'https://hooks.example.com/slotlock',
      eventTypes: ['coverage.recorded', 'coverage.stale', 'coverage.deleted'],
    });
    expect(hook.ok).toBe(true);

    // More changes than one batch reads, then the rows each earlier release wrote.
    await superuser`
      INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, origin)
      SELECT ${tenantRef}, ${resourceId}, 'resource.updated', ${resourceId}, '{}', 'library'
        FROM generate_series(1, ${SLOTLOCK_COVERAGE_CHANGE_RENAME_BATCH * 2 + 7})`;
    const stale52 = (source: string) => ({
      resource_id: resourceId,
      source,
      observed_at: '2026-10-27T09:00:00Z',
      last_error: `HTTP 401 from ${source.slice(5)}`,
    });
    const digest53 = slotlockCoverageSourceId(tenantRef, address);
    const legacy = [
      { type: 'coverage.stale', subject: live, data: stale52(live) },
      { type: 'coverage.stale', subject: gone, data: stale52(gone) },
      {
        type: 'coverage.recorded',
        subject: digest53,
        data: { resource_id: resourceId, source_id: digest53, start: window.start, end: window.end, revision: 1 },
      },
      { type: 'coverage.deleted', subject: slotlockCoverageSourceId(tenantRef, gone), data: { resource_id: resourceId, source_id: slotlockCoverageSourceId(tenantRef, gone) } },
    ];
    for (const row of legacy) {
      await superuser`
        INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, origin)
        VALUES (${tenantRef}, ${resourceId}, ${row.type}, ${row.subject}, ${superuser.json(row.data as never)}, 'maintenance')`;
    }
    const secrets = ['SECRET123', 'GONE456', 'calendar.example.com', 'alice.smith', digest53];

    // Before the upgrade, on every read path: listChanges, history and a webhook's delivery.
    // The newest five: a filler change, then the four to rename.
    const filler = (await store.listRecentChanges({ tenantRef, limit: 5 })).at(-1);
    expect(filler?.type).toBe('resource.updated');
    const coverageChanges = async () => {
      const page = await store.listChanges({ tenantRef, limit: 500, after: filler?.position as string });
      if (!page.ok) throw new Error(page.code);
      return page.changes.filter(({ type }) => type.startsWith('coverage.'));
    };
    const before = await coverageChanges();
    expect(before.map(({ subject }) => subject)).toEqual(['src_redacted', 'src_redacted', 'src_redacted', 'src_redacted']);
    const bodies: string[] = [];
    await deliverSlotlockWebhooks({
      feed: store,
      tenantRef,
      batch: 100,
      send: async (request) => {
        bodies.push(request.body);
        return { status: 200 };
      },
    });
    const history = await store.listHistory({ tenantRef, resourceId, limit: 10 });
    const served = JSON.stringify([before, bodies, history]);
    expect(bodies).toHaveLength(4);
    expect(bodies.map((body) => (JSON.parse(body) as { subject: string }).subject)).toEqual(
      before.map(({ subject }) => subject),
    );
    for (const secret of secrets) expect(served).not.toContain(secret);
    for (const change of [...before, ...history.filter(({ type }) => type.startsWith('coverage.'))]) {
      expect(change.data).not.toHaveProperty('source');
      expect(change.data).not.toHaveProperty('last_error');
    }

    // The upgrade, as the owning role forced RLS binds, from the schema 0.5.3 left (no stored id, so
    // the sources are given new ones; its digests do not match).
    await superuser.unsafe('ALTER TABLE slotlock.calendar_coverage DROP COLUMN source_id');
    await superuser`UPDATE slotlock.schema_version SET ddl_sha256 = NULL, catalog_sha256 = NULL`;
    await ownerStore.applySchema();
    expect(await forcedTables()).toEqual([...SLOTLOCK_TENANT_TABLES].sort());
    const ids = await sourceIds(tenantRef, resourceId);
    expect(ids[live]).toMatch(SOURCE_ID);
    expect(ids[address]).toMatch(SOURCE_ID);
    const stored = () =>
      superuser<{ id: string; type: string; subject: string; data: Record<string, unknown> }[]>`
        SELECT id::text, type, subject, data FROM slotlock.outbox
         WHERE tenant_ref = ${tenantRef} AND type LIKE 'coverage.%' ORDER BY outbox.id`;
    const renamed = await stored();
    expect(renamed.slice(-4).map(({ type, subject, data }) => ({ type, subject, data }))).toEqual([
      { type: 'coverage.stale', subject: ids[live], data: { resource_id: resourceId, source_id: ids[live], observed_at: '2026-10-27T09:00:00Z' } },
      { type: 'coverage.stale', subject: 'src_redacted', data: { resource_id: resourceId, source_id: 'src_redacted', observed_at: '2026-10-27T09:00:00Z' } },
      {
        type: 'coverage.recorded',
        subject: ids[address],
        data: { resource_id: resourceId, source_id: ids[address], start: window.start, end: window.end, revision: 1 },
      },
      { type: 'coverage.deleted', subject: 'src_redacted', data: { resource_id: resourceId, source_id: 'src_redacted' } },
    ]);
    const everything = JSON.stringify(await superuser`SELECT * FROM slotlock.outbox WHERE tenant_ref = ${tenantRef}`);
    for (const secret of secrets) expect(everything).not.toContain(secret);
    expect((await coverageChanges()).map(({ subject }) => subject)).toEqual([
      ids[live],
      'src_redacted',
      ids[address],
      'src_redacted',
    ]);

    // Again, whole, and as a no-op: nothing changes.
    await superuser`UPDATE slotlock.schema_version SET ddl_sha256 = NULL, catalog_sha256 = NULL`;
    await ownerStore.applySchema();
    await ownerStore.applySchema();
    expect(await stored()).toEqual(renamed);
    expect(await sourceIds(tenantRef, resourceId)).toEqual(ids);
    expect(await forcedTables()).toEqual([...SLOTLOCK_TENANT_TABLES].sort());

    // SLOTLOCK_CORE_DDL, for psql, renames in its one transaction too.
    await superuser
      .begin(async (tx) => {
        await tx`
          INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, origin)
          VALUES (${tenantRef}, ${resourceId}, 'coverage.stale', ${live}, ${tx.json(stale52(live))}, 'maintenance')`;
        await tx.unsafe(`SET LOCAL ROLE ${owner}`);
        await tx.unsafe(SLOTLOCK_CORE_DDL);
        await tx.unsafe('RESET ROLE');
        const [last] = await tx<{ subject: string; data: Record<string, unknown> }[]>`
          SELECT subject, data FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} ORDER BY id DESC LIMIT 1`;
        expect(last).toEqual({ subject: ids[live], data: { resource_id: resourceId, source_id: ids[live], observed_at: '2026-10-27T09:00:00Z' } });
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback') throw error;
      });
  });
});

describe.skipIf(!url)('rolling back to 0.5.x (real Postgres)', () => {
  const database = `slotlock_rollback_${randomBytes(6).toString('hex')}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    sql = postgres(target.href, { max: 1, onnotice: () => undefined });
    await createSlotlockStore(sql).applySchema();
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });

  it("is refused by 0.5.3's migration, which would put the digest trigger back", async () => {
    // 0.5.3 records schema version 3 and refuses only a higher one before it changes anything.
    const preconditions = readFileSync(
      new URL('./fixtures/slotlock-0.5.3-schema-preconditions.sql', import.meta.url),
      'utf8',
    );
    await expect(sql.unsafe(preconditions)).rejects.toMatchObject({
      code: '55000',
      message: expect.stringContaining('Slotlock will not migrate a schema a newer release migrated'),
    });
    expect(SLOTLOCK_SCHEMA_VERSION).toBeGreaterThan(3);
  });
});
