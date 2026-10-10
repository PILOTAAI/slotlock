// The README's examples, executed as written: deploy as the schema owner, serve traffic as a LOGIN
// role without BYPASSRLS, and drive the agent server with the official MCP and A2A SDKs. The README
// quotes these files verbatim (readme-examples.test.ts), so a snippet that stops working fails here.
import { createServer } from 'node:net';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listResourcesOverA2a } from '../../examples/a2a-client.js';
import { startCalendarServer } from '../../examples/agent-server.js';
import { deploySlotlock } from '../../examples/deploy.js';
import { maintainTenant } from '../../examples/maintenance.js';
import { findSlotOverMcp } from '../../examples/mcp-client.js';
import { openLiveCalendar } from '../../examples/mcp-live.js';
import { bookHandover, openSlotlock, scheduleWeeklyInspection } from '../../examples/store.js';
import { slotlockCalendarResourceUri } from '../agent-server.js';
import { SLOTLOCK_CORE_DDL, SLOTLOCK_TENANT_RLS_DDL } from '../ddl.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('port')),
      );
    });
  });
}

describe.skipIf(!url)('Slotlock README examples (real Postgres)', () => {
  const role = `slotlock_example_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = crypto.randomUUID();
  const tenantRef = `example-tenant-${crypto.randomUUID()}`;
  const canaryTenantRef = `example-canary-${crypto.randomUUID()}`;
  let admin: ReturnType<typeof postgres>;
  let app: ReturnType<typeof openSlotlock>;
  let vehicleId: string;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 2, onnotice: () => {} });
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    // The test's own connection stands in for the deployment role.
    await deploySlotlock(url as string, role);
    const applicationUrl = new URL(url as string);
    applicationUrl.username = role;
    applicationUrl.password = password;
    app = openSlotlock(applicationUrl.href);
  });

  afterAll(async () => {
    await app?.sql.end();
    for (const tenant of [tenantRef, canaryTenantRef]) {
      await admin`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenant}`;
      await admin`DELETE FROM slotlock.calendar_event_occurrences WHERE tenant_ref = ${tenant}`;
      await admin`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${tenant}`;
      await admin`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${tenant}`;
      await admin`DELETE FROM slotlock.reservations WHERE tenant_ref = ${tenant}`;
      await admin`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenant}`;
    }
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('refuses to grant the application privileges to a role that bypasses RLS', async () => {
    const [self] = await admin<{ name: string }[]>`SELECT current_user AS name`;
    const deployer = createSlotlockStore(admin);
    await expect(deployer.grantApplicationRole(self?.name ?? '')).rejects.toMatchObject({
      code: 'unsafe_application_role',
    });
    await expect(deployer.grantApplicationRole('slotlock_no_such_role')).rejects.toMatchObject({
      code: 'role_not_found',
    });
  });

  it('refuses a role that can leave forced RLS itself or through a role it belongs to', async () => {
    // Membership counts: a member may SET ROLE to the role or use its privileges, and one holding
    // only ADMIN OPTION can grant itself either. Each probe is refused for the reason it names. The
    // probe roles, objects, rights and owners exist only inside a transaction that is rolled back.
    const [self] = await admin<{ name: string; database: string }[]>`
      SELECT current_user AS name, current_database() AS database`;
    const bypass = `${role}_bypass`;
    const superuser = `${role}_superuser`;
    const owner = `${role}_owner`;
    const truncate = `${role}_truncate`;
    const grouped = `${role}_grouped`;
    const harmless = [`${role}_temporary`, `${role}_own_default`, `${role}_other_default`];
    const ownsObjects = 'owner of objects in the database';
    const tableRights = 'TRUNCATE, REFERENCES or TRIGGER on a slotlock table';
    const refused: Record<string, string> = {
      [bypass]: 'BYPASSRLS',
      [`${bypass}_member`]: 'BYPASSRLS',
      [`${role}_super_member`]: 'superuser',
      [superuser]: 'superuser',
      [`${superuser}_member`]: 'superuser',
      [`${role}_replication`]: 'REPLICATION',
      [`${role}_createrole`]: 'CREATEROLE',
      [`${role}_files`]: 'member of pg_read_server_files',
      [`${role}_write_files`]: 'member of pg_write_server_files',
      [`${role}_program`]: 'member of pg_execute_server_program',
      [owner]: ownsObjects,
      [`${owner}_member`]: ownsObjects,
      [`${owner}_nested`]: ownsObjects,
      [`${role}_function`]: ownsObjects,
      [`${role}_type`]: ownsObjects,
      [`${role}_elsewhere`]: ownsObjects,
      [`${role}_schema`]: 'owner of or CREATE on schema slotlock',
      [`${role}_create`]: 'owner of or CREATE on schema slotlock',
      [`${role}_public`]: 'owner of or CREATE on schema public',
      [`${role}_database`]: 'CREATE on the database',
      [`${role}_database_owner`]: 'owner of the database',
      [truncate]: tableRights,
      [`${truncate}_member`]: tableRights,
      [`${role}_references`]: tableRights,
      [`${role}_trigger`]: tableRights,
      [`${role}_default`]: 'TRUNCATE, REFERENCES or TRIGGER by default on new slotlock tables',
      [`${role}_creator_default`]:
        'TRUNCATE, REFERENCES or TRIGGER by default on new slotlock tables',
      [`${role}_parameter`]: 'a right on server setting archive_command',
      [`${role}_extension`]: 'owner of the btree_gist extension',
    };
    const rollback = new Error('roll back the probe roles');
    const outcomes: Record<string, string> = {};
    await expect(
      admin.begin(async (tx) => {
        await tx.unsafe(`CREATE ROLE ${bypass} NOLOGIN NOSUPERUSER BYPASSRLS`);
        await tx.unsafe(`CREATE ROLE ${bypass}_member NOLOGIN NOBYPASSRLS IN ROLE ${bypass}`);
        await tx.unsafe(`CREATE ROLE ${role}_super_member NOLOGIN IN ROLE "${self?.name}"`);
        // A superuser that owns nothing: refused for the attribute alone.
        await tx.unsafe(`CREATE ROLE ${superuser} NOLOGIN SUPERUSER`);
        await tx.unsafe(`CREATE ROLE ${superuser}_member NOLOGIN NOSUPERUSER IN ROLE ${superuser}`);
        await tx.unsafe(`CREATE ROLE ${role}_replication NOLOGIN REPLICATION`);
        await tx.unsafe(`CREATE ROLE ${role}_createrole NOLOGIN CREATEROLE`);
        await tx.unsafe(`CREATE ROLE ${role}_files NOLOGIN IN ROLE pg_read_server_files`);
        await tx.unsafe(`CREATE ROLE ${role}_write_files NOLOGIN IN ROLE pg_write_server_files`);
        await tx.unsafe(`CREATE ROLE ${role}_program NOLOGIN IN ROLE pg_execute_server_program`);
        await tx.unsafe(`CREATE ROLE ${owner} NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`CREATE TABLE slotlock.${owner}_probe (id int)`);
        await tx.unsafe(`ALTER TABLE slotlock.${owner}_probe OWNER TO ${owner}`);
        await tx.unsafe(`CREATE ROLE ${owner}_member NOLOGIN NOBYPASSRLS IN ROLE ${owner}`);
        await tx.unsafe(
          `CREATE ROLE ${owner}_nested NOLOGIN NOBYPASSRLS NOINHERIT IN ROLE ${owner}_member`,
        );
        // Owning a function the tables' triggers call is enough to rewrite what every write does.
        await tx.unsafe(`CREATE ROLE ${role}_function NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(
          `CREATE FUNCTION slotlock.${role}_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
        );
        await tx.unsafe(`ALTER FUNCTION slotlock.${role}_probe() OWNER TO ${role}_function`);
        // A type's owner can attach a check to it that runs on every tenant's writes.
        await tx.unsafe(`CREATE ROLE ${role}_type NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`CREATE TYPE slotlock.${role}_kind AS ENUM ('probe')`);
        await tx.unsafe(`ALTER TYPE slotlock.${role}_kind OWNER TO ${role}_type`);
        // An object outside slotlock counts too: a function on a search path decides what a call
        // with that name runs, in every tenant's session.
        await tx.unsafe(`CREATE ROLE ${role}_elsewhere NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(
          `CREATE FUNCTION public.${role}_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
        );
        await tx.unsafe(`ALTER FUNCTION public.${role}_probe() OWNER TO ${role}_elsewhere`);
        await tx.unsafe(`CREATE ROLE ${role}_schema NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`ALTER SCHEMA slotlock OWNER TO ${role}_schema`);
        // Creating objects is the same power: in slotlock after the check ran, in public (or a schema
        // named after the deployment role, which "$user" puts on its search path) for any call.
        await tx.unsafe(`CREATE ROLE ${role}_create NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`GRANT CREATE ON SCHEMA slotlock TO ${role}_create`);
        await tx.unsafe(`CREATE ROLE ${role}_public NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`GRANT CREATE ON SCHEMA public TO ${role}_public`);
        await tx.unsafe(`CREATE ROLE ${role}_database NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`GRANT CREATE ON DATABASE "${self?.database}" TO ${role}_database`);
        // The database owner can also drop the schema btree_gist lives in, and the arbiter with it.
        await tx.unsafe(`CREATE ROLE ${role}_database_owner NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`ALTER DATABASE "${self?.database}" OWNER TO ${role}_database_owner`);
        // Rights RLS does not filter: TRUNCATE empties a table for every tenant, a foreign key
        // check reads every tenant's keys, and a trigger sees every tenant's rows.
        await tx.unsafe(`CREATE ROLE ${truncate} NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`GRANT TRUNCATE ON slotlock.calendar_event_commands TO ${truncate}`);
        await tx.unsafe(`CREATE ROLE ${truncate}_group NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`GRANT TRUNCATE ON slotlock.resources TO ${truncate}_group`);
        await tx.unsafe(
          `CREATE ROLE ${truncate}_member NOLOGIN NOBYPASSRLS NOINHERIT IN ROLE ${truncate}_group`,
        );
        await tx.unsafe(`CREATE ROLE ${role}_references NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`GRANT REFERENCES (id) ON slotlock.resources TO ${role}_references`);
        await tx.unsafe(`CREATE ROLE ${role}_trigger NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`GRANT TRIGGER ON slotlock.calendar_events TO ${role}_trigger`);
        // A default privilege hands the same rights over on the table a later release adds, set by
        // the deploying role or by any role that can create slotlock tables without owning the schema.
        await tx.unsafe(`CREATE ROLE ${role}_default NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA slotlock GRANT TRUNCATE ON TABLES TO ${role}_default`,
        );
        await tx.unsafe(`CREATE ROLE ${role}_creator NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`GRANT CREATE ON SCHEMA slotlock TO ${role}_creator`);
        await tx.unsafe(`CREATE ROLE ${role}_creator_default NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${role}_creator IN SCHEMA slotlock GRANT TRIGGER ON TABLES TO ${role}_creator_default`,
        );
        // archive_command runs a shell command as the server's operating-system user.
        await tx.unsafe(`CREATE ROLE ${role}_parameter NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`GRANT ALTER SYSTEM ON PARAMETER archive_command TO ${role}_parameter`);
        // The owner of btree_gist can DROP EXTENSION ... CASCADE, taking the exclusion constraints
        // with it. A trusted extension belongs to whoever created it, and PostgreSQL has no ALTER
        // EXTENSION ... OWNER TO, so the probe hands it over in the catalog (rolled back below).
        await tx.unsafe(`CREATE ROLE ${role}_extension NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(
          `UPDATE pg_catalog.pg_extension SET extowner = '${role}_extension'::regrole WHERE extname = 'btree_gist'`,
        );
        // A member of an ordinary group role is still an application role.
        await tx.unsafe(`CREATE ROLE ${role}_group NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`CREATE ROLE ${grouped} NOLOGIN NOBYPASSRLS IN ROLE ${role}_group`);
        // So is one that owns only what reaches no other session: a temporary table, or a default
        // privilege for tables it cannot create. Nor does another role's default privilege count
        // when that role creates no slotlock table.
        await tx.unsafe(`CREATE ROLE ${role}_temporary NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`SET LOCAL ROLE ${role}_temporary`);
        await tx.unsafe(`CREATE TEMPORARY TABLE ${role}_scratch (id integer)`);
        await tx.unsafe('RESET ROLE');
        await tx.unsafe(`CREATE ROLE ${role}_own_default NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${role}_own_default GRANT SELECT ON TABLES TO PUBLIC`,
        );
        await tx.unsafe(`CREATE ROLE ${role}_bystander NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(`CREATE ROLE ${role}_other_default NOLOGIN NOBYPASSRLS`);
        await tx.unsafe(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${role}_bystander IN SCHEMA slotlock GRANT TRUNCATE ON TABLES TO ${role}_other_default`,
        );
        const deployer = createSlotlockStore(tx);
        const grant = (candidate: string, reason = '') =>
          deployer.grantApplicationRole(candidate).then(
            () => 'granted',
            (error: { code?: string; reasons?: readonly string[] }) =>
              `${error.code}: ${error.reasons?.includes(reason) ? reason : error.reasons?.join('; ')}`,
          );
        for (const [candidate, reason] of Object.entries(refused)) {
          outcomes[candidate] = await grant(candidate, reason);
        }
        outcomes[grouped] = await grant(grouped);
        for (const control of harmless) outcomes[control] = await grant(control);
        // A right granted to PUBLIC is held by every role, the ordinary one included.
        await tx.unsafe('GRANT TRUNCATE ON slotlock.calendar_event_commands TO PUBLIC');
        outcomes.public = await grant(grouped, tableRights);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(outcomes).toEqual({
      ...Object.fromEntries(
        Object.entries(refused).map(([candidate, reason]) => [
          candidate,
          `unsafe_application_role: ${reason}`,
        ]),
      ),
      [grouped]: 'granted',
      ...Object.fromEntries(harmless.map((control) => [control, 'granted'])),
      public: `unsafe_application_role: ${tableRights}`,
    });
  });

  it('never resolves a name through a schema another role can write while it deploys', async () => {
    // A role that can create a schema can name it after the deployment role, which "$user" puts
    // first on the default search path, and plant the functions deployment SQL calls: then the next
    // release runs its code as the owner of every table. Each planted function raises instead.
    const [self] = await admin<{ name: string }[]>`SELECT current_user AS name`;
    const schema = `"${self?.name}"`;
    const rollback = new Error('roll back the planted schema');
    const observed: { pathRestored?: boolean; unpinnedFunctions?: string[] } = {};
    await expect(
      admin.begin(async (tx) => {
        const [before] = await tx<
          { path: string }[]
        >`SELECT current_setting('search_path') AS path`;
        await tx.unsafe(`CREATE SCHEMA ${schema}`);
        for (const signature of [
          'digest(text, text) RETURNS bytea',
          'hashtextextended(text, integer) RETURNS bigint',
          'obj_description(oid, text) RETURNS text',
          'concat_ws(text, name, text, text, text, text, text) RETURNS text',
        ]) {
          await tx.unsafe(
            `CREATE FUNCTION ${schema}.${signature} LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'planted function ran'; END $$`,
          );
        }
        const deployer = createSlotlockStore(tx);
        await deployer.applySchema();
        await deployer.applyTenantRls();
        await deployer.grantApplicationRole(role);
        const [after] = await tx<{ path: string }[]>`SELECT current_setting('search_path') AS path`;
        observed.pathRestored = after?.path === before?.path;
        // Slotlock's own functions resolve names only in pg_catalog and slotlock, whoever calls them.
        const unpinned = await tx<{ name: string }[]>`
          SELECT fn.proname AS name
            FROM pg_proc fn
            JOIN pg_namespace ns ON ns.oid = fn.pronamespace
           WHERE ns.nspname = 'slotlock'
             AND NOT EXISTS (SELECT 1 FROM pg_depend member
                              WHERE member.classid = 'pg_proc'::regclass
                                AND member.objid = fn.oid AND member.deptype = 'e')
             AND NOT ('search_path=pg_catalog, slotlock, pg_temp' = ANY (COALESCE(fn.proconfig, '{}')))
           ORDER BY 1`;
        observed.unpinnedFunctions = unpinned.map((row) => row.name);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(observed).toEqual({ pathRestored: true, unpinnedFunctions: [] });
  });

  it('refuses to deploy into a slotlock schema that another role controls', async () => {
    // A role that can create schemas can create `slotlock` before the first deployment, with the one
    // table the deployment writes rows into and a trigger on it. IF NOT EXISTS keeps both, and the
    // next applyTenantRls ran that trigger as the owner of every table. Owning the schema, creating
    // in it, owning an object in it, or owning what a trigger on its tables runs is the same power.
    // Each probe runs in a savepoint that is rolled back; the first renames the deployed schema away
    // so that `slotlock` is missing, as on a fresh database.
    const [self] = await admin<{ database: string }[]>`SELECT current_database() AS database`;
    const other = `${role}_other`;
    const probes: Record<string, { setup: string[]; reason: string }> = {
      precreated: {
        setup: [
          `ALTER SCHEMA slotlock RENAME TO ${role}_deployed`,
          `GRANT CREATE ON DATABASE "${self?.database}" TO ${other}`,
          `SET LOCAL ROLE ${other}`,
          'CREATE SCHEMA slotlock',
          `CREATE TABLE slotlock.rls_policy_contracts (table_name text PRIMARY KEY,
             tenant_context_setting text NOT NULL, policy_fingerprint text NOT NULL,
             installed_at timestamptz NOT NULL DEFAULT now())`,
          `CREATE FUNCTION slotlock.planted() RETURNS trigger LANGUAGE plpgsql
             AS $$ BEGIN RAISE EXCEPTION 'planted trigger ran'; END $$`,
          `CREATE TRIGGER planted BEFORE INSERT ON slotlock.rls_policy_contracts
             FOR EACH STATEMENT EXECUTE FUNCTION slotlock.planted()`,
          'RESET ROLE',
        ],
        reason: `trigger planted on slotlock.rls_policy_contracts runs slotlock.planted(), owned by ${other}`,
      },
      owner: {
        setup: [`ALTER SCHEMA slotlock OWNER TO ${other}`],
        reason: `schema slotlock is owned by ${other}`,
      },
      create: {
        setup: [`GRANT CREATE ON SCHEMA slotlock TO ${other}`],
        reason: `${other} can create objects in schema slotlock`,
      },
      public: {
        setup: ['GRANT CREATE ON SCHEMA slotlock TO PUBLIC'],
        reason: 'PUBLIC can create objects in schema slotlock',
      },
      object: {
        setup: [
          `CREATE FUNCTION slotlock.${role}_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
          `ALTER FUNCTION slotlock.${role}_probe() OWNER TO ${other}`,
        ],
        reason: `function slotlock.${role}_probe() is owned by ${other}`,
      },
      trigger: {
        setup: [
          `CREATE FUNCTION public.${role}_probe() RETURNS trigger LANGUAGE plpgsql
             AS $$ BEGIN RETURN NULL; END $$`,
          `ALTER FUNCTION public.${role}_probe() OWNER TO ${other}`,
          `CREATE TRIGGER ${role}_probe BEFORE INSERT ON slotlock.rls_policy_contracts
             FOR EACH STATEMENT EXECUTE FUNCTION public.${role}_probe()`,
        ],
        reason: `trigger ${role}_probe on slotlock.rls_policy_contracts runs public.${role}_probe(), owned by ${other}`,
      },
      // A role that may create triggers can add one after the check ran, before the deployment
      // writes a row.
      triggerRight: {
        setup: [`GRANT TRIGGER ON slotlock.rls_policy_contracts TO ${other}`],
        reason: `${other} can create triggers on slotlock.rls_policy_contracts`,
      },
      // The owner of btree_gist can DROP EXTENSION ... CASCADE, which takes the exclusion
      // constraints with it. PostgreSQL has no ALTER EXTENSION ... OWNER TO, so the probe hands the
      // extension over, into slotlock, in the catalog.
      extension: {
        setup: [
          `UPDATE pg_catalog.pg_extension SET extowner = '${other}'::regrole,
             extnamespace = 'slotlock'::regnamespace WHERE extname = 'btree_gist'`,
        ],
        reason: `extension btree_gist in schema slotlock is owned by ${other}`,
      },
    };
    // The refusal keeps the database's error (SQLSTATE 42501) as its cause.
    const settle = (operation: Promise<void>, reason: string) =>
      operation.then(
        () => 'applied',
        (error: {
          code?: string;
          reasons?: readonly string[];
          message?: string;
          cause?: { code?: string };
        }) =>
          error.code === 'unsafe_slotlock_schema'
            ? `${error.code} (${error.cause?.code}): ${error.reasons?.includes(reason) ? reason : error.reasons?.join('; ')}`
            : `${error.code}: ${error.message}`,
      );
    const rollback = new Error('roll back the probes');
    const probeRollback = new Error('roll back the probe');
    const outcomes: Record<string, string[]> = {};
    await expect(
      admin.begin(async (tx) => {
        await tx.unsafe(`CREATE ROLE ${other} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
        for (const [name, probe] of Object.entries(probes)) {
          await tx
            .savepoint(async (sp) => {
              for (const statement of probe.setup) await sp.unsafe(statement);
              const deployer = createSlotlockStore(sp);
              outcomes[name] = [
                await settle(deployer.applySchema(), probe.reason),
                await settle(deployer.applyTenantRls(), probe.reason),
              ];
              throw probeRollback;
            })
            .catch((error: unknown) => {
              if (error !== probeRollback) throw error;
            });
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(outcomes).toEqual(
      Object.fromEntries(
        Object.entries(probes).map(([name, probe]) => [
          name,
          [
            `unsafe_slotlock_schema (42501): ${probe.reason}`,
            `unsafe_slotlock_schema (42501): ${probe.reason}`,
          ],
        ]),
      ),
    );
  });

  it('restores the search_path of a transaction that runs the exported DDL', async () => {
    // An application may run the DDL inside its own migration transaction and keep going: its next
    // unqualified name must resolve as before (a host application's booking bridge does exactly this).
    const rollback = new Error('roll back the DDL');
    const paths: string[] = [];
    await expect(
      admin.begin(async (tx) => {
        await tx`SELECT set_config('search_path', 'public, pg_temp', true)`;
        for (const ddl of [SLOTLOCK_CORE_DDL, SLOTLOCK_TENANT_RLS_DDL]) {
          await tx.unsafe(ddl);
          const [row] = await tx<{ path: string }[]>`SELECT current_setting('search_path') AS path`;
          paths.push(row?.path ?? '');
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(paths).toEqual(['public, pg_temp', 'public, pg_temp']);
  });

  it('books and reads as the application role, confined to one tenant by forced RLS', async () => {
    const [who] = await app.sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(who).toEqual({ rolsuper: false, rolbypassrls: false });

    const booked = await bookHandover(app.store, tenantRef);
    vehicleId = booked.vehicle.id;
    expect(booked.handover).toMatchObject({ ok: true, revision: 1, occurrenceCount: 1 });
    expect(booked.freeBusy.busy).toEqual([
      { start: new Date('2027-03-29T09:00:00Z'), end: new Date('2027-03-29T10:00:00Z') },
    ]);
    expect(booked.freeBusy.coverage.state).toBe('complete');

    // Outside withTenant the role sees nothing; inside, another tenant's rows stay invisible.
    await expect(app.store.listResources({ tenantRef })).resolves.toEqual([]);
    await bookHandover(app.store, canaryTenantRef);
    await expect(
      app.store.withTenant(tenantRef, (tenant) =>
        tenant.listResources({ tenantRef: canaryTenantRef }),
      ),
    ).resolves.toEqual([]);
  });

  it('extends a recurring event over the rolling horizon in scheduled maintenance', async () => {
    expect(await scheduleWeeklyInspection(app.store, tenantRef, vehicleId)).toMatchObject({
      ok: true,
      occurrenceCount: 8,
    });
    expect(await maintainTenant(app.store, tenantRef)).toEqual({
      extended: 1,
      conflicts: 0,
      refused: 0,
      pruned: 0,
      capped: false,
    });
  });

  it('answers the MCP and A2A client examples over HTTP', async () => {
    const port = await freePort();
    const listener = await startCalendarServer({
      store: app.store,
      publicBaseUrl: `http://localhost:${port}/slotlock`,
      port,
      allowInsecureLocalhost: true,
      verifyToken: async (token) =>
        token === 'example-token' ? { subject: 'fleet-assistant', tenantRef } : null,
    });
    try {
      // Monday 2027-03-29, 09:00-17:00 London (BST): the 09:00-10:00 UTC handover leaves 08:00-09:00,
      // too short, so the first two-hour slot starts at 10:00 UTC.
      expect(
        await findSlotOverMcp(`http://localhost:${port}/slotlock/mcp`, 'example-token', vehicleId),
      ).toEqual({
        slot: {
          resource_id: vehicleId,
          start: '2027-03-29T10:00:00.000Z',
          end: '2027-03-29T12:00:00.000Z',
          coverage: {
            start: '2027-03-29T00:00:00.000Z',
            end: '2027-04-05T00:00:00.000Z',
            certainty: 'certain',
            reason: null,
          },
        },
      });
      await expect(
        findSlotOverMcp(`http://localhost:${port}/slotlock/mcp`, 'wrong-token', vehicleId),
      ).rejects.toThrow();

      expect(
        await listResourcesOverA2a(`http://localhost:${port}/slotlock`, 'example-token'),
      ).toEqual({
        resources: [{ id: vehicleId, external_ref: 'vehicle-42', timezone: 'Europe/London' }],
        next_cursor: null,
      });
    } finally {
      await listener.close();
    }
  });

  it('asks the person before an agent books, then tells a subscribed agent the calendar changed', async () => {
    const port = await freePort();
    const listener = await startCalendarServer({
      store: app.store,
      publicBaseUrl: `http://localhost:${port}/slotlock`,
      port,
      allowInsecureLocalhost: true,
      verifyToken: async (token) =>
        token === 'example-token' ? { subject: 'fleet-assistant', tenantRef } : null,
      confirmationSecret: 'example-confirmation-secret-0123456789abcdef',
    });
    const asked: string[] = [];
    const changes: string[] = [];
    const live = await openLiveCalendar({
      mcpUrl: `http://localhost:${port}/slotlock/mcp`,
      token: 'example-token',
      resourceId: vehicleId,
      confirm: async (message) => {
        asked.push(message);
        return true;
      },
      onChange: (uri) => changes.push(uri),
    });
    try {
      const uri = slotlockCalendarResourceUri(vehicleId);
      expect(live.watching).toEqual([uri]);
      // Two days from now, inside the 90 days the example's calendar resources look ahead.
      const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1_000);
      start.setUTCHours(13, 0, 0, 0);
      const end = new Date(start.getTime() + 60 * 60 * 1_000);
      const booked = await live.book({
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        timezone: 'Europe/London',
        title: 'Live handover',
        idempotency_key: 'live-handover',
      });
      expect(booked.isError).toBeFalsy();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(
        /^Book "Live handover" on resource .+: \d{4}-\d{2}-\d{2} 1[34]:00–1[45]:00 \(Europe\/London\)\.$/,
      );

      await vi.waitFor(() => expect(changes).toEqual([uri]), { timeout: 15_000, interval: 100 });
      expect((await live.read()).busy).toContainEqual({
        start: start.toISOString(),
        end: end.toISOString(),
      });
    } finally {
      await live.close();
      await listener.close();
    }
  }, 30_000);
});
