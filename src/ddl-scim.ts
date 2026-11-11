// Teams phase 5.6–5.7: a team's directory (Okta, Entra) provisioning its people over SCIM 2.0
// (scim.ts parses and normalises the requests; these functions keep the records and apply what they
// mean to the team's memberships). Reached only through the SECURITY DEFINER functions below.
//
// The rules the database holds:
// - A token is the team's (never its creator's), stored as its SHA-256 only, and works for that team
//   alone: a token presented at another team's address is refused.
// - A directory user is a standing invitation from the directory: it binds to the person who signs in
//   holding its address verified, and only at a domain the team has verified.
// - Deactivating a user ends that person's membership of this team at their next request, and nothing
//   else of theirs; reactivating restores it, for sessions begun after (sessions_valid_after).
// - The directory never makes an Owner, never changes one, and never deactivates or deletes one.
// - Groups named slotlock-role-<role>, or mapped by an Owner, give roles: the highest a person's
//   groups give (admin, developer, member, viewer; billing only alone), else Viewer.

import { SLOTLOCK_PERSON_PATTERN } from './ddl-identity.js';

const PERSON = SLOTLOCK_PERSON_PATTERN;

export const SLOTLOCK_SCIM_TABLES = Object.freeze(['scim_tokens', 'scim_users', 'scim_groups', 'scim_group_members'] as const);

export const SLOTLOCK_SCIM_FUNCTIONS = Object.freeze([
  'slotlock.enable_scim(text, text, text)',
  'slotlock.disable_scim(text, text)',
  'slotlock.create_scim_token(text, text, bytea, text)',
  'slotlock.revoke_scim_token(text, text, uuid)',
  'slotlock.scim_state(text)',
  'slotlock.scim_authenticate(bytea, text)',
  'slotlock.scim_put_user(text, uuid, uuid, text, text, boolean, text, text, text, text)',
  'slotlock.scim_users_list(text, text, text, integer, integer, uuid)',
  'slotlock.scim_delete_user(text, uuid)',
  'slotlock.scim_put_group(text, uuid, uuid, text, text, uuid[])',
  'slotlock.scim_groups_list(text, text, text, integer, integer, uuid)',
  'slotlock.scim_delete_group(text, uuid)',
  'slotlock.map_scim_group_role(text, text, uuid, text)',
  'slotlock.scim_bind(text, text[], integer)',
] as const);

/** Active tokens a team may hold at once (two, to rotate). */
export const SLOTLOCK_SCIM_TOKEN_LIMIT = 2;

const fn = SLOTLOCK_SCIM_FUNCTIONS;

// The role a SCIM user's groups give, by precedence; Viewer when none does.
const ROLE_OF_USER = (tenant: string, user: string) => `coalesce((
    SELECT grouped.role FROM slotlock.scim_group_members membership
      JOIN slotlock.scim_groups grouped ON grouped.id = membership.group_id AND grouped.deleted_at IS NULL
     WHERE membership.user_id = ${user} AND grouped.tenant_ref = ${tenant} AND grouped.role IS NOT NULL
     ORDER BY array_position(ARRAY['admin', 'developer', 'member', 'viewer', 'billing'], grouped.role)
     LIMIT 1), 'viewer')`;

export const SLOTLOCK_SCIM_DDL = `
-- A team's SCIM tokens: the SHA-256 of each, and its first characters to name it.
CREATE TABLE IF NOT EXISTS slotlock.scim_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL REFERENCES slotlock.workspaces (tenant_ref) ON DELETE CASCADE,
  token_sha256 bytea NOT NULL,
  prefix text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT slotlock_scim_tokens_digest_key UNIQUE (token_sha256),
  CONSTRAINT slotlock_scim_tokens_valid CHECK (
    octet_length(token_sha256) = 32 AND prefix ~ '^slk_scim_[A-Za-z0-9]{4}$'
    AND (created_by IS NULL OR created_by ~ '${PERSON}')
  )
);
ALTER TABLE slotlock.scim_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.scim_tokens FROM PUBLIC;

-- The directory's users of a team: their SCIM id is Slotlock's, per team, never a person's id.
CREATE TABLE IF NOT EXISTS slotlock.scim_users (
  id uuid PRIMARY KEY,
  tenant_ref text NOT NULL REFERENCES slotlock.workspaces (tenant_ref) ON DELETE CASCADE,
  user_name text NOT NULL,
  user_name_key text NOT NULL,
  external_id text,
  active boolean NOT NULL DEFAULT true,
  given_name text,
  family_name text,
  display_name text,
  work_email text,
  person_ref text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT slotlock_scim_users_valid CHECK (
    char_length(user_name) BETWEEN 1 AND 254 AND user_name_key = lower(user_name)
    AND (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 255)
    AND (given_name IS NULL OR char_length(given_name) BETWEEN 1 AND 100)
    AND (family_name IS NULL OR char_length(family_name) BETWEEN 1 AND 100)
    AND (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200)
    AND (work_email IS NULL OR (char_length(work_email) BETWEEN 3 AND 254 AND work_email = lower(work_email)))
    AND (person_ref IS NULL OR person_ref ~ '${PERSON}')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_scim_users_name_key
  ON slotlock.scim_users (tenant_ref, user_name_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS slotlock_scim_users_email_idx ON slotlock.scim_users (work_email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS slotlock_scim_users_person_idx ON slotlock.scim_users (person_ref);
ALTER TABLE slotlock.scim_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.scim_users FROM PUBLIC;

-- The directory's groups of a team, and the role each gives (never Owner).
CREATE TABLE IF NOT EXISTS slotlock.scim_groups (
  id uuid PRIMARY KEY,
  tenant_ref text NOT NULL REFERENCES slotlock.workspaces (tenant_ref) ON DELETE CASCADE,
  display_name text NOT NULL,
  display_name_key text NOT NULL,
  external_id text,
  role text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  deleted_at timestamptz,
  CONSTRAINT slotlock_scim_groups_valid CHECK (
    char_length(display_name) BETWEEN 1 AND 200 AND display_name_key = lower(display_name)
    AND (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 255)
    AND (role IS NULL OR role IN ('admin', 'developer', 'member', 'viewer', 'billing'))
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_scim_groups_name_key
  ON slotlock.scim_groups (tenant_ref, display_name_key) WHERE deleted_at IS NULL;
ALTER TABLE slotlock.scim_groups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.scim_groups FROM PUBLIC;

CREATE TABLE IF NOT EXISTS slotlock.scim_group_members (
  group_id uuid NOT NULL REFERENCES slotlock.scim_groups (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES slotlock.scim_users (id) ON DELETE CASCADE,
  CONSTRAINT slotlock_scim_group_members_pkey PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS slotlock_scim_group_members_user_idx ON slotlock.scim_group_members (user_id);
ALTER TABLE slotlock.scim_group_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.scim_group_members FROM PUBLIC;

-- Whether a team's directory provisions it, and what a deactivated person's keys become.
ALTER TABLE slotlock.workspaces ADD COLUMN IF NOT EXISTS scim_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE slotlock.workspaces ADD COLUMN IF NOT EXISTS scim_key_policy text
  CONSTRAINT slotlock_workspaces_scim_key_policy_valid CHECK (scim_key_policy IS NULL OR scim_key_policy IN ('keep', 'revoke'));
-- A membership the directory gave, or restored: its sessions from before that moment do not count.
ALTER TABLE slotlock.workspace_memberships ADD COLUMN IF NOT EXISTS sessions_valid_after timestamptz;
-- Who ended a membership: the team (an Owner or Admin), the person themselves, or the team's
-- directory. The directory restores only what it ended (ddl.ts remove_member sets the others).
ALTER TABLE slotlock.workspace_memberships ADD COLUMN IF NOT EXISTS deactivated_by text
  CONSTRAINT slotlock_workspace_memberships_deactivated_by_valid CHECK (deactivated_by IN ('team', 'self', 'scim'));

-- Turn the team's directory on, by an Owner, choosing what a deactivated person's keys become. The
-- directory decides who is in from then on: domains no longer let people join at once, and single
-- sign-on no longer adds people.
CREATE OR REPLACE FUNCTION slotlock.enable_scim(requested_tenant text, requested_actor text, requested_key_policy text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_enable_scim$
DECLARE
  actor_role text;
BEGIN
  IF requested_key_policy IS NULL OR requested_key_policy NOT IN ('keep', 'revoke') THEN
    RETURN 'key_policy';
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
  IF NOT EXISTS (SELECT 1 FROM slotlock.workspace_domains claim WHERE claim.tenant_ref = requested_tenant AND claim.status = 'verified') THEN
    RETURN 'no_verified_domain';
  END IF;
  UPDATE slotlock.workspaces ws SET scim_enabled = true, scim_key_policy = requested_key_policy WHERE ws.tenant_ref = requested_tenant;
  UPDATE slotlock.workspace_domains claim SET join_policy = 'request'
   WHERE claim.tenant_ref = requested_tenant AND claim.join_policy = 'auto';
  UPDATE slotlock.sso_connections linked SET jit_enabled = false WHERE linked.tenant_ref = requested_tenant;
  RETURN NULL;
END
$slotlock_enable_scim$;
REVOKE ALL ON FUNCTION ${fn[0]} FROM PUBLIC;

-- Turn it off, by an Owner: its tokens stop. Nobody is deactivated by it.
CREATE OR REPLACE FUNCTION slotlock.disable_scim(requested_tenant text, requested_actor text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_disable_scim$
DECLARE
  actor_role text;
BEGIN
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN 'not_allowed';
  END IF;
  UPDATE slotlock.workspaces ws SET scim_enabled = false WHERE ws.tenant_ref = requested_tenant;
  UPDATE slotlock.scim_tokens token SET revoked_at = statement_timestamp()
   WHERE token.tenant_ref = requested_tenant AND token.revoked_at IS NULL;
  RETURN NULL;
END
$slotlock_disable_scim$;
REVOKE ALL ON FUNCTION ${fn[1]} FROM PUBLIC;

-- A new token, by an Owner, while the directory is on: two at most at once, to rotate.
CREATE OR REPLACE FUNCTION slotlock.create_scim_token(
  requested_tenant text, requested_actor text, requested_digest bytea, requested_prefix text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_create_scim_token$
DECLARE
  actor_role text;
BEGIN
  PERFORM 1 FROM slotlock.workspaces ws
   WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' AND ws.scim_enabled FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_enabled';
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN 'not_allowed';
  END IF;
  IF (SELECT count(*) FROM slotlock.scim_tokens token WHERE token.tenant_ref = requested_tenant AND token.revoked_at IS NULL)
     >= ${SLOTLOCK_SCIM_TOKEN_LIMIT} THEN
    RETURN 'token_limit';
  END IF;
  INSERT INTO slotlock.scim_tokens (tenant_ref, token_sha256, prefix, created_by)
  VALUES (requested_tenant, requested_digest, requested_prefix, requested_actor);
  RETURN NULL;
END
$slotlock_create_scim_token$;
REVOKE ALL ON FUNCTION ${fn[2]} FROM PUBLIC;

CREATE OR REPLACE FUNCTION slotlock.revoke_scim_token(requested_tenant text, requested_actor text, requested_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_revoke_scim_token$
DECLARE
  actor_role text;
BEGIN
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN 'not_allowed';
  END IF;
  UPDATE slotlock.scim_tokens token SET revoked_at = statement_timestamp()
   WHERE token.id = requested_id AND token.tenant_ref = requested_tenant AND token.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  RETURN NULL;
END
$slotlock_revoke_scim_token$;
REVOKE ALL ON FUNCTION ${fn[3]} FROM PUBLIC;

-- The team's directory as its Identity page shows it: on or off, its key policy, and its tokens.
CREATE OR REPLACE FUNCTION slotlock.scim_state(requested_tenant text)
RETURNS TABLE (enabled boolean, key_policy text, token_id uuid, prefix text, created_at timestamptz, last_used_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_scim_state$
  SELECT ws.scim_enabled, ws.scim_key_policy, token.id, token.prefix, token.created_at, token.last_used_at
    FROM slotlock.workspaces ws
    LEFT JOIN slotlock.scim_tokens token ON token.tenant_ref = ws.tenant_ref AND token.revoked_at IS NULL
   WHERE ws.tenant_ref = requested_tenant
   ORDER BY token.created_at;
$slotlock_scim_state$;
REVOKE ALL ON FUNCTION ${fn[4]} FROM PUBLIC;

-- A request's token: its team, which must be the team the address names (a token at another team's
-- address is wrong_workspace), while the directory is on.
CREATE OR REPLACE FUNCTION slotlock.scim_authenticate(requested_digest bytea, requested_team text)
RETURNS TABLE (team_ref text, token_prefix text, key_policy text, refusal text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_scim_authenticate$
DECLARE
  token slotlock.scim_tokens%ROWTYPE;
  policy text;
BEGIN
  SELECT * INTO token FROM slotlock.scim_tokens found WHERE found.token_sha256 = requested_digest AND found.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, 'bad_token'::text;
    RETURN;
  END IF;
  IF token.tenant_ref IS DISTINCT FROM requested_team THEN
    RETURN QUERY SELECT token.tenant_ref, token.prefix, NULL::text, 'wrong_workspace'::text;
    RETURN;
  END IF;
  SELECT ws.scim_key_policy INTO policy FROM slotlock.workspaces ws
   WHERE ws.tenant_ref = token.tenant_ref AND ws.status = 'active' AND ws.scim_enabled;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, 'bad_token'::text;
    RETURN;
  END IF;
  UPDATE slotlock.scim_tokens found SET last_used_at = statement_timestamp()
   WHERE found.id = token.id AND (found.last_used_at IS NULL OR found.last_used_at < statement_timestamp() - interval '1 minute');
  RETURN QUERY SELECT token.tenant_ref, token.prefix, policy, NULL::text;
END
$slotlock_scim_authenticate$;
REVOKE ALL ON FUNCTION ${fn[5]} FROM PUBLIC;

-- Create (requested_id null: requested_new_id) or replace a directory user, as scim.ts has already
-- worked out its attributes (a PUT, or a PATCH applied). Its address must be at a domain the team
-- has verified. Its active flag ends or restores the bound person's membership of this team; an
-- Owner's never. Returns the user's id, what happened to the membership, and the person.
CREATE OR REPLACE FUNCTION slotlock.scim_put_user(
  requested_tenant text, requested_id uuid, requested_new_id uuid, requested_user_name text, requested_external_id text,
  requested_active boolean, requested_given_name text, requested_family_name text, requested_display_name text,
  requested_work_email text)
RETURNS TABLE (user_id uuid, refusal text, membership text, person text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_scim_put_user$
DECLARE
  existing slotlock.scim_users%ROWTYPE;
  address text := lower(coalesce(requested_work_email, CASE WHEN requested_user_name LIKE '%@%' THEN requested_user_name END));
  saved uuid;
  bound text;
  member_role text;
  effect text := 'none';
BEGIN
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' AND ws.scim_enabled FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, 'not_found'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF address IS NULL OR NOT EXISTS (
    SELECT 1 FROM slotlock.workspace_domains claim
     WHERE claim.tenant_ref = requested_tenant AND claim.status = 'verified'
       AND claim.domain_ascii = lower(substring(address FROM '@([^@]+)$'))
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'domain_not_verified'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF requested_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM slotlock.scim_users other WHERE other.tenant_ref = requested_tenant
                AND other.user_name_key = lower(requested_user_name) AND other.deleted_at IS NULL) THEN
      RETURN QUERY SELECT NULL::uuid, 'uniqueness'::text, NULL::text, NULL::text;
      RETURN;
    END IF;
    -- A member now who joined by this address (an invitation, a domain) is this user already: the
    -- directory may end their membership, never change the role they were given by hand. Someone
    -- the team removed is nobody's user (ddl.ts remove_member).
    SELECT member.person_ref, member.role INTO bound, member_role FROM slotlock.workspace_memberships member
     WHERE member.tenant_ref = requested_tenant AND member.joined_email = address AND member.status = 'active'
     ORDER BY member.created_at LIMIT 1;
    IF member_role = 'owner' AND NOT requested_active THEN
      RETURN QUERY SELECT NULL::uuid, 'owner_protected'::text, NULL::text, bound;
      RETURN;
    END IF;
    INSERT INTO slotlock.scim_users (id, tenant_ref, user_name, user_name_key, external_id, active, given_name, family_name,
                                     display_name, work_email, person_ref)
    VALUES (requested_new_id, requested_tenant, requested_user_name, lower(requested_user_name), requested_external_id,
            requested_active, requested_given_name, requested_family_name, requested_display_name,
            lower(requested_work_email), bound)
    RETURNING id INTO saved;
    existing.active := true;
    existing.person_ref := bound;
  ELSE
    SELECT * INTO existing FROM slotlock.scim_users found
     WHERE found.id = requested_id AND found.tenant_ref = requested_tenant AND found.deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT NULL::uuid, 'not_found'::text, NULL::text, NULL::text;
      RETURN;
    END IF;
    IF lower(requested_user_name) <> existing.user_name_key AND EXISTS (
      SELECT 1 FROM slotlock.scim_users other WHERE other.tenant_ref = requested_tenant AND other.id <> existing.id
         AND other.user_name_key = lower(requested_user_name) AND other.deleted_at IS NULL
    ) THEN
      RETURN QUERY SELECT NULL::uuid, 'uniqueness'::text, NULL::text, NULL::text;
      RETURN;
    END IF;
    saved := existing.id;
    bound := existing.person_ref;
  END IF;
  IF bound IS NOT NULL THEN
    SELECT member.role INTO member_role FROM slotlock.workspace_memberships member
     WHERE member.tenant_ref = requested_tenant AND member.person_ref = bound;
    IF member_role = 'owner' AND NOT requested_active THEN
      RETURN QUERY SELECT saved, 'owner_protected'::text, NULL::text, bound;
      RETURN;
    END IF;
  END IF;
  IF requested_id IS NOT NULL THEN
    UPDATE slotlock.scim_users found
       SET user_name = requested_user_name, user_name_key = lower(requested_user_name), external_id = requested_external_id,
           active = requested_active, given_name = requested_given_name, family_name = requested_family_name,
           display_name = requested_display_name, work_email = lower(requested_work_email), updated_at = statement_timestamp()
     WHERE found.id = saved;
  END IF;
  IF bound IS NOT NULL AND member_role IS DISTINCT FROM 'owner' THEN
    IF NOT requested_active AND existing.active THEN
      UPDATE slotlock.workspace_memberships member
         SET status = 'inactive', deactivated_at = statement_timestamp(), deactivated_by = 'scim', updated_at = statement_timestamp()
       WHERE member.tenant_ref = requested_tenant AND member.person_ref = bound AND member.status = 'active';
      effect := 'deactivated';
    ELSIF requested_active THEN
      -- Back in the directory: only a membership the directory itself ended returns, and not for an
      -- address the team removed; for sessions begun from now on.
      UPDATE slotlock.workspace_memberships member
         SET status = 'active', deactivated_at = NULL, deactivated_by = NULL, sessions_valid_after = statement_timestamp(),
             role = CASE WHEN member.role_managed_by = 'manual' THEN member.role ELSE ${ROLE_OF_USER('requested_tenant', 'saved')} END,
             updated_at = statement_timestamp()
       WHERE member.tenant_ref = requested_tenant AND member.person_ref = bound AND member.status = 'inactive'
         AND member.deactivated_by = 'scim'
         AND NOT EXISTS (SELECT 1 FROM slotlock.workspace_join_blocks blocked
                          WHERE blocked.tenant_ref = requested_tenant
                            AND blocked.email_sha256 = sha256(convert_to(address, 'UTF8')));
      IF FOUND THEN
        effect := 'activated';
      END IF;
    END IF;
  END IF;
  RETURN QUERY SELECT saved, NULL::text, effect, bound;
END
$slotlock_scim_put_user$;
REVOKE ALL ON FUNCTION ${fn[6]} FROM PUBLIC;

-- A team's directory users, filtered by one attribute (username, externalid, id, email: exact, the
-- user name case-insensitively), in a stable order, a page at a time, with the total.
CREATE OR REPLACE FUNCTION slotlock.scim_users_list(
  requested_tenant text, requested_attribute text, requested_value text, requested_start integer, requested_count integer,
  requested_id uuid)
RETURNS TABLE (user_id uuid, user_name text, external_id text, active boolean, given_name text, family_name text,
               display_name text, work_email text, created_at timestamptz, updated_at timestamptz, total integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_scim_users_list$
  WITH matched AS (
    SELECT found.* FROM slotlock.scim_users found
     WHERE found.tenant_ref = requested_tenant AND found.deleted_at IS NULL
       AND (requested_id IS NULL OR found.id = requested_id)
       AND (requested_attribute IS NULL
            OR (requested_attribute = 'username' AND found.user_name_key = lower(requested_value))
            OR (requested_attribute = 'externalid' AND found.external_id = requested_value)
            OR (requested_attribute = 'id' AND found.id::text = lower(requested_value))
            OR (requested_attribute = 'email' AND found.work_email = lower(requested_value)))
  )
  SELECT matched.id, matched.user_name, matched.external_id, matched.active, matched.given_name, matched.family_name,
         matched.display_name, matched.work_email, matched.created_at, matched.updated_at,
         (SELECT count(*)::integer FROM matched)
    FROM matched
   ORDER BY matched.created_at, matched.id
  OFFSET greatest(coalesce(requested_start, 1), 1) - 1
   LIMIT least(greatest(coalesce(requested_count, 100), 0), 100);
$slotlock_scim_users_list$;
REVOKE ALL ON FUNCTION ${fn[7]} FROM PUBLIC;

-- Delete a directory user (Entra, 30 days after a soft delete): the membership ends, as on
-- deactivation; an Owner's is refused. A user made again with the same name gets a new id.
CREATE OR REPLACE FUNCTION slotlock.scim_delete_user(requested_tenant text, requested_id uuid)
RETURNS TABLE (refusal text, person text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_scim_delete_user$
DECLARE
  existing slotlock.scim_users%ROWTYPE;
BEGIN
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  SELECT * INTO existing FROM slotlock.scim_users found
   WHERE found.id = requested_id AND found.tenant_ref = requested_tenant AND found.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;
  IF existing.person_ref IS NOT NULL AND EXISTS (
    SELECT 1 FROM slotlock.workspace_memberships member
     WHERE member.tenant_ref = requested_tenant AND member.person_ref = existing.person_ref AND member.role = 'owner'
  ) THEN
    RETURN QUERY SELECT 'owner_protected'::text, existing.person_ref;
    RETURN;
  END IF;
  -- Deleted in the directory: nothing of the user is kept (their membership ends, by the directory).
  DELETE FROM slotlock.scim_group_members membership WHERE membership.user_id = existing.id;
  DELETE FROM slotlock.scim_users found WHERE found.id = existing.id;
  IF existing.person_ref IS NOT NULL THEN
    UPDATE slotlock.workspace_memberships member
       SET status = 'inactive', deactivated_at = statement_timestamp(), deactivated_by = 'scim', updated_at = statement_timestamp()
     WHERE member.tenant_ref = requested_tenant AND member.person_ref = existing.person_ref AND member.status = 'active';
  END IF;
  RETURN QUERY SELECT NULL::text, existing.person_ref;
END
$slotlock_scim_delete_user$;
REVOKE ALL ON FUNCTION ${fn[8]} FROM PUBLIC;

-- Create (requested_id null) or replace a group with its members, as scim.ts worked them out; a name
-- slotlock-role-<role> gives that role (never Owner). Each member's role is recomputed after: the
-- highest their groups give, for members the directory manages, never an Owner.
CREATE OR REPLACE FUNCTION slotlock.scim_put_group(
  requested_tenant text, requested_id uuid, requested_new_id uuid, requested_display_name text, requested_external_id text,
  requested_members uuid[])
RETURNS TABLE (group_id uuid, refusal text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_scim_put_group$
DECLARE
  saved uuid;
  reserved text := substring(lower(requested_display_name) FROM '^slotlock-role-(admin|developer|member|viewer|billing)$');
  affected uuid[];
BEGIN
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' AND ws.scim_enabled FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, 'not_found'::text;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM slotlock.scim_groups other
              WHERE other.tenant_ref = requested_tenant AND other.display_name_key = lower(requested_display_name)
                AND other.deleted_at IS NULL AND other.id IS DISTINCT FROM requested_id) THEN
    RETURN QUERY SELECT NULL::uuid, 'uniqueness'::text;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(coalesce(requested_members, ARRAY[]::uuid[])) given
              WHERE NOT EXISTS (SELECT 1 FROM slotlock.scim_users found
                                 WHERE found.id = given AND found.tenant_ref = requested_tenant AND found.deleted_at IS NULL)) THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_member'::text;
    RETURN;
  END IF;
  IF requested_id IS NULL THEN
    INSERT INTO slotlock.scim_groups (id, tenant_ref, display_name, display_name_key, external_id, role)
    VALUES (requested_new_id, requested_tenant, requested_display_name, lower(requested_display_name), requested_external_id, reserved)
    RETURNING id INTO saved;
  ELSE
    UPDATE slotlock.scim_groups found
       SET display_name = requested_display_name, display_name_key = lower(requested_display_name),
           external_id = requested_external_id,
           role = CASE WHEN reserved IS NOT NULL THEN reserved
                       WHEN found.display_name_key ~ '^slotlock-role-' THEN NULL ELSE found.role END,
           updated_at = statement_timestamp()
     WHERE found.id = requested_id AND found.tenant_ref = requested_tenant AND found.deleted_at IS NULL
    RETURNING found.id INTO saved;
    IF saved IS NULL THEN
      RETURN QUERY SELECT NULL::uuid, 'not_found'::text;
      RETURN;
    END IF;
  END IF;
  SELECT array_agg(DISTINCT member_id) INTO affected FROM (
    SELECT membership.user_id AS member_id FROM slotlock.scim_group_members membership WHERE membership.group_id = saved
    UNION SELECT unnest(coalesce(requested_members, ARRAY[]::uuid[]))) changed;
  DELETE FROM slotlock.scim_group_members membership WHERE membership.group_id = saved;
  INSERT INTO slotlock.scim_group_members (group_id, user_id)
  SELECT saved, given FROM unnest(coalesce(requested_members, ARRAY[]::uuid[])) given ON CONFLICT DO NOTHING;
  -- Every affected member the directory manages: the role their groups give now.
  UPDATE slotlock.workspace_memberships member
     SET role = ${ROLE_OF_USER('requested_tenant', 'directory.id')}, updated_at = statement_timestamp()
    FROM slotlock.scim_users directory
   WHERE directory.id = ANY (coalesce(affected, ARRAY[]::uuid[])) AND directory.person_ref = member.person_ref
     AND member.tenant_ref = requested_tenant AND member.role_managed_by = 'scim' AND member.role <> 'owner';
  RETURN QUERY SELECT saved, NULL::text;
END
$slotlock_scim_put_group$;
REVOKE ALL ON FUNCTION ${fn[9]} FROM PUBLIC;

CREATE OR REPLACE FUNCTION slotlock.scim_groups_list(
  requested_tenant text, requested_attribute text, requested_value text, requested_start integer, requested_count integer,
  requested_id uuid)
RETURNS TABLE (group_id uuid, display_name text, external_id text, members uuid[], created_at timestamptz,
               updated_at timestamptz, total integer, mapped_role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_scim_groups_list$
  WITH matched AS (
    SELECT found.* FROM slotlock.scim_groups found
     WHERE found.tenant_ref = requested_tenant AND found.deleted_at IS NULL
       AND (requested_id IS NULL OR found.id = requested_id)
       AND (requested_attribute IS NULL
            OR (requested_attribute = 'displayname' AND found.display_name_key = lower(requested_value))
            OR (requested_attribute = 'externalid' AND found.external_id = requested_value)
            OR (requested_attribute = 'id' AND found.id::text = lower(requested_value)))
  )
  SELECT matched.id, matched.display_name, matched.external_id,
         coalesce((SELECT array_agg(membership.user_id ORDER BY membership.user_id) FROM slotlock.scim_group_members membership
                    WHERE membership.group_id = matched.id), ARRAY[]::uuid[]),
         matched.created_at, matched.updated_at, (SELECT count(*)::integer FROM matched), matched.role
    FROM matched
   ORDER BY matched.created_at, matched.id
  OFFSET greatest(coalesce(requested_start, 1), 1) - 1
   LIMIT least(greatest(coalesce(requested_count, 100), 0), 100);
$slotlock_scim_groups_list$;
REVOKE ALL ON FUNCTION ${fn[10]} FROM PUBLIC;

-- Delete a group: its members' roles fall back to what their other groups give; nobody is deactivated.
CREATE OR REPLACE FUNCTION slotlock.scim_delete_group(requested_tenant text, requested_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_scim_delete_group$
DECLARE
  affected uuid[];
BEGIN
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  SELECT array_agg(membership.user_id) INTO affected FROM slotlock.scim_group_members membership WHERE membership.group_id = requested_id;
  UPDATE slotlock.scim_groups found SET deleted_at = statement_timestamp()
   WHERE found.id = requested_id AND found.tenant_ref = requested_tenant AND found.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  DELETE FROM slotlock.scim_group_members membership WHERE membership.group_id = requested_id;
  UPDATE slotlock.workspace_memberships member
     SET role = ${ROLE_OF_USER('requested_tenant', 'directory.id')}, updated_at = statement_timestamp()
    FROM slotlock.scim_users directory
   WHERE directory.id = ANY (coalesce(affected, ARRAY[]::uuid[])) AND directory.person_ref = member.person_ref
     AND member.tenant_ref = requested_tenant AND member.role_managed_by = 'scim' AND member.role <> 'owner';
  RETURN NULL;
END
$slotlock_scim_delete_group$;
REVOKE ALL ON FUNCTION ${fn[11]} FROM PUBLIC;

-- Map any pushed group to a role (never Owner), by an Owner; null unmaps it.
CREATE OR REPLACE FUNCTION slotlock.map_scim_group_role(requested_tenant text, requested_actor text, requested_id uuid, requested_role text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_map_scim_group_role$
DECLARE
  actor_role text;
BEGIN
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN 'not_allowed';
  END IF;
  IF requested_role = 'owner' THEN
    RETURN 'owner_not_mappable';
  END IF;
  IF requested_role IS NOT NULL AND requested_role NOT IN ('admin', 'developer', 'member', 'viewer', 'billing') THEN
    RETURN 'role_not_allowed';
  END IF;
  UPDATE slotlock.scim_groups found SET role = requested_role, updated_at = statement_timestamp()
   WHERE found.id = requested_id AND found.tenant_ref = requested_tenant AND found.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  UPDATE slotlock.workspace_memberships member
     SET role = ${ROLE_OF_USER('requested_tenant', 'directory.id')}, updated_at = statement_timestamp()
    FROM slotlock.scim_users directory
    JOIN slotlock.scim_group_members membership ON membership.user_id = directory.id AND membership.group_id = requested_id
   WHERE directory.person_ref = member.person_ref
     AND member.tenant_ref = requested_tenant AND member.role_managed_by = 'scim' AND member.role <> 'owner';
  RETURN NULL;
END
$slotlock_map_scim_group_role$;
REVOKE ALL ON FUNCTION ${fn[12]} FROM PUBLIC;

-- A sign-in holding addresses the domain itself vouches for (the caller passes only those: a Google
-- Workspace account of the domain, or an address the team's own provider sent): each active directory
-- user of a team whose directory is on, not bound yet, at one of those addresses, binds to the person,
-- who becomes a member (the role their groups give), unless the team removed them or that address.
-- Returns the teams joined.
CREATE OR REPLACE FUNCTION slotlock.scim_bind(requested_person text, requested_emails text[], requested_free_cap integer)
RETURNS TABLE (team_ref text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_scim_bind$
DECLARE
  directory slotlock.scim_users%ROWTYPE;
BEGIN
  IF requested_person IS NULL OR requested_person !~ '${PERSON}' THEN
    RETURN;
  END IF;
  FOR directory IN
    SELECT found.* FROM slotlock.scim_users found
      JOIN slotlock.workspaces ws ON ws.tenant_ref = found.tenant_ref AND ws.status = 'active' AND ws.scim_enabled
     WHERE found.deleted_at IS NULL AND found.active AND found.person_ref IS NULL
       AND coalesce(found.work_email, found.user_name_key) IN (SELECT lower(btrim(given)) FROM unnest(coalesce(requested_emails, ARRAY[]::text[])) given)
       AND NOT EXISTS (SELECT 1 FROM slotlock.scim_users taken
                        WHERE taken.tenant_ref = found.tenant_ref AND taken.person_ref = requested_person AND taken.deleted_at IS NULL)
       -- At a domain the team still holds verified (a released or lapsed one may be someone else's).
       AND EXISTS (SELECT 1 FROM slotlock.workspace_domains claim
                    WHERE claim.tenant_ref = found.tenant_ref AND claim.status = 'verified'
                      AND claim.domain_ascii = lower(substring(coalesce(found.work_email, found.user_name_key) FROM '@([^@]+)$')))
       -- Someone the team removed, or who left, or whose address it removed or declined, is not
       -- brought back; one the directory itself ended is.
       AND NOT EXISTS (SELECT 1 FROM slotlock.workspace_memberships removed
                        WHERE removed.tenant_ref = found.tenant_ref AND removed.person_ref = requested_person
                          AND removed.status = 'inactive' AND removed.deactivated_by IS DISTINCT FROM 'scim')
       AND NOT EXISTS (SELECT 1 FROM slotlock.workspace_join_blocks blocked
                        WHERE blocked.tenant_ref = found.tenant_ref
                          AND blocked.email_sha256 = sha256(convert_to(coalesce(found.work_email, found.user_name_key), 'UTF8')))
     ORDER BY found.created_at
     LIMIT 20
  LOOP
    PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = directory.tenant_ref FOR UPDATE;
    -- A team on the free plan holds its member cap (the caller passes it where plans apply).
    IF requested_free_cap IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM slotlock.tenant_plans billed WHERE billed.tenant_ref = directory.tenant_ref
                        AND billed.plan <> 'free' AND billed.status <> 'canceled')
       AND NOT EXISTS (SELECT 1 FROM slotlock.workspace_memberships mine
                        WHERE mine.tenant_ref = directory.tenant_ref AND mine.person_ref = requested_person AND mine.status = 'active')
       AND (SELECT count(*) FROM slotlock.workspace_memberships member
             WHERE member.tenant_ref = directory.tenant_ref AND member.status = 'active')
         + (SELECT count(*) FROM slotlock.workspace_invitations pending
             WHERE pending.tenant_ref = directory.tenant_ref AND pending.accepted_at IS NULL
               AND pending.revoked_at IS NULL AND pending.expires_at > statement_timestamp()) >= requested_free_cap THEN
      CONTINUE;
    END IF;
    UPDATE slotlock.scim_users found SET person_ref = requested_person WHERE found.id = directory.id AND found.person_ref IS NULL;
    IF FOUND THEN
      INSERT INTO slotlock.workspace_memberships AS member
        (tenant_ref, person_ref, role, source, role_managed_by, joined_email)
      VALUES (directory.tenant_ref, requested_person, ${ROLE_OF_USER('directory.tenant_ref', 'directory.id')}, 'scim', 'scim',
              coalesce(directory.work_email, directory.user_name_key))
      ON CONFLICT ON CONSTRAINT slotlock_workspace_memberships_pkey DO UPDATE
         SET status = 'active', deactivated_at = NULL, deactivated_by = NULL,
             sessions_valid_after = CASE WHEN member.status = 'inactive' THEN statement_timestamp() ELSE member.sessions_valid_after END,
             -- The directory decides the role from now on, unless an Owner set it by hand, or it is an Owner's.
             role_managed_by = CASE WHEN member.role_managed_by = 'manual' OR member.role = 'owner' THEN member.role_managed_by ELSE 'scim' END,
             role = CASE WHEN member.role_managed_by = 'manual' OR member.role = 'owner' THEN member.role ELSE excluded.role END,
             updated_at = statement_timestamp();
      team_ref := directory.tenant_ref;
      RETURN NEXT;
    END IF;
  END LOOP;
END
$slotlock_scim_bind$;
REVOKE ALL ON FUNCTION ${fn[13]} FROM PUBLIC;
`;
