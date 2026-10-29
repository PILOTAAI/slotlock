// What the feed must never hold, and how its provenance columns migrate (the feed provenance review):
// a coverage source (an iCalendar URL with a token, an address) never reaches a feed row, a CloudEvent
// or the history, only its random id; the origin column is added without a scan under the lock, its CHECK
// is the origins the API reads, and a write that names no origin is `library`; an authenticator's
// key id that withTenant would refuse is left out. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { SLOTLOCK_APPLICATION_OPERATIONS } from '../application-api.js';
import { SLOTLOCK_CORE_DDL, SLOTLOCK_STRUCTURE_DDL, SLOTLOCK_VALIDATION_DDL } from '../ddl.js';
import { SLOTLOCK_CHANGE_ORIGINS, slotlockCoverageSourceId } from '../event-feed.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe('the outbox DDL', () => {
  it('adds origin with no CHECK of its own, and its CHECK NOT VALID, of the known origins', () => {
    expect(SLOTLOCK_CORE_DDL).toMatch(/ADD COLUMN IF NOT EXISTS origin text;/);
    expect(SLOTLOCK_CORE_DDL).not.toMatch(/ADD COLUMN IF NOT EXISTS origin[^;]*CHECK/);
    const check = /ADD CONSTRAINT slotlock_outbox_origin_known\s+CHECK \(origin IN \(([^)]*)\)\) NOT VALID;/.exec(
      SLOTLOCK_CORE_DDL,
    );
    expect(check?.[1]).toBe(SLOTLOCK_CHANGE_ORIGINS.map((origin) => `'${origin}'`).join(', '));
  });

  it("no longer works out 0.5.3's guessable digest: slotlockCoverageSourceId throws, naming listCoverage", () => {
    expect(() => slotlockCoverageSourceId('a', 'google:fleet')).toThrow(/listCoverage/);
    expect(() => slotlockCoverageSourceId('a', 'google:fleet')).toThrow(
      expect.objectContaining({ code: 'coverage_source_id_unavailable' }),
    );
  });
});

describe.skipIf(!url)('the feed provenance review (real Postgres)', () => {
  let admin: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenants: string[] = [];
  const tenant = (name: string) => {
    const ref = `${name}-${randomUUID()}`;
    tenants.push(ref);
    return ref;
  };
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 8, 1);
  const at = (hour: number) => new Date(base + hour * 3_600_000);

  beforeAll(async () => {
    admin = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(admin);
    await store.applySchema();
  });

  afterAll(async () => {
    for (const ref of tenants) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    await admin.end();
  });

  it('names a coverage source by its random id on the feed, in CloudEvents and in the history', async () => {
    const tenantRef = tenant('coverage-privacy');
    const token = `tok${randomUUID().replaceAll('-', '')}`;
    const ics = `ical:https://calendar.example.com/private/feed.ics?token=${token}`;
    const email = `google:owner-${randomUUID().slice(0, 8)}@example.com`;
    const app = createSlotlockStoreApplicationBackend(store);
    const as = { principal: { tenantRef, scopes: ['admin'] }, signal: new AbortController().signal } as never;
    const { resource } = (await app.createResource(as, { external_ref: 'van', timezone: 'UTC' })) as {
      resource: { id: string };
    };
    const window = { start: at(0).toISOString(), end: at(48).toISOString() };
    for (const source of [ics, email]) {
      await app.recordCoverage(as, { resource_id: resource.id, source, ...window, revision: 1 });
      await app.recordCoverageFailure(as, { resource_id: resource.id, source, error: `HTTP 401 from ${source}` });
    }
    const { sources } = (await app.getCoverage(as, { resource_id: resource.id })) as {
      sources: { source: string; source_id: string }[];
    };
    const idOf = (source: string) => sources.find((entry) => entry.source === source)?.source_id;
    for (const source of [ics, email]) expect(idOf(source)).toMatch(/^src_[0-9a-f]{32}$/);

    await admin`UPDATE slotlock.calendar_coverage SET observed_at = now() - interval '2 days' WHERE tenant_ref = ${tenantRef}`;
    expect(await store.withTenant(tenantRef, (t) => t.reportStaleCoverage({ tenantRef }))).toBe(2);
    await app.deleteCoverage(as, { resource_id: resource.id, source: ics });

    const rows = await admin<{ type: string; subject: string; data: Record<string, unknown> }[]>`
      SELECT type, subject, data FROM slotlock.outbox
       WHERE tenant_ref = ${tenantRef} AND type LIKE 'coverage.%' ORDER BY txid, id`;
    const named = (type: string) => rows.filter((row) => row.type === type).map(({ subject }) => subject).sort();
    expect(named('coverage.recorded')).toEqual([idOf(ics), idOf(email)].sort());
    expect(named('coverage.stale')).toEqual([idOf(ics), idOf(email)].sort());
    expect(named('coverage.deleted')).toEqual([idOf(ics)]);
    for (const row of rows) expect(row.data.source_id).toBe(row.subject);

    const everything = JSON.stringify([
      await admin`SELECT * FROM slotlock.outbox WHERE tenant_ref = ${tenantRef}`,
      await app.listChanges(as, { limit: 100 }),
      await app.getResourceHistory(as, { resource_id: resource.id, limit: 100 }),
      await store.listHistory({ tenantRef, resourceId: resource.id, limit: 100 }),
    ]);
    for (const secret of [token, 'calendar.example.com', email, '@example.com']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('adds the origin CHECK NOT VALID, and validation makes it valid', async () => {
    const state = () => admin<{ validated: boolean; definition: string }[]>`
      SELECT convalidated AS validated, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'slotlock.outbox'::regclass AND conname LIKE 'slotlock_outbox_origin%'`;
    await admin
      .begin(async (tx) => {
        await tx.unsafe('ALTER TABLE slotlock.outbox DROP CONSTRAINT IF EXISTS slotlock_outbox_origin_known');
        await tx.unsafe(SLOTLOCK_STRUCTURE_DDL);
        const before = await tx<{ validated: boolean }[]>`
          SELECT convalidated AS validated FROM pg_constraint
           WHERE conrelid = 'slotlock.outbox'::regclass AND conname LIKE 'slotlock_outbox_origin%'`;
        expect(before).toEqual([{ validated: false }]);
        await tx.unsafe(SLOTLOCK_VALIDATION_DDL);
        const after = await tx<{ validated: boolean }[]>`
          SELECT convalidated AS validated FROM pg_constraint
           WHERE conrelid = 'slotlock.outbox'::regclass AND conname LIKE 'slotlock_outbox_origin%'`;
        expect(after).toEqual([{ validated: true }]);
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback') throw error;
      });
    const [constraint] = await state();
    expect(constraint?.definition).toContain("'dashboard-assistant'::text");
  });

  it('replaces an origin CHECK an earlier release built from a shorter list', async () => {
    await admin
      .begin(async (tx) => {
        await tx.unsafe(`ALTER TABLE slotlock.outbox DROP CONSTRAINT IF EXISTS slotlock_outbox_origin_known;
          ALTER TABLE slotlock.outbox ADD CONSTRAINT slotlock_outbox_origin_known
            CHECK (origin IN ('mcp', 'library')) NOT VALID;
          COMMENT ON CONSTRAINT slotlock_outbox_origin_known ON slotlock.outbox IS 'mcp library'`);
        await tx.unsafe(SLOTLOCK_STRUCTURE_DDL);
        const [constraint] = await tx<{ definition: string; validated: boolean }[]>`
          SELECT pg_get_constraintdef(oid) AS definition, convalidated AS validated FROM pg_constraint
           WHERE conrelid = 'slotlock.outbox'::regclass AND conname = 'slotlock_outbox_origin_known'`;
        for (const origin of SLOTLOCK_CHANGE_ORIGINS) expect(constraint?.definition).toContain(`'${origin}'::text`);
        expect(constraint?.validated).toBe(false);
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback') throw error;
      });
  });

  it('refuses an origin the API does not read, and reads one written before the CHECK as unrecorded', async () => {
    const tenantRef = tenant('origin-check');
    const as = { principal: { tenantRef, scopes: ['admin'] }, signal: new AbortController().signal } as never;
    const { resource } = (await createSlotlockStoreApplicationBackend(store).createResource(as, {
      external_ref: 'van',
      timezone: 'UTC',
    })) as { resource: { id: string } };
    const insert = (sql: postgres.Sql | postgres.TransactionSql) =>
      sql`INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, origin)
          VALUES (${tenantRef}, ${resource.id}, 'resource.updated', ${resource.id}, '{}', 'smtp')`;
    await expect(insert(admin)).rejects.toMatchObject({ code: '23514' });
    // A row a later release wrote (or one from before the CHECK): read as null, never a failed page.
    const history = SLOTLOCK_APPLICATION_OPERATIONS.find(({ invoke }) => invoke === 'getResourceHistory');
    await admin
      .begin(async (tx) => {
        await tx.unsafe('ALTER TABLE slotlock.outbox DROP CONSTRAINT slotlock_outbox_origin_known');
        await insert(tx);
        const inTx = createSlotlockStore(tx as never);
        const [latest] = await inTx.listHistory({ tenantRef, resourceId: resource.id, limit: 1 });
        expect(latest).toMatchObject({ type: 'resource.updated', origin: null });
        const page = await createSlotlockStoreApplicationBackend(inTx).getResourceHistory(as, {
          resource_id: resource.id,
          limit: 10,
        });
        expect(history?.output.safeParse(page).success).toBe(true);
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback') throw error;
      });
  });

  it('records library for a write through the root store outside withTenant', async () => {
    const tenantRef = tenant('library');
    const created = await store.createResource({ tenantRef, externalRef: 'van', timezone: 'UTC' });
    expect(created).toMatchObject({ externalRef: 'van' });
    const rows = await admin<{ type: string; origin: string | null; key_id: string | null }[]>`
      SELECT type, origin, key_id::text FROM slotlock.outbox WHERE tenant_ref = ${tenantRef}`;
    expect(rows).toEqual([{ type: 'resource.created', origin: 'library', key_id: null }]);
  });

  it("leaves out an authenticator's UUIDv7 key id instead of refusing the call", async () => {
    const tenantRef = tenant('uuid7');
    const keyId = '01920f3c-6a8b-7c3d-9e4f-0a1b2c3d4e5f';
    const app = createSlotlockStoreApplicationBackend(store);
    const as = {
      principal: { tenantRef, scopes: ['admin'], keyId, subject: `custom:${keyId}` },
      signal: new AbortController().signal,
    } as never;
    await expect(app.createResource(as, { external_ref: 'van', timezone: 'UTC' })).resolves.toMatchObject({
      resource: { external_ref: 'van' },
    });
    const rows = await admin<{ actor: string | null; key_id: string | null }[]>`
      SELECT actor, key_id::text FROM slotlock.outbox WHERE tenant_ref = ${tenantRef}`;
    expect(rows).toEqual([{ actor: `custom:${keyId}`, key_id: null }]);
  });
});
