// The schema records which release migrated it, a server refuses a database migrated by an older or
// a newer release, and a migration never makes serving queries queue behind it for long: one with
// nothing to change takes no table lock, and one that must wait for a lock gives up after its lock
// timeout and tries again. Each test works in a database of its own, since it rewrites the schema
// and holds locks other files would wait on. Skipped without DATABASE_URL; the role must create
// databases.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SLOTLOCK_SCHEMA_VERSION } from '../ddl.js';
import { runSlotlockCli } from '../self-host.js';
import {
  type SlotlockStore,
  assertSlotlockSchemaCurrent,
  createSlotlockStore,
  readSlotlockSchemaVersion,
} from '../store.js';

const url = process.env.DATABASE_URL?.trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)('schema version and migration locks (real Postgres)', () => {
  const database = `slotlock_version_${randomBytes(6).toString('hex')}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let store: SlotlockStore;
  const connect = (max = 2) => {
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    return postgres(target.href, { max, onnotice: () => undefined });
  };

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    sql = connect(4);
    store = createSlotlockStore(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });

  beforeEach(async () => {
    await sql.unsafe('DROP SCHEMA IF EXISTS slotlock CASCADE');
    await store.applySchema();
  });

  /** Every constraint in the schema: its definition and whether the database has checked it. */
  async function constraints() {
    return sql<{ table: string; name: string; definition: string; validated: boolean }[]>`
      SELECT rel.relname AS table, con.conname AS name,
             pg_get_constraintdef(con.oid) AS definition, con.convalidated AS validated
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'slotlock'
       ORDER BY rel.relname, con.conname`;
  }

  it('records the version it migrated to, and the server check accepts exactly that one', async () => {
    expect(SLOTLOCK_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
    await expect(readSlotlockSchemaVersion(sql)).resolves.toBe(SLOTLOCK_SCHEMA_VERSION);
    await expect(assertSlotlockSchemaCurrent(sql)).resolves.toBeUndefined();
  });

  it('calls a database an earlier release migrated (no version) outdated until it is migrated', async () => {
    // What 0.2 left: the tables, without the version record or the function that reads it.
    await sql.unsafe(`
      DROP FUNCTION slotlock.installed_schema_version();
      DROP TABLE slotlock.schema_version;
    `);
    await expect(readSlotlockSchemaVersion(sql)).resolves.toBeNull();
    await expect(assertSlotlockSchemaCurrent(sql)).rejects.toMatchObject({
      code: 'schema_outdated',
    });
    await store.applySchema();
    await expect(assertSlotlockSchemaCurrent(sql)).resolves.toBeUndefined();
  });

  it('calls a database an older versioned release migrated outdated', async () => {
    await sql`UPDATE slotlock.schema_version SET version = ${SLOTLOCK_SCHEMA_VERSION - 1}`;
    await expect(assertSlotlockSchemaCurrent(sql)).rejects.toMatchObject({
      code: 'schema_outdated',
      installed: SLOTLOCK_SCHEMA_VERSION - 1,
      expected: SLOTLOCK_SCHEMA_VERSION,
    });
    await store.applySchema();
    await expect(readSlotlockSchemaVersion(sql)).resolves.toBe(SLOTLOCK_SCHEMA_VERSION);
  });

  it('refuses to migrate or serve a database a newer release migrated, and changes nothing', async () => {
    await sql`UPDATE slotlock.schema_version SET version = ${SLOTLOCK_SCHEMA_VERSION + 1}`;
    // Something this release would put back if it went ahead.
    await sql.unsafe('DROP INDEX slotlock.slotlock_reservations_resource_time_idx');
    await expect(store.applySchema()).rejects.toMatchObject({ code: 'schema_newer' });
    await expect(store.applyTenantRls()).rejects.toMatchObject({ code: 'schema_newer' });
    const [index] = await sql<{ present: boolean }[]>`
      SELECT to_regclass('slotlock.slotlock_reservations_resource_time_idx') IS NOT NULL AS present`;
    expect(index?.present).toBe(false);
    await expect(readSlotlockSchemaVersion(sql)).resolves.toBe(SLOTLOCK_SCHEMA_VERSION + 1);
    await expect(assertSlotlockSchemaCurrent(sql)).rejects.toMatchObject({
      code: 'schema_newer',
      installed: SLOTLOCK_SCHEMA_VERSION + 1,
      expected: SLOTLOCK_SCHEMA_VERSION,
    });
  });

  it('migrates a schema with nothing to change without waiting on a serving transaction', async () => {
    await store.applyTenantRls();
    const serving = connect(1);
    const reserved = await serving.reserve();
    try {
      // A serving transaction that has read the tables: it holds their ACCESS SHARE locks.
      await reserved`BEGIN`;
      await reserved`SELECT count(*) FROM slotlock.reservations`;
      await reserved`SELECT count(*) FROM slotlock.resources`;
      const migrate = (async () => {
        await store.applySchema();
        await store.applyTenantRls();
        return 'migrated';
      })();
      await expect(Promise.race([migrate, sleep(3_000).then(() => 'waited')])).resolves.toBe(
        'migrated',
      );
    } finally {
      await reserved`ROLLBACK`;
      reserved.release();
      await serving.end();
    }
  });

  it('gives up waiting for a lock after its timeout, so serving reads queue behind it only that long', async () => {
    // A change to make: the full migration runs and needs ACCESS EXCLUSIVE on the reservations.
    await sql.unsafe('DROP INDEX slotlock.slotlock_reservations_resource_time_idx');
    const serving = connect(2);
    const reserved = await serving.reserve();
    try {
      await reserved`BEGIN`;
      await reserved`SELECT count(*) FROM slotlock.reservations`;
      const started = Date.now();
      const migrate = store.applySchema({ lockTimeoutMs: 300, attempts: 2 }).then(
        () => 'migrated' as const,
        (error: unknown) => error,
      );
      await sleep(100);
      // A read arriving while the migration waits is served within its own statement timeout.
      const read = await serving.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = 1500`;
        return tx<{ count: number }[]>`SELECT count(*)::int AS count FROM slotlock.reservations`;
      });
      expect(read[0]?.count).toBe(0);
      await expect(migrate).resolves.toMatchObject({ code: 'schema_lock_timeout' });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await reserved`ROLLBACK`;
      reserved.release();
      await serving.end();
    }
    // Once nothing holds the lock, the migration goes through.
    await store.applySchema({ lockTimeoutMs: 300 });
    const [index] = await sql<{ present: boolean }[]>`
      SELECT to_regclass('slotlock.slotlock_reservations_resource_time_idx') IS NOT NULL AS present`;
    expect(index?.present).toBe(true);
  });

  it('refuses a timeout or attempt count it cannot honour before it starts', async () => {
    for (const options of [
      { lockTimeoutMs: 0 },
      { lockTimeoutMs: Number.NaN },
      { statementTimeoutMs: -1 },
      { attempts: 0 },
      { attempts: 1.5 },
    ]) {
      await expect(store.applySchema(options)).rejects.toMatchObject({
        code: 'invalid_migration_options',
      });
    }
  });

  it('validates every constraint an upgrade added NOT VALID, so the upgraded catalog equals a fresh one', async () => {
    const fresh = await constraints();
    expect(fresh.filter(({ validated }) => !validated)).toEqual([]);
    // 0.1's API key scope constraint, which the upgrade replaces NOT VALID.
    await sql.unsafe(`
      ALTER TABLE slotlock.api_keys DROP CONSTRAINT slotlock_api_keys_scopes_known;
      ALTER TABLE slotlock.api_keys
        ADD CONSTRAINT slotlock_api_keys_scopes_valid
        CHECK (scopes IN (ARRAY['read']::text[], ARRAY['write']::text[], ARRAY['read', 'write']::text[]));
    `);
    await store.applySchema();
    expect(await constraints()).toEqual(fresh);
  });

  it('leaves a constraint NOT VALID, and the migration done, when old rows break it', async () => {
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO slotlock.resources (tenant_ref, external_ref) VALUES ('legacy', 'van') RETURNING id`;
    // A row a spike schema wrote before revisions were checked.
    await sql.unsafe(`
      ALTER TABLE slotlock.reservations DROP CONSTRAINT slotlock_reservations_revision_valid;
      INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, revision)
      VALUES ('${resource?.id}', '2027-01-01T09:00:00Z', '2027-01-01T10:00:00Z', 0);
    `);
    await store.applySchema();
    const revision = (await constraints()).find(
      ({ name }) => name === 'slotlock_reservations_revision_valid',
    );
    expect(revision?.validated).toBe(false);
    await expect(readSlotlockSchemaVersion(sql)).resolves.toBe(SLOTLOCK_SCHEMA_VERSION);
  });

  it('serve refuses a database migrated by an older or a newer release, naming which', async () => {
    const role = `slotlock_version_${randomBytes(8).toString('hex')}`;
    const password = randomBytes(24).toString('hex');
    await sql.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    try {
      await store.applyTenantRls();
      await store.grantApplicationRole(role);
      const serving = new URL(url as string);
      serving.pathname = `/${database}`;
      serving.username = role;
      serving.password = password;
      const serve = async () => {
        const out: string[] = [];
        const err: string[] = [];
        const code = await runSlotlockCli(['serve'], {
          env: {
            DATABASE_URL: serving.href,
            SLOTLOCK_AUTH_TOKEN: randomBytes(32).toString('hex'),
            SLOTLOCK_TENANT: 'version-tenant',
            SLOTLOCK_CONFIRM_WRITES: 'none',
            HOST: '127.0.0.1',
            PORT: '0',
            SLOTLOCK_PUBLIC_URL: 'http://localhost:8080',
          },
          stdout: { write: (chunk: string) => out.push(chunk) },
          stderr: { write: (chunk: string) => err.push(chunk) },
          // A server that does start is stopped after 3 seconds and exits 0.
          signal: AbortSignal.timeout(3_000),
        });
        const failure = err
          .join('')
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line) as Record<string, unknown>)[0];
        return {
          code,
          failure,
          listening: out.join('').includes('"listening"'),
          stderr: err.join(''),
        };
      };

      await sql`UPDATE slotlock.schema_version SET version = ${SLOTLOCK_SCHEMA_VERSION - 1}`;
      const older = await serve();
      expect(older).toMatchObject({
        code: 1,
        listening: false,
        failure: { event: 'serve_failed', code: 'schema_outdated' },
      });

      await sql`UPDATE slotlock.schema_version SET version = ${SLOTLOCK_SCHEMA_VERSION + 1}`;
      const newer = await serve();
      expect(newer).toMatchObject({
        code: 1,
        listening: false,
        failure: { event: 'serve_failed', code: 'schema_newer' },
      });

      await sql`UPDATE slotlock.schema_version SET version = ${SLOTLOCK_SCHEMA_VERSION}`;
      const current = await serve();
      expect(current).toMatchObject({ code: 0, listening: true });
    } finally {
      await sql.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
      await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  });
});
