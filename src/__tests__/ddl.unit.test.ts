import { describe, expect, it } from 'vitest';
import {
  SLOTLOCK_API_KEY_FUNCTIONS,
  SLOTLOCK_API_KEY_TABLES,
  SLOTLOCK_CORE_DDL,
  SLOTLOCK_DASHBOARD_FUNCTIONS,
  SLOTLOCK_DASHBOARD_TABLES,
  SLOTLOCK_DEFINER_FUNCTIONS,
  SLOTLOCK_DEFINER_TABLES,
  SLOTLOCK_TENANT_CONTEXT_SETTING,
  SLOTLOCK_TENANT_RLS_DDL,
  SLOTLOCK_TENANT_TABLES,
  createSlotlockApplicationRoleGrantsDdl,
  createSlotlockTenantRlsDdl,
} from '../ddl.js';

describe('tenant RLS DDL', () => {
  it('persists bounded owner namespaces and upgrades legacy event identities idempotently', () => {
    expect(SLOTLOCK_CORE_DDL).toContain("owner_ref text NOT NULL DEFAULT 'internal'");
    expect(SLOTLOCK_CORE_DDL).toContain(
      'CONSTRAINT slotlock_calendar_events_owner_external_key UNIQUE (tenant_ref, owner_ref, external_ref)',
    );
    expect(SLOTLOCK_CORE_DDL).toContain(
      'CONSTRAINT slotlock_calendar_event_tombstones_owner_key PRIMARY KEY (tenant_ref, owner_ref, external_ref)',
    );
    expect(SLOTLOCK_CORE_DDL).toContain(
      'CONSTRAINT slotlock_calendar_event_commands_owner_key PRIMARY KEY (tenant_ref, owner_ref, idempotency_key)',
    );
    expect(SLOTLOCK_CORE_DDL).toContain('ADD COLUMN IF NOT EXISTS owner_ref');
    expect(SLOTLOCK_CORE_DDL).toContain(
      "owner_ref = 'internal' OR owner_ref ~ '^agent:[0-9a-f]{64}$'",
    );
    expect(SLOTLOCK_CORE_DDL).not.toContain('octet_length(owner_ref) BETWEEN');
    expect(SLOTLOCK_CORE_DDL).toContain('prevent_calendar_event_owner_change');
    expect(SLOTLOCK_CORE_DDL).toContain('slotlock_calendar_event_commands_retention_idx');
    expect(SLOTLOCK_CORE_DDL).toContain('(tenant_ref, created_at, owner_ref, idempotency_key)');
    expect(SLOTLOCK_CORE_DDL).toContain('slotlock_calendar_event_commands_authority_idx');
    expect(SLOTLOCK_CORE_DDL).toContain('slotlock_calendar_event_tombstones_agent_retention_idx');
  });

  it('uses a consumer-neutral, fail-closed context setting by default', () => {
    expect(SLOTLOCK_TENANT_CONTEXT_SETTING).toBe('slotlock.tenant_ref');
    expect(SLOTLOCK_TENANT_RLS_DDL).toContain("current_setting('slotlock.tenant_ref', true)");
    expect(SLOTLOCK_TENANT_RLS_DDL).not.toContain('app.operator_id');
    expect(SLOTLOCK_TENANT_RLS_DDL).toContain('FORCE ROW LEVEL SECURITY');
    for (const table of [
      'calendar_events',
      'calendar_event_attendees',
      'calendar_event_reminders',
      'calendar_event_exceptions',
      'calendar_event_occurrences',
      'calendar_event_tombstones',
      'calendar_event_commands',
      'calendar_coverage',
    ]) {
      expect(SLOTLOCK_TENANT_RLS_DDL).toContain(
        `ALTER TABLE slotlock.${table} FORCE ROW LEVEL SECURITY`,
      );
      expect(SLOTLOCK_TENANT_RLS_DDL).toContain(
        `COMMENT ON POLICY tenant_isolation_v1 ON slotlock.${table}`,
      );
    }
  });

  it('lets an adapter bind policies to its existing transaction context', () => {
    const ddl = createSlotlockTenantRlsDdl('app.operator_id');
    expect(ddl).toContain("current_setting('app.operator_id', true)");
    expect(ddl).not.toContain("current_setting('slotlock.tenant_ref', true)");
    expect(ddl).toContain("'DROP POLICY %I ON slotlock.%I'");
    expect(ddl).toContain("IS 'slotlock:tenant-context:app.operator_id'");
  });

  // slotlock.caller_search_path is where the deployment DDL keeps the caller's search_path.
  it.each([
    'operator_id',
    'app.operator-id',
    "app.operator_id'); DROP SCHEMA slotlock; --",
    '',
    'slotlock.caller_search_path',
  ])('rejects unsafe or non-namespaced setting %j', (setting) => {
    expect(() => createSlotlockTenantRlsDdl(setting)).toThrow(
      'Slotlock tenant context setting must be a dotted identifier',
    );
  });
});

// The deployment role owns every table, so a function it resolves through a schema another role
// can write runs with that ownership. Its DDL resolves names in pg_catalog first and last, and only
// while it runs: a caller that keeps going in the same transaction gets its search_path back.
describe('deployment DDL name resolution', () => {
  const SAVE =
    "SELECT pg_catalog.set_config('slotlock.caller_search_path', pg_catalog.current_setting('search_path'), true);";
  const PIN = "SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);";
  const RESTORE =
    "SELECT pg_catalog.set_config('search_path', pg_catalog.current_setting('slotlock.caller_search_path'), true);";
  const CONTROL = 'DO $slotlock_schema_control$';

  it('pins search_path before its first statement and restores it after its last', () => {
    for (const ddl of [SLOTLOCK_CORE_DDL, SLOTLOCK_TENANT_RLS_DDL]) {
      expect(ddl.trimStart().startsWith(`${SAVE}\n${PIN}\n`)).toBe(true);
      expect(ddl.trimEnd().endsWith(RESTORE)).toBe(true);
    }
  });

  it('refuses a slotlock schema another role controls before anything touches it', () => {
    const objectReference = /\bslotlock\.(?!caller_search_path\b)/;
    const schema = SLOTLOCK_CORE_DDL.indexOf('CREATE SCHEMA IF NOT EXISTS slotlock;');
    const control = SLOTLOCK_CORE_DDL.indexOf(CONTROL);
    expect(schema).toBeGreaterThan(0);
    expect(control).toBeGreaterThan(schema);
    expect(SLOTLOCK_CORE_DDL.slice(0, control)).not.toMatch(objectReference);
    expect(
      SLOTLOCK_CORE_DDL.indexOf('CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA slotlock;'),
    ).toBeGreaterThan(control);
    const rlsControl = SLOTLOCK_TENANT_RLS_DDL.indexOf(CONTROL);
    expect(rlsControl).toBeGreaterThan(0);
    expect(SLOTLOCK_TENANT_RLS_DDL.slice(0, rlsControl)).not.toMatch(objectReference);
    expect(SLOTLOCK_CORE_DDL).not.toContain('pgcrypto');
  });

  it('fingerprints policies with core sha256, not an extension function found by name', () => {
    expect(SLOTLOCK_TENANT_RLS_DDL).not.toMatch(/\bdigest\(/);
    expect(SLOTLOCK_TENANT_RLS_DDL).toContain('pg_catalog.sha256(');
  });

  const functions = [
    ...SLOTLOCK_CORE_DDL.matchAll(
      /CREATE OR REPLACE FUNCTION (slotlock\.\w+)\(([^)]*)\)([\s\S]*?)\bAS \$/g,
    ),
  ];

  it('pins search_path on every function it defines', () => {
    expect(functions.length).toBeGreaterThan(0);
    for (const [, name, , header] of functions) {
      expect(`${name}: ${header}`).toContain('SET search_path = pg_catalog, slotlock, pg_temp');
    }
  });

  // A function is executable by PUBLIC unless revoked, and a SECURITY DEFINER one runs as the owner.
  it('defines the API key and dashboard functions as SECURITY DEFINER, executable by no one by default', () => {
    expect([...SLOTLOCK_DEFINER_FUNCTIONS]).toEqual([
      ...SLOTLOCK_API_KEY_FUNCTIONS,
      ...SLOTLOCK_DASHBOARD_FUNCTIONS,
    ]);
    const definers = functions.filter(([, , , header]) => header?.includes('SECURITY DEFINER'));
    expect(definers.map(([, name]) => name).sort()).toEqual(
      SLOTLOCK_DEFINER_FUNCTIONS.map((signature) => signature.slice(0, signature.indexOf('('))).sort(),
    );
    for (const signature of SLOTLOCK_DEFINER_FUNCTIONS) {
      expect(SLOTLOCK_CORE_DDL).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
    }
    for (const [, name, parameters] of functions) {
      const types = (parameters ?? '')
        .split(',')
        .map((parameter) => parameter.trim().split(/\s+/).slice(1).join(' '))
        .filter(Boolean)
        .join(', ');
      if (SLOTLOCK_DEFINER_FUNCTIONS.some((signature) => signature.startsWith(`${name}(`))) {
        expect(SLOTLOCK_DEFINER_FUNCTIONS).toContain(`${name}(${types})`);
      }
    }
  });

  it('keeps API keys and dashboard records in tables no role but their owner reads or writes', () => {
    expect([...SLOTLOCK_DEFINER_TABLES]).toEqual([...SLOTLOCK_API_KEY_TABLES, ...SLOTLOCK_DASHBOARD_TABLES]);
    for (const table of SLOTLOCK_DEFINER_TABLES) {
      expect(SLOTLOCK_CORE_DDL).toContain(`CREATE TABLE IF NOT EXISTS slotlock.${table} (`);
      expect(SLOTLOCK_CORE_DDL).toContain(`ALTER TABLE slotlock.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(SLOTLOCK_CORE_DDL).toContain(`REVOKE ALL ON slotlock.${table} FROM PUBLIC;`);
    }
    expect(SLOTLOCK_CORE_DDL).toMatch(/secret_hash bytea NOT NULL/);
    expect(SLOTLOCK_CORE_DDL).not.toMatch(/api_keys[^;]*\bkey text\b/);
    // The database holds the limits the library checks, not only the library.
    expect(SLOTLOCK_CORE_DDL).toContain("expires_at <= created_at + interval '3651 days'");
    expect(SLOTLOCK_CORE_DDL).toContain(
      "scopes IN (ARRAY['read']::text[], ARRAY['write']::text[], ARRAY['read', 'write']::text[])",
    );
  });

  it('records a dashboard token once, as a digest, for a day at most', () => {
    const use = SLOTLOCK_CORE_DDL.slice(
      SLOTLOCK_CORE_DDL.indexOf('CREATE OR REPLACE FUNCTION slotlock.use_dashboard_token('),
      SLOTLOCK_CORE_DDL.indexOf('$slotlock_use_dashboard_token$;'),
    );
    expect(SLOTLOCK_CORE_DDL).toContain('CHECK (octet_length(token_hash) = 32)');
    expect(SLOTLOCK_CORE_DDL).toContain("CHECK (kind IN ('sign_in', 'form', 'ended_session'))");
    // A recorded token that has not expired is never replaced, so the second use comes back false.
    expect(use).toContain('ON CONFLICT (kind, token_hash) DO UPDATE');
    expect(use).toContain('WHERE used.expires_at <= now()');
    expect(use).toContain('RETURN coalesce(recorded, false);');
    expect(use).toContain("LEAST(requested_expires_at, now() + interval '1 day') + interval '5 minutes'");
    // Pruning is bounded per call and never waits on a row another call holds.
    expect(use).toMatch(/LIMIT 100\s+FOR UPDATE SKIP LOCKED/);
  });

  it('creates keys only under READ COMMITTED, where its lock makes the limit count exact', () => {
    const create = SLOTLOCK_CORE_DDL.slice(
      SLOTLOCK_CORE_DDL.indexOf('CREATE OR REPLACE FUNCTION slotlock.create_api_key('),
      SLOTLOCK_CORE_DDL.indexOf('$slotlock_create_api_key$;'),
    );
    const isolation = create.indexOf("current_setting('transaction_isolation') <> 'read committed'");
    const lock = create.indexOf('pg_advisory_xact_lock(');
    const count = create.indexOf('count(*)');
    expect(isolation).toBeGreaterThan(0);
    expect(lock).toBeGreaterThan(isolation);
    expect(count).toBeGreaterThan(lock);
  });
});

describe('application role grants', () => {
  it('covers exactly the tables the core schema creates, each under forced RLS', () => {
    // rls_policy_contracts is deployment-only; the API key and dashboard tables are reached only
    // through their functions.
    const definerTables: readonly string[] = SLOTLOCK_DEFINER_TABLES;
    const created = [...SLOTLOCK_CORE_DDL.matchAll(/CREATE TABLE IF NOT EXISTS slotlock\.([a-z_]+)/g)]
      .map((match) => match[1] as string)
      .filter((table) => table !== 'rls_policy_contracts' && !definerTables.includes(table));
    expect([...SLOTLOCK_TENANT_TABLES].sort()).toEqual([...new Set(created)].sort());
    for (const table of SLOTLOCK_TENANT_TABLES) {
      expect(SLOTLOCK_TENANT_RLS_DDL).toContain(
        `ALTER TABLE slotlock.${table} FORCE ROW LEVEL SECURITY`,
      );
    }
  });

  it('grants schema usage, DML on those tables and EXECUTE on the definer functions only', () => {
    const ddl = createSlotlockApplicationRoleGrantsDdl('slotlock_app');
    expect(ddl).toBe(
      `GRANT USAGE ON SCHEMA slotlock TO "slotlock_app";\nGRANT SELECT, INSERT, UPDATE, DELETE ON ${SLOTLOCK_TENANT_TABLES.map((table) => `slotlock.${table}`).join(', ')} TO "slotlock_app";\nGRANT EXECUTE ON FUNCTION ${SLOTLOCK_DEFINER_FUNCTIONS.join(', ')} TO "slotlock_app";\n`,
    );
    for (const signature of SLOTLOCK_DASHBOARD_FUNCTIONS) expect(ddl).toContain(signature);
    expect(ddl).not.toContain('rls_policy_contracts');
    for (const table of SLOTLOCK_DEFINER_TABLES) expect(ddl).not.toContain(`slotlock.${table} `);
    for (const table of SLOTLOCK_DEFINER_TABLES) expect(ddl).not.toContain(`slotlock.${table},`);
    expect(ddl).not.toMatch(/ALL|TRUNCATE|REFERENCES|TRIGGER|CREATE|OWNER/);
  });

  it.each([
    'public',
    'PUBLIC',
    'current_user',
    'session_user',
    'current_role',
    'pg_read_all_data',
    'Slotlock_App',
    'slotlock-app',
    '1slotlock',
    'slotlock_app"; DROP SCHEMA slotlock; --',
    '',
    'k'.repeat(64),
  ])('rejects the role name %j', (role) => {
    expect(() => createSlotlockApplicationRoleGrantsDdl(role)).toThrow(
      expect.objectContaining({ code: 'invalid_role_name' }),
    );
  });
});
