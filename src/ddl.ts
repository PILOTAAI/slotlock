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
  SLOTLOCK_MAX_KEY_SCOPE_REFS,
  SLOTLOCK_MAX_COMPOSITE_PARTS,
  SLOTLOCK_RECONCILE_TOLERANCE_PERCENT,
  SLOTLOCK_MAX_POOL_SETTINGS,
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
 * digest. 0.10 is 5, so a 0.9 release refuses it rather than putting back an erase_tenant that
 * leaves team workspaces, their members and invitations behind.
 */
export const SLOTLOCK_SCHEMA_VERSION = 5;

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
  'api_key_resource_scopes',
  'api_key_limits',
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
  'slotlock.set_api_key_resource_scope(text, uuid, text[], text[])',
  'slotlock.authenticate_scoped_api_key(bytea)',
  'slotlock.list_api_key_resource_scopes(text)',
  'slotlock.set_api_key_limits(text, uuid, integer, integer, integer, boolean)',
  'slotlock.list_api_key_limits(text)',
  'slotlock.authenticate_limited_api_key(bytea)',
] as const);


/**
 * The table behind the dashboard's shared records (dashboard.ts). No role but its owner holds a
 * right on it; it is reached only through SLOTLOCK_DASHBOARD_FUNCTIONS.
 */
export const SLOTLOCK_DASHBOARD_TABLES = Object.freeze([
  'dashboard_tokens',
  'dashboard_organizations',
  'dashboard_people',
  'workspace_memberships',
  'workspaces',
  'workspace_invitations',
  'dashboard_sessions',
] as const);

/** The SECURITY DEFINER functions through which the serving role reaches the dashboard's records. */
export const SLOTLOCK_DASHBOARD_FUNCTIONS = Object.freeze([
  'slotlock.use_dashboard_token(text, bytea, timestamptz, bytea)',
  'slotlock.dashboard_session_ended(bytea, timestamptz)',
  'slotlock.enabled_organizations(text)',
  'slotlock.enable_organization(text, text, text)',
  'slotlock.disable_organization(text, text)',
  'slotlock.dashboard_sign_in(text, text)',
  'slotlock.dashboard_standing(text, text)',
  'slotlock.dashboard_sign_out_everywhere(text)',
  'slotlock.prune_audit_events(text)',
  'slotlock.dashboard_display(text, text)',
  'slotlock.create_team(text, text, text, integer)',
  'slotlock.workspace_info(text)',
  'slotlock.person_workspaces(text)',
  'slotlock.workspace_members(text)',
  'slotlock.workspace_invitations_list(text)',
  'slotlock.invite_member(text, text, text, text, text, text, bytea, integer, integer, integer)',
  'slotlock.invitation_preview(bytea)',
  'slotlock.accept_invitation(bytea, uuid, text, text[], integer)',
  'slotlock.revoke_invitation(text, text, uuid)',
  'slotlock.resend_invitation(text, text, uuid, bytea, integer, integer, integer)',
  'slotlock.change_member_role(text, text, text, text)',
  'slotlock.remove_member(text, text, text)',
  'slotlock.pending_invitations_for(text, text[])',
  'slotlock.workspace_active(text)',
  'slotlock.prune_workspace_invitations()',
  'slotlock.dashboard_session_started(text, bytea, timestamptz, text, text)',
  'slotlock.dashboard_session_seen(text, bytea)',
  'slotlock.dashboard_sessions_of(text)',
  'slotlock.dashboard_session_end(text, bytea)',
  'slotlock.prune_dashboard_sessions()',
] as const);

/**
 * A workspace's roles (workspace-roles.ts), as workspace_memberships keeps them; and how long the
 * audit log keeps an event.
 */
export const SLOTLOCK_WORKSPACE_ROLE_VALUES = Object.freeze(['owner', 'admin', 'developer', 'member', 'viewer', 'billing'] as const);
export const SLOTLOCK_AUDIT_RETENTION_DAYS = 180;

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
  'overage_reports',
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
  'slotlock.tenant_plan_quotas(text)',
  'slotlock.reset_test_tenant(text)',
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

/** The most conversations a member keeps with the dashboard assistant: past it, the least recent goes. */
export const SLOTLOCK_ASSISTANT_MAX_CHATS = 100;

/** How a conversation with the assistant is named: 16 URL-safe characters. */
export const SLOTLOCK_ASSISTANT_CHAT_ID = /^[A-Za-z0-9_-]{16}$/;

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
/**
 * Partner accounts (RFC 0003 part 4): what the serving role may call for a partner key and the
 * partner API. A partner, its keys and its contract are made by the schema owner (`slotlock partner`).
 */
export const SLOTLOCK_PARTNER_FUNCTIONS = Object.freeze([
  'slotlock.partner_tenant_blocked(text)',
  'slotlock.authenticate_partner_key(bytea)',
  'slotlock.partner_contract(text)',
  'slotlock.put_partner_account(text, text, text)',
  'slotlock.list_partner_accounts(text)',
  'slotlock.get_partner_account(text, text)',
  'slotlock.set_partner_account_suspended(text, text, boolean, text)',
  'slotlock.partner_usage(text, date, date, text)',
  'slotlock.partner_account_tenant(text, text)',
  'slotlock.record_partner_reconciliation(text, date, integer, integer, numeric)',
] as const);

/** The partner tables: owner-only, reached through SLOTLOCK_PARTNER_FUNCTIONS. */
export const SLOTLOCK_PARTNER_TABLES = Object.freeze([
  'partners',
  'partner_keys',
  'partner_accounts',
  'partner_invoices',
  'partner_month_closes',
  'partner_erased_usage',
  'partner_reconciliations',
] as const);

export const SLOTLOCK_DEFINER_FUNCTIONS = Object.freeze([
  ...SLOTLOCK_API_KEY_FUNCTIONS,
  ...SLOTLOCK_PARTNER_FUNCTIONS,
  ...SLOTLOCK_DASHBOARD_FUNCTIONS,
  ...SLOTLOCK_SCHEMA_FUNCTIONS,
  ...SLOTLOCK_TENANT_ADMIN_FUNCTIONS,
]);

/**
 * Tenant tables the serving role may only add to and read (no UPDATE or DELETE): the audit log,
 * whose rows go only through slotlock.prune_audit_events and erasure.
 */
export const SLOTLOCK_APPEND_ONLY_TABLES = Object.freeze(['audit_events'] as const);

/** Tables no role but their owner reads or writes, reached only through SLOTLOCK_DEFINER_FUNCTIONS. */
export const SLOTLOCK_DEFINER_TABLES = Object.freeze([
  ...SLOTLOCK_API_KEY_TABLES,
  ...SLOTLOCK_PARTNER_TABLES,
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
  -- A test environment's key (RFC 0003 G9) says so: slk_test_, and only there (the DO block below).
  CONSTRAINT slotlock_api_keys_prefix_valid CHECK (prefix ~ '^slk_(test_)?[0-9A-Za-z]{8}$'),
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
-- A tenant reference ending in ~test is the test environment of the one before it (RFC 0003 G9):
-- its keys start slk_test_, and no other tenant's do, so a key says where it acts. Added NOT VALID
-- (DEPLOYMENT_VALIDATE_CONSTRAINTS); the prefix check it widens is replaced with it.
DO $slotlock_api_keys_environment$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.api_keys'::regclass AND conname = 'slotlock_api_keys_environment_valid'
  ) THEN
    ALTER TABLE slotlock.api_keys DROP CONSTRAINT IF EXISTS slotlock_api_keys_prefix_valid;
    ALTER TABLE slotlock.api_keys ADD CONSTRAINT slotlock_api_keys_prefix_valid
      CHECK (prefix ~ '^slk_(test_)?[0-9A-Za-z]{8}$') NOT VALID;
    ALTER TABLE slotlock.api_keys ADD CONSTRAINT slotlock_api_keys_environment_valid
      CHECK ((prefix ~ '^slk_test_') = (tenant_ref ~ '~test$')) NOT VALID;
  END IF;
END
$slotlock_api_keys_environment$;

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

-- Keys limited to part of their tenant (RFC 0003 G6): the locations (each with every location in
-- it) and groups whose resources the key reaches, and no other. Set when the key is made and kept
-- through rotation; gone with the key. Owner-only, reached through the functions below; the
-- database enforces it (withTenant's slotlock.resource_scope and the resource_scope_v1 policies).
CREATE TABLE IF NOT EXISTS slotlock.api_key_resource_scopes (
  key_id uuid PRIMARY KEY REFERENCES slotlock.api_keys (id) ON DELETE CASCADE,
  tenant_ref text NOT NULL,
  locations text[] NOT NULL DEFAULT '{}',
  groups text[] NOT NULL DEFAULT '{}',
  CONSTRAINT slotlock_api_key_resource_scopes_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND cardinality(locations) + cardinality(groups) >= 1
    AND cardinality(locations) <= ${SLOTLOCK_MAX_KEY_SCOPE_REFS}
    AND cardinality(groups) <= ${SLOTLOCK_MAX_KEY_SCOPE_REFS}
    AND array_position(locations, NULL) IS NULL AND array_position(groups, NULL) IS NULL
  )
);
ALTER TABLE slotlock.api_key_resource_scopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.api_key_resource_scopes FROM PUBLIC;

-- Limit one of the tenant's active keys, once: true when set, false when the tenant has no such
-- active key or it is limited already. Each reference as locations and groups take them.
CREATE OR REPLACE FUNCTION slotlock.set_api_key_resource_scope(
  requested_tenant_ref text, requested_id uuid, requested_locations text[], requested_groups text[]
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_set_api_key_resource_scope$
BEGIN
  IF requested_locations IS NULL OR requested_groups IS NULL
     OR EXISTS (SELECT 1 FROM unnest(requested_locations || requested_groups) named(ref)
                 WHERE named.ref IS NULL OR named.ref !~ '^[a-z0-9][a-z0-9._-]{0,99}$') THEN
    RAISE EXCEPTION 'Slotlock key scope references must be location and group references'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM slotlock.api_keys limited
                  WHERE limited.tenant_ref = requested_tenant_ref AND limited.id = requested_id
                    AND limited.revoked_at IS NULL) THEN
    RETURN false;
  END IF;
  INSERT INTO slotlock.api_key_resource_scopes (key_id, tenant_ref, locations, groups)
  VALUES (
    requested_id, requested_tenant_ref,
    ARRAY(SELECT DISTINCT ref FROM unnest(requested_locations) ref ORDER BY ref),
    ARRAY(SELECT DISTINCT ref FROM unnest(requested_groups) ref ORDER BY ref))
  ON CONFLICT (key_id) DO NOTHING;
  RETURN FOUND;
END
$slotlock_set_api_key_resource_scope$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[6]} FROM PUBLIC;

-- As authenticate_api_key, with the key's scope: null locations and groups for a key with none.
-- A key of a partner's account whose partner is not active (RFC 0003 P2) authenticates as nothing.
CREATE OR REPLACE FUNCTION slotlock.authenticate_scoped_api_key(presented_secret_hash bytea)
RETURNS TABLE (key_id uuid, key_tenant_ref text, key_scopes text[], scope_locations text[], scope_groups text[])
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_authenticate_scoped_api_key$
BEGIN
  RETURN QUERY
  SELECT found.key_id, found.key_tenant_ref, found.key_scopes, scope.locations, scope.groups
    FROM slotlock.authenticate_api_key(presented_secret_hash) found
    LEFT JOIN slotlock.api_key_resource_scopes scope ON scope.key_id = found.key_id
   WHERE NOT slotlock.partner_tenant_blocked(found.key_tenant_ref);
END
$slotlock_authenticate_scoped_api_key$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[7]} FROM PUBLIC;

-- The scopes of the tenant's limited keys, for its key list.
CREATE OR REPLACE FUNCTION slotlock.list_api_key_resource_scopes(requested_tenant_ref text)
RETURNS TABLE (key_id uuid, locations text[], groups text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_list_api_key_resource_scopes$
  SELECT scope.key_id, scope.locations, scope.groups
    FROM slotlock.api_key_resource_scopes scope
   WHERE scope.tenant_ref = requested_tenant_ref;
$slotlock_list_api_key_resource_scopes$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[8]} FROM PUBLIC;

-- What one agent's key may do, below the server's limits (RFC 0004 A5): its live holds and the
-- hours they hold, its requests a minute, and whether its bookings wait for a person. Null is the
-- server's. Kept through rotation (the key keeps its id); gone with the key. Owner-only, reached
-- through the functions below.
CREATE TABLE IF NOT EXISTS slotlock.api_key_limits (
  key_id uuid PRIMARY KEY REFERENCES slotlock.api_keys (id) ON DELETE CASCADE,
  tenant_ref text NOT NULL,
  max_holds integer,
  max_held_hours integer,
  requests_per_minute integer,
  requires_approval boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_api_key_limits_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND (max_holds IS NULL OR max_holds BETWEEN 1 AND 10000)
    AND (max_held_hours IS NULL OR max_held_hours BETWEEN 1 AND 876000)
    AND (requests_per_minute IS NULL OR requests_per_minute BETWEEN 1 AND 100000)
  )
);
ALTER TABLE slotlock.api_key_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.api_key_limits FROM PUBLIC;

-- Set one of the tenant's active keys' limits, replacing what it had; none at all removes them.
-- False when the tenant has no such active key.
CREATE OR REPLACE FUNCTION slotlock.set_api_key_limits(
  requested_tenant_ref text, requested_id uuid, requested_max_holds integer,
  requested_max_held_hours integer, requested_requests_per_minute integer, requested_approval boolean
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_set_api_key_limits$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM slotlock.api_keys limited
                  WHERE limited.tenant_ref = requested_tenant_ref AND limited.id = requested_id
                    AND limited.revoked_at IS NULL) THEN
    RETURN false;
  END IF;
  IF requested_max_holds IS NULL AND requested_max_held_hours IS NULL
     AND requested_requests_per_minute IS NULL AND requested_approval IS NOT TRUE THEN
    DELETE FROM slotlock.api_key_limits WHERE key_id = requested_id;
    RETURN true;
  END IF;
  INSERT INTO slotlock.api_key_limits (
    key_id, tenant_ref, max_holds, max_held_hours, requests_per_minute, requires_approval
  ) VALUES (
    requested_id, requested_tenant_ref, requested_max_holds, requested_max_held_hours,
    requested_requests_per_minute, requested_approval IS TRUE
  )
  ON CONFLICT (key_id) DO UPDATE
    SET max_holds = EXCLUDED.max_holds, max_held_hours = EXCLUDED.max_held_hours,
        requests_per_minute = EXCLUDED.requests_per_minute,
        requires_approval = EXCLUDED.requires_approval, updated_at = statement_timestamp();
  RETURN true;
END
$slotlock_set_api_key_limits$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[9]} FROM PUBLIC;

-- The limits of the tenant's keys that have any, for its key list.
CREATE OR REPLACE FUNCTION slotlock.list_api_key_limits(requested_tenant_ref text)
RETURNS TABLE (key_id uuid, max_holds integer, max_held_hours integer, requests_per_minute integer, requires_approval boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_list_api_key_limits$
  SELECT limits.key_id, limits.max_holds, limits.max_held_hours, limits.requests_per_minute,
         limits.requires_approval
    FROM slotlock.api_key_limits limits
   WHERE limits.tenant_ref = requested_tenant_ref;
$slotlock_list_api_key_limits$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[10]} FROM PUBLIC;

-- As authenticate_scoped_api_key, with the key's limits (null for the server's).
CREATE OR REPLACE FUNCTION slotlock.authenticate_limited_api_key(presented_secret_hash bytea)
RETURNS TABLE (
  key_id uuid, key_tenant_ref text, key_scopes text[], scope_locations text[], scope_groups text[],
  max_holds integer, max_held_hours integer, requests_per_minute integer, requires_approval boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_authenticate_limited_api_key$
BEGIN
  RETURN QUERY
  SELECT found.key_id, found.key_tenant_ref, found.key_scopes, found.scope_locations,
         found.scope_groups, limits.max_holds, limits.max_held_hours, limits.requests_per_minute,
         COALESCE(limits.requires_approval, false)
    FROM slotlock.authenticate_scoped_api_key(presented_secret_hash) found
    LEFT JOIN slotlock.api_key_limits limits ON limits.key_id = found.key_id;
END
$slotlock_authenticate_limited_api_key$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS[11]} FROM PUBLIC;

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

-- GitHub organizations an owner turned Slotlock on for (Teams on Cloud, RFC 0003, with
-- SLOTLOCK_DASHBOARD_ORGS=enabled): their github-org:<id> tenants are served while enabled. Turning
-- one off stops its keys at once and keeps its data, which the organization can turn back on to
-- reach, or erase. Owner-only; read and written through the functions below.
CREATE TABLE IF NOT EXISTS slotlock.dashboard_organizations (
  org_id text PRIMARY KEY,
  login text NOT NULL,
  enabled boolean NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_dashboard_organizations_valid CHECK (
    org_id ~ '^[1-9][0-9]{0,19}$'
    AND login ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'
    AND changed_by ~ '^github:[1-9][0-9]{0,19}$'
  )
);
ALTER TABLE slotlock.dashboard_organizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.dashboard_organizations FROM PUBLIC;

-- Of these organization ids (comma-separated), the ones turned on.
CREATE OR REPLACE FUNCTION slotlock.enabled_organizations(requested_ids text)
RETURNS SETOF text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_enabled_organizations$
  SELECT org.org_id FROM slotlock.dashboard_organizations org
   WHERE org.enabled
     AND org.org_id = ANY (pg_catalog.string_to_array(requested_ids, ','));
$slotlock_enabled_organizations$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[2]} FROM PUBLIC;

-- Turn Slotlock on for an organization; true when it was not on. Who may (an owner of it, read from
-- GitHub at sign-in) is the dashboard's to check.
CREATE OR REPLACE FUNCTION slotlock.enable_organization(requested_org text, requested_login text, requested_by text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_enable_organization$
DECLARE
  was boolean;
BEGIN
  SELECT org.enabled INTO was FROM slotlock.dashboard_organizations org
   WHERE org.org_id = requested_org FOR UPDATE;
  INSERT INTO slotlock.dashboard_organizations AS org (org_id, login, enabled, changed_by)
  VALUES (requested_org, requested_login, true, requested_by)
  ON CONFLICT (org_id) DO UPDATE
    SET login = EXCLUDED.login, enabled = true,
        changed_by = CASE WHEN org.enabled THEN org.changed_by ELSE EXCLUDED.changed_by END,
        changed_at = CASE WHEN org.enabled THEN org.changed_at ELSE statement_timestamp() END;
  RETURN was IS NOT TRUE;
END
$slotlock_enable_organization$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[3]} FROM PUBLIC;

-- Turn it off; true when it was on.
CREATE OR REPLACE FUNCTION slotlock.disable_organization(requested_org text, requested_by text)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_disable_organization$
  UPDATE slotlock.dashboard_organizations org
     SET enabled = false, changed_by = requested_by, changed_at = statement_timestamp()
   WHERE org.org_id = requested_org AND org.enabled
  RETURNING true;
$slotlock_disable_organization$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[4]} FROM PUBLIC;

-- The people who sign in to the dashboard, by their identity (github:<id> or google:<subject>,
-- never an email): when they last signed in, and the epoch their sessions carry. The epoch is
-- drawn at random: "Sign out everywhere" draws another, and a session sealed under any other is
-- refused (ASVS 5.0 7.4.1's per-user revocation). A person without a row (erased) has no epoch,
-- so none of their sessions passes, and a row made again draws afresh. Owner-only; reached
-- through the functions below.
CREATE TABLE IF NOT EXISTS slotlock.dashboard_people (
  person_ref text PRIMARY KEY,
  session_epoch integer NOT NULL DEFAULT (1 + floor(random() * 2147483646))::integer,
  last_sign_in_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_dashboard_people_valid CHECK (
    person_ref ~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$'
    AND session_epoch > 0
  )
);
ALTER TABLE slotlock.dashboard_people ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.dashboard_people FROM PUBLIC;

-- Who belongs to a shared workspace, and as what (workspace-roles.ts). A person's own workspace
-- (their github:<id> or google:<subject> tenant) has no row: they are its Owner. The live tenant
-- holds the rows; its test environment (~test) has the same members. Inactive rows are kept so
-- someone added back gets their role again. Owner-only: the serving role reads and writes roles only
-- through the functions below, which check what they are given; it cannot write the table itself.
-- A change made in Slotlock (a role given, a member removed) sets source to 'created' or
-- 'invitation', and sign-in's mirroring of GitHub never touches such a row again.
CREATE TABLE IF NOT EXISTS slotlock.workspace_memberships (
  tenant_ref text NOT NULL,
  person_ref text NOT NULL,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  deactivated_at timestamptz,
  CONSTRAINT slotlock_workspace_memberships_pkey PRIMARY KEY (tenant_ref, person_ref),
  CONSTRAINT slotlock_workspace_memberships_valid CHECK (
    tenant_ref ~ '^(github-org:[1-9][0-9]{0,19}|team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
    AND person_ref ~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$'
    AND role IN ('owner', 'admin', 'developer', 'member', 'viewer', 'billing')
    AND status IN ('active', 'inactive')
    AND source IN ('github_org', 'invitation', 'created')
    AND (status = 'active') = (deactivated_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS slotlock_workspace_memberships_person_idx
  ON slotlock.workspace_memberships (person_ref) WHERE status = 'active';
ALTER TABLE slotlock.workspace_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.workspace_memberships FROM PUBLIC;

-- A sign-in: the person is recorded (their epoch returned, to seal into the session) and, signing
-- in with GitHub, the organizations GitHub lists them in, as JSON [{"id":"123","role":"admin"}],
-- become their memberships there: GitHub's owners Owner, its members Developer. An organization
-- GitHub no longer lists ends the membership it gave. A role given in Slotlock (source other than
-- github_org) is never changed here.
CREATE OR REPLACE FUNCTION slotlock.dashboard_sign_in(requested_person text, requested_github_orgs text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_dashboard_sign_in$
DECLARE
  listed jsonb;
  epoch integer;
BEGIN
  IF requested_person IS NULL
     OR requested_person !~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$' THEN
    RAISE EXCEPTION 'Slotlock dashboard: invalid person' USING ERRCODE = '22023';
  END IF;
  INSERT INTO slotlock.dashboard_people AS person (person_ref) VALUES (requested_person)
  ON CONFLICT (person_ref) DO UPDATE SET last_sign_in_at = statement_timestamp()
  RETURNING person.session_epoch INTO epoch;
  IF requested_github_orgs IS NULL THEN
    RETURN epoch;
  END IF;
  IF requested_person !~ '^github:' OR octet_length(requested_github_orgs) > 8192 THEN
    RAISE EXCEPTION 'Slotlock dashboard: invalid organizations' USING ERRCODE = '22023';
  END IF;
  listed := requested_github_orgs::jsonb;
  IF jsonb_typeof(listed) <> 'array' OR jsonb_array_length(listed) > 100 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(listed) org
     WHERE jsonb_typeof(org) <> 'object'
        OR coalesce(org ->> 'id', '') !~ '^[1-9][0-9]{0,19}$'
        OR coalesce(org ->> 'role', '') NOT IN ('admin', 'member')
  ) THEN
    RAISE EXCEPTION 'Slotlock dashboard: invalid organizations' USING ERRCODE = '22023';
  END IF;
  INSERT INTO slotlock.workspace_memberships AS member (tenant_ref, person_ref, role, status, source)
  SELECT DISTINCT ON (org ->> 'id') 'github-org:' || (org ->> 'id'), requested_person,
         CASE org ->> 'role' WHEN 'admin' THEN 'owner' ELSE 'developer' END, 'active', 'github_org'
    FROM jsonb_array_elements(listed) org
   ORDER BY org ->> 'id', org ->> 'role'
  ON CONFLICT (tenant_ref, person_ref) DO UPDATE
    SET role = EXCLUDED.role, status = 'active', deactivated_at = NULL,
        updated_at = statement_timestamp()
    WHERE member.source = 'github_org';
  UPDATE slotlock.workspace_memberships member
     SET status = 'inactive', deactivated_at = statement_timestamp(), updated_at = statement_timestamp()
   WHERE member.person_ref = requested_person
     AND member.source = 'github_org'
     AND member.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(listed) org
        WHERE member.tenant_ref = 'github-org:' || (org ->> 'id'));
  RETURN epoch;
END
$slotlock_dashboard_sign_in$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[5]} FROM PUBLIC;

-- A person's standing in a workspace now: their role (Owner of their own; else an active
-- membership's, or none) and their sessions' epoch. A test environment is its live tenant's.
CREATE OR REPLACE FUNCTION slotlock.dashboard_standing(requested_tenant text, requested_person text)
RETURNS TABLE (role text, session_epoch integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_dashboard_standing$
  WITH live AS (
    SELECT pg_catalog.regexp_replace(requested_tenant, '~test$', '') AS tenant_ref
  )
  SELECT CASE
           WHEN live.tenant_ref = requested_person THEN 'owner'
           ELSE (SELECT member.role FROM slotlock.workspace_memberships member
                  WHERE member.tenant_ref = live.tenant_ref
                    AND member.person_ref = requested_person
                    AND member.status = 'active')
         END,
         (SELECT person.session_epoch FROM slotlock.dashboard_people person
           WHERE person.person_ref = requested_person)
    FROM live;
$slotlock_dashboard_standing$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[6]} FROM PUBLIC;

-- Sign a person out everywhere: a new epoch is drawn (never the old one), and every session sealed
-- under the old is refused from now on. Returns the new epoch.
CREATE OR REPLACE FUNCTION slotlock.dashboard_sign_out_everywhere(requested_person text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_dashboard_sign_out_everywhere$
DECLARE
  epoch integer;
BEGIN
  IF requested_person IS NULL
     OR requested_person !~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$' THEN
    RAISE EXCEPTION 'Slotlock dashboard: invalid person' USING ERRCODE = '22023';
  END IF;
  INSERT INTO slotlock.dashboard_people AS person (person_ref) VALUES (requested_person)
  ON CONFLICT (person_ref) DO UPDATE
    SET session_epoch = (
      SELECT CASE WHEN drawn.epoch = person.session_epoch THEN drawn.epoch % 2147483646 + 1 ELSE drawn.epoch END
        FROM (SELECT (1 + floor(random() * 2147483646))::integer AS epoch) drawn)
  RETURNING person.session_epoch INTO epoch;
  RETURN epoch;
END
$slotlock_dashboard_sign_out_everywhere$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[7]} FROM PUBLIC;

-- Team workspaces (team:<uuid>): a workspace Slotlock owns, not a person's and not a GitHub
-- organization's, so its owners can change. Owner-only; reached through the functions below.
CREATE TABLE IF NOT EXISTS slotlock.workspaces (
  tenant_ref text PRIMARY KEY,
  handle text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  -- Who created it, for the free team workspaces a person may create; cleared when they are erased.
  created_by text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_workspaces_handle_key UNIQUE (handle),
  CONSTRAINT slotlock_workspaces_valid CHECK (
    tenant_ref ~ '^team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND handle ~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$'
    AND char_length(name) BETWEEN 1 AND 80
    AND name !~ '[[:cntrl:]]'
    AND status IN ('active')
    AND (created_by IS NULL OR created_by ~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$')
  )
);
ALTER TABLE slotlock.workspaces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.workspaces FROM PUBLIC;

-- How a person is shown to the others in their workspaces: their GitHub login or the Google email
-- Google verified, as they last signed in. Never an identifier: people are their github:/google: ref.
ALTER TABLE slotlock.dashboard_people ADD COLUMN IF NOT EXISTS display text;
DO $slotlock_people_display$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_dashboard_people_display_valid'
       AND conrelid = 'slotlock.dashboard_people'::regclass
  ) THEN
    ALTER TABLE slotlock.dashboard_people ADD CONSTRAINT slotlock_dashboard_people_display_valid
      CHECK (display IS NULL OR (char_length(display) BETWEEN 1 AND 254 AND display !~ '[[:cntrl:]<>]'));
  END IF;
END
$slotlock_people_display$;

-- Invitations to a team workspace: to an email address or a GitHub account, with a role, by a
-- member entitled to give it. Only a SHA-256 digest of the token is kept (the token is 256 random
-- bits, shown or sent once). An invitation is pending until accepted, revoked or past expires_at;
-- accepting needs the signed-in person to be the GitHub account invited, or to hold the invited
-- email verified. Owner-only; reached through the functions below.
CREATE TABLE IF NOT EXISTS slotlock.workspace_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL REFERENCES slotlock.workspaces (tenant_ref) ON DELETE CASCADE,
  token_sha256 bytea NOT NULL,
  email text,
  github_ref text,
  github_login text,
  role text NOT NULL,
  inviter_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  sent_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by text,
  revoked_at timestamptz,
  CONSTRAINT slotlock_workspace_invitations_token_key UNIQUE (token_sha256),
  CONSTRAINT slotlock_workspace_invitations_valid CHECK (
    octet_length(token_sha256) = 32
    AND (email IS NULL) <> (github_ref IS NULL)
    AND (email IS NULL OR (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)
                           AND email ~ '^[^@[:space:][:cntrl:]<>]+@[^@[:space:][:cntrl:]<>]+$'))
    AND (github_ref IS NULL OR github_ref ~ '^github:[1-9][0-9]{0,19}$')
    AND (github_login IS NULL OR github_login ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$')
    AND role IN ('owner', 'admin', 'developer', 'member', 'viewer', 'billing')
    AND inviter_ref ~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$'
    AND (accepted_by IS NULL OR accepted_by ~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$')
    AND expires_at > created_at
  )
);
CREATE INDEX IF NOT EXISTS slotlock_workspace_invitations_tenant_idx
  ON slotlock.workspace_invitations (tenant_ref, sent_at DESC);
CREATE INDEX IF NOT EXISTS slotlock_workspace_invitations_github_idx
  ON slotlock.workspace_invitations (github_ref) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS slotlock_workspace_invitations_email_idx
  ON slotlock.workspace_invitations (email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE slotlock.workspace_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.workspace_invitations FROM PUBLIC;

-- Whether a role may give another (workspace-roles.ts slotlockRoleMayGrant): an Owner any role, an
-- Admin up to Admin (never Owner or Billing), anyone else none.
CREATE OR REPLACE FUNCTION slotlock.workspace_may_grant(granter text, granted text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_workspace_may_grant$
  SELECT CASE granter
           WHEN 'owner' THEN granted IN ('owner', 'admin', 'developer', 'member', 'viewer', 'billing')
           WHEN 'admin' THEN granted IN ('admin', 'developer', 'member', 'viewer')
           ELSE false
         END;
$slotlock_workspace_may_grant$;
REVOKE ALL ON FUNCTION slotlock.workspace_may_grant(text, text) FROM PUBLIC;

-- A person's display (their GitHub login, or the email Google verified), at sign-in.
CREATE OR REPLACE FUNCTION slotlock.dashboard_display(requested_person text, requested_display text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_dashboard_display$
BEGIN
  UPDATE slotlock.dashboard_people person
     SET display = NULLIF(requested_display, '')
   WHERE person.person_ref = requested_person;
END
$slotlock_dashboard_display$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[9]} FROM PUBLIC;

-- A new team workspace, its creator its Owner. With requested_cap, a person may have created at
-- most that many active team workspaces that are not on a paid plan.
CREATE OR REPLACE FUNCTION slotlock.create_team(
  requested_person text, requested_name text, requested_handle text, requested_cap integer)
RETURNS TABLE (tenant_ref text, refusal text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_create_team$
DECLARE
  created text := 'team:' || gen_random_uuid()::text;
  free_count integer;
BEGIN
  IF requested_person !~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$' THEN
    RAISE EXCEPTION 'Slotlock teams: invalid person' USING ERRCODE = '22023';
  END IF;
  IF requested_handle IS NULL OR requested_handle !~ '^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$' THEN
    RETURN QUERY SELECT NULL::text, 'invalid_handle'::text;
    RETURN;
  END IF;
  IF requested_name IS NULL OR char_length(btrim(requested_name)) NOT BETWEEN 1 AND 80
     OR requested_name ~ '[[:cntrl:]]' THEN
    RETURN QUERY SELECT NULL::text, 'invalid_name'::text;
    RETURN;
  END IF;
  -- One person's creations at a time, so two at once cannot both pass the cap.
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:create-team:' || requested_person, 0));
  IF requested_cap IS NOT NULL THEN
    SELECT count(*) INTO free_count FROM slotlock.workspaces ws
     WHERE ws.created_by = requested_person AND ws.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM slotlock.tenant_plans paid
                        WHERE paid.tenant_ref = ws.tenant_ref AND paid.plan <> 'free' AND paid.status <> 'canceled');
    IF free_count >= requested_cap THEN
      RETURN QUERY SELECT NULL::text, 'team_limit'::text;
      RETURN;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM slotlock.workspaces ws WHERE ws.handle = requested_handle) THEN
    RETURN QUERY SELECT NULL::text, 'handle_taken'::text;
    RETURN;
  END IF;
  INSERT INTO slotlock.workspaces (tenant_ref, handle, name, created_by)
  VALUES (created, requested_handle, btrim(requested_name), requested_person);
  INSERT INTO slotlock.workspace_memberships (tenant_ref, person_ref, role, source)
  VALUES (created, requested_person, 'owner', 'created');
  RETURN QUERY SELECT created, NULL::text;
EXCEPTION WHEN unique_violation THEN
  RETURN QUERY SELECT NULL::text, 'handle_taken'::text;
END
$slotlock_create_team$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[10]} FROM PUBLIC;

-- A team workspace's handle, name and status (its test environment's are its own).
CREATE OR REPLACE FUNCTION slotlock.workspace_info(requested_tenant text)
RETURNS TABLE (handle text, name text, status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_workspace_info$
BEGIN
  RETURN QUERY SELECT ws.handle, ws.name, ws.status FROM slotlock.workspaces ws
   WHERE ws.tenant_ref = pg_catalog.regexp_replace(requested_tenant, '~test$', '');
END
$slotlock_workspace_info$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[11]} FROM PUBLIC;

-- The team workspaces a person is an active member of, with their role, by name.
CREATE OR REPLACE FUNCTION slotlock.person_workspaces(requested_person text)
RETURNS TABLE (tenant_ref text, handle text, name text, role text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_person_workspaces$
BEGIN
  RETURN QUERY SELECT ws.tenant_ref, ws.handle, ws.name, member.role
    FROM slotlock.workspace_memberships member
    JOIN slotlock.workspaces ws ON ws.tenant_ref = member.tenant_ref AND ws.status = 'active'
   WHERE member.person_ref = requested_person AND member.status = 'active'
   ORDER BY lower(ws.name), ws.handle
   LIMIT 100;
END
$slotlock_person_workspaces$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[12]} FROM PUBLIC;

-- A workspace's active members, Owners first, with how each is shown.
CREATE OR REPLACE FUNCTION slotlock.workspace_members(requested_tenant text)
RETURNS TABLE (person_ref text, role text, source text, display text, joined_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_workspace_members$
BEGIN
  RETURN QUERY SELECT member.person_ref, member.role, member.source, person.display, member.created_at
    FROM slotlock.workspace_memberships member
    LEFT JOIN slotlock.dashboard_people person ON person.person_ref = member.person_ref
   WHERE member.tenant_ref = pg_catalog.regexp_replace(requested_tenant, '~test$', '')
     AND member.status = 'active'
   ORDER BY array_position(ARRAY['owner', 'admin', 'developer', 'member', 'viewer', 'billing'], member.role),
            lower(coalesce(person.display, member.person_ref))
   LIMIT 1000;
END
$slotlock_workspace_members$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[13]} FROM PUBLIC;

-- A workspace's invitations not accepted or revoked: pending ones, and those expired in the last
-- 30 days (to send again), newest first.
CREATE OR REPLACE FUNCTION slotlock.workspace_invitations_list(requested_tenant text)
RETURNS TABLE (id uuid, email text, github_login text, role text, inviter_display text,
               sent_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_workspace_invitations_list$
BEGIN
  RETURN QUERY SELECT invitation.id, invitation.email, invitation.github_login, invitation.role,
                      coalesce(inviter.display, invitation.inviter_ref), invitation.sent_at, invitation.expires_at
    FROM slotlock.workspace_invitations invitation
    LEFT JOIN slotlock.dashboard_people inviter ON inviter.person_ref = invitation.inviter_ref
   WHERE invitation.tenant_ref = pg_catalog.regexp_replace(requested_tenant, '~test$', '')
     AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
     AND invitation.expires_at > statement_timestamp() - interval '30 days'
   ORDER BY invitation.sent_at DESC
   LIMIT 500;
END
$slotlock_workspace_invitations_list$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[14]} FROM PUBLIC;

-- Invite to a team workspace: by email or GitHub account, with a role the inviter may give, one
-- pending invitation per address (a new one replaces it), at most requested_daily_limit sent a day,
-- and with requested_member_cap, no more people than it counting pending invitations. The token
-- is given as its SHA-256 digest only.
CREATE OR REPLACE FUNCTION slotlock.invite_member(
  requested_tenant text, requested_inviter text, requested_email text, requested_github text,
  requested_github_login text, requested_role text, requested_token bytea, requested_days integer,
  requested_daily_limit integer, requested_member_cap integer)
RETURNS TABLE (invitation_id uuid, refusal text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_invite_member$
DECLARE
  inviter_role text;
  email_normalized text := NULLIF(lower(btrim(requested_email)), '');
  occupied integer;
  created uuid;
BEGIN
  IF requested_days IS NULL OR requested_days NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'Slotlock teams: invitations last 1-30 days' USING ERRCODE = '22023';
  END IF;
  -- The workspace's invitations one at a time: the cap and the daily limit see each other.
  PERFORM 1 FROM slotlock.workspaces ws
   WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, 'not_found'::text;
    RETURN;
  END IF;
  SELECT member.role INTO inviter_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_inviter AND member.status = 'active';
  IF inviter_role IS NULL OR NOT slotlock.workspace_may_grant(inviter_role, requested_role) THEN
    RETURN QUERY SELECT NULL::uuid, 'not_allowed'::text;
    RETURN;
  END IF;
  IF (email_normalized IS NULL) = (requested_github IS NULL) THEN
    RAISE EXCEPTION 'Slotlock teams: invite an email or a GitHub account' USING ERRCODE = '22023';
  END IF;
  IF requested_github IS NOT NULL AND EXISTS (
    SELECT 1 FROM slotlock.workspace_memberships member
     WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_github AND member.status = 'active'
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'already_member'::text;
    RETURN;
  END IF;
  -- The team's invitations a day, and the inviter's across every team they are in.
  IF requested_daily_limit IS NOT NULL AND (
    (SELECT count(*) FROM slotlock.workspace_invitations sent
      WHERE sent.tenant_ref = requested_tenant AND sent.sent_at > statement_timestamp() - interval '1 day')
      >= requested_daily_limit
    OR (SELECT count(*) FROM slotlock.workspace_invitations sent
         WHERE sent.inviter_ref = requested_inviter AND sent.sent_at > statement_timestamp() - interval '1 day')
      >= requested_daily_limit
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'invitation_limit'::text;
    RETURN;
  END IF;
  -- A pending invitation to the same address is replaced, so it is not counted against the cap.
  IF requested_member_cap IS NOT NULL THEN
    SELECT (SELECT count(*) FROM slotlock.workspace_memberships member
             WHERE member.tenant_ref = requested_tenant AND member.status = 'active')
         + (SELECT count(*) FROM slotlock.workspace_invitations pending
             WHERE pending.tenant_ref = requested_tenant AND pending.accepted_at IS NULL
               AND pending.revoked_at IS NULL AND pending.expires_at > statement_timestamp()
               AND NOT coalesce(pending.email = email_normalized OR pending.github_ref = requested_github, false))
      INTO occupied;
    IF occupied >= requested_member_cap THEN
      RETURN QUERY SELECT NULL::uuid, 'member_cap'::text;
      RETURN;
    END IF;
  END IF;
  UPDATE slotlock.workspace_invitations old
     SET revoked_at = statement_timestamp()
   WHERE old.tenant_ref = requested_tenant AND old.accepted_at IS NULL AND old.revoked_at IS NULL
     AND (old.email = email_normalized OR old.github_ref = requested_github);
  INSERT INTO slotlock.workspace_invitations
    (tenant_ref, token_sha256, email, github_ref, github_login, role, inviter_ref, expires_at)
  VALUES (requested_tenant, requested_token, email_normalized, requested_github,
          CASE WHEN requested_github IS NULL THEN NULL ELSE requested_github_login END,
          requested_role, requested_inviter,
          statement_timestamp() + make_interval(days => requested_days))
  RETURNING id INTO created;
  RETURN QUERY SELECT created, NULL::text;
END
$slotlock_invite_member$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[15]} FROM PUBLIC;

-- What an invitation's holder may see before joining: the workspace, who invited them, the role,
-- whom it is for, and its state. Nothing else of the workspace.
CREATE OR REPLACE FUNCTION slotlock.invitation_preview(requested_token bytea)
RETURNS TABLE (invitation_id uuid, tenant_ref text, workspace_name text, workspace_handle text,
               inviter_display text, role text, email text, github_ref text, github_login text, state text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_invitation_preview$
BEGIN
  RETURN QUERY SELECT invitation.id, invitation.tenant_ref, ws.name, ws.handle,
         coalesce(inviter.display, 'A member'), invitation.role, invitation.email, invitation.github_ref,
         invitation.github_login,
         CASE WHEN invitation.revoked_at IS NOT NULL THEN 'revoked'
              WHEN invitation.accepted_at IS NOT NULL THEN 'accepted'
              WHEN invitation.expires_at <= statement_timestamp() THEN 'expired'
              ELSE 'pending' END
    FROM slotlock.workspace_invitations invitation
    JOIN slotlock.workspaces ws ON ws.tenant_ref = invitation.tenant_ref
    LEFT JOIN slotlock.dashboard_people inviter ON inviter.person_ref = invitation.inviter_ref
   WHERE invitation.token_sha256 = requested_token;
END
$slotlock_invitation_preview$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[16]} FROM PUBLIC;

-- Accept an invitation, by its token's digest or (one found for the person) its id: in one
-- transaction, only while pending, only by the GitHub account invited or a person holding the
-- invited email verified, only while the inviter may still give the role, and within
-- requested_member_cap. A member already keeps their role.
CREATE OR REPLACE FUNCTION slotlock.accept_invitation(
  requested_token bytea, requested_id uuid, requested_person text, requested_emails text[],
  requested_member_cap integer)
RETURNS TABLE (tenant_ref text, refusal text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_accept_invitation$
DECLARE
  invitation slotlock.workspace_invitations%ROWTYPE;
  found_id uuid;
  found_tenant text;
  inviter_role text;
  members integer;
BEGIN
  IF requested_person !~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$' THEN
    RAISE EXCEPTION 'Slotlock teams: invalid person' USING ERRCODE = '22023';
  END IF;
  SELECT found.id, found.tenant_ref INTO found_id, found_tenant FROM slotlock.workspace_invitations found
   WHERE (requested_token IS NOT NULL AND found.token_sha256 = requested_token)
      OR (requested_token IS NULL AND found.id = requested_id);
  IF found_id IS NULL THEN
    RETURN QUERY SELECT NULL::text, 'not_found'::text;
    RETURN;
  END IF;
  -- The workspace first, then the invitation: the order every change to it takes, so none deadlock.
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = found_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, 'not_found'::text;
    RETURN;
  END IF;
  SELECT * INTO invitation FROM slotlock.workspace_invitations found WHERE found.id = found_id FOR UPDATE;
  -- Sent again while this waited: the old token no longer opens it.
  IF NOT FOUND OR (requested_token IS NOT NULL AND invitation.token_sha256 <> requested_token) THEN
    RETURN QUERY SELECT NULL::text, 'not_found'::text;
    RETURN;
  END IF;
  IF invitation.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::text, 'revoked'::text;
    RETURN;
  ELSIF invitation.accepted_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::text, 'accepted'::text;
    RETURN;
  ELSIF invitation.expires_at <= statement_timestamp() THEN
    RETURN QUERY SELECT NULL::text, 'expired'::text;
    RETURN;
  END IF;
  IF NOT (
    (invitation.github_ref IS NOT NULL AND invitation.github_ref = requested_person)
    OR (invitation.email IS NOT NULL AND invitation.email = ANY (
          SELECT lower(btrim(given)) FROM unnest(coalesce(requested_emails, ARRAY[]::text[])) given))
  ) THEN
    RETURN QUERY SELECT NULL::text, 'not_for_you'::text;
    RETURN;
  END IF;
  SELECT member.role INTO inviter_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = invitation.tenant_ref AND member.person_ref = invitation.inviter_ref
     AND member.status = 'active';
  IF inviter_role IS NULL OR NOT slotlock.workspace_may_grant(inviter_role, invitation.role) THEN
    UPDATE slotlock.workspace_invitations SET revoked_at = statement_timestamp() WHERE id = invitation.id;
    RETURN QUERY SELECT NULL::text, 'revoked'::text;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM slotlock.workspace_memberships member
              WHERE member.tenant_ref = invitation.tenant_ref AND member.person_ref = requested_person
                AND member.status = 'active') THEN
    UPDATE slotlock.workspace_invitations
       SET accepted_at = statement_timestamp(), accepted_by = requested_person WHERE id = invitation.id;
    RETURN QUERY SELECT invitation.tenant_ref, NULL::text;
    RETURN;
  END IF;
  IF requested_member_cap IS NOT NULL THEN
    SELECT count(*) INTO members FROM slotlock.workspace_memberships member
     WHERE member.tenant_ref = invitation.tenant_ref AND member.status = 'active';
    IF members >= requested_member_cap THEN
      RETURN QUERY SELECT NULL::text, 'member_cap'::text;
      RETURN;
    END IF;
  END IF;
  INSERT INTO slotlock.workspace_memberships AS member (tenant_ref, person_ref, role, source)
  VALUES (invitation.tenant_ref, requested_person, invitation.role, 'invitation')
  ON CONFLICT ON CONSTRAINT slotlock_workspace_memberships_pkey DO UPDATE
    SET role = EXCLUDED.role, status = 'active', source = 'invitation', deactivated_at = NULL,
        updated_at = statement_timestamp();
  UPDATE slotlock.workspace_invitations
     SET accepted_at = statement_timestamp(), accepted_by = requested_person WHERE id = invitation.id;
  RETURN QUERY SELECT invitation.tenant_ref, NULL::text;
END
$slotlock_accept_invitation$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[17]} FROM PUBLIC;

-- Revoke a pending invitation, by an Owner or Admin of its workspace.
CREATE OR REPLACE FUNCTION slotlock.revoke_invitation(requested_tenant text, requested_actor text, requested_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_revoke_invitation$
DECLARE
  actor_role text;
  changed integer;
BEGIN
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  -- Only an invitation whose role the actor could give: an Admin never withdraws an Owner's.
  UPDATE slotlock.workspace_invitations invitation SET revoked_at = statement_timestamp()
   WHERE invitation.id = requested_id AND invitation.tenant_ref = requested_tenant
     AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
     AND actor_role IS NOT NULL AND slotlock.workspace_may_grant(actor_role, invitation.role);
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END
$slotlock_revoke_invitation$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[18]} FROM PUBLIC;

-- Send an invitation again, with a new token and a new expiry: by someone who may give its role,
-- within the daily limit. The old token stops working.
CREATE OR REPLACE FUNCTION slotlock.resend_invitation(
  requested_tenant text, requested_actor text, requested_id uuid, requested_token bytea,
  requested_days integer, requested_daily_limit integer, requested_member_cap integer)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_resend_invitation$
DECLARE
  actor_role text;
  invitation_role text;
BEGIN
  IF requested_days IS NULL OR requested_days NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'Slotlock teams: invitations last 1-30 days' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  SELECT invitation.role INTO invitation_role FROM slotlock.workspace_invitations invitation
   WHERE invitation.id = requested_id AND invitation.tenant_ref = requested_tenant
     AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
   FOR UPDATE;
  IF invitation_role IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF actor_role IS NULL OR NOT slotlock.workspace_may_grant(actor_role, invitation_role) THEN
    RETURN 'not_allowed';
  END IF;
  IF requested_daily_limit IS NOT NULL AND (
    (SELECT count(*) FROM slotlock.workspace_invitations sent
      WHERE sent.tenant_ref = requested_tenant AND sent.sent_at > statement_timestamp() - interval '1 day')
      >= requested_daily_limit
    OR (SELECT count(*) FROM slotlock.workspace_invitations sent
         WHERE sent.inviter_ref = requested_actor AND sent.sent_at > statement_timestamp() - interval '1 day')
      >= requested_daily_limit
  ) THEN
    RETURN 'invitation_limit';
  END IF;
  -- Sent again, it is open again: held to the cap with the members and the other open invitations.
  IF requested_member_cap IS NOT NULL AND
     (SELECT count(*) FROM slotlock.workspace_memberships member
       WHERE member.tenant_ref = requested_tenant AND member.status = 'active')
     + (SELECT count(*) FROM slotlock.workspace_invitations pending
         WHERE pending.tenant_ref = requested_tenant AND pending.id <> requested_id
           AND pending.accepted_at IS NULL AND pending.revoked_at IS NULL
           AND pending.expires_at > statement_timestamp())
     >= requested_member_cap THEN
    RETURN 'member_cap';
  END IF;
  UPDATE slotlock.workspace_invitations invitation
     SET token_sha256 = requested_token, sent_at = statement_timestamp(), inviter_ref = requested_actor,
         expires_at = statement_timestamp() + make_interval(days => requested_days)
   WHERE invitation.id = requested_id;
  RETURN NULL;
END
$slotlock_resend_invitation$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[19]} FROM PUBLIC;

-- Change a member's role, by someone who may give both their current role and the new one; a
-- workspace always keeps an Owner. A role given in Slotlock is never changed by a GitHub sign-in.
CREATE OR REPLACE FUNCTION slotlock.change_member_role(
  requested_tenant text, requested_actor text, requested_person text, requested_role text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_change_member_role$
DECLARE
  actor_role text;
  current_role_of text;
BEGIN
  IF requested_role NOT IN ('owner', 'admin', 'developer', 'member', 'viewer', 'billing') THEN
    RAISE EXCEPTION 'Slotlock teams: invalid role' USING ERRCODE = '22023';
  END IF;
  -- The workspace's owners one change at a time, so two Owners demoting each other leave one.
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  SELECT member.role INTO current_role_of FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_person AND member.status = 'active';
  IF current_role_of IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF actor_role IS NULL OR NOT slotlock.workspace_may_grant(actor_role, current_role_of)
     OR NOT slotlock.workspace_may_grant(actor_role, requested_role) THEN
    RETURN 'not_allowed';
  END IF;
  IF current_role_of = 'owner' AND requested_role <> 'owner' AND NOT EXISTS (
    SELECT 1 FROM slotlock.workspace_memberships other
     WHERE other.tenant_ref = requested_tenant AND other.status = 'active' AND other.role = 'owner'
       AND other.person_ref <> requested_person
  ) THEN
    RETURN 'last_owner';
  END IF;
  UPDATE slotlock.workspace_memberships member
     SET role = requested_role, source = CASE WHEN member.source = 'github_org' THEN 'created' ELSE member.source END,
         updated_at = statement_timestamp()
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_person;
  RETURN NULL;
END
$slotlock_change_member_role$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[20]} FROM PUBLIC;

-- Remove a member (or, the actor themselves, leave): by someone who may give their role; a
-- workspace always keeps an Owner. Their pending invitations go with them. The membership is kept
-- inactive, so inviting them back restores what an invitation gives.
CREATE OR REPLACE FUNCTION slotlock.remove_member(requested_tenant text, requested_actor text, requested_person text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_remove_member$
DECLARE
  actor_role text;
  removed_role text;
BEGIN
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  SELECT member.role INTO removed_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_person AND member.status = 'active';
  IF removed_role IS NULL OR actor_role IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF requested_actor <> requested_person AND NOT slotlock.workspace_may_grant(actor_role, removed_role) THEN
    RETURN 'not_allowed';
  END IF;
  IF removed_role = 'owner' AND NOT EXISTS (
    SELECT 1 FROM slotlock.workspace_memberships other
     WHERE other.tenant_ref = requested_tenant AND other.status = 'active' AND other.role = 'owner'
       AND other.person_ref <> requested_person
  ) THEN
    RETURN 'last_owner';
  END IF;
  UPDATE slotlock.workspace_memberships member
     SET status = 'inactive', source = 'created', deactivated_at = statement_timestamp(),
         updated_at = statement_timestamp()
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_person;
  UPDATE slotlock.workspace_invitations invitation SET revoked_at = statement_timestamp()
   WHERE invitation.tenant_ref = requested_tenant AND invitation.inviter_ref = requested_person
     AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL;
  RETURN NULL;
END
$slotlock_remove_member$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[21]} FROM PUBLIC;

-- The pending invitations meant for a person: to their GitHub account, or to an email they hold
-- verified. For the dashboard to offer "Join" without the link.
CREATE OR REPLACE FUNCTION slotlock.pending_invitations_for(requested_person text, requested_emails text[])
RETURNS TABLE (invitation_id uuid, tenant_ref text, workspace_name text, workspace_handle text,
               inviter_display text, role text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_pending_invitations_for$
BEGIN
  RETURN QUERY SELECT invitation.id, invitation.tenant_ref, ws.name, ws.handle,
         coalesce(inviter.display, 'A member'), invitation.role
    FROM slotlock.workspace_invitations invitation
    JOIN slotlock.workspaces ws ON ws.tenant_ref = invitation.tenant_ref AND ws.status = 'active'
    LEFT JOIN slotlock.dashboard_people inviter ON inviter.person_ref = invitation.inviter_ref
   WHERE invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
     AND invitation.expires_at > statement_timestamp()
     AND (invitation.github_ref = requested_person
          OR invitation.email = ANY (SELECT lower(btrim(given)) FROM unnest(coalesce(requested_emails, ARRAY[]::text[])) given))
     AND NOT EXISTS (SELECT 1 FROM slotlock.workspace_memberships member
                      WHERE member.tenant_ref = invitation.tenant_ref AND member.person_ref = requested_person
                        AND member.status = 'active')
   ORDER BY invitation.sent_at DESC
   LIMIT 20;
END
$slotlock_pending_invitations_for$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[22]} FROM PUBLIC;

-- Whether a team workspace serves its keys: only while it exists and is active.
CREATE OR REPLACE FUNCTION slotlock.workspace_active(requested_tenant text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_workspace_active$
BEGIN
  RETURN EXISTS (SELECT 1 FROM slotlock.workspaces ws
                  WHERE ws.tenant_ref = pg_catalog.regexp_replace(requested_tenant, '~test$', '')
                    AND ws.status = 'active');
END
$slotlock_workspace_active$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[23]} FROM PUBLIC;

-- Invitations finished (accepted, revoked or expired) more than 30 days ago, with the address they
-- were sent to: deleted.
CREATE OR REPLACE FUNCTION slotlock.prune_workspace_invitations()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_prune_workspace_invitations$
DECLARE
  pruned integer;
BEGIN
  -- Ended when accepted, revoked or, untouched, expired.
  DELETE FROM slotlock.workspace_invitations finished
   WHERE coalesce(finished.accepted_at, finished.revoked_at, finished.expires_at)
         < statement_timestamp() - interval '30 days';
  GET DIAGNOSTICS pruned = ROW_COUNT;
  RETURN pruned;
END
$slotlock_prune_workspace_invitations$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[24]} FROM PUBLIC;

-- Each dashboard session a person signed in with, for the Account page: when it began, when it was
-- last seen (to five minutes), the browser and address it began from, and whether the person
-- signed it out from another. Only a SHA-256 digest of the session's id is kept. Owner-only;
-- reached through the functions below.
CREATE TABLE IF NOT EXISTS slotlock.dashboard_sessions (
  sid_sha256 bytea PRIMARY KEY,
  person_ref text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  user_agent text,
  ip_address text,
  CONSTRAINT slotlock_dashboard_sessions_valid CHECK (
    octet_length(sid_sha256) = 32
    AND person_ref ~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$'
    AND (user_agent IS NULL OR char_length(user_agent) BETWEEN 1 AND 256)
    AND (ip_address IS NULL OR char_length(ip_address) BETWEEN 1 AND 64)
    AND expires_at > started_at
  )
);
CREATE INDEX IF NOT EXISTS slotlock_dashboard_sessions_person_idx
  ON slotlock.dashboard_sessions (person_ref, last_seen_at DESC);
ALTER TABLE slotlock.dashboard_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.dashboard_sessions FROM PUBLIC;

-- A session begun: recorded, and the person's expired ones dropped; at most 50 kept, newest first.
CREATE OR REPLACE FUNCTION slotlock.dashboard_session_started(
  requested_person text, requested_sid bytea, requested_expires timestamptz, requested_agent text,
  requested_address text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_dashboard_session_started$
BEGIN
  INSERT INTO slotlock.dashboard_sessions (sid_sha256, person_ref, expires_at, user_agent, ip_address)
  VALUES (requested_sid, requested_person, requested_expires,
          NULLIF(left(requested_agent, 256), ''), NULLIF(left(requested_address, 64), ''))
  ON CONFLICT ON CONSTRAINT dashboard_sessions_pkey DO NOTHING;
  DELETE FROM slotlock.dashboard_sessions old
   WHERE old.person_ref = requested_person
     AND (old.expires_at <= statement_timestamp()
          OR old.sid_sha256 IN (SELECT kept.sid_sha256 FROM slotlock.dashboard_sessions kept
                                 WHERE kept.person_ref = requested_person
                                 ORDER BY kept.started_at DESC OFFSET 50));
END
$slotlock_dashboard_session_started$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[25]} FROM PUBLIC;

-- Whether the person's session may go on (not signed out from another device), noting it seen at
-- most every five minutes. A session from before these records has none, and goes on.
CREATE OR REPLACE FUNCTION slotlock.dashboard_session_seen(requested_person text, requested_sid bytea)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_dashboard_session_seen$
BEGIN
  UPDATE slotlock.dashboard_sessions seen SET last_seen_at = statement_timestamp()
   WHERE seen.sid_sha256 = requested_sid AND seen.person_ref = requested_person AND seen.ended_at IS NULL
     AND seen.last_seen_at < statement_timestamp() - interval '5 minutes';
  RETURN NOT EXISTS (
    SELECT 1 FROM slotlock.dashboard_sessions ended
     WHERE ended.sid_sha256 = requested_sid
       AND (ended.ended_at IS NOT NULL OR ended.person_ref <> requested_person));
END
$slotlock_dashboard_session_seen$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[26]} FROM PUBLIC;

-- The person's sessions still going, most recently seen first.
CREATE OR REPLACE FUNCTION slotlock.dashboard_sessions_of(requested_person text)
RETURNS TABLE (sid_sha256 bytea, started_at timestamptz, last_seen_at timestamptz, expires_at timestamptz,
               user_agent text, ip_address text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_dashboard_sessions_of$
BEGIN
  RETURN QUERY SELECT kept.sid_sha256, kept.started_at, kept.last_seen_at, kept.expires_at, kept.user_agent,
                      kept.ip_address
    FROM slotlock.dashboard_sessions kept
   WHERE kept.person_ref = requested_person AND kept.ended_at IS NULL
     AND kept.expires_at > statement_timestamp()
   ORDER BY kept.last_seen_at DESC
   LIMIT 50;
END
$slotlock_dashboard_sessions_of$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[27]} FROM PUBLIC;

-- Sign one of the person's sessions out (or, with no session, all of them): whether any was.
CREATE OR REPLACE FUNCTION slotlock.dashboard_session_end(requested_person text, requested_sid bytea)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_dashboard_session_end$
DECLARE
  changed integer;
BEGIN
  UPDATE slotlock.dashboard_sessions ending SET ended_at = statement_timestamp()
   WHERE ending.person_ref = requested_person AND ending.ended_at IS NULL
     AND (requested_sid IS NULL OR ending.sid_sha256 = requested_sid);
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed > 0;
END
$slotlock_dashboard_session_end$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[28]} FROM PUBLIC;

-- Sessions that ended or expired more than a day ago: deleted.
CREATE OR REPLACE FUNCTION slotlock.prune_dashboard_sessions()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_prune_dashboard_sessions$
DECLARE
  pruned integer;
BEGIN
  DELETE FROM slotlock.dashboard_sessions old
   WHERE least(coalesce(old.ended_at, 'infinity'), old.expires_at) < statement_timestamp() - interval '1 day';
  GET DIAGNOSTICS pruned = ROW_COUNT;
  RETURN pruned;
END
$slotlock_prune_dashboard_sessions$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[29]} FROM PUBLIC;
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
  -- Its own suspension, its live tenant's (a test environment, RFC 0003 G9), or its partner's (a
  -- partner's account, RFC 0003 P2).
  SELECT EXISTS (
    SELECT 1 FROM slotlock.tenant_suspensions suspended
     WHERE suspended.tenant_ref IN (requested_tenant_ref, regexp_replace(requested_tenant_ref, '~test$', ''))
  ) OR slotlock.partner_tenant_blocked(requested_tenant_ref);
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
  CONSTRAINT slotlock_tenant_plans_plan_valid CHECK (plan IN ('free', 'developer', 'team')),
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
-- A partner's account (RFC 0003 P4) is on one of its contract's plans: its own name and numbers,
-- quotas included, set by put_partner_account. Every other row is a plan Pylota sells.
ALTER TABLE slotlock.tenant_plans
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'direct',
  ADD COLUMN IF NOT EXISTS partner_id text,
  ADD COLUMN IF NOT EXISTS quota_operations bigint,
  ADD COLUMN IF NOT EXISTS quota_bookings bigint,
  ADD COLUMN IF NOT EXISTS quota_stop_percent integer;
DO $slotlock_tenant_plans_source$
BEGIN
  -- Replaced too when it predates the Team plan (Teams on Cloud), whose name it must take.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.tenant_plans'::regclass AND conname = 'slotlock_tenant_plans_source_valid'
       AND pg_catalog.pg_get_constraintdef(oid) LIKE '%team%'
  ) THEN
    ALTER TABLE slotlock.tenant_plans DROP CONSTRAINT IF EXISTS slotlock_tenant_plans_source_valid;
    -- Wider than the plan check it replaces, so added NOT VALID (DEPLOYMENT_VALIDATE_CONSTRAINTS).
    ALTER TABLE slotlock.tenant_plans DROP CONSTRAINT IF EXISTS slotlock_tenant_plans_plan_valid;
    ALTER TABLE slotlock.tenant_plans ADD CONSTRAINT slotlock_tenant_plans_source_valid CHECK (
      (source = 'direct' AND partner_id IS NULL AND plan IN ('free', 'developer', 'team')
       AND quota_operations IS NULL AND quota_bookings IS NULL AND quota_stop_percent IS NULL)
      OR (source = 'partner' AND partner_id ~ '^[a-z][a-z0-9-]{1,39}$' AND plan ~ '^[a-z][a-z0-9_]{0,40}$'
          AND quota_operations BETWEEN 1 AND 1000000000000 AND quota_bookings BETWEEN 1 AND 1000000000000
          AND quota_stop_percent BETWEEN 100 AND 1000)
    ) NOT VALID;
  END IF;
END
$slotlock_tenant_plans_source$;
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
  -- A test environment (<tenant>~test, RFC 0003 G9) is on its live tenant's plan, with no billing.
  WITH live AS (
    SELECT regexp_replace(requested_tenant_ref, '~test$', '') AS tenant_ref,
           requested_tenant_ref ~ '~test$' AS test
  )
  SELECT current.plan, current.status, current.max_resources, current.max_api_keys,
         current.max_webhook_endpoints,
         CASE WHEN live.test THEN NULL ELSE current.stripe_customer END,
         CASE WHEN live.test THEN NULL ELSE current.stripe_subscription END,
         CASE WHEN live.test THEN NULL ELSE current.current_period_end END
    FROM live JOIN slotlock.tenant_plans current ON current.tenant_ref = live.tenant_ref
  UNION ALL
  SELECT fallback.plan, 'active', fallback.max_resources, fallback.max_api_keys,
         fallback.max_webhook_endpoints, NULL, NULL, NULL
    FROM live, slotlock.plan_defaults fallback
   WHERE fallback.applies_from <= statement_timestamp()
     AND NOT EXISTS (SELECT 1 FROM slotlock.tenant_plans current
                      WHERE current.tenant_ref = live.tenant_ref);
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

-- The tenant's plan and its own quotas, when it has them (a partner's account, RFC 0003 P4): null
-- quotas are the plan's (plans.ts SLOTLOCK_PLAN_QUOTAS).
CREATE OR REPLACE FUNCTION slotlock.tenant_plan_quotas(requested_tenant_ref text)
RETURNS TABLE (plan text, operations bigint, bookings bigint, stop_percent integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_tenant_plan_quotas$
  SELECT given.plan, own.quota_operations, own.quota_bookings, own.quota_stop_percent
    FROM slotlock.tenant_plan(requested_tenant_ref) given
    LEFT JOIN slotlock.tenant_plans own
           ON own.tenant_ref = regexp_replace(requested_tenant_ref, '~test$', '');
$slotlock_tenant_plan_quotas$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[19]} FROM PUBLIC;
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
  -- A test environment's plan is its live tenant's (RFC 0003 G9): that is the one enrolled.
  requested_tenant_ref := regexp_replace(requested_tenant_ref, '~test$', '');
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

-- Metered overage (off unless SLOTLOCK_OVERAGE=on, overage.ts): how many operations above its
-- quota each tenant's month has been reported to Stripe as, so each is reported once however often
-- the report runs. Owner-only: \`slotlock overage report\` runs as the schema owner.
CREATE TABLE IF NOT EXISTS slotlock.overage_reports (
  tenant_ref text NOT NULL,
  month date NOT NULL,
  reported bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_overage_reports_pkey PRIMARY KEY (tenant_ref, month),
  CONSTRAINT slotlock_overage_reports_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500 AND extract(day FROM month) = 1 AND reported >= 0
  )
);
ALTER TABLE slotlock.overage_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.overage_reports FROM PUBLIC;

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
  tested record;
  cleared_rows bigint;
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
  -- Erasing a person never takes other people's workspace with it: a team's only Owner hands it
  -- on, or deletes it, first. The teams they own are locked first, as every change to a team's
  -- people locks it, so an Owner leaving meanwhile waits, and this check sees what it left.
  PERFORM 1 FROM slotlock.workspaces ws
   WHERE ws.tenant_ref IN (SELECT mine.tenant_ref FROM slotlock.workspace_memberships mine
                            WHERE mine.person_ref = requested_tenant_ref AND mine.status = 'active'
                              AND mine.role = 'owner')
   ORDER BY ws.tenant_ref
   FOR UPDATE;
  IF requested_tenant_ref ~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$' AND EXISTS (
    SELECT 1 FROM slotlock.workspace_memberships mine
      JOIN slotlock.workspaces ws ON ws.tenant_ref = mine.tenant_ref AND ws.status = 'active'
     WHERE mine.person_ref = requested_tenant_ref AND mine.status = 'active' AND mine.role = 'owner'
       AND NOT EXISTS (SELECT 1 FROM slotlock.workspace_memberships other
                        WHERE other.tenant_ref = mine.tenant_ref AND other.status = 'active'
                          AND other.role = 'owner' AND other.person_ref <> mine.person_ref)
  ) THEN
    RAISE EXCEPTION 'Slotlock person is the only owner of a team workspace: make another owner, or delete it, first'
      USING ERRCODE = 'object_in_use', HINT = 'sole_owner';
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
  erased_table := 'composite_claims';
  DELETE FROM slotlock.composite_claims WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'approvals';
  DELETE FROM slotlock.approvals WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'approval_policies';
  DELETE FROM slotlock.approval_policies WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'availability_exceptions';
  DELETE FROM slotlock.availability_exceptions WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'holiday_calendars';
  DELETE FROM slotlock.holiday_calendars WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'availability_defaults';
  DELETE FROM slotlock.availability_defaults WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'contacts';
  DELETE FROM slotlock.contacts WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'reminder_dispatches';
  DELETE FROM slotlock.reminder_dispatches WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'reservation_reminder_dispatches';
  DELETE FROM slotlock.reservation_reminder_dispatches WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'hold_payments';
  DELETE FROM slotlock.hold_payments WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'source_busy';
  DELETE FROM slotlock.source_busy WHERE tenant_ref = requested_tenant_ref;
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
  -- A partner's account: what it used in months its partner has not closed is kept for billing
  -- first (by the partner's account reference only), then its partner's record of it goes too.
  INSERT INTO slotlock.partner_erased_usage AS kept (partner_id, account, plan, month, metric, count)
  SELECT owned.partner_id, owned.account, owned.plan, monthly.month, monthly.metric, monthly.count
    FROM slotlock.partner_accounts owned
    JOIN (
      SELECT daily.month, daily.metric,
             CASE WHEN daily.metric = 'resources' THEN max(daily.count) ELSE sum(daily.count) END::bigint AS count
        FROM (
          SELECT date_trunc('month', used.day)::date AS month, used.day, used.metric, sum(used.count) AS count
            FROM slotlock.usage_daily used
           WHERE used.tenant_ref = requested_tenant_ref
             AND used.day >= (date_trunc('month', statement_timestamp()) - interval '1 month')::date
           GROUP BY 1, used.day, used.metric
        ) daily
       GROUP BY daily.month, daily.metric
    ) monthly ON true
   WHERE owned.tenant_ref = requested_tenant_ref
     AND NOT EXISTS (SELECT 1 FROM slotlock.partner_month_closes closed
                      WHERE closed.partner_id = owned.partner_id AND closed.month = monthly.month)
  ON CONFLICT (partner_id, account, month, metric) DO UPDATE
    SET count = CASE WHEN kept.metric = 'resources' THEN GREATEST(kept.count, EXCLUDED.count)
                     ELSE kept.count + EXCLUDED.count END,
        plan = EXCLUDED.plan, erased_at = statement_timestamp();
  erased_table := 'partner_accounts';
  DELETE FROM slotlock.partner_accounts WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'assistant_conversations';
  DELETE FROM slotlock.assistant_conversations WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'assistant_chats';
  DELETE FROM slotlock.assistant_chats WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'audit_events';
  DELETE FROM slotlock.audit_events WHERE tenant_ref = requested_tenant_ref;
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
  erased_table := 'overage_reports';
  DELETE FROM slotlock.overage_reports WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  -- Before the keys, so their count is reported (the key's deletion would take them too).
  erased_table := 'api_key_limits';
  DELETE FROM slotlock.api_key_limits WHERE tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'api_key_resource_scopes';
  DELETE FROM slotlock.api_key_resource_scopes WHERE tenant_ref = requested_tenant_ref;
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
  -- A team workspace's record and invitations go with it.
  erased_table := 'workspace_invitations';
  DELETE FROM slotlock.workspace_invitations invitation
   WHERE invitation.tenant_ref = requested_tenant_ref
      OR (requested_tenant_ref ~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$'
          AND (invitation.inviter_ref = requested_tenant_ref OR invitation.accepted_by = requested_tenant_ref));
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'workspaces';
  DELETE FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  IF requested_tenant_ref ~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$' THEN
    UPDATE slotlock.workspaces ws SET created_by = NULL WHERE ws.created_by = requested_tenant_ref;
    GET DIAGNOSTICS cleared_rows = ROW_COUNT;
    erased_rows := erased_rows + cleared_rows;
  END IF;
  RETURN NEXT;
  -- A shared workspace's members go with it; a person's own tenant takes their memberships of
  -- every workspace, and their record of signing in, with it.
  erased_table := 'workspace_memberships';
  DELETE FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant_ref
      OR (requested_tenant_ref ~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$'
          AND member.person_ref = requested_tenant_ref);
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'dashboard_sessions';
  DELETE FROM slotlock.dashboard_sessions session_kept WHERE session_kept.person_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'dashboard_people';
  DELETE FROM slotlock.dashboard_people person WHERE person.person_ref = requested_tenant_ref;
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  -- An organization's record of being turned on goes with its tenant (Teams on Cloud).
  erased_table := 'dashboard_organizations';
  DELETE FROM slotlock.dashboard_organizations org
   WHERE requested_tenant_ref ~ '^github-org:[1-9][0-9]{0,19}$'
     AND org.org_id = substr(requested_tenant_ref, 12);
  GET DIAGNOSTICS erased_rows = ROW_COUNT;
  RETURN NEXT;
  erased_table := 'dashboard_tokens';
  erased_rows := 0;
  IF requested_tenant_ref LIKE 'github:%' THEN
    DELETE FROM slotlock.dashboard_tokens
     WHERE kind = 'form'
       AND owner_hash = sha256(convert_to(
             'slotlock-dashboard-owner.' || substr(requested_tenant_ref, 8), 'UTF8'));
    GET DIAGNOSTICS erased_rows = ROW_COUNT;
  ELSIF requested_tenant_ref LIKE 'google:%' THEN
    -- A Google person's form records are under their whole reference (dashboard.ts).
    DELETE FROM slotlock.dashboard_tokens
     WHERE kind = 'form'
       AND owner_hash = sha256(convert_to('slotlock-dashboard-owner.' || requested_tenant_ref, 'UTF8'));
    GET DIAGNOSTICS erased_rows = ROW_COUNT;
  END IF;
  RETURN NEXT;

  -- A live tenant goes with its test environment (RFC 0003 G9), reported as test.<table>.
  IF requested_tenant_ref !~ '~test$' AND octet_length(requested_tenant_ref) <= 495 THEN
    FOR tested IN
      SELECT inner_erased.erased_table AS name, inner_erased.erased_rows AS count
        FROM slotlock.erase_tenant(requested_tenant_ref || '~test') inner_erased
    LOOP
      IF tested.count > 0 THEN
        erased_table := 'test.' || tested.name;
        erased_rows := tested.count;
        RETURN NEXT;
      END IF;
    END LOOP;
  END IF;

  FOR setting IN SELECT jsonb_object_keys(previous) LOOP
    PERFORM set_config(setting, coalesce(previous ->> setting, ''), true);
  END LOOP;
END
$slotlock_erase_tenant$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_TENANT_ADMIN_FUNCTIONS[1]} FROM PUBLIC;

-- Empty a test environment (RFC 0004 A6 sandbox reset): its resources, locations and groups, every
-- booking, event, hold and waitlist entry, its approval policies, booking rule defaults and pool
-- settings, and its feed, as if it were new. What sets it up is kept: its API keys (and their
-- scopes and limits), webhook endpoints, plan, usage and assistant. Only a test environment
-- (a tenant ending ~test, api-keys.ts), and only the one the caller acts in (its tenant context), so
-- a server resets nothing it was not asked to; a live tenant is never touched.
CREATE OR REPLACE FUNCTION slotlock.reset_test_tenant(requested_tenant_ref text)
RETURNS TABLE (reset_table text, reset_rows bigint)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_reset_test_tenant$
DECLARE
  emptied text;
  gone bigint;
BEGIN
  IF requested_tenant_ref IS NULL OR octet_length(requested_tenant_ref) NOT BETWEEN 1 AND 500
     OR right(requested_tenant_ref, 5) <> '~test' THEN
    RAISE EXCEPTION 'Slotlock resets only a test environment (a tenant ending ~test)'
      USING ERRCODE = 'insufficient_privilege', HINT = 'sandbox_test_only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM slotlock.rls_policy_contracts contract
                  WHERE current_setting(contract.tenant_context_setting, true) = requested_tenant_ref) THEN
    RAISE EXCEPTION 'Slotlock resets only the tenant the caller acts in'
      USING ERRCODE = 'insufficient_privilege', HINT = 'sandbox_test_only';
  END IF;
  -- Waits for the tenant's transactions under way, as erasure does.
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:tenant:' || requested_tenant_ref, 0));
  -- Nothing reset is a change anyone is told of: the feed goes with what it described.
  PERFORM set_config('slotlock.erasing', requested_tenant_ref, true);
  reset_table := 'reservations';
  DELETE FROM slotlock.reservations
   WHERE tenant_ref = requested_tenant_ref
      OR resource_id IN (SELECT owned.id FROM slotlock.resources owned
                          WHERE owned.tenant_ref = requested_tenant_ref);
  GET DIAGNOSTICS reset_rows = ROW_COUNT;
  RETURN NEXT;
  FOREACH emptied IN ARRAY ARRAY[
    'calendar_event_attendees', 'calendar_event_reminders', 'calendar_event_exceptions',
    'calendar_event_occurrences', 'composite_claims', 'approvals', 'approval_policies',
    'availability_exceptions', 'holiday_calendars', 'availability_defaults', 'contacts', 'reminder_dispatches',
    'reservation_reminder_dispatches',
    'hold_payments', 'source_busy', 'calendar_events', 'calendar_event_tombstones', 'calendar_event_commands',
    'reservation_tombstones', 'reservation_conflict_archive', 'calendar_coverage', 'hold_commands',
    'waitlist_entries', 'booking_rule_defaults', 'pool_settings', 'resource_group_members',
    'resources', 'resource_groups', 'outbox'
  ] LOOP
    reset_table := emptied;
    EXECUTE format('DELETE FROM slotlock.%I WHERE tenant_ref = $1', emptied) USING requested_tenant_ref;
    GET DIAGNOSTICS reset_rows = ROW_COUNT;
    RETURN NEXT;
  END LOOP;
  -- Locations last: one may be inside another, so the innermost go first.
  reset_table := 'locations';
  reset_rows := 0;
  LOOP
    DELETE FROM slotlock.locations place
     WHERE place.tenant_ref = requested_tenant_ref
       AND NOT EXISTS (SELECT 1 FROM slotlock.locations inner_place
                        WHERE inner_place.tenant_ref = requested_tenant_ref
                          AND inner_place.parent_ref = place.ref);
    GET DIAGNOSTICS gone = ROW_COUNT;
    EXIT WHEN gone = 0;
    reset_rows := reset_rows + gone;
  END LOOP;
  RETURN NEXT;
  PERFORM set_config('slotlock.erasing', '', true);
END
$slotlock_reset_test_tenant$;
REVOKE ALL ON FUNCTION slotlock.reset_test_tenant(text) FROM PUBLIC;

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
    DELETE FROM slotlock.assistant_chats gone
     WHERE gone.tenant_ref = due.tenant_ref
       AND (gone.member_ref, gone.chat_id) IN (
         SELECT expired.member_ref, expired.chat_id FROM slotlock.assistant_chats expired
          WHERE expired.tenant_ref = due.tenant_ref AND expired.expires_at <= now()
          LIMIT greatest(max_rows - deleted, 0))
       AND gone.expires_at <= now();
    GET DIAGNOSTICS step = ROW_COUNT;
    deleted := deleted + step;
    SELECT least(
             (SELECT min(live.expires_at) FROM slotlock.assistant_conversations live
               WHERE live.tenant_ref = due.tenant_ref),
             (SELECT min(chat.expires_at) FROM slotlock.assistant_chats chat
               WHERE chat.tenant_ref = due.tenant_ref AND chat.expires_at IS NOT NULL))
      INTO upcoming;
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
-- A create's retry identity (RFC 0004 P0-5), kept as long as the endpoint: the same key and
-- request answer the endpoint (and its secret) the first made, another is idempotency_conflict.
ALTER TABLE slotlock.webhook_endpoints ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE slotlock.webhook_endpoints ADD COLUMN IF NOT EXISTS payload_hash text;
DO $slotlock_webhook_key$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slotlock_webhook_endpoints_key_valid'
                    AND conrelid = 'slotlock.webhook_endpoints'::regclass) THEN
    ALTER TABLE slotlock.webhook_endpoints ADD CONSTRAINT slotlock_webhook_endpoints_key_valid CHECK (
      (idempotency_key IS NULL AND payload_hash IS NULL)
      OR (octet_length(idempotency_key) BETWEEN 1 AND 500 AND payload_hash ~ '^[0-9a-f]{64}$')
    ) NOT VALID;
  END IF;
END
$slotlock_webhook_key$;
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_webhook_endpoints_key_idx
  ON slotlock.webhook_endpoints (tenant_ref, idempotency_key) WHERE idempotency_key IS NOT NULL;
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
  SELECT COALESCE(array_agg(up.ref ORDER BY up.steps), '{}'::text[]) FROM up;
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
-- A join's retry identity (RFC 0004 P0-5), kept as long as the entry: the same key and request
-- answer the entry the first made, another request is idempotency_conflict.
ALTER TABLE slotlock.waitlist_entries ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE slotlock.waitlist_entries ADD COLUMN IF NOT EXISTS payload_hash text;
DO $slotlock_waitlist_key$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slotlock_waitlist_entries_key_valid'
                    AND conrelid = 'slotlock.waitlist_entries'::regclass) THEN
    ALTER TABLE slotlock.waitlist_entries ADD CONSTRAINT slotlock_waitlist_entries_key_valid CHECK (
      (idempotency_key IS NULL AND payload_hash IS NULL)
      OR (octet_length(idempotency_key) BETWEEN 1 AND 500 AND payload_hash ~ '^[0-9a-f]{64}$')
    ) NOT VALID;
  END IF;
END
$slotlock_waitlist_key$;
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_waitlist_entries_key_idx
  ON slotlock.waitlist_entries (tenant_ref, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Waitlists that match (RFC 0004 B6): an entry may ask for any slot of a length within its window
-- (duration_ms; NULL is the whole window), and an offer ends accepted (its hold confirmed), declined
-- (let go) or lapsed (expired), when it was decided. The wider checks admit every row the old ones
-- did, so they are added NOT VALID (no scan under the lock), and the old ones dropped.
ALTER TABLE slotlock.waitlist_entries ADD COLUMN IF NOT EXISTS duration_ms bigint;
ALTER TABLE slotlock.waitlist_entries ADD COLUMN IF NOT EXISTS decided_at timestamptz;
DO $slotlock_waitlist_outcomes$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slotlock_waitlist_entries_outcome_valid'
                    AND conrelid = 'slotlock.waitlist_entries'::regclass) THEN
    ALTER TABLE slotlock.waitlist_entries ADD CONSTRAINT slotlock_waitlist_entries_outcome_valid CHECK (
      status IN ('waiting', 'offered', 'accepted', 'declined', 'lapsed', 'expired')
      AND (status <> 'offered' OR (hold_id IS NOT NULL AND offered_at IS NOT NULL AND offered_resource_id IS NOT NULL))
      AND (status <> 'waiting' OR (hold_id IS NULL AND offered_at IS NULL))
      AND (duration_ms IS NULL OR (duration_ms >= 60000
                                   AND duration_ms <= extract(epoch FROM ends_at - starts_at) * 1000))
    ) NOT VALID;
  END IF;
  ALTER TABLE slotlock.waitlist_entries DROP CONSTRAINT IF EXISTS slotlock_waitlist_entries_status_valid;
  ALTER TABLE slotlock.waitlist_entries DROP CONSTRAINT IF EXISTS slotlock_waitlist_entries_offer_valid;
END
$slotlock_waitlist_outcomes$;

-- How an offer ends (RFC 0004 B6), from what becomes of its hold, whatever path took it: confirmed
-- (or consumed by a booking that names it, under slotlock.ending = 'confirmed') is accepted;
-- expired is lapsed; let go before then is declined. The entry says so, and the feed.
CREATE OR REPLACE FUNCTION slotlock.waitlist_offer_settle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_waitlist_offer_settle$
DECLARE
  outcome text;
  settled slotlock.waitlist_entries%ROWTYPE;
BEGIN
  IF OLD.status <> 'held' OR OLD.source IS DISTINCT FROM 'slotlock:waitlist' THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status = 'held' THEN RETURN NULL; END IF;
    outcome := 'accepted';
  ELSIF current_setting('slotlock.ending', true) = 'confirmed' THEN
    outcome := 'accepted';
  ELSIF OLD.expires_at <= statement_timestamp() THEN
    outcome := 'lapsed';
  ELSE
    outcome := 'declined';
  END IF;
  UPDATE slotlock.waitlist_entries SET status = outcome, decided_at = statement_timestamp()
   WHERE hold_id = OLD.id AND status = 'offered'
  RETURNING * INTO settled;
  IF settled.id IS NULL THEN RETURN NULL; END IF;
  -- Erasure (erase_tenant, running as the schema's owner) is not reported.
  IF settled.tenant_ref = current_setting('slotlock.erasing', true)
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace
                          WHERE nspname = 'slotlock') THEN
    RETURN NULL;
  END IF;
  INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
  VALUES (
    settled.tenant_ref, settled.offered_resource_id, 'waitlist.' || outcome, settled.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'id', settled.id, 'hold_id', settled.hold_id, 'resource_id', settled.offered_resource_id,
      'pool', settled.pool_ref, 'holder_ref', settled.holder_ref)),
    COALESCE(NULLIF(current_setting('slotlock.actor', true), ''),
             CASE WHEN outcome = 'lapsed' THEN 'slotlock:maintenance' END)
  );
  RETURN NULL;
END
$slotlock_waitlist_offer_settle$;
DROP TRIGGER IF EXISTS slotlock_waitlist_offer_settle ON slotlock.reservations;
CREATE TRIGGER slotlock_waitlist_offer_settle
  AFTER UPDATE OF status OR DELETE ON slotlock.reservations
  FOR EACH ROW EXECUTE FUNCTION slotlock.waitlist_offer_settle();
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

-- At most SLOTLOCK_MAX_POOL_SETTINGS pools a tenant set an order for, under the tenant's lock.
CREATE OR REPLACE FUNCTION slotlock.pool_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_pool_settings_guard$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:pool-settings:' || NEW.tenant_ref, 0));
  -- An upsert of a pool the tenant has set fires this before its conflict is found.
  IF NOT EXISTS (SELECT 1 FROM slotlock.pool_settings kept
                  WHERE kept.tenant_ref = NEW.tenant_ref AND kept.pool_ref = NEW.pool_ref)
     AND (SELECT count(*) FROM slotlock.pool_settings kept WHERE kept.tenant_ref = NEW.tenant_ref)
         >= ${SLOTLOCK_MAX_POOL_SETTINGS} THEN
    RAISE EXCEPTION 'Slotlock keeps an order for at most ${SLOTLOCK_MAX_POOL_SETTINGS} pools a tenant'
      USING ERRCODE = 'check_violation', HINT = 'pool_order_limit_reached';
  END IF;
  RETURN NEW;
END
$slotlock_pool_settings_guard$;
CREATE OR REPLACE TRIGGER slotlock_pool_settings_guard
  BEFORE INSERT ON slotlock.pool_settings
  FOR EACH ROW EXECUTE FUNCTION slotlock.pool_settings_guard();

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

-- A member's conversations with the dashboard assistant (its history), each with the writes it
-- proposed. Kept until the member deletes one, or until expires_at where the deployment gives
-- conversations a lifetime; at most ${SLOTLOCK_ASSISTANT_MAX_CHATS} a member, the least recent going first.
CREATE TABLE IF NOT EXISTS slotlock.assistant_chats (
  tenant_ref text NOT NULL,
  member_ref text NOT NULL,
  chat_id text NOT NULL,
  title text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz,
  CONSTRAINT slotlock_assistant_chats_pkey PRIMARY KEY (tenant_ref, member_ref, chat_id),
  CONSTRAINT slotlock_assistant_chats_identity_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500 AND octet_length(member_ref) BETWEEN 1 AND 500
    AND chat_id ~ '^[A-Za-z0-9_-]{16}$'
  ),
  CONSTRAINT slotlock_assistant_chats_title_valid CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT slotlock_assistant_chats_messages_valid CHECK (
    jsonb_typeof(messages) = 'array' AND octet_length(messages::text) <= 262144
  ),
  CONSTRAINT slotlock_assistant_chats_actions_valid CHECK (
    jsonb_typeof(actions) = 'object' AND octet_length(actions::text) <= 131072
  )
);
CREATE INDEX IF NOT EXISTS slotlock_assistant_chats_recent_idx
  ON slotlock.assistant_chats (tenant_ref, member_ref, updated_at DESC);
CREATE INDEX IF NOT EXISTS slotlock_assistant_chats_expiry_idx
  ON slotlock.assistant_chats (tenant_ref, expires_at) WHERE expires_at IS NOT NULL;

-- The one conversation a member had before chats were kept (0.8 and earlier) becomes their first
-- chat, titled by its first message, and leaves the old table: a later migration does not bring
-- back a chat the member deleted. A server of 0.8 still running meanwhile keeps using the old table;
-- what it writes there is moved by the next migration as a chat of its own (its id is the
-- conversation's, with when it was last written), never into one already moved.
WITH moved AS (
  DELETE FROM slotlock.assistant_conversations old
   WHERE old.expires_at > statement_timestamp()
  RETURNING old.tenant_ref, old.member_ref, old.messages, old.actions, old.updated_at
)
INSERT INTO slotlock.assistant_chats AS chat
  (tenant_ref, member_ref, chat_id, title, messages, actions, created_at, updated_at, expires_at)
SELECT moved.tenant_ref, moved.member_ref,
       pg_catalog.translate(pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
         moved.tenant_ref || pg_catalog.chr(10) || moved.member_ref || pg_catalog.chr(10)
           || (extract(epoch FROM moved.updated_at) * 1000000)::bigint::text, 'UTF8')), 'base64'), 16), '+/', '-_'),
       coalesce(nullif(pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.btrim(first_user.text), '\\s+', ' ', 'g'), 80), ''),
                'Conversation'),
       moved.messages, moved.actions, moved.updated_at, moved.updated_at, NULL
  FROM moved
  LEFT JOIN LATERAL (
    SELECT entry ->> 'text' AS text FROM pg_catalog.jsonb_array_elements(moved.messages) AS entry
     WHERE entry ->> 'role' = 'user' LIMIT 1
  ) first_user ON true
ON CONFLICT DO NOTHING;

-- A workspace's audit log: who did what to its people, keys, webhooks, billing and settings, from
-- where, and whether it was refused. Not the change feed: that keeps 30 days and goes to the
-- tenant's webhooks; this keeps SLOTLOCK_AUDIT_RETENTION_DAYS (180) and goes nowhere. The serving
-- role may only add and read rows (no UPDATE, DELETE or TRUNCATE): an event once written stays as
-- it was until slotlock.prune_audit_events, or erasure, takes it. Names are never stored, only
-- references (github:<id>, api_key:<id>), resolved when the log is read.
CREATE TABLE IF NOT EXISTS slotlock.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  action text NOT NULL,
  actor_type text NOT NULL,
  actor_ref text NOT NULL,
  actor_role text,
  target_type text,
  target_ref text,
  outcome text NOT NULL DEFAULT 'success',
  reason text,
  ip_address text,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT slotlock_audit_events_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND action ~ '^[a-z][a-z_]{0,31}(\\.[a-z][a-z_]{0,31}){1,2}$'
    AND actor_type IN ('person', 'api_key', 'assistant', 'system')
    AND octet_length(actor_ref) BETWEEN 1 AND 500
    AND (actor_role IS NULL OR actor_role IN ('owner', 'admin', 'developer', 'member', 'viewer', 'billing'))
    AND (target_type IS NULL OR target_type ~ '^[a-z][a-z_]{0,31}$')
    AND (target_ref IS NULL OR octet_length(target_ref) BETWEEN 1 AND 500)
    AND outcome IN ('success', 'denied')
    AND (reason IS NULL OR octet_length(reason) BETWEEN 1 AND 200)
    AND (ip_address IS NULL OR octet_length(ip_address) BETWEEN 1 AND 64)
    AND (user_agent IS NULL OR octet_length(user_agent) BETWEEN 1 AND 256)
    AND jsonb_typeof(metadata) = 'object'
    AND pg_column_size(metadata) <= 4096
  )
);
CREATE INDEX IF NOT EXISTS slotlock_audit_events_recent_idx
  ON slotlock.audit_events (tenant_ref, occurred_at DESC, id);

-- Each tenant's events form a chain: each holds the SHA-256 of the one before it with its own
-- content, numbered in the order they were written. Rewriting, removing or reordering an event
-- (which the serving role cannot do, but an owner of the database could) breaks every hash after
-- it, and slotlock.verify_audit_chain says where. Events from before the chain have none.
ALTER TABLE slotlock.audit_events ADD COLUMN IF NOT EXISTS chain_index bigint;
ALTER TABLE slotlock.audit_events ADD COLUMN IF NOT EXISTS prev_hash bytea;
ALTER TABLE slotlock.audit_events ADD COLUMN IF NOT EXISTS hash bytea;
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_audit_events_chain_idx
  ON slotlock.audit_events (tenant_ref, chain_index);

-- An event as its hash covers it: every field, in a fixed order, separated by the unit separator.
CREATE OR REPLACE FUNCTION slotlock.audit_event_text(event slotlock.audit_events)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_audit_event_text$
  SELECT concat_ws(chr(31), event.tenant_ref, event.chain_index::text, event.id::text,
                   (extract(epoch FROM event.occurred_at) * 1000000)::bigint::text, event.action,
                   event.actor_type, event.actor_ref, coalesce(event.actor_role, ''),
                   coalesce(event.target_type, ''), coalesce(event.target_ref, ''), event.outcome,
                   coalesce(event.reason, ''), coalesce(event.ip_address, ''),
                   coalesce(event.user_agent, ''), event.metadata::text);
$slotlock_audit_event_text$;

-- Before each insert: the tenant's chain one writer at a time, the event numbered after the last
-- and hashed with it.
CREATE OR REPLACE FUNCTION slotlock.chain_audit_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_chain_audit_event$
DECLARE
  last_index bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:audit-chain:' || NEW.tenant_ref, 0));
  SELECT kept.chain_index, kept.hash INTO last_index, last_hash FROM slotlock.audit_events kept
   WHERE kept.tenant_ref = NEW.tenant_ref AND kept.chain_index IS NOT NULL
   ORDER BY kept.chain_index DESC LIMIT 1;
  NEW.chain_index := coalesce(last_index, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := sha256(coalesce(last_hash, ''::bytea) || convert_to(slotlock.audit_event_text(NEW), 'UTF8'));
  RETURN NEW;
END
$slotlock_chain_audit_event$;
DROP TRIGGER IF EXISTS slotlock_audit_events_chain ON slotlock.audit_events;
CREATE TRIGGER slotlock_audit_events_chain BEFORE INSERT ON slotlock.audit_events
  FOR EACH ROW EXECUTE FUNCTION slotlock.chain_audit_event();

-- Whether a tenant's chain holds, from its oldest event kept: how many events it checked, and the
-- first whose number, link or hash is wrong (null when none is). Run as the serving role, under
-- the tenant's own row security.
CREATE OR REPLACE FUNCTION slotlock.verify_audit_chain(requested_tenant text)
RETURNS TABLE (checked bigint, broken_at bigint)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_verify_audit_chain$
DECLARE
  event slotlock.audit_events;
  expected_index bigint;
  expected_prev bytea;
  seen bigint := 0;
BEGIN
  FOR event IN
    SELECT * FROM slotlock.audit_events kept
     WHERE kept.tenant_ref = requested_tenant AND kept.chain_index IS NOT NULL
     ORDER BY kept.chain_index
  LOOP
    IF (seen > 0 AND (event.chain_index <> expected_index OR event.prev_hash IS DISTINCT FROM expected_prev))
       OR event.hash IS DISTINCT FROM
          sha256(coalesce(event.prev_hash, ''::bytea) || convert_to(slotlock.audit_event_text(event), 'UTF8')) THEN
      RETURN QUERY SELECT seen, event.chain_index;
      RETURN;
    END IF;
    seen := seen + 1;
    expected_index := event.chain_index + 1;
    expected_prev := event.hash;
  END LOOP;
  RETURN QUERY SELECT seen, NULL::bigint;
END
$slotlock_verify_audit_chain$;

-- A tenant's events past retention. The serving role cannot delete audit events itself: this is
-- the one way they go, besides erasure, and it reaches only events retention has ended.
CREATE OR REPLACE FUNCTION slotlock.prune_audit_events(requested_tenant text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_prune_audit_events$
DECLARE
  pruned integer;
BEGIN
  -- The start of the chain only, so what is kept still links up: every event up to the last one
  -- written before retention's cut, and events from before the chain past it.
  DELETE FROM slotlock.audit_events gone
   WHERE gone.tenant_ref = requested_tenant
     AND ((gone.chain_index IS NULL
           AND gone.occurred_at < statement_timestamp() - make_interval(days => ${SLOTLOCK_AUDIT_RETENTION_DAYS}))
          OR gone.chain_index <= (
            SELECT max(old.chain_index) FROM slotlock.audit_events old
             WHERE old.tenant_ref = requested_tenant
               AND old.occurred_at < statement_timestamp() - make_interval(days => ${SLOTLOCK_AUDIT_RETENTION_DAYS})));
  GET DIAGNOSTICS pruned = ROW_COUNT;
  RETURN pruned;
END
$slotlock_prune_audit_events$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS[8]} FROM PUBLIC;

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
    -- A no-show release (releaseNoShows) names its deletion, so the feed has one change for it,
    -- not a cancellation as well. The marker only renames: a deletion is always recorded.
    kind := CASE
      WHEN OLD.status <> 'held' AND current_setting('slotlock.ending', true) = 'no_show'
        THEN 'reservation.no_show'
      WHEN OLD.status <> 'held' THEN 'reservation.cancelled'
      WHEN OLD.expires_at <= statement_timestamp() THEN 'hold.expired'
      ELSE 'hold.released'
    END;
  END IF;
  INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
  SELECT
    owner, changed.resource_id, written.change_type,
    COALESCE(changed.external_ref, changed.id::text),
    jsonb_strip_nulls(jsonb_build_object(
      'id', changed.id,
      'reference', changed.external_ref,
      'resource_id', changed.resource_id,
      'start', changed.starts_at,
      'end', changed.ends_at,
      'buffer_after_ms', changed.buffer_after_ms,
      -- Whom to tell and whether (RFC 0004 P3): a reference, never the person; notify only when off.
      'contact_ref', changed.contact_ref,
      'notify', CASE WHEN NOT changed.notify THEN false END,
      'payment_required', CASE WHEN changed.payment_required THEN true END,
      -- A paid hold that ended without a booking (expired, let go, or left when another of its
      -- group was booked): its payment was never applied, and is the integrator's to refund (RFC
      -- 0004 C3). Booked from (slotlock.ending = 'confirmed') or taken over by an approval, it was.
      'payment_unapplied', CASE
        WHEN TG_OP = 'DELETE' AND OLD.status = 'held' AND OLD.payment_ref IS NOT NULL
             AND COALESCE(current_setting('slotlock.ending', true), '') NOT IN ('confirmed', 'approval')
        THEN jsonb_strip_nulls(jsonb_build_object(
          'payment_ref', OLD.payment_ref, 'amount_minor', OLD.paid_amount_minor, 'currency', OLD.paid_currency))
      END,
      -- A cancellation's fee and an admin's reason for going past a cutoff (RFC 0004 B5).
      'cancellation_fee', CASE WHEN kind = 'reservation.cancelled'
                               THEN NULLIF(current_setting('slotlock.cancellation_fee', true), '')::jsonb END,
      'override_reason', NULLIF(current_setting('slotlock.override_reason', true), ''),
      -- A no-show carries the revision its reference is retired at, and the check-in window.
      'revision', CASE WHEN changed.status = 'held' THEN NULL
                       WHEN kind = 'reservation.no_show' THEN changed.revision + 1
                       ELSE changed.revision END,
      'check_in_minutes', CASE WHEN kind = 'reservation.no_show'
                               THEN NULLIF(current_setting('slotlock.ending_detail', true), '')::int END,
      'expires_at', CASE WHEN changed.status = 'held' THEN changed.expires_at END,
      -- A move says where it came from.
      'before', CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object(
        'resource_id', OLD.resource_id, 'start', OLD.starts_at, 'end', OLD.ends_at,
        'revision', OLD.revision) END
    )),
    NULLIF(current_setting('slotlock.actor', true), '')
    -- A booking moved in time or to another resource is also reservation.rescheduled (RFC 0004
    -- B4); reservation.updated stays for those who read it.
    FROM (VALUES (kind), (CASE WHEN kind = 'reservation.updated'
                                AND (OLD.starts_at, OLD.ends_at, OLD.resource_id)
                                    IS DISTINCT FROM (NEW.starts_at, NEW.ends_at, NEW.resource_id)
                               THEN 'reservation.rescheduled' END)) AS written(change_type)
   WHERE written.change_type IS NOT NULL;
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
      'notify', CASE WHEN NOT changed.notify THEN false END,
      -- A cancellation's fee and an admin's reason for going past a cutoff (RFC 0004 B5).
      'cancellation_fee', CASE WHEN kind = 'event.cancelled'
                               THEN NULLIF(current_setting('slotlock.cancellation_fee', true), '')::jsonb END,
      'override_reason', NULLIF(current_setting('slotlock.override_reason', true), ''),
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
  -- Never null: the erasing setting is unset outside erasure, and a null here would read as neither
  -- erasing nor not to a caller that writes NOT outbox_erasing(...).
  SELECT COALESCE(owner = current_setting('slotlock.erasing', true)
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace
                          WHERE nspname = 'slotlock'), false);
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
    -- The composite it is a part of (RFC 0003 G8), read through to_jsonb: a migration that runs
    -- this before the column exists sees no change rather than an error.
    IF (to_jsonb(OLD) -> 'parent_id') IS DISTINCT FROM (to_jsonb(NEW) -> 'parent_id') THEN
      before := before || jsonb_build_object('parent', to_jsonb(OLD) -> 'parent_id');
      after := after || jsonb_build_object('parent', to_jsonb(NEW) -> 'parent_id');
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

-- A resource deleted: resource.deleted, recorded just before its row goes, while its groups are
-- still there (a foreign key's cascade takes them before any AFTER trigger of the resource runs),
-- with where it was: its pool, location and groups, so an endpoint filtered by them still receives
-- it (event-feed.ts FILTER_MATCH). A delete that fails takes this row back with it.
CREATE OR REPLACE FUNCTION slotlock.outbox_resource_deleting()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_outbox_resource_deleting$
DECLARE
  was_in text[];
BEGIN
  IF OLD.tenant_ref IS NULL OR slotlock.outbox_erasing(OLD.tenant_ref) THEN RETURN OLD; END IF;
  was_in := ARRAY(SELECT member.group_ref FROM slotlock.resource_group_members member
                   WHERE member.tenant_ref = OLD.tenant_ref AND member.resource_id = OLD.id
                   ORDER BY member.group_ref);
  INSERT INTO slotlock.outbox (tenant_ref, resource_id, type, subject, data, actor)
  VALUES (
    OLD.tenant_ref, OLD.id, 'resource.deleted', OLD.id::text,
    jsonb_build_object('id', OLD.id, 'reference', OLD.external_ref)
      || jsonb_strip_nulls(jsonb_build_object('pool', OLD.pool_ref, 'location', OLD.location_ref))
      || CASE WHEN cardinality(was_in) > 0 THEN jsonb_build_object('groups', to_jsonb(was_in)) ELSE '{}'::jsonb END,
    NULLIF(current_setting('slotlock.actor', true), '')
  );
  RETURN OLD;
END
$slotlock_outbox_resource_deleting$;

-- Deletion has its own trigger, before the row goes (outbox_resource_deleting).
CREATE OR REPLACE TRIGGER slotlock_outbox_resource_change
  AFTER INSERT OR UPDATE ON slotlock.resources
  FOR EACH ROW EXECUTE FUNCTION slotlock.outbox_resource_change();
CREATE OR REPLACE TRIGGER slotlock_outbox_resource_deleting
  BEFORE DELETE ON slotlock.resources
  FOR EACH ROW EXECUTE FUNCTION slotlock.outbox_resource_deleting();
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

/**
 * Partner accounts (RFC 0003 part 4, P1-P4, P6): a partner (stackapi.app, say) creates and runs
 * Slotlock tenants for its own users, `partner:<partner>:<account>`, with plans from its contract,
 * and Pylota invoices the partner. Owner-only tables; the serving role reaches them only through
 * SLOTLOCK_PARTNER_FUNCTIONS, each scoped to the one partner a partner key names.
 */
const SLOTLOCK_PARTNER_DDL = `
CREATE TABLE IF NOT EXISTS slotlock.partners (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  -- The plans its accounts may be on, the scopes their keys may have, and its prices (partners.ts).
  contract jsonb NOT NULL,
  stripe_customer text,
  -- Where usage.period_closed goes (P5), signed with the secret.
  webhook_url text,
  webhook_secret text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_partners_valid CHECK (
    id ~ '^[a-z][a-z0-9-]{1,39}$'
    AND char_length(name) BETWEEN 1 AND 100 AND name !~ '[[:cntrl:]]'
    AND status IN ('active', 'suspended')
    AND jsonb_typeof(contract) = 'object'
    AND (stripe_customer IS NULL OR stripe_customer ~ '^cus_[A-Za-z0-9]{1,250}$')
    AND (webhook_url IS NULL OR (webhook_url ~ '^https://' AND octet_length(webhook_url) <= 2048))
    AND (webhook_secret IS NULL OR webhook_secret ~ '^whsec_[A-Za-z0-9+/=]{32,200}$')
  )
);
ALTER TABLE slotlock.partners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.partners FROM PUBLIC;

CREATE TABLE IF NOT EXISTS slotlock.partner_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id text NOT NULL REFERENCES slotlock.partners (id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  secret_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT slotlock_partner_keys_secret_hash_key UNIQUE (secret_hash),
  CONSTRAINT slotlock_partner_keys_valid CHECK (
    octet_length(secret_hash) = 32
    AND char_length(name) BETWEEN 1 AND 100 AND name !~ '[[:cntrl:]]'
    AND prefix ~ '^slk_partner_[0-9A-Za-z]{6}$'
  )
);
ALTER TABLE slotlock.partner_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.partner_keys FROM PUBLIC;

CREATE TABLE IF NOT EXISTS slotlock.partner_accounts (
  partner_id text NOT NULL REFERENCES slotlock.partners (id) ON DELETE RESTRICT,
  account text NOT NULL,
  tenant_ref text NOT NULL,
  plan text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_partner_accounts_pkey PRIMARY KEY (partner_id, account),
  CONSTRAINT slotlock_partner_accounts_tenant_key UNIQUE (tenant_ref),
  CONSTRAINT slotlock_partner_accounts_valid CHECK (
    account ~ '^[A-Za-z0-9._-]{1,128}$'
    AND tenant_ref = 'partner:' || partner_id || ':' || account
    AND plan ~ '^[a-z][a-z0-9_]{0,40}$'
  )
);
ALTER TABLE slotlock.partner_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.partner_accounts FROM PUBLIC;

-- Each line of a partner's month (P6), recorded before it is sent to Stripe and with its Stripe id
-- after, so a month is billed once however often the job runs.
CREATE TABLE IF NOT EXISTS slotlock.partner_invoices (
  partner_id text NOT NULL REFERENCES slotlock.partners (id) ON DELETE RESTRICT,
  month date NOT NULL,
  line text NOT NULL,
  description text NOT NULL,
  quantity bigint NOT NULL,
  amount bigint NOT NULL,
  currency text NOT NULL,
  stripe_item text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  sent_at timestamptz,
  CONSTRAINT slotlock_partner_invoices_pkey PRIMARY KEY (partner_id, month, line),
  CONSTRAINT slotlock_partner_invoices_valid CHECK (
    extract(day FROM month) = 1
    AND line ~ '^[a-z][a-z0-9_]{0,60}$'
    AND char_length(description) BETWEEN 1 AND 500
    AND quantity >= 0 AND amount >= 0
    AND currency ~ '^[a-z]{3}$'
    AND (stripe_item IS NULL OR stripe_item ~ '^ii_[A-Za-z0-9]{1,250}$')
  )
);
ALTER TABLE slotlock.partner_invoices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.partner_invoices FROM PUBLIC;

-- A partner's month as it was first closed (P5, P6): each account's totals and the checksum the
-- usage.period_closed webhook carries. Every later run sends the same body under the same id, and
-- the month's invoice lines are priced from these totals only, once.
CREATE TABLE IF NOT EXISTS slotlock.partner_month_closes (
  partner_id text NOT NULL REFERENCES slotlock.partners (id) ON DELETE RESTRICT,
  month date NOT NULL,
  accounts jsonb NOT NULL,
  checksum text NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  webhook_status integer,
  webhook_delivered_at timestamptz,
  CONSTRAINT slotlock_partner_month_closes_pkey PRIMARY KEY (partner_id, month),
  CONSTRAINT slotlock_partner_month_closes_valid CHECK (
    extract(day FROM month) = 1 AND checksum ~ '^[0-9a-f]{64}$' AND jsonb_typeof(accounts) = 'array'
    AND (webhook_status IS NULL OR webhook_status BETWEEN 100 AND 599)
  )
);
ALTER TABLE slotlock.partner_month_closes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.partner_month_closes FROM PUBLIC;

-- What an account of a partner's used in a month not yet closed, kept when the account is erased
-- (erase_tenant), so its month is still billed. By the partner's own account reference: the tenant
-- and everything in it are gone.
CREATE TABLE IF NOT EXISTS slotlock.partner_erased_usage (
  partner_id text NOT NULL REFERENCES slotlock.partners (id) ON DELETE RESTRICT,
  account text NOT NULL,
  plan text NOT NULL,
  month date NOT NULL,
  metric text NOT NULL,
  count bigint NOT NULL,
  erased_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_partner_erased_usage_pkey PRIMARY KEY (partner_id, account, month, metric),
  CONSTRAINT slotlock_partner_erased_usage_valid CHECK (extract(day FROM month) = 1 AND count >= 0)
);
ALTER TABLE slotlock.partner_erased_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.partner_erased_usage FROM PUBLIC;

-- Each day a partner compared its counts with Slotlock's (P5, the partner API's reconcile call):
-- how many accounts, how many differed by more than ${SLOTLOCK_RECONCILE_TOLERANCE_PERCENT}%, and by
-- how much at most. A day with any is an incident on our side: \`slotlock billing daily\` lists it.
CREATE TABLE IF NOT EXISTS slotlock.partner_reconciliations (
  partner_id text NOT NULL REFERENCES slotlock.partners (id) ON DELETE CASCADE,
  day date NOT NULL,
  accounts integer NOT NULL,
  mismatched integer NOT NULL,
  worst_percent numeric NOT NULL,
  reconciled_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_partner_reconciliations_pkey PRIMARY KEY (partner_id, day),
  CONSTRAINT slotlock_partner_reconciliations_valid CHECK (
    accounts BETWEEN 0 AND 100000 AND mismatched BETWEEN 0 AND accounts AND worst_percent >= 0
  )
);
ALTER TABLE slotlock.partner_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.partner_reconciliations FROM PUBLIC;

-- Whether the tenant is a partner's account whose partner is not active: its keys authenticate as
-- nothing and it is suspended with its partner (tenant_suspended). Any other tenant reference, one
-- that merely starts with partner: included, is never blocked here.
CREATE OR REPLACE FUNCTION slotlock.partner_tenant_blocked(requested_tenant_ref text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_partner_tenant_blocked$
  SELECT EXISTS (
    SELECT 1 FROM slotlock.partner_accounts owned
      JOIN slotlock.partners partner ON partner.id = owned.partner_id
     WHERE owned.tenant_ref = regexp_replace(requested_tenant_ref, '~test$', '')
       AND partner.status <> 'active'
  );
$slotlock_partner_tenant_blocked$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_PARTNER_FUNCTIONS[0]} FROM PUBLIC;

-- A partner key's partner, while the key is not revoked and the partner is active; last_used_at
-- moves at most once a minute.
CREATE OR REPLACE FUNCTION slotlock.authenticate_partner_key(presented_secret_hash bytea)
RETURNS TABLE (key_id uuid, partner_id text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_authenticate_partner_key$
#variable_conflict use_column
BEGIN
  UPDATE slotlock.partner_keys used
     SET last_used_at = now()
   WHERE used.secret_hash = presented_secret_hash AND used.revoked_at IS NULL
     AND (used.last_used_at IS NULL OR used.last_used_at < now() - interval '1 minute');
  RETURN QUERY
  SELECT found.id, found.partner_id
    FROM slotlock.partner_keys found
    JOIN slotlock.partners partner ON partner.id = found.partner_id
   WHERE found.secret_hash = presented_secret_hash AND found.revoked_at IS NULL
     AND partner.status = 'active';
END
$slotlock_authenticate_partner_key$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_PARTNER_FUNCTIONS[1]} FROM PUBLIC;

CREATE OR REPLACE FUNCTION slotlock.partner_contract(requested_partner_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_partner_contract$
  SELECT partner.contract FROM slotlock.partners partner
   WHERE partner.id = requested_partner_id AND partner.status = 'active';
$slotlock_partner_contract$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_PARTNER_FUNCTIONS[2]} FROM PUBLIC;

-- Create the partner's account, or put it on another of its contract's plans: the account's tenant
-- gets that plan's limits and quotas (tenant_plans, source partner). Refused (invalid_parameter_value)
-- for a plan the contract does not have; nothing for a partner that is not active.
CREATE OR REPLACE FUNCTION slotlock.put_partner_account(
  requested_partner_id text, requested_account text, requested_plan text
)
RETURNS TABLE (account text, tenant_ref text, plan text, created_at timestamptz, updated_at timestamptz, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_put_partner_account$
#variable_conflict use_column
DECLARE
  terms jsonb;
  chosen jsonb;
  tenant text := 'partner:' || requested_partner_id || ':' || requested_account;
  existed boolean;
BEGIN
  SELECT partner.contract INTO terms FROM slotlock.partners partner
   WHERE partner.id = requested_partner_id AND partner.status = 'active';
  IF NOT FOUND THEN RETURN; END IF;
  IF requested_account IS NULL OR requested_account !~ '^[A-Za-z0-9._-]{1,128}$' THEN
    RAISE EXCEPTION 'Slotlock partner account must be 1-128 letters, digits, dots, dashes or underscores'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'invalid_partner_account';
  END IF;
  chosen := terms -> 'plans' -> requested_plan;
  IF requested_plan IS NULL OR chosen IS NULL OR jsonb_typeof(chosen) <> 'object' THEN
    RAISE EXCEPTION 'Slotlock partner plan is not one of the contract''s'
      USING ERRCODE = 'invalid_parameter_value', HINT = 'invalid_partner_plan';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:tenant:' || tenant, 0));
  existed := EXISTS (SELECT 1 FROM slotlock.partner_accounts kept
                      WHERE kept.partner_id = requested_partner_id AND kept.account = requested_account);
  INSERT INTO slotlock.partner_accounts AS kept (partner_id, account, tenant_ref, plan)
  VALUES (requested_partner_id, requested_account, tenant, requested_plan)
  ON CONFLICT (partner_id, account) DO UPDATE
    SET plan = EXCLUDED.plan,
        updated_at = CASE WHEN kept.plan = EXCLUDED.plan THEN kept.updated_at ELSE statement_timestamp() END;
  INSERT INTO slotlock.tenant_plans AS kept (
    tenant_ref, plan, status, max_resources, max_api_keys, max_webhook_endpoints,
    source, partner_id, quota_operations, quota_bookings, quota_stop_percent
  ) VALUES (
    tenant, requested_plan, 'active',
    (chosen ->> 'resources')::integer, (chosen ->> 'api_keys')::integer, (chosen ->> 'webhook_endpoints')::integer,
    'partner', requested_partner_id,
    (chosen ->> 'operations')::bigint, (chosen ->> 'bookings')::bigint, (chosen ->> 'stop_percent')::integer
  )
  ON CONFLICT (tenant_ref) DO UPDATE
    SET plan = EXCLUDED.plan, status = 'active',
        max_resources = EXCLUDED.max_resources, max_api_keys = EXCLUDED.max_api_keys,
        max_webhook_endpoints = EXCLUDED.max_webhook_endpoints,
        source = 'partner', partner_id = EXCLUDED.partner_id,
        quota_operations = EXCLUDED.quota_operations, quota_bookings = EXCLUDED.quota_bookings,
        quota_stop_percent = EXCLUDED.quota_stop_percent,
        stripe_customer = NULL, stripe_subscription = NULL, current_period_end = NULL,
        updated_at = statement_timestamp();
  RETURN QUERY
  SELECT kept.account, kept.tenant_ref, kept.plan, kept.created_at, kept.updated_at, NOT existed
    FROM slotlock.partner_accounts kept
   WHERE kept.partner_id = requested_partner_id AND kept.account = requested_account;
END
$slotlock_put_partner_account$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_PARTNER_FUNCTIONS[3]} FROM PUBLIC;

-- PL/pgSQL, as partner_usage: these read tables created after this section, which a SQL function's
-- body may not name when it is created on a new schema.
CREATE OR REPLACE FUNCTION slotlock.list_partner_accounts(requested_partner_id text)
RETURNS TABLE (account text, plan text, suspended boolean, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_list_partner_accounts$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT owned.account, owned.plan,
         EXISTS (SELECT 1 FROM slotlock.tenant_suspensions held WHERE held.tenant_ref = owned.tenant_ref),
         owned.created_at, owned.updated_at
    FROM slotlock.partner_accounts owned
   WHERE owned.partner_id = requested_partner_id
   ORDER BY owned.account
   LIMIT 10000;
END
$slotlock_list_partner_accounts$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_PARTNER_FUNCTIONS[4]} FROM PUBLIC;

-- One account, with how many resources (archived ones included) and active keys it holds.
CREATE OR REPLACE FUNCTION slotlock.get_partner_account(requested_partner_id text, requested_account text)
RETURNS TABLE (account text, tenant_ref text, plan text, suspended boolean, created_at timestamptz,
               updated_at timestamptz, resources bigint, api_keys bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_get_partner_account$
#variable_conflict use_column
DECLARE
  owned slotlock.partner_accounts%ROWTYPE;
  setting text;
  previous jsonb := '{}'::jsonb;
  counted bigint;
BEGIN
  SELECT * INTO owned FROM slotlock.partner_accounts kept
   WHERE kept.partner_id = requested_partner_id AND kept.account = requested_account;
  IF NOT FOUND THEN RETURN; END IF;
  -- Resources have forced row-level security, their owner bound too: counted in the account's context.
  FOR setting IN SELECT DISTINCT contract.tenant_context_setting FROM slotlock.rls_policy_contracts contract
  LOOP
    previous := previous || jsonb_build_object(setting, current_setting(setting, true));
    PERFORM set_config(setting, owned.tenant_ref, true);
  END LOOP;
  SELECT count(*) INTO counted FROM slotlock.resources held WHERE held.tenant_ref = owned.tenant_ref;
  FOR setting IN SELECT jsonb_object_keys(previous) LOOP
    PERFORM set_config(setting, coalesce(previous ->> setting, ''), true);
  END LOOP;
  RETURN QUERY
  SELECT owned.account, owned.tenant_ref, owned.plan,
         EXISTS (SELECT 1 FROM slotlock.tenant_suspensions held WHERE held.tenant_ref = owned.tenant_ref),
         owned.created_at, owned.updated_at, counted,
         (SELECT count(*) FROM slotlock.api_keys issued
           WHERE issued.tenant_ref = owned.tenant_ref AND issued.revoked_at IS NULL
             AND (issued.expires_at IS NULL OR issued.expires_at > now()));
END
$slotlock_get_partner_account$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_PARTNER_FUNCTIONS[5]} FROM PUBLIC;

-- Suspend an account of the partner's, or lift a suspension the partner made: one Pylota made (for
-- abuse, say) the partner cannot lift. True when it changed something; null for no such account.
CREATE OR REPLACE FUNCTION slotlock.set_partner_account_suspended(
  requested_partner_id text, requested_account text, requested_suspended boolean, requested_reason text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_set_partner_account_suspended$
DECLARE
  tenant text;
BEGIN
  SELECT owned.tenant_ref INTO tenant FROM slotlock.partner_accounts owned
    JOIN slotlock.partners partner ON partner.id = owned.partner_id AND partner.status = 'active'
   WHERE owned.partner_id = requested_partner_id AND owned.account = requested_account;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- As suspend_tenant: the tenant's lock and its key lock, so writes in flight finish first.
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:tenant:' || tenant, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:api-keys:' || tenant, 0));
  IF requested_suspended THEN
    INSERT INTO slotlock.tenant_suspensions (tenant_ref, reason)
    VALUES (tenant, 'partner: ' || COALESCE(left(requested_reason, 200), 'suspended by its partner'))
    ON CONFLICT (tenant_ref) DO NOTHING;
    RETURN FOUND;
  END IF;
  DELETE FROM slotlock.tenant_suspensions held
   WHERE held.tenant_ref = tenant AND held.reason LIKE 'partner: %';
  RETURN FOUND;
END
$slotlock_set_partner_account_suspended$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_PARTNER_FUNCTIONS[6]} FROM PUBLIC;

-- The partner's accounts' usage (P5), from usage_daily, by account, UTC day and metric, from
-- from_day to to_day (at most the retention); one account, or all of them.
CREATE OR REPLACE FUNCTION slotlock.partner_usage(
  requested_partner_id text, from_day date, to_day date, requested_account text
)
RETURNS TABLE (account text, day date, metric text, count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_partner_usage$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT owned.account, used.day, used.metric,
         CASE WHEN used.metric = 'resources' THEN max(used.count) ELSE sum(used.count) END::bigint
    FROM slotlock.partner_accounts owned
    JOIN slotlock.usage_daily used ON used.tenant_ref = owned.tenant_ref
   WHERE owned.partner_id = requested_partner_id
     AND (requested_account IS NULL OR owned.account = requested_account)
     AND used.day BETWEEN from_day AND to_day
     AND to_day - from_day BETWEEN 0 AND ${SLOTLOCK_USAGE_RETENTION_DAYS}
   GROUP BY owned.account, used.day, used.metric
   ORDER BY owned.account, used.day, used.metric;
END
$slotlock_partner_usage$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_PARTNER_FUNCTIONS[7]} FROM PUBLIC;

-- The tenant of a partner's account, for a partner key acting for it (Slotlock-Account, RFC 0003
-- P3): one indexed read, on every such request.
CREATE OR REPLACE FUNCTION slotlock.partner_account_tenant(requested_partner_id text, requested_account text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_partner_account_tenant$
  SELECT owned.tenant_ref FROM slotlock.partner_accounts owned
   WHERE owned.partner_id = requested_partner_id AND owned.account = requested_account;
$slotlock_partner_account_tenant$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_PARTNER_FUNCTIONS[8]} FROM PUBLIC;

-- Record a partner's comparison of one day (the latest one stands).
CREATE OR REPLACE FUNCTION slotlock.record_partner_reconciliation(
  requested_partner_id text, requested_day date, requested_accounts integer, requested_mismatched integer,
  requested_worst numeric
)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_record_partner_reconciliation$
  INSERT INTO slotlock.partner_reconciliations AS kept (partner_id, day, accounts, mismatched, worst_percent)
  VALUES (requested_partner_id, requested_day, requested_accounts, requested_mismatched, requested_worst)
  ON CONFLICT (partner_id, day) DO UPDATE
    SET accounts = EXCLUDED.accounts, mismatched = EXCLUDED.mismatched,
        worst_percent = EXCLUDED.worst_percent, reconciled_at = statement_timestamp();
$slotlock_record_partner_reconciliation$;
REVOKE ALL ON FUNCTION ${SLOTLOCK_PARTNER_FUNCTIONS[9]} FROM PUBLIC;
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
-- When maintenance said the booking ended (reservation.completed, RFC 0004 B4): it changes nothing
-- anyone wrote, so the feed's trigger ignores it.
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS completed_at timestamptz;
CREATE INDEX IF NOT EXISTS slotlock_reservations_uncompleted_idx
  ON slotlock.reservations (tenant_ref, ends_at)
  WHERE status = 'confirmed' AND completed_at IS NULL;
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
-- Why the booking ended (RFC 0004 B4): cancelled or no_show (a hold leaves no tombstone; released
-- and expired are on the feed). Rows from before keep 'cancelled', as every one of them was. A late
-- cancellation's fee (B5), recorded for the integrator to charge, and an admin's reason for going
-- past a cutoff.
ALTER TABLE slotlock.reservation_tombstones
  ADD COLUMN IF NOT EXISTS end_reason text NOT NULL DEFAULT 'cancelled';
ALTER TABLE slotlock.reservation_tombstones ADD COLUMN IF NOT EXISTS cancellation_fee jsonb;
ALTER TABLE slotlock.reservation_tombstones ADD COLUMN IF NOT EXISTS override_reason text;
DO $slotlock_tombstone_end_reason$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.reservation_tombstones'::regclass
       AND conname = 'slotlock_reservation_tombstones_end_valid'
  ) THEN
    ALTER TABLE slotlock.reservation_tombstones
      ADD CONSTRAINT slotlock_reservation_tombstones_end_valid CHECK (
        end_reason IN ('cancelled', 'no_show', 'released', 'expired', 'erased')
        AND (cancellation_fee IS NULL OR (jsonb_typeof(cancellation_fee) = 'object'
                                          AND octet_length(cancellation_fee::text) <= 200))
        AND (override_reason IS NULL OR char_length(override_reason) BETWEEN 1 AND 500)
      );
  END IF;
END
$slotlock_tombstone_end_reason$;
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

-- Composite resources (RFC 0003 G8): a parent made of parts (a hall of three rooms), one level
-- deep. A part has its parent and its place among the parent's parts. A booking of a part also
-- claims its place on the parent ([i, i+1)); a booking of the parent claims every place ([0, ∞)).
-- composite_claims keeps those apart by PostgreSQL's own exclusion constraint: the whole conflicts
-- with every part, and two parts never with each other. A resource that is neither has no claims.
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS parent_id uuid;
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS part_index integer;
DO $slotlock_resources_parent$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.resources'::regclass AND conname = 'slotlock_resources_parent_fkey'
  ) THEN
    -- Deleting a parent sets its parts free (the store refuses it while anything on it is live).
    ALTER TABLE slotlock.resources ADD CONSTRAINT slotlock_resources_parent_fkey
      FOREIGN KEY (parent_id, tenant_ref) REFERENCES slotlock.resources (id, tenant_ref)
      ON DELETE SET NULL (parent_id) NOT VALID;
    ALTER TABLE slotlock.resources ADD CONSTRAINT slotlock_resources_part_valid CHECK (
      (parent_id IS NULL OR part_index IS NOT NULL)
      AND (part_index IS NULL OR part_index BETWEEN 0 AND ${SLOTLOCK_MAX_COMPOSITE_PARTS - 1})
      AND parent_id IS DISTINCT FROM id
    ) NOT VALID;
  END IF;
END
$slotlock_resources_parent$;
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_resources_part_idx
  ON slotlock.resources (parent_id, part_index) WHERE parent_id IS NOT NULL;

-- One level, ${SLOTLOCK_MAX_COMPOSITE_PARTS} parts at most, and never while either side holds a
-- booking or live hold that has not ended: claims are made as bookings are, never backfilled.
CREATE OR REPLACE FUNCTION slotlock.resources_parent_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_resources_parent_guard$
BEGIN
  IF NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:composite:' || COALESCE(NEW.parent_id, OLD.parent_id)::text, 0));
  IF NEW.parent_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM slotlock.resources parent WHERE parent.id = NEW.parent_id AND parent.parent_id IS NOT NULL)
       OR EXISTS (SELECT 1 FROM slotlock.resources part WHERE part.parent_id = NEW.id) THEN
      RAISE EXCEPTION 'Slotlock composites are one level deep: a part has no parts, and a parent is no part'
        USING ERRCODE = 'check_violation', HINT = 'composite_too_deep';
    END IF;
    IF (SELECT count(*) FROM slotlock.resources part WHERE part.parent_id = NEW.parent_id)
       >= ${SLOTLOCK_MAX_COMPOSITE_PARTS} THEN
      RAISE EXCEPTION 'Slotlock composites have at most ${SLOTLOCK_MAX_COMPOSITE_PARTS} parts'
        USING ERRCODE = 'check_violation', HINT = 'composite_parts_limit';
    END IF;
    NEW.part_index := COALESCE(
      (SELECT min(free.slot) FROM pg_catalog.generate_series(0, ${SLOTLOCK_MAX_COMPOSITE_PARTS - 1}) AS free(slot)
        WHERE NOT EXISTS (SELECT 1 FROM slotlock.resources part
                           WHERE part.parent_id = NEW.parent_id AND part.part_index = free.slot)),
      0);
  ELSE
    NEW.part_index := NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM slotlock.reservations booked
     WHERE booked.resource_id IN (NEW.id, NEW.parent_id, OLD.parent_id)
       AND COALESCE(booked.occupied_ends_at, booked.ends_at) > statement_timestamp()
       AND (booked.status <> 'held' OR booked.expires_at > statement_timestamp())
  ) THEN
    RAISE EXCEPTION 'Slotlock changes a composite only while neither side has a booking or live hold to come'
      USING ERRCODE = 'check_violation', HINT = 'composite_busy';
  END IF;
  RETURN NEW;
END
$slotlock_resources_parent_guard$;
CREATE OR REPLACE TRIGGER slotlock_resources_parent_guard
  BEFORE UPDATE OF parent_id ON slotlock.resources
  FOR EACH ROW EXECUTE FUNCTION slotlock.resources_parent_guard();

CREATE TABLE IF NOT EXISTS slotlock.composite_claims (
  reservation_id uuid PRIMARY KEY REFERENCES slotlock.reservations (id) ON DELETE CASCADE,
  tenant_ref text NOT NULL,
  -- The composite: the parent, whichever of its resources the booking is on.
  resource_id uuid NOT NULL REFERENCES slotlock.resources (id) ON DELETE CASCADE,
  booked_resource_id uuid NOT NULL,
  span int4range NOT NULL,
  during tstzrange NOT NULL,
  status text NOT NULL,
  expires_at timestamptz,
  CONSTRAINT slotlock_composite_claims_valid CHECK (octet_length(tenant_ref) BETWEEN 1 AND 500 AND NOT isempty(span)),
  CONSTRAINT slotlock_composite_claims_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    during WITH &&,
    span WITH &&
  )
);
CREATE INDEX IF NOT EXISTS slotlock_composite_claims_booked_idx
  ON slotlock.composite_claims (booked_resource_id);

-- Each booking or hold on a part or a parent claims its place on the composite, in the same
-- statement: a claim that overlaps another fails it with 23P01, as a booking that overlaps one on
-- its own resource does.
CREATE OR REPLACE FUNCTION slotlock.composite_claim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_composite_claim$
DECLARE
  booked record;
  composite uuid;
  claimed int4range;
BEGIN
  -- An update that moves nothing the claim holds leaves it (no column list on the trigger, so an
  -- upgrade that adds a column later in the DDL never finds one here first).
  IF TG_OP = 'UPDATE'
     AND NEW.resource_id = OLD.resource_id
     AND NEW.starts_at = OLD.starts_at AND NEW.ends_at = OLD.ends_at
     AND NEW.occupied_starts_at IS NOT DISTINCT FROM OLD.occupied_starts_at
     AND NEW.occupied_ends_at IS NOT DISTINCT FROM OLD.occupied_ends_at
     AND NEW.status = OLD.status
     AND NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM slotlock.composite_claims claim WHERE claim.reservation_id = OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN NULL;
  END IF;
  SELECT resource.parent_id, resource.part_index, resource.tenant_ref,
         EXISTS (SELECT 1 FROM slotlock.resources part WHERE part.parent_id = resource.id) AS whole
    INTO booked
    FROM slotlock.resources resource WHERE resource.id = NEW.resource_id;
  IF booked.parent_id IS NOT NULL THEN
    composite := booked.parent_id;
    claimed := int4range(booked.part_index, booked.part_index + 1);
  ELSIF booked.whole THEN
    composite := NEW.resource_id;
    claimed := int4range(0, NULL);
  ELSE
    RETURN NULL;
  END IF;
  INSERT INTO slotlock.composite_claims (
    reservation_id, tenant_ref, resource_id, booked_resource_id, span, during, status, expires_at
  ) VALUES (
    NEW.id, booked.tenant_ref, composite, NEW.resource_id, claimed,
    tstzrange(COALESCE(NEW.occupied_starts_at, NEW.starts_at), COALESCE(NEW.occupied_ends_at, NEW.ends_at), '[)'),
    NEW.status, NEW.expires_at
  );
  RETURN NULL;
END
$slotlock_composite_claim$;
CREATE OR REPLACE TRIGGER slotlock_reservations_composite_claim
  AFTER INSERT OR UPDATE OR DELETE ON slotlock.reservations
  FOR EACH ROW EXECUTE FUNCTION slotlock.composite_claim();

-- Approval policies (RFC 0004 A4): which writes a person approves before they are made, or
-- refuses outright. applies_to names resources, pools, locations (each with the locations in it)
-- or groups ({} is every resource); conditions name what makes a write need it: longer than some
-- minutes, outside the resource's hours, or a kind of write. The wait is the policy's own, bounded
-- by the booking's start less lead_minutes and by the server's maximum.
CREATE TABLE IF NOT EXISTS slotlock.approval_policies (
  tenant_ref text NOT NULL,
  ref text NOT NULL,
  name text NOT NULL,
  applies_to jsonb NOT NULL DEFAULT '{}'::jsonb,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL,
  approval_ttl_minutes integer NOT NULL DEFAULT 1440,
  lead_minutes integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_ref, ref),
  CONSTRAINT slotlock_approval_policies_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND ref ~ '^[a-z0-9][a-z0-9_-]{0,62}$'
    AND char_length(name) BETWEEN 1 AND 200
    AND jsonb_typeof(applies_to) = 'object' AND jsonb_typeof(conditions) = 'object'
    AND outcome IN ('require_approval', 'refuse')
    AND approval_ttl_minutes BETWEEN 1 AND 43200
    AND lead_minutes BETWEEN 0 AND 43200
  )
);
-- A policy holds agents' bookings, and the tenant's own through the application API (bundles and
-- pool bookings) only when it includes them (RFC 0004 B7).
ALTER TABLE slotlock.approval_policies ADD COLUMN IF NOT EXISTS include_application boolean NOT NULL DEFAULT false;

-- A write waiting for a person: its time held by holds whose holder is the approval (never the
-- agent, so it cannot release them and they do not count against its caps), and the request to run
-- as its requester when granted, in the same transaction that lets the holds go.
CREATE TABLE IF NOT EXISTS slotlock.approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL,
  policy_ref text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  operation text NOT NULL,
  request jsonb NOT NULL,
  requester jsonb NOT NULL,
  hold_ids uuid[] NOT NULL,
  -- What it holds, kept for the record once the holds are gone.
  resource_ids uuid[] NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- The requester, operation and idempotency key, hashed: a retry finds the approval it made.
  request_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  reason text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_approvals_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND status IN ('pending', 'granted', 'declined', 'expired')
    AND operation IN ('slotlock_create_event', 'slotlock_book_together', 'slotlock_update_event')
    AND jsonb_typeof(request) = 'object' AND jsonb_typeof(requester) = 'object'
    AND cardinality(hold_ids) BETWEEN 1 AND 20
    AND cardinality(resource_ids) BETWEEN 1 AND 20 AND ends_at > starts_at
    AND request_key ~ '^[0-9a-f]{64}$'
    AND (decided_by IS NULL OR octet_length(decided_by) BETWEEN 1 AND 500)
    AND (reason IS NULL OR char_length(reason) <= 500)
    AND ((status = 'pending') = (decided_at IS NULL))
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_approvals_request_idx
  ON slotlock.approvals (tenant_ref, request_key);
CREATE INDEX IF NOT EXISTS slotlock_approvals_pending_idx
  ON slotlock.approvals (tenant_ref, created_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS slotlock_approvals_expiry_idx
  ON slotlock.approvals (expires_at) WHERE status = 'pending';

-- Stored hours (RFC 0004 B2): the tenant's (no location) and each location's. A resource without
-- its own inherits its location's, the nearest up the chain, then its tenant's, then the server's.
-- Rules are written validated (weekly rules, at most 50).
CREATE TABLE IF NOT EXISTS slotlock.availability_defaults (
  tenant_ref text NOT NULL,
  location_ref text,
  rules jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_availability_defaults_location_fkey FOREIGN KEY (tenant_ref, location_ref)
    REFERENCES slotlock.locations (tenant_ref, ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_availability_defaults_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 50
    AND octet_length(rules::text) <= 65536
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_availability_defaults_scope_idx
  ON slotlock.availability_defaults (tenant_ref, (COALESCE(location_ref, '')));

-- Exceptions to the weekly hours (RFC 0004 B1): whole local days, closed or open with hours of
-- their own, for the tenant, a location (and every resource inside it) or one resource. An import
-- names its source's id, so importing again updates the same row.
CREATE TABLE IF NOT EXISTS slotlock.availability_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL,
  location_ref text,
  resource_id uuid,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  outcome text NOT NULL,
  hours jsonb,
  label text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  source_uid text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_availability_exceptions_location_fkey FOREIGN KEY (tenant_ref, location_ref)
    REFERENCES slotlock.locations (tenant_ref, ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_availability_exceptions_resource_fkey FOREIGN KEY (resource_id, tenant_ref)
    REFERENCES slotlock.resources (id, tenant_ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_availability_exceptions_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND (location_ref IS NULL OR resource_id IS NULL)
    AND ends_on >= starts_on AND ends_on - starts_on < 367
    AND outcome IN ('closed', 'open')
    AND ((outcome = 'open') = (hours IS NOT NULL))
    AND (hours IS NULL OR (jsonb_typeof(hours) = 'array' AND jsonb_array_length(hours) BETWEEN 1 AND 4))
    AND char_length(label) BETWEEN 1 AND 200 AND btrim(label) <> ''
    AND source IN ('manual', 'ics', 'vavailability')
    AND (source_uid IS NULL OR octet_length(source_uid) BETWEEN 1 AND 600)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_availability_exceptions_source_idx
  ON slotlock.availability_exceptions
     (tenant_ref, (COALESCE(location_ref, '')), (COALESCE(resource_id::text, '')), source_uid)
  WHERE source_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS slotlock_availability_exceptions_days_idx
  ON slotlock.availability_exceptions (tenant_ref, ends_on, starts_on);
CREATE INDEX IF NOT EXISTS slotlock_availability_exceptions_resource_idx
  ON slotlock.availability_exceptions (resource_id) WHERE resource_id IS NOT NULL;

-- A holiday calendar imported into closures (RFC 0004 B1), for the tenant, a location or a
-- resource, by name: its closures name it, so importing it again removes the holidays it has
-- dropped. With a URL it is a subscription, which maintenance imports again by next_import_at.
-- Deleting it deletes its closures.
CREATE TABLE IF NOT EXISTS slotlock.holiday_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL,
  location_ref text,
  resource_id uuid,
  name text NOT NULL,
  url text,
  imported_at timestamptz,
  next_import_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_holiday_calendars_tenant_key UNIQUE (id, tenant_ref),
  CONSTRAINT slotlock_holiday_calendars_location_fkey FOREIGN KEY (tenant_ref, location_ref)
    REFERENCES slotlock.locations (tenant_ref, ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_holiday_calendars_resource_fkey FOREIGN KEY (resource_id, tenant_ref)
    REFERENCES slotlock.resources (id, tenant_ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_holiday_calendars_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND (location_ref IS NULL OR resource_id IS NULL)
    AND char_length(name) BETWEEN 1 AND 200 AND btrim(name) <> ''
    AND (url IS NULL OR (url ~ '^https://' AND octet_length(url) <= 2048))
    AND (next_import_at IS NULL OR url IS NOT NULL)
    AND (last_error IS NULL OR char_length(last_error) <= 500)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_holiday_calendars_name_idx
  ON slotlock.holiday_calendars (tenant_ref, (COALESCE(location_ref, '')), (COALESCE(resource_id::text, '')), name);
CREATE INDEX IF NOT EXISTS slotlock_holiday_calendars_due_idx
  ON slotlock.holiday_calendars (tenant_ref, next_import_at) WHERE next_import_at IS NOT NULL;
-- The calendar an imported closure came from: NULL for one added by hand, or imported before
-- calendars were kept (claimed by the next import of a calendar that names it).
ALTER TABLE slotlock.availability_exceptions ADD COLUMN IF NOT EXISTS calendar_id uuid;
DO $slotlock_exception_calendar$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_availability_exceptions_calendar_fkey'
       AND conrelid = 'slotlock.availability_exceptions'::regclass
  ) THEN
    ALTER TABLE slotlock.availability_exceptions
      ADD CONSTRAINT slotlock_availability_exceptions_calendar_fkey FOREIGN KEY (calendar_id, tenant_ref)
      REFERENCES slotlock.holiday_calendars (id, tenant_ref) ON DELETE CASCADE;
  END IF;
END
$slotlock_exception_calendar$;
CREATE INDEX IF NOT EXISTS slotlock_availability_exceptions_calendar_idx
  ON slotlock.availability_exceptions (calendar_id) WHERE calendar_id IS NOT NULL;

-- The hours a resource without its own inherits: its location's, the nearest up the chain, else its
-- tenant's, as {source, location?, rules}; NULL leaves the server's default. Runs as the caller, so
-- row-level security keeps it inside the tenant.
CREATE OR REPLACE FUNCTION slotlock.inherited_availability(requested_tenant_ref text, requested_location_ref text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_inherited_availability$
  WITH RECURSIVE up(ref, parent_ref, steps) AS (
    SELECT place.ref, place.parent_ref, 1 FROM slotlock.locations place
     WHERE requested_location_ref IS NOT NULL
       AND place.tenant_ref = requested_tenant_ref AND place.ref = requested_location_ref
    UNION ALL
    SELECT place.ref, place.parent_ref, up.steps + 1
      FROM slotlock.locations place JOIN up ON place.tenant_ref = requested_tenant_ref AND place.ref = up.parent_ref
     WHERE up.steps <= ${SLOTLOCK_MAX_LOCATION_DEPTH}
  )
  SELECT COALESCE(
    (SELECT jsonb_build_object('source', 'location', 'location', up.ref, 'rules', defaults.rules)
       FROM up JOIN slotlock.availability_defaults defaults
         ON defaults.tenant_ref = requested_tenant_ref AND defaults.location_ref = up.ref
      ORDER BY up.steps LIMIT 1),
    (SELECT jsonb_build_object('source', 'tenant', 'rules', defaults.rules)
       FROM slotlock.availability_defaults defaults
      WHERE defaults.tenant_ref = requested_tenant_ref AND defaults.location_ref IS NULL)
  );
$slotlock_inherited_availability$;

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
-- A turnaround may run to a week (RFC 0004 B3): the wider check admits every row the old one did,
-- so it is added NOT VALID (no scan under the lock), and the old one dropped.
DO $slotlock_calendar_event_week_turnaround$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.calendar_events'::regclass
       AND conname = 'slotlock_calendar_events_buffer_week_valid'
  ) THEN
    ALTER TABLE slotlock.calendar_events
      ADD CONSTRAINT slotlock_calendar_events_buffer_week_valid
      CHECK (buffer_after_ms BETWEEN 0 AND 604800000) NOT VALID;
  END IF;
  ALTER TABLE slotlock.calendar_events DROP CONSTRAINT IF EXISTS slotlock_calendar_events_buffer_valid;
END
$slotlock_calendar_event_week_turnaround$;
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

-- Zone rule changes reach everything (RFC 0004 B9): a series' occurrences, and reservations that
-- carry the wall time they were booked for, keep it, so maintenance finds those whose wall time now
-- falls at another instant. An occurrence's is its series' zone's wall time when written; a
-- reservation's is what the writer gave (local_start), in its resource's zone.
ALTER TABLE slotlock.calendar_event_occurrences ADD COLUMN IF NOT EXISTS wall_starts_at timestamp;
ALTER TABLE slotlock.calendar_event_occurrences ADD COLUMN IF NOT EXISTS zone_shift_reported_at timestamptz;
CREATE OR REPLACE FUNCTION slotlock.calendar_event_occurrence_wall_time()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_occurrence_wall_time$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
    NEW.wall_starts_at := slotlock.zoned_wall(
      NEW.starts_at, (SELECT event.timezone FROM slotlock.calendar_events event WHERE event.id = NEW.event_id));
    NEW.zone_shift_reported_at := NULL;
  END IF;
  RETURN NEW;
END
$slotlock_occurrence_wall_time$;
DROP TRIGGER IF EXISTS slotlock_calendar_event_occurrence_wall_time ON slotlock.calendar_event_occurrences;
CREATE TRIGGER slotlock_calendar_event_occurrence_wall_time
  BEFORE INSERT OR UPDATE ON slotlock.calendar_event_occurrences
  FOR EACH ROW EXECUTE FUNCTION slotlock.calendar_event_occurrence_wall_time();
-- Occurrences to come written before this release: their wall time as the rules read now. A new
-- database has none, and may not have slotlock.zoned_wall yet at this point.
DO $slotlock_occurrence_wall_backfill$
BEGIN
  IF to_regprocedure('slotlock.zoned_wall(timestamptz, text)') IS NOT NULL THEN
    EXECUTE $backfill$
      UPDATE slotlock.calendar_event_occurrences occurrence
         SET wall_starts_at = slotlock.zoned_wall(occurrence.starts_at, event.timezone)
        FROM slotlock.calendar_events event
       WHERE event.id = occurrence.event_id AND occurrence.wall_starts_at IS NULL
         AND occurrence.starts_at > now()
    $backfill$;
  END IF;
END
$slotlock_occurrence_wall_backfill$;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS wall_starts_at timestamp;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS zone_shift_reported_at timestamptz;

-- Integrations (RFC 0004 P3). Core never sends a message and never holds a provider token; it keeps
-- what the packages that do need. A booking may name the person to tell (contact_ref) and say not
-- to tell anyone (notify); a hold may wait for the integrator's payment before it is confirmed.
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS contact_ref text;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS notify boolean NOT NULL DEFAULT true;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS payment_required boolean NOT NULL DEFAULT false;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS payment_ref text;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS paid_at timestamptz;
-- What a hold's payment must be, and what was received (RFC 0004 C3), in the currency's minor unit.
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS payment_amount_minor bigint;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS payment_currency text;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS paid_amount_minor bigint;
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS paid_currency text;
ALTER TABLE slotlock.calendar_events ADD COLUMN IF NOT EXISTS notify boolean NOT NULL DEFAULT true;
DO $slotlock_integration_columns$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slotlock_reservations_integration_valid'
                    AND conrelid = 'slotlock.reservations'::regclass) THEN
    ALTER TABLE slotlock.reservations ADD CONSTRAINT slotlock_reservations_integration_valid CHECK (
      (contact_ref IS NULL OR contact_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$')
      AND (payment_ref IS NULL OR octet_length(payment_ref) BETWEEN 1 AND 255)
      AND (paid_at IS NULL OR payment_ref IS NOT NULL)
    ) NOT VALID;
  END IF;
END
$slotlock_integration_columns$;
DO $slotlock_payment_amounts$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slotlock_reservations_payment_amounts_valid'
                    AND conrelid = 'slotlock.reservations'::regclass) THEN
    ALTER TABLE slotlock.reservations ADD CONSTRAINT slotlock_reservations_payment_amounts_valid CHECK (
      (payment_amount_minor IS NULL) = (payment_currency IS NULL)
      AND (paid_amount_minor IS NULL) = (paid_currency IS NULL)
      AND (payment_amount_minor IS NULL OR payment_amount_minor BETWEEN 0 AND 1000000000000)
      AND (paid_amount_minor IS NULL OR paid_amount_minor BETWEEN 0 AND 1000000000000)
      AND (payment_currency IS NULL OR payment_currency ~ '^[A-Z]{3}$')
      AND (paid_currency IS NULL OR paid_currency ~ '^[A-Z]{3}$')
    ) NOT VALID;
  END IF;
END
$slotlock_payment_amounts$;
-- Forgetting a person finds the bookings that name them.
CREATE INDEX IF NOT EXISTS slotlock_reservations_contact_idx
  ON slotlock.reservations (tenant_ref, contact_ref) WHERE contact_ref IS NOT NULL;

-- The people a tenant's bookings may tell (RFC 0004 P3): how to reach each, and what each agreed
-- to. A person is erased by deleting their row; bookings keep no copy of what it held.
CREATE TABLE IF NOT EXISTS slotlock.contacts (
  tenant_ref text NOT NULL,
  ref text NOT NULL,
  name text,
  email text,
  phone text,
  whatsapp text,
  consent jsonb NOT NULL DEFAULT '{}'::jsonb,
  locale text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_ref, ref),
  CONSTRAINT slotlock_contacts_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
    AND (name IS NULL OR char_length(name) BETWEEN 1 AND 200)
    AND (email IS NULL OR (char_length(email) BETWEEN 3 AND 320 AND email LIKE '%_@_%'))
    AND (phone IS NULL OR phone ~ '^[+][1-9][0-9]{6,14}$')
    AND (whatsapp IS NULL OR whatsapp ~ '^[+][1-9][0-9]{6,14}$')
    AND jsonb_typeof(consent) = 'object' AND octet_length(consent::text) <= 512
    AND (locale IS NULL OR locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$')
  )
);

-- Each reminder once (RFC 0004 P3): when maintenance put reminder.due on the feed for an
-- occurrence, so a later pass never says it again.
CREATE TABLE IF NOT EXISTS slotlock.reminder_dispatches (
  tenant_ref text NOT NULL,
  event_id uuid NOT NULL,
  recurrence_id text NOT NULL,
  ordinal integer NOT NULL,
  due_at timestamptz NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (event_id, recurrence_id, ordinal),
  CONSTRAINT slotlock_reminder_dispatches_event_fkey FOREIGN KEY (event_id, tenant_ref)
    REFERENCES slotlock.calendar_events (id, tenant_ref) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS slotlock_reminder_dispatches_tenant_idx
  ON slotlock.reminder_dispatches (tenant_ref, due_at);

-- A booking's reminders (RFC 0004 P3): minutes before its start, at most five; each said once on
-- the feed as reminder.due, and again if the booking moves.
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS reminder_minutes integer[];
DO $slotlock_reservation_reminders$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slotlock_reservations_reminders_valid'
                    AND conrelid = 'slotlock.reservations'::regclass) THEN
    ALTER TABLE slotlock.reservations ADD CONSTRAINT slotlock_reservations_reminders_valid CHECK (
      reminder_minutes IS NULL
      OR (cardinality(reminder_minutes) BETWEEN 1 AND 5
          AND 0 <= ALL (reminder_minutes) AND 527040 >= ALL (reminder_minutes))
    ) NOT VALID;
  END IF;
END
$slotlock_reservation_reminders$;
CREATE TABLE IF NOT EXISTS slotlock.reservation_reminder_dispatches (
  tenant_ref text NOT NULL,
  reservation_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4),
  due_at timestamptz NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (reservation_id, ordinal),
  CONSTRAINT slotlock_reservation_reminder_dispatches_fkey FOREIGN KEY (reservation_id, tenant_ref)
    REFERENCES slotlock.reservations (id, tenant_ref) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS slotlock_reservation_reminder_dispatches_tenant_idx
  ON slotlock.reservation_reminder_dispatches (tenant_ref, due_at);

-- Each hold's payment, kept once recorded (RFC 0004 C3), however the hold ends: confirmed in place,
-- booked as an event (its row deleted), released or expired. So the same payment, told again later,
-- is answered as the payment already recorded, never as one to refund.
CREATE TABLE IF NOT EXISTS slotlock.hold_payments (
  tenant_ref text NOT NULL,
  hold_id uuid PRIMARY KEY,
  resource_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  buffer_after_ms bigint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  payment_ref text NOT NULL CHECK (octet_length(payment_ref) BETWEEN 1 AND 255),
  paid_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  payment_amount_minor bigint,
  payment_currency text,
  paid_amount_minor bigint,
  paid_currency text,
  CONSTRAINT slotlock_hold_payments_resource_fkey FOREIGN KEY (resource_id, tenant_ref)
    REFERENCES slotlock.resources (id, tenant_ref) ON DELETE CASCADE
);
-- Whether a paid hold was booked (RFC 0004 C3): confirmed, or booked from by a write that named it
-- (booked_at), or taken over by an approval (approval_id) and so booked as that approval goes. A
-- payment whose hold ended any other way was never applied: markHoldPaid answers it hold_ended, and
-- the feed's hold.expired or hold.released says so (payment_unapplied), for the payment to be
-- refunded. Payments recorded before this was kept are taken as applied: none is refunded unasked.
DO $slotlock_hold_payments_outcome$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'slotlock' AND table_name = 'hold_payments' AND column_name = 'booked_at'
  ) THEN
    ALTER TABLE slotlock.hold_payments ADD COLUMN booked_at timestamptz, ADD COLUMN approval_id uuid;
    UPDATE slotlock.hold_payments payment SET booked_at = payment.paid_at
     WHERE NOT EXISTS (SELECT 1 FROM slotlock.reservations hold
                        WHERE hold.id = payment.hold_id AND hold.status = 'held');
  END IF;
END
$slotlock_hold_payments_outcome$;
-- When each channel's consent was last given or withdrawn, as proof of it.
ALTER TABLE slotlock.contacts ADD COLUMN IF NOT EXISTS consent_at jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Busy time a calendar reports without its events (Google freeBusy, Microsoft getSchedule), for one
-- resource and source (RFC 0004 C1): replaced window by window with the source's coverage, counted
-- in free/busy and refused to every booking Slotlock makes, as an event's time would be.
CREATE TABLE IF NOT EXISTS slotlock.source_busy (
  tenant_ref text NOT NULL,
  resource_id uuid NOT NULL,
  source text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  CONSTRAINT slotlock_source_busy_resource_fkey FOREIGN KEY (resource_id, tenant_ref)
    REFERENCES slotlock.resources (id, tenant_ref) ON DELETE CASCADE,
  CONSTRAINT slotlock_source_busy_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500 AND octet_length(source) BETWEEN 1 AND 500
    AND ends_at > starts_at
  )
);
CREATE INDEX IF NOT EXISTS slotlock_source_busy_resource_idx
  ON slotlock.source_busy (resource_id, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS slotlock_source_busy_source_idx
  ON slotlock.source_busy (resource_id, source, starts_at);
-- Busy time that ended long ago goes in retention (pruneBookingRetention), tenant by tenant.
CREATE INDEX IF NOT EXISTS slotlock_source_busy_ended_idx
  ON slotlock.source_busy (tenant_ref, ends_at);

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
${SLOTLOCK_OUTBOX_DDL}${SLOTLOCK_API_KEYS_DDL}${SLOTLOCK_PARTNER_DDL}${SLOTLOCK_DASHBOARD_DDL}${SLOTLOCK_TENANT_ADMIN_DDL}${DEPLOYMENT_RECORD_VERSION}`;

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
  'assistant_chats',
  'audit_events',
  'locations',
  'resource_groups',
  'resource_group_members',
  'pool_settings',
  'composite_claims',
  'approval_policies',
  'approvals',
  'availability_defaults',
  'availability_exceptions',
  'holiday_calendars',
  'contacts',
  'reminder_dispatches',
  'reservation_reminder_dispatches',
  'hold_payments',
  'source_busy',
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
  const appendOnly: readonly string[] = SLOTLOCK_APPEND_ONLY_TABLES;
  const tables = SLOTLOCK_TENANT_TABLES.filter((table) => !appendOnly.includes(table))
    .map((table) => `slotlock.${table}`)
    .join(', ');
  const added = SLOTLOCK_APPEND_ONLY_TABLES.map((table) => `slotlock.${table}`).join(', ');
  return `GRANT USAGE ON SCHEMA slotlock TO "${role}";
GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables} TO "${role}";
GRANT SELECT, INSERT ON ${added} TO "${role}";
REVOKE UPDATE, DELETE ON ${added} FROM "${role}";
GRANT EXECUTE ON FUNCTION ${SLOTLOCK_DEFINER_FUNCTIONS.join(', ')} TO "${role}";
`;
}

/**
 * Build the production-hardening DDL for a tenant context setting. The default setting is
 * `slotlock.tenant_ref`; adapters may supply an established transaction-local setting name.
 * Every policy fails closed when the setting is absent or empty, and FORCE binds the table owner.
 */
/**
 * The transaction-local setting withTenant sets for a key limited to part of its tenant (RFC 0003
 * G6): the ids of the resources it reaches, as a uuid[] literal; empty for every other caller.
 */
export const SLOTLOCK_RESOURCE_SCOPE_SETTING = 'slotlock.resource_scope';

const RESOURCE_SCOPE_OPEN = `NULLIF(current_setting('${SLOTLOCK_RESOURCE_SCOPE_SETTING}', true), '') IS NULL`;
const resourceScopeAllows = (column: string) =>
  `(${RESOURCE_SCOPE_OPEN} OR ${column} = ANY (NULLIF(current_setting('${SLOTLOCK_RESOURCE_SCOPE_SETTING}', true), '')::uuid[]))`;

/**
 * The tables a key limited to part of its tenant is held to, and how each row names its resource:
 * the resource itself, or the event it belongs to. Tombstones and archives name none and stay as the
 * tenant policy leaves them.
 */
export const SLOTLOCK_RESOURCE_SCOPED_TABLES: Readonly<Record<string, string>> = Object.freeze({
  resources: resourceScopeAllows('id'),
  reservations: resourceScopeAllows('resource_id'),
  calendar_events: resourceScopeAllows('resource_id'),
  calendar_coverage: resourceScopeAllows('resource_id'),
  hold_commands: resourceScopeAllows('resource_id'),
  resource_group_members: resourceScopeAllows('resource_id'),
  // A change or a waitlist entry about no one resource (a key, a pool) is not the key's.
  outbox: resourceScopeAllows('resource_id'),
  waitlist_entries: resourceScopeAllows('resource_id'),
  // The tenant's and locations' exceptions shape every resource's hours, so every key reads them.
  availability_exceptions: `(resource_id IS NULL OR ${resourceScopeAllows('resource_id')})`,
  holiday_calendars: `(resource_id IS NULL OR ${resourceScopeAllows('resource_id')})`,
  source_busy: resourceScopeAllows('resource_id'),
  hold_payments: resourceScopeAllows('resource_id'),
  ...Object.fromEntries(
    [
      'calendar_event_attendees',
      'calendar_event_reminders',
      'calendar_event_exceptions',
      'calendar_event_occurrences',
      'calendar_event_commands',
    ].map((table) => [
      table,
      `(${RESOURCE_SCOPE_OPEN} OR EXISTS (SELECT 1 FROM slotlock.calendar_events scoped_event WHERE scoped_event.id = event_id))`,
    ]),
  ),
});

/**
 * One restrictive policy on each table SLOTLOCK_RESOURCE_SCOPED_TABLES names: it only narrows what
 * the tenant policy allows, for reads and writes alike, and is open when no scope is set.
 */
const SLOTLOCK_RESOURCE_SCOPE_POLICIES = Object.entries(SLOTLOCK_RESOURCE_SCOPED_TABLES)
  .map(
    ([table, allows]) =>
      `CREATE POLICY resource_scope_v1 ON slotlock.${table} AS RESTRICTIVE USING ${allows} WITH CHECK ${allows};`,
  )
  .join('\n');

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
ALTER TABLE slotlock.assistant_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.assistant_chats FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.locations FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.resource_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.resource_groups FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.resource_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.resource_group_members FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.pool_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.pool_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.composite_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.composite_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.approval_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.approval_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.availability_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.availability_defaults FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.availability_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.availability_exceptions FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.reminder_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.reminder_dispatches FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.reservation_reminder_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.reservation_reminder_dispatches FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.hold_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.hold_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.holiday_calendars ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.holiday_calendars FORCE ROW LEVEL SECURITY;
ALTER TABLE slotlock.source_busy ENABLE ROW LEVEL SECURITY;
ALTER TABLE slotlock.source_busy FORCE ROW LEVEL SECURITY;

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
         'assistant_chats',
         'audit_events',
         'locations',
         'resource_groups',
         'resource_group_members',
         'pool_settings',
         'composite_claims',
         'approval_policies',
         'approvals',
         'availability_defaults',
         'availability_exceptions',
         'holiday_calendars',
         'contacts',
         'reminder_dispatches',
         'reservation_reminder_dispatches',
         'hold_payments',
         'source_busy'
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
     WHERE schemaname = 'slotlock' AND tablename = 'assistant_chats'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.assistant_chats
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'audit_events'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.audit_events
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'composite_claims'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.composite_claims
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'approval_policies'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.approval_policies
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'approvals'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.approvals
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'availability_defaults'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.availability_defaults
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'availability_exceptions'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.availability_exceptions
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'contacts'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.contacts
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'reminder_dispatches'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.reminder_dispatches
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'reservation_reminder_dispatches'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.reservation_reminder_dispatches
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'hold_payments'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.hold_payments
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'holiday_calendars'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.holiday_calendars
      USING (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''))
      WITH CHECK (tenant_ref = NULLIF(current_setting('${tenantContextSetting}', true), ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'slotlock' AND tablename = 'source_busy'
       AND policyname = 'tenant_isolation_v1'
  ) THEN
    CREATE POLICY tenant_isolation_v1 ON slotlock.source_busy
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
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.assistant_chats
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.audit_events
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.locations
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.resource_groups
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.resource_group_members
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.pool_settings
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.composite_claims
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.approval_policies
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.approvals
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.availability_defaults
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.availability_exceptions
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.contacts
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.reminder_dispatches
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.reservation_reminder_dispatches
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.hold_payments
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.holiday_calendars
  IS 'slotlock:tenant-context:${tenantContextSetting}';
COMMENT ON POLICY tenant_isolation_v1 ON slotlock.source_busy
  IS 'slotlock:tenant-context:${tenantContextSetting}';
${SLOTLOCK_RESOURCE_SCOPE_POLICIES}

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
    'assistant_chats',
    'audit_events',
    'locations',
    'resource_groups',
    'resource_group_members',
    'pool_settings',
    'composite_claims',
    'approval_policies',
    'approvals',
    'availability_defaults',
    'availability_exceptions',
    'holiday_calendars',
    'contacts',
    'reminder_dispatches',
    'reservation_reminder_dispatches',
    'hold_payments',
    'source_busy'
  )
  AND policyname = 'tenant_isolation_v1'
ON CONFLICT (table_name) DO UPDATE
SET tenant_context_setting = EXCLUDED.tenant_context_setting,
    policy_fingerprint = EXCLUDED.policy_fingerprint,
    installed_at = EXCLUDED.installed_at;
${DEPLOYMENT_SEARCH_PATH_RESTORE}`;
}

export const SLOTLOCK_TENANT_RLS_DDL = createSlotlockTenantRlsDdl();
