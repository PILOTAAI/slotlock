import { describe, expect, it } from 'vitest';
import {
  SLOTLOCK_CORE_DDL,
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

  it('pins search_path on every function it defines', () => {
    const functions = [
      ...SLOTLOCK_CORE_DDL.matchAll(/CREATE OR REPLACE FUNCTION (slotlock\.\w+)\(\)([\s\S]*?)\bAS\b/g),
    ];
    expect(functions.length).toBeGreaterThan(0);
    for (const [, name, header] of functions) {
      expect(`${name}: ${header}`).toContain('SET search_path = pg_catalog, slotlock, pg_temp');
    }
  });
});

describe('application role grants', () => {
  it('covers exactly the tables the core schema creates, each under forced RLS', () => {
    const created = [...SLOTLOCK_CORE_DDL.matchAll(/CREATE TABLE IF NOT EXISTS slotlock\.([a-z_]+)/g)]
      .map((match) => match[1])
      .filter((table) => table !== 'rls_policy_contracts');
    expect([...SLOTLOCK_TENANT_TABLES].sort()).toEqual([...new Set(created)].sort());
    for (const table of SLOTLOCK_TENANT_TABLES) {
      expect(SLOTLOCK_TENANT_RLS_DDL).toContain(
        `ALTER TABLE slotlock.${table} FORCE ROW LEVEL SECURITY`,
      );
    }
  });

  it('grants schema usage and DML on those tables only', () => {
    const ddl = createSlotlockApplicationRoleGrantsDdl('slotlock_app');
    expect(ddl).toBe(
      `GRANT USAGE ON SCHEMA slotlock TO "slotlock_app";\nGRANT SELECT, INSERT, UPDATE, DELETE ON ${SLOTLOCK_TENANT_TABLES.map((table) => `slotlock.${table}`).join(', ')} TO "slotlock_app";\n`,
    );
    expect(ddl).not.toContain('rls_policy_contracts');
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
