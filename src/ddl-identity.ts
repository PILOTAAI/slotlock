// Teams phase 5: a team's verified domains, and joining a team by one (src/domains.ts has the DNS
// side). Reached only through the SECURITY DEFINER functions below, as the rest of the dashboard's
// records are: each locks the team's row before it changes the team's people, checks the actor's
// role itself, and answers with a refusal code rather than an error.
//
// A domain a team claims is `pending` until its TXT record is found (seven days at most), then
// `verified`. It is looked up again every day: absent from both resolvers on two checks a day apart,
// it is `lapsing` and its token is replaced, so only a record published after the absence restores
// it; fourteen days later it has `lapsed`, and another team may claim it. At most one team holds a
// domain at a time. A domain's join policy decides what a person whose verified address is at it may
// do: ask to join (`request`, the default), join as a Viewer at once (`auto`), or nothing (`off`).

/**
 * Who a person is, as every dashboard table checks it: a GitHub account, a Google account, or a
 * person a team's identity provider signed in (sso:<uuid>, teams phase 5.4).
 */
export const SLOTLOCK_PERSON_PATTERN =
  '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255}|sso:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$';
const PERSON = SLOTLOCK_PERSON_PATTERN;
/** A domain as normalizeSlotlockDomain keys it: lowercase ASCII labels, two or more. */
const DOMAIN = '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$';

/** The tables of verified domains and requests to join: their owner's only. */
export const SLOTLOCK_IDENTITY_TABLES = Object.freeze(['workspace_domains', 'workspace_join_requests', 'workspace_join_blocks'] as const);

/** The SECURITY DEFINER functions through which the serving role reaches them. */
export const SLOTLOCK_IDENTITY_FUNCTIONS = Object.freeze([
  'slotlock.claim_domain(text, text, text, text, text)',
  'slotlock.workspace_domains_list(text)',
  'slotlock.record_domain_check(uuid, text, text, text, text, text)',
  'slotlock.domains_due(integer)',
  'slotlock.release_domain(text, text, uuid)',
  'slotlock.set_invite_domain_restriction(text, text, boolean)',
  'slotlock.set_domain_join_policy(text, text, uuid, text)',
  'slotlock.discoverable_workspaces(text, text[])',
  'slotlock.request_to_join(text, text, text[], text, integer)',
  'slotlock.workspace_join_requests_list(text)',
  'slotlock.decide_join_request(text, text, uuid, text, text, integer)',
  'slotlock.workspace_domain_members(text)',
  'slotlock.prune_workspace_domains()',
  'slotlock.workspace_invites_restricted(text)',
] as const);

/** How many domains a team may claim or hold at once. */
export const SLOTLOCK_WORKSPACE_DOMAIN_LIMIT = 20;
/**
 * How a person's address was verified, as a request to join records it: by a Google Workspace
 * account of that domain (Google's `hd` claim), the only evidence that lets someone join at once;
 * or by a Google or GitHub account that verified it once and never checks again, which only asks.
 */
export const SLOTLOCK_JOIN_EVIDENCE = Object.freeze(['google_workspace', 'google', 'github'] as const);

/**
 * SQL that is true when a team holds its invitations to its verified domains and the invitation
 * (to `email`, or to the GitHub account `github`) is not to one of them.
 */
export const SLOTLOCK_INVITE_DOMAIN_REFUSED = (tenant: string, email: string, github: string) =>
  `(coalesce((SELECT ws.invites_domain_restricted FROM slotlock.workspaces ws WHERE ws.tenant_ref = ${tenant}), false)
     AND (${github} IS NOT NULL OR ${email} IS NULL OR NOT EXISTS (
       SELECT 1 FROM slotlock.workspace_domains claim
        WHERE claim.tenant_ref = ${tenant} AND claim.status IN ('verified', 'lapsing')
          AND lower(substring(${email} FROM '@([^@]+)$')) IN (claim.domain_ascii, claim.domain_unicode))))`;

/** Requests to join a person may make a day, across every team. */
export const SLOTLOCK_JOIN_REQUEST_DAILY_LIMIT = 20;

const fn = SLOTLOCK_IDENTITY_FUNCTIONS;

/** The addresses given, as `local@ascii-domain` lowercase: the domains an address is matched on. */
const EMAIL_DOMAINS = (emails: string) =>
  `(SELECT lower(substring(btrim(given) FROM '@([^@]+)$')) FROM unnest(coalesce(${emails}, ARRAY[]::text[])) given)`;

export const SLOTLOCK_IDENTITY_DDL = `
-- A team's claim on a domain, and the domain once verified. The token is public by design (it is
-- published in DNS): it is unique to the claim, so one team's record never verifies another's.
CREATE TABLE IF NOT EXISTS slotlock.workspace_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL REFERENCES slotlock.workspaces (tenant_ref) ON DELETE CASCADE,
  domain_ascii text NOT NULL,
  domain_unicode text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  token text NOT NULL,
  join_policy text NOT NULL DEFAULT 'request',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_seen_at timestamptz,
  missing_since timestamptz,
  error_since timestamptz,
  lapse_after timestamptz,
  ended_at timestamptz,
  CONSTRAINT slotlock_workspace_domains_valid CHECK (
    char_length(domain_ascii) BETWEEN 3 AND 253
    AND domain_ascii ~ '${DOMAIN}'
    AND char_length(domain_unicode) BETWEEN 3 AND 253
    AND domain_unicode !~ '[[:space:][:cntrl:]@/<>]'
    AND status IN ('pending', 'verified', 'lapsing', 'lapsed', 'released')
    AND token ~ '^[a-z2-7]{26}$'
    AND join_policy IN ('off', 'request', 'auto')
    AND (created_by IS NULL OR created_by ~ '${PERSON}')
    AND (status NOT IN ('verified', 'lapsing') OR verified_at IS NOT NULL)
    AND (status = 'lapsing') = (lapse_after IS NOT NULL)
    AND (status IN ('lapsed', 'released')) = (ended_at IS NOT NULL)
  )
);
-- One team holds a domain at a time; a team claims each once.
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_workspace_domains_held_key
  ON slotlock.workspace_domains (domain_ascii) WHERE status IN ('verified', 'lapsing');
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_workspace_domains_claim_key
  ON slotlock.workspace_domains (tenant_ref, domain_ascii) WHERE status IN ('pending', 'verified', 'lapsing');
CREATE INDEX IF NOT EXISTS slotlock_workspace_domains_due_idx
  ON slotlock.workspace_domains (last_checked_at NULLS FIRST) WHERE status IN ('pending', 'verified', 'lapsing');
ALTER TABLE slotlock.workspace_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.workspace_domains FROM PUBLIC;

-- Invitations only to addresses at the team's verified domains, when its Owner says so.
ALTER TABLE slotlock.workspaces ADD COLUMN IF NOT EXISTS invites_domain_restricted boolean NOT NULL DEFAULT false;

-- A membership a domain gave (asked for and approved, or joined at once), and through which domain;
-- and the address a membership came by (a domain's, or an invitation's), to remember a removal by.
ALTER TABLE slotlock.workspace_memberships ADD COLUMN IF NOT EXISTS joined_via_domain uuid
  REFERENCES slotlock.workspace_domains (id) ON DELETE SET NULL;
ALTER TABLE slotlock.workspace_memberships ADD COLUMN IF NOT EXISTS joined_email text
  CONSTRAINT slotlock_workspace_memberships_joined_email_valid
  CHECK (joined_email IS NULL OR (char_length(joined_email) BETWEEN 3 AND 254 AND joined_email = lower(joined_email)));
DO $slotlock_memberships_sources$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'slotlock_workspace_memberships_valid' AND conrelid = 'slotlock.workspace_memberships'::regclass
       AND pg_get_constraintdef(oid) LIKE '%''scim''%'
  ) THEN
    ALTER TABLE slotlock.workspace_memberships DROP CONSTRAINT IF EXISTS slotlock_workspace_memberships_valid;
    ALTER TABLE slotlock.workspace_memberships ADD CONSTRAINT slotlock_workspace_memberships_valid CHECK (
      tenant_ref ~ '^(github-org:[1-9][0-9]{0,19}|team:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
      AND person_ref ~ '${PERSON}'
      AND role IN ('owner', 'admin', 'developer', 'member', 'viewer', 'billing')
      AND status IN ('active', 'inactive')
      AND source IN ('github_org', 'invitation', 'created', 'domain', 'sso', 'scim')
      AND (status = 'active') = (deactivated_at IS NULL)
    );
  END IF;
END
$slotlock_memberships_sources$;

-- A person's request to join a team, by an address they hold verified at one of its domains. It
-- waits seven days for an Owner or Admin, who picks the role (Viewer, Member or Developer).
CREATE TABLE IF NOT EXISTS slotlock.workspace_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_ref text NOT NULL REFERENCES slotlock.workspaces (tenant_ref) ON DELETE CASCADE,
  domain_id uuid NOT NULL REFERENCES slotlock.workspace_domains (id) ON DELETE CASCADE,
  person_ref text NOT NULL,
  email text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  role text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz,
  CONSTRAINT slotlock_workspace_join_requests_valid CHECK (
    person_ref ~ '${PERSON}'
    AND char_length(email) BETWEEN 3 AND 254
    AND email ~ '^[^@[:space:][:cntrl:]<>]+@[^@[:space:][:cntrl:]<>]+$'
    AND status IN ('pending', 'approved', 'declined', 'expired')
    AND (role IS NULL OR role IN ('developer', 'member', 'viewer'))
    AND (status = 'approved') = (role IS NOT NULL)
    AND (decided_by IS NULL OR decided_by ~ '${PERSON}')
    AND expires_at > created_at
  )
);
ALTER TABLE slotlock.workspace_join_requests ADD COLUMN IF NOT EXISTS evidence text NOT NULL DEFAULT 'github'
  CONSTRAINT slotlock_workspace_join_requests_evidence_valid CHECK (evidence IN ('google_workspace', 'google', 'github'));
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_workspace_join_requests_pending_key
  ON slotlock.workspace_join_requests (tenant_ref, person_ref) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS slotlock_workspace_join_requests_person_idx
  ON slotlock.workspace_join_requests (person_ref, created_at);
ALTER TABLE slotlock.workspace_join_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.workspace_join_requests FROM PUBLIC;

-- Addresses a team removed or declined, by their SHA-256 only: whoever holds one asks again rather
-- than joining at once, under any account and after erasing the one they had. A team's record of its
-- own decision: it goes with the team, or a year after it was made, or when a request is approved.
CREATE TABLE IF NOT EXISTS slotlock.workspace_join_blocks (
  tenant_ref text NOT NULL REFERENCES slotlock.workspaces (tenant_ref) ON DELETE CASCADE,
  email_sha256 bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_workspace_join_blocks_pkey PRIMARY KEY (tenant_ref, email_sha256),
  CONSTRAINT slotlock_workspace_join_blocks_valid CHECK (octet_length(email_sha256) = 32)
);
ALTER TABLE slotlock.workspace_join_blocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.workspace_join_blocks FROM PUBLIC;

-- Claim a domain for a team, by its Owner, with a new token. A claim already pending past its seven
-- days is claimed afresh (a new token); one the team claimed or holds already is refused.
-- The caller has normalised and checked the domain (public suffixes, consumer mail); the shape is
-- checked again here.
CREATE OR REPLACE FUNCTION slotlock.claim_domain(
  requested_tenant text, requested_actor text, requested_ascii text, requested_unicode text, requested_token text)
RETURNS TABLE (claimed_id uuid, refusal text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_claim_domain$
DECLARE
  actor_role text;
  existing slotlock.workspace_domains%ROWTYPE;
  created uuid;
BEGIN
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, 'not_found'::text;
    RETURN;
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN QUERY SELECT NULL::uuid, 'not_allowed'::text;
    RETURN;
  END IF;
  IF requested_ascii IS NULL OR char_length(requested_ascii) NOT BETWEEN 3 AND 253 OR requested_ascii !~ '${DOMAIN}'
     OR requested_unicode IS NULL OR char_length(requested_unicode) NOT BETWEEN 3 AND 253
     OR requested_unicode ~ '[[:space:][:cntrl:]@/<>]' OR requested_token IS NULL OR requested_token !~ '^[a-z2-7]{26}$' THEN
    RETURN QUERY SELECT NULL::uuid, 'invalid_domain'::text;
    RETURN;
  END IF;
  -- Whether another team holds it is not said here, where anyone with a team could ask of any
  -- domain: only to a team that publishes its own record (record_domain_check's domain_taken).
  SELECT * INTO existing FROM slotlock.workspace_domains claim
   WHERE claim.tenant_ref = requested_tenant AND claim.domain_ascii = requested_ascii
     AND claim.status IN ('pending', 'verified', 'lapsing')
   FOR UPDATE;
  IF FOUND THEN
    IF existing.status = 'pending' AND existing.created_at <= statement_timestamp() - interval '7 days' THEN
      UPDATE slotlock.workspace_domains claim
         SET token = requested_token, domain_unicode = requested_unicode, created_by = requested_actor,
             created_at = statement_timestamp(), last_checked_at = NULL, error_since = NULL
       WHERE claim.id = existing.id;
      RETURN QUERY SELECT existing.id, NULL::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT existing.id, 'already_claimed'::text;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM slotlock.workspace_domains claim
       WHERE claim.tenant_ref = requested_tenant AND claim.status IN ('pending', 'verified', 'lapsing'))
     >= ${SLOTLOCK_WORKSPACE_DOMAIN_LIMIT} THEN
    RETURN QUERY SELECT NULL::uuid, 'domain_limit'::text;
    RETURN;
  END IF;
  INSERT INTO slotlock.workspace_domains (tenant_ref, domain_ascii, domain_unicode, token, created_by)
  VALUES (requested_tenant, requested_ascii, requested_unicode, requested_token, requested_actor)
  RETURNING id INTO created;
  RETURN QUERY SELECT created, NULL::text;
END
$slotlock_claim_domain$;
REVOKE ALL ON FUNCTION ${fn[0]} FROM PUBLIC;

-- A team's domains as its Identity page shows them: claims pending (or past their seven days),
-- verified and lapsing ones. The token is public: it is the record the team publishes.
CREATE OR REPLACE FUNCTION slotlock.workspace_domains_list(requested_tenant text)
RETURNS TABLE (domain_id uuid, domain_ascii text, domain_unicode text, status text, token text,
               join_policy text, created_at timestamptz, verified_at timestamptz,
               last_checked_at timestamptz, missing_since timestamptz, error_since timestamptz,
               lapse_after timestamptz, expired boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_workspace_domains_list$
  SELECT claim.id, claim.domain_ascii, claim.domain_unicode, claim.status, claim.token, claim.join_policy,
         claim.created_at, claim.verified_at, claim.last_checked_at, claim.missing_since, claim.error_since,
         claim.lapse_after,
         claim.status = 'pending' AND claim.created_at <= statement_timestamp() - interval '7 days'
    FROM slotlock.workspace_domains claim
   WHERE claim.tenant_ref = requested_tenant AND claim.status IN ('pending', 'verified', 'lapsing')
   ORDER BY claim.domain_ascii;
$slotlock_workspace_domains_list$;
REVOKE ALL ON FUNCTION ${fn[1]} FROM PUBLIC;

-- What a lookup of a claim's record found, applied: by the daily check (no actor), or by an Owner's
-- "Verify now" (at most once a minute). requested_checked_token is the token the lookup asked for:
-- if the claim's has changed since, nothing changes. requested_primary is the first resolver's
-- verdict, requested_secondary the second's (null with one resolver). requested_next_token replaces
-- the token when the domain starts to lapse. Returns what happened, and the claim's team and domain
-- for the audit log.
CREATE OR REPLACE FUNCTION slotlock.record_domain_check(
  requested_domain uuid, requested_actor text, requested_checked_token text, requested_primary text,
  requested_secondary text, requested_next_token text)
RETURNS TABLE (outcome text, team_ref text, domain_name text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_record_domain_check$
DECLARE
  claim slotlock.workspace_domains%ROWTYPE;
  actor_role text;
  both_absent boolean;
BEGIN
  IF requested_primary IS NULL OR requested_primary NOT IN ('present', 'absent', 'error')
     OR (requested_secondary IS NOT NULL AND requested_secondary NOT IN ('present', 'absent', 'error')) THEN
    RAISE EXCEPTION 'Slotlock domains: a verdict is present, absent or error' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO claim FROM slotlock.workspace_domains found WHERE found.id = requested_domain FOR UPDATE;
  IF NOT FOUND OR claim.status NOT IN ('pending', 'verified', 'lapsing') THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF requested_actor IS NOT NULL THEN
    SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
     WHERE member.tenant_ref = claim.tenant_ref AND member.person_ref = requested_actor AND member.status = 'active';
    IF actor_role IS DISTINCT FROM 'owner' THEN
      RETURN QUERY SELECT 'not_allowed'::text, NULL::text, NULL::text;
      RETURN;
    END IF;
    IF claim.last_checked_at > statement_timestamp() - interval '1 minute' THEN
      RETURN QUERY SELECT 'too_soon'::text, claim.tenant_ref, claim.domain_ascii;
      RETURN;
    END IF;
  END IF;
  IF claim.status = 'pending' AND claim.created_at <= statement_timestamp() - interval '7 days' THEN
    RETURN QUERY SELECT 'expired'::text, claim.tenant_ref, claim.domain_ascii;
    RETURN;
  END IF;
  IF requested_checked_token IS DISTINCT FROM claim.token THEN
    RETURN QUERY SELECT 'unchanged'::text, claim.tenant_ref, claim.domain_ascii;
    RETURN;
  END IF;
  UPDATE slotlock.workspace_domains found SET last_checked_at = statement_timestamp() WHERE found.id = claim.id;
  both_absent := requested_primary = 'absent' AND coalesce(requested_secondary, 'absent') = 'absent';

  IF claim.status = 'pending' THEN
    IF requested_primary = 'present' THEN
      BEGIN
        UPDATE slotlock.workspace_domains found
           SET status = 'verified', verified_at = statement_timestamp(), last_seen_at = statement_timestamp(),
               missing_since = NULL, error_since = NULL
         WHERE found.id = claim.id;
      EXCEPTION WHEN unique_violation THEN
        -- Another team verified it first: the claim stays pending, and says only that it is taken.
        RETURN QUERY SELECT 'domain_taken'::text, claim.tenant_ref, claim.domain_ascii;
        RETURN;
      END;
      RETURN QUERY SELECT 'verified'::text, claim.tenant_ref, claim.domain_ascii;
      RETURN;
    END IF;
    UPDATE slotlock.workspace_domains found
       SET error_since = CASE WHEN requested_primary = 'error' THEN coalesce(found.error_since, statement_timestamp()) END
     WHERE found.id = claim.id;
    RETURN QUERY SELECT CASE WHEN requested_primary = 'error' THEN 'error' ELSE 'absent' END, claim.tenant_ref, claim.domain_ascii;
    RETURN;
  END IF;

  IF claim.status = 'verified' THEN
    IF requested_primary = 'present' THEN
      UPDATE slotlock.workspace_domains found
         SET last_seen_at = statement_timestamp(), missing_since = NULL, error_since = NULL
       WHERE found.id = claim.id;
      RETURN QUERY SELECT 'seen'::text, claim.tenant_ref, claim.domain_ascii;
      RETURN;
    END IF;
    IF both_absent THEN
      IF claim.missing_since IS NULL THEN
        UPDATE slotlock.workspace_domains found SET missing_since = statement_timestamp(), error_since = NULL
         WHERE found.id = claim.id;
        RETURN QUERY SELECT 'missing'::text, claim.tenant_ref, claim.domain_ascii;
        RETURN;
      END IF;
      IF claim.missing_since <= statement_timestamp() - interval '1 day' THEN
        IF requested_next_token IS NULL OR requested_next_token !~ '^[a-z2-7]{26}$' OR requested_next_token = claim.token THEN
          RAISE EXCEPTION 'Slotlock domains: a lapsing domain needs a new token' USING ERRCODE = '22023';
        END IF;
        -- Gone a day: lapsing, with a new token. The old one is never accepted again, so a record
        -- copied from DNS history by whoever holds the domain next restores nothing.
        UPDATE slotlock.workspace_domains found
           SET status = 'lapsing', token = requested_next_token, lapse_after = statement_timestamp() + interval '14 days',
               error_since = NULL
         WHERE found.id = claim.id;
        RETURN QUERY SELECT 'lapsing'::text, claim.tenant_ref, claim.domain_ascii;
        RETURN;
      END IF;
      RETURN QUERY SELECT 'missing'::text, claim.tenant_ref, claim.domain_ascii;
      RETURN;
    END IF;
    IF requested_primary = 'error' OR requested_secondary = 'error' THEN
      -- Fourteen days of nothing but errors (a zone deleted, its delegation dangling): lapsing, with
      -- a new token, as if the record had gone, so whoever takes the delegation over cannot revive it.
      IF claim.error_since IS NOT NULL AND claim.error_since <= statement_timestamp() - interval '14 days'
         AND requested_primary <> 'present' AND coalesce(requested_secondary, 'error') <> 'present' THEN
        IF requested_next_token IS NULL OR requested_next_token !~ '^[a-z2-7]{26}$' OR requested_next_token = claim.token THEN
          RAISE EXCEPTION 'Slotlock domains: a lapsing domain needs a new token' USING ERRCODE = '22023';
        END IF;
        UPDATE slotlock.workspace_domains found
           SET status = 'lapsing', token = requested_next_token, lapse_after = statement_timestamp() + interval '14 days'
         WHERE found.id = claim.id;
        RETURN QUERY SELECT 'lapsing'::text, claim.tenant_ref, claim.domain_ascii;
        RETURN;
      END IF;
      UPDATE slotlock.workspace_domains found SET error_since = coalesce(found.error_since, statement_timestamp())
       WHERE found.id = claim.id;
      RETURN QUERY SELECT 'error'::text, claim.tenant_ref, claim.domain_ascii;
      RETURN;
    END IF;
    -- One resolver has it and the other not: nothing changes.
    RETURN QUERY SELECT 'unchanged'::text, claim.tenant_ref, claim.domain_ascii;
    RETURN;
  END IF;

  -- Lapsing: the new token's record restores it; fourteen days without, it has lapsed.
  IF requested_primary = 'present' THEN
    UPDATE slotlock.workspace_domains found
       SET status = 'verified', lapse_after = NULL, missing_since = NULL, error_since = NULL,
           last_seen_at = statement_timestamp()
     WHERE found.id = claim.id;
    RETURN QUERY SELECT 'restored'::text, claim.tenant_ref, claim.domain_ascii;
    RETURN;
  END IF;
  -- Past its fourteen days it lapses only on what lapsed it: both resolvers without the record, or
  -- fourteen days of nothing but errors. One resolver failing, or one still finding it, waits.
  IF requested_primary = 'error' OR requested_secondary = 'error' THEN
    UPDATE slotlock.workspace_domains found SET error_since = coalesce(found.error_since, statement_timestamp())
     WHERE found.id = claim.id;
  ELSE
    UPDATE slotlock.workspace_domains found SET error_since = NULL WHERE found.id = claim.id;
  END IF;
  IF claim.lapse_after <= statement_timestamp()
     AND (both_absent
          OR (requested_primary <> 'present' AND coalesce(requested_secondary, 'error') <> 'present'
              AND claim.error_since IS NOT NULL AND claim.error_since <= statement_timestamp() - interval '14 days')) THEN
    UPDATE slotlock.workspace_domains found
       SET status = 'lapsed', lapse_after = NULL, error_since = NULL, ended_at = statement_timestamp()
     WHERE found.id = claim.id;
    UPDATE slotlock.workspace_join_requests pending SET status = 'expired'
     WHERE pending.domain_id = claim.id AND pending.status = 'pending';
    RETURN QUERY SELECT 'lapsed'::text, claim.tenant_ref, claim.domain_ascii;
    RETURN;
  END IF;
  RETURN QUERY SELECT CASE WHEN requested_primary = 'error' THEN 'error' ELSE 'unchanged' END, claim.tenant_ref, claim.domain_ascii;
END
$slotlock_record_domain_check$;
REVOKE ALL ON FUNCTION ${fn[2]} FROM PUBLIC;

-- The claims to look up now, oldest check first: pending ones hourly for their first three days
-- (after that, only "Verify now"), verified and lapsing ones daily, and lapsing ones past their
-- fourteen days at once. Teams being deleted are left alone.
CREATE OR REPLACE FUNCTION slotlock.domains_due(requested_limit integer)
RETURNS TABLE (domain_id uuid, team_ref text, domain_ascii text, token text, status text, missing_since timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_domains_due$
  SELECT claim.id, claim.tenant_ref, claim.domain_ascii, claim.token, claim.status, claim.missing_since
    FROM slotlock.workspace_domains claim
    JOIN slotlock.workspaces ws ON ws.tenant_ref = claim.tenant_ref AND ws.status = 'active'
   WHERE (claim.status = 'pending' AND claim.created_at > statement_timestamp() - interval '72 hours'
          AND (claim.last_checked_at IS NULL OR claim.last_checked_at <= statement_timestamp() - interval '50 minutes'))
      OR (claim.status IN ('verified', 'lapsing')
          AND (claim.last_checked_at IS NULL OR claim.last_checked_at <= statement_timestamp() - interval '1 day'))
      OR (claim.status = 'lapsing' AND claim.lapse_after <= statement_timestamp())
   ORDER BY claim.last_checked_at NULLS FIRST
   LIMIT greatest(1, least(coalesce(requested_limit, 50), 500));
$slotlock_domains_due$;
REVOKE ALL ON FUNCTION ${fn[3]} FROM PUBLIC;

-- Give up a domain (or withdraw a claim), by the team's Owner. Not the last verified domain while
-- invitations are held to them: the Owner turns that off first.
CREATE OR REPLACE FUNCTION slotlock.release_domain(requested_tenant text, requested_actor text, requested_domain uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_release_domain$
DECLARE
  actor_role text;
  restricted boolean;
  claim slotlock.workspace_domains%ROWTYPE;
BEGIN
  SELECT ws.invites_domain_restricted INTO restricted FROM slotlock.workspaces ws
   WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS DISTINCT FROM 'owner' THEN
    RETURN 'not_allowed';
  END IF;
  SELECT * INTO claim FROM slotlock.workspace_domains found
   WHERE found.id = requested_domain AND found.tenant_ref = requested_tenant
     AND found.status IN ('pending', 'verified', 'lapsing')
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF restricted AND claim.status IN ('verified', 'lapsing') AND NOT EXISTS (
    SELECT 1 FROM slotlock.workspace_domains other
     WHERE other.tenant_ref = requested_tenant AND other.id <> claim.id AND other.status IN ('verified', 'lapsing')
  ) THEN
    RETURN 'restricted';
  END IF;
  UPDATE slotlock.workspace_domains found
     SET status = 'released', lapse_after = NULL, ended_at = statement_timestamp()
   WHERE found.id = claim.id;
  UPDATE slotlock.workspace_join_requests pending SET status = 'expired'
   WHERE pending.domain_id = claim.id AND pending.status = 'pending';
  RETURN NULL;
END
$slotlock_release_domain$;
REVOKE ALL ON FUNCTION ${fn[4]} FROM PUBLIC;

-- Hold invitations to addresses at the team's verified domains, or stop: by its Owner, and only
-- with a verified domain to hold them to. Turning it on withdraws the open invitations it refuses.
CREATE OR REPLACE FUNCTION slotlock.set_invite_domain_restriction(requested_tenant text, requested_actor text, requested_on boolean)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_set_invite_domain_restriction$
DECLARE
  actor_role text;
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
  IF requested_on AND NOT EXISTS (
    SELECT 1 FROM slotlock.workspace_domains claim
     WHERE claim.tenant_ref = requested_tenant AND claim.status = 'verified'
  ) THEN
    RETURN 'no_verified_domain';
  END IF;
  UPDATE slotlock.workspaces ws SET invites_domain_restricted = coalesce(requested_on, false)
   WHERE ws.tenant_ref = requested_tenant;
  -- Held from now on, invitations already open to anyone else are withdrawn too.
  IF requested_on THEN
    UPDATE slotlock.workspace_invitations invitation SET revoked_at = statement_timestamp()
     WHERE invitation.tenant_ref = requested_tenant AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
       AND ${SLOTLOCK_INVITE_DOMAIN_REFUSED('requested_tenant', 'invitation.email', 'invitation.github_ref')};
  END IF;
  RETURN NULL;
END
$slotlock_set_invite_domain_restriction$;
REVOKE ALL ON FUNCTION ${fn[5]} FROM PUBLIC;

-- What a domain lets the people at it do: by the team's Owner. Turning it off withdraws the
-- requests waiting through it.
CREATE OR REPLACE FUNCTION slotlock.set_domain_join_policy(
  requested_tenant text, requested_actor text, requested_domain uuid, requested_policy text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_set_domain_join_policy$
DECLARE
  actor_role text;
BEGIN
  IF requested_policy IS NULL OR requested_policy NOT IN ('off', 'request', 'auto') THEN
    RAISE EXCEPTION 'Slotlock domains: a join policy is off, request or auto' USING ERRCODE = '22023';
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
  UPDATE slotlock.workspace_domains claim SET join_policy = requested_policy
   WHERE claim.id = requested_domain AND claim.tenant_ref = requested_tenant
     AND claim.status IN ('pending', 'verified', 'lapsing');
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF requested_policy = 'off' THEN
    UPDATE slotlock.workspace_join_requests pending SET status = 'expired'
     WHERE pending.domain_id = requested_domain AND pending.status = 'pending';
  END IF;
  RETURN NULL;
END
$slotlock_set_domain_join_policy$;
REVOKE ALL ON FUNCTION ${fn[6]} FROM PUBLIC;

-- The teams a person may ask to join (or join): those with a verified domain, open to joining, that
-- one of their verified addresses is at, exactly. Name and handle only, and whether they asked.
CREATE OR REPLACE FUNCTION slotlock.discoverable_workspaces(requested_person text, requested_emails text[])
RETURNS TABLE (team_ref text, handle text, name text, domain text, domain_key text, join_policy text, requested boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_discoverable_workspaces$
  SELECT ws.tenant_ref, ws.handle, ws.name, claim.domain_unicode, claim.domain_ascii, claim.join_policy,
         EXISTS (SELECT 1 FROM slotlock.workspace_join_requests asked
                  WHERE asked.tenant_ref = ws.tenant_ref AND asked.person_ref = requested_person
                    AND asked.status = 'pending' AND asked.expires_at > statement_timestamp())
    FROM slotlock.workspace_domains claim
    JOIN slotlock.workspaces ws ON ws.tenant_ref = claim.tenant_ref AND ws.status = 'active'
   WHERE requested_person ~ '${PERSON}'
     AND claim.status = 'verified' AND claim.join_policy IN ('request', 'auto')
     AND claim.domain_ascii IN ${EMAIL_DOMAINS('requested_emails')}
     AND NOT EXISTS (SELECT 1 FROM slotlock.workspace_memberships member
                      WHERE member.tenant_ref = ws.tenant_ref AND member.person_ref = requested_person
                        AND member.status = 'active')
   ORDER BY ws.name, ws.handle
   LIMIT 20;
$slotlock_discoverable_workspaces$;
REVOKE ALL ON FUNCTION ${fn[7]} FROM PUBLIC;

-- Ask to join a team by a verified address at one of its domains: joined at once as a Viewer where
-- the domain says so, the address was verified by an account of that domain (a Google Workspace
-- account: evidence google_workspace), the person was never a member and the address was never
-- removed or declined (someone removed asks again, under any account); else a request that waits
-- seven days. Every case the person may not see answers not_found.
CREATE OR REPLACE FUNCTION slotlock.request_to_join(
  requested_tenant text, requested_person text, requested_emails text[], requested_evidence text,
  requested_member_cap integer)
RETURNS TABLE (outcome text, refusal text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_request_to_join$
DECLARE
  matched slotlock.workspace_domains%ROWTYPE;
  matched_email text;
  occupied integer;
BEGIN
  IF requested_person IS NULL OR requested_person !~ '${PERSON}' THEN
    RETURN QUERY SELECT NULL::text, 'not_found'::text;
    RETURN;
  END IF;
  IF requested_evidence IS NULL OR requested_evidence NOT IN ('google_workspace', 'google', 'github') THEN
    RAISE EXCEPTION 'Slotlock teams: evidence is google_workspace, google or github' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, 'not_found'::text;
    RETURN;
  END IF;
  SELECT * INTO matched FROM slotlock.workspace_domains claim
   WHERE claim.tenant_ref = requested_tenant AND claim.status = 'verified' AND claim.join_policy IN ('request', 'auto')
     AND claim.domain_ascii IN ${EMAIL_DOMAINS('requested_emails')}
   ORDER BY claim.join_policy = 'auto' DESC, claim.domain_ascii
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, 'not_found'::text;
    RETURN;
  END IF;
  SELECT lower(btrim(given)) INTO matched_email FROM unnest(requested_emails) given
   WHERE lower(substring(btrim(given) FROM '@([^@]+)$')) = matched.domain_ascii
   LIMIT 1;
  IF EXISTS (SELECT 1 FROM slotlock.workspace_memberships member
              WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_person AND member.status = 'active') THEN
    RETURN QUERY SELECT NULL::text, 'already_member'::text;
    RETURN;
  END IF;
  UPDATE slotlock.workspace_join_requests stale SET status = 'expired'
   WHERE stale.tenant_ref = requested_tenant AND stale.person_ref = requested_person
     AND stale.status = 'pending' AND stale.expires_at <= statement_timestamp();
  IF matched.join_policy = 'auto' AND requested_evidence = 'google_workspace'
     AND NOT EXISTS (SELECT 1 FROM slotlock.workspace_memberships member
                      WHERE member.tenant_ref = requested_tenant
                        AND (member.person_ref = requested_person OR member.joined_email = matched_email))
     AND NOT EXISTS (SELECT 1 FROM slotlock.workspace_join_blocks blocked
                      WHERE blocked.tenant_ref = requested_tenant
                        AND blocked.email_sha256 = sha256(convert_to(matched_email, 'UTF8'))) THEN
    IF requested_member_cap IS NOT NULL THEN
      SELECT (SELECT count(*) FROM slotlock.workspace_memberships member
               WHERE member.tenant_ref = requested_tenant AND member.status = 'active')
           + (SELECT count(*) FROM slotlock.workspace_invitations pending
               WHERE pending.tenant_ref = requested_tenant AND pending.accepted_at IS NULL
                 AND pending.revoked_at IS NULL AND pending.expires_at > statement_timestamp())
        INTO occupied;
      IF occupied >= requested_member_cap THEN
        RETURN QUERY SELECT NULL::text, 'member_cap'::text;
        RETURN;
      END IF;
    END IF;
    INSERT INTO slotlock.workspace_memberships (tenant_ref, person_ref, role, source, joined_via_domain, joined_email)
    VALUES (requested_tenant, requested_person, 'viewer', 'domain', matched.id, matched_email);
    UPDATE slotlock.workspace_join_requests asked SET status = 'expired'
     WHERE asked.tenant_ref = requested_tenant AND asked.person_ref = requested_person AND asked.status = 'pending';
    RETURN QUERY SELECT 'joined'::text, NULL::text;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM slotlock.workspace_join_requests asked
              WHERE asked.tenant_ref = requested_tenant AND asked.person_ref = requested_person AND asked.status = 'pending') THEN
    RETURN QUERY SELECT NULL::text, 'pending'::text;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM slotlock.workspace_join_requests asked
       WHERE asked.person_ref = requested_person AND asked.created_at > statement_timestamp() - interval '1 day')
     >= ${SLOTLOCK_JOIN_REQUEST_DAILY_LIMIT} THEN
    RETURN QUERY SELECT NULL::text, 'request_limit'::text;
    RETURN;
  END IF;
  INSERT INTO slotlock.workspace_join_requests (tenant_ref, domain_id, person_ref, email, evidence, expires_at)
  VALUES (requested_tenant, matched.id, requested_person, matched_email, requested_evidence,
          statement_timestamp() + interval '7 days');
  RETURN QUERY SELECT 'requested'::text, NULL::text;
END
$slotlock_request_to_join$;
REVOKE ALL ON FUNCTION ${fn[8]} FROM PUBLIC;

-- The requests waiting on a team: who asked (as they are shown), by which address, through which domain.
CREATE OR REPLACE FUNCTION slotlock.workspace_join_requests_list(requested_tenant text)
RETURNS TABLE (request_id uuid, person_ref text, display text, email text, domain text,
               created_at timestamptz, expires_at timestamptz, evidence text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_workspace_join_requests_list$
  SELECT asked.id, asked.person_ref, person.display, asked.email, claim.domain_unicode, asked.created_at, asked.expires_at,
         asked.evidence
    FROM slotlock.workspace_join_requests asked
    JOIN slotlock.workspace_domains claim ON claim.id = asked.domain_id
    LEFT JOIN slotlock.dashboard_people person ON person.person_ref = asked.person_ref
   WHERE asked.tenant_ref = requested_tenant AND asked.status = 'pending' AND asked.expires_at > statement_timestamp()
   ORDER BY asked.created_at
   LIMIT 200;
$slotlock_workspace_join_requests_list$;
REVOKE ALL ON FUNCTION ${fn[9]} FROM PUBLIC;

-- Approve a request (as Viewer, Member or Developer, never more) or decline it: by an Owner or an
-- Admin who may give the role, while the domain it came through is still verified.
CREATE OR REPLACE FUNCTION slotlock.decide_join_request(
  requested_tenant text, requested_actor text, requested_request uuid, requested_decision text,
  requested_role text, requested_member_cap integer)
RETURNS TABLE (refusal text, joined_person text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_decide_join_request$
DECLARE
  actor_role text;
  asked slotlock.workspace_join_requests%ROWTYPE;
  occupied integer;
BEGIN
  IF requested_decision IS NULL OR requested_decision NOT IN ('approve', 'decline') THEN
    RAISE EXCEPTION 'Slotlock teams: a decision is approve or decline' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant AND ws.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;
  SELECT member.role INTO actor_role FROM slotlock.workspace_memberships member
   WHERE member.tenant_ref = requested_tenant AND member.person_ref = requested_actor AND member.status = 'active';
  IF actor_role IS NULL OR actor_role NOT IN ('owner', 'admin') THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO asked FROM slotlock.workspace_join_requests found
   WHERE found.id = requested_request AND found.tenant_ref = requested_tenant AND found.status = 'pending'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text;
    RETURN;
  END IF;
  IF asked.expires_at <= statement_timestamp() THEN
    UPDATE slotlock.workspace_join_requests found SET status = 'expired' WHERE found.id = asked.id;
    RETURN QUERY SELECT 'expired'::text, asked.person_ref;
    RETURN;
  END IF;
  IF requested_decision = 'decline' THEN
    UPDATE slotlock.workspace_join_requests found
       SET status = 'declined', decided_by = requested_actor, decided_at = statement_timestamp()
     WHERE found.id = asked.id;
    INSERT INTO slotlock.workspace_join_blocks (tenant_ref, email_sha256)
    VALUES (requested_tenant, sha256(convert_to(asked.email, 'UTF8')))
    ON CONFLICT ON CONSTRAINT slotlock_workspace_join_blocks_pkey DO NOTHING;
    RETURN QUERY SELECT NULL::text, asked.person_ref;
    RETURN;
  END IF;
  IF requested_role IS NULL OR requested_role NOT IN ('viewer', 'member', 'developer') THEN
    RETURN QUERY SELECT 'role_not_allowed'::text, asked.person_ref;
    RETURN;
  END IF;
  IF NOT slotlock.workspace_may_grant(actor_role, requested_role) THEN
    RETURN QUERY SELECT 'not_allowed'::text, asked.person_ref;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM slotlock.workspace_domains claim
                  WHERE claim.id = asked.domain_id AND claim.status = 'verified' AND claim.join_policy <> 'off') THEN
    RETURN QUERY SELECT 'domain_not_verified'::text, asked.person_ref;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM slotlock.workspace_memberships member
              WHERE member.tenant_ref = requested_tenant AND member.person_ref = asked.person_ref AND member.status = 'active') THEN
    UPDATE slotlock.workspace_join_requests found SET status = 'expired' WHERE found.id = asked.id;
    RETURN QUERY SELECT 'already_member'::text, asked.person_ref;
    RETURN;
  END IF;
  IF requested_member_cap IS NOT NULL THEN
    SELECT (SELECT count(*) FROM slotlock.workspace_memberships member
             WHERE member.tenant_ref = requested_tenant AND member.status = 'active')
         + (SELECT count(*) FROM slotlock.workspace_invitations pending
             WHERE pending.tenant_ref = requested_tenant AND pending.accepted_at IS NULL
               AND pending.revoked_at IS NULL AND pending.expires_at > statement_timestamp())
      INTO occupied;
    IF occupied >= requested_member_cap THEN
      RETURN QUERY SELECT 'member_cap'::text, asked.person_ref;
      RETURN;
    END IF;
  END IF;
  INSERT INTO slotlock.workspace_memberships (tenant_ref, person_ref, role, source, joined_via_domain, joined_email)
  VALUES (requested_tenant, asked.person_ref, requested_role, 'domain', asked.domain_id, asked.email)
  ON CONFLICT ON CONSTRAINT slotlock_workspace_memberships_pkey DO UPDATE
     SET role = excluded.role, status = 'active', source = 'domain', joined_via_domain = excluded.joined_via_domain, deactivated_by = NULL,
         joined_email = excluded.joined_email, deactivated_at = NULL, updated_at = statement_timestamp();
  -- Let in by a person who decided: the address is no longer one the team turned away.
  DELETE FROM slotlock.workspace_join_blocks blocked
   WHERE blocked.tenant_ref = requested_tenant AND blocked.email_sha256 = sha256(convert_to(asked.email, 'UTF8'));
  UPDATE slotlock.workspace_join_requests found
     SET status = 'approved', role = requested_role, decided_by = requested_actor, decided_at = statement_timestamp()
   WHERE found.id = asked.id;
  RETURN QUERY SELECT NULL::text, asked.person_ref;
END
$slotlock_decide_join_request$;
REVOKE ALL ON FUNCTION ${fn[10]} FROM PUBLIC;

-- Members a domain let in, with that domain and its standing now: a lapsed domain's people stay,
-- shown as joined through a domain the team no longer holds.
CREATE OR REPLACE FUNCTION slotlock.workspace_domain_members(requested_tenant text)
RETURNS TABLE (person_ref text, domain text, domain_status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_workspace_domain_members$
  SELECT member.person_ref, claim.domain_unicode, claim.status
    FROM slotlock.workspace_memberships member
    JOIN slotlock.workspace_domains claim ON claim.id = member.joined_via_domain
   WHERE member.tenant_ref = requested_tenant AND member.status = 'active' AND member.source = 'domain';
$slotlock_workspace_domain_members$;
REVOKE ALL ON FUNCTION ${fn[11]} FROM PUBLIC;

-- Requests decided or expired 30 days ago, with the address they came by, deleted; claims that ended
-- (lapsed, released, or pending past their seven days) 90 days ago deleted; removals and refusals
-- remembered a year. How many went.
CREATE OR REPLACE FUNCTION slotlock.prune_workspace_domains()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_prune_workspace_domains$
DECLARE
  requests integer;
  claims integer;
  blocks integer;
BEGIN
  DELETE FROM slotlock.workspace_join_requests asked
   WHERE (asked.status <> 'pending' AND coalesce(asked.decided_at, asked.expires_at) < statement_timestamp() - interval '30 days')
      OR (asked.status = 'pending' AND asked.expires_at < statement_timestamp() - interval '30 days');
  GET DIAGNOSTICS requests = ROW_COUNT;
  DELETE FROM slotlock.workspace_domains claim
   WHERE (claim.status IN ('lapsed', 'released') AND claim.ended_at < statement_timestamp() - interval '90 days')
      OR (claim.status = 'pending' AND claim.created_at < statement_timestamp() - interval '97 days');
  GET DIAGNOSTICS claims = ROW_COUNT;
  DELETE FROM slotlock.workspace_join_blocks blocked WHERE blocked.created_at < statement_timestamp() - interval '365 days';
  GET DIAGNOSTICS blocks = ROW_COUNT;
  RETURN requests + claims + blocks;
END
$slotlock_prune_workspace_domains$;
REVOKE ALL ON FUNCTION ${fn[12]} FROM PUBLIC;

-- Whether a team's invitations are held to its verified domains.
CREATE OR REPLACE FUNCTION slotlock.workspace_invites_restricted(requested_tenant text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_workspace_invites_restricted$
  SELECT coalesce((SELECT ws.invites_domain_restricted FROM slotlock.workspaces ws WHERE ws.tenant_ref = requested_tenant), false);
$slotlock_workspace_invites_restricted$;
REVOKE ALL ON FUNCTION ${fn[13]} FROM PUBLIC;
`;
