// Teams phase 5.3–5.5: single sign-on through a team's own identity provider (OpenID Connect; the
// tokens are checked in oidc.ts, before any of this is called). Reached only through the SECURITY
// DEFINER functions below, as the rest of the dashboard's records are.
//
// The rules the database holds, whatever the caller does:
// - An identity is the provider's subject (issuer and `sub`; Entra's tenant and object id too),
//   never an email. A sign-in never attaches to an existing person by email.
// - An email from a team's provider is trusted only at a domain that same team has verified.
// - A person signed in through a team's provider alone acts in that team alone: their session is
//   scoped to it (dashboard_sessions.sso_connection_id), so the team's provider, which its Owner
//   controls, never reaches the person's other workspaces.
// - A team that requires single sign-on gives no role to a session without a recent proof from its
//   provider, or an Owner's bypass; dashboard_standing says so, so a caller that forgets fails closed.
// - The provider never makes an Owner, and never changes one.

import { SLOTLOCK_PERSON_PATTERN } from './ddl-identity.js';

const PERSON = SLOTLOCK_PERSON_PATTERN;

/** The tables of single sign-on: their owner's only. */
export const SLOTLOCK_SSO_TABLES = Object.freeze([
  'sso_connections',
  'sso_identities',
  'sso_role_mappings',
  'dashboard_session_sso',
  'sso_bypasses',
] as const);

/** The SECURITY DEFINER functions through which the serving role reaches them. */
export const SLOTLOCK_SSO_FUNCTIONS = Object.freeze([
  'slotlock.save_sso_connection(text, text, uuid, text, text, text, text, text, text, text, text, text[], boolean, text)',
  'slotlock.sso_connection_of(text)',
  'slotlock.sso_connection_by_id(uuid)',
  'slotlock.sso_connection_route(text, text)',
  'slotlock.record_sso_test(text, text, uuid, integer, jsonb)',
  'slotlock.set_sso_connection_status(text, text, uuid, text)',
  'slotlock.delete_sso_connection(text, text, uuid)',
  'slotlock.set_sso_provisioning(text, text, boolean, text, text)',
  'slotlock.set_sso_role_mapping(text, text, text, text)',
  'slotlock.sso_role_mappings_of(text)',
  'slotlock.sso_sign_in(uuid, text, text, text, text, text, boolean, text[], boolean, boolean, text, integer)',
  'slotlock.record_sso_proof(bytea, text, uuid, boolean, integer)',
  'slotlock.set_require_sso(text, text, bytea, boolean, integer)',
  'slotlock.sso_owner_bypass(text, text, bytea)',
  'slotlock.prune_sso()',
] as const);

/** How long a proof from a team's provider lasts by default, and the range an Owner may set. */
export const SLOTLOCK_SSO_MAX_AGE_HOURS = Object.freeze({ default: 24, min: 1, max: 168 });
/** How fresh a proof must be to turn "require single sign-on" on. */
export const SLOTLOCK_SSO_ENABLE_PROOF_MINUTES = 10;
/** How long an Owner's bypass lasts. */
export const SLOTLOCK_SSO_BYPASS_MINUTES = 60;

const fn = SLOTLOCK_SSO_FUNCTIONS;
const NOT_SSO = `!~ '^sso:'`;

export const SLOTLOCK_SSO_DDL = `
-- A team's connection to its identity provider: one per team. The client secret is sealed by the
-- application (AES-256-GCM, oidc.ts) with the team and connection as associated data; only its last
-- four characters are kept in the clear. The endpoints are the provider's discovery document's when
-- the Owner saved it; a change to the issuer, client or secret returns it to draft until tested.
CREATE TABLE IF NOT EXISTS slotlock.sso_connections (
  id uuid PRIMARY KEY,
  tenant_ref text NOT NULL REFERENCES slotlock.workspaces (tenant_ref) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  issuer text NOT NULL,
  client_id text NOT NULL,
  secret_sealed text,
  secret_last4 text,
  authorization_endpoint text NOT NULL,
  token_endpoint text NOT NULL,
  jwks_uri text NOT NULL,
  algorithms text[] NOT NULL,
  iss_parameter boolean NOT NULL DEFAULT false,
  entra_tenant text,
  groups_claim text NOT NULL DEFAULT 'groups',
  jit_enabled boolean NOT NULL DEFAULT true,
  default_role text NOT NULL DEFAULT 'viewer',
  config_version integer NOT NULL DEFAULT 1,
  tested_version integer,
  last_tested_at timestamptz,
  last_test_claims jsonb,
  tested_by text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_sso_connections_tenant_key UNIQUE (tenant_ref),
  CONSTRAINT slotlock_sso_connections_valid CHECK (
    kind IN ('okta', 'entra', 'google_workspace', 'oidc')
    AND status IN ('draft', 'tested', 'active', 'disabled')
    AND char_length(issuer) <= 500 AND issuer ~ '^https://[^[:space:][:cntrl:]]+$'
    AND char_length(client_id) BETWEEN 1 AND 255 AND client_id !~ '[[:space:][:cntrl:]]'
    AND (secret_sealed IS NULL OR char_length(secret_sealed) BETWEEN 1 AND 2048)
    AND (secret_last4 IS NULL OR char_length(secret_last4) BETWEEN 1 AND 4)
    AND authorization_endpoint ~ '^https://' AND token_endpoint ~ '^https://' AND jwks_uri ~ '^https://'
    AND cardinality(algorithms) BETWEEN 1 AND 3 AND algorithms <@ ARRAY['RS256', 'PS256', 'ES256']
    AND (entra_tenant IS NULL OR entra_tenant ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    AND (kind <> 'entra' OR entra_tenant IS NOT NULL)
    AND groups_claim ~ '^[A-Za-z0-9_:./-]{1,100}$'
    AND default_role IN ('viewer', 'member', 'developer')
    AND config_version >= 1
    AND (created_by IS NULL OR created_by ~ '${PERSON}')
    AND (tested_by IS NULL OR tested_by ~ '${PERSON}')
    AND (last_test_claims IS NULL OR (jsonb_typeof(last_test_claims) = 'object' AND pg_column_size(last_test_claims) <= 8192))
  )
);
ALTER TABLE slotlock.sso_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.sso_connections FROM PUBLIC;

-- Who the provider says signed in: its subject, under the connection, and the person it is.
CREATE TABLE IF NOT EXISTS slotlock.sso_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES slotlock.sso_connections (id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  entra_tid text,
  entra_oid text,
  person_ref text NOT NULL,
  email_last text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_sso_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- When the person linked another account in its place: kept, so its address stays theirs (a
  -- removal blocks it) and it signs in as nobody.
  replaced_at timestamptz,
  CONSTRAINT slotlock_sso_identities_subject_key UNIQUE (connection_id, issuer, subject),
  CONSTRAINT slotlock_sso_identities_valid CHECK (
    char_length(subject) BETWEEN 1 AND 255
    AND person_ref ~ '${PERSON}'
    AND (email_last IS NULL OR char_length(email_last) BETWEEN 3 AND 254)
    AND (entra_oid IS NULL) = (entra_tid IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_sso_identities_entra_key
  ON slotlock.sso_identities (connection_id, entra_tid, entra_oid) WHERE entra_oid IS NOT NULL;
CREATE INDEX IF NOT EXISTS slotlock_sso_identities_person_idx ON slotlock.sso_identities (person_ref);
-- One account at a team's provider a person: linking another replaces it.
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_sso_identities_person_key ON slotlock.sso_identities (connection_id, person_ref)
  WHERE replaced_at IS NULL;
ALTER TABLE slotlock.sso_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.sso_identities FROM PUBLIC;

-- What a provider group (or app role) gives: any role but Owner.
CREATE TABLE IF NOT EXISTS slotlock.sso_role_mappings (
  connection_id uuid NOT NULL REFERENCES slotlock.sso_connections (id) ON DELETE CASCADE,
  idp_value text NOT NULL,
  role text NOT NULL,
  CONSTRAINT slotlock_sso_role_mappings_pkey PRIMARY KEY (connection_id, idp_value),
  CONSTRAINT slotlock_sso_role_mappings_valid CHECK (
    char_length(idp_value) BETWEEN 1 AND 255 AND idp_value !~ '[[:cntrl:]]'
    AND role IN ('admin', 'developer', 'member', 'viewer', 'billing')
  )
);
ALTER TABLE slotlock.sso_role_mappings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.sso_role_mappings FROM PUBLIC;

-- A session's scope (the connection it was signed in through, when signed in through one alone),
-- and its proofs: when a team's provider last vouched for the person in this session.
ALTER TABLE slotlock.dashboard_sessions ADD COLUMN IF NOT EXISTS sso_connection_id uuid
  REFERENCES slotlock.sso_connections (id) ON DELETE CASCADE;
CREATE TABLE IF NOT EXISTS slotlock.dashboard_session_sso (
  sid_sha256 bytea NOT NULL REFERENCES slotlock.dashboard_sessions (sid_sha256) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES slotlock.sso_connections (id) ON DELETE CASCADE,
  person_ref text NOT NULL,
  authenticated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_dashboard_session_sso_pkey PRIMARY KEY (sid_sha256, connection_id),
  CONSTRAINT slotlock_dashboard_session_sso_valid CHECK (person_ref ~ '${PERSON}')
);
ALTER TABLE slotlock.dashboard_session_sso ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.dashboard_session_sso FROM PUBLIC;

-- An Owner's way in while the provider is down: one session, one team, an hour.
CREATE TABLE IF NOT EXISTS slotlock.sso_bypasses (
  sid_sha256 bytea NOT NULL REFERENCES slotlock.dashboard_sessions (sid_sha256) ON DELETE CASCADE,
  tenant_ref text NOT NULL REFERENCES slotlock.workspaces (tenant_ref) ON DELETE CASCADE,
  person_ref text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT slotlock_sso_bypasses_pkey PRIMARY KEY (sid_sha256, tenant_ref),
  CONSTRAINT slotlock_sso_bypasses_valid CHECK (person_ref ~ '${PERSON}' AND expires_at > granted_at)
);
ALTER TABLE slotlock.sso_bypasses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.sso_bypasses FROM PUBLIC;

-- Whether a team requires single sign-on, and how long a proof lasts.
ALTER TABLE slotlock.workspaces ADD COLUMN IF NOT EXISTS require_sso boolean NOT NULL DEFAULT false;
ALTER TABLE slotlock.workspaces ADD COLUMN IF NOT EXISTS sso_max_age_hours integer NOT NULL DEFAULT ${SLOTLOCK_SSO_MAX_AGE_HOURS.default}
  CONSTRAINT slotlock_workspaces_sso_max_age_valid
  CHECK (sso_max_age_hours BETWEEN ${SLOTLOCK_SSO_MAX_AGE_HOURS.min} AND ${SLOTLOCK_SSO_MAX_AGE_HOURS.max});

-- Who decides a member's role: Slotlock (manual, the default; a role changed by hand stays so) or
-- the team's provider at each sign-in (sso: a member it provisioned).
ALTER TABLE slotlock.workspace_memberships ADD COLUMN IF NOT EXISTS role_managed_by text NOT NULL DEFAULT 'manual'
  CONSTRAINT slotlock_workspace_memberships_managed_valid CHECK (role_managed_by IN ('manual', 'sso'));

-- A person's standing in a workspace now, for this session: their role (Owner of their own; else an
-- active membership's, or none) and their sessions' epoch. None, with why, when the session is scoped
-- to another team's provider or to one turned off (sso_scope), or the team requires single sign-on and the session holds
-- no proof younger than the team allows and no Owner's bypass (sso_required: may_bypass says whether
-- this person may use one). A person signed in through a provider (sso:) has no workspace of their
-- own. A test environment is its live tenant's.
CREATE OR REPLACE FUNCTION slotlock.dashboard_standing(requested_tenant text, requested_person text, requested_sid bytea)
RETURNS TABLE (role text, session_epoch integer, refusal text, may_bypass boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_dashboard_standing$
DECLARE
  live text := pg_catalog.regexp_replace(requested_tenant, '~test$', '');
  found_role text;
  epoch integer;
  scoped uuid;
  scoped_tenant text;
  scoped_status text;
  enforced boolean;
  max_age integer;
  connection uuid;
BEGIN
  SELECT person.session_epoch INTO epoch FROM slotlock.dashboard_people person WHERE person.person_ref = requested_person;
  IF live = requested_person AND requested_person ${NOT_SSO} THEN
    found_role := 'owner';
  ELSE
    SELECT member.role INTO found_role FROM slotlock.workspace_memberships member
     WHERE member.tenant_ref = live AND member.person_ref = requested_person AND member.status = 'active';
  END IF;
  IF requested_sid IS NOT NULL THEN
    SELECT kept.sso_connection_id INTO scoped FROM slotlock.dashboard_sessions kept
     WHERE kept.sid_sha256 = requested_sid AND kept.person_ref = requested_person;
    -- A person a team's provider made signs in only through it: a session of theirs it did not
    -- scope (its proof refused while it was turned off, say) is nobody's.
    IF scoped IS NULL AND requested_person ~ '^sso:' THEN
      RETURN QUERY SELECT NULL::text, epoch, 'sso_scope'::text, false;
      RETURN;
    END IF;
    IF scoped IS NOT NULL THEN
      SELECT linked.tenant_ref, linked.status INTO scoped_tenant, scoped_status
        FROM slotlock.sso_connections linked WHERE linked.id = scoped;
      -- Another team's provider, or this team's turned off since: nothing.
      IF scoped_tenant IS DISTINCT FROM live OR scoped_status IS DISTINCT FROM 'active' THEN
        RETURN QUERY SELECT NULL::text, epoch, 'sso_scope'::text, false;
        RETURN;
      END IF;
    END IF;
  END IF;
  IF found_role IS NOT NULL THEN
    SELECT ws.require_sso, ws.sso_max_age_hours INTO enforced, max_age FROM slotlock.workspaces ws WHERE ws.tenant_ref = live;
    IF coalesce(enforced, false) THEN
      SELECT linked.id INTO connection FROM slotlock.sso_connections linked
       WHERE linked.tenant_ref = live AND linked.status = 'active';
      IF requested_sid IS NULL OR NOT (
        EXISTS (SELECT 1 FROM slotlock.dashboard_session_sso proof
                 WHERE proof.sid_sha256 = requested_sid AND proof.connection_id = connection
                   AND proof.person_ref = requested_person
                   AND proof.authenticated_at > statement_timestamp() - make_interval(hours => max_age))
        OR EXISTS (SELECT 1 FROM slotlock.sso_bypasses bypass
                    WHERE bypass.sid_sha256 = requested_sid AND bypass.tenant_ref = live
                      AND bypass.person_ref = requested_person AND bypass.expires_at > statement_timestamp())
      ) THEN
        RETURN QUERY SELECT NULL::text, epoch, 'sso_required'::text, (found_role = 'owner' AND requested_person ${NOT_SSO});
        RETURN;
      END IF;
    END IF;
  END IF;
  RETURN QUERY SELECT found_role, epoch, NULL::text, false;
END
$slotlock_dashboard_standing$;
REVOKE ALL ON FUNCTION slotlock.dashboard_standing(text, text, bytea) FROM PUBLIC;

-- Save a team's connection, by its Owner, while the team has a verified domain. A change to the
-- issuer, client or secret (a new sealed secret) makes it a new configuration: draft until tested,
-- "require single sign-on" off (which enforcement_off reports for the audit log), and the sessions
-- and proofs the old one vouched for ended.
CREATE OR REPLACE FUNCTION slotlock.save_sso_connection(
  requested_tenant text, requested_actor text, requested_id uuid, requested_kind text, requested_issuer text,
  requested_client_id text, requested_secret_sealed text, requested_secret_last4 text,
  requested_authorization_endpoint text, requested_token_endpoint text, requested_jwks_uri text,
  requested_algorithms text[], requested_iss_parameter boolean, requested_entra_tenant text)
RETURNS TABLE (connection_id uuid, refusal text, enforcement_off boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_save_sso_connection$
DECLARE
  actor_role text;
  existing slotlock.sso_connections%ROWTYPE;
  material boolean;
  was_enforced boolean;
BEGIN
  SELECT ws.require_sso INTO was_enforced FROM slotlock.workspaces ws
   WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, 'not_found'::text, false;
    RETURN;
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN QUERY SELECT NULL::uuid, 'not_allowed'::text, false;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM slotlock.workspace_domains claim
                  WHERE claim.tenant_ref = requested_tenant AND claim.status = 'verified') THEN
    RETURN QUERY SELECT NULL::uuid, 'no_verified_domain'::text, false;
    RETURN;
  END IF;
  SELECT * INTO existing FROM slotlock.sso_connections linked WHERE linked.tenant_ref = requested_tenant FOR UPDATE;
  IF NOT FOUND THEN
    IF requested_kind <> 'google_workspace' AND requested_secret_sealed IS NULL THEN
      RETURN QUERY SELECT NULL::uuid, 'secret_required'::text, false;
      RETURN;
    END IF;
    INSERT INTO slotlock.sso_connections
      (id, tenant_ref, kind, issuer, client_id, secret_sealed, secret_last4, authorization_endpoint, token_endpoint,
       jwks_uri, algorithms, iss_parameter, entra_tenant, created_by)
    VALUES (requested_id, requested_tenant, requested_kind, requested_issuer, requested_client_id, requested_secret_sealed,
            requested_secret_last4, requested_authorization_endpoint, requested_token_endpoint, requested_jwks_uri,
            requested_algorithms, coalesce(requested_iss_parameter, false), requested_entra_tenant, requested_actor);
    RETURN QUERY SELECT requested_id, NULL::text, false;
    RETURN;
  END IF;
  IF existing.id <> requested_id THEN
    RETURN QUERY SELECT existing.id, 'conflict'::text, false;
    RETURN;
  END IF;
  material := existing.kind <> requested_kind OR existing.issuer <> requested_issuer
              OR existing.client_id <> requested_client_id OR requested_secret_sealed IS NOT NULL
              OR existing.entra_tenant IS DISTINCT FROM requested_entra_tenant;
  UPDATE slotlock.sso_connections linked
     SET kind = requested_kind, issuer = requested_issuer, client_id = requested_client_id,
         secret_sealed = coalesce(requested_secret_sealed, linked.secret_sealed),
         secret_last4 = CASE WHEN requested_secret_sealed IS NULL THEN linked.secret_last4 ELSE requested_secret_last4 END,
         authorization_endpoint = requested_authorization_endpoint, token_endpoint = requested_token_endpoint,
         jwks_uri = requested_jwks_uri, algorithms = requested_algorithms,
         iss_parameter = coalesce(requested_iss_parameter, false), entra_tenant = requested_entra_tenant,
         config_version = linked.config_version + CASE WHEN material THEN 1 ELSE 0 END,
         status = CASE WHEN material THEN 'draft' ELSE linked.status END,
         updated_at = statement_timestamp()
   WHERE linked.id = existing.id;
  IF material AND was_enforced THEN
    UPDATE slotlock.workspaces ws SET require_sso = false WHERE ws.tenant_ref = requested_tenant;
  END IF;
  IF material THEN
    UPDATE slotlock.dashboard_sessions kept SET ended_at = statement_timestamp()
     WHERE kept.sso_connection_id = existing.id AND kept.ended_at IS NULL;
    DELETE FROM slotlock.dashboard_session_sso proof WHERE proof.connection_id = existing.id;
  END IF;
  RETURN QUERY SELECT existing.id, NULL::text, coalesce(material AND was_enforced, false);
END
$slotlock_save_sso_connection$;
REVOKE ALL ON FUNCTION ${fn[0]} FROM PUBLIC;

-- A team's connection, as its Identity page and sign-in read it (the sealed secret included: the
-- application opens it to sign in), with whether the team requires single sign-on.
CREATE OR REPLACE FUNCTION slotlock.sso_connection_of(requested_tenant text)
RETURNS TABLE (connection_id uuid, kind text, status text, issuer text, client_id text, secret_sealed text,
               secret_last4 text, authorization_endpoint text, token_endpoint text, jwks_uri text,
               algorithms text[], iss_parameter boolean, entra_tenant text, groups_claim text,
               jit_enabled boolean, default_role text, config_version integer, tested_version integer,
               last_tested_at timestamptz, last_test_claims jsonb, require_sso boolean, sso_max_age_hours integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_sso_connection_of$
  SELECT linked.id, linked.kind, linked.status, linked.issuer, linked.client_id, linked.secret_sealed,
         linked.secret_last4, linked.authorization_endpoint, linked.token_endpoint, linked.jwks_uri,
         linked.algorithms, linked.iss_parameter, linked.entra_tenant, linked.groups_claim, linked.jit_enabled,
         linked.default_role, linked.config_version, linked.tested_version, linked.last_tested_at,
         linked.last_test_claims, ws.require_sso, ws.sso_max_age_hours
    FROM slotlock.sso_connections linked
    JOIN slotlock.workspaces ws ON ws.tenant_ref = linked.tenant_ref
   WHERE linked.tenant_ref = requested_tenant;
$slotlock_sso_connection_of$;
REVOKE ALL ON FUNCTION ${fn[1]} FROM PUBLIC;

-- A connection by its id, for its callback: with its team, while the team is active.
CREATE OR REPLACE FUNCTION slotlock.sso_connection_by_id(requested_id uuid)
RETURNS TABLE (team_ref text, handle text, name text, kind text, status text, issuer text, client_id text,
               secret_sealed text, token_endpoint text, jwks_uri text, algorithms text[], iss_parameter boolean,
               entra_tenant text, groups_claim text, config_version integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_sso_connection_by_id$
  SELECT linked.tenant_ref, ws.handle, ws.name, linked.kind, linked.status, linked.issuer, linked.client_id,
         linked.secret_sealed, linked.token_endpoint, linked.jwks_uri, linked.algorithms, linked.iss_parameter,
         linked.entra_tenant, linked.groups_claim, linked.config_version
    FROM slotlock.sso_connections linked
    JOIN slotlock.workspaces ws ON ws.tenant_ref = linked.tenant_ref AND ws.status = 'active'
   WHERE linked.id = requested_id;
$slotlock_sso_connection_by_id$;
REVOKE ALL ON FUNCTION ${fn[2]} FROM PUBLIC;

-- Where single sign-on starts: a team's active connection, by the team's handle or by a domain the
-- team holds verified.
CREATE OR REPLACE FUNCTION slotlock.sso_connection_route(requested_handle text, requested_domain text)
RETURNS TABLE (connection_id uuid, team_ref text, handle text, name text, authorization_endpoint text,
               client_id text, kind text, entra_tenant text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_sso_connection_route$
  SELECT linked.id, ws.tenant_ref, ws.handle, ws.name, linked.authorization_endpoint, linked.client_id, linked.kind,
         linked.entra_tenant
    FROM slotlock.sso_connections linked
    JOIN slotlock.workspaces ws ON ws.tenant_ref = linked.tenant_ref AND ws.status = 'active'
   WHERE linked.status = 'active'
     AND ((requested_handle IS NOT NULL AND ws.handle = lower(requested_handle))
          OR (requested_domain IS NOT NULL AND EXISTS (
                SELECT 1 FROM slotlock.workspace_domains claim
                 WHERE claim.tenant_ref = ws.tenant_ref AND claim.status = 'verified'
                   AND claim.domain_ascii = lower(requested_domain))))
   LIMIT 1;
$slotlock_sso_connection_route$;
REVOKE ALL ON FUNCTION ${fn[3]} FROM PUBLIC;

-- A test sign-in's result, by an Owner, for the configuration it tested: what the provider sent,
-- with no token. A configuration changed since is not marked tested.
CREATE OR REPLACE FUNCTION slotlock.record_sso_test(
  requested_tenant text, requested_actor text, requested_id uuid, requested_version integer, requested_claims jsonb)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_record_sso_test$
DECLARE
  actor_role text;
BEGIN
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN 'not_allowed';
  END IF;
  UPDATE slotlock.sso_connections linked
     SET tested_version = requested_version, last_tested_at = statement_timestamp(), last_test_claims = requested_claims,
         tested_by = requested_actor,
         status = CASE WHEN linked.status = 'draft' THEN 'tested' ELSE linked.status END
   WHERE linked.id = requested_id AND linked.tenant_ref = requested_tenant AND linked.config_version = requested_version;
  IF NOT FOUND THEN
    RETURN 'stale_config';
  END IF;
  RETURN NULL;
END
$slotlock_record_sso_test$;
REVOKE ALL ON FUNCTION ${fn[4]} FROM PUBLIC;

-- Turn a connection on (only once its configuration has been tested) or off (which stops requiring
-- single sign-on, and ends the sessions and proofs it vouched for), by an Owner.
CREATE OR REPLACE FUNCTION slotlock.set_sso_connection_status(
  requested_tenant text, requested_actor text, requested_id uuid, requested_status text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_set_sso_connection_status$
DECLARE
  actor_role text;
  linked slotlock.sso_connections%ROWTYPE;
BEGIN
  IF requested_status IS NULL OR requested_status NOT IN ('active', 'disabled') THEN
    RAISE EXCEPTION 'Slotlock SSO: a connection is turned active or disabled' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN 'not_allowed';
  END IF;
  SELECT * INTO linked FROM slotlock.sso_connections found
   WHERE found.id = requested_id AND found.tenant_ref = requested_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF requested_status = 'active' AND linked.tested_version IS DISTINCT FROM linked.config_version THEN
    RETURN 'untested';
  END IF;
  IF requested_status = 'disabled' AND NOT EXISTS (
    SELECT 1 FROM slotlock.workspace_memberships member
     WHERE member.tenant_ref = requested_tenant AND member.status = 'active' AND member.role = 'owner'
       AND member.person_ref ${NOT_SSO}
  ) THEN
    RETURN 'no_breakglass_owner';
  END IF;
  UPDATE slotlock.sso_connections found SET status = requested_status, updated_at = statement_timestamp()
   WHERE found.id = requested_id;
  IF requested_status = 'disabled' THEN
    UPDATE slotlock.workspaces ws SET require_sso = false WHERE ws.tenant_ref = requested_tenant;
    UPDATE slotlock.dashboard_sessions kept SET ended_at = statement_timestamp()
     WHERE kept.sso_connection_id = requested_id AND kept.ended_at IS NULL;
    DELETE FROM slotlock.dashboard_session_sso proof WHERE proof.connection_id = requested_id;
  END IF;
  RETURN NULL;
END
$slotlock_set_sso_connection_status$;
REVOKE ALL ON FUNCTION ${fn[5]} FROM PUBLIC;

-- Delete a team's connection, by an Owner: its identities and proofs go, sessions signed in through
-- it alone end, single sign-on is no longer required, and the people who signed in only through it
-- (sso:), left with no way in, are erased. Refused while every Owner signs in through it.
CREATE OR REPLACE FUNCTION slotlock.delete_sso_connection(requested_tenant text, requested_actor text, requested_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_delete_sso_connection$
DECLARE
  actor_role text;
  departing text[];
  person text;
BEGIN
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN 'not_allowed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM slotlock.workspace_memberships member
     WHERE member.tenant_ref = requested_tenant AND member.status = 'active' AND member.role = 'owner'
       AND member.person_ref ${NOT_SSO}
  ) THEN
    RETURN 'no_breakglass_owner';
  END IF;
  SELECT coalesce(array_agg(identity.person_ref), ARRAY[]::text[]) INTO departing
    FROM slotlock.sso_identities identity
    JOIN slotlock.sso_connections linked ON linked.id = identity.connection_id
   WHERE linked.id = requested_id AND linked.tenant_ref = requested_tenant AND identity.person_ref ~ '^sso:';
  DELETE FROM slotlock.sso_connections linked WHERE linked.id = requested_id AND linked.tenant_ref = requested_tenant;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  UPDATE slotlock.workspaces ws SET require_sso = false WHERE ws.tenant_ref = requested_tenant;
  FOREACH person IN ARRAY departing LOOP
    PERFORM 1 FROM slotlock.erase_tenant(person);
  END LOOP;
  RETURN NULL;
END
$slotlock_delete_sso_connection$;
REVOKE ALL ON FUNCTION ${fn[6]} FROM PUBLIC;

-- Who a first sign-in through the provider makes a member, and as what, by an Owner: on by default,
-- as a Viewer (Member or Developer at most), and only for an email trusted at a verified domain.
CREATE OR REPLACE FUNCTION slotlock.set_sso_provisioning(
  requested_tenant text, requested_actor text, requested_jit boolean, requested_default_role text, requested_groups_claim text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_set_sso_provisioning$
DECLARE
  actor_role text;
BEGIN
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN 'not_allowed';
  END IF;
  IF requested_default_role IS NULL OR requested_default_role NOT IN ('viewer', 'member', 'developer') THEN
    RETURN 'role_not_allowed';
  END IF;
  UPDATE slotlock.sso_connections linked
     SET jit_enabled = coalesce(requested_jit, false), default_role = requested_default_role,
         groups_claim = coalesce(nullif(btrim(requested_groups_claim), ''), 'groups'), updated_at = statement_timestamp()
   WHERE linked.tenant_ref = requested_tenant;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  RETURN NULL;
END
$slotlock_set_sso_provisioning$;
REVOKE ALL ON FUNCTION ${fn[7]} FROM PUBLIC;

-- Map a provider group (or app role) to a role, never Owner; a null role removes the mapping.
CREATE OR REPLACE FUNCTION slotlock.set_sso_role_mapping(
  requested_tenant text, requested_actor text, requested_value text, requested_role text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_set_sso_role_mapping$
DECLARE
  actor_role text;
  linked uuid;
BEGIN
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN 'not_allowed';
  END IF;
  IF requested_role = 'owner' THEN
    RETURN 'owner_not_mappable';
  END IF;
  SELECT found.id INTO linked FROM slotlock.sso_connections found WHERE found.tenant_ref = requested_tenant;
  IF linked IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF requested_value IS NULL OR char_length(btrim(requested_value)) NOT BETWEEN 1 AND 255 THEN
    RETURN 'invalid_value';
  END IF;
  IF requested_role IS NULL THEN
    DELETE FROM slotlock.sso_role_mappings mapped WHERE mapped.connection_id = linked AND mapped.idp_value = btrim(requested_value);
    RETURN NULL;
  END IF;
  IF requested_role NOT IN ('admin', 'developer', 'member', 'viewer', 'billing') THEN
    RETURN 'role_not_allowed';
  END IF;
  IF (SELECT count(*) FROM slotlock.sso_role_mappings mapped WHERE mapped.connection_id = linked) >= 50 THEN
    RETURN 'mapping_limit';
  END IF;
  INSERT INTO slotlock.sso_role_mappings (connection_id, idp_value, role) VALUES (linked, btrim(requested_value), requested_role)
  ON CONFLICT ON CONSTRAINT slotlock_sso_role_mappings_pkey DO UPDATE SET role = excluded.role;
  RETURN NULL;
END
$slotlock_set_sso_role_mapping$;
REVOKE ALL ON FUNCTION ${fn[8]} FROM PUBLIC;

CREATE OR REPLACE FUNCTION slotlock.sso_role_mappings_of(requested_tenant text)
RETURNS TABLE (idp_value text, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_sso_role_mappings_of$
  SELECT mapped.idp_value, mapped.role FROM slotlock.sso_role_mappings mapped
    JOIN slotlock.sso_connections linked ON linked.id = mapped.connection_id
   WHERE linked.tenant_ref = requested_tenant
   ORDER BY mapped.idp_value;
$slotlock_sso_role_mappings_of$;
REVOKE ALL ON FUNCTION ${fn[9]} FROM PUBLIC;

-- A sign-in through a team's provider, its token already checked. requested_session_person is the
-- person already signed in to Slotlock who started it (to prove themselves to the team, or to link
-- the identity to themselves), or null for a sign-in through the provider alone.
-- - The identity is found by the provider's subject (and Entra's tenant and object id), never email.
-- - Linking: an identity seen for the first time while a team member is signed in becomes theirs,
--   only with an email trusted at the team's verified domain (identity_untrusted otherwise: no
--   personal account keeps a member in), replacing the one they linked before; one already another
--   person's is refused (identity_taken).
-- - Alone: an identity seen for the first time is a new person (sso:<uuid>), with no workspace of
--   their own, kept only once they are let in: a pending invitation to their trusted email (never an
--   Owner's: the provider makes no Owner) makes them a member, or the connection provisions them (on
--   by default) as its default role or the role their groups map to. An email is trusted only at a
--   domain this team has verified, and only when the caller says the provider vouched for it
--   (requested_email_ok: Entra's xms_edov, Google's hd, no email_verified false).
-- - Someone the team removed, or whose address it removed, is not provisioned again.
-- - A member the provider provisioned has their role recomputed from their groups each time.
CREATE OR REPLACE FUNCTION slotlock.sso_sign_in(
  requested_connection uuid, requested_issuer text, requested_subject text, requested_tid text, requested_oid text,
  requested_email text, requested_email_ok boolean, requested_groups text[], requested_overage boolean,
  requested_guest boolean, requested_session_person text, requested_member_cap integer)
RETURNS TABLE (person text, outcome text, refusal text, member_role text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_sso_sign_in$
DECLARE
  linked slotlock.sso_connections%ROWTYPE;
  known slotlock.sso_identities%ROWTYPE;
  email_key text := lower(btrim(requested_email));
  trusted boolean := false;
  mapped text;
  current_membership slotlock.workspace_memberships%ROWTYPE;
  chosen text;
  invitation uuid;
  accepted_ref text;
  accepted_refusal text;
  occupied integer;
  newcomer text;
BEGIN
  SELECT * INTO linked FROM slotlock.sso_connections found WHERE found.id = requested_connection;
  IF NOT FOUND OR linked.status <> 'active' THEN
    RETURN QUERY SELECT NULL::text, NULL::text, 'connection_inactive'::text, NULL::text;
    RETURN;
  END IF;
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = linked.tenant_ref AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::text, 'connection_inactive'::text, NULL::text;
    RETURN;
  END IF;
  IF requested_issuer IS DISTINCT FROM linked.issuer OR requested_subject IS NULL
     OR char_length(requested_subject) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'Slotlock SSO: the identity is not this connection''s' USING ERRCODE = '22023';
  END IF;
  IF coalesce(requested_guest, false) THEN
    RETURN QUERY SELECT NULL::text, NULL::text, 'guest_refused'::text, NULL::text;
    RETURN;
  END IF;
  IF email_key IS NOT NULL AND email_key !~ '^[^@[:space:][:cntrl:]<>]+@[^@[:space:][:cntrl:]<>]+$' THEN
    email_key := NULL;
  END IF;
  trusted := coalesce(requested_email_ok, false) AND email_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM slotlock.workspace_domains claim
     WHERE claim.tenant_ref = linked.tenant_ref AND claim.status = 'verified'
       AND claim.domain_ascii = lower(substring(email_key FROM '@([^@]+)$')));
  -- The highest role a group maps to; none when the provider sent too many groups to list.
  IF NOT coalesce(requested_overage, false) THEN
    SELECT mapping.role INTO mapped FROM slotlock.sso_role_mappings mapping
     WHERE mapping.connection_id = linked.id AND mapping.idp_value = ANY (coalesce(requested_groups, ARRAY[]::text[]))
     ORDER BY array_position(ARRAY['admin', 'developer', 'member', 'viewer', 'billing'], mapping.role)
     LIMIT 1;
  END IF;
  SELECT * INTO known FROM slotlock.sso_identities found
   WHERE found.connection_id = linked.id
     AND ((found.issuer = requested_issuer AND found.subject = requested_subject)
          OR (requested_oid IS NOT NULL AND found.entra_tid = requested_tid AND found.entra_oid = requested_oid))
   ORDER BY (found.subject = requested_subject) DESC
   LIMIT 1;

  IF requested_session_person IS NOT NULL THEN
    -- Proving oneself to the team, or linking: the signed-in person must be a member of it.
    IF requested_session_person !~ '${PERSON}' OR NOT EXISTS (
      SELECT 1 FROM slotlock.workspace_memberships member
       WHERE member.tenant_ref = linked.tenant_ref AND member.person_ref = requested_session_person AND member.status = 'active'
    ) THEN
      RETURN QUERY SELECT NULL::text, NULL::text, 'not_member'::text, NULL::text;
      RETURN;
    END IF;
    IF known.id IS NOT NULL AND known.person_ref <> requested_session_person THEN
      RETURN QUERY SELECT NULL::text, NULL::text, 'identity_taken'::text, NULL::text;
      RETURN;
    END IF;
    IF known.replaced_at IS NOT NULL THEN
      -- An account of theirs they replaced, linked again in place of the current one.
      UPDATE slotlock.sso_identities current_one SET replaced_at = statement_timestamp()
       WHERE current_one.connection_id = linked.id AND current_one.person_ref = requested_session_person
         AND current_one.replaced_at IS NULL;
      UPDATE slotlock.sso_identities found SET replaced_at = NULL WHERE found.id = known.id;
    END IF;
    IF known.id IS NULL THEN
      IF NOT trusted THEN
        RETURN QUERY SELECT NULL::text, NULL::text, 'identity_untrusted'::text, NULL::text;
        RETURN;
      END IF;
      UPDATE slotlock.sso_identities replaced SET replaced_at = statement_timestamp()
       WHERE replaced.connection_id = linked.id AND replaced.person_ref = requested_session_person
         AND replaced.replaced_at IS NULL;
      INSERT INTO slotlock.sso_identities (connection_id, issuer, subject, entra_tid, entra_oid, person_ref, email_last)
      VALUES (linked.id, requested_issuer, requested_subject, requested_tid, requested_oid, requested_session_person, email_key);
      RETURN QUERY SELECT requested_session_person, 'linked'::text, NULL::text,
                          (SELECT member.role FROM slotlock.workspace_memberships member
                            WHERE member.tenant_ref = linked.tenant_ref AND member.person_ref = requested_session_person);
      RETURN;
    END IF;
    UPDATE slotlock.sso_identities found SET last_sso_at = statement_timestamp(), subject = requested_subject,
           email_last = CASE WHEN trusted THEN email_key ELSE found.email_last END
     WHERE found.id = known.id;
    RETURN QUERY SELECT requested_session_person, 'proof'::text, NULL::text,
                        (SELECT member.role FROM slotlock.workspace_memberships member
                          WHERE member.tenant_ref = linked.tenant_ref AND member.person_ref = requested_session_person);
    RETURN;
  END IF;

  -- Through the provider alone. An account its person replaced signs in as nobody.
  IF known.replaced_at IS NOT NULL THEN
    RETURN QUERY SELECT NULL::text, NULL::text, 'not_member'::text, NULL::text;
    RETURN;
  END IF;
  IF known.id IS NULL THEN
    newcomer := 'sso:' || gen_random_uuid()::text;
  ELSE
    newcomer := known.person_ref;
    UPDATE slotlock.sso_identities found SET last_sso_at = statement_timestamp(), subject = requested_subject,
           email_last = CASE WHEN trusted THEN email_key ELSE found.email_last END
     WHERE found.id = known.id;
  END IF;
  SELECT * INTO current_membership FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = linked.tenant_ref AND member.person_ref = newcomer;
  IF current_membership.status = 'active' THEN
    IF current_membership.role_managed_by = 'sso' AND current_membership.role <> 'owner' THEN
      chosen := coalesce(mapped, linked.default_role);
      IF chosen <> current_membership.role THEN
        UPDATE slotlock.workspace_memberships member SET role = chosen, updated_at = statement_timestamp()
         WHERE member.tenant_ref = linked.tenant_ref AND member.person_ref = newcomer;
        RETURN QUERY SELECT newcomer, 'role_changed'::text, NULL::text, chosen;
        RETURN;
      END IF;
    END IF;
    RETURN QUERY SELECT newcomer, 'signed_in'::text, NULL::text, current_membership.role;
    RETURN;
  END IF;
  IF current_membership.person_ref IS NOT NULL THEN
    -- Removed from the team: the provider does not bring them back.
    RETURN QUERY SELECT CASE WHEN known.id IS NULL THEN NULL ELSE newcomer END, NULL::text, 'not_member'::text, NULL::text;
    RETURN;
  END IF;
  IF trusted THEN
    SELECT pending.id INTO invitation FROM slotlock.workspace_invitations pending
     WHERE pending.tenant_ref = linked.tenant_ref AND pending.email = email_key
       AND pending.accepted_at IS NULL AND pending.revoked_at IS NULL AND pending.expires_at > statement_timestamp()
       AND pending.role <> 'owner'
     ORDER BY pending.sent_at DESC LIMIT 1;
    IF invitation IS NOT NULL THEN
      SELECT accepted.tenant_ref, accepted.refusal INTO accepted_ref, accepted_refusal
        FROM slotlock.accept_invitation(NULL::bytea, invitation, newcomer, ARRAY[email_key], requested_member_cap) accepted;
      IF accepted_ref IS NOT NULL THEN
        IF known.id IS NULL THEN
          INSERT INTO slotlock.sso_identities (connection_id, issuer, subject, entra_tid, entra_oid, person_ref, email_last)
          VALUES (linked.id, requested_issuer, requested_subject, requested_tid, requested_oid, newcomer, email_key);
        END IF;
        RETURN QUERY SELECT newcomer, 'joined'::text, NULL::text,
                            (SELECT member.role FROM slotlock.workspace_memberships member
                              WHERE member.tenant_ref = linked.tenant_ref AND member.person_ref = newcomer);
        RETURN;
      END IF;
      IF accepted_refusal = 'member_cap' THEN
        RETURN QUERY SELECT CASE WHEN known.id IS NULL THEN NULL ELSE newcomer END, NULL::text, 'member_cap'::text, NULL::text;
        RETURN;
      END IF;
    END IF;
  END IF;
  IF NOT linked.jit_enabled OR NOT trusted OR EXISTS (
    SELECT 1 FROM slotlock.workspace_join_blocks blocked
     WHERE blocked.tenant_ref = linked.tenant_ref AND blocked.email_sha256 = sha256(convert_to(email_key, 'UTF8'))
  ) OR EXISTS (
    SELECT 1 FROM slotlock.workspace_memberships member
     WHERE member.tenant_ref = linked.tenant_ref AND member.joined_email = email_key AND member.status = 'inactive'
  ) THEN
    RETURN QUERY SELECT CASE WHEN known.id IS NULL THEN NULL ELSE newcomer END, NULL::text, 'not_member'::text, NULL::text;
    RETURN;
  END IF;
  IF requested_member_cap IS NOT NULL THEN
    SELECT (SELECT count(*) FROM slotlock.workspace_memberships member
             WHERE member.tenant_ref = linked.tenant_ref AND member.status = 'active')
         + (SELECT count(*) FROM slotlock.workspace_invitations pending
             WHERE pending.tenant_ref = linked.tenant_ref AND pending.accepted_at IS NULL
               AND pending.revoked_at IS NULL AND pending.expires_at > statement_timestamp())
      INTO occupied;
    IF occupied >= requested_member_cap THEN
      RETURN QUERY SELECT CASE WHEN known.id IS NULL THEN NULL ELSE newcomer END, NULL::text, 'member_cap'::text, NULL::text;
      RETURN;
    END IF;
  END IF;
  chosen := coalesce(mapped, linked.default_role);
  INSERT INTO slotlock.workspace_memberships (tenant_ref, person_ref, role, source, role_managed_by, joined_email)
  VALUES (linked.tenant_ref, newcomer, chosen, 'sso', 'sso', email_key);
  IF known.id IS NULL THEN
    INSERT INTO slotlock.sso_identities (connection_id, issuer, subject, entra_tid, entra_oid, person_ref, email_last)
    VALUES (linked.id, requested_issuer, requested_subject, requested_tid, requested_oid, newcomer, email_key);
  END IF;
  RETURN QUERY SELECT newcomer, 'joined'::text, NULL::text, chosen;
END
$slotlock_sso_sign_in$;
REVOKE ALL ON FUNCTION ${fn[10]} FROM PUBLIC;

-- A session's proof from a connection's provider, now: for the person whose session it is. A session
-- begun through the provider alone (scoped) is scoped to the connection's team for its life.
CREATE OR REPLACE FUNCTION slotlock.record_sso_proof(
  requested_sid bytea, requested_person text, requested_connection uuid, requested_scoped boolean, requested_version integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_record_sso_proof$
BEGIN
  -- Only from a connection on now, configured as it was when it vouched (requested_version, where the
  -- caller knows it): locked, so turning it off or changing it waits for this, or this sees it.
  IF NOT EXISTS (SELECT 1 FROM slotlock.sso_connections linked
                  WHERE linked.id = requested_connection AND linked.status = 'active'
                    AND (requested_version IS NULL OR linked.config_version = requested_version)
                  FOR SHARE) THEN
    RETURN false;
  END IF;
  -- A session scoped to one team's provider proves nothing to another's.
  IF NOT EXISTS (SELECT 1 FROM slotlock.dashboard_sessions kept
                  WHERE kept.sid_sha256 = requested_sid AND kept.person_ref = requested_person
                    AND kept.ended_at IS NULL AND kept.expires_at > statement_timestamp()
                    AND (kept.sso_connection_id IS NULL OR kept.sso_connection_id = requested_connection)) THEN
    RETURN false;
  END IF;
  IF requested_scoped THEN
    UPDATE slotlock.dashboard_sessions kept SET sso_connection_id = requested_connection
     WHERE kept.sid_sha256 = requested_sid AND kept.sso_connection_id IS NULL
       AND kept.started_at > statement_timestamp() - interval '1 minute';
    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;
  INSERT INTO slotlock.dashboard_session_sso (sid_sha256, connection_id, person_ref)
  VALUES (requested_sid, requested_connection, requested_person)
  ON CONFLICT ON CONSTRAINT slotlock_dashboard_session_sso_pkey DO UPDATE SET authenticated_at = statement_timestamp();
  RETURN true;
END
$slotlock_record_sso_proof$;
REVOKE ALL ON FUNCTION ${fn[11]} FROM PUBLIC;

-- Require single sign-on, or stop, by an Owner: turning it on needs the team's connection active,
-- a proof from it in this session in the last ${SLOTLOCK_SSO_ENABLE_PROOF_MINUTES} minutes, and an Owner who signs in with
-- GitHub or Google, for when the provider is down.
CREATE OR REPLACE FUNCTION slotlock.set_require_sso(
  requested_tenant text, requested_actor text, requested_sid bytea, requested_on boolean, requested_max_age integer)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_set_require_sso$
DECLARE
  actor_role text;
  linked uuid;
BEGIN
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN 'not_allowed';
  END IF;
  IF requested_max_age IS NULL OR requested_max_age NOT BETWEEN ${SLOTLOCK_SSO_MAX_AGE_HOURS.min} AND ${SLOTLOCK_SSO_MAX_AGE_HOURS.max} THEN
    RETURN 'invalid_max_age';
  END IF;
  IF requested_on THEN
    SELECT found.id INTO linked FROM slotlock.sso_connections found
     WHERE found.tenant_ref = requested_tenant AND found.status = 'active';
    IF linked IS NULL THEN
      RETURN 'no_active_connection';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM slotlock.dashboard_session_sso proof
                    WHERE proof.sid_sha256 = requested_sid AND proof.connection_id = linked
                      AND proof.person_ref = requested_actor
                      AND proof.authenticated_at > statement_timestamp() - interval '${SLOTLOCK_SSO_ENABLE_PROOF_MINUTES} minutes') THEN
      RETURN 'stale_sso_proof';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM slotlock.workspace_memberships member
                    WHERE member.tenant_ref = requested_tenant AND member.status = 'active' AND member.role = 'owner'
                      AND member.person_ref ${NOT_SSO}) THEN
      RETURN 'no_breakglass_owner';
    END IF;
  END IF;
  UPDATE slotlock.workspaces ws SET require_sso = coalesce(requested_on, false), sso_max_age_hours = requested_max_age
   WHERE ws.tenant_ref = requested_tenant;
  RETURN NULL;
END
$slotlock_set_require_sso$;
REVOKE ALL ON FUNCTION ${fn[12]} FROM PUBLIC;

-- An Owner's way in while the provider is down: an Owner who signs in with GitHub or Google, in this
-- session, for ${SLOTLOCK_SSO_BYPASS_MINUTES} minutes. The caller records it in the audit log and tells the other Owners.
CREATE OR REPLACE FUNCTION slotlock.sso_owner_bypass(requested_tenant text, requested_person text, requested_sid bytea)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_sso_owner_bypass$
BEGIN
  IF requested_person IS NULL OR requested_person !~ '${PERSON}' OR requested_person ~ '^sso:' OR NOT EXISTS (
    SELECT 1 FROM slotlock.workspace_memberships member
     WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_person
       AND member.status = 'active' AND member.role = 'owner'
  ) THEN
    RETURN 'not_allowed';
  END IF;
  -- A live session the Owner began themselves: never one their team's provider began alone.
  IF NOT EXISTS (SELECT 1 FROM slotlock.dashboard_sessions kept
                  WHERE kept.sid_sha256 = requested_sid AND kept.person_ref = requested_person
                    AND kept.ended_at IS NULL AND kept.expires_at > statement_timestamp()
                    AND kept.sso_connection_id IS NULL) THEN
    RETURN 'not_allowed';
  END IF;
  INSERT INTO slotlock.sso_bypasses (sid_sha256, tenant_ref, person_ref, expires_at)
  VALUES (requested_sid, requested_tenant, requested_person, statement_timestamp() + interval '${SLOTLOCK_SSO_BYPASS_MINUTES} minutes')
  ON CONFLICT ON CONSTRAINT slotlock_sso_bypasses_pkey DO UPDATE
     SET granted_at = statement_timestamp(), expires_at = excluded.expires_at;
  RETURN NULL;
END
$slotlock_sso_owner_bypass$;
REVOKE ALL ON FUNCTION ${fn[13]} FROM PUBLIC;

-- Bypasses that ended, deleted. How many went.
CREATE OR REPLACE FUNCTION slotlock.prune_sso()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_prune_sso$
DECLARE
  pruned integer;
BEGIN
  DELETE FROM slotlock.sso_bypasses bypass WHERE bypass.expires_at < statement_timestamp();
  GET DIAGNOSTICS pruned = ROW_COUNT;
  RETURN pruned;
END
$slotlock_prune_sso$;
REVOKE ALL ON FUNCTION ${fn[14]} FROM PUBLIC;
`;
