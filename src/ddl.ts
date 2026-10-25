// Slotlock owns its schema. This DDL lives in the dedicated `slotlock` Postgres schema and is applied
// by the package itself (store.applySchema). It is idempotent for fresh and evolved deployments.
//
// The EXCLUDE constraint is the load-bearing piece (RFC-0001 spike criterion a): the DATABASE —
// not application code — arbitrates double-booking, per resource, on the half-open `[)` range.
// The same pattern scales from an integration's booking tables to a first-class reservation store.
//
// The deployment role owns every table, so any function or operator it resolves through a schema
// another role can create objects in ("$user", public) runs with that ownership. The DDL therefore
// resolves names only in pg_catalog, then the session's temporary schema, while it runs, and hands
// the caller's search_path back at the end, so a caller that keeps going in the same transaction
// resolves its own names as before. Apply it in one transaction: under autocommit every statement
// is a transaction of its own, and the pin ends with the statement that sets it.
import { SLOTLOCK_MAX_AVAILABILITY_RULES } from './weekly-hours.js';

const CALLER_SEARCH_PATH_SETTING = 'slotlock.caller_search_path';
const DEPLOYMENT_SEARCH_PATH_PIN = `SELECT pg_catalog.set_config('${CALLER_SEARCH_PATH_SETTING}', pg_catalog.current_setting('search_path'), true);
SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
`;
const DEPLOYMENT_SEARCH_PATH_RESTORE = `SELECT pg_catalog.set_config('search_path', pg_catalog.current_setting('${CALLER_SEARCH_PATH_SETTING}'), true);
`;

// applyTenantRls forces row-level security, which binds the table owner too, and the deployment
// sets no tenant: its data steps (reaping holds and listing conflicts before the overlap
// constraint, merging duplicate resources, binding archives, backfilling event children) would see
// no rows, skip what they repair and leave a constraint to meet rows its own check never saw. The
// deployment lifts FORCE from the tables that have it before its first data step and puts it back
// after its last, on those tables only. applySchema runs both in one transaction, which holds the
// tables locked in between; a failure rolls the lift back with everything else. Run statement by
// statement, the lift commits on its own and a refused data step stops the run before the restore,
// so the tables lifted are recorded in a table, not the session: the next deployment, from any
// session or connection, puts FORCE back on every table recorded, and `slotlock serve` refuses to
// start while a tenant table is left without it.
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
 * The version of the schema this release creates, recorded in `slotlock.schema_version` by every
 * migration. Releases up to 0.2 recorded nothing; 0.1 was version 1 and 0.2 version 2.
 */
export const SLOTLOCK_SCHEMA_VERSION = 3;

/** The start of the message with which the deployment DDL refuses a schema a newer release migrated. */
export const SLOTLOCK_SCHEMA_NEWER_REFUSAL =
  'Slotlock will not migrate a schema a newer release migrated';

/** The oldest PostgreSQL the DDL runs on (`server_version_num`): it uses pg_input_is_valid. */
const MIN_SERVER_VERSION_NUM = 160000;

// Before anything changes: a server too old for the DDL fails here, with a message that names the
// version, rather than part way through on a function it lacks; and a schema a newer release
// migrated is refused, since this release's DDL would put back what that release replaced.
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

// Every slotlock.<name> the deployment uses resolves in that schema, and the deployment writes rows
// into its tables, firing their triggers, as the owner of every table. A role that owns the schema,
// can create objects in it, owns an object in it, owns the function a trigger on its tables runs, or
// may create such a trigger (after this check, before the first write) can therefore run code as the
// deployment role (IF NOT EXISTS keeps whatever it made first); one that owns an extension installed
// there can DROP EXTENSION ... CASCADE and take the exclusion constraints with it. The deployment
// refuses before it touches anything there, listing each finding as a JSON array in the error's
// DETAIL. Superusers are trusted: they can do all of this anyway.
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
 * What every migration checks before it changes anything, applySchema and applyTenantRls included
 * when they find nothing to change: that no other role controls the schema, then the server version
 * and the schema version. Run with search_path pinned, as the DDL pins it.
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
export const SLOTLOCK_TENANT_ADMIN_TABLES = Object.freeze(['tenant_suspensions'] as const);

/**
 * The SECURITY DEFINER functions through which a server checks a tenant's suspension and erases a
 * tenant, by signature.
 */
export const SLOTLOCK_TENANT_ADMIN_FUNCTIONS = Object.freeze([
  'slotlock.tenant_suspended(text)',
  'slotlock.erase_tenant(text)',
] as const);

/**
 * Functions only the deployment role runs: suspending and lifting a suspension. No other role is
 * granted them, so a serving role cannot lift a suspension.
 */
export const SLOTLOCK_OPERATOR_FUNCTIONS = Object.freeze([
  'slotlock.suspend_tenant(text, text)',
  'slotlock.unsuspend_tenant(text)',
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

// API keys (api-keys.ts). The tables hold a SHA-256 digest per key, never the key. Row-level security
// is enabled with no policy and no role is granted anything on them, so only their owner reads or
// writes them, through the functions below; the serving role may execute those and nothing else here.
//
// Each function takes its tenant as an argument, as every store method does: the serving role
// already names the tenant of every query it makes. Within a call it cannot reach another tenant's
// keys, read a digest, or use a digest again once its key was rotated out or erased: those digests
// stay in api_key_retired_digests (digests only, nothing about the tenant), and a revoked key's row
// stays in api_keys until erasure, so the unique digest refuses it too.
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
         ) < ${SLOTLOCK_API_KEY_ACTIVE_LIMIT}
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
`;

// The dashboard's records (dashboard.ts), shared by every server on this database: a finished sign-in
// (its callback works once), a sent form (it runs once) and a signed-out session (a copied cookie
// stays out). Each is a SHA-256 digest of a value only the dashboard's sealed cookies and pages
// carry. Form records also carry a digest of the person who sent them, so the database can cap them;
// nothing here names a tenant. Row-level security is enabled with no policy and no role is granted
// anything, so the serving role reaches the table only through the two functions below.
//
// The database's clock decides. Servers seal an expiry into each cookie and form by their own
// clocks, which may run apart from each other and from the database's; a record judged by the
// database while its token was judged by a server could lapse while some server still took the
// token. So the functions refuse a token whose expiry the database's clock has passed, or that
// claims to outlive a day (no dashboard token lives longer than 12 hours), and keep each record
// until exactly that expiry: while the database would accept the token, its record is there.
const SLOTLOCK_DASHBOARD_DDL = `
CREATE TABLE IF NOT EXISTS slotlock.dashboard_tokens (
  kind text NOT NULL,
  token_hash bytea NOT NULL,
  owner_hash bytea,
  expires_at timestamptz NOT NULL,
  CONSTRAINT slotlock_dashboard_tokens_pkey PRIMARY KEY (kind, token_hash),
  CONSTRAINT slotlock_dashboard_tokens_kind_valid CHECK (kind IN ('sign_in', 'form', 'ended_session')),
  CONSTRAINT slotlock_dashboard_tokens_hash_valid CHECK (octet_length(token_hash) = 32),
  CONSTRAINT slotlock_dashboard_tokens_owner_valid
    CHECK (owner_hash IS NULL OR octet_length(owner_hash) = 32),
  CONSTRAINT slotlock_dashboard_tokens_form_owner CHECK (kind <> 'form' OR owner_hash IS NOT NULL)
);
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

// The schema's version. One row, written by the DDL itself at its end, so a schema migrated by
// running SLOTLOCK_CORE_DDL directly is versioned too. applySchema adds digests of the DDL and of the
// catalog it left, so that a later migration with nothing to change can tell, and take no lock on
// any table. Nothing here names a tenant; RLS is enabled with no policy and no role is granted
// anything, so a server reads the version only through installed_schema_version().
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

// Tenant suspension and erasure. A suspended tenant's server transactions (withTenant) may read,
// and write nothing; its keys still authenticate, but it gets no new key or secret. The table names
// tenants and why they were suspended, so RLS is enabled with no policy and no role is granted
// anything: a server reads it only through tenant_suspended(), and only the deployment role, which
// owns it, suspends or lifts a suspension. Erasure keeps the suspension, so an erased abuser stays
// suspended.
//
// Every server transaction for a tenant holds the tenant's lock shared, from before it reads the
// suspension; suspension and erasure take it exclusively. So a suspension waits for the tenant's
// transactions in flight, and every one that starts after it sees it.
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
  FOR setting IN
    SELECT DISTINCT contract.tenant_context_setting FROM slotlock.rls_policy_contracts contract
  LOOP
    previous := previous || jsonb_build_object(setting, current_setting(setting, true));
    PERFORM set_config(setting, requested_tenant_ref, true);
  END LOOP;

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
  erased_table := 'resources';
  DELETE FROM slotlock.resources WHERE tenant_ref = requested_tenant_ref;
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
`;

// A constraint an upgrade added NOT VALID (no table scan under its ACCESS EXCLUSIVE lock) is checked
// here. applySchema runs this in a transaction of its own once the DDL has committed: inside the
// DDL's transaction every table it altered stays under ACCESS EXCLUSIVE until commit, so the scan
// would hold up every serving query. On its own, each VALIDATE takes SHARE UPDATE EXCLUSIVE (and
// ROW SHARE on a foreign key's referenced table), which no read or row write conflicts with
// (PostgreSQL 17, ALTER TABLE and Explicit Locking). It sees every row whatever row-level security
// the table forces: the check scans the table itself, and referential checks bypass row security.
// One that old rows still break stays NOT VALID, with a notice, rather than stopping the migration:
// it binds every new row either way, and applySchema tries it again at each later migration. Once
// valid, a constraint is never checked again.
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

// The digests that let the next migration skip are recorded by applySchema once it has validated.
const DEPLOYMENT_RECORD_VERSION = `INSERT INTO slotlock.schema_version (singleton, version, applied_at)
VALUES (true, ${SLOTLOCK_SCHEMA_VERSION}, now())
ON CONFLICT (singleton) DO UPDATE
SET version = EXCLUDED.version, ddl_sha256 = NULL, catalog_sha256 = NULL,
    applied_at = EXCLUDED.applied_at;
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
  CONSTRAINT slotlock_reservations_status_valid CHECK (status IN ('held', 'confirmed')),
  -- A hold must carry its expiry; a confirmed reservation must not (expiry is hold-only state).
  CONSTRAINT slotlock_reservations_expiry_shape CHECK (
    (status = 'held' AND expires_at IS NOT NULL)
    OR (status = 'confirmed' AND expires_at IS NULL)
  ),
  CONSTRAINT slotlock_reservations_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(starts_at, COALESCE(occupied_ends_at, ends_at), '[)') WITH &&
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
-- Who sees a resource: 'shared' ones are listed to agents and booked through them, 'private' ones
-- (a tax-deadline calendar, say) only by the tenant's own code. Fixed when the resource is created.
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'shared';
-- When the tenant archived it: listed nowhere and booked no more, its history kept. NULL: in use.
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS tenant_ref text;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS external_ref text;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS buffer_after_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS occupied_ends_at timestamptz;
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
     WHERE conname = 'slotlock_resources_visibility_valid'
       AND conrelid = 'slotlock.resources'::regclass
  ) THEN
    ALTER TABLE slotlock.resources
      ADD CONSTRAINT slotlock_resources_visibility_valid CHECK (visibility IN ('shared', 'private'));
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
END $$;

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
        tstzrange(starts_at, COALESCE(occupied_ends_at, ends_at), '[)') WITH &&
      );
  END IF;
  ALTER TABLE slotlock.reservations DROP CONSTRAINT IF EXISTS slotlock_reservations_buffered_no_overlap;
END
$slotlock_occupied_overlap$;

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
${SLOTLOCK_API_KEYS_DDL}${SLOTLOCK_DASHBOARD_DDL}${SLOTLOCK_TENANT_ADMIN_DDL}${DEPLOYMENT_RECORD_VERSION}`;

/** The whole deployment DDL, run in one transaction: the schema, then its constraints validated. */
export const SLOTLOCK_CORE_DDL: string = `${CORE_DDL_BODY}${DEPLOYMENT_VALIDATE_CONSTRAINTS}${DEPLOYMENT_RESTORE_FORCED_ROW_SECURITY}${DEPLOYMENT_SEARCH_PATH_RESTORE}`;

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
] as const);

const POSTGRES_SETTING_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const POSTGRES_ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
/** Names GRANT reads as a pseudo-role (PUBLIC reaches every role) or PostgreSQL reserves. */
const RESERVED_ROLE_NAMES = new Set(['public', 'current_role', 'current_user', 'session_user']);

/**
 * Build the grants for the application role: USAGE on the `slotlock` schema, DML on the store's
 * tables and EXECUTE on the API key and dashboard functions. Nothing else: no ownership, DDL,
 * sequence, RLS-contract, API key or dashboard table access. The role must not be
 * able to leave forced RLS, itself or through a role it belongs to (`grantApplicationRole` refuses
 * the known ways out; these statements check nothing). Rerun after every `applySchema()`, since a
 * release may add a table.
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
         'hold_commands'
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
    'hold_commands'
  )
  AND policyname = 'tenant_isolation_v1'
ON CONFLICT (table_name) DO UPDATE
SET tenant_context_setting = EXCLUDED.tenant_context_setting,
    policy_fingerprint = EXCLUDED.policy_fingerprint,
    installed_at = EXCLUDED.installed_at;
${DEPLOYMENT_SEARCH_PATH_RESTORE}`;
}

export const SLOTLOCK_TENANT_RLS_DDL = createSlotlockTenantRlsDdl();
