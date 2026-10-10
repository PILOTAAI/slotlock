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
const CALLER_SEARCH_PATH_SETTING = 'slotlock.caller_search_path';
const DEPLOYMENT_SEARCH_PATH_PIN = `SELECT pg_catalog.set_config('${CALLER_SEARCH_PATH_SETTING}', pg_catalog.current_setting('search_path'), true);
SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
`;
const DEPLOYMENT_SEARCH_PATH_RESTORE = `SELECT pg_catalog.set_config('search_path', pg_catalog.current_setting('${CALLER_SEARCH_PATH_SETTING}'), true);
`;

/** The start of the message with which the deployment DDL refuses a `slotlock` schema. */
export const SLOTLOCK_SCHEMA_CONTROL_REFUSAL = 'Slotlock will not deploy into schema slotlock';

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

/** Active (unrevoked, unexpired) API keys one tenant may hold. */
export const SLOTLOCK_API_KEY_ACTIVE_LIMIT = 100;
/** API keys one tenant may hold in all, revoked and expired ones included, so lists stay bounded. */
export const SLOTLOCK_API_KEY_RETAINED_LIMIT = 1_000;

/**
 * The tables behind API keys. No role but their owner holds a right on them; they are reached only
 * through SLOTLOCK_API_KEY_FUNCTIONS.
 */
export const SLOTLOCK_API_KEY_TABLES = Object.freeze(['api_keys', 'api_key_retired_digests'] as const);

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
  CONSTRAINT slotlock_api_keys_scopes_valid
    CHECK (scopes IN (ARRAY['read']::text[], ARRAY['write']::text[], ARRAY['read', 'write']::text[])),
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

// btree_gist is created in slotlock when it is missing; one installed elsewhere stays where it is.
export const SLOTLOCK_CORE_DDL: string = `
${DEPLOYMENT_SEARCH_PATH_PIN}CREATE SCHEMA IF NOT EXISTS slotlock;
${SLOTLOCK_SCHEMA_CONTROL_CHECK}CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA slotlock;

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
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
);

-- Idempotent evolution for pre-holds spike schemas: columns AND the shape CHECKs bind on
-- evolved tables too, so every applied schema enforces identical invariants.
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'confirmed';
ALTER TABLE slotlock.reservations ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE slotlock.resources ADD COLUMN IF NOT EXISTS tenant_ref text;
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

CREATE UNIQUE INDEX IF NOT EXISTS slotlock_reservations_tenant_external_ref_key
  ON slotlock.reservations (tenant_ref, external_ref)
  WHERE tenant_ref IS NOT NULL AND external_ref IS NOT NULL;

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
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_reservations_buffered_no_overlap'
       AND conrelid = 'slotlock.reservations'::regclass
  ) THEN
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_buffered_no_overlap EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(starts_at, occupied_ends_at, '[)') WITH &&
      ) WHERE (tenant_ref IS NOT NULL);
  END IF;
END $$;

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
  -- A recurring series expands inside a window of at most 367 days. A one-off event is its own
  -- window, so a lease or long rental may span up to 3,660 days (the store's hard ceiling).
  CONSTRAINT slotlock_calendar_events_materialization_window_bounded CHECK (
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
     WHERE conname = 'slotlock_calendar_events_materialization_window_bounded'
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
${SLOTLOCK_API_KEYS_DDL}${DEPLOYMENT_SEARCH_PATH_RESTORE}`;

export const SLOTLOCK_TENANT_CONTEXT_SETTING = 'slotlock.tenant_ref';

/**
 * Every table the store reads or writes at runtime, each under forced tenant RLS.
 * `slotlock.rls_policy_contracts` is deployment-only and deliberately absent.
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
] as const);

const POSTGRES_SETTING_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const POSTGRES_ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
/** Names GRANT reads as a pseudo-role (PUBLIC reaches every role) or PostgreSQL reserves. */
const RESERVED_ROLE_NAMES = new Set(['public', 'current_role', 'current_user', 'session_user']);

/**
 * Build the grants for the application role: USAGE on the `slotlock` schema, DML on the store's
 * tables and EXECUTE on the API key functions. Nothing else: no ownership, DDL, sequence,
 * RLS-contract or API key table access. The role must not be
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
GRANT EXECUTE ON FUNCTION ${SLOTLOCK_API_KEY_FUNCTIONS.join(', ')} TO "${role}";
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
${DEPLOYMENT_SEARCH_PATH_PIN}${SLOTLOCK_SCHEMA_CONTROL_CHECK}ALTER TABLE slotlock.resources ENABLE ROW LEVEL SECURITY;
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
         'calendar_coverage'
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
    'calendar_coverage'
  )
  AND policyname = 'tenant_isolation_v1'
ON CONFLICT (table_name) DO UPDATE
SET tenant_context_setting = EXCLUDED.tenant_context_setting,
    policy_fingerprint = EXCLUDED.policy_fingerprint,
    installed_at = EXCLUDED.installed_at;
${DEPLOYMENT_SEARCH_PATH_RESTORE}`;
}

export const SLOTLOCK_TENANT_RLS_DDL = createSlotlockTenantRlsDdl();
