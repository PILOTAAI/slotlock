// Slotlock owns its schema: this DDL lives in the `slotlock` Postgres schema, is applied by
// store.applySchema, and is idempotent.
//
// The EXCLUDE constraint is the load-bearing piece: the database, not application code, arbitrates
// double-booking per resource on the half-open `[)` range.
//
// The deployment role owns every table, so a function or operator resolved through a schema another
// role can write to ("$user", public) would run with that ownership. The DDL pins search_path to
// pg_catalog and pg_temp while it runs and restores the caller's at the end. Apply it in one
// transaction: under autocommit the pin ends with its own statement.
import {
  SLOTLOCK_MAX_GROUPS_PER_RESOURCE,
  SLOTLOCK_MAX_LOCATION_DEPTH,
  SLOTLOCK_MAX_LOCATIONS,
  SLOTLOCK_MAX_RESOURCE_GROUPS,
  SLOTLOCK_POOL_ORDERS,
  SLOTLOCK_RESOURCE_KINDS,
  SLOTLOCK_RESOURCE_PROFILE_LIMITS,
} from './resource-profile.js';
import {
  SLOTLOCK_CHANGE_ORIGINS,
  SLOTLOCK_WEBHOOK_FILTER_REFS,
  SLOTLOCK_WEBHOOK_FILTER_RESOURCES,
  legacyCoverageSourceDigestSql,
} from './event-feed.js';
import { SLOTLOCK_MAX_AVAILABILITY_RULES } from './weekly-hours.js';

const CALLER_SEARCH_PATH_SETTING = 'slotlock.caller_search_path';
const DEPLOYMENT_SEARCH_PATH_PIN = `SELECT pg_catalog.set_config('${CALLER_SEARCH_PATH_SETTING}', pg_catalog.current_setting('search_path'), true);
SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
`;
const DEPLOYMENT_SEARCH_PATH_RESTORE = `SELECT pg_catalog.set_config('search_path', pg_catalog.current_setting('${CALLER_SEARCH_PATH_SETTING}'), true);
`;

// applyTenantRls forces RLS, which binds the owner too, and the deployment sets no tenant, so its
// data steps would see no rows. FORCE is lifted from the tables that have it before the first data
// step and restored after the last. The lifted tables are recorded in a table, not the session, so
// if a statement-by-statement run stops before the restore, the next deployment from any session
// restores them, and `slotlock serve` refuses to start meanwhile.
const DEPLOYMENT_LIFT_FORCED_ROW_SECURITY = `CREATE TABLE IF NOT EXISTS slotlock.deployment_lifted_row_security (
  table_name text PRIMARY KEY
);
REVOKE ALL ON slotlock.deployment_lifted_row_security FROM PUBLIC;
DO $slotlock_lift_forced_row_security$
DECLARE
  forced_table text;
BEGIN
  INSERT INTO slotlock.deployment_lifted_row_security (table_name)
  SELECT rel.relname::text
    FROM pg_catalog.pg_class rel
    JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
   WHERE ns.nspname = 'slotlock' AND rel.relkind IN ('r', 'p') AND rel.relforcerowsecurity
  ON CONFLICT (table_name) DO NOTHING;
  FOR forced_table IN
    SELECT rel.relname::text
      FROM pg_catalog.pg_class rel
      JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'slotlock' AND rel.relkind IN ('r', 'p') AND rel.relforcerowsecurity
     ORDER BY rel.relname
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE slotlock.%I NO FORCE ROW LEVEL SECURITY', forced_table);
  END LOOP;
END
$slotlock_lift_forced_row_security$;
`;
const DEPLOYMENT_RESTORE_FORCED_ROW_SECURITY = `DO $slotlock_restore_forced_row_security$
DECLARE
  forced_table text;
BEGIN
  FOR forced_table IN
    SELECT table_name FROM slotlock.deployment_lifted_row_security ORDER BY table_name
  LOOP
    IF pg_catalog.to_regclass(pg_catalog.format('slotlock.%I', forced_table)) IS NOT NULL THEN
      EXECUTE pg_catalog.format('ALTER TABLE slotlock.%I FORCE ROW LEVEL SECURITY', forced_table);
    END IF;
  END LOOP;
  DELETE FROM slotlock.deployment_lifted_row_security;
END
$slotlock_restore_forced_row_security$;
`;

/** The start of the message with which the deployment DDL refuses a `slotlock` schema. */
export const SLOTLOCK_SCHEMA_CONTROL_REFUSAL = 'Slotlock will not deploy into schema slotlock';

/**
 * The schema version this release creates, recorded in `slotlock.schema_version`. Up to 0.2
 * recorded nothing (0.1 was 1, 0.2 was 2); 0.3 to 0.5 recorded 3. 0.6 is 4, so a 0.5 release
 * refuses it rather than restoring the trigger that names a coverage source by its guessable
 * digest.
 */
export const SLOTLOCK_SCHEMA_VERSION = 4;

/** The start of the message with which the deployment DDL refuses a schema a newer release migrated. */
export const SLOTLOCK_SCHEMA_NEWER_REFUSAL =
  'Slotlock will not migrate a schema a newer release migrated';

/** The oldest PostgreSQL the DDL runs on (`server_version_num`): it uses pg_input_is_valid. */
const MIN_SERVER_VERSION_NUM = 160000;

// Before anything changes: an old server fails here with a message naming the version rather than
// midway, and a schema a newer release migrated is refused.
const SLOTLOCK_SCHEMA_PRECONDITIONS = `DO $slotlock_schema_preconditions$
DECLARE
  installed integer;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < ${MIN_SERVER_VERSION_NUM} THEN
    RAISE EXCEPTION 'Slotlock needs PostgreSQL 16 or later; this server is %',
      pg_catalog.current_setting('server_version')
      USING ERRCODE = 'feature_not_supported';
  END IF;
  IF pg_catalog.to_regclass('slotlock.schema_version') IS NOT NULL THEN
    EXECUTE 'SELECT version FROM slotlock.schema_version WHERE singleton' INTO installed;
    IF installed > ${SLOTLOCK_SCHEMA_VERSION} THEN
      RAISE EXCEPTION '${SLOTLOCK_SCHEMA_NEWER_REFUSAL} (version %; this release is version ${SLOTLOCK_SCHEMA_VERSION})', installed
        USING ERRCODE = 'object_not_in_prerequisite_state',
              HINT = 'Migrate and serve it with the release that migrated it, or a later one.';
    END IF;
  END IF;
END
$slotlock_schema_preconditions$;
`;

// The deployment writes rows as the owner of every table, firing their triggers. A role that owns
// or can create objects in the schema, owns an object or trigger function there, or may create a
// trigger could therefore run code as the deployment role; one owning an extension there could DROP
// EXTENSION ... CASCADE and take the exclusion constraints. The deployment refuses before touching
// anything, with findings as a JSON array in DETAIL. Superusers are trusted.
const SLOTLOCK_SCHEMA_CONTROL_CHECK = `DO $slotlock_schema_control$
DECLARE
  refusals text[];
BEGIN
  SELECT pg_catalog.array_agg(refusal.reason ORDER BY refusal.reason)
    INTO refusals
    FROM (
      SELECT 'schema slotlock is owned by ' || owned_by.rolname AS reason
        FROM pg_catalog.pg_namespace ns
        JOIN pg_catalog.pg_roles owned_by ON owned_by.oid = ns.nspowner
       WHERE ns.nspname = 'slotlock'
         AND owned_by.rolname <> CURRENT_USER AND NOT owned_by.rolsuper
      UNION
      SELECT COALESCE(grantee_role.rolname, 'PUBLIC') || ' can create objects in schema slotlock'
        FROM pg_catalog.pg_namespace ns
       CROSS JOIN LATERAL pg_catalog.aclexplode(ns.nspacl) acl
        LEFT JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = acl.grantee
       WHERE ns.nspname = 'slotlock'
         AND acl.privilege_type = 'CREATE'
         AND acl.grantee <> ns.nspowner
         AND (acl.grantee = 0
              OR (grantee_role.rolname <> CURRENT_USER AND NOT grantee_role.rolsuper))
      UNION
      SELECT ident.type || ' ' || ident.identity || ' is owned by ' || owned_by.rolname
        FROM pg_catalog.pg_shdepend owned
        JOIN pg_catalog.pg_roles owned_by ON owned_by.oid = owned.refobjid
       CROSS JOIN LATERAL pg_catalog.pg_identify_object(owned.classid, owned.objid, owned.objsubid) ident
       WHERE owned.dbid = (SELECT db.oid FROM pg_catalog.pg_database db
                            WHERE db.datname = pg_catalog.current_database())
         AND owned.deptype = 'o'
         AND owned.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
         AND owned_by.rolname <> CURRENT_USER AND NOT owned_by.rolsuper
         AND ident.schema = 'slotlock'
      UNION
      SELECT 'trigger ' || trg.tgname || ' on slotlock.' || rel.relname || ' runs '
             || trg.tgfoid::pg_catalog.regprocedure::pg_catalog.text
             || ', owned by ' || owned_by.rolname
        FROM pg_catalog.pg_trigger trg
        JOIN pg_catalog.pg_class rel ON rel.oid = trg.tgrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
        JOIN pg_catalog.pg_proc fn ON fn.oid = trg.tgfoid
        JOIN pg_catalog.pg_roles owned_by ON owned_by.oid = fn.proowner
       WHERE ns.nspname = 'slotlock'
         AND NOT trg.tgisinternal
         AND owned_by.rolname <> CURRENT_USER AND NOT owned_by.rolsuper
      UNION
      SELECT COALESCE(grantee_role.rolname, 'PUBLIC') || ' can create triggers on slotlock.'
             || rel.relname
        FROM pg_catalog.pg_class rel
        JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
       CROSS JOIN LATERAL pg_catalog.aclexplode(rel.relacl) acl
        LEFT JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = acl.grantee
       WHERE ns.nspname = 'slotlock'
         AND acl.privilege_type = 'TRIGGER'
         AND acl.grantee <> rel.relowner
         AND (acl.grantee = 0
              OR (grantee_role.rolname <> CURRENT_USER AND NOT grantee_role.rolsuper))
      UNION
      SELECT 'extension ' || ext.extname || ' in schema slotlock is owned by ' || owned_by.rolname
        FROM pg_catalog.pg_extension ext
        JOIN pg_catalog.pg_namespace ns ON ns.oid = ext.extnamespace
        JOIN pg_catalog.pg_roles owned_by ON owned_by.oid = ext.extowner
       WHERE ns.nspname = 'slotlock'
         AND owned_by.rolname <> CURRENT_USER AND NOT owned_by.rolsuper
    ) refusal;
  IF refusals IS NOT NULL THEN
    RAISE EXCEPTION '${SLOTLOCK_SCHEMA_CONTROL_REFUSAL}: another role controls it'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = pg_catalog.to_jsonb(refusals)::pg_catalog.text,
            HINT = 'The deployment role must own schema slotlock and every object in it, and no other role may create objects in it.';
  END IF;
END
$slotlock_schema_control$;
`;

/**
 * What every migration checks before changing anything, even when it finds nothing to change: no
 * other role controls the schema, then server and schema version. Run with search_path pinned.
 */
export const SLOTLOCK_DEPLOYMENT_CHECKS = `${SLOTLOCK_SCHEMA_CONTROL_CHECK}${SLOTLOCK_SCHEMA_PRECONDITIONS}`;

/** Active (unrevoked, unexpired) API keys one tenant may hold. */
export const SLOTLOCK_API_KEY_ACTIVE_LIMIT = 100;
/** API keys one tenant may hold in all, revoked and expired ones included, so lists stay bounded. */
export const SLOTLOCK_API_KEY_RETAINED_LIMIT = 1_000;

/**
 * The tables behind API keys. No role but their owner holds a right on them; they are reached only
 * through SLOTLOCK_API_KEY_FUNCTIONS.
 */
export const SLOTLOCK_API_KEY_TABLES = Object.freeze([
  'api_keys',
  'api_key_retired_digests',
] as const);

/**
 * The SECURITY DEFINER functions through which the serving role reaches API keys, by signature.
 * They run as the deployment role, which owns the tables.
 */
export const SLOTLOCK_API_KEY_FUNCTIONS = Object.freeze([
  'slotlock.create_api_key(text, text, text, bytea, text[], timestamptz, text)',
  'slotlock.list_api_keys(text)',
  'slotlock.rotate_api_key(text, uuid, text, bytea)',
  'slotlock.revoke_api_key(text, uuid)',
  'slotlock.authenticate_api_key(bytea)',
  'slotlock.erase_api_keys(text)',
] as const);

/**
 * The table behind the dashboard's shared records (dashboard.ts). No role but its owner holds a
 * right on it; it is reached only through SLOTLOCK_DASHBOARD_FUNCTIONS.
 */
export const SLOTLOCK_DASHBOARD_TABLES = Object.freeze(['dashboard_tokens'] as const);

/** The SECURITY DEFINER functions through which the serving role reaches the dashboard's records. */
export const SLOTLOCK_DASHBOARD_FUNCTIONS = Object.freeze([
  'slotlock.use_dashboard_token(text, bytea, timestamptz, bytea)',
  'slotlock.dashboard_session_ended(bytea, timestamptz)',
] as const);

/** Live form records one person may leave in the dashboard's records (12 hours of forms). */
export const SLOTLOCK_DASHBOARD_FORM_LIMIT = 1_000;

/** The table that records which release migrated the schema (SLOTLOCK_SCHEMA_VERSION). */
export const SLOTLOCK_SCHEMA_TABLES = Object.freeze(['schema_version'] as const);

/** The SECURITY DEFINER function through which a server reads the version it is serving. */
export const SLOTLOCK_SCHEMA_FUNCTIONS = Object.freeze([
  'slotlock.installed_schema_version()',
] as const);

/** The table of suspended tenants: they may read, and write nothing (store.ts withTenant). */
export const SLOTLOCK_TENANT_ADMIN_TABLES = Object.freeze([
  'tenant_suspensions',
  'tenant_plans',
  'plan_defaults',
  'usage_daily',
  'usage_flushes',
  'usage_cursors',
  'usage_meter_start',
  'usage_notices',
  'webhook_tenants',
  'rate_buckets',
  'assistant_tenants',
  'maintenance_tenants',
] as const);

/**
 * The SECURITY DEFINER functions through which a server checks a tenant's suspension and erases a
 * tenant, by signature.
 */
export const SLOTLOCK_TENANT_ADMIN_FUNCTIONS = Object.freeze([
  'slotlock.tenant_suspended(text)',
  'slotlock.erase_tenant(text)',
  'slotlock.register_webhook_tenant(text)',
  'slotlock.webhook_tenants(text)',
  'slotlock.unregister_webhook_tenant(text)',
  'slotlock.take_rate_token(text, double precision, double precision)',
  'slotlock.register_assistant_tenant(text, timestamptz)',
  'slotlock.sweep_assistant_conversations(integer)',
  'slotlock.list_maintenance_tenant()',
  'slotlock.maintenance_tenants(text)',
  'slotlock.tenant_plan(text)',
  'slotlock.set_tenant_plan(text, text, text, integer, integer, integer, text, text, timestamptz)',
  'slotlock.plan_default()',
  'slotlock.enrol_tenant_plan(text)',
  'slotlock.record_usage(uuid, jsonb)',
  'slotlock.roll_up_usage(text, integer)',
  'slotlock.tenant_usage(text, date, date)',
  'slotlock.tenant_quota_usage(text, date)',
  'slotlock.note_usage_threshold(text, date, text, integer, bigint, bigint)',
] as const);

/** The functions usage metering runs (SLOTLOCK_USAGE=on): serve checks it may, before it starts. */
export const SLOTLOCK_USAGE_FUNCTIONS = Object.freeze([
  'slotlock.record_usage(uuid, jsonb)',
  'slotlock.roll_up_usage(text, integer)',
  'slotlock.tenant_usage(text, date, date)',
] as const);

/** The functions quotas run (SLOTLOCK_QUOTAS=on, quotas.ts): serve checks it may, before it starts. */
export const SLOTLOCK_QUOTA_FUNCTIONS = Object.freeze([
  'slotlock.tenant_plan(text)',
  'slotlock.tenant_quota_usage(text, date)',
  'slotlock.note_usage_threshold(text, date, text, integer, bigint, bigint)',
] as const);

/** What a plan's monthly quotas count (quotas.ts): operations run and bookings made. */
export const SLOTLOCK_QUOTA_METRICS = Object.freeze(['operations', 'bookings'] as const);

/** The shares of a quota, in percent, at which a tenant is told once a month (usage.threshold_reached). */
export const SLOTLOCK_QUOTA_NOTICE_PERCENTS = Object.freeze([80, 100] as const);

/** The most bookings past the roll-up cursor one quota read counts: more than any plan allows. */
export const SLOTLOCK_QUOTA_UNROLLED_LIMIT = 100_000;

/**
 * What usage.ts meters, per tenant and day: operations run, bookings and holds committed, webhook
 * deliveries accepted, messages to the dashboard assistant, and resources held (a count each day, not
 * a sum).
 */
export const SLOTLOCK_USAGE_METRICS = Object.freeze([
  'operations',
  'bookings',
  'holds',
  'webhook_deliveries',
  'assistant_messages',
  'resources',
] as const);
/** The metrics a server counts and records (slotlock.record_usage); the rest the database counts. */
export const SLOTLOCK_RECORDED_USAGE_METRICS = Object.freeze([
  'operations',
  'webhook_deliveries',
  'assistant_messages',
] as const);
/** Days a tenant's daily usage is kept: a yearly plan, and a month for disputes after it. */
export const SLOTLOCK_USAGE_RETENTION_DAYS = 400;

/**
 * Functions only the deployment role runs: suspending and lifting a suspension, and setting the
 * hosted plan every tenant without one of its own is on. No other role is granted them, so a serving
 * role cannot lift a suspension or change the default plan.
 */
export const SLOTLOCK_OPERATOR_FUNCTIONS = Object.freeze([
  'slotlock.suspend_tenant(text, text)',
  'slotlock.unsuspend_tenant(text)',
  'slotlock.set_plan_default(text, integer, integer, integer, timestamptz)',
] as const);

/** Every SECURITY DEFINER function the serving role may execute, by signature. */
export const SLOTLOCK_DEFINER_FUNCTIONS = Object.freeze([
  ...SLOTLOCK_API_KEY_FUNCTIONS,
  ...SLOTLOCK_DASHBOARD_FUNCTIONS,
  ...SLOTLOCK_SCHEMA_FUNCTIONS,
  ...SLOTLOCK_TENANT_ADMIN_FUNCTIONS,
]);

/** Tables no role but their owner reads or writes, reached only through SLOTLOCK_DEFINER_FUNCTIONS. */
export const SLOTLOCK_DEFINER_TABLES = Object.freeze([
  ...SLOTLOCK_API_KEY_TABLES,
  ...SLOTLOCK_DASHBOARD_TABLES,
  ...SLOTLOCK_SCHEMA_TABLES,
  ...SLOTLOCK_TENANT_ADMIN_TABLES,
]);

/**
 * The advisory lock every server transaction for a tenant holds shared (store.ts withTenant), and
 * suspension and erasure take exclusively, keyed by this text's hashtextextended(…, 0).
 */
export function slotlockTenantLockKey(tenantRef: string): string {
  return `slotlock:tenant:${tenantRef}`;
}

const API_KEY_COLUMNS = `key_id uuid,
  key_tenant_ref text,
  key_name text,
  key_prefix text,
  key_scopes text[],
  key_created_by text,
  key_created_at timestamptz,
  key_expires_at timestamptz,
  key_last_used_at timestamptz,
  key_revoked_at timestamptz`;
const apiKeySelect = (alias: string) =>
  ['id', 'tenant_ref', 'name', 'prefix', 'scopes', 'created_by', 'created_at', 'expires_at']
    .concat(['last_used_at', 'revoked_at'])
    .map((column) => `${alias}.${column}`)
    .join(', ');

// API keys (api-keys.ts): SHA-256 digests only, never the key. RLS is enabled with no policy and no
// grants, so only the owner reaches the tables, through the functions below, which the serving role
// may execute.
//
// Each function takes its tenant as an argument. A call cannot reach another tenant's keys, read a
// digest, or reuse a digest rotated out or erased: those stay in api_key_retired_digests (digests
// only), and a revoked key's row stays until erasure.
const SLOTLOCK_API_KEYS_DDL = `
CREATE TABLE IF NOT EXISTS slotlock.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL,
  name text NOT NULL,
  prefix text NOT NULL,
  secret_hash bytea NOT NULL,
  scopes text[] NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT slotlock_api_keys_secret_hash_key UNIQUE (secret_hash),
  CONSTRAINT slotlock_api_keys_secret_hash_valid CHECK (octet_length(secret_hash) = 32),
  CONSTRAINT slotlock_api_keys_tenant_ref_valid
    CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500 AND tenant_ref !~ '[[:cntrl:]]'),
  CONSTRAINT slotlock_api_keys_name_valid
    CHECK (char_length(name) BETWEEN 1 AND 100 AND name !~ '[[:cntrl:]]'),
  CONSTRAINT slotlock_api_keys_prefix_valid CHECK (prefix ~ '^slk_[0-9A-Za-z]{8}$'),
  -- A non-empty list of read, write and admin, each once, in that order (api-keys.ts).
  CONSTRAINT slotlock_api_keys_scopes_known
    CHECK (scopes IN (
      ARRAY['read']::text[], ARRAY['write']::text[], ARRAY['admin']::text[],
      ARRAY['read', 'write']::text[], ARRAY['read', 'admin']::text[], ARRAY['write', 'admin']::text[],
      ARRAY['read', 'write', 'admin']::text[]
    )),
  CONSTRAINT slotlock_api_keys_created_by_valid
    CHECK (created_by IS NULL OR (octet_length(created_by) BETWEEN 1 AND 200
                                  AND created_by !~ '[[:cntrl:]]')),
  -- Ten years, plus a day for clock skew between the application and the database.
  CONSTRAINT slotlock_api_keys_expiry_valid
    CHECK (expires_at IS NULL
           OR (expires_at > created_at AND expires_at <= created_at + interval '3651 days'))
);
CREATE INDEX IF NOT EXISTS slotlock_api_keys_tenant_idx
  ON slotlock.api_keys (tenant_ref, created_at DESC, id DESC);
ALTER TABLE slotlock.api_keys ENABLE ROW LEVEL SECURITY;

-- Schemas from 0.1 allow only read and write. The CHECK with admin admits every row the old one
-- did, so it is added NOT VALID (no table scan under the lock) and the old one dropped in the same
-- transaction.
DO $slotlock_api_key_scopes$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_api_keys_scopes_known'
       AND conrelid = 'slotlock.api_keys'::regclass
  ) THEN
    ALTER TABLE slotlock.api_keys
      ADD CONSTRAINT slotlock_api_keys_scopes_known CHECK (scopes IN (
      ARRAY['read']::text[], ARRAY['write']::text[], ARRAY['admin']::text[],
      ARRAY['read', 'write']::text[], ARRAY['read', 'admin']::text[], ARRAY['write', 'admin']::text[],
      ARRAY['read', 'write', 'admin']::text[]
    )) NOT VALID;
  END IF;
  ALTER TABLE slotlock.api_keys DROP CONSTRAINT IF EXISTS slotlock_api_keys_scopes_valid;
END
$slotlock_api_key_scopes$;
REVOKE ALL ON slotlock.api_keys FROM PUBLIC;

CREATE TABLE IF NOT EXISTS slotlock.api_key_retired_digests (
  secret_hash bytea PRIMARY KEY CHECK (octet_length(secret_hash) = 32),
  retired_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE slotlock.api_key_retired_digests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.api_key_retired_digests FROM PUBLIC;

-- The per-tenant lock serializes creations. Under READ COMMITTED each statement after it takes a new
-- snapshot, so the limit counts see every key created before the lock was granted; under REPEATABLE
-- READ or SERIALIZABLE the snapshot predates the lock, so the function refuses to run there (the
-- store runs it in a READ COMMITTED transaction of its own). No row comes back at a limit.
CREATE OR REPLACE FUNCTION slotlock.create_api_key(
  requested_tenant_ref text,
  requested_name text,
  requested_prefix text,
  requested_secret_hash bytea,
  requested_scopes text[],
  requested_expires_at timestamptz,
  requested_created_by text
)
RETURNS TABLE (${API_KEY_COLUMNS})
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_create_api_key$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Slotlock creates API keys only in a READ COMMITTED transaction'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:api-keys:' || requested_tenant_ref, 0));
  IF EXISTS (SELECT 1 FROM slotlock.tenant_suspensions suspended
              WHERE suspended.tenant_ref = requested_tenant_ref) THEN
    RAISE EXCEPTION 'Slotlock tenant is suspended: it gets no new API key'
      USING ERRCODE = 'insufficient_privilege', HINT = 'tenant_suspended';
  END IF;
  IF EXISTS (SELECT 1 FROM slotlock.api_key_retired_digests retired
              WHERE retired.secret_hash = requested_secret_hash) THEN
    RAISE EXCEPTION 'Slotlock never uses a retired API key digest again'
      USING ERRCODE = 'unique_violation';
  END IF;
  RETURN QUERY
  INSERT INTO slotlock.api_keys AS created (
    tenant_ref, name, prefix, secret_hash, scopes, expires_at, created_by
  )
  SELECT requested_tenant_ref, requested_name, requested_prefix, requested_secret_hash,
         requested_scopes, requested_expires_at, requested_created_by
   WHERE (SELECT count(*) FROM slotlock.api_keys active
           WHERE active.tenant_ref = requested_tenant_ref
             AND active.revoked_at IS NULL
             AND (active.expires_at IS NULL OR active.expires_at > now())
         ) < LEAST(${SLOTLOCK_API_KEY_ACTIVE_LIMIT}, COALESCE(
           (SELECT plan.max_api_keys FROM slotlock.tenant_plan(requested_tenant_ref) plan),
           ${SLOTLOCK_API_KEY_ACTIVE_LIMIT}))
     AND (SELECT count(*) FROM slotlock.api_keys kept
           WHERE kept.tenant_ref = requested_tenant_ref
         ) < ${SLOTLOCK_API_KEY_RETAINED_LIMIT}
  RETURNING ${apiKeySelect('created')};
END
$slotlock_create_api_key$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[0]} FROM PUBLIC;

CREATE OR REPLACE FUNCTION slotlock.list_api_keys(requested_tenant_ref text)
RETURNS TABLE (${API_KEY_COLUMNS})
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_list_api_keys$
  SELECT ${apiKeySelect('listed')}
    FROM slotlock.api_keys listed
   WHERE listed.tenant_ref = requested_tenant_ref
   ORDER BY listed.created_at DESC, listed.id DESC;
$slotlock_list_api_keys$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[1]} FROM PUBLIC;

-- A new secret for an active key: same id, scopes and expiry. The old digest is retired for good.
CREATE OR REPLACE FUNCTION slotlock.rotate_api_key(
  requested_tenant_ref text,
  requested_id uuid,
  requested_prefix text,
  requested_secret_hash bytea
)
RETURNS TABLE (${API_KEY_COLUMNS})
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_rotate_api_key$
DECLARE
  retiring bytea;
BEGIN
  -- Ordered with suspension, which takes this lock too.
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:api-keys:' || requested_tenant_ref, 0));
  IF EXISTS (SELECT 1 FROM slotlock.tenant_suspensions suspended
              WHERE suspended.tenant_ref = requested_tenant_ref) THEN
    RAISE EXCEPTION 'Slotlock tenant is suspended: it gets no new API key secret'
      USING ERRCODE = 'insufficient_privilege', HINT = 'tenant_suspended';
  END IF;
  IF EXISTS (SELECT 1 FROM slotlock.api_key_retired_digests retired
              WHERE retired.secret_hash = requested_secret_hash) THEN
    RAISE EXCEPTION 'Slotlock never uses a retired API key digest again'
      USING ERRCODE = 'unique_violation';
  END IF;
  SELECT rotating.secret_hash INTO retiring
    FROM slotlock.api_keys rotating
   WHERE rotating.tenant_ref = requested_tenant_ref
     AND rotating.id = requested_id
     AND rotating.revoked_at IS NULL
     AND (rotating.expires_at IS NULL OR rotating.expires_at > now())
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO slotlock.api_key_retired_digests (secret_hash) VALUES (retiring)
    ON CONFLICT DO NOTHING;
  RETURN QUERY
  UPDATE slotlock.api_keys rotated
     SET secret_hash = requested_secret_hash, prefix = requested_prefix, last_used_at = NULL
   WHERE rotated.id = requested_id
  RETURNING ${apiKeySelect('rotated')};
END
$slotlock_rotate_api_key$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[2]} FROM PUBLIC;

-- Idempotent: a revoked key keeps its first revocation time. Another tenant's id matches no row.
CREATE OR REPLACE FUNCTION slotlock.revoke_api_key(requested_tenant_ref text, requested_id uuid)
RETURNS TABLE (${API_KEY_COLUMNS})
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_revoke_api_key$
  UPDATE slotlock.api_keys
     SET revoked_at = now()
   WHERE tenant_ref = requested_tenant_ref AND id = requested_id AND revoked_at IS NULL;
  SELECT ${apiKeySelect('revoked')}
    FROM slotlock.api_keys revoked
   WHERE revoked.tenant_ref = requested_tenant_ref AND revoked.id = requested_id;
$slotlock_revoke_api_key$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[3]} FROM PUBLIC;

-- last_used_at moves at most once a minute, so a busy key does not write on every request.
CREATE OR REPLACE FUNCTION slotlock.authenticate_api_key(presented_secret_hash bytea)
RETURNS TABLE (key_id uuid, key_tenant_ref text, key_scopes text[])
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_authenticate_api_key$
  UPDATE slotlock.api_keys
     SET last_used_at = now()
   WHERE secret_hash = presented_secret_hash
     AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > now())
     AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');
  SELECT id, tenant_ref, scopes
    FROM slotlock.api_keys
   WHERE secret_hash = presented_secret_hash
     AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > now());
$slotlock_authenticate_api_key$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[4]} FROM PUBLIC;

-- Tenant erasure: every key the tenant holds, revoked and expired ones included. Their digests are
-- retired, so no erased key can be created again.
CREATE OR REPLACE FUNCTION slotlock.erase_api_keys(requested_tenant_ref text)
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_erase_api_keys$
  WITH erased AS (
    DELETE FROM slotlock.api_keys WHERE tenant_ref = requested_tenant_ref RETURNING secret_hash
  ), retired AS (
    INSERT INTO slotlock.api_key_retired_digests (secret_hash)
    SELECT secret_hash FROM erased
    ON CONFLICT DO NOTHING
  )
  SELECT count(*) FROM erased;
$slotlock_erase_api_keys$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[5]} FROM PUBLIC;

-- A key created, given a new secret or revoked appends to its tenant's feed (key.created,
-- key.rotated, key.revoked): its id, scopes and expiry, never its digest, prefix or name. Only the
-- functions above write keys, as the schema's owner, which forced row-level security on the feed
-- binds too: the row is appended under the tenant's name in every setting a policy reads, and the
-- caller's values are put back after. Who did it is the caller's actor, else the key's creator.
CREATE OR REPLACE FUNCTION slotlock.outbox_api_key_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_outbox_api_key$
DECLARE
  kind text;
  setting text;
  previous jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    kind := 'key.created';
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    kind := 'key.revoked';
  ELSIF OLD.secret_hash IS DISTINCT FROM NEW.secret_hash THEN
    kind := 'key.rotated';
  ELSE
    RETURN NULL;
  END IF;
  FOR setting IN
    SELECT DISTINCT contract.tenant_context_setting FROM slotlock.rls_policy_contracts contract
  LOOP
    previous := previous || jsonb_build_object(setting, current_setting(setting, true));
    PERFORM set_config(setting, NEW.tenant_ref, true);
  END LOOP;
  INSERT INTO slotlock.outbox (tenant_ref, type, subject, data, actor)
  VALUES (
    NEW.tenant_ref, kind, NEW.id::text,
    jsonb_build_object(
      'id', NEW.id, 'scopes', to_jsonb(NEW.scopes), 'expires_at', NEW.expires_at,
      'revoked_at', NEW.revoked_at),
    COALESCE(NULLIF(current_setting('slotlock.actor', true), ''),
             CASE WHEN TG_OP = 'INSERT' THEN NEW.created_by END)
  );
  FOR setting IN SELECT jsonb_object_keys(previous) LOOP
    PERFORM set_config(setting, COALESCE(previous ->> setting, ''), true);
  END LOOP;
  RETURN NULL;
END
$slotlock_outbox_api_key$;
CREATE OR REPLACE TRIGGER slotlock_outbox_api_key_change
  AFTER INSERT OR UPDATE OF revoked_at, secret_hash ON slotlock.api_keys
  FOR EACH ROW EXECUTE FUNCTION slotlock.outbox_api_key_change();
`;

// The dashboard's shared records (dashboard.ts): finished sign-ins (a callback works once), sent
// forms (run once) and signed-out sessions (a copied cookie stays out), each a SHA-256 digest; form
// records also carry the sender's digest so the database can cap them. RLS with no policy and no
// grants: reached only through the two functions below.
//
// The database's clock decides: server clocks may drift, so the functions refuse a token the
// database's clock says has expired, or one claiming to outlive a day, and keep each record until
// exactly that expiry.
const SLOTLOCK_DASHBOARD_DDL = `
CREATE TABLE IF NOT EXISTS slotlock.dashboard_tokens (
  kind text NOT NULL,
  token_hash bytea NOT NULL,
  owner_hash bytea,
  expires_at timestamptz NOT NULL,
  CONSTRAINT slotlock_dashboard_tokens_pkey PRIMARY KEY (kind, token_hash),
  CONSTRAINT slotlock_dashboard_tokens_kind_valid
    CHECK (kind IN ('sign_in', 'form', 'ended_session', 'confirmation')),
  CONSTRAINT slotlock_dashboard_tokens_hash_valid CHECK (octet_length(token_hash) = 32),
  CONSTRAINT slotlock_dashboard_tokens_owner_valid
    CHECK (owner_hash IS NULL OR octet_length(owner_hash) = 32),
  CONSTRAINT slotlock_dashboard_tokens_form_owner CHECK (kind <> 'form' OR owner_hash IS NOT NULL)
);
-- 0.3.1 records accepted write confirmations here too (kind 'confirmation'). A schema from an
-- earlier release has the narrower check; replace it only then, so a migration with nothing to
-- change takes no lock on the table.
DO $slotlock_dashboard_token_kinds$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.dashboard_tokens'::regclass
       AND conname = 'slotlock_dashboard_tokens_kind_valid'
       AND pg_catalog.pg_get_constraintdef(oid) LIKE '%confirmation%'
  ) THEN
    ALTER TABLE slotlock.dashboard_tokens DROP CONSTRAINT IF EXISTS slotlock_dashboard_tokens_kind_valid;
    ALTER TABLE slotlock.dashboard_tokens ADD CONSTRAINT slotlock_dashboard_tokens_kind_valid
      CHECK (kind IN ('sign_in', 'form', 'ended_session', 'confirmation'));
  END IF;
END
$slotlock_dashboard_token_kinds$;
CREATE INDEX IF NOT EXISTS slotlock_dashboard_tokens_expiry_idx
  ON slotlock.dashboard_tokens (expires_at);
CREATE INDEX IF NOT EXISTS slotlock_dashboard_tokens_owner_idx
  ON slotlock.dashboard_tokens (owner_hash, expires_at) WHERE owner_hash IS NOT NULL;
ALTER TABLE slotlock.dashboard_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.dashboard_tokens FROM PUBLIC;

-- True the first time a live token is recorded; false while it stays recorded, and for a token the
-- database's clock holds expired or that claims to outlive a day (nothing is stored then). Racing
-- calls for one token meet at the primary key: the second waits for the first to commit, then finds
-- its row. A person's form records are counted under a lock on that person, so racing forms on any
-- number of servers stop at ${SLOTLOCK_DASHBOARD_FORM_LIMIT} live ones; past that the call fails
-- with program_limit_exceeded. The count is exact only under READ COMMITTED (each statement after
-- the lock sees every record committed before it), so the function refuses to run under anything
-- else. Each call deletes up to 100 expired rows, so the table holds what is live and little more.
CREATE OR REPLACE FUNCTION slotlock.use_dashboard_token(
  requested_kind text,
  requested_hash bytea,
  requested_expires_at timestamptz,
  requested_owner_hash bytea
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_use_dashboard_token$
DECLARE
  recorded boolean;
BEGIN
  IF requested_expires_at IS NULL
     OR requested_expires_at <= now()
     OR requested_expires_at > now() + interval '1 day' THEN
    RETURN false;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Slotlock records dashboard tokens only in a READ COMMITTED transaction'
      USING ERRCODE = 'invalid_transaction_state';
  END IF;
  DELETE FROM slotlock.dashboard_tokens stale
   WHERE (stale.kind, stale.token_hash) IN (
     SELECT expired.kind, expired.token_hash
       FROM slotlock.dashboard_tokens expired
      WHERE expired.expires_at <= now()
      LIMIT 100
        FOR UPDATE SKIP LOCKED);
  IF requested_kind = 'form' AND requested_owner_hash IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('slotlock:dashboard-forms:' || encode(requested_owner_hash, 'hex'), 0));
    IF (SELECT count(*) FROM slotlock.dashboard_tokens live
         WHERE live.owner_hash = requested_owner_hash
           AND live.kind = 'form'
           AND live.expires_at > now()) >= ${SLOTLOCK_DASHBOARD_FORM_LIMIT} THEN
      RAISE EXCEPTION 'Slotlock dashboard form limit reached'
        USING ERRCODE = 'program_limit_exceeded';
    END IF;
  END IF;
  INSERT INTO slotlock.dashboard_tokens (kind, token_hash, owner_hash, expires_at)
  VALUES (requested_kind, requested_hash, requested_owner_hash, requested_expires_at)
  ON CONFLICT (kind, token_hash) DO NOTHING
  RETURNING true INTO recorded;
  RETURN coalesce(recorded, false);
END
$slotlock_use_dashboard_token$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[0]} FROM PUBLIC;

-- Whether a session is over: signed out, or past its expiry by the database's clock (or claiming to
-- outlive a day), whatever the clock of the server asking.
CREATE OR REPLACE FUNCTION slotlock.dashboard_session_ended(
  requested_hash bytea,
  requested_expires_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_dashboard_session_ended$
  SELECT requested_expires_at IS NULL
      OR requested_expires_at <= now()
      OR requested_expires_at > now() + interval '1 day'
      OR EXISTS (
           SELECT 1 FROM slotlock.dashboard_tokens ended
            WHERE ended.kind = 'ended_session'
              AND ended.token_hash = requested_hash
              AND ended.expires_at > now());
$slotlock_dashboard_session_ended$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[1]} FROM PUBLIC;
`;

// The schema's version: one row, written by the DDL itself, so running SLOTLOCK_CORE_DDL directly
// is versioned too. applySchema adds digests of the DDL and catalog so a later no-op migration can
// skip without locking. RLS with no policy and no grants: read only through
// installed_schema_version().
const SLOTLOCK_SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS slotlock.schema_version (
  singleton boolean PRIMARY KEY DEFAULT true,
  version integer NOT NULL,
  ddl_sha256 text,
  catalog_sha256 text,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotlock_schema_version_singleton CHECK (singleton),
  CONSTRAINT slotlock_schema_version_valid CHECK (version > 0)
);
ALTER TABLE slotlock.schema_version ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.schema_version FROM PUBLIC;
-- The rename of coverage changes earlier releases wrote (0.6, slotlockCoverageChangeRenameSql): the
-- last outbox id a pass has read (null before the first), and whether it is done. A pass after the
-- first that finds nothing to rename marks it done, and no migration reads the outbox for it again.
ALTER TABLE slotlock.schema_version ADD COLUMN IF NOT EXISTS coverage_changes_renamed_through bigint;
ALTER TABLE slotlock.schema_version
  ADD COLUMN IF NOT EXISTS coverage_changes_renamed boolean NOT NULL DEFAULT false;

-- NULL when no migration has recorded a version (a schema from 0.2 or earlier).
CREATE OR REPLACE FUNCTION slotlock.installed_schema_version()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_installed_schema_version$
  SELECT version FROM slotlock.schema_version WHERE singleton;
$slotlock_installed_schema_version$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_SCHEMA_FUNCTIONS[0]} FROM PUBLIC;
`;

// Tenant suspension and erasure. A suspended tenant may read and write nothing; its keys still
// authenticate but it gets no new key. The table names tenants and reasons, so RLS with no policy
// and no grants: servers read it only through tenant_suspended(), and only the deployment role
// (owner) suspends. Erasure keeps the suspension.
//
// Every server transaction for a tenant holds its lock shared before reading the suspension;
// suspension and erasure take it exclusively, so a suspension waits for transactions in flight and
// every later one sees it.
const SLOTLOCK_TENANT_ADMIN_DDL = `
CREATE TABLE IF NOT EXISTS slotlock.tenant_suspensions (
  tenant_ref text PRIMARY KEY,
  reason text,
  suspended_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotlock_tenant_suspensions_tenant_ref_valid
    CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500),
  CONSTRAINT slotlock_tenant_suspensions_reason_valid
    CHECK (reason IS NULL OR (char_length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'))
);
ALTER TABLE slotlock.tenant_suspensions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.tenant_suspensions FROM PUBLIC;

CREATE OR REPLACE FUNCTION slotlock.tenant_suspended(requested_tenant_ref text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_tenant_suspended$
  SELECT EXISTS (
    SELECT 1 FROM slotlock.tenant_suspensions suspended
     WHERE suspended.tenant_ref = requested_tenant_ref
  );
$slotlock_tenant_suspended$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[0]} FROM PUBLIC;

-- A hosted tenant's plan (plans.ts): the limits it buys, set from its Stripe subscription. A tenant
-- with no row is on the deployment's default plan (plan_defaults) once that applies, and otherwise
-- has no plan limits; self-hosted Slotlock writes neither.
CREATE TABLE IF NOT EXISTS slotlock.tenant_plans (
  tenant_ref text PRIMARY KEY,
  plan text NOT NULL,
  status text NOT NULL,
  max_resources integer NOT NULL,
  max_api_keys integer NOT NULL,
  max_webhook_endpoints integer NOT NULL,
  stripe_customer text,
  stripe_subscription text,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_tenant_plans_tenant_ref_valid
    CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500),
  CONSTRAINT slotlock_tenant_plans_plan_valid CHECK (plan IN ('free', 'developer')),
  CONSTRAINT slotlock_tenant_plans_status_valid CHECK (status IN ('active', 'past_due', 'canceled')),
  CONSTRAINT slotlock_tenant_plans_limits_valid CHECK (
    max_resources BETWEEN 1 AND 100000
    AND max_api_keys BETWEEN 1 AND ${SLOTLOCK_API_KEY_ACTIVE_LIMIT}
    AND max_webhook_endpoints BETWEEN 1 AND 1000
  ),
  CONSTRAINT slotlock_tenant_plans_stripe_valid CHECK (
    (stripe_customer IS NULL OR stripe_customer ~ '^cus_[A-Za-z0-9]{1,250}$')
    AND (stripe_subscription IS NULL OR stripe_subscription ~ '^sub_[A-Za-z0-9]{1,250}$')
  )
);
ALTER TABLE slotlock.tenant_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.tenant_plans FROM PUBLIC;

-- The plan a hosted deployment puts every tenant without a row of its own on, from applies_from:
-- one row or none. Both servers read it through tenant_plan, so a limit holds whichever one a write
-- comes through. Only the deployment role sets it (set_plan_default, \`slotlock plan default\`).
CREATE TABLE IF NOT EXISTS slotlock.plan_defaults (
  only_row boolean PRIMARY KEY DEFAULT true,
  plan text NOT NULL,
  max_resources integer NOT NULL,
  max_api_keys integer NOT NULL,
  max_webhook_endpoints integer NOT NULL,
  applies_from timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_plan_defaults_one_row CHECK (only_row),
  CONSTRAINT slotlock_plan_defaults_plan_valid CHECK (plan IN ('free', 'developer')),
  CONSTRAINT slotlock_plan_defaults_limits_valid CHECK (
    max_resources BETWEEN 1 AND 100000
    AND max_api_keys BETWEEN 1 AND ${SLOTLOCK_API_KEY_ACTIVE_LIMIT}
    AND max_webhook_endpoints BETWEEN 1 AND 1000
  )
);
ALTER TABLE slotlock.plan_defaults ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.plan_defaults FROM PUBLIC;

-- The tenant's own plan, or the default once it applies; no row when neither does.
CREATE OR REPLACE FUNCTION slotlock.tenant_plan(requested_tenant_ref text)
RETURNS TABLE (
  plan text, status text, max_resources integer, max_api_keys integer,
  max_webhook_endpoints integer, stripe_customer text, stripe_subscription text,
  current_period_end timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_tenant_plan$
  SELECT current.plan, current.status, current.max_resources, current.max_api_keys,
         current.max_webhook_endpoints, current.stripe_customer, current.stripe_subscription,
         current.current_period_end
    FROM slotlock.tenant_plans current
   WHERE current.tenant_ref = requested_tenant_ref
  UNION ALL
  SELECT fallback.plan, 'active', fallback.max_resources, fallback.max_api_keys,
         fallback.max_webhook_endpoints, NULL, NULL, NULL
    FROM slotlock.plan_defaults fallback
   WHERE fallback.applies_from <= statement_timestamp()
     AND NOT EXISTS (SELECT 1 FROM slotlock.tenant_plans current
                      WHERE current.tenant_ref = requested_tenant_ref);
$slotlock_tenant_plan$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[10]} FROM PUBLIC;

-- The default plan and when it applies, for the dashboard and \`slotlock plan status\`.
CREATE OR REPLACE FUNCTION slotlock.plan_default()
RETURNS TABLE (
  plan text, max_resources integer, max_api_keys integer, max_webhook_endpoints integer,
  applies_from timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_plan_default$
  SELECT fallback.plan, fallback.max_resources, fallback.max_api_keys,
         fallback.max_webhook_endpoints, fallback.applies_from
    FROM slotlock.plan_defaults fallback;
$slotlock_plan_default$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[12]} FROM PUBLIC;

-- Before the default applies to every tenant, a new one is put on it at once: one with no API key
-- (ever), no row in the feed or anything maintenance lists, and no webhook. Existing tenants keep
-- what they had until applies_from, as the notice given to them says. True when a plan was written.
-- Under the key lock, so a key being issued is either counted here or sees the plan.
CREATE OR REPLACE FUNCTION slotlock.enrol_tenant_plan(requested_tenant_ref text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_enrol_tenant_plan$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:api-keys:' || requested_tenant_ref, 0));
  INSERT INTO slotlock.tenant_plans (
    tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints
  )
  SELECT requested_tenant_ref, fallback.plan, 'active', fallback.max_resources,
         fallback.max_api_keys, fallback.max_webhook_endpoints
    FROM slotlock.plan_defaults fallback
   WHERE fallback.applies_from > statement_timestamp()
     AND NOT EXISTS (SELECT 1 FROM slotlock.api_keys issued
                      WHERE issued.tenant_ref = requested_tenant_ref)
     AND NOT EXISTS (SELECT 1 FROM slotlock.maintenance_tenants listed
                      WHERE listed.tenant_ref = requested_tenant_ref)
     AND NOT EXISTS (SELECT 1 FROM slotlock.webhook_tenants hooked
                      WHERE hooked.tenant_ref = requested_tenant_ref)
  ON CONFLICT (tenant_ref) DO NOTHING;
  RETURN FOUND;
END
$slotlock_enrol_tenant_plan$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[13]} FROM PUBLIC;

-- Sets the default plan, or removes it with a null plan. Runs as its caller: only the deployment
-- role, which owns the table, can.
CREATE OR REPLACE FUNCTION slotlock.set_plan_default(
  requested_plan text,
  requested_max_resources integer,
  requested_max_api_keys integer,
  requested_max_webhook_endpoints integer,
  requested_applies_from timestamptz
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_set_plan_default$
BEGIN
  IF requested_plan IS NULL THEN
    DELETE FROM slotlock.plan_defaults;
    RETURN;
  END IF;
  INSERT INTO slotlock.plan_defaults AS current (
    only_row, plan, max_resources, max_api_keys, max_webhook_endpoints, applies_from, updated_at
  )
  VALUES (
    true, requested_plan, requested_max_resources, requested_max_api_keys,
    requested_max_webhook_endpoints, requested_applies_from, statement_timestamp()
  )
  ON CONFLICT (only_row) DO UPDATE
  SET plan = EXCLUDED.plan,
      max_resources = EXCLUDED.max_resources,
      max_api_keys = EXCLUDED.max_api_keys,
      max_webhook_endpoints = EXCLUDED.max_webhook_endpoints,
      applies_from = EXCLUDED.applies_from,
      updated_at = EXCLUDED.updated_at;
END
$slotlock_set_plan_default$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_OPERATOR_FUNCTIONS[2]} FROM PUBLIC;

-- Sets the tenant's plan as its billing says it is now (the dashboard's Stripe webhook). Under the
-- key lock, so a key being issued counts against the plan before or after, never between.
CREATE OR REPLACE FUNCTION slotlock.set_tenant_plan(
  requested_tenant_ref text,
  requested_plan text,
  requested_status text,
  requested_max_resources integer,
  requested_max_api_keys integer,
  requested_max_webhook_endpoints integer,
  requested_stripe_customer text,
  requested_stripe_subscription text,
  requested_period_end timestamptz
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_set_tenant_plan$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:api-keys:' || requested_tenant_ref, 0));
  INSERT INTO slotlock.tenant_plans AS current (
    tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints,
    stripe_customer, stripe_subscription, current_period_end, updated_at
  )
  VALUES (
    requested_tenant_ref, requested_plan, requested_status, requested_max_resources,
    requested_max_api_keys, requested_max_webhook_endpoints, requested_stripe_customer,
    requested_stripe_subscription, requested_period_end, statement_timestamp()
  )
  ON CONFLICT (tenant_ref) DO UPDATE
  SET plan = EXCLUDED.plan,
      status = EXCLUDED.status,
      max_resources = EXCLUDED.max_resources,
      max_api_keys = EXCLUDED.max_api_keys,
      max_webhook_endpoints = EXCLUDED.max_webhook_endpoints,
      stripe_customer = COALESCE(EXCLUDED.stripe_customer, current.stripe_customer),
      stripe_subscription = EXCLUDED.stripe_subscription,
      current_period_end = EXCLUDED.current_period_end,
      updated_at = EXCLUDED.updated_at;
END
$slotlock_set_tenant_plan$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[11]} FROM PUBLIC;

-- A tenant's use of the service (usage.ts), by UTC day: operations its keys and the assistant ran
-- (recorded by the servers), and the bookings and holds it committed (rolled up from its feed). By
-- API key ('' for none) and surface. Counts only, never what was asked; owner-only, read and written
-- through the functions below, erased with the tenant, kept ${SLOTLOCK_USAGE_RETENTION_DAYS} days.
CREATE TABLE IF NOT EXISTS slotlock.usage_daily (
  tenant_ref text NOT NULL,
  day date NOT NULL,
  metric text NOT NULL,
  key_id text NOT NULL DEFAULT '',
  origin text NOT NULL,
  count bigint NOT NULL,
  CONSTRAINT slotlock_usage_daily_pkey PRIMARY KEY (tenant_ref, day, metric, key_id, origin),
  CONSTRAINT slotlock_usage_daily_tenant_ref_valid CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500),
  CONSTRAINT slotlock_usage_daily_key_id_valid
    CHECK (key_id = '' OR key_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT slotlock_usage_daily_origin_valid CHECK (origin ~ '^[a-z][a-z-]{0,39}$'),
  CONSTRAINT slotlock_usage_daily_count_valid CHECK (count > 0)
);
-- The metrics it takes, and no other. Its comment is the list it was built from: a release that
-- adds a metric replaces it (NOT VALID, so nothing is scanned under the lock; validated after).
DO $slotlock_usage_daily_metric$
BEGIN
  ALTER TABLE slotlock.usage_daily DROP CONSTRAINT IF EXISTS slotlock_usage_daily_metric_valid;
  IF (
    SELECT pg_catalog.obj_description(oid, 'pg_constraint') FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.usage_daily'::regclass AND conname = 'slotlock_usage_daily_metric_known'
  ) IS DISTINCT FROM '${SLOTLOCK_USAGE_METRICS.join(' ')}' THEN
    ALTER TABLE slotlock.usage_daily DROP CONSTRAINT IF EXISTS slotlock_usage_daily_metric_known;
    ALTER TABLE slotlock.usage_daily
      ADD CONSTRAINT slotlock_usage_daily_metric_known
      CHECK (metric IN (${SLOTLOCK_USAGE_METRICS.map((metric) => `'${metric}'`).join(', ')})) NOT VALID;
    COMMENT ON CONSTRAINT slotlock_usage_daily_metric_known ON slotlock.usage_daily
      IS '${SLOTLOCK_USAGE_METRICS.join(' ')}';
  END IF;
END
$slotlock_usage_daily_metric$;
ALTER TABLE slotlock.usage_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.usage_daily FROM PUBLIC;

-- Each batch of operation counts a server recorded, by the id it chose for it, so a batch sent again
-- (its answer lost) adds nothing. Kept a week.
CREATE TABLE IF NOT EXISTS slotlock.usage_flushes (
  flush_id uuid PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT statement_timestamp()
);
ALTER TABLE slotlock.usage_flushes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.usage_flushes FROM PUBLIC;

-- How far each tenant's feed has been rolled up into usage_daily, as a feed position (txid, id).
CREATE TABLE IF NOT EXISTS slotlock.usage_cursors (
  tenant_ref text PRIMARY KEY,
  txid xid8 NOT NULL,
  id bigint NOT NULL,
  CONSTRAINT slotlock_usage_cursors_tenant_ref_valid CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500)
);
ALTER TABLE slotlock.usage_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.usage_cursors FROM PUBLIC;

-- Where metering began: a tenant with no cursor yet starts its roll-up here, so the feed written
-- before this release is never counted. Recorded once, as the oldest transaction still running when
-- the table is created: a change at or after it is counted, one before it never.
CREATE TABLE IF NOT EXISTS slotlock.usage_meter_start (
  only_row boolean PRIMARY KEY DEFAULT true,
  txid xid8 NOT NULL,
  CONSTRAINT slotlock_usage_meter_start_one_row CHECK (only_row)
);
-- The one row, written the first time and never moved by a later migration.
INSERT INTO slotlock.usage_meter_start (txid)
VALUES (pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot()))
ON CONFLICT (only_row) DO NOTHING;
ALTER TABLE slotlock.usage_meter_start ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.usage_meter_start FROM PUBLIC;

-- The quota notices a tenant was sent (usage.threshold_reached, quotas.ts): one per UTC month,
-- metric and share of the plan's quota, so each goes once however many servers see the count pass
-- it. Owner-only, erased with the tenant; a month's rows go when the next month's first is noted.
CREATE TABLE IF NOT EXISTS slotlock.usage_notices (
  tenant_ref text NOT NULL,
  month date NOT NULL,
  metric text NOT NULL,
  percent integer NOT NULL,
  noticed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_usage_notices_pkey PRIMARY KEY (tenant_ref, month, metric, percent),
  CONSTRAINT slotlock_usage_notices_tenant_ref_valid CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500),
  CONSTRAINT slotlock_usage_notices_month_valid CHECK (extract(day FROM month) = 1),
  CONSTRAINT slotlock_usage_notices_metric_valid CHECK (metric IN (${SLOTLOCK_QUOTA_METRICS.map((metric) => `'${metric}'`).join(', ')})),
  CONSTRAINT slotlock_usage_notices_percent_valid CHECK (percent IN (${SLOTLOCK_QUOTA_NOTICE_PERCENTS.join(', ')}))
);
ALTER TABLE slotlock.usage_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.usage_notices FROM PUBLIC;

-- Adds a server's batch of counts, once per flush id: true when added, false when that batch was
-- added before. Each row names a tenant, a day within a day of today, a metric a server counts
-- (operations, webhook deliveries, assistant messages), a key ('' for none), a surface and a count;
-- rows for the same day, metric, key and surface are summed first.
CREATE OR REPLACE FUNCTION slotlock.record_usage(requested_flush_id uuid, requested_rows jsonb)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_record_usage$
BEGIN
  IF requested_flush_id IS NULL OR requested_rows IS NULL OR jsonb_typeof(requested_rows) <> 'array'
     OR jsonb_array_length(requested_rows) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Slotlock usage batch must be 1-10,000 rows with a flush id'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(requested_rows) given
     WHERE jsonb_typeof(given) <> 'object'
        OR COALESCE(given ->> 'metric', '') NOT IN (${SLOTLOCK_RECORDED_USAGE_METRICS.map((metric) => `'${metric}'`).join(', ')})
        OR (given ->> 'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        OR (given ->> 'day')::date NOT BETWEEN current_date - 1 AND current_date + 1
        OR jsonb_typeof(given -> 'count') <> 'number'
        OR (given ->> 'count')::numeric NOT BETWEEN 1 AND 1000000000
  ) THEN
    RAISE EXCEPTION 'Slotlock usage rows must be counts a server records, 1-1,000,000,000, within a day of today'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO slotlock.usage_flushes (flush_id) VALUES (requested_flush_id) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  -- Each tenant's shared lock, as withTenant takes it: an erasure in flight commits first, and the
  -- check below then sees it.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('slotlock:tenant:' || named.tenant_ref, 0))
     FROM (SELECT DISTINCT given ->> 'tenant_ref' AS tenant_ref
             FROM jsonb_array_elements(requested_rows) given
            ORDER BY 1) named;
  -- Only for a tenant that still exists, one with an API key or a feed: counts a server held while
  -- the tenant was erased are dropped rather than recreate rows for it.
  INSERT INTO slotlock.usage_daily AS kept (tenant_ref, day, metric, key_id, origin, count)
  SELECT given ->> 'tenant_ref', (given ->> 'day')::date, given ->> 'metric',
         COALESCE(given ->> 'key_id', ''), given ->> 'origin', sum((given ->> 'count')::bigint)
    FROM jsonb_array_elements(requested_rows) given
   WHERE EXISTS (SELECT 1 FROM slotlock.api_keys issued WHERE issued.tenant_ref = given ->> 'tenant_ref')
      OR EXISTS (SELECT 1 FROM slotlock.maintenance_tenants listed
                  WHERE listed.tenant_ref = given ->> 'tenant_ref')
   GROUP BY 1, 2, 3, 4, 5
  ON CONFLICT (tenant_ref, day, metric, key_id, origin) DO UPDATE SET count = kept.count + EXCLUDED.count;
  -- Now and then, batches older than a week (never sent again by then) are forgotten.
  IF random() < 0.01 THEN
    DELETE FROM slotlock.usage_flushes WHERE at < statement_timestamp() - interval '7 days';
  END IF;
  RETURN true;
END
$slotlock_record_usage$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[14]} FROM PUBLIC;

-- Rolls up to max_rows of the tenant's feed past its cursor into usage_daily: each committed
-- reservation.created, event.created (a whole series is one) and hold.confirmed is a booking, each
-- hold.created a hold, and maintenance's own changes count for nothing. The feed is read as its readers read it, in (txid, id) order and
-- only from transactions below this snapshot's xmin, every one of which has ended, so no change is
-- counted twice or skipped, and one that rolled back is never counted. The counts and the cursor
-- move in one transaction. Also deletes the tenant's usage older than the retention. Returns how
-- many changes it read: fewer than max_rows means it has caught up.
CREATE OR REPLACE FUNCTION slotlock.roll_up_usage(requested_tenant_ref text, max_rows integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_roll_up_usage$
DECLARE
  setting text;
  previous jsonb := '{}'::jsonb;
  from_txid xid8;
  from_id bigint;
  horizon xid8 := pg_snapshot_xmin(pg_current_snapshot());
  last_txid xid8;
  last_id bigint;
  scanned integer;
BEGIN
  IF requested_tenant_ref IS NULL OR octet_length(requested_tenant_ref) NOT BETWEEN 1 AND 500
     OR max_rows IS NULL OR max_rows NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'Slotlock usage roll-up arguments are invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- As every tenant transaction does (withTenant): an erasure waits for it, and it for an erasure,
  -- so it never counts into a tenant just erased. Then one roll-up of a tenant at a time.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('slotlock:tenant:' || requested_tenant_ref, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:usage:' || requested_tenant_ref, 0));
  SELECT cursor.txid, cursor.id INTO from_txid, from_id
    FROM slotlock.usage_cursors cursor WHERE cursor.tenant_ref = requested_tenant_ref;
  IF NOT FOUND THEN
    SELECT start.txid, 0 INTO from_txid, from_id FROM slotlock.usage_meter_start start;
  END IF;
  -- The feed has forced row-level security, its owner bound too: read it in the tenant's context.
  FOR setting IN
    SELECT DISTINCT contract.tenant_context_setting FROM slotlock.rls_policy_contracts contract
  LOOP
    previous := previous || jsonb_build_object(setting, current_setting(setting, true));
    PERFORM set_config(setting, requested_tenant_ref, true);
  END LOOP;
  WITH batch AS MATERIALIZED (
    SELECT change.txid, change.id, change.type, change.origin, change.key_id, change.occurred_at
      FROM slotlock.outbox change
     WHERE change.tenant_ref = requested_tenant_ref
       AND (change.txid, change.id) > (from_txid, from_id)
       AND change.txid < horizon
     ORDER BY change.txid, change.id
     LIMIT max_rows
  ), counted AS (
    INSERT INTO slotlock.usage_daily AS kept (tenant_ref, day, metric, key_id, origin, count)
    SELECT requested_tenant_ref, (batch.occurred_at AT TIME ZONE 'UTC')::date,
           CASE batch.type WHEN 'hold.created' THEN 'holds' ELSE 'bookings' END,
           COALESCE(batch.key_id::text, ''), COALESCE(batch.origin, 'library'), count(*)
      FROM batch
     WHERE batch.type IN ('reservation.created', 'event.created', 'hold.confirmed', 'hold.created')
       AND COALESCE(batch.origin, 'library') <> 'maintenance'
     GROUP BY 1, 2, 3, 4, 5
    ON CONFLICT (tenant_ref, day, metric, key_id, origin) DO UPDATE SET count = kept.count + EXCLUDED.count
  )
  SELECT (SELECT batch.txid FROM batch ORDER BY batch.txid DESC, batch.id DESC LIMIT 1),
         (SELECT batch.id FROM batch ORDER BY batch.txid DESC, batch.id DESC LIMIT 1),
         (SELECT count(*) FROM batch)::integer
    INTO last_txid, last_id, scanned;
  -- How many resources the tenant holds today (archived ones included, as a plan counts them): the
  -- day's last pass leaves the count at the end of the day. A count, so it replaces, never adds.
  INSERT INTO slotlock.usage_daily AS kept (tenant_ref, day, metric, key_id, origin, count)
  SELECT requested_tenant_ref, (statement_timestamp() AT TIME ZONE 'UTC')::date, 'resources', '',
         'maintenance', count(*)
    FROM slotlock.resources held
   WHERE held.tenant_ref = requested_tenant_ref
  HAVING count(*) > 0
  ON CONFLICT (tenant_ref, day, metric, key_id, origin) DO UPDATE SET count = EXCLUDED.count;
  IF scanned > 0 THEN
    INSERT INTO slotlock.usage_cursors AS kept (tenant_ref, txid, id)
    VALUES (requested_tenant_ref, last_txid, last_id)
    ON CONFLICT (tenant_ref) DO UPDATE SET txid = EXCLUDED.txid, id = EXCLUDED.id;
  END IF;
  DELETE FROM slotlock.usage_daily
   WHERE tenant_ref = requested_tenant_ref
     AND day < current_date - ${SLOTLOCK_USAGE_RETENTION_DAYS};
  FOR setting IN SELECT jsonb_object_keys(previous) LOOP
    PERFORM set_config(setting, coalesce(previous ->> setting, ''), true);
  END LOOP;
  RETURN scanned;
END
$slotlock_roll_up_usage$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[15]} FROM PUBLIC;

-- The tenant's usage from from_day to to_day (inclusive, at most 400 days), by day, metric, key and
-- surface.
CREATE OR REPLACE FUNCTION slotlock.tenant_usage(
  requested_tenant_ref text, from_day date, to_day date
)
RETURNS TABLE (day date, metric text, key_id text, origin text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_tenant_usage$
  SELECT used.day, used.metric, used.key_id, used.origin, used.count
    FROM slotlock.usage_daily used
   WHERE used.tenant_ref = requested_tenant_ref
     AND used.day BETWEEN from_day AND to_day
     AND to_day - from_day BETWEEN 0 AND ${SLOTLOCK_USAGE_RETENTION_DAYS}
   ORDER BY used.day, used.metric, used.key_id, used.origin;
$slotlock_tenant_usage$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[16]} FROM PUBLIC;

-- The tenant's operations and bookings from from_day (its quota month's first day, UTC) until now,
-- for its plan's quotas (quotas.ts): what usage_daily holds, plus the bookings in its feed past the
-- roll-up cursor, counted as roll_up_usage will count them (at most ${SLOTLOCK_QUOTA_UNROLLED_LIMIT.toLocaleString('en-US')} of those, more
-- than any quota). One statement, so a roll-up that commits meanwhile is counted once, never twice
-- or not at all.
CREATE OR REPLACE FUNCTION slotlock.tenant_quota_usage(requested_tenant_ref text, from_day date)
RETURNS TABLE (operations bigint, bookings bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_tenant_quota_usage$
DECLARE
  setting text;
  previous jsonb := '{}'::jsonb;
  today date := (statement_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF requested_tenant_ref IS NULL OR octet_length(requested_tenant_ref) NOT BETWEEN 1 AND 500
     OR from_day IS NULL OR from_day NOT BETWEEN today - 31 AND today + 1 THEN
    RAISE EXCEPTION 'Slotlock quota usage arguments are invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The feed has forced row-level security, its owner bound too: read it in the tenant's context.
  FOR setting IN
    SELECT DISTINCT contract.tenant_context_setting FROM slotlock.rls_policy_contracts contract
  LOOP
    previous := previous || jsonb_build_object(setting, current_setting(setting, true));
    PERFORM set_config(setting, requested_tenant_ref, true);
  END LOOP;
  RETURN QUERY
  WITH rolled_to AS (
    SELECT COALESCE(
             (SELECT kept.txid FROM slotlock.usage_cursors kept WHERE kept.tenant_ref = requested_tenant_ref),
             (SELECT start.txid FROM slotlock.usage_meter_start start)) AS txid,
           COALESCE(
             (SELECT kept.id FROM slotlock.usage_cursors kept WHERE kept.tenant_ref = requested_tenant_ref),
             0) AS id
  ), unrolled AS (
    SELECT 1
      FROM slotlock.outbox change, rolled_to
     WHERE change.tenant_ref = requested_tenant_ref
       AND (change.txid, change.id) > (rolled_to.txid, rolled_to.id)
       AND change.type IN ('reservation.created', 'event.created', 'hold.confirmed')
       AND COALESCE(change.origin, 'library') <> 'maintenance'
       AND change.occurred_at >= from_day::timestamp AT TIME ZONE 'UTC'
     LIMIT ${SLOTLOCK_QUOTA_UNROLLED_LIMIT}
  ), rolled AS (
    SELECT COALESCE(sum(used.count) FILTER (WHERE used.metric = 'operations'), 0) AS operations,
           COALESCE(sum(used.count) FILTER (WHERE used.metric = 'bookings'), 0) AS bookings
      FROM slotlock.usage_daily used
     WHERE used.tenant_ref = requested_tenant_ref
       AND used.day >= from_day
       AND used.metric IN ('operations', 'bookings')
  )
  SELECT rolled.operations::bigint, (rolled.bookings + (SELECT count(*) FROM unrolled))::bigint
    FROM rolled;
  FOR setting IN SELECT jsonb_object_keys(previous) LOOP
    PERFORM set_config(setting, coalesce(previous ->> setting, ''), true);
  END LOOP;
END
$slotlock_tenant_quota_usage$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[17]} FROM PUBLIC;

-- Notes that the tenant's use of a quota reached a share of it in a month, once: true the first
-- time, when it also appends usage.threshold_reached to the tenant's feed (the metric, the share,
-- the count, the quota and when the month ends), which its webhooks deliver as any change. Only for
-- a tenant that still exists (one with an API key or a feed, as record_usage), under its shared lock.
CREATE OR REPLACE FUNCTION slotlock.note_usage_threshold(
  requested_tenant_ref text,
  requested_month date,
  requested_metric text,
  requested_percent integer,
  requested_used bigint,
  requested_quota bigint
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_note_usage_threshold$
DECLARE
  setting text;
  previous jsonb := '{}'::jsonb;
  today date := (statement_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  IF requested_tenant_ref IS NULL OR octet_length(requested_tenant_ref) NOT BETWEEN 1 AND 500
     OR requested_month IS NULL OR extract(day FROM requested_month) <> 1
     OR requested_month NOT BETWEEN today - 31 AND today + 1
     OR requested_metric IS NULL
     OR requested_metric NOT IN (${SLOTLOCK_QUOTA_METRICS.map((metric) => `'${metric}'`).join(', ')})
     OR requested_percent IS NULL OR requested_percent NOT IN (${SLOTLOCK_QUOTA_NOTICE_PERCENTS.join(', ')})
     OR requested_used IS NULL OR requested_used < 0
     OR requested_quota IS NULL OR requested_quota < 1 THEN
    RAISE EXCEPTION 'Slotlock usage notice arguments are invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- As withTenant: an erasure in flight commits first, and the check below then sees it.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('slotlock:tenant:' || requested_tenant_ref, 0));
  IF NOT EXISTS (SELECT 1 FROM slotlock.api_keys issued WHERE issued.tenant_ref = requested_tenant_ref)
     AND NOT EXISTS (SELECT 1 FROM slotlock.maintenance_tenants listed
                      WHERE listed.tenant_ref = requested_tenant_ref) THEN
    RETURN false;
  END IF;
  INSERT INTO slotlock.usage_notices (tenant_ref, month, metric, percent)
  VALUES (requested_tenant_ref, requested_month, requested_metric, requested_percent)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  DELETE FROM slotlock.usage_notices
   WHERE tenant_ref = requested_tenant_ref AND month < requested_month;
  FOR setting IN
    SELECT DISTINCT contract.tenant_context_setting FROM slotlock.rls_policy_contracts contract
  LOOP
    previous := previous || jsonb_build_object(setting, current_setting(setting, true));
    PERFORM set_config(setting, requested_tenant_ref, true);
  END LOOP;
  INSERT INTO slotlock.outbox (tenant_ref, type, subject, data)
  VALUES (
    requested_tenant_ref, 'usage.threshold_reached',
    'usage_' || requested_metric || '_' || to_char(requested_month, 'YYYY_MM') || '_' || requested_percent,
    jsonb_build_object(
      'metric', requested_metric, 'percent', requested_percent, 'used', requested_used,
      'quota', requested_quota, 'period_start', to_char(requested_month, 'YYYY-MM-DD'),
      'resets_at', to_char((requested_month + interval '1 month'), 'YYYY-MM-DD"T"00:00:00"Z"'))
  );
  FOR setting IN SELECT jsonb_object_keys(previous) LOOP
    PERFORM set_config(setting, coalesce(previous ->> setting, ''), true);
  END LOOP;
  RETURN true;
END
$slotlock_note_usage_threshold$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[18]} FROM PUBLIC;

-- True when the tenant was not suspended already; a second suspension keeps the first's reason.
CREATE OR REPLACE FUNCTION slotlock.suspend_tenant(requested_tenant_ref text, requested_reason text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_suspend_tenant$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:tenant:' || requested_tenant_ref, 0));
  -- The tenant's key lock too: a key or secret being issued commits first, and one issued after
  -- this commits sees the suspension and is refused.
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:api-keys:' || requested_tenant_ref, 0));
  INSERT INTO slotlock.tenant_suspensions (tenant_ref, reason)
  VALUES (requested_tenant_ref, requested_reason)
  ON CONFLICT (tenant_ref) DO NOTHING;
  RETURN FOUND;
END
$slotlock_suspend_tenant$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_OPERATOR_FUNCTIONS[0]} FROM PUBLIC;

-- True when the tenant was suspended.
CREATE OR REPLACE FUNCTION slotlock.unsuspend_tenant(requested_tenant_ref text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_unsuspend_tenant$
BEGIN
  DELETE FROM slotlock.tenant_suspensions WHERE tenant_ref = requested_tenant_ref;
  RETURN FOUND;
END
$slotlock_unsuspend_tenant$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_OPERATOR_FUNCTIONS[1]} FROM PUBLIC;

-- Tenant erasure: every row the tenant owns, one row of the result per table with how many were
-- deleted, in an order no foreign key refuses. Holds carry no tenant: those on the tenant's resources
-- are its. API key digests are retired, as erase_api_keys retires them, so no erased key works again.
-- A personal (github:<id>) tenant's dashboard form records carry a digest of the person, the
-- dashboard's (dashboard.ts ownerDigest). Running it again deletes nothing. Forced row-level security
-- binds the function's owner too, so it names the tenant in every setting a policy reads, and puts
-- the caller's values back after.
CREATE OR REPLACE FUNCTION slotlock.erase_tenant(requested_tenant_ref text)
RETURNS TABLE (erased_table text, erased_rows bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_erase_tenant$
DECLARE
  setting text;
  previous jsonb := '{}'::jsonb;
BEGIN
  IF requested_tenant_ref IS NULL OR octet_length(requested_tenant_ref) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Slotlock tenant reference must be 1-500 UTF-8 bytes'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:tenant:' || requested_tenant_ref, 0));
  -- A key being issued commits first, so its row is deleted below with the rest.
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:api-keys:' || requested_tenant_ref, 0));
  -- A paid plan is cancelled first (plans.ts): erasing the tenant would leave its subscription
  -- renewing for an account that no longer exists. Cancelling it in Stripe moves the plan to Free
  -- (the dashboard's webhook), and then erasure runs. Under the key lock, which set_tenant_plan takes.
  IF EXISTS (SELECT 1 FROM slotlock.tenant_plans billed
              WHERE billed.tenant_ref = requested_tenant_ref
                AND billed.stripe_subscription IS NOT NULL) THEN
    RAISE EXCEPTION 'Slotlock tenant has a live subscription: cancel it before erasing the tenant'
      USING ERRCODE = 'object_in_use', HINT = 'billing_active';
  END IF;
  FOR setting IN
    SELECT DISTINCT contract.tenant_context_setting FROM slotlock.rls_policy_contracts contract
  LOOP
    previous := previous || jsonb_build_object(setting, current_setting(setting, true));
    PERFORM set_config(setting, requested_tenant_ref, true);
  END LOOP;
  -- What erasure deletes is not a change anyone is told of: the feed goes with the tenant.
  previous := previous || jsonb_build_object('slotlock.erasing', current_setting('slotlock.erasing', true));
  PERFORM set_config('slotlock.erasing', requested_tenant_ref, true);

  erased_table := 'calendar_event_attendees';
  DELETE FROM slotlock.calendar_event_attendees WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'calendar_event_reminders';
  DELETE FROM slotlock.calendar_event_reminders WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'calendar_event_exceptions';
  DELETE FROM slotlock.calendar_event_exceptions WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'calendar_event_occurrences';
  DELETE FROM slotlock.calendar_event_occurrences WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'reservations';
  DELETE FROM slotlock.reservations
   WHERE tenant_ref = requested_tenant_ref
      OR resource_id IN (SELECT owned.id FROM slotlock.resources owned
                          WHERE owned.tenant_ref = requested_tenant_ref);
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'calendar_events';
  DELETE FROM slotlock.calendar_events WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'calendar_event_tombstones';
  DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'calendar_event_commands';
  DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'reservation_tombstones';
  DELETE FROM slotlock.reservation_tombstones WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'reservation_conflict_archive';
  DELETE FROM slotlock.reservation_conflict_archive WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'calendar_coverage';
  DELETE FROM slotlock.calendar_coverage WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'hold_commands';
  DELETE FROM slotlock.hold_commands WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'waitlist_entries';
  DELETE FROM slotlock.waitlist_entries WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'booking_rule_defaults';
  DELETE FROM slotlock.booking_rule_defaults WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'pool_settings';
  DELETE FROM slotlock.pool_settings WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'tenant_plans';
  DELETE FROM slotlock.tenant_plans WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'assistant_conversations';
  DELETE FROM slotlock.assistant_conversations WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'assistant_settings';
  DELETE FROM slotlock.assistant_settings WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  -- A resource's group memberships, then the resource; its location after it, as resources and
  -- locations under it name it.
  erased_table := 'resource_group_members';
  DELETE FROM slotlock.resource_group_members WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'resources';
  DELETE FROM slotlock.resources WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'resource_groups';
  DELETE FROM slotlock.resource_groups WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'locations';
  DELETE FROM slotlock.locations WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  -- After every booking table: what their deletion just appended goes with the rest.
  erased_table := 'outbox';
  DELETE FROM slotlock.outbox WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'outbox_pruned';
  DELETE FROM slotlock.outbox_pruned WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'webhook_endpoints';
  DELETE FROM slotlock.webhook_endpoints WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'assistant_tenants';
  DELETE FROM slotlock.assistant_tenants WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'webhook_tenants';
  DELETE FROM slotlock.webhook_tenants WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'maintenance_tenants';
  DELETE FROM slotlock.maintenance_tenants WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'usage_daily';
  DELETE FROM slotlock.usage_daily WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'usage_cursors';
  DELETE FROM slotlock.usage_cursors WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'usage_notices';
  DELETE FROM slotlock.usage_notices WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'api_keys';
  WITH erased AS (
    DELETE FROM slotlock.api_keys WHERE tenant_ref = requested_tenant_ref RETURNING secret_hash
  ), retired AS (
    INSERT INTO slotlock.api_key_retired_digests (secret_hash)
    SELECT erased.secret_hash FROM erased
    ON CONFLICT DO NOTHING
  )
  SELECT count(*) INTO erased_rows FROM erased;
  RETURN NEXT;
  erased_table := 'dashboard_tokens';
  erased_rows := 0;
  IF requested_tenant_ref LIKE 'github:%' THEN
    DELETE FROM slotlock.dashboard_tokens
     WHERE kind = 'form'
       AND owner_hash = sha256(convert_to(
             'slotlock-dashboard-owner.' || substr(requested_tenant_ref, 8), 'UTF8'));
    GET DIAGNOSTICS erased_rows = ROW_COUNT;
  END IF;
  RETURN NEXT;

  FOR setting IN SELECT jsonb_object_keys(previous) LOOP
    PERFORM set_config(setting, coalesce(previous ->> setting, ''), true);
  END LOOP;
END
$slotlock_erase_tenant$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[1]} FROM PUBLIC;

-- The tenants with a webhook endpoint, which a server delivers for. Row-level security hides every
-- other tenant's endpoints from the serving role, so this list (names only) is how a server that
-- restarted finds the tenants whose events still wait. No role but its owner reads it.
CREATE TABLE IF NOT EXISTS slotlock.webhook_tenants (
  tenant_ref text PRIMARY KEY,
  registered_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotlock_webhook_tenants_tenant_ref_valid
    CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500)
);
ALTER TABLE slotlock.webhook_tenants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.webhook_tenants FROM PUBLIC;

CREATE OR REPLACE FUNCTION slotlock.register_webhook_tenant(requested_tenant_ref text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_register_webhook_tenant$
  INSERT INTO slotlock.webhook_tenants (tenant_ref) VALUES (requested_tenant_ref)
  ON CONFLICT (tenant_ref) DO NOTHING;
$slotlock_register_webhook_tenant$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[2]} FROM PUBLIC;

-- A page of 1,000 tenant names after \`after\` (NULL: from the start); a caller pages to the end.
DROP FUNCTION IF EXISTS slotlock.webhook_tenants();
CREATE OR REPLACE FUNCTION slotlock.webhook_tenants(after text)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_webhook_tenants$
  SELECT tenant_ref FROM slotlock.webhook_tenants
   WHERE after IS NULL OR tenant_ref > after
   ORDER BY tenant_ref LIMIT 1000;
$slotlock_webhook_tenants$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[3]} FROM PUBLIC;

-- Called when a tenant's last endpoint is deleted, so the list holds only tenants with one.
CREATE OR REPLACE FUNCTION slotlock.unregister_webhook_tenant(requested_tenant_ref text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_unregister_webhook_tenant$
  DELETE FROM slotlock.webhook_tenants WHERE tenant_ref = requested_tenant_ref;
$slotlock_unregister_webhook_tenant$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[4]} FROM PUBLIC;

-- Request budgets shared by every server of a deployment (SLOTLOCK_SHARED_LIMITS): one token bucket
-- per limit and tenant, keyed by a digest, refilled and taken in one statement so racing servers
-- never both take the last token. No role but its owner reads it.
CREATE TABLE IF NOT EXISTS slotlock.rate_buckets (
  bucket text PRIMARY KEY,
  tokens double precision NOT NULL,
  at timestamptz NOT NULL,
  CONSTRAINT slotlock_rate_buckets_bucket_valid CHECK (bucket ~ '^[0-9a-f]{64}$')
);
ALTER TABLE slotlock.rate_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.rate_buckets FROM PUBLIC;

-- True when a token was taken: the bucket refills at per_second up to burst, and starts full.
CREATE OR REPLACE FUNCTION slotlock.take_rate_token(
  requested_bucket text, per_second double precision, burst double precision
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_take_rate_token$
DECLARE
  taken boolean;
BEGIN
  IF requested_bucket !~ '^[0-9a-f]{64}$' OR NOT (per_second > 0) OR NOT (burst >= 1) THEN
    RAISE EXCEPTION 'Slotlock rate bucket arguments are invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO slotlock.rate_buckets AS kept (bucket, tokens, at)
  VALUES (requested_bucket, burst - 1, clock_timestamp())
  ON CONFLICT (bucket) DO UPDATE
     SET tokens = LEAST(burst, kept.tokens + EXTRACT(EPOCH FROM clock_timestamp() - kept.at) * per_second) - 1,
         at = clock_timestamp()
   WHERE LEAST(burst, kept.tokens + EXTRACT(EPOCH FROM clock_timestamp() - kept.at) * per_second) >= 1
  RETURNING true INTO taken;
  -- Now and then, buckets idle for an hour (full again long since) are dropped.
  IF random() < 0.001 THEN
    DELETE FROM slotlock.rate_buckets WHERE at < clock_timestamp() - interval '1 hour';
  END IF;
  RETURN COALESCE(taken, false);
END
$slotlock_take_rate_token$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[5]} FROM PUBLIC;

-- The tenants with a dashboard assistant conversation, and when the first of them expires. Forced
-- row-level security hides every other tenant's conversations, from the owner too, so this list
-- (names and a time only) is how maintenance finds the tenants whose conversations have expired,
-- whichever server stored them: one only the dashboard (or its Worker) ever used included. No role
-- but its owner reads it.
CREATE TABLE IF NOT EXISTS slotlock.assistant_tenants (
  tenant_ref text PRIMARY KEY,
  next_expiry timestamptz NOT NULL,
  CONSTRAINT slotlock_assistant_tenants_tenant_ref_valid
    CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS slotlock_assistant_tenants_expiry_idx
  ON slotlock.assistant_tenants (next_expiry);
ALTER TABLE slotlock.assistant_tenants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.assistant_tenants FROM PUBLIC;

-- Record that the tenant has a conversation expiring at expires (the earliest is kept).
CREATE OR REPLACE FUNCTION slotlock.register_assistant_tenant(requested_tenant_ref text, expires timestamptz)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_register_assistant_tenant$
BEGIN
  IF requested_tenant_ref IS NULL OR octet_length(requested_tenant_ref) NOT BETWEEN 1 AND 500
     OR expires IS NULL THEN
    RAISE EXCEPTION 'Slotlock assistant tenant arguments are invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO slotlock.assistant_tenants AS kept (tenant_ref, next_expiry)
  VALUES (requested_tenant_ref, expires)
  ON CONFLICT (tenant_ref) DO UPDATE SET next_expiry = LEAST(kept.next_expiry, EXCLUDED.next_expiry);
END
$slotlock_register_assistant_tenant$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[6]} FROM PUBLIC;

-- Delete expired assistant conversations across every tenant: up to max_rows of them, from the
-- tenants whose earliest expiry has passed, longest overdue first, each under its own tenant
-- context (forced row-level security binds the owner too), putting the caller's settings back
-- after. A tenant left with none leaves the list; one with more is listed at its next expiry.
-- Only a count comes back.
CREATE OR REPLACE FUNCTION slotlock.sweep_assistant_conversations(max_rows integer)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_sweep_assistant_conversations$
DECLARE
  setting text;
  previous jsonb := '{}'::jsonb;
  due record;
  deleted bigint := 0;
  step bigint;
  upcoming timestamptz;
BEGIN
  IF max_rows IS NULL OR max_rows NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'Slotlock assistant sweep size must be 1-100,000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR setting IN
    SELECT DISTINCT contract.tenant_context_setting FROM slotlock.rls_policy_contracts contract
  LOOP
    previous := previous || jsonb_build_object(setting, current_setting(setting, true));
  END LOOP;
  FOR due IN
    SELECT listed.tenant_ref FROM slotlock.assistant_tenants listed
     WHERE listed.next_expiry <= now()
     ORDER BY listed.next_expiry
     LIMIT 1000
       FOR UPDATE SKIP LOCKED
  LOOP
    EXIT WHEN deleted >= max_rows;
    FOR setting IN SELECT jsonb_object_keys(previous) LOOP
      PERFORM set_config(setting, due.tenant_ref, true);
    END LOOP;
    DELETE FROM slotlock.assistant_conversations gone
     WHERE gone.tenant_ref = due.tenant_ref
       AND gone.member_ref IN (
         SELECT expired.member_ref FROM slotlock.assistant_conversations expired
          WHERE expired.tenant_ref = due.tenant_ref AND expired.expires_at <= now()
          LIMIT max_rows - deleted)
       AND gone.expires_at <= now();
    GET DIAGNOSTICS step = ROW_COUNT;
    deleted := deleted + step;
    SELECT min(live.expires_at) INTO upcoming FROM slotlock.assistant_conversations live
     WHERE live.tenant_ref = due.tenant_ref;
    IF upcoming IS NULL THEN
      DELETE FROM slotlock.assistant_tenants WHERE tenant_ref = due.tenant_ref;
    ELSE
      UPDATE slotlock.assistant_tenants SET next_expiry = upcoming WHERE tenant_ref = due.tenant_ref;
    END IF;
  END LOOP;
  FOR setting IN SELECT jsonb_object_keys(previous) LOOP
    PERFORM set_config(setting, coalesce(previous ->> setting, ''), true);
  END LOOP;
  RETURN deleted;
END
$slotlock_sweep_assistant_conversations$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[7]} FROM PUBLIC;

-- The tenants with data, which \`serve\` maintains every hour whether or not their keys call: what
-- retention ends is deleted for a tenant gone quiet too. Forced row-level security hides every
-- tenant's rows from the owner as well, so this list (names only) is how a server finds them. A
-- tenant is listed by the first row it writes to a table maintenance prunes (each change on its
-- feed is one, so every booking, event, resource and endpoint counts), and erasure takes it off.
-- While it is empty (first created), it starts from every tenant already in a tenant table: the
-- deployment has lifted FORCE by now. No role but its owner reads it.
CREATE TABLE IF NOT EXISTS slotlock.maintenance_tenants (
  tenant_ref text PRIMARY KEY,
  CONSTRAINT slotlock_maintenance_tenants_tenant_ref_valid
    CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500)
);
DO $slotlock_maintenance_tenants_known$
DECLARE
  tenant_table text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM slotlock.maintenance_tenants) THEN
    FOR tenant_table IN
      SELECT rel.relname::text
        FROM pg_catalog.pg_class rel
        JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
        JOIN pg_catalog.pg_attribute att ON att.attrelid = rel.oid
       WHERE ns.nspname = 'slotlock' AND rel.relkind IN ('r', 'p')
         AND att.attname = 'tenant_ref' AND NOT att.attisdropped
         AND rel.relname <> 'maintenance_tenants'
       ORDER BY rel.relname
    LOOP
      EXECUTE pg_catalog.format(
        'INSERT INTO slotlock.maintenance_tenants (tenant_ref)
         SELECT DISTINCT tenant_ref FROM slotlock.%I
          WHERE octet_length(tenant_ref) BETWEEN 1 AND 500
         ON CONFLICT (tenant_ref) DO NOTHING', tenant_table);
    END LOOP;
  END IF;
END
$slotlock_maintenance_tenants_known$;
ALTER TABLE slotlock.maintenance_tenants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.maintenance_tenants FROM PUBLIC;

-- Lists the tenants of the rows a statement appended (only the writer's own: RLS checks each row).
-- Once listed, a tenant costs each later statement one index probe.
CREATE OR REPLACE FUNCTION slotlock.list_maintenance_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_list_maintenance_tenant$
BEGIN
  INSERT INTO slotlock.maintenance_tenants (tenant_ref)
  SELECT DISTINCT appended.tenant_ref FROM appended
   WHERE appended.tenant_ref IS NOT NULL
  ON CONFLICT (tenant_ref) DO NOTHING;
  RETURN NULL;
END
$slotlock_list_maintenance_tenant$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[8]} FROM PUBLIC;
-- The feed, and what can be written without a change on it: a reference retired with no booking,
-- an event's cancellation and idempotency answers, a hold's answer, a waitlist entry.
DO $slotlock_maintenance_tenants_triggers$
DECLARE
  tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'outbox', 'reservation_tombstones', 'calendar_event_tombstones', 'calendar_event_commands',
    'hold_commands', 'waitlist_entries'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE OR REPLACE TRIGGER slotlock_list_maintenance_tenant
         AFTER INSERT ON slotlock.%I REFERENCING NEW TABLE AS appended
         FOR EACH STATEMENT EXECUTE FUNCTION slotlock.list_maintenance_tenant()', tenant_table);
  END LOOP;
END
$slotlock_maintenance_tenants_triggers$;

-- A page of 1,000 tenant names after \`after\` (NULL: from the start); a caller pages to the end.
CREATE OR REPLACE FUNCTION slotlock.maintenance_tenants(after text)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_maintenance_tenants$
  SELECT tenant_ref FROM slotlock.maintenance_tenants
   WHERE after IS NULL OR tenant_ref > after
   ORDER BY tenant_ref LIMIT 1000;
$slotlock_maintenance_tenants$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[9]} FROM PUBLIC;
`;

// Validate constraints an upgrade added NOT VALID. applySchema runs this in its own transaction
// after the DDL commits: inside the DDL's, altered tables stay ACCESS EXCLUSIVE and the scan would
// block serving queries. Alone, VALIDATE takes SHARE UPDATE EXCLUSIVE, which no read or row write
// conflicts with (PostgreSQL 17 docs), and it sees every row regardless of RLS. One old rows still
// break stays NOT VALID with a notice (it still binds new rows) and is retried at each migration.
const DEPLOYMENT_VALIDATE_CONSTRAINTS = `DO $slotlock_validate_constraints$
DECLARE
  unchecked record;
BEGIN
  FOR unchecked IN
    SELECT rel.relname::text AS table_name, con.conname::text AS constraint_name
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
      JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'slotlock' AND NOT con.convalidated
     ORDER BY rel.relname, con.conname
  LOOP
    BEGIN
      EXECUTE pg_catalog.format('ALTER TABLE slotlock.%I VALIDATE CONSTRAINT %I',
                                unchecked.table_name, unchecked.constraint_name);
    EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation THEN
      RAISE NOTICE 'Slotlock left %.% NOT VALID: existing rows break it',
        unchecked.table_name, unchecked.constraint_name;
    END;
  END LOOP;
END
$slotlock_validate_constraints$;
`;

/** The constraint validation applySchema runs after the rest of SLOTLOCK_CORE_DDL has committed. */
export const SLOTLOCK_VALIDATION_DDL: string = DEPLOYMENT_VALIDATE_CONSTRAINTS;

const DEPLOYMENT_RECORD_VERSION = `INSERT INTO slotlock.schema_version (singleton, version, applied_at)
VALUES (true, ${SLOTLOCK_SCHEMA_VERSION}, now())
ON CONFLICT (singleton) DO UPDATE
SET version = EXCLUDED.version, ddl_sha256 = NULL, catalog_sha256 = NULL,
    applied_at = EXCLUDED.applied_at;
`;

// The event feed (RFC 0002 P1-5). Every committed change to a tenant's holds, bookings and calendar
// events appends a row here in the same transaction, by trigger, so no write path can skip it and
// nothing is recorded that did not commit. Rows carry ids, times and states, never titles,
// descriptions or attendees. A reader orders rows by (txid, id) and reads only transactions below
// its snapshot's xmin: every one of those has ended, so a transaction that commits late can never
// add a row behind a position a reader has passed. Maintenance deletes rows past the retention.
const SLOTLOCK_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS slotlock.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  tenant_ref text NOT NULL,
  resource_id uuid,
  type text NOT NULL,
  subject text NOT NULL,
  data jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_outbox_tenant_ref_valid CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500),
  CONSTRAINT slotlock_outbox_type_valid CHECK (type ~ '^[a-z]+\\.[a-z_]+$')
);
-- Who made the change (withTenant's actor: an API key, an agent), for the history.
ALTER TABLE slotlock.outbox ADD COLUMN IF NOT EXISTS actor text;
-- Where it came from (withTenant's origin: mcp, a2a, rest, application, dashboard,
-- dashboard-assistant, maintenance, library) and the API key that made it (withTenant's keyId).
-- Added bare, so the rows already there keep null (an earlier release) and nothing is scanned under
-- the lock; the defaults then bind only new rows. A write that names no origin (code calling the
-- store outside withTenant, or SQL of its own) is \`library\`.
ALTER TABLE slotlock.outbox ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE slotlock.outbox ADD COLUMN IF NOT EXISTS key_id uuid;
ALTER TABLE slotlock.outbox
  ALTER COLUMN origin SET DEFAULT COALESCE(NULLIF(current_setting('slotlock.origin', true), ''), 'library'),
  ALTER COLUMN key_id SET DEFAULT NULLIF(current_setting('slotlock.key_id', true), '')::uuid;
-- The origins the API reads, and no other. NOT VALID, so adding it scans nothing under the lock;
-- DEPLOYMENT_VALIDATE_CONSTRAINTS validates it after the migration commits. Its comment is the list
-- it was built from: a release that changes the list replaces it, so an upgraded database never
-- keeps refusing an origin the release writes.
DO $slotlock_outbox_origin$
BEGIN
  ALTER TABLE slotlock.outbox DROP CONSTRAINT IF EXISTS slotlock_outbox_origin_valid;
  IF (
    SELECT pg_catalog.obj_description(oid, 'pg_constraint') FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.outbox'::regclass AND conname = 'slotlock_outbox_origin_known'
  ) IS DISTINCT FROM '${SLOTLOCK_CHANGE_ORIGINS.join(' ')}' THEN
    ALTER TABLE slotlock.outbox DROP CONSTRAINT IF EXISTS slotlock_outbox_origin_known;
    ALTER TABLE slotlock.outbox
      ADD CONSTRAINT slotlock_outbox_origin_known
      CHECK (origin IN (${SLOTLOCK_CHANGE_ORIGINS.map((origin) => `'${origin}'`).join(', ')})) NOT VALID;
    COMMENT ON CONSTRAINT slotlock_outbox_origin_known ON slotlock.outbox
      IS '${SLOTLOCK_CHANGE_ORIGINS.join(' ')}';
  END IF;
END
$slotlock_outbox_origin$;
CREATE INDEX IF NOT EXISTS slotlock_outbox_tenant_resource_idx
  ON slotlock.outbox (tenant_ref, resource_id, id) WHERE resource_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS slotlock_outbox_tenant_subject_idx
  ON slotlock.outbox (tenant_ref, subject, id);
CREATE INDEX IF NOT EXISTS slotlock_outbox_tenant_position_idx
  ON slotlock.outbox (tenant_ref, txid, id);
CREATE INDEX IF NOT EXISTS slotlock_outbox_tenant_time_idx
  ON slotlock.outbox (tenant_ref, occurred_at);
-- How far a tenant's feed has been pruned: no change after (txid, id) was ever deleted, so a cursor
-- at or past it has missed none, and one before it may have, and is refused. Created once, it starts
-- every tenant already known at its oldest kept change (or now): what an earlier version pruned is
-- before it.
DO $slotlock_outbox_pruned$
BEGIN
  IF pg_catalog.to_regclass('slotlock.outbox_pruned') IS NULL THEN
    -- No change is deleted between reading what is kept and the mark it starts at.
    LOCK TABLE slotlock.outbox IN SHARE ROW EXCLUSIVE MODE;
    CREATE TABLE IF NOT EXISTS slotlock.outbox_pruned (
      tenant_ref text PRIMARY KEY,
      txid xid8 NOT NULL,
      id bigint NOT NULL,
      CONSTRAINT slotlock_outbox_pruned_tenant_ref_valid CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500)
    );
    INSERT INTO slotlock.outbox_pruned (tenant_ref, txid, id)
    SELECT known.tenant_ref, min(known.txid), 0
      FROM (
        SELECT tenant_ref, txid FROM slotlock.outbox
        UNION ALL
        SELECT tenant_ref, pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())
          FROM slotlock.resources WHERE tenant_ref IS NOT NULL
      ) known
     GROUP BY known.tenant_ref;
  END IF;
END
$slotlock_outbox_pruned$;
-- Whatever deletes changes (maintenance, an older server's, an operator's), the mark follows it.
CREATE OR REPLACE FUNCTION slotlock.outbox_mark_pruned()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_outbox_mark_pruned$
BEGIN
  INSERT INTO slotlock.outbox_pruned AS mark (tenant_ref, txid, id)
  SELECT DISTINCT ON (pruned.tenant_ref) pruned.tenant_ref, pruned.txid, pruned.id
    FROM pruned
   ORDER BY pruned.tenant_ref, pruned.txid DESC, pruned.id DESC
  ON CONFLICT (tenant_ref) DO UPDATE SET txid = excluded.txid, id = excluded.id
   WHERE (excluded.txid, excluded.id) > (mark.txid, mark.id);
  RETURN NULL;
END
$slotlock_outbox_mark_pruned$;
CREATE OR REPLACE TRIGGER slotlock_outbox_mark_pruned
  AFTER DELETE ON slotlock.outbox REFERENCING OLD TABLE AS pruned
  FOR EACH STATEMENT EXECUTE FUNCTION slotlock.outbox_mark_pruned();
-- Live updates poll each tenant's feed (change-watch.ts). A pre-release build woke readers with a
-- notification trigger here, which made every outbox commit take the cluster-wide notify lock: drop it.
DROP TRIGGER IF EXISTS slotlock_outbox_notify ON slotlock.outbox;
DROP FUNCTION IF EXISTS slotlock.outbox_notify();

CREATE TABLE IF NOT EXISTS slotlock.webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL,
  url text NOT NULL,
  secret text NOT NULL,
  event_types text[],
  cursor_txid xid8 NOT NULL,
  cursor_id bigint NOT NULL DEFAULT 0,
  -- Set when maintenance pruned a change this (disabled) endpoint had not received: enabling it
  -- again is refused rather than skipping that change unseen.
  changes_pruned boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  failing_since timestamptz,
  last_status integer,
  last_error text,
  disabled_at timestamptz,
  disabled_reason text,
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotlock_webhook_endpoints_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND octet_length(url) BETWEEN 1 AND 2048
    AND secret ~ '^whsec_[A-Za-z0-9+/]{43}=$'
  ),
  CONSTRAINT slotlock_webhook_endpoints_type_count_valid CHECK (
    event_types IS NULL OR cardinality(event_types) BETWEEN 1 AND 64
  ),
  CONSTRAINT slotlock_webhook_endpoints_error_valid CHECK (
    last_error IS NULL OR char_length(last_error) <= 500
  )
);
ALTER TABLE slotlock.webhook_endpoints ADD COLUMN IF NOT EXISTS changes_pruned boolean NOT NULL DEFAULT false;
-- Which resources' changes an endpoint receives (RFC 0003 G5): with any of these, only changes about
-- a resource it names, or one in a pool, at a location (or a location in it) or in a group it names,
-- matched as the change is delivered. Null: no such filter.
ALTER TABLE slotlock.webhook_endpoints ADD COLUMN IF NOT EXISTS filter_resource_ids uuid[];
ALTER TABLE slotlock.webhook_endpoints ADD COLUMN IF NOT EXISTS filter_pools text[];
ALTER TABLE slotlock.webhook_endpoints ADD COLUMN IF NOT EXISTS filter_locations text[];
ALTER TABLE slotlock.webhook_endpoints ADD COLUMN IF NOT EXISTS filter_groups text[];
DO $slotlock_webhook_filter$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.webhook_endpoints'::regclass
       AND conname = 'slotlock_webhook_endpoints_filter_valid'
  ) THEN
    ALTER TABLE slotlock.webhook_endpoints
      ADD CONSTRAINT slotlock_webhook_endpoints_filter_valid CHECK (
        (filter_resource_ids IS NULL
         OR cardinality(filter_resource_ids) BETWEEN 1 AND ${SLOTLOCK_WEBHOOK_FILTER_RESOURCES})
        AND (filter_pools IS NULL OR cardinality(filter_pools) BETWEEN 1 AND ${SLOTLOCK_WEBHOOK_FILTER_REFS})
        AND (filter_locations IS NULL OR cardinality(filter_locations) BETWEEN 1 AND ${SLOTLOCK_WEBHOOK_FILTER_REFS})
        AND (filter_groups IS NULL OR cardinality(filter_groups) BETWEEN 1 AND ${SLOTLOCK_WEBHOOK_FILTER_REFS})
      ) NOT VALID;
  END IF;
END
$slotlock_webhook_filter$;

-- A location and every location it is in, by reference (none for none): what a location filter
-- matches a resource's location against. Run as its caller, in the tenant's context.
CREATE OR REPLACE FUNCTION slotlock.location_path(requested_tenant_ref text, requested_ref text)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_location_path$
  WITH RECURSIVE up(ref, parent_ref, steps) AS (
    SELECT place.ref, place.parent_ref, 1 FROM slotlock.locations place
     WHERE place.tenant_ref = requested_tenant_ref AND place.ref = requested_ref
    UNION ALL
    SELECT place.ref, place.parent_ref, up.steps + 1
      FROM slotlock.locations place JOIN up ON place.tenant_ref = requested_tenant_ref AND place.ref = up.parent_ref
     WHERE up.steps <= ${SLOTLOCK_MAX_LOCATION_DEPTH}
  )
  SELECT COALESCE(array_agg(up.ref), '{}'::text[]) FROM up;
$slotlock_location_path$;
-- 0.5 allowed a filter of at most 20 types, fewer than there are now. The wider CHECK admits every
-- row the old one did, so it is added NOT VALID (no scan under the lock), and the old one dropped.
DO $slotlock_webhook_type_count$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.webhook_endpoints'::regclass
       AND conname = 'slotlock_webhook_endpoints_type_count_valid'
  ) THEN
    ALTER TABLE slotlock.webhook_endpoints
      ADD CONSTRAINT slotlock_webhook_endpoints_type_count_valid CHECK (
        event_types IS NULL OR cardinality(event_types) BETWEEN 1 AND 64
      ) NOT VALID;
  END IF;
  ALTER TABLE slotlock.webhook_endpoints DROP CONSTRAINT IF EXISTS slotlock_webhook_endpoints_types_valid;
END
$slotlock_webhook_type_count$;
CREATE INDEX IF NOT EXISTS slotlock_webhook_endpoints_tenant_idx
  ON slotlock.webhook_endpoints (tenant_ref, created_at);

-- Who waits for time on a resource or in a pool, offered in order (offerWaitlist): the first whose
-- window comes free gets a hold of it, for offer_ttl_ms, and the feed says so (waitlist.offered).
CREATE TABLE IF NOT EXISTS slotlock.waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL,
  resource_id uuid,
  pool_ref text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  holder_ref text NOT NULL,
  offer_ttl_ms bigint NOT NULL,
  status text NOT NULL DEFAULT 'waiting',
  hold_id uuid,
  offered_resource_id uuid,
  offered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- The resource is the entry's own tenant's, as the database sees it, whatever wrote the row.
  CONSTRAINT slotlock_waitlist_entries_resource_fk FOREIGN KEY (resource_id, tenant_ref)
    REFERENCES slotlock.resources (id, tenant_ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_waitlist_entries_target_valid CHECK ((resource_id IS NULL) <> (pool_ref IS NULL)),
  CONSTRAINT slotlock_waitlist_entries_window_valid CHECK (ends_at > starts_at),
  CONSTRAINT slotlock_waitlist_entries_status_valid CHECK (status IN ('waiting', 'offered', 'expired')),
  CONSTRAINT slotlock_waitlist_entries_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500 AND octet_length(holder_ref) BETWEEN 1 AND 500
  ),
  CONSTRAINT slotlock_waitlist_entries_ttl_valid CHECK (offer_ttl_ms BETWEEN 60000 AND 86400000),
  CONSTRAINT slotlock_waitlist_entries_offer_valid CHECK (
    (status = 'offered') = (hold_id IS NOT NULL AND offered_at IS NOT NULL AND offered_resource_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS slotlock_waitlist_entries_queue_idx
  ON slotlock.waitlist_entries (tenant_ref, created_at, id) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS slotlock_waitlist_entries_tenant_idx
  ON slotlock.waitlist_entries (tenant_ref, starts_at);

-- Default booking rules (booking-rules.ts), for the tenant (pool_ref '') or for one of its pools:
-- a resource's rules are the tenant's, overlaid by its pool's, overlaid by its own.
CREATE TABLE IF NOT EXISTS slotlock.booking_rule_defaults (
  tenant_ref text NOT NULL,
  pool_ref text NOT NULL DEFAULT '',
  rules jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_booking_rule_defaults_pkey PRIMARY KEY (tenant_ref, pool_ref),
  CONSTRAINT slotlock_booking_rule_defaults_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND (pool_ref = '' OR pool_ref ~ '^[a-z0-9][a-z0-9._-]{0,99}$')
  ),
  CONSTRAINT slotlock_booking_rule_defaults_rules_valid CHECK (
    jsonb_typeof(rules) = 'object' AND octet_length(rules::text) <= 4096
  )
);

-- The order a pool booking tries a pool's members in (RFC 0003 G7): stable (by id), least_booked
-- (fewest bookings made on each in the last 30 days first) or round_robin (from the one after the
-- member booked last). A pool without a row is stable.
CREATE TABLE IF NOT EXISTS slotlock.pool_settings (
  tenant_ref text NOT NULL,
  pool_ref text NOT NULL,
  member_order text NOT NULL DEFAULT 'stable',
  last_member uuid,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_pool_settings_pkey PRIMARY KEY (tenant_ref, pool_ref),
  CONSTRAINT slotlock_pool_settings_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND pool_ref ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
    AND member_order IN (${SLOTLOCK_POOL_ORDERS.map((order) => `'${order}'`).join(', ')})
  )
);

-- The model a tenant's dashboard assistant uses (dashboard.ts, assistant.ts), one row a tenant.
-- The API key is stored only sealed (AES-256-GCM under the deployment's SLOTLOCK_ASSISTANT_SECRET,
-- bound to the tenant), with its last four characters to show.
CREATE TABLE IF NOT EXISTS slotlock.assistant_settings (
  tenant_ref text PRIMARY KEY,
  provider text NOT NULL,
  base_url text NOT NULL,
  model text NOT NULL,
  sealed_key text,
  key_hint text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_assistant_settings_tenant_ref_valid CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500),
  CONSTRAINT slotlock_assistant_settings_provider_valid CHECK (provider IN ('anthropic', 'openai')),
  CONSTRAINT slotlock_assistant_settings_base_url_valid CHECK (octet_length(base_url) BETWEEN 1 AND 2048),
  CONSTRAINT slotlock_assistant_settings_model_valid CHECK (octet_length(model) BETWEEN 1 AND 200),
  CONSTRAINT slotlock_assistant_settings_key_valid CHECK (
    (sealed_key IS NULL) = (key_hint IS NULL)
    AND (sealed_key IS NULL OR octet_length(sealed_key) BETWEEN 1 AND 8192)
    AND (key_hint IS NULL OR char_length(key_hint) BETWEEN 1 AND 4)
  ),
  CONSTRAINT slotlock_assistant_settings_updated_by_valid
    CHECK (updated_by IS NULL OR octet_length(updated_by) BETWEEN 1 AND 200)
);

-- One member's short-lived conversation with the dashboard assistant, and the writes it proposed
-- (actions, by id, each pending until the member approves or dismisses it).
CREATE TABLE IF NOT EXISTS slotlock.assistant_conversations (
  tenant_ref text NOT NULL,
  member_ref text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT slotlock_assistant_conversations_pkey PRIMARY KEY (tenant_ref, member_ref),
  CONSTRAINT slotlock_assistant_conversations_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500 AND octet_length(member_ref) BETWEEN 1 AND 500
  ),
  CONSTRAINT slotlock_assistant_conversations_messages_valid CHECK (
    jsonb_typeof(messages) = 'array' AND octet_length(messages::text) <= 262144
  ),
  CONSTRAINT slotlock_assistant_conversations_actions_valid CHECK (
    jsonb_typeof(actions) = 'object' AND octet_length(actions::text) <= 131072
  )
);
CREATE INDEX IF NOT EXISTS slotlock_assistant_conversations_expiry_idx
  ON slotlock.assistant_conversations (tenant_ref, expires_at);

-- The tenant a reservation row belongs to: its own, or (a hold) its resource's.
CREATE OR REPLACE FUNCTION slotlock.outbox_reservation_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_outbox_reservation$
DECLARE
  changed slotlock.reservations%ROWTYPE;
  owner text;
  kind text;
BEGIN
  changed := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  -- A calendar event's occupation is reported as the event's change.
  IF changed.calendar_event_id IS NOT NULL THEN RETURN NULL; END IF;
  owner := changed.tenant_ref;
  IF owner IS NULL THEN
    SELECT resource.tenant_ref INTO owner FROM slotlock.resources resource
     WHERE resource.id = changed.resource_id;
  END IF;
  IF owner IS NULL THEN RETURN NULL; END IF;
  -- Erasure (erase_tenant, running as the schema's owner) is not reported. The marker is an ordinary
  -- setting, so it counts only when the owner set it: the serving role cannot hide its own writes.
  IF owner = current_setting('slotlock.erasing', true)
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace
                          WHERE nspname = 'slotlock') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    kind := CASE WHEN NEW.status = 'held' THEN 'hold.created' ELSE 'reservation.created' END;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'held' AND NEW.status <> 'held' THEN
      kind := 'hold.confirmed';
    ELSIF (OLD.starts_at, OLD.ends_at, OLD.resource_id, OLD.revision, OLD.buffer_after_ms)
          IS NOT DISTINCT FROM
          (NEW.starts_at, NEW.ends_at, NEW.resource_id, NEW.revision, NEW.buffer_after_ms) THEN
      RETURN NULL;
    ELSE
      kind := CASE WHEN NEW.status = 'held' THEN 'hold.updated' ELSE 'reservation.updated' END;
    END IF;
  ELSE
    kind := CASE
      WHEN OLD.status <> 'held' THEN 'reservation.cancelled'
      WHEN OLD.expires_at <= statement_timestamp() THEN 'hold.expired'
      ELSE 'hold.released'
    END;
  END IF;
  INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
  VALUES (
    owner, changed.resource_id, kind,
    COALESCE(changed.external_ref, changed.id::text),
    jsonb_strip_nulls(jsonb_build_object(
      'id', changed.id,
      'reference', changed.external_ref,
      'resource_id', changed.resource_id,
      'start', changed.starts_at,
      'end', changed.ends_at,
      'buffer_after_ms', changed.buffer_after_ms,
      'revision', CASE WHEN changed.status = 'held' THEN NULL ELSE changed.revision END,
      'expires_at', CASE WHEN changed.status = 'held' THEN changed.expires_at END,
      -- A move says where it came from.
      'before', CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object(
        'resource_id', OLD.resource_id, 'start', OLD.starts_at, 'end', OLD.ends_at,
        'revision', OLD.revision) END
    )),
    NULLIF(current_setting('slotlock.actor', true), '')
  );
  RETURN NULL;
END
$slotlock_outbox_reservation$;

CREATE OR REPLACE FUNCTION slotlock.outbox_calendar_event_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_outbox_calendar_event$
DECLARE
  changed slotlock.calendar_events%ROWTYPE;
  kind text;
BEGIN
  changed := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  -- Erasure (erase_tenant, running as the schema's owner) is not reported. The marker is an ordinary
  -- setting, so it counts only when the owner set it: the serving role cannot hide its own writes.
  IF changed.tenant_ref = current_setting('slotlock.erasing', true)
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace
                          WHERE nspname = 'slotlock') THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    kind := 'event.created';
  ELSIF TG_OP = 'UPDATE' THEN
    -- Extending a series to the rolling horizon changes nothing anyone wrote.
    IF OLD.revision = NEW.revision AND OLD.resource_id = NEW.resource_id THEN RETURN NULL; END IF;
    kind := 'event.updated';
  ELSE
    kind := 'event.cancelled';
  END IF;
  INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
  VALUES (
    changed.tenant_ref, changed.resource_id, kind, changed.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'id', changed.id,
      'resource_id', changed.resource_id,
      'start', changed.starts_at,
      'end', changed.ends_at,
      'timezone', changed.timezone,
      'status', changed.status,
      'transparency', changed.transparency,
      'recurring', changed.recurrence_rule IS NOT NULL,
      'revision', changed.revision,
      'before', CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object(
        'resource_id', OLD.resource_id, 'start', OLD.starts_at, 'end', OLD.ends_at,
        'status', OLD.status, 'transparency', OLD.transparency, 'revision', OLD.revision) END
    )),
    NULLIF(current_setting('slotlock.actor', true), '')
  );
  RETURN NULL;
END
$slotlock_outbox_calendar_event$;

-- Time zone rules change (tzdata): an event is kept as the wall-clock time it was booked for in its
-- zone as well as the instant, so maintenance can find a future one-off event whose wall time now
-- falls at another instant. PostgreSQL's own tzdata resolves both. A zone it does not know gives
-- NULL rather than an error, and such an event is left alone.
CREATE OR REPLACE FUNCTION slotlock.zoned_wall(instant timestamptz, zone text)
RETURNS timestamp LANGUAGE plpgsql STABLE SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_zoned_wall$
BEGIN
  RETURN instant AT TIME ZONE zone;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$slotlock_zoned_wall$;
CREATE OR REPLACE FUNCTION slotlock.zoned_instant(wall timestamp, zone text)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_zoned_instant$
BEGIN
  RETURN wall AT TIME ZONE zone;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$slotlock_zoned_instant$;
ALTER TABLE slotlock.calendar_events ADD COLUMN IF NOT EXISTS wall_starts_at timestamp;
ALTER TABLE slotlock.calendar_events ADD COLUMN IF NOT EXISTS wall_ends_at timestamp;
-- Set when a shift was reported, so it is reported once; any change of the event's time clears it.
ALTER TABLE slotlock.calendar_events ADD COLUMN IF NOT EXISTS zone_shift_reported_at timestamptz;
CREATE OR REPLACE FUNCTION slotlock.calendar_event_wall_time()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_calendar_event_wall_time$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
     OR NEW.timezone IS DISTINCT FROM OLD.timezone THEN
    NEW.wall_starts_at := slotlock.zoned_wall(NEW.starts_at, NEW.timezone);
    NEW.wall_ends_at := slotlock.zoned_wall(NEW.ends_at, NEW.timezone);
    NEW.zone_shift_reported_at := NULL;
  END IF;
  RETURN NEW;
END
$slotlock_calendar_event_wall_time$;
DROP TRIGGER IF EXISTS slotlock_calendar_event_wall_time ON slotlock.calendar_events;
CREATE TRIGGER slotlock_calendar_event_wall_time
  BEFORE INSERT OR UPDATE ON slotlock.calendar_events
  FOR EACH ROW EXECUTE FUNCTION slotlock.calendar_event_wall_time();
-- Events written before this release: their wall time as the rules read now.
UPDATE slotlock.calendar_events
   SET wall_starts_at = slotlock.zoned_wall(starts_at, timezone),
       wall_ends_at = slotlock.zoned_wall(ends_at, timezone)
 WHERE wall_starts_at IS NULL AND ends_at > now();

-- Feed health: a source's last failure, and when its staleness was last reported on the feed.
ALTER TABLE slotlock.calendar_coverage ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE slotlock.calendar_coverage ADD COLUMN IF NOT EXISTS last_error_at timestamptz;
ALTER TABLE slotlock.calendar_coverage ADD COLUMN IF NOT EXISTS stale_reported_at timestamptz;
-- How the feed names a source (0.6): \`src_\` and 32 random hex digits, made when the source is first
-- recorded for the resource and kept until it is deleted, so nobody can confirm a guessed source
-- against it (0.5.3 named it by an unkeyed digest of the tenant and the source). Added bare, its
-- default set apart (a volatile default on ADD COLUMN would rewrite the table under the lock), the
-- sources already there given one each, and its CHECK NOT VALID, validated after the migration
-- commits. Only listCoverage gives the source beside it, to the tenant.
ALTER TABLE slotlock.calendar_coverage ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE slotlock.calendar_coverage
  ALTER COLUMN source_id SET DEFAULT 'src_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
UPDATE slotlock.calendar_coverage SET source_id = DEFAULT WHERE source_id IS NULL;
DO $slotlock_coverage_source_id$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.calendar_coverage'::regclass
       AND conname = 'slotlock_calendar_coverage_source_id_valid'
  ) THEN
    ALTER TABLE slotlock.calendar_coverage
      ADD CONSTRAINT slotlock_calendar_coverage_source_id_valid
      CHECK (source_id IS NOT NULL AND source_id ~ '^src_[0-9a-f]{32}$') NOT VALID;
  END IF;
END
$slotlock_coverage_source_id$;

-- Configuration changes (RFC 0002 P1-6): a resource's own settings, the sources its coverage is
-- read from, and the tenant's webhook endpoints. Each change that alters something appends one row,
-- with what it was before and after for the fields it changed; writing the same value again appends
-- none. Erasure is not reported, as above.
CREATE OR REPLACE FUNCTION slotlock.outbox_erasing(owner text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_outbox_erasing$
  SELECT owner = current_setting('slotlock.erasing', true)
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace
                          WHERE nspname = 'slotlock');
$slotlock_outbox_erasing$;

CREATE OR REPLACE FUNCTION slotlock.outbox_resource_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_outbox_resource$
DECLARE
  changed slotlock.resources%ROWTYPE;
  kind text;
  before jsonb := '{}'::jsonb;
  after jsonb := '{}'::jsonb;
  -- The profile fields that changed, by name only: a name or description is calendar content.
  profile_changed text[] := '{}';
  details jsonb;
BEGIN
  changed := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF changed.tenant_ref IS NULL OR slotlock.outbox_erasing(changed.tenant_ref) THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    kind := 'resource.created';
    details := jsonb_build_object(
      'timezone', NEW.timezone, 'visibility', NEW.visibility, 'pool', NEW.pool_ref, 'location', NEW.location_ref,
      'availability', NEW.availability_rules, 'booking_rules', NEW.booking_rules);
  ELSIF TG_OP = 'DELETE' THEN
    kind := 'resource.deleted';
    details := '{}'::jsonb;
  ELSIF (OLD.archived_at IS NULL) <> (NEW.archived_at IS NULL) THEN
    kind := CASE WHEN NEW.archived_at IS NULL THEN 'resource.restored' ELSE 'resource.archived' END;
    details := jsonb_build_object('archived_at', NEW.archived_at);
  ELSE
    -- Only what changed, under the names the API gives it; a null is kept (no pool, no rules).
    IF OLD.external_ref IS DISTINCT FROM NEW.external_ref THEN
      before := before || jsonb_build_object('reference', OLD.external_ref);
      after := after || jsonb_build_object('reference', NEW.external_ref);
    END IF;
    IF OLD.timezone IS DISTINCT FROM NEW.timezone THEN
      before := before || jsonb_build_object('timezone', OLD.timezone);
      after := after || jsonb_build_object('timezone', NEW.timezone);
    END IF;
    IF OLD.pool_ref IS DISTINCT FROM NEW.pool_ref THEN
      before := before || jsonb_build_object('pool', OLD.pool_ref);
      after := after || jsonb_build_object('pool', NEW.pool_ref);
    END IF;
    IF OLD.location_ref IS DISTINCT FROM NEW.location_ref THEN
      before := before || jsonb_build_object('location', OLD.location_ref);
      after := after || jsonb_build_object('location', NEW.location_ref);
    END IF;
    IF OLD.availability_rules IS DISTINCT FROM NEW.availability_rules THEN
      before := before || jsonb_build_object('availability', OLD.availability_rules);
      after := after || jsonb_build_object('availability', NEW.availability_rules);
    END IF;
    IF OLD.booking_rules IS DISTINCT FROM NEW.booking_rules THEN
      before := before || jsonb_build_object('booking_rules', OLD.booking_rules);
      after := after || jsonb_build_object('booking_rules', NEW.booking_rules);
    END IF;
    IF OLD.name IS DISTINCT FROM NEW.name THEN profile_changed := profile_changed || 'name'::text; END IF;
    IF OLD.description IS DISTINCT FROM NEW.description THEN
      profile_changed := profile_changed || 'description'::text;
    END IF;
    IF OLD.kind IS DISTINCT FROM NEW.kind THEN profile_changed := profile_changed || 'kind'::text; END IF;
    IF OLD.capacity IS DISTINCT FROM NEW.capacity THEN
      profile_changed := profile_changed || 'capacity'::text;
    END IF;
    IF OLD.labels IS DISTINCT FROM NEW.labels THEN profile_changed := profile_changed || 'labels'::text; END IF;
    IF OLD.attributes IS DISTINCT FROM NEW.attributes THEN
      profile_changed := profile_changed || 'attributes'::text;
    END IF;
    IF after = '{}'::jsonb AND cardinality(profile_changed) = 0 THEN RETURN NULL; END IF;
    kind := 'resource.updated';
    details := jsonb_build_object('before', before, 'after', after)
      || CASE WHEN cardinality(profile_changed) > 0
              THEN jsonb_build_object('profile_changed', to_jsonb(profile_changed))
              ELSE '{}'::jsonb END;
  END IF;
  INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
  VALUES (
    changed.tenant_ref, changed.id, kind, changed.id::text,
    jsonb_build_object('id', changed.id, 'reference', changed.external_ref) || details,
    NULLIF(current_setting('slotlock.actor', true), '')
  );
  RETURN NULL;
END
$slotlock_outbox_resource$;

-- A source first recorded, and deleted. Reading it again (a new revision) is progress, not a change
-- of what the resource is read from, and appends nothing; neither does a resource's deletion, which
-- takes its coverage with it and is its own change. The source is named by its random source_id:
-- it can be an iCalendar URL with a token in it, or an address.
CREATE OR REPLACE FUNCTION slotlock.outbox_coverage_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_outbox_coverage$
DECLARE
  changed slotlock.calendar_coverage%ROWTYPE;
BEGIN
  changed := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF slotlock.outbox_erasing(changed.tenant_ref) THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM slotlock.resources resource WHERE resource.id = OLD.resource_id) THEN
    RETURN NULL;
  END IF;
  INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
  VALUES (
    changed.tenant_ref, changed.resource_id,
    CASE WHEN TG_OP = 'DELETE' THEN 'coverage.deleted' ELSE 'coverage.recorded' END,
    changed.source_id,
    jsonb_strip_nulls(jsonb_build_object(
      'resource_id', changed.resource_id,
      'source_id', changed.source_id,
      'start', CASE WHEN TG_OP = 'INSERT' THEN changed.starts_at END,
      'end', CASE WHEN TG_OP = 'INSERT' THEN changed.ends_at END,
      'revision', CASE WHEN TG_OP = 'INSERT' THEN changed.revision END)),
    NULLIF(current_setting('slotlock.actor', true), '')
  );
  RETURN NULL;
END
$slotlock_outbox_coverage$;

-- An endpoint added, enabled again or deleted (disabling is webhook.disabled, from the delivery that
-- gave up). Its id and the types it takes, never its URL, which can carry a token, or its secret.
CREATE OR REPLACE FUNCTION slotlock.outbox_webhook_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_outbox_webhook$
DECLARE
  changed slotlock.webhook_endpoints%ROWTYPE;
  kind text;
BEGIN
  changed := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF slotlock.outbox_erasing(changed.tenant_ref) THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' THEN
    kind := 'webhook.created';
  ELSIF TG_OP = 'DELETE' THEN
    kind := 'webhook.deleted';
  ELSIF OLD.disabled_at IS NOT NULL AND NEW.disabled_at IS NULL THEN
    kind := 'webhook.enabled';
  ELSE
    RETURN NULL;
  END IF;
  INSERT INTO slotlock.outbox (tenant_ref, type, subject, data, actor)
  VALUES (
    changed.tenant_ref, kind, changed.id::text,
    jsonb_build_object('id', changed.id, 'event_types', to_jsonb(changed.event_types))
      || CASE WHEN changed.filter_resource_ids IS NULL AND changed.filter_pools IS NULL
                   AND changed.filter_locations IS NULL AND changed.filter_groups IS NULL
              THEN '{}'::jsonb
              ELSE jsonb_build_object('filter', jsonb_strip_nulls(jsonb_build_object(
                'resource_ids', to_jsonb(changed.filter_resource_ids), 'pools', to_jsonb(changed.filter_pools),
                'locations', to_jsonb(changed.filter_locations), 'groups', to_jsonb(changed.filter_groups))))
         END,
    NULLIF(current_setting('slotlock.actor', true), '')
  );
  RETURN NULL;
END
$slotlock_outbox_webhook$;

CREATE OR REPLACE TRIGGER slotlock_outbox_resource_change
  AFTER INSERT OR UPDATE OR DELETE ON slotlock.resources
  FOR EACH ROW EXECUTE FUNCTION slotlock.outbox_resource_change();
CREATE OR REPLACE TRIGGER slotlock_outbox_coverage_change
  AFTER INSERT OR DELETE ON slotlock.calendar_coverage
  FOR EACH ROW EXECUTE FUNCTION slotlock.outbox_coverage_change();

-- A coverage change an earlier release's server (0.3-0.5) still running writes, as it is inserted:
-- named by its source's source_id (src_redacted for a source it cannot find), without the source or
-- the error read from it. 0.5.2 and earlier wrote the source itself (an iCalendar URL with a token,
-- an address) and its last error; 0.5.3 its guessable digest. This release's own rows are in shape
-- and pass unchanged. It runs as the inserting role, under its tenant's RLS like the insert itself.
CREATE OR REPLACE FUNCTION slotlock.outbox_coverage_in_shape()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_outbox_coverage_in_shape$
DECLARE
  named text;
BEGIN
  IF ${coverageChangeInShapeSql('NEW')} THEN RETURN NEW; END IF;
  named := ${coverageChangeSourceIdSql('NEW')};
  NEW.subject := named;
  NEW.data := (NEW.data - 'source' - 'last_error') || pg_catalog.jsonb_build_object('source_id', named);
  RETURN NEW;
END
$slotlock_outbox_coverage_in_shape$;
CREATE OR REPLACE TRIGGER slotlock_outbox_coverage_in_shape
  BEFORE INSERT ON slotlock.outbox
  FOR EACH ROW WHEN (NEW.type LIKE 'coverage.%')
  EXECUTE FUNCTION slotlock.outbox_coverage_in_shape();
-- A resource put in a group or taken out of one (RFC 0003 G3): resource.updated, with the groups
-- it was in before and is in after, by reference, sorted. Once per statement, from the rows the
-- statement changed, so each resource it touched has one change, whatever its other groups; adding
-- a resource to a group it is in changes no row and appends none. Taken out because its group was
-- deleted is a change; because the resource was deleted (resource.deleted says so) or its tenant
-- erased is not.
CREATE OR REPLACE FUNCTION slotlock.outbox_group_membership_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_outbox_group_membership$
BEGIN
  INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
  SELECT resource.tenant_ref, resource.id, 'resource.updated', resource.id::text,
         jsonb_build_object(
           'id', resource.id, 'reference', resource.external_ref,
           'before', jsonb_build_object('groups', to_jsonb(CASE WHEN TG_OP = 'INSERT'
             THEN ARRAY(SELECT kept FROM unnest(now_in.refs) kept WHERE kept <> ALL (touched.groups) ORDER BY kept)
             ELSE ARRAY(SELECT DISTINCT was FROM unnest(now_in.refs || touched.groups) was ORDER BY was) END)),
           'after', jsonb_build_object('groups', to_jsonb(now_in.refs))),
         NULLIF(current_setting('slotlock.actor', true), '')
    FROM (SELECT changed.tenant_ref, changed.resource_id, array_agg(changed.group_ref) AS groups
            FROM changed_members changed
           GROUP BY changed.tenant_ref, changed.resource_id) touched
    JOIN slotlock.resources resource
      ON resource.id = touched.resource_id AND resource.tenant_ref = touched.tenant_ref
   CROSS JOIN LATERAL (
     SELECT ARRAY(SELECT member.group_ref FROM slotlock.resource_group_members member
                   WHERE member.tenant_ref = touched.tenant_ref AND member.resource_id = touched.resource_id
                   ORDER BY member.group_ref) AS refs) now_in
   -- IS NOT TRUE, not NOT: outbox_erasing is null for the schema owner outside erasure, and a
   -- cascade's trigger runs as the owner on PostgreSQL 18.
   WHERE slotlock.outbox_erasing(touched.tenant_ref) IS NOT TRUE
   ORDER BY resource.id;
  RETURN NULL;
END
$slotlock_outbox_group_membership$;
-- A trigger with a transition table takes one event; both name it changed_members for the function.
CREATE OR REPLACE TRIGGER slotlock_outbox_group_member_added
  AFTER INSERT ON slotlock.resource_group_members
  REFERENCING NEW TABLE AS changed_members
  FOR EACH STATEMENT EXECUTE FUNCTION slotlock.outbox_group_membership_change();
CREATE OR REPLACE TRIGGER slotlock_outbox_group_member_removed
  AFTER DELETE ON slotlock.resource_group_members
  REFERENCING OLD TABLE AS changed_members
  FOR EACH STATEMENT EXECUTE FUNCTION slotlock.outbox_group_membership_change();
CREATE OR REPLACE TRIGGER slotlock_outbox_webhook_change
  AFTER INSERT OR DELETE ON slotlock.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION slotlock.outbox_webhook_change();
-- Only an update that sets disabled_at: leases and deliveries, which do not, cost nothing here.
CREATE OR REPLACE TRIGGER slotlock_outbox_webhook_enabled
  AFTER UPDATE OF disabled_at ON slotlock.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION slotlock.outbox_webhook_change();

DROP TRIGGER IF EXISTS slotlock_outbox_reservation_change ON slotlock.reservations;
CREATE TRIGGER slotlock_outbox_reservation_change
  AFTER INSERT OR UPDATE OR DELETE ON slotlock.reservations
  FOR EACH ROW EXECUTE FUNCTION slotlock.outbox_reservation_change();
DROP TRIGGER IF EXISTS slotlock_outbox_calendar_event_change ON slotlock.calendar_events;
CREATE TRIGGER slotlock_outbox_calendar_event_change
  AFTER INSERT OR UPDATE OR DELETE ON slotlock.calendar_events
  FOR EACH ROW EXECUTE FUNCTION slotlock.outbox_calendar_event_change();
`;

// btree_gist is created in slotlock when it is missing; one installed elsewhere stays where it is.
const CORE_DDL_BODY = `
${DEPLOYMENT_SEARCH_PATH_PIN}CREATE SCHEMA IF NOT EXISTS slotlock;
${SLOTLOCK_DEPLOYMENT_CHECKS}CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA slotlock;
${DEPLOYMENT_LIFT_FORCED_ROW_SECURITY}${SLOTLOCK_SCHEMA_VERSION_DDL}
-- Records the exact catalog representation installed for each owned RLS policy. Health checks
-- compare live policy fingerprints with this contract so ALTER POLICY drift cannot hide behind a
-- retained name/comment. This table contains configuration only, never tenant or calendar data.
CREATE TABLE IF NOT EXISTS slotlock.rls_policy_contracts (
  table_name text PRIMARY KEY,
  tenant_context_setting text NOT NULL,
  policy_fingerprint text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slotlock.resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref text,
  tenant_ref text,
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slotlock.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES slotlock.resources(id) ON DELETE CASCADE,
  tenant_ref text,
  external_ref text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  buffer_after_ms bigint NOT NULL DEFAULT 0,
  occupied_ends_at timestamptz,
  buffer_before_ms bigint NOT NULL DEFAULT 0,
  occupied_starts_at timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'confirmed',
  expires_at timestamptz,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotlock_reservations_window_valid CHECK (ends_at > starts_at),
  CONSTRAINT slotlock_reservations_buffer_valid CHECK (
    buffer_after_ms >= 0 AND buffer_after_ms <= 2592000000
  ),
  CONSTRAINT slotlock_reservations_identity_shape CHECK (
    (tenant_ref IS NULL) = (external_ref IS NULL)
  ),
  CONSTRAINT slotlock_reservations_revision_valid CHECK (revision > 0),
  CONSTRAINT slotlock_reservations_occupied_end_valid CHECK (
    tenant_ref IS NULL
    OR (
      occupied_ends_at IS NOT NULL
      AND occupied_ends_at = ends_at + buffer_after_ms * interval '1 millisecond'
    )
  ),
  CONSTRAINT slotlock_reservations_buffer_before_valid CHECK (
    buffer_before_ms >= 0 AND buffer_before_ms <= 86400000
  ),
  -- NULL only without a leading buffer: a NULL occupied start reads as the start itself.
  CONSTRAINT slotlock_reservations_occupied_start_valid CHECK (
    (occupied_starts_at IS NULL AND buffer_before_ms = 0)
    OR (occupied_starts_at IS NOT NULL
        AND occupied_starts_at = starts_at - buffer_before_ms * interval '1 millisecond')
  ),
  CONSTRAINT slotlock_reservations_status_valid CHECK (status IN ('held', 'confirmed')),
  -- A hold must carry its expiry; a confirmed reservation must not (expiry is hold-only state).
  CONSTRAINT slotlock_reservations_expiry_shape CHECK (
    (status = 'held' AND expires_at IS NOT NULL)
    OR (status = 'confirmed' AND expires_at IS NULL)
  ),
  CONSTRAINT slotlock_reservations_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(COALESCE(occupied_starts_at, starts_at), COALESCE(occupied_ends_at, ends_at), '[)') WITH &&
  )
);

-- Idempotent evolution for pre-holds spike schemas: columns AND the shape CHECKs bind on
-- evolved tables too, so every applied schema enforces identical invariants.
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmed';
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS tenant_ref text;
-- A resource's own bookable hours (weekly-hours.ts validates each rule); NULL uses the default.
-- Its CHECK holds SLOTLOCK_MAX_AVAILABILITY_RULES as it was when first added: changing the cap
-- needs a constraint under a new name.
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS availability_rules jsonb;
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS booking_rules jsonb;
-- Since when the booking rules have asked for check-in: only bookings made after it are released
-- unclaimed (releaseNoShows), so turning the rule on releases none of the bookings already made.
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS check_in_since timestamptz;
-- When the booking was claimed (checkInReservation); null while it has not been.
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;
-- The pool (a vehicle class, a room type) whose interchangeable members this resource is one of.
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS pool_ref text;
CREATE INDEX IF NOT EXISTS slotlock_resources_pool_idx
  ON slotlock.resources (tenant_ref, pool_ref, id) WHERE pool_ref IS NOT NULL;
-- Who sees a resource: 'shared' ones are listed to agents and booked through them, 'private' ones
-- (a tax-deadline calendar, say) only by the tenant's own code. Fixed when the resource is created.
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'shared';
-- When the tenant archived it: listed nowhere and booked no more, its history kept. NULL: in use.
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS archived_at timestamptz;
-- Its profile (resource-profile.ts, RFC 0003 G1), each part optional: a name shown instead of the
-- reference, a description, what kind of thing it is (a hint for filtering, never a rule), how many
-- people or seats it holds (informational, never enforced), labels to find it by, and attributes
-- the integrator wants back. Calendar content: the feed names the fields that changed, never their
-- values. Added with constant defaults, so no row is rewritten.
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'other';
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS capacity integer;
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS labels text[] NOT NULL DEFAULT '{}';
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS slotlock_resources_labels_idx ON slotlock.resources USING gin (labels);
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS tenant_ref text;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS external_ref text;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS buffer_after_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS occupied_ends_at timestamptz;
-- The leading buffer a booking keeps before its start (its resource's bufferBeforeMinutes when it
-- was made), and where its occupied time starts: its start less that buffer. A row written before
-- leading buffers has none, so its occupied time starts at its start (NULL reads as starts_at).
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS buffer_before_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS occupied_starts_at timestamptz;
-- A keyed hold's holder (its principal) and the group of alternatives it was taken in: an agent
-- releases or books only its own holds, and booking one releases the rest of its group.
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS holder_ref text;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS hold_group_id uuid;
CREATE INDEX IF NOT EXISTS slotlock_reservations_hold_group_idx
  ON slotlock.reservations (hold_group_id) WHERE hold_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS slotlock_reservations_holder_idx
  ON slotlock.reservations (holder_ref, expires_at) WHERE status = 'held' AND holder_ref IS NOT NULL;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;

-- timestamptz + interval is STABLE (session timezone aware), so PostgreSQL correctly refuses it
-- inside an exclusion-index expression. Materialize the occupied end under a trigger instead;
-- the GiST range below then uses columns only while raw rental end remains separately queryable.
CREATE OR REPLACE FUNCTION slotlock.set_reservation_occupied_end()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $$
BEGIN
  NEW.occupied_ends_at := NEW.ends_at + NEW.buffer_after_ms * interval '1 millisecond';
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'slotlock_reservations_set_occupied_end'
       AND tgrelid = 'slotlock.reservations'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER slotlock_reservations_set_occupied_end
    BEFORE INSERT OR UPDATE OF ends_at, buffer_after_ms ON slotlock.reservations
    FOR EACH ROW EXECUTE FUNCTION slotlock.set_reservation_occupied_end();
  END IF;
END $$;

-- The occupied start, materialized for the same reason as the occupied end.
CREATE OR REPLACE FUNCTION slotlock.set_reservation_occupied_start()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $$
BEGIN
  NEW.occupied_starts_at := NEW.starts_at - NEW.buffer_before_ms * interval '1 millisecond';
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'slotlock_reservations_set_occupied_start'
       AND tgrelid = 'slotlock.reservations'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER slotlock_reservations_set_occupied_start
    BEFORE INSERT OR UPDATE OF starts_at, buffer_before_ms ON slotlock.reservations
    FOR EACH ROW EXECUTE FUNCTION slotlock.set_reservation_occupied_start();
  END IF;
END $$;

-- Cancellation is an idempotency fact, not the absence of a reservation. Keeping a tombstone
-- prevents delayed at-least-once create delivery from resurrecting a cancelled booking key.
CREATE TABLE IF NOT EXISTS slotlock.reservation_tombstones (
  tenant_ref text NOT NULL,
  external_ref text NOT NULL,
  revision bigint NOT NULL,
  PRIMARY KEY (tenant_ref, external_ref),
  CONSTRAINT slotlock_reservation_tombstones_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND octet_length(external_ref) BETWEEN 1 AND 500
  ),
  CONSTRAINT slotlock_reservation_tombstones_revision_valid CHECK (revision > 0)
);
-- When the reference was retired, so maintenance can prune it past the retention window. Rows from
-- before 0.3 read '-infinity', earlier than every time, so none counts as a recent cancellation
-- against the tenant's limits; new rows take now(). An ADD COLUMN default is evaluated once and
-- kept for the rows already there, with no table rewrite, and SET DEFAULT changes only later
-- inserts (PostgreSQL 16, ALTER TABLE notes; Date/Time Types, special values).
ALTER TABLE slotlock.reservation_tombstones
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NOT NULL DEFAULT '-infinity';
ALTER TABLE slotlock.reservation_tombstones ALTER COLUMN cancelled_at SET DEFAULT now();
-- True when the cancel retired a reference no booking held (its create may still be on the way).
-- Only those are pruned past the retention window. A cancelled booking's tombstone is kept until
-- the tenant is erased, so a delayed or replayed create never books it again; rows from before 0.3
-- are kept too.
ALTER TABLE slotlock.reservation_tombstones
  ADD COLUMN IF NOT EXISTS stray boolean NOT NULL DEFAULT false;
-- Resource identity: one resource per tenant/external_ref namespace (plus one isolated NULL-tenant
-- legacy namespace). Dedupe first (repoint reservations to the keeper, drop the rest) so the
-- unique indexes also bind on DBs poisoned by the pre-index
-- SELECT-then-INSERT race, then enforce. Conflicting reservations cannot simply be repointed:
-- the EXCLUDE constraint would abort bootstrap forever. Preserve those rows in an immutable
-- quarantine and deterministically keep the first occupier; non-conflicting rows are repointed.
CREATE TABLE IF NOT EXISTS slotlock.reservation_conflict_archive (
  archive_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text,
  original_reservation_id uuid NOT NULL UNIQUE,
  original_resource_id uuid NOT NULL,
  keeper_resource_id uuid NOT NULL,
  external_ref text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL,
  expires_at timestamptz,
  source text,
  original_created_at timestamptz NOT NULL,
  reason text NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotlock_reservation_conflict_archive_tenant_valid CHECK (
    tenant_ref IS NULL OR octet_length(tenant_ref) BETWEEN 1 AND 500
  )
);

ALTER TABLE slotlock.reservation_conflict_archive ADD COLUMN IF NOT EXISTS tenant_ref text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservation_conflict_archive_tenant_valid'
       AND conrelid = 'slotlock.reservation_conflict_archive'::regclass
  ) THEN
    ALTER TABLE slotlock.reservation_conflict_archive
      ADD CONSTRAINT slotlock_reservation_conflict_archive_tenant_valid CHECK (
        tenant_ref IS NULL OR octet_length(tenant_ref) BETWEEN 1 AND 500
      ) NOT VALID;
  END IF;
END $$;

-- Bind archives installed by the previous schema to their surviving keeper before RLS stops
-- consulting that mutable/deletable row. Truly tenantless legacy archives remain fail-closed.
UPDATE slotlock.reservation_conflict_archive archive
   SET tenant_ref = keeper.tenant_ref
  FROM slotlock.resources keeper
 WHERE keeper.id = archive.keeper_resource_id
   AND archive.tenant_ref IS NULL
   AND keeper.tenant_ref IS NOT NULL;

DO $slotlock_dedupe$
DECLARE
  candidate record;
  exact_duplicate boolean;
BEGIN
  FOR candidate IN
    WITH keepers AS (
      SELECT tenant_ref, external_ref, min(id::text)::uuid AS keep_id
        FROM slotlock.resources
       WHERE external_ref IS NOT NULL
       GROUP BY tenant_ref, external_ref
    )
    SELECT res.id, res.resource_id, res.starts_at, res.ends_at, res.status,
           res.expires_at, res.source, res.created_at, r.tenant_ref,
           r.external_ref, k.keep_id
      FROM slotlock.reservations res
      JOIN slotlock.resources r ON r.id = res.resource_id
      JOIN keepers k
        ON k.external_ref = r.external_ref
       AND k.tenant_ref IS NOT DISTINCT FROM r.tenant_ref
     WHERE r.id <> k.keep_id
     ORDER BY r.tenant_ref, r.external_ref, r.id, res.starts_at, res.ends_at, res.id
  LOOP
    IF EXISTS (
      SELECT 1
        FROM slotlock.reservations kept
       WHERE kept.resource_id = candidate.keep_id
         AND kept.id <> candidate.id
         AND tstzrange(kept.starts_at, kept.ends_at, '[)')
             && tstzrange(candidate.starts_at, candidate.ends_at, '[)')
    ) THEN
      SELECT EXISTS (
        SELECT 1
          FROM slotlock.reservations kept
         WHERE kept.resource_id = candidate.keep_id
           AND kept.id <> candidate.id
           AND kept.starts_at = candidate.starts_at
           AND kept.ends_at = candidate.ends_at
      ) INTO exact_duplicate;

      INSERT INTO slotlock.reservation_conflict_archive (
        tenant_ref, original_reservation_id, original_resource_id, keeper_resource_id,
        external_ref, starts_at, ends_at, status, expires_at, source,
        original_created_at, reason
      ) VALUES (
        candidate.tenant_ref, candidate.id, candidate.resource_id, candidate.keep_id,
        candidate.external_ref, candidate.starts_at, candidate.ends_at, candidate.status,
        candidate.expires_at, candidate.source, candidate.created_at,
        CASE WHEN exact_duplicate THEN 'duplicate_interval' ELSE 'overlap_conflict' END
      )
      ON CONFLICT (original_reservation_id) DO NOTHING;

      DELETE FROM slotlock.reservations WHERE id = candidate.id;
    ELSE
      UPDATE slotlock.reservations
         SET resource_id = candidate.keep_id
       WHERE id = candidate.id;
    END IF;
  END LOOP;
END
$slotlock_dedupe$;

DELETE FROM slotlock.resources r
 USING (
   SELECT r2.id FROM slotlock.resources r2
     JOIN (
       SELECT tenant_ref, external_ref, min(id::text)::uuid AS keep_id
         FROM slotlock.resources
        WHERE external_ref IS NOT NULL
        GROUP BY tenant_ref, external_ref
     ) k
       ON k.external_ref = r2.external_ref
      AND k.tenant_ref IS NOT DISTINCT FROM r2.tenant_ref
      AND r2.id <> k.keep_id
 ) dead
 WHERE r.id = dead.id;

-- external_ref is a provider/customer namespace, never a global resource identity. Remove the
-- earlier global key and retain a separate NULL-tenant compatibility namespace for spike callers.
DROP INDEX IF EXISTS slotlock.slotlock_resources_external_ref_key;
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_resources_tenant_external_ref_key
  ON slotlock.resources (tenant_ref, external_ref)
  WHERE tenant_ref IS NOT NULL AND external_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_resources_legacy_external_ref_key
  ON slotlock.resources (external_ref)
  WHERE tenant_ref IS NULL AND external_ref IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_resources_id_tenant_key'
       AND conrelid = 'slotlock.resources'::regclass
  ) THEN
    ALTER TABLE slotlock.resources
      ADD CONSTRAINT slotlock_resources_id_tenant_key UNIQUE (id, tenant_ref);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_resources_availability_rules_valid'
       AND conrelid = 'slotlock.resources'::regclass
  ) THEN
    ALTER TABLE slotlock.resources
      ADD CONSTRAINT slotlock_resources_availability_rules_valid CHECK (
        availability_rules IS NULL
        OR CASE WHEN jsonb_typeof(availability_rules) = 'array'
                THEN jsonb_array_length(availability_rules) <= ${SLOTLOCK_MAX_AVAILABILITY_RULES}
                ELSE false END
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_resources_pool_ref_valid'
  ) THEN
    ALTER TABLE slotlock.resources
      ADD CONSTRAINT slotlock_resources_pool_ref_valid CHECK (
        pool_ref IS NULL OR (char_length(pool_ref) BETWEEN 1 AND 100 AND pool_ref ~ '^[a-z0-9][a-z0-9._-]*$')
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_resources_booking_rules_valid'
       AND conrelid = 'slotlock.resources'::regclass
  ) THEN
    ALTER TABLE slotlock.resources
      ADD CONSTRAINT slotlock_resources_booking_rules_valid CHECK (
        booking_rules IS NULL OR jsonb_typeof(booking_rules) = 'object'
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_resources_visibility_valid'
       AND conrelid = 'slotlock.resources'::regclass
  ) THEN
    ALTER TABLE slotlock.resources
      ADD CONSTRAINT slotlock_resources_visibility_valid CHECK (visibility IN ('shared', 'private'));
  END IF;
  -- The profile's bounds (SLOTLOCK_RESOURCE_PROFILE_LIMITS), NOT VALID so adding them scans
  -- nothing under the lock; DEPLOYMENT_VALIDATE_CONSTRAINTS validates them after the migration.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_resources_profile_valid'
       AND conrelid = 'slotlock.resources'::regclass
  ) THEN
    ALTER TABLE slotlock.resources
      ADD CONSTRAINT slotlock_resources_profile_valid CHECK (
        (name IS NULL OR (char_length(name) BETWEEN 1 AND ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.name}
                          AND btrim(name) <> ''))
        AND (description IS NULL
             OR (char_length(description) BETWEEN 1 AND ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.description}
                 AND btrim(description) <> ''))
        AND kind IN (${SLOTLOCK_RESOURCE_KINDS.map((kind) => `'${kind}'`).join(', ')})
        AND (capacity IS NULL OR capacity BETWEEN 1 AND ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.capacity})
        AND cardinality(labels) <= ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.labels}
        AND array_position(labels, NULL) IS NULL
        AND (cardinality(labels) = 0
             OR array_to_string(labels, ',') ~ '^[a-z0-9][a-z0-9._-]{0,63}(,[a-z0-9][a-z0-9._-]{0,63})*$')
        AND jsonb_typeof(attributes) = 'object'
        AND octet_length(attributes::text) <= ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.attributeBytes * 2}
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_revision_valid'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_revision_valid CHECK (revision > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_id_tenant_key'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_id_tenant_key UNIQUE (id, tenant_ref);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_resource_tenant_fkey'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_resource_tenant_fkey
      FOREIGN KEY (resource_id, tenant_ref)
      REFERENCES slotlock.resources (id, tenant_ref) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_status_valid'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_status_valid CHECK (status IN ('held', 'confirmed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_identity_shape'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_identity_shape CHECK (
        (tenant_ref IS NULL) = (external_ref IS NULL)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_occupied_end_valid'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_occupied_end_valid CHECK (
        tenant_ref IS NULL
        OR (
          occupied_ends_at IS NOT NULL
          AND occupied_ends_at = ends_at + buffer_after_ms * interval '1 millisecond'
        )
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_expiry_shape'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_expiry_shape CHECK (
        (status = 'held' AND expires_at IS NOT NULL)
        OR (status = 'confirmed' AND expires_at IS NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_buffer_valid'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_buffer_valid CHECK (
        buffer_after_ms >= 0 AND buffer_after_ms <= 2592000000
      ) NOT VALID;
  END IF;
  -- Every existing row has no leading buffer, so both hold of it; added NOT VALID (no scan under
  -- the lock) and validated after the migration commits.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_buffer_before_valid'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_buffer_before_valid CHECK (
        buffer_before_ms >= 0 AND buffer_before_ms <= 86400000
      ) NOT VALID;
  END IF;
  -- A first form of this check let a NULL occupied start through with a leading buffer (the
  -- comparison is NULL, which a CHECK passes): replaced wherever it lacks the IS NOT NULL guard.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_occupied_start_valid'
       AND conrelid = 'slotlock.reservations'::regclass
       AND pg_catalog.pg_get_constraintdef(oid) LIKE '%occupied_starts_at IS NOT NULL%'
  ) THEN
    ALTER TABLE slotlock.reservations DROP CONSTRAINT IF EXISTS slotlock_reservations_occupied_start_valid;
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_occupied_start_valid CHECK (
        (occupied_starts_at IS NULL AND buffer_before_ms = 0)
        OR (occupied_starts_at IS NOT NULL
            AND occupied_starts_at = starts_at - buffer_before_ms * interval '1 millisecond')
      ) NOT VALID;
  END IF;
END $$;

-- Where a tenant's resources are (RFC 0003 G2, resource-profile.ts): a tree of at most
-- ${SLOTLOCK_MAX_LOCATION_DEPTH} levels (a region, a site, a building, a floor, a zone, or whatever the
-- tenant's are), at most ${SLOTLOCK_MAX_LOCATIONS} a tenant, each named by a reference of the tenant's own.
-- A location something is in (a resource, or a location under it) cannot be deleted: the foreign
-- keys are NO ACTION, checked at the end of the statement, so erasing a whole tenant's tree in one
-- statement passes. Its time zone, when it has one, is the one a resource created there without
-- its own takes (the nearest location above that has one).
CREATE TABLE IF NOT EXISTS slotlock.locations (
  tenant_ref text NOT NULL,
  ref text NOT NULL,
  name text NOT NULL,
  parent_ref text,
  timezone text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_locations_pkey PRIMARY KEY (tenant_ref, ref),
  CONSTRAINT slotlock_locations_parent_fkey FOREIGN KEY (tenant_ref, parent_ref)
    REFERENCES slotlock.locations (tenant_ref, ref),
  CONSTRAINT slotlock_locations_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND ref ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
    AND char_length(name) BETWEEN 1 AND ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.name} AND btrim(name) <> ''
    AND (parent_ref IS NULL OR parent_ref <> ref)
    AND (timezone IS NULL OR char_length(timezone) BETWEEN 1 AND 100)
  )
);
CREATE INDEX IF NOT EXISTS slotlock_locations_parent_idx
  ON slotlock.locations (tenant_ref, parent_ref) WHERE parent_ref IS NOT NULL;

-- A location's depth, a loop through its parents, and the tenant's count, under the tenant's
-- location lock, so two writers never each pass a check the other then breaks.
CREATE OR REPLACE FUNCTION slotlock.locations_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_locations_guard$
DECLARE
  above integer := 0;
  below integer := 0;
  looped boolean := false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:locations:' || NEW.tenant_ref, 0));
  -- An upsert of a location the tenant has fires this before its conflict is found: not a new one.
  IF TG_OP = 'INSERT'
     AND NOT EXISTS (SELECT 1 FROM slotlock.locations kept
                      WHERE kept.tenant_ref = NEW.tenant_ref AND kept.ref = NEW.ref)
     AND (SELECT count(*) FROM slotlock.locations kept WHERE kept.tenant_ref = NEW.tenant_ref)
         >= ${SLOTLOCK_MAX_LOCATIONS} THEN
    RAISE EXCEPTION 'Slotlock keeps at most ${SLOTLOCK_MAX_LOCATIONS} locations a tenant'
      USING ERRCODE = 'check_violation', HINT = 'location_limit_reached';
  END IF;
  IF NEW.parent_ref IS NOT NULL THEN
    WITH RECURSIVE up(at, parent, steps) AS (
      SELECT kept.ref, kept.parent_ref, 1 FROM slotlock.locations kept
       WHERE kept.tenant_ref = NEW.tenant_ref AND kept.ref = NEW.parent_ref
      UNION ALL
      SELECT kept.ref, kept.parent_ref, up.steps + 1
        FROM slotlock.locations kept JOIN up ON kept.tenant_ref = NEW.tenant_ref AND kept.ref = up.parent
       WHERE up.steps <= ${SLOTLOCK_MAX_LOCATION_DEPTH}
    )
    SELECT coalesce(max(up.steps), 0), coalesce(bool_or(up.at = NEW.ref), false)
      INTO above, looped FROM up;
    IF looped THEN
      RAISE EXCEPTION 'Slotlock location cannot be under itself'
        USING ERRCODE = 'check_violation', HINT = 'location_cycle';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    WITH RECURSIVE down(at, steps) AS (
      SELECT kept.ref, 1 FROM slotlock.locations kept
       WHERE kept.tenant_ref = NEW.tenant_ref AND kept.parent_ref = NEW.ref
      UNION ALL
      SELECT kept.ref, down.steps + 1
        FROM slotlock.locations kept JOIN down ON kept.tenant_ref = NEW.tenant_ref AND kept.parent_ref = down.at
       WHERE down.steps <= ${SLOTLOCK_MAX_LOCATION_DEPTH}
    )
    SELECT coalesce(max(down.steps), 0) INTO below FROM down;
  END IF;
  IF above + 1 + below > ${SLOTLOCK_MAX_LOCATION_DEPTH} THEN
    RAISE EXCEPTION 'Slotlock locations are at most ${SLOTLOCK_MAX_LOCATION_DEPTH} levels deep'
      USING ERRCODE = 'check_violation', HINT = 'location_too_deep';
  END IF;
  RETURN NEW;
END
$slotlock_locations_guard$;
CREATE OR REPLACE TRIGGER slotlock_locations_guard
  BEFORE INSERT OR UPDATE OF parent_ref ON slotlock.locations
  FOR EACH ROW EXECUTE FUNCTION slotlock.locations_guard();

-- The location a resource is at, one at most; null when not said.
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS location_ref text;
CREATE INDEX IF NOT EXISTS slotlock_resources_location_idx
  ON slotlock.resources (tenant_ref, location_ref) WHERE location_ref IS NOT NULL;
DO $slotlock_resources_location$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_resources_location_fkey'
       AND conrelid = 'slotlock.resources'::regclass
  ) THEN
    -- NOT VALID: the column is new, and DEPLOYMENT_VALIDATE_CONSTRAINTS validates it after.
    ALTER TABLE slotlock.resources
      ADD CONSTRAINT slotlock_resources_location_fkey FOREIGN KEY (tenant_ref, location_ref)
      REFERENCES slotlock.locations (tenant_ref, ref) NOT VALID;
  END IF;
END
$slotlock_resources_location$;

-- Any set of resources a tenant wants (RFC 0003 G3): a team, a department, a contract, "Saturday
-- clinic", "airport vans". Many a resource, at most ${SLOTLOCK_MAX_GROUPS_PER_RESOURCE}, and at most
-- ${SLOTLOCK_MAX_RESOURCE_GROUPS} a tenant. No booking rule reads them: a pool is how resources are
-- booked as a class.
CREATE TABLE IF NOT EXISTS slotlock.resource_groups (
  tenant_ref text NOT NULL,
  ref text NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_resource_groups_pkey PRIMARY KEY (tenant_ref, ref),
  CONSTRAINT slotlock_resource_groups_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND ref ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
    AND char_length(name) BETWEEN 1 AND ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.name} AND btrim(name) <> ''
    AND (description IS NULL
         OR (char_length(description) BETWEEN 1 AND ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.description}
             AND btrim(description) <> ''))
  )
);
CREATE TABLE IF NOT EXISTS slotlock.resource_group_members (
  tenant_ref text NOT NULL,
  group_ref text NOT NULL,
  resource_id uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_resource_group_members_pkey PRIMARY KEY (tenant_ref, group_ref, resource_id),
  CONSTRAINT slotlock_resource_group_members_group_fkey FOREIGN KEY (tenant_ref, group_ref)
    REFERENCES slotlock.resource_groups (tenant_ref, ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_resource_group_members_resource_fkey FOREIGN KEY (resource_id, tenant_ref)
    REFERENCES slotlock.resources (id, tenant_ref) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS slotlock_resource_group_members_resource_idx
  ON slotlock.resource_group_members (tenant_ref, resource_id);

-- The counts, under the tenant's group lock.
CREATE OR REPLACE FUNCTION slotlock.resource_groups_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_resource_groups_guard$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:groups:' || NEW.tenant_ref, 0));
  -- An upsert of a group, or a membership, the tenant has fires this before its conflict is found.
  IF TG_TABLE_NAME = 'resource_groups' THEN
    IF NOT EXISTS (SELECT 1 FROM slotlock.resource_groups kept
                    WHERE kept.tenant_ref = NEW.tenant_ref AND kept.ref = NEW.ref)
       AND (SELECT count(*) FROM slotlock.resource_groups kept WHERE kept.tenant_ref = NEW.tenant_ref)
           >= ${SLOTLOCK_MAX_RESOURCE_GROUPS} THEN
      RAISE EXCEPTION 'Slotlock keeps at most ${SLOTLOCK_MAX_RESOURCE_GROUPS} groups a tenant'
        USING ERRCODE = 'check_violation', HINT = 'group_limit_reached';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM slotlock.resource_group_members kept
                     WHERE kept.tenant_ref = NEW.tenant_ref AND kept.group_ref = NEW.group_ref
                       AND kept.resource_id = NEW.resource_id)
        AND (SELECT count(*) FROM slotlock.resource_group_members kept
              WHERE kept.tenant_ref = NEW.tenant_ref AND kept.resource_id = NEW.resource_id)
            >= ${SLOTLOCK_MAX_GROUPS_PER_RESOURCE} THEN
    RAISE EXCEPTION 'Slotlock puts a resource in at most ${SLOTLOCK_MAX_GROUPS_PER_RESOURCE} groups'
      USING ERRCODE = 'check_violation', HINT = 'resource_group_limit_reached';
  END IF;
  RETURN NEW;
END
$slotlock_resource_groups_guard$;
CREATE OR REPLACE TRIGGER slotlock_resource_groups_guard
  BEFORE INSERT ON slotlock.resource_groups
  FOR EACH ROW EXECUTE FUNCTION slotlock.resource_groups_guard();
CREATE OR REPLACE TRIGGER slotlock_resource_group_members_guard
  BEFORE INSERT ON slotlock.resource_group_members
  FOR EACH ROW EXECUTE FUNCTION slotlock.resource_groups_guard();

-- Every row occupies from its start to its occupied end: its end plus its turnaround buffer. Up to
-- 0.1 the buffer bound only tenant-owned bookings to each other (slotlock_reservations_buffered_no_overlap),
-- so a hold could take a booking's buffer and a buffered booking could cover a hold. The upgrade
-- reaps expired holds in the way, as the next writer would, then refuses to go on while a live row
-- is in the way: a constraint is never made to fit by deleting a booking or a live hold. Rows from
-- before the occupied-end trigger may lack occupied_ends_at; their end is where they stop.
DO $slotlock_occupied_overlap$
DECLARE
  conflicts bigint;
  examples text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_no_overlap'
       AND conrelid = 'slotlock.reservations'::regclass
       AND pg_catalog.pg_get_constraintdef(oid) LIKE '%occupied_ends_at%'
  ) THEN
    DELETE FROM slotlock.reservations hold
     USING slotlock.reservations buffered
     WHERE hold.status = 'held'
       AND hold.expires_at <= now()
       AND buffered.resource_id = hold.resource_id
       AND buffered.id <> hold.id
       AND buffered.buffer_after_ms > 0
       AND tstzrange(buffered.starts_at, COALESCE(buffered.occupied_ends_at, buffered.ends_at), '[)')
           && tstzrange(hold.starts_at, hold.ends_at, '[)');
    SELECT count(*),
           string_agg(buffered.id::text || ' and ' || other.id::text, ', ' ORDER BY buffered.id, other.id)
      INTO conflicts, examples
      FROM slotlock.reservations buffered
      JOIN slotlock.reservations other
        ON other.resource_id = buffered.resource_id
       AND other.id <> buffered.id
       AND tstzrange(buffered.starts_at, COALESCE(buffered.occupied_ends_at, buffered.ends_at), '[)')
           && tstzrange(other.starts_at, COALESCE(other.occupied_ends_at, other.ends_at), '[)')
     WHERE buffered.buffer_after_ms > 0
       -- A pair of buffered rows counts once.
       AND (other.buffer_after_ms = 0 OR buffered.id < other.id);
    IF conflicts > 0 THEN
      RAISE EXCEPTION 'Slotlock cannot upgrade: % reservations or holds overlap another''s turnaround buffer', conflicts
        USING ERRCODE = '23P01',
              DETAIL = 'Reservation ids, in pairs: ' || left(examples, 2000),
              HINT = 'Move, cancel or release one of each pair (slotlock.reservations), then migrate again.';
    END IF;
    ALTER TABLE slotlock.reservations DROP CONSTRAINT IF EXISTS slotlock_reservations_no_overlap;
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_no_overlap EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(COALESCE(occupied_starts_at, starts_at), COALESCE(occupied_ends_at, ends_at), '[)') WITH &&
      );
  END IF;
  ALTER TABLE slotlock.reservations DROP CONSTRAINT IF EXISTS slotlock_reservations_buffered_no_overlap;
END
$slotlock_occupied_overlap$;

-- A row occupies from its occupied start too: its start less its leading buffer. Every row an
-- upgrade finds was written before leading buffers and keeps none, so its range is the one the old
-- constraint already kept apart and none can conflict: the constraint is replaced in place, its
-- index built once under the migration's lock.
DO $slotlock_occupied_start_overlap$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_no_overlap'
       AND conrelid = 'slotlock.reservations'::regclass
       AND pg_catalog.pg_get_constraintdef(oid) LIKE '%occupied_starts_at%'
  ) THEN
    ALTER TABLE slotlock.reservations DROP CONSTRAINT IF EXISTS slotlock_reservations_no_overlap;
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_no_overlap EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(COALESCE(occupied_starts_at, starts_at), COALESCE(occupied_ends_at, ends_at), '[)') WITH &&
      );
  END IF;
END
$slotlock_occupied_start_overlap$;

CREATE INDEX IF NOT EXISTS slotlock_reservations_resource_time_idx
  ON slotlock.reservations (resource_id, starts_at, ends_at);

-- Trusted calendar content is deliberately separate from content-minimised provider busy
-- ingestion. One event belongs to exactly one tenant-owned resource and carries the full
-- RFC 5545 fields needed for interoperable authoring.
CREATE TABLE IF NOT EXISTS slotlock.calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL,
  owner_ref text NOT NULL DEFAULT 'internal',
  external_ref text NOT NULL,
  resource_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  summary text NOT NULL,
  description text,
  location text,
  status text NOT NULL DEFAULT 'confirmed',
  transparency text NOT NULL DEFAULT 'opaque',
  organizer jsonb,
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  reminders jsonb NOT NULL DEFAULT '[]'::jsonb,
  recurrence_rule text,
  recurrence_exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  materialized_starts_at timestamptz NOT NULL,
  materialized_ends_at timestamptz NOT NULL,
  revision bigint NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotlock_calendar_events_owner_external_key UNIQUE (tenant_ref, owner_ref, external_ref),
  CONSTRAINT slotlock_calendar_events_id_tenant_key UNIQUE (id, tenant_ref),
  CONSTRAINT slotlock_calendar_events_resource_tenant_fkey
    FOREIGN KEY (resource_id, tenant_ref)
    REFERENCES slotlock.resources (id, tenant_ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_calendar_events_owner_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND (owner_ref = 'internal' OR owner_ref ~ '^agent:[0-9a-f]{64}$')
    AND octet_length(external_ref) BETWEEN 1 AND 500
  ),
  CONSTRAINT slotlock_calendar_events_window_valid CHECK (ends_at > starts_at),
  -- A recurring series expands inside a window of at most 369 days (a 367-day search from any
  -- moment of the day, plus the day before it). A one-off event is its own window, so a lease or
  -- long rental may span up to 3,660 days (the store's hard ceiling).
  CONSTRAINT slotlock_calendar_events_materialization_window_limit CHECK (
    materialized_ends_at > materialized_starts_at
    AND (
      materialized_ends_at - materialized_starts_at <= interval '369 days'
      OR (
        recurrence_rule IS NULL
        AND materialized_starts_at = starts_at
        AND materialized_ends_at = ends_at
        AND ends_at - starts_at <= interval '3660 days'
      )
    )
  ),
  CONSTRAINT slotlock_calendar_events_revision_valid CHECK (revision > 0),
  CONSTRAINT slotlock_calendar_events_status_valid CHECK (status IN ('confirmed', 'tentative')),
  CONSTRAINT slotlock_calendar_events_transparency_valid CHECK (
    transparency IN ('opaque', 'transparent')
  ),
  CONSTRAINT slotlock_calendar_events_text_bounds CHECK (
    octet_length(summary) BETWEEN 1 AND 4096
    AND octet_length(timezone) BETWEEN 1 AND 255
    AND (description IS NULL OR octet_length(description) <= 16384)
    AND (location IS NULL OR octet_length(location) <= 16384)
    AND (source IS NULL OR octet_length(source) BETWEEN 1 AND 500)
    AND (recurrence_rule IS NULL OR octet_length(recurrence_rule) BETWEEN 1 AND 4096)
  ),
  CONSTRAINT slotlock_calendar_events_json_shape CHECK (
    (organizer IS NULL OR jsonb_typeof(organizer) = 'object')
    AND (organizer IS NULL OR octet_length(organizer::text) <= 4096)
    AND jsonb_typeof(attendees) = 'array'
    AND jsonb_array_length(attendees) <= 100
    AND octet_length(attendees::text) <= 131072
    AND jsonb_typeof(reminders) = 'array'
    AND jsonb_array_length(reminders) <= 20
    AND octet_length(reminders::text) <= 16384
    AND jsonb_typeof(recurrence_exceptions) = 'array'
    AND jsonb_array_length(recurrence_exceptions) <= 1000
    AND octet_length(recurrence_exceptions::text) <= 262144
  )
);

-- Existing standalone package deployments predate principal ownership. Their trusted/provider
-- events are explicitly adopted into the bounded internal namespace before composite identities
-- are enforced. The event UUID + tenant key remains stable for all normalized child FKs.
ALTER TABLE slotlock.calendar_events
  ADD COLUMN IF NOT EXISTS owner_ref text NOT NULL DEFAULT 'internal';
ALTER TABLE slotlock.calendar_events
  DROP CONSTRAINT IF EXISTS slotlock_calendar_events_tenant_external_key;
ALTER TABLE slotlock.calendar_events
  DROP CONSTRAINT IF EXISTS slotlock_calendar_events_identity_valid;
DO $slotlock_calendar_event_owner_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_calendar_events_owner_external_key'
       AND conrelid = 'slotlock.calendar_events'::regclass
  ) THEN
    ALTER TABLE slotlock.calendar_events
      ADD CONSTRAINT slotlock_calendar_events_owner_external_key
      UNIQUE (tenant_ref, owner_ref, external_ref);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_calendar_events_owner_identity_valid'
       AND conrelid = 'slotlock.calendar_events'::regclass
  ) THEN
    ALTER TABLE slotlock.calendar_events
      ADD CONSTRAINT slotlock_calendar_events_owner_identity_valid CHECK (
        octet_length(tenant_ref) BETWEEN 1 AND 500
        AND (owner_ref = 'internal' OR owner_ref ~ '^agent:[0-9a-f]{64}$')
        AND octet_length(external_ref) BETWEEN 1 AND 500
      );
  END IF;
END
$slotlock_calendar_event_owner_constraints$;

-- Schemas installed before long one-off events carry the 367-day-only window CHECK. The bounded
-- CHECK only admits more rows, so every stored row already satisfies it: add it NOT VALID (no table
-- scan under the lock) and drop the old one in the same transaction.
DO $slotlock_calendar_event_window_bounds$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname IN ('slotlock_calendar_events_materialization_window_bounded',
                       'slotlock_calendar_events_materialization_window_limit')
       AND conrelid = 'slotlock.calendar_events'::regclass
  ) THEN
    ALTER TABLE slotlock.calendar_events
      ADD CONSTRAINT slotlock_calendar_events_materialization_window_bounded CHECK (
        materialized_ends_at > materialized_starts_at
        AND (
          materialized_ends_at - materialized_starts_at <= interval '367 days'
          OR (
            recurrence_rule IS NULL
            AND materialized_starts_at = starts_at
            AND materialized_ends_at = ends_at
            AND ends_at - starts_at <= interval '3660 days'
          )
        )
      ) NOT VALID;
  END IF;
END
$slotlock_calendar_event_window_bounds$;
ALTER TABLE slotlock.calendar_events
  DROP CONSTRAINT IF EXISTS slotlock_calendar_events_materialization_window_valid;

-- Up to 0.2 a series' window was at most 367 days. The 369-day CHECK admits every row the 367-day
-- one did: add it NOT VALID and drop the old one in the same transaction.
DO $slotlock_calendar_event_window_limit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_calendar_events_materialization_window_limit'
       AND conrelid = 'slotlock.calendar_events'::regclass
  ) THEN
    ALTER TABLE slotlock.calendar_events
      ADD CONSTRAINT slotlock_calendar_events_materialization_window_limit CHECK (
        materialized_ends_at > materialized_starts_at
        AND (
          materialized_ends_at - materialized_starts_at <= interval '369 days'
          OR (
            recurrence_rule IS NULL
            AND materialized_starts_at = starts_at
            AND materialized_ends_at = ends_at
            AND ends_at - starts_at <= interval '3660 days'
          )
        )
      ) NOT VALID;
  END IF;
END
$slotlock_calendar_event_window_limit$;
ALTER TABLE slotlock.calendar_events
  DROP CONSTRAINT IF EXISTS slotlock_calendar_events_materialization_window_bounded;

-- Where a recurring series' last expansion stopped (ical.js's iterator state as JSON), so the next
-- one resumes there instead of searching again from the series' start. Only Slotlock writes it. A
-- cursor that does not fit the row's rule and start is ignored, so NULL, or a cursor left by an
-- earlier rule, is always safe; a cursor that fits is trusted like the row's other columns. Every
-- existing row is NULL, so the size bound is added NOT VALID (no table scan under the lock). It does
-- not tie the cursor to a rule: a release from before cursors may turn a series into a one-off and
-- leave its cursor, which is then never read.
ALTER TABLE slotlock.calendar_events ADD COLUMN IF NOT EXISTS recurrence_cursor jsonb;
-- When the horizon roll may next examine a series it could not extend (an occurrence collided, or
-- the rule is over the expansion budget): until then it waits behind the series that can roll, so
-- a pile of blocked series never starves a healthy one. NULL: due as usual.
ALTER TABLE slotlock.calendar_events ADD COLUMN IF NOT EXISTS roll_retry_at timestamptz;
-- For a recurring series, a time by which every occurrence ends, moved ones included; 'infinity'
-- when its rule has no end, or none Slotlock could follow it to. NULL: not worked out yet (a series
-- from before 0.3, until its next roll), and so treated as going on. Unused for a one-off event.
ALTER TABLE slotlock.calendar_events ADD COLUMN IF NOT EXISTS recurrence_ends_by timestamptz;
-- The turnaround a booked event keeps after each occurrence (its resource's, when it was booked), so
-- the occurrences a later roll adds keep it too. At most a day.
ALTER TABLE slotlock.calendar_events
  ADD COLUMN IF NOT EXISTS buffer_after_ms integer NOT NULL DEFAULT 0
  CONSTRAINT slotlock_calendar_events_buffer_valid CHECK (buffer_after_ms BETWEEN 0 AND 86400000);
-- The leading buffer a booked event keeps before each occurrence, kept for a later roll alike.
ALTER TABLE slotlock.calendar_events
  ADD COLUMN IF NOT EXISTS buffer_before_ms integer NOT NULL DEFAULT 0
  CONSTRAINT slotlock_calendar_events_buffer_before_valid CHECK (buffer_before_ms BETWEEN 0 AND 86400000);
ALTER TABLE slotlock.calendar_events
  DROP CONSTRAINT IF EXISTS slotlock_calendar_events_recurrence_cursor_bounded;
DO $slotlock_calendar_event_recurrence_cursor$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_calendar_events_recurrence_cursor_size'
       AND conrelid = 'slotlock.calendar_events'::regclass
  ) THEN
    ALTER TABLE slotlock.calendar_events
      ADD CONSTRAINT slotlock_calendar_events_recurrence_cursor_size CHECK (
        recurrence_cursor IS NULL
        OR (
          jsonb_typeof(recurrence_cursor) = 'object'
          AND octet_length(recurrence_cursor::text) <= 32768
        )
      ) NOT VALID;
  END IF;
END
$slotlock_calendar_event_recurrence_cursor$;

CREATE OR REPLACE FUNCTION slotlock.prevent_calendar_event_owner_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_calendar_event_owner_function$
BEGIN
  IF NEW.owner_ref IS DISTINCT FROM OLD.owner_ref THEN
    RAISE EXCEPTION 'slotlock calendar event ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$slotlock_calendar_event_owner_function$;
REVOKE ALL ON FUNCTION slotlock.prevent_calendar_event_owner_change() FROM PUBLIC;

DO $slotlock_calendar_event_owner_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'slotlock_calendar_events_owner_immutable'
       AND tgrelid = 'slotlock.calendar_events'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER slotlock_calendar_events_owner_immutable
    BEFORE UPDATE OF owner_ref ON slotlock.calendar_events
    FOR EACH ROW EXECUTE FUNCTION slotlock.prevent_calendar_event_owner_change();
  END IF;
END
$slotlock_calendar_event_owner_trigger$;

-- Queryable event collections are normalized. The JSON columns above remain a bounded
-- compatibility projection while existing deployments and older readers transition.
CREATE TABLE IF NOT EXISTS slotlock.calendar_event_attendees (
  tenant_ref text NOT NULL,
  event_id uuid NOT NULL,
  ordinal integer NOT NULL,
  email text NOT NULL,
  display_name text,
  role text,
  participation_status text,
  rsvp boolean,
  PRIMARY KEY (tenant_ref, event_id, ordinal),
  CONSTRAINT calendar_event_attendees_event_tenant_fkey
    FOREIGN KEY (event_id, tenant_ref)
    REFERENCES slotlock.calendar_events (id, tenant_ref) ON DELETE CASCADE,
  CONSTRAINT calendar_event_attendees_event_email_uq
    UNIQUE (tenant_ref, event_id, email),
  CONSTRAINT calendar_event_attendees_ordinal_ck CHECK (ordinal BETWEEN 0 AND 99),
  CONSTRAINT calendar_event_attendees_email_ck CHECK (
    octet_length(email) BETWEEN 3 AND 320
    AND email = lower(btrim(email))
    AND email ~ '^[^[:space:]@]+@[^[:space:]@]+$'
  ),
  CONSTRAINT calendar_event_attendees_name_ck CHECK (
    display_name IS NULL OR octet_length(display_name) BETWEEN 1 AND 1024
  ),
  CONSTRAINT calendar_event_attendees_role_ck CHECK (
    role IS NULL OR role IN ('chair', 'required', 'optional', 'non_participant')
  ),
  CONSTRAINT calendar_event_attendees_participation_ck CHECK (
    participation_status IS NULL OR participation_status IN (
      'needs_action', 'accepted', 'declined', 'tentative', 'delegated'
    )
  )
);

CREATE TABLE IF NOT EXISTS slotlock.calendar_event_reminders (
  tenant_ref text NOT NULL,
  event_id uuid NOT NULL,
  ordinal integer NOT NULL,
  action text NOT NULL,
  minutes_before_start integer NOT NULL,
  PRIMARY KEY (tenant_ref, event_id, ordinal),
  CONSTRAINT calendar_event_reminders_event_tenant_fkey
    FOREIGN KEY (event_id, tenant_ref)
    REFERENCES slotlock.calendar_events (id, tenant_ref) ON DELETE CASCADE,
  CONSTRAINT calendar_event_reminders_ordinal_ck CHECK (ordinal BETWEEN 0 AND 19),
  CONSTRAINT calendar_event_reminders_action_ck CHECK (action IN ('display', 'email')),
  CONSTRAINT calendar_event_reminders_minutes_ck CHECK (
    minutes_before_start BETWEEN 0 AND 527040
  )
);

CREATE TABLE IF NOT EXISTS slotlock.calendar_event_exceptions (
  tenant_ref text NOT NULL,
  event_id uuid NOT NULL,
  recurrence_id timestamptz NOT NULL,
  cancelled boolean NOT NULL DEFAULT false,
  starts_at timestamptz,
  ends_at timestamptz,
  PRIMARY KEY (tenant_ref, event_id, recurrence_id),
  CONSTRAINT calendar_event_exceptions_event_tenant_fkey
    FOREIGN KEY (event_id, tenant_ref)
    REFERENCES slotlock.calendar_events (id, tenant_ref) ON DELETE CASCADE,
  CONSTRAINT calendar_event_exceptions_shape_ck CHECK (
    date_trunc('second', recurrence_id) = recurrence_id
    AND (starts_at IS NULL) = (ends_at IS NULL)
    AND (cancelled OR starts_at IS NOT NULL)
    AND (starts_at IS NULL OR (
      date_trunc('second', starts_at) = starts_at
      AND date_trunc('second', ends_at) = ends_at
      AND ends_at > starts_at
    ))
  )
);

-- Backfill trusted compatibility projections. Invalid manually-authored legacy elements remain in
-- bounded JSON for operator review instead of aborting the deploy or weakening normalized checks.
INSERT INTO slotlock.calendar_event_attendees (
  tenant_ref, event_id, ordinal, email, display_name, role, participation_status, rsvp
)
SELECT
  event.tenant_ref,
  event.id,
  (item.ordinality - 1)::integer,
  lower(btrim(item.value ->> 'email')),
  CASE
    WHEN jsonb_typeof(item.value -> 'name') = 'string'
      AND octet_length(btrim(item.value ->> 'name')) BETWEEN 1 AND 1024
    THEN btrim(item.value ->> 'name')
    ELSE NULL
  END,
  CASE
    WHEN item.value ->> 'role' IN ('chair', 'required', 'optional', 'non_participant')
    THEN item.value ->> 'role'
    ELSE NULL
  END,
  CASE
    WHEN item.value ->> 'participationStatus' IN (
      'needs_action', 'accepted', 'declined', 'tentative', 'delegated'
    ) THEN item.value ->> 'participationStatus'
    ELSE NULL
  END,
  CASE
    WHEN jsonb_typeof(item.value -> 'rsvp') = 'boolean'
    THEN (item.value ->> 'rsvp')::boolean
    ELSE NULL
  END
FROM slotlock.calendar_events event
CROSS JOIN LATERAL jsonb_array_elements(event.attendees) WITH ORDINALITY AS item(value, ordinality)
WHERE jsonb_typeof(item.value) = 'object'
  AND jsonb_typeof(item.value -> 'email') = 'string'
  AND octet_length(lower(btrim(item.value ->> 'email'))) BETWEEN 3 AND 320
  AND lower(btrim(item.value ->> 'email')) ~ '^[^[:space:]@]+@[^[:space:]@]+$'
ON CONFLICT DO NOTHING;

INSERT INTO slotlock.calendar_event_reminders (
  tenant_ref, event_id, ordinal, action, minutes_before_start
)
SELECT
  event.tenant_ref,
  event.id,
  (item.ordinality - 1)::integer,
  item.value ->> 'action',
  (item.value ->> 'minutesBeforeStart')::integer
FROM slotlock.calendar_events event
CROSS JOIN LATERAL jsonb_array_elements(event.reminders) WITH ORDINALITY AS item(value, ordinality)
WHERE jsonb_typeof(item.value) = 'object'
  AND item.value ->> 'action' IN ('display', 'email')
  AND item.value ->> 'minutesBeforeStart' ~ '^[0-9]{1,6}$'
  AND (item.value ->> 'minutesBeforeStart')::integer BETWEEN 0 AND 527040
ON CONFLICT DO NOTHING;

INSERT INTO slotlock.calendar_event_exceptions (
  tenant_ref, event_id, recurrence_id, cancelled, starts_at, ends_at
)
SELECT
  event.tenant_ref,
  event.id,
  parsed.recurrence_id,
  parsed.cancelled,
  parsed.starts_at,
  parsed.ends_at
FROM slotlock.calendar_events event
CROSS JOIN LATERAL jsonb_array_elements(event.recurrence_exceptions) AS item(value)
CROSS JOIN LATERAL (
  SELECT
    CASE
      WHEN pg_input_is_valid(item.value ->> 'recurrenceId', 'timestamp with time zone')
      THEN (item.value ->> 'recurrenceId')::timestamptz
      ELSE NULL
    END AS recurrence_id,
    CASE
      WHEN item.value ->> 'cancelled' IN ('true', 'false')
      THEN (item.value ->> 'cancelled')::boolean
      ELSE false
    END AS cancelled,
    CASE
      WHEN pg_input_is_valid(item.value ->> 'start', 'timestamp with time zone')
      THEN (item.value ->> 'start')::timestamptz
      ELSE NULL
    END AS starts_at,
    CASE
      WHEN pg_input_is_valid(item.value ->> 'end', 'timestamp with time zone')
      THEN (item.value ->> 'end')::timestamptz
      ELSE NULL
    END AS ends_at
) parsed
WHERE jsonb_typeof(item.value) = 'object'
  AND parsed.recurrence_id IS NOT NULL
  AND date_trunc('second', parsed.recurrence_id) = parsed.recurrence_id
  AND (parsed.starts_at IS NULL) = (parsed.ends_at IS NULL)
  AND (parsed.cancelled OR parsed.starts_at IS NOT NULL)
  AND (parsed.starts_at IS NULL OR (
    date_trunc('second', parsed.starts_at) = parsed.starts_at
    AND date_trunc('second', parsed.ends_at) = parsed.ends_at
    AND parsed.ends_at > parsed.starts_at
  ))
ON CONFLICT DO NOTHING;

ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS calendar_event_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_calendar_event_tenant_fkey'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_calendar_event_tenant_fkey
      FOREIGN KEY (calendar_event_id, tenant_ref)
      REFERENCES slotlock.calendar_events (id, tenant_ref) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_calendar_event_identity_shape'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_calendar_event_identity_shape CHECK (
        calendar_event_id IS NULL OR tenant_ref IS NOT NULL
      );
  END IF;
END $$;

-- A booking's reference is unique in its tenant. The rows a calendar event occupies carry a
-- reference derived from the event in the same columns, but they are not bookings and are left out:
-- a booking with the same reference neither collides with one nor answers for it. Up to 0.1 one
-- index covered both; every row it admitted, this one admits.
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_reservations_booking_external_ref_key
  ON slotlock.reservations (tenant_ref, external_ref)
  WHERE tenant_ref IS NOT NULL AND external_ref IS NOT NULL AND calendar_event_id IS NULL;
DROP INDEX IF EXISTS slotlock.slotlock_reservations_tenant_external_ref_key;

-- Up to 0.2 a confirmed hold, and a createReservation booking, on a tenant's resource kept no tenant
-- or reference, so no cancel or move could ever reach it. Each takes its resource's tenant and its
-- own id as reference, as both now do when written. A tombstone already holding that reference was
-- written by cancelling it as a reference no booking held (the only way to try): it retired nothing
-- and is dropped, so the booking can be cancelled. A booking another booking's reference already
-- uses (never written by Slotlock) is left as it was.
DELETE FROM slotlock.reservation_tombstones tombstone
 USING slotlock.reservations booking
  JOIN slotlock.resources resource ON resource.id = booking.resource_id
 WHERE booking.tenant_ref IS NULL
   AND booking.status = 'confirmed'
   AND booking.calendar_event_id IS NULL
   AND resource.tenant_ref IS NOT NULL
   AND tombstone.tenant_ref = resource.tenant_ref
   AND tombstone.external_ref = booking.id::text;
UPDATE slotlock.reservations booking
   SET tenant_ref = resource.tenant_ref,
       external_ref = booking.id::text,
       occupied_ends_at = booking.ends_at + booking.buffer_after_ms * interval '1 millisecond'
  FROM slotlock.resources resource
 WHERE resource.id = booking.resource_id
   AND booking.tenant_ref IS NULL
   AND booking.status = 'confirmed'
   AND booking.calendar_event_id IS NULL
   AND resource.tenant_ref IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM slotlock.reservations taken
      WHERE taken.tenant_ref = resource.tenant_ref
        AND taken.external_ref = booking.id::text
        AND taken.calendar_event_id IS NULL
   );

-- Materialized occurrences point at reservations created under the SAME exclusion arbiter as
-- bookings and holds. Transparent events retain occurrence visibility with a NULL reservation.
CREATE TABLE IF NOT EXISTS slotlock.calendar_event_occurrences (
  event_id uuid NOT NULL,
  tenant_ref text NOT NULL,
  recurrence_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reservation_id uuid UNIQUE,
  PRIMARY KEY (event_id, recurrence_id),
  CONSTRAINT slotlock_calendar_event_occurrences_event_tenant_fkey
    FOREIGN KEY (event_id, tenant_ref)
    REFERENCES slotlock.calendar_events (id, tenant_ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_calendar_event_occurrences_reservation_tenant_fkey
    FOREIGN KEY (reservation_id, tenant_ref)
    REFERENCES slotlock.reservations (id, tenant_ref) ON DELETE SET NULL (reservation_id),
  CONSTRAINT slotlock_calendar_event_occurrences_window_valid CHECK (ends_at > starts_at),
  CONSTRAINT slotlock_calendar_event_occurrences_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND octet_length(recurrence_id) BETWEEN 1 AND 500
  )
);

-- A cancelled UID remains terminal. This blocks delayed create delivery after the event row and
-- its derived reservations have been removed.
CREATE TABLE IF NOT EXISTS slotlock.calendar_event_tombstones (
  tenant_ref text NOT NULL,
  owner_ref text NOT NULL DEFAULT 'internal',
  external_ref text NOT NULL,
  event_id uuid NOT NULL,
  revision bigint NOT NULL,
  cancelled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotlock_calendar_event_tombstones_owner_key PRIMARY KEY (tenant_ref, owner_ref, external_ref),
  CONSTRAINT slotlock_calendar_event_tombstones_owner_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND (owner_ref = 'internal' OR owner_ref ~ '^agent:[0-9a-f]{64}$')
    AND octet_length(external_ref) BETWEEN 1 AND 500
  ),
  CONSTRAINT slotlock_calendar_event_tombstones_revision_valid CHECK (revision > 0)
);

ALTER TABLE slotlock.calendar_event_tombstones
  ADD COLUMN IF NOT EXISTS owner_ref text NOT NULL DEFAULT 'internal';
ALTER TABLE slotlock.calendar_event_tombstones
  DROP CONSTRAINT IF EXISTS calendar_event_tombstones_pkey;
ALTER TABLE slotlock.calendar_event_tombstones
  DROP CONSTRAINT IF EXISTS slotlock_calendar_event_tombstones_identity_valid;
DO $slotlock_calendar_event_tombstone_owner_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_calendar_event_tombstones_owner_key'
       AND conrelid = 'slotlock.calendar_event_tombstones'::regclass
  ) THEN
    ALTER TABLE slotlock.calendar_event_tombstones
      ADD CONSTRAINT slotlock_calendar_event_tombstones_owner_key
      PRIMARY KEY (tenant_ref, owner_ref, external_ref);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_calendar_event_tombstones_owner_identity_valid'
       AND conrelid = 'slotlock.calendar_event_tombstones'::regclass
  ) THEN
    ALTER TABLE slotlock.calendar_event_tombstones
      ADD CONSTRAINT slotlock_calendar_event_tombstones_owner_identity_valid CHECK (
        octet_length(tenant_ref) BETWEEN 1 AND 500
        AND (owner_ref = 'internal' OR owner_ref ~ '^agent:[0-9a-f]{64}$')
        AND octet_length(external_ref) BETWEEN 1 AND 500
      );
  END IF;
END
$slotlock_calendar_event_tombstone_owner_constraints$;

-- Successful command results are retained by tenant idempotency key. Only a digest and the small
-- stable result are stored; event PII is never duplicated into this ledger.
CREATE TABLE IF NOT EXISTS slotlock.calendar_event_commands (
  tenant_ref text NOT NULL,
  owner_ref text NOT NULL DEFAULT 'internal',
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  payload_hash text NOT NULL,
  event_id uuid NOT NULL,
  external_ref text NOT NULL,
  result_revision bigint NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotlock_calendar_event_commands_owner_key PRIMARY KEY (tenant_ref, owner_ref, idempotency_key),
  CONSTRAINT slotlock_calendar_event_commands_owner_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND (owner_ref = 'internal' OR owner_ref ~ '^agent:[0-9a-f]{64}$')
    AND octet_length(idempotency_key) BETWEEN 1 AND 500
    AND octet_length(external_ref) BETWEEN 1 AND 500
    AND octet_length(payload_hash) = 64
  ),
  CONSTRAINT slotlock_calendar_event_commands_operation_valid CHECK (
    operation IN ('put', 'cancel')
  ),
  CONSTRAINT slotlock_calendar_event_commands_result_valid CHECK (
    result_revision > 0 AND occurrence_count >= 0 AND occurrence_count <= 2000
  )
);

ALTER TABLE slotlock.calendar_event_commands
  ADD COLUMN IF NOT EXISTS owner_ref text NOT NULL DEFAULT 'internal';
ALTER TABLE slotlock.calendar_event_commands
  DROP CONSTRAINT IF EXISTS calendar_event_commands_pkey;
ALTER TABLE slotlock.calendar_event_commands
  DROP CONSTRAINT IF EXISTS slotlock_calendar_event_commands_identity_valid;
DO $slotlock_calendar_event_command_owner_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_calendar_event_commands_owner_key'
       AND conrelid = 'slotlock.calendar_event_commands'::regclass
  ) THEN
    ALTER TABLE slotlock.calendar_event_commands
      ADD CONSTRAINT slotlock_calendar_event_commands_owner_key
      PRIMARY KEY (tenant_ref, owner_ref, idempotency_key);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_calendar_event_commands_owner_identity_valid'
       AND conrelid = 'slotlock.calendar_event_commands'::regclass
  ) THEN
    ALTER TABLE slotlock.calendar_event_commands
      ADD CONSTRAINT slotlock_calendar_event_commands_owner_identity_valid CHECK (
        octet_length(tenant_ref) BETWEEN 1 AND 500
        AND (owner_ref = 'internal' OR owner_ref ~ '^agent:[0-9a-f]{64}$')
        AND octet_length(idempotency_key) BETWEEN 1 AND 500
        AND octet_length(external_ref) BETWEEN 1 AND 500
        AND octet_length(payload_hash) = 64
      );
  END IF;
END
$slotlock_calendar_event_command_owner_constraints$;

-- Provider adapters explicitly attest the complete interval represented by a cursor/revision.
-- Free/busy certainty never guesses beyond this rolling window.
CREATE TABLE IF NOT EXISTS slotlock.calendar_coverage (
  tenant_ref text NOT NULL,
  resource_id uuid NOT NULL,
  source text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  revision bigint NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_ref, resource_id, source),
  CONSTRAINT slotlock_calendar_coverage_resource_tenant_fkey
    FOREIGN KEY (resource_id, tenant_ref)
    REFERENCES slotlock.resources (id, tenant_ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_calendar_coverage_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND octet_length(source) BETWEEN 1 AND 500
  ),
  CONSTRAINT slotlock_calendar_coverage_window_valid CHECK (
    ends_at > starts_at AND ends_at - starts_at <= interval '367 days'
  ),
  CONSTRAINT slotlock_calendar_coverage_revision_valid CHECK (revision > 0)
);

-- A keyed hold's first answer, by the key its caller gave inside its tenant and principal, so a
-- retried request answers the same hold instead of overlapping it. The answer stays as given until
-- the hold would have expired, even once it is confirmed, released or reaped, and counts against
-- the tenant's hold limit while its hold is not live; then maintenance, or a hold at that limit,
-- deletes it (store.ts forgetExpiredHoldAnswers).
CREATE TABLE IF NOT EXISTS slotlock.hold_commands (
  tenant_ref text NOT NULL,
  principal_ref text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  hold_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  buffer_after_ms bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slotlock_hold_commands_key PRIMARY KEY (tenant_ref, principal_ref, idempotency_key),
  CONSTRAINT slotlock_hold_commands_resource_tenant_fkey
    FOREIGN KEY (resource_id, tenant_ref)
    REFERENCES slotlock.resources (id, tenant_ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_hold_commands_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND octet_length(principal_ref) BETWEEN 1 AND 500
    AND octet_length(idempotency_key) BETWEEN 1 AND 500
    AND octet_length(payload_hash) = 64
  )
);
CREATE INDEX IF NOT EXISTS slotlock_hold_commands_expiry_idx
  ON slotlock.hold_commands (tenant_ref, expires_at);
-- References retired with no booking: a tenant's count of them, and maintenance's prune.
CREATE INDEX IF NOT EXISTS slotlock_reservation_tombstones_stray_idx
  ON slotlock.reservation_tombstones (tenant_ref, cancelled_at) WHERE stray;
-- Holds by resource and expiry: a tenant's live-hold count, and maintenance's purge of expired ones.
CREATE INDEX IF NOT EXISTS slotlock_reservations_held_expiry_idx
  ON slotlock.reservations (resource_id, expires_at) WHERE status = 'held';
-- Confirmed bookings with no tenant, by resource: maintenance finds those a 0.2 server wrote on a
-- tenant's resource after the migration (store.ts pruneBookingRetention).
CREATE INDEX IF NOT EXISTS slotlock_reservations_untenanted_booking_idx
  ON slotlock.reservations (resource_id)
  WHERE tenant_ref IS NULL AND status = 'confirmed' AND calendar_event_id IS NULL;
-- What the tenant limits count (store.ts tenantLimitCount), each read as a range so a count stops
-- at the limit: bookings and events by when they end (one-offs and series apart) and by when they
-- were made, and cancellations by when they were made.
CREATE INDEX IF NOT EXISTS slotlock_reservations_booking_end_idx
  ON slotlock.reservations (tenant_ref, occupied_ends_at)
  WHERE external_ref IS NOT NULL AND calendar_event_id IS NULL;
CREATE INDEX IF NOT EXISTS slotlock_reservations_booking_created_idx
  ON slotlock.reservations (tenant_ref, created_at)
  WHERE external_ref IS NOT NULL AND calendar_event_id IS NULL;
CREATE INDEX IF NOT EXISTS slotlock_reservation_tombstones_cancelled_idx
  ON slotlock.reservation_tombstones (tenant_ref, cancelled_at);
CREATE INDEX IF NOT EXISTS slotlock_calendar_events_one_off_end_idx
  ON slotlock.calendar_events (tenant_ref, ends_at) WHERE recurrence_rule IS NULL;
CREATE INDEX IF NOT EXISTS slotlock_calendar_events_series_end_idx
  ON slotlock.calendar_events (tenant_ref, recurrence_ends_by) WHERE recurrence_rule IS NOT NULL;
CREATE INDEX IF NOT EXISTS slotlock_calendar_events_created_idx
  ON slotlock.calendar_events (tenant_ref, created_at);
CREATE INDEX IF NOT EXISTS slotlock_calendar_event_tombstones_cancelled_idx
  ON slotlock.calendar_event_tombstones (tenant_ref, cancelled_at);

CREATE INDEX IF NOT EXISTS slotlock_calendar_events_resource_time_idx
  ON slotlock.calendar_events (tenant_ref, resource_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS slotlock_calendar_events_owner_resource_time_idx
  ON slotlock.calendar_events (tenant_ref, owner_ref, resource_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS slotlock_calendar_event_commands_retention_idx
  ON slotlock.calendar_event_commands (tenant_ref, created_at, owner_ref, idempotency_key);
CREATE INDEX IF NOT EXISTS slotlock_calendar_event_commands_authority_idx
  ON slotlock.calendar_event_commands (tenant_ref, owner_ref, event_id, external_ref);
CREATE INDEX IF NOT EXISTS slotlock_calendar_event_tombstones_agent_retention_idx
  ON slotlock.calendar_event_tombstones (tenant_ref, cancelled_at, owner_ref, external_ref)
  WHERE owner_ref LIKE 'agent:%';
CREATE INDEX IF NOT EXISTS slotlock_calendar_event_occurrences_resource_time_idx
  ON slotlock.calendar_event_occurrences (tenant_ref, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS slotlock_reservations_calendar_event_idx
  ON slotlock.reservations (calendar_event_id) WHERE calendar_event_id IS NOT NULL;
${SLOTLOCK_OUTBOX_DDL}${SLOTLOCK_API_KEYS_DDL}${SLOTLOCK_DASHBOARD_DDL}${SLOTLOCK_TENANT_ADMIN_DDL}${DEPLOYMENT_RECORD_VERSION}`;

/**
 * Whether the outbox row `row` (a coverage change) is in this release's shape: named by a source_id
 * or src_redacted, in `subject` and `data.source_id` alike, with no `source` or `last_error`.
 */
function coverageChangeInShapeSql(row: string): string {
  return `(${row}.subject ~ '^src_([0-9a-f]{32}|redacted)$'
         AND ${row}.data ->> 'source_id' IS NOT DISTINCT FROM ${row}.subject
         AND NOT ${row}.data ?| ARRAY['source', 'last_error'])`;
}

/**
 * The source_id an earlier release's coverage change `row` names: the source matching its tenant,
 * resource and source (0.5.2 and earlier: the subject or `data.source`) or 0.5.3 digest, else
 * src_redacted.
 */
function coverageChangeSourceIdSql(row: string): string {
  return `COALESCE((
           SELECT coverage.source_id FROM slotlock.calendar_coverage coverage
            WHERE coverage.tenant_ref = ${row}.tenant_ref
              AND coverage.resource_id = ${row}.resource_id
              AND coverage.source_id IS NOT NULL
              AND (coverage.source = ${row}.subject
                   OR coverage.source = ${row}.data ->> 'source'
                   OR ${legacyCoverageSourceDigestSql('coverage.tenant_ref', 'coverage.source')} = ${row}.subject)
            LIMIT 1), 'src_redacted')`;
}

/** Outbox ids one batch of the coverage-change rename reads (by primary key) in one transaction. */
export const SLOTLOCK_COVERAGE_CHANGE_RENAME_BATCH = 5_000;

/**
 * One batch of the rename of coverage changes an earlier release wrote: of the outbox rows after
 * `after` up to `head` (bigint SQL expressions), the first `batch` by id; each `coverage.*` row not
 * yet in shape gets its source_id as subject and `data.source_id`, and loses `source` and
 * `last_error` (before 0.5.3 these carried the source itself, a URL with a token; 0.5.3's unkeyed
 * digest could confirm a guess). A deleted source becomes `src_redacted`. Selects `last` (null when
 * none) and `renamed`, `INTO` `into` when given. Idempotent.
 */
export function slotlockCoverageChangeRenameSql(after: string, head: string, batch: string, into = ''): string {
  return `WITH scanned AS MATERIALIZED (
  SELECT id FROM slotlock.outbox
   WHERE id > ${after} AND id <= ${head}
   ORDER BY id
   LIMIT ${batch}
), earlier AS (
  SELECT change.id, change.tenant_ref, change.resource_id, change.subject, change.data
    FROM slotlock.outbox change
   WHERE change.id IN (SELECT scanned.id FROM scanned)
     AND change.type LIKE 'coverage.%'
     AND NOT ${coverageChangeInShapeSql('change')}
     FOR UPDATE OF change
), named AS (
  SELECT earlier.id, ${coverageChangeSourceIdSql('earlier')} AS source_id
    FROM earlier
), renamed AS (
  UPDATE slotlock.outbox change
     SET subject = named.source_id,
         data = (change.data - 'source' - 'last_error') || jsonb_build_object('source_id', named.source_id)
    FROM named
   WHERE change.id = named.id
  RETURNING change.id
)
SELECT (SELECT max(scanned.id) FROM scanned)::text AS last,
       (SELECT count(*) FROM renamed)::integer AS renamed${into ? `
  INTO ${into}` : ''}`;
}

// The rename for SLOTLOCK_CORE_DDL, run whole in its one transaction while FORCE is lifted (the
// outbox is under ACCESS EXCLUSIVE throughout). Resumes where the last pass stopped and is skipped
// once done; applySchema instead runs it in batches after the structure commits.
const DEPLOYMENT_RENAME_COVERAGE_CHANGES = `DO $slotlock_rename_coverage_changes$
DECLARE
  scan_after bigint;
  scan_head bigint;
  scan_last text;
  scan_renamed integer;
  renamed_total integer := 0;
  first_pass boolean;
BEGIN
  IF (SELECT coverage_changes_renamed FROM slotlock.schema_version WHERE singleton) THEN
    RETURN;
  END IF;
  SELECT coverage_changes_renamed_through INTO scan_after FROM slotlock.schema_version WHERE singleton;
  first_pass := scan_after IS NULL;
  scan_after := COALESCE(scan_after, 0);
  SELECT COALESCE(max(id), 0) INTO scan_head FROM slotlock.outbox;
  LOOP
    ${slotlockCoverageChangeRenameSql('scan_after', 'scan_head', String(SLOTLOCK_COVERAGE_CHANGE_RENAME_BATCH), 'scan_last, scan_renamed')};
    EXIT WHEN scan_last IS NULL;
    scan_after := scan_last::bigint;
    renamed_total := renamed_total + scan_renamed;
  END LOOP;
  UPDATE slotlock.schema_version
     SET coverage_changes_renamed_through = GREATEST(scan_after, scan_head),
         coverage_changes_renamed = NOT first_pass AND renamed_total = 0
   WHERE singleton;
END
$slotlock_rename_coverage_changes$;
`;

/** The whole deployment DDL, run in one transaction: the schema, then its constraints validated. */
export const SLOTLOCK_CORE_DDL: string = `${CORE_DDL_BODY}${DEPLOYMENT_RENAME_COVERAGE_CHANGES}${DEPLOYMENT_VALIDATE_CONSTRAINTS}${DEPLOYMENT_RESTORE_FORCED_ROW_SECURITY}${DEPLOYMENT_SEARCH_PATH_RESTORE}`;

/**
 * SLOTLOCK_CORE_DDL without the validation, which applySchema runs as a step of its own after this
 * commits (SLOTLOCK_VALIDATION_DDL).
 */
export const SLOTLOCK_STRUCTURE_DDL: string = `${CORE_DDL_BODY}${DEPLOYMENT_RESTORE_FORCED_ROW_SECURITY}${DEPLOYMENT_SEARCH_PATH_RESTORE}`;

export const SLOTLOCK_TENANT_CONTEXT_SETTING = 'slotlock.tenant_ref';

/**
 * Every table the store reads or writes at runtime, each under forced tenant RLS.
 * `slotlock.rls_policy_contracts` and `slotlock.deployment_lifted_row_security` are
 * deployment-only and deliberately absent.
 */
export const SLOTLOCK_TENANT_TABLES = Object.freeze([
  'resources',
  'reservations',
  'reservation_tombstones',
  'reservation_conflict_archive',
  'calendar_events',
  'calendar_event_attendees',
  'calendar_event_reminders',
  'calendar_event_exceptions',
  'calendar_event_occurrences',
  'calendar_event_tombstones',
  'calendar_event_commands',
  'calendar_coverage',
  'hold_commands',
  'outbox',
  'outbox_pruned',
  'webhook_endpoints',
  'waitlist_entries',
  'booking_rule_defaults',
  'assistant_settings',
  'assistant_conversations',
  'locations',
  'resource_groups',
  'resource_group_members',
  'pool_settings',
] as const);

const POSTGRES_SETTING_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const POSTGRES_ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
/** Names GRANT reads as a pseudo-role (PUBLIC reaches every role) or PostgreSQL reserves. */
const RESERVED_ROLE_NAMES = new Set(['public', 'current_role', 'current_user', 'session_user']);

/**
 * Build the grants for the application role: USAGE on the schema, DML on the store's tables and
 * EXECUTE on the API key and dashboard functions, nothing else. The role must not be able to leave
 * forced RLS (`grantApplicationRole` checks; these statements do not). Rerun after every
 * `applySchema()`, since a release may add a table.
 */
export function createSlotlockApplicationRoleGrantsDdl(role: string): string {
  if (!POSTGRES_ROLE_NAME.test(role) || RESERVED_ROLE_NAMES.has(role) || role.startsWith('pg_')) {
    throw Object.assign(
      new Error('Slotlock application role must be a lowercase, non-reserved PostgreSQL role name'),
      { code: 'invalid_role_name' as const },
    );
  }
  const tables = SLOTLOCK_TENANT_TABLES.map((table) => `slotlock.${table}`).join(', ');
  return `GRANT USAGE ON SCHEMA slotlock TO "${role}";
GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables} TO "${role}";
GRANT EXECUTE ON FUNCTION ${SLOTLOCK_DEFINER_FUNCTIONS.join(', ')} TO "${role}";
`;
}

/**
 * Build the production-hardening DDL for a tenant context setting. The default setting is
 * `slotlock.tenant_ref`; adapters may supply an established transaction-local setting name.
 * Every policy fails closed when the setting is absent or empty, and FORCE binds the table owner.
 */
export function createSlotlockTenantRlsDdl(
  tenantContextSetting = SLOTLOCK_TENANT_CONTEXT_SETTING,
): string {
  if (
    tenantContextSetting.length > 128 ||
    !POSTGRES_SETTING_NAME.test(tenantContextSetting) ||
    tenantContextSetting === CALLER_SEARCH_PATH_SETTING
  ) {
    throw Object.assign(
      new Error(
        `Slotlock tenant context setting must be a dotted identifier other than ${CALLER_SEARCH_PATH_SETTING}`,
      ),
      { code: 'invalid_tenant_context_setting' as const },
    );
  }
  return `
${DEPLOYMENT_SEARCH_PATH_PIN}${SLOTLOCK_DEPLOYMENT_CHECKS}ALTER TABLE slotlock.resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.resources FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.reservation_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.reservation_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.reservation_conflict_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.reservation_conflict_archive FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_events FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_attendees FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_reminders FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_exceptions FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_tombstones FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_event_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.calendar_coverage FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.hold_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.hold_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.outbox_pruned ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.outbox_pruned FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.webhook_endpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.waitlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.waitlist_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.booking_rule_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.booking_rule_defaults FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.assistant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.assistant_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.assistant_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.assistant_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.locations FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.resource_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.resource_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.resource_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.resource_group_members FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.pool_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.pool_settings FORCE ROW LEVEL SECURITY;

-- One database must have one tenant-context contract. Re-applying with an adapter-specific
-- setting deliberately rebinds the stable policies instead of silently keeping a prior setting.
-- Use SlotlockStore.applyTenantRls() to serialize and transact this policy replacement.
DO $slotlock_drop_rls$
DECLARE existing_policy record;
BEGIN
  FOR existing_policy IN
    SELECT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'slotlock'
       AND tablename IN (
         'resources',
         'reservations',
         'reservation_tombstones',
         'reservation_conflict_archive',
         'calendar_events',
         'calendar_event_attendees',
         'calendar_event_reminders',
         'calendar_event_exceptions',
         'calendar_event_occurrences',
         'calendar_event_tombstones',
         'calendar_event_commands',
         'calendar_coverage',
         'hold_commands',
         'outbox',
         'outbox_pruned',
         'webhook_endpoints',
         'waitlist_entries',
         'booking_rule_defaults',
         'assistant_settings',
         'assistant_conversations',
         'locations',
         'resource_groups',
         'resource_group_members',
         'pool_settings'
       )
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON slotlock.%I',
      existing_policy.policyname,
      existing_policy.tablename
    );
  END LOOP;
END
$slotlock_drop_rls$;

DO $slotlock_rls$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'resources'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.resources
      USING (
        tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), '')
      )
      WITH CHECK (
        tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), '')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'reservations'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.reservations
      USING (
        EXISTS (
          SELECT 1 FROM slotlock.resources resource
           WHERE resource.id = reservations.resource_id
             AND resource.tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), '')
        )
        AND (
          reservations.tenant_ref IS NULL
          OR reservations.tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), '')
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM slotlock.resources resource
           WHERE resource.id = reservations.resource_id
             AND resource.tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), '')
        )
        AND (
          reservations.tenant_ref IS NULL
          OR reservations.tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), '')
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'reservation_tombstones'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.reservation_tombstones
      USING (
        tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), '')
      )
      WITH CHECK (
        tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), '')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'reservation_conflict_archive'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.reservation_conflict_archive
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'calendar_events'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.calendar_events
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'calendar_event_occurrences'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.calendar_event_occurrences
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'calendar_event_attendees'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.calendar_event_attendees
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'calendar_event_reminders'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.calendar_event_reminders
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'calendar_event_exceptions'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.calendar_event_exceptions
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'calendar_event_tombstones'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.calendar_event_tombstones
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'calendar_event_commands'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.calendar_event_commands
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'calendar_coverage'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.calendar_coverage
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'hold_commands'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.hold_commands
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'outbox'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.outbox
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'outbox_pruned'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.outbox_pruned
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'webhook_endpoints'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.webhook_endpoints
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'waitlist_entries'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.waitlist_entries
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'booking_rule_defaults'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.booking_rule_defaults
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'assistant_settings'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.assistant_settings
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'assistant_conversations'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.assistant_conversations
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'locations'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.locations
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'resource_groups'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.resource_groups
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'resource_group_members'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.resource_group_members
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'pool_settings'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.pool_settings
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;
END
$slotlock_rls$;

COMMENT ON POLICY tenant_isolation_v1 ON slotlock.resources
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.reservations
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.reservation_tombstones
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.reservation_conflict_archive
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.calendar_events
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.calendar_event_attendees
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.calendar_event_reminders
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.calendar_event_exceptions
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.calendar_event_occurrences
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.calendar_event_tombstones
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.calendar_event_commands
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.calendar_coverage
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.hold_commands
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.outbox
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.outbox_pruned
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.webhook_endpoints
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.waitlist_entries
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.booking_rule_defaults
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.assistant_settings
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.assistant_conversations
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.locations
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.resource_groups
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.resource_group_members
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.pool_settings
  IS 'slotlock:tenant-context:${tenantContextSetting}';

INSERT INTO slotlock.rls_policy_contracts (
  table_name, tenant_context_setting, policy_fingerprint, installed_at
)
SELECT
  tablename,
  '${tenantContextSetting}',
  pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.concat_ws(
          E'\\x1f', policyname, permissive, roles::text, cmd,
          COALESCE(qual, ''), COALESCE(with_check, '')
        ),
        'UTF8'
      )
    ),
    'hex'
  ),
  now()
FROM pg_policies
WHERE schemaname = 'slotlock'
  AND tablename IN (
    'resources',
    'reservations',
    'reservation_tombstones',
    'reservation_conflict_archive',
    'calendar_events',
    'calendar_event_attendees',
    'calendar_event_reminders',
    'calendar_event_exceptions',
    'calendar_event_occurrences',
    'calendar_event_tombstones',
    'calendar_event_commands',
    'calendar_coverage',
    'hold_commands',
    'outbox',
    'outbox_pruned',
    'webhook_endpoints',
    'waitlist_entries',
    'booking_rule_defaults',
    'assistant_settings',
    'assistant_conversations',
    'locations',
    'resource_groups',
    'resource_group_members',
    'pool_settings'
  )
  AND policyname = 'tenant_isolation_v1'
ON CONFLICT (table_name) DO UPDATE
SET tenant_context_setting = EXCLUDED.tenant_context_setting,
    policy_fingerprint = EXCLUDED.policy_fingerprint,
    installed_at = EXCLUDED.installed_at;
${DEPLOYMENT_SEARCH_PATH_RESTORE}`;
}

export const SLOTLOCK_TENANT_RLS_DDL = createSlotlockTenantRlsDdl();
