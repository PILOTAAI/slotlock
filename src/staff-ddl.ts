// The admin console's records (docs/rfc/0006-admin-console.md): the people who run a hosted
// Slotlock (staff), their passkeys, and the staff audit log, plus the functions the console reaches
// every account through.
//
// - Staff tables are owner-only, like the dashboard's: RLS on, no policy, no grants.
// - The console's database role (`slotlock_admin_app`, granted by createSlotlockAdminRoleGrantsDdl)
//   holds no table rights at all: it may only execute SLOTLOCK_ADMIN_FUNCTIONS. Each one is a
//   SECURITY DEFINER function that checks the caller's staff role (slotlock.staff_require) and
//   writes the staff audit log in the same transaction (slotlock.staff_log).
// - No function returns booking content: no titles, descriptions, attendees or contacts, which the
//   audit log and free/busy never hold either. The account's own audit log is returned without IP
//   addresses, user agents or metadata.
// - Staff are added, given a role and removed only by the deployment role, through
//   SLOTLOCK_STAFF_OPERATOR_FUNCTIONS (`slotlock staff …`), so the console cannot raise its own
//   access.
// - The staff audit log is hash-chained, only grows (a trigger refuses UPDATE and DELETE), and has
//   no tenant column, so erasing an account never takes it (RFC 0006, E7).

/** Staff roles, most access first (RFC 0006, Part 2). */
export const SLOTLOCK_STAFF_ROLES = Object.freeze(['owner', 'support', 'billing', 'editor', 'viewer'] as const);
export type SlotlockStaffRole = (typeof SLOTLOCK_STAFF_ROLES)[number];

/**
 * What each role may do in Phase 1 (RFC 0006, 4.3). The database checks the same map
 * (slotlock.staff_require), so the console and the database cannot disagree.
 */
export const SLOTLOCK_STAFF_CAPABILITIES = Object.freeze({
  owner: ['home', 'accounts.read', 'staff.read', 'staff.log'],
  support: ['home', 'accounts.read'],
  billing: ['home', 'accounts.read'],
  editor: ['home'],
  viewer: ['home'],
} as const satisfies Record<SlotlockStaffRole, readonly string[]>);
export type SlotlockStaffCapability = (typeof SLOTLOCK_STAFF_CAPABILITIES)[SlotlockStaffRole][number];

/** Whether a role may use a capability. */
export function slotlockStaffMay(role: SlotlockStaffRole, capability: SlotlockStaffCapability): boolean {
  return (SLOTLOCK_STAFF_CAPABILITIES[role] as readonly string[]).includes(capability);
}

/** A staff member's reference: their GitHub account id, as the dashboard's people are named. */
export const SLOTLOCK_STAFF_REF_PATTERN = '^github:[1-9][0-9]{0,19}$';
/** Who did something in the staff log: a staff member, or a deployment-role command (`cli:<user>`). */
const STAFF_ACTOR_PATTERN = '^(github:[1-9][0-9]{0,19}|cli:[a-z_][a-z0-9_.-]{0,63})$';
/** Days an enrollment code lasts: long enough to receive it, short enough to be worthless later. */
export const SLOTLOCK_STAFF_ENROLLMENT_DAYS = 2;
/** Passkeys one staff member may register. */
export const SLOTLOCK_STAFF_MAX_PASSKEYS = 10;
/** Rows one console call returns at most. */
export const SLOTLOCK_ADMIN_PAGE_LIMIT = 100;

export const SLOTLOCK_STAFF_TABLES = Object.freeze([
  'staff_members',
  'staff_passkeys',
  'staff_audit_events',
] as const);

/** The SECURITY DEFINER functions the console's role executes, and nothing else. */
export const SLOTLOCK_ADMIN_FUNCTIONS = Object.freeze([
  'slotlock.admin_sign_in(text)',
  'slotlock.admin_record(text, text, text, text, text, jsonb)',
  'slotlock.admin_home(text)',
  'slotlock.admin_accounts(text, text, text, text, text, integer)',
  'slotlock.admin_account(text, text)',
  'slotlock.admin_account_keys(text, text)',
  'slotlock.admin_account_usage(text, text, integer)',
  'slotlock.admin_account_audit(text, text, integer)',
  'slotlock.admin_staff(text)',
  'slotlock.admin_staff_log(text, bigint, integer)',
  'slotlock.admin_passkeys(text)',
  'slotlock.admin_passkey_enroll(text, bytea, bytea, bytea, integer, bigint, text)',
  'slotlock.admin_passkey_used(text, bytea, bigint)',
] as const);

/** Functions only the deployment role runs (`slotlock staff …`): granted to no role. */
export const SLOTLOCK_STAFF_OPERATOR_FUNCTIONS = Object.freeze([
  'slotlock.staff_add(text, text, text, bytea, timestamptz)',
  'slotlock.staff_set_role(text, text, text)',
  'slotlock.staff_reset(text, text, bytea, timestamptz)',
  'slotlock.staff_remove(text, text)',
] as const);

/** Internal helpers the functions above call; executable by their owner only. */
const STAFF_HELPER_FUNCTIONS = [
  'slotlock.staff_log(text, text, text, text, text, jsonb)',
  'slotlock.staff_require(text, text)',
  'slotlock.staff_directory()',
] as const;

const roleList = SLOTLOCK_STAFF_ROLES.map((role) => `'${role}'`).join(', ');
const capabilityCase = SLOTLOCK_STAFF_ROLES.map(
  (role) =>
    `      WHEN '${role}' THEN ARRAY[${SLOTLOCK_STAFF_CAPABILITIES[role].map((capability) => `'${capability}'`).join(', ')}]::text[]`,
).join('\n');
const monthStart = `date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date`;
const today = `(statement_timestamp() AT TIME ZONE 'UTC')::date`;

export const SLOTLOCK_STAFF_DDL = `
-- Staff (RFC 0006): who may use the admin console, as which role. Added, changed and removed only
-- by the deployment role (slotlock.staff_add and the others below), never by the console.
CREATE TABLE IF NOT EXISTS slotlock.staff_members (
  staff_ref text PRIMARY KEY,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  removed_at timestamptz,
  last_seen_at timestamptz,
  -- A one-time code, hashed, that lets a member with no passkey register their first one.
  enrollment_hash bytea,
  enrollment_expires_at timestamptz,
  CONSTRAINT slotlock_staff_members_valid CHECK (
    staff_ref ~ '${SLOTLOCK_STAFF_REF_PATTERN}'
    AND role IN (${roleList})
    AND status IN ('active', 'removed')
    AND (status = 'active') = (removed_at IS NULL)
    AND added_by ~ '${STAFF_ACTOR_PATTERN}'
    AND (enrollment_hash IS NULL) = (enrollment_expires_at IS NULL)
    AND (enrollment_hash IS NULL OR octet_length(enrollment_hash) = 32)
  )
);
ALTER TABLE slotlock.staff_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.staff_members FROM PUBLIC;

-- Each member's passkeys (WebAuthn), the console's second factor: the public key and its counter.
CREATE TABLE IF NOT EXISTS slotlock.staff_passkeys (
  credential_id bytea PRIMARY KEY,
  staff_ref text NOT NULL REFERENCES slotlock.staff_members (staff_ref) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  algorithm integer NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_used_at timestamptz,
  CONSTRAINT slotlock_staff_passkeys_valid CHECK (
    octet_length(credential_id) BETWEEN 16 AND 1023
    AND octet_length(public_key) BETWEEN 32 AND 2048
    AND algorithm IN (-7, -257)
    AND sign_count >= 0
    AND char_length(name) BETWEEN 1 AND 60 AND name !~ '[[:cntrl:]]'
  )
);
CREATE INDEX IF NOT EXISTS slotlock_staff_passkeys_staff_idx ON slotlock.staff_passkeys (staff_ref);
ALTER TABLE slotlock.staff_passkeys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.staff_passkeys FROM PUBLIC;

-- The staff audit log: every sign-in, every view of an account and every staff action, chained by
-- SHA-256 so a change shows. account_ref is not a tenant column on purpose: erasing an account
-- keeps the record of what staff did (RFC 0006, E7). Kept two years.
CREATE TABLE IF NOT EXISTS slotlock.staff_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  staff_ref text NOT NULL,
  action text NOT NULL,
  account_ref text,
  target text,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  chain_index bigint NOT NULL,
  prev_hash bytea,
  hash bytea NOT NULL,
  CONSTRAINT slotlock_staff_audit_events_chain_key UNIQUE (chain_index),
  CONSTRAINT slotlock_staff_audit_events_valid CHECK (
    staff_ref ~ '${STAFF_ACTOR_PATTERN}'
    AND action ~ '^[a-z][a-z_]{0,31}(\\.[a-z][a-z_]{0,31}){1,2}$'
    AND (account_ref IS NULL OR (octet_length(account_ref) BETWEEN 1 AND 500 AND account_ref !~ '[[:cntrl:]]'))
    AND (target IS NULL OR (char_length(target) BETWEEN 1 AND 200 AND target !~ '[[:cntrl:]]'))
    AND (reason IS NULL OR (char_length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'))
    AND jsonb_typeof(metadata) = 'object'
    AND octet_length(metadata::text) <= 4096
    AND chain_index > 0
    AND octet_length(hash) = 32
  )
);
CREATE INDEX IF NOT EXISTS slotlock_staff_audit_events_account_idx
  ON slotlock.staff_audit_events (account_ref, id) WHERE account_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS slotlock_staff_audit_events_staff_idx
  ON slotlock.staff_audit_events (staff_ref, id);
ALTER TABLE slotlock.staff_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.staff_audit_events FROM PUBLIC;

-- A staff event as its hash covers it: every field, in a fixed order, separated by the unit
-- separator, as slotlock.audit_event_text does for a workspace's log.
CREATE OR REPLACE FUNCTION slotlock.staff_audit_event_text(event slotlock.staff_audit_events)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_audit_event_text$
  SELECT concat_ws(chr(31), event.chain_index::text, event.id::text,
                   (extract(epoch FROM event.occurred_at) * 1000000)::bigint::text, event.staff_ref,
                   event.action, coalesce(event.account_ref, ''), coalesce(event.target, ''),
                   coalesce(event.reason, ''), event.metadata::text);
$slotlock_staff_audit_event_text$;

-- Before each insert: one writer at a time, numbered after the last event and hashed with it, at
-- the database's time.
CREATE OR REPLACE FUNCTION slotlock.chain_staff_audit_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_chain_staff_audit_event$
DECLARE
  last_index bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:staff-audit-chain', 0));
  SELECT kept.chain_index, kept.hash INTO last_index, last_hash FROM slotlock.staff_audit_events kept
   ORDER BY kept.chain_index DESC LIMIT 1;
  NEW.occurred_at := statement_timestamp();
  NEW.chain_index := coalesce(last_index, 0) + 1;
  NEW.prev_hash := last_hash;
  NEW.hash := sha256(coalesce(last_hash, ''::bytea) || convert_to(slotlock.staff_audit_event_text(NEW), 'UTF8'));
  RETURN NEW;
END
$slotlock_chain_staff_audit_event$;
DROP TRIGGER IF EXISTS slotlock_staff_audit_events_chain ON slotlock.staff_audit_events;
CREATE TRIGGER slotlock_staff_audit_events_chain BEFORE INSERT ON slotlock.staff_audit_events
  FOR EACH ROW EXECUTE FUNCTION slotlock.chain_staff_audit_event();

-- The log only grows: no row is changed or removed, by any role.
CREATE OR REPLACE FUNCTION slotlock.refuse_staff_audit_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_refuse_staff_audit_change$
BEGIN
  RAISE EXCEPTION 'the staff audit log only grows' USING ERRCODE = '42501';
END
$slotlock_refuse_staff_audit_change$;
DROP TRIGGER IF EXISTS slotlock_staff_audit_events_frozen ON slotlock.staff_audit_events;
CREATE TRIGGER slotlock_staff_audit_events_frozen BEFORE UPDATE OR DELETE ON slotlock.staff_audit_events
  FOR EACH ROW EXECUTE FUNCTION slotlock.refuse_staff_audit_change();

-- Add one event to the staff log. Called inside the functions below, in their transaction, so an
-- action and its record commit together or not at all.
CREATE OR REPLACE FUNCTION slotlock.staff_log(actor text, happened text, account text, detail text, why text, extra jsonb)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_log$
  INSERT INTO slotlock.staff_audit_events (staff_ref, action, account_ref, target, reason, metadata)
  VALUES (actor, happened, account, detail, why, coalesce(extra, '{}'::jsonb));
$slotlock_staff_log$;

-- The caller's role when it may use the capability; otherwise an error (42501), so nothing after
-- the check runs. The same map as SLOTLOCK_STAFF_CAPABILITIES in staff-ddl.ts.
CREATE OR REPLACE FUNCTION slotlock.staff_require(actor text, capability text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_require$
DECLARE
  found_role text;
BEGIN
  SELECT member.role INTO found_role FROM slotlock.staff_members member
   WHERE member.staff_ref = actor AND member.status = 'active';
  IF found_role IS NULL OR NOT (capability = ANY (CASE found_role
${capabilityCase}
    END)) THEN
    RAISE EXCEPTION 'staff_forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN found_role;
END
$slotlock_staff_require$;

-- Every account: a person (github:, google:), an organization (github-org:), a team workspace
-- (team:), a partner's account (partner:), and any other tenant holding data or a plan. Test
-- environments (~test) are listed too; the console hides them unless asked. Names only where the
-- database keeps one: a person's login is never stored (PRIVACY.md).
CREATE OR REPLACE FUNCTION slotlock.staff_directory()
RETURNS TABLE (account_ref text, kind text, name text, created_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_directory$
  WITH refs AS (
    SELECT known.tenant_ref AS ref FROM slotlock.maintenance_tenants known
    UNION SELECT person.person_ref FROM slotlock.dashboard_people person
    UNION SELECT team.tenant_ref FROM slotlock.workspaces team
    UNION SELECT 'github-org:' || org.org_id FROM slotlock.dashboard_organizations org WHERE org.enabled
    UNION SELECT planned.tenant_ref FROM slotlock.tenant_plans planned
    UNION SELECT account.tenant_ref FROM slotlock.partner_accounts account
  )
  SELECT refs.ref,
         CASE
           WHEN refs.ref ~ '~test$' THEN 'test'
           WHEN refs.ref LIKE 'github:%' OR refs.ref LIKE 'google:%' THEN 'person'
           WHEN refs.ref LIKE 'github-org:%' THEN 'organization'
           WHEN refs.ref LIKE 'team:%' THEN 'team'
           WHEN refs.ref LIKE 'partner:%' THEN 'partner'
           ELSE 'other'
         END,
         coalesce(team.name, org.login, partner.account),
         coalesce(person.created_at, team.created_at, partner.created_at)
    FROM refs
    LEFT JOIN slotlock.dashboard_people person ON person.person_ref = refs.ref
    LEFT JOIN slotlock.workspaces team ON team.tenant_ref = refs.ref
    LEFT JOIN slotlock.dashboard_organizations org ON 'github-org:' || org.org_id = refs.ref
    LEFT JOIN slotlock.partner_accounts partner ON partner.tenant_ref = refs.ref;
$slotlock_staff_directory$;

-- Signing in to the console: the member's role, or NULL for anyone who is not active staff. Both
-- are recorded.
CREATE OR REPLACE FUNCTION slotlock.admin_sign_in(actor text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_sign_in$
DECLARE
  found_role text;
BEGIN
  IF actor IS NULL OR actor !~ '${SLOTLOCK_STAFF_REF_PATTERN}' THEN
    RETURN NULL;
  END IF;
  UPDATE slotlock.staff_members member SET last_seen_at = statement_timestamp()
   WHERE member.staff_ref = actor AND member.status = 'active'
  RETURNING member.role INTO found_role;
  PERFORM slotlock.staff_log(actor,
    CASE WHEN found_role IS NULL THEN 'staff.sign_in_refused' ELSE 'staff.signed_in' END,
    NULL, NULL, NULL, '{}'::jsonb);
  RETURN found_role;
END
$slotlock_admin_sign_in$;

-- What the console itself records: a sign-out, a passkey refused, a page refused, a lookup. Only
-- staff, and only staff., page. and search. events: an account action is recorded by its function.
CREATE OR REPLACE FUNCTION slotlock.admin_record(actor text, happened text, account text, detail text, why text, extra jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_record$
BEGIN
  PERFORM slotlock.staff_require(actor, 'home');
  IF happened IS NULL OR happened !~ '^(staff|page|search)\\.' THEN
    RAISE EXCEPTION 'admin_record_action' USING ERRCODE = '22023';
  END IF;
  PERFORM slotlock.staff_log(actor, happened, account, detail, why, extra);
END
$slotlock_admin_record$;

-- The home page's numbers: accounts by kind, paying and suspended, activity, this month's and last
-- month's operations and bookings, and sign-ups by day for 30 days. Test environments excluded.
CREATE OR REPLACE FUNCTION slotlock.admin_home(actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_home$
DECLARE
  month_start date := ${monthStart};
  last_month_start date := (${monthStart} - interval '1 month')::date;
  result jsonb;
BEGIN
  PERFORM slotlock.staff_require(actor, 'home');
  WITH accounts AS (
    SELECT listed.kind FROM slotlock.staff_directory() listed WHERE listed.kind <> 'test'
  ), usage AS (
    SELECT used.day, used.metric, used.count, used.tenant_ref FROM slotlock.usage_daily used
     WHERE used.day >= last_month_start AND used.tenant_ref !~ '~test$'
  ), signups AS (
    SELECT joined::date AS day, count(*) AS added FROM (
      SELECT person.created_at AS joined FROM slotlock.dashboard_people person
      UNION ALL SELECT team.created_at FROM slotlock.workspaces team
      UNION ALL SELECT partner.created_at FROM slotlock.partner_accounts partner
    ) joins
     WHERE joined >= statement_timestamp() - interval '30 days'
     GROUP BY 1
  )
  SELECT jsonb_build_object(
    'accounts', (SELECT count(*) FROM accounts),
    'people', (SELECT count(*) FROM accounts WHERE kind = 'person'),
    'teams', (SELECT count(*) FROM accounts WHERE kind = 'team'),
    'organizations', (SELECT count(*) FROM accounts WHERE kind = 'organization'),
    'partner_accounts', (SELECT count(*) FROM accounts WHERE kind = 'partner'),
    'paying', (SELECT count(*) FROM slotlock.tenant_plans planned
                WHERE planned.plan <> 'free' AND planned.status = 'active' AND planned.tenant_ref !~ '~test$'),
    'past_due', (SELECT count(*) FROM slotlock.tenant_plans planned
                  WHERE planned.status = 'past_due' AND planned.tenant_ref !~ '~test$'),
    'suspended', (SELECT count(*) FROM slotlock.tenant_suspensions held WHERE held.tenant_ref !~ '~test$'),
    'active_7_days', (SELECT count(DISTINCT tenant_ref) FROM usage WHERE day > ${today} - 7),
    'operations_month', (SELECT coalesce(sum(count), 0) FROM usage WHERE day >= month_start AND metric = 'operations'),
    'bookings_month', (SELECT coalesce(sum(count), 0) FROM usage WHERE day >= month_start AND metric = 'bookings'),
    'operations_last_month', (SELECT coalesce(sum(count), 0) FROM usage WHERE day < month_start AND metric = 'operations'),
    'bookings_last_month', (SELECT coalesce(sum(count), 0) FROM usage WHERE day < month_start AND metric = 'bookings'),
    'signups', (SELECT coalesce(jsonb_agg(jsonb_build_object('day', day, 'count', added) ORDER BY day), '[]'::jsonb) FROM signups),
    'staff', (SELECT count(*) FROM slotlock.staff_members member WHERE member.status = 'active')
  ) INTO result;
  PERFORM slotlock.staff_log(actor, 'home.viewed', NULL, NULL, NULL, '{}'::jsonb);
  RETURN result;
END
$slotlock_admin_home$;

-- The account directory, a page at a time, by account reference. A query finds an account by its
-- reference (or the start of one), a GitHub account id, an API key (only its prefix is read or
-- recorded, never the rest), a Stripe customer, or the name of a team, organization or partner
-- account. Without a query, test environments are left out.
CREATE OR REPLACE FUNCTION slotlock.admin_accounts(actor text, query text, plan_filter text, status_filter text, after text, page_size integer)
RETURNS TABLE (account_ref text, kind text, name text, created_at timestamptz, last_active date,
               plan text, plan_status text, suspended boolean, stripe_customer text,
               operations_month bigint, bookings_month bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_accounts$
#variable_conflict use_column
DECLARE
  wanted text := nullif(btrim(coalesce(query, '')), '');
  key_prefix text;
  month_start date := ${monthStart};
  shown integer := least(greatest(coalesce(page_size, 50), 1), ${SLOTLOCK_ADMIN_PAGE_LIMIT});
BEGIN
  PERFORM slotlock.staff_require(actor, 'accounts.read');
  IF char_length(coalesce(wanted, '')) > 200 OR wanted ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'admin_query_invalid' USING ERRCODE = '22023';
  END IF;
  IF wanted ~ '^slk_test_[0-9A-Za-z]{8}' THEN
    key_prefix := left(wanted, 17);
  ELSIF wanted ~ '^slk_[0-9A-Za-z]{8}' THEN
    key_prefix := left(wanted, 12);
  END IF;
  PERFORM slotlock.staff_log(actor, 'accounts.searched', NULL, NULL, NULL, jsonb_strip_nulls(jsonb_build_object(
    'query', coalesce(key_prefix, wanted), 'plan', plan_filter, 'status', status_filter, 'after', after)));
  RETURN QUERY
  WITH found AS (
    SELECT listed.account_ref, listed.kind, listed.name, listed.created_at
      FROM slotlock.staff_directory() listed
     WHERE (after IS NULL OR listed.account_ref > after)
       AND CASE
             WHEN wanted IS NULL THEN listed.kind <> 'test'
             WHEN key_prefix IS NOT NULL THEN listed.account_ref IN (
               SELECT minted.tenant_ref FROM slotlock.api_keys minted WHERE minted.prefix = key_prefix)
             WHEN wanted ~ '^cus_' THEN listed.account_ref IN (
               SELECT planned.tenant_ref FROM slotlock.tenant_plans planned WHERE planned.stripe_customer = wanted)
             WHEN wanted ~ '^[1-9][0-9]{0,19}$' THEN listed.account_ref IN ('github:' || wanted, 'github-org:' || wanted)
             ELSE listed.account_ref = wanted
               OR left(listed.account_ref, char_length(wanted)) = wanted
               OR strpos(lower(coalesce(listed.name, '')), lower(wanted)) > 0
           END
  )
  SELECT found.account_ref, found.kind, found.name, found.created_at,
         (SELECT max(used.day) FROM slotlock.usage_daily used WHERE used.tenant_ref = found.account_ref),
         coalesce(planned.plan, partner.plan, 'free'),
         planned.status,
         held.tenant_ref IS NOT NULL,
         planned.stripe_customer,
         coalesce((SELECT sum(used.count) FROM slotlock.usage_daily used
                    WHERE used.tenant_ref = found.account_ref AND used.day >= month_start
                      AND used.metric = 'operations'), 0)::bigint,
         coalesce((SELECT sum(used.count) FROM slotlock.usage_daily used
                    WHERE used.tenant_ref = found.account_ref AND used.day >= month_start
                      AND used.metric = 'bookings'), 0)::bigint
    FROM found
    LEFT JOIN slotlock.tenant_plans planned ON planned.tenant_ref = found.account_ref
    LEFT JOIN slotlock.partner_accounts partner ON partner.tenant_ref = found.account_ref
    LEFT JOIN slotlock.tenant_suspensions held ON held.tenant_ref = found.account_ref
   WHERE (plan_filter IS NULL OR coalesce(planned.plan, partner.plan, 'free') = plan_filter)
     AND (status_filter IS NULL
          OR (status_filter = 'suspended' AND held.tenant_ref IS NOT NULL)
          OR (status_filter = 'active' AND held.tenant_ref IS NULL))
   ORDER BY found.account_ref
   LIMIT shown;
END
$slotlock_admin_accounts$;

-- One account: who it is, its plan and suspension, its counts and this month's use. Resources and
-- webhooks are read under the account's own row security, then the setting is put back. NULL when
-- no account has that reference.
CREATE OR REPLACE FUNCTION slotlock.admin_account(actor text, requested text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_account$
DECLARE
  previous text := current_setting('slotlock.tenant_ref', true);
  month_start date := ${monthStart};
  result jsonb;
BEGIN
  PERFORM slotlock.staff_require(actor, 'accounts.read');
  IF requested IS NULL OR octet_length(requested) NOT BETWEEN 1 AND 500 OR requested ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'admin_account_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object(
    'account_ref', listed.account_ref, 'kind', listed.kind, 'name', listed.name,
    'created_at', listed.created_at,
    'plan', coalesce(planned.plan, partner.plan, 'free'), 'plan_status', planned.status,
    'stripe_customer', planned.stripe_customer, 'stripe_subscription', planned.stripe_subscription,
    'current_period_end', planned.current_period_end,
    'limits', CASE WHEN planned.tenant_ref IS NULL THEN NULL ELSE jsonb_build_object(
      'resources', planned.max_resources, 'api_keys', planned.max_api_keys,
      'webhook_endpoints', planned.max_webhook_endpoints) END,
    'partner', partner.partner_id,
    'suspended', held.tenant_ref IS NOT NULL, 'suspended_at', held.suspended_at,
    'suspension_reason', held.reason,
    'team_status', team.status,
    'last_active', (SELECT max(used.day) FROM slotlock.usage_daily used WHERE used.tenant_ref = listed.account_ref),
    'members', (SELECT count(*) FROM slotlock.workspace_memberships member
                 WHERE member.tenant_ref = listed.account_ref AND member.status = 'active'),
    'api_keys_active', (SELECT count(*) FROM slotlock.api_keys minted
                         WHERE minted.tenant_ref = listed.account_ref AND minted.revoked_at IS NULL
                           AND (minted.expires_at IS NULL OR minted.expires_at > statement_timestamp())),
    'usage_month', (SELECT coalesce(jsonb_object_agg(month.metric, month.total), '{}'::jsonb) FROM (
      SELECT used.metric, sum(used.count) AS total FROM slotlock.usage_daily used
       WHERE used.tenant_ref = listed.account_ref AND used.day >= month_start GROUP BY used.metric) month)
  ) INTO result
    FROM slotlock.staff_directory() listed
    LEFT JOIN slotlock.tenant_plans planned ON planned.tenant_ref = listed.account_ref
    LEFT JOIN slotlock.partner_accounts partner ON partner.tenant_ref = listed.account_ref
    LEFT JOIN slotlock.tenant_suspensions held ON held.tenant_ref = listed.account_ref
    LEFT JOIN slotlock.workspaces team ON team.tenant_ref = listed.account_ref
   WHERE listed.account_ref = requested;
  IF result IS NULL THEN
    PERFORM slotlock.staff_log(actor, 'account.not_found', requested, NULL, NULL, '{}'::jsonb);
    RETURN NULL;
  END IF;
  PERFORM set_config('slotlock.tenant_ref', requested, true);
  result := result || jsonb_build_object(
    'resources', (SELECT count(*) FROM slotlock.resources held WHERE held.tenant_ref = requested),
    'webhook_endpoints', (SELECT count(*) FROM slotlock.webhook_endpoints hook
                           WHERE hook.tenant_ref = requested AND hook.disabled_at IS NULL));
  PERFORM set_config('slotlock.tenant_ref', coalesce(previous, ''), true);
  PERFORM slotlock.staff_log(actor, 'account.viewed', requested, NULL, NULL, '{}'::jsonb);
  RETURN result;
END
$slotlock_admin_account$;

-- An account's API keys as metadata: name, prefix, scopes and dates. Only the prefix of a key is
-- ever stored besides its hash, so no secret can be shown.
CREATE OR REPLACE FUNCTION slotlock.admin_account_keys(actor text, account text)
RETURNS TABLE (id uuid, name text, prefix text, scopes text[], created_at timestamptz,
               expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_account_keys$
BEGIN
  PERFORM slotlock.staff_require(actor, 'accounts.read');
  PERFORM slotlock.staff_log(actor, 'account.keys_viewed', account, NULL, NULL, '{}'::jsonb);
  RETURN QUERY
  SELECT minted.id, minted.name, minted.prefix, minted.scopes, minted.created_at, minted.expires_at,
         minted.last_used_at, minted.revoked_at
    FROM slotlock.api_keys minted
   WHERE minted.tenant_ref = account
   ORDER BY minted.created_at DESC
   LIMIT ${SLOTLOCK_ADMIN_PAGE_LIMIT};
END
$slotlock_admin_account_keys$;

-- An account's use by day and metric over its last days (at most 400, what usage_daily keeps).
CREATE OR REPLACE FUNCTION slotlock.admin_account_usage(actor text, account text, days integer)
RETURNS TABLE (day date, metric text, count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_account_usage$
#variable_conflict use_column
DECLARE
  span integer := least(greatest(coalesce(days, 90), 1), 400);
BEGIN
  PERFORM slotlock.staff_require(actor, 'accounts.read');
  PERFORM slotlock.staff_log(actor, 'account.usage_viewed', account, NULL, NULL,
    jsonb_build_object('days', span));
  RETURN QUERY
  SELECT used.day, used.metric, sum(used.count)::bigint
    FROM slotlock.usage_daily used
   WHERE used.tenant_ref = account AND used.day > ${today} - span
   GROUP BY used.day, used.metric
   ORDER BY used.day, used.metric;
END
$slotlock_admin_account_usage$;

-- An account's own audit log, newest first, under its row security: what happened, who (an id,
-- never a name), and the outcome. No IP address, user agent or metadata.
CREATE OR REPLACE FUNCTION slotlock.admin_account_audit(actor text, account text, page_size integer)
RETURNS TABLE (occurred_at timestamptz, action text, actor_type text, actor_ref text,
               target_type text, target_ref text, outcome text, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_account_audit$
#variable_conflict use_column
DECLARE
  previous text := current_setting('slotlock.tenant_ref', true);
  shown integer := least(greatest(coalesce(page_size, 50), 1), ${SLOTLOCK_ADMIN_PAGE_LIMIT});
BEGIN
  PERFORM slotlock.staff_require(actor, 'accounts.read');
  PERFORM slotlock.staff_log(actor, 'account.audit_viewed', account, NULL, NULL, '{}'::jsonb);
  PERFORM set_config('slotlock.tenant_ref', account, true);
  RETURN QUERY
  SELECT event.occurred_at, event.action, event.actor_type, event.actor_ref, event.target_type,
         event.target_ref, event.outcome, event.reason
    FROM slotlock.audit_events event
   WHERE event.tenant_ref = account
   ORDER BY event.occurred_at DESC, event.id
   LIMIT shown;
  PERFORM set_config('slotlock.tenant_ref', coalesce(previous, ''), true);
END
$slotlock_admin_account_audit$;

-- The staff list, with how many passkeys each member has. Owner only.
CREATE OR REPLACE FUNCTION slotlock.admin_staff(actor text)
RETURNS TABLE (staff_ref text, role text, status text, added_by text, added_at timestamptz,
               last_seen_at timestamptz, passkeys integer, enrolling boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_staff$
#variable_conflict use_column
BEGIN
  PERFORM slotlock.staff_require(actor, 'staff.read');
  PERFORM slotlock.staff_log(actor, 'staff.list_viewed', NULL, NULL, NULL, '{}'::jsonb);
  RETURN QUERY
  SELECT member.staff_ref, member.role, member.status, member.added_by, member.added_at,
         member.last_seen_at,
         (SELECT count(*)::integer FROM slotlock.staff_passkeys key WHERE key.staff_ref = member.staff_ref),
         member.enrollment_expires_at IS NOT NULL AND member.enrollment_expires_at > statement_timestamp()
    FROM slotlock.staff_members member
   ORDER BY member.status, member.added_at;
END
$slotlock_admin_staff$;

-- The staff log, newest first, a page at a time (before: a chain index). Owner only.
CREATE OR REPLACE FUNCTION slotlock.admin_staff_log(actor text, before bigint, page_size integer)
RETURNS TABLE (chain_index bigint, occurred_at timestamptz, staff_ref text, action text,
               account_ref text, target text, reason text, metadata jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_staff_log$
#variable_conflict use_column
DECLARE
  shown integer := least(greatest(coalesce(page_size, 50), 1), ${SLOTLOCK_ADMIN_PAGE_LIMIT});
BEGIN
  PERFORM slotlock.staff_require(actor, 'staff.log');
  RETURN QUERY
  SELECT event.chain_index, event.occurred_at, event.staff_ref, event.action, event.account_ref,
         event.target, event.reason, event.metadata
    FROM slotlock.staff_audit_events event
   WHERE before IS NULL OR event.chain_index < before
   ORDER BY event.chain_index DESC
   LIMIT shown;
END
$slotlock_admin_staff_log$;

-- The caller's own passkeys, to check a sign-in against. Any active member.
CREATE OR REPLACE FUNCTION slotlock.admin_passkeys(actor text)
RETURNS TABLE (credential_id bytea, public_key bytea, algorithm integer, sign_count bigint,
               name text, created_at timestamptz, last_used_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_passkeys$
#variable_conflict use_column
BEGIN
  PERFORM slotlock.staff_require(actor, 'home');
  RETURN QUERY
  SELECT key.credential_id, key.public_key, key.algorithm, key.sign_count, key.name, key.created_at,
         key.last_used_at
    FROM slotlock.staff_passkeys key
   WHERE key.staff_ref = actor
   ORDER BY key.created_at;
END
$slotlock_admin_passkeys$;

-- Register a passkey the console has verified. A member's first passkey needs the one-time code
-- the deployment role issued (slotlock staff add or reset), which this uses up; a later one needs
-- no code, and the console asks for a passkey sign-in first. False when the code is wrong or
-- spent, or the member already has the most passkeys allowed.
CREATE OR REPLACE FUNCTION slotlock.admin_passkey_enroll(actor text, code_hash bytea, credential bytea, key bytea, alg integer, counter bigint, label text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_passkey_enroll$
DECLARE
  held integer;
  member slotlock.staff_members;
BEGIN
  PERFORM slotlock.staff_require(actor, 'home');
  SELECT * INTO member FROM slotlock.staff_members found WHERE found.staff_ref = actor FOR UPDATE;
  SELECT count(*) INTO held FROM slotlock.staff_passkeys owned WHERE owned.staff_ref = actor;
  IF held >= ${SLOTLOCK_STAFF_MAX_PASSKEYS} THEN
    PERFORM slotlock.staff_log(actor, 'staff.passkey_refused', NULL, NULL, 'too many passkeys', '{}'::jsonb);
    RETURN false;
  END IF;
  IF held = 0 THEN
    IF code_hash IS NULL OR member.enrollment_hash IS NULL OR member.enrollment_hash <> code_hash
       OR member.enrollment_expires_at <= statement_timestamp() THEN
      PERFORM slotlock.staff_log(actor, 'staff.passkey_refused', NULL, NULL, 'enrollment code', '{}'::jsonb);
      RETURN false;
    END IF;
  ELSIF code_hash IS NOT NULL THEN
    PERFORM slotlock.staff_log(actor, 'staff.passkey_refused', NULL, NULL, 'already enrolled', '{}'::jsonb);
    RETURN false;
  END IF;
  INSERT INTO slotlock.staff_passkeys (credential_id, staff_ref, public_key, algorithm, sign_count, name)
  VALUES (credential, actor, key, alg, greatest(coalesce(counter, 0), 0), label);
  UPDATE slotlock.staff_members found SET enrollment_hash = NULL, enrollment_expires_at = NULL
   WHERE found.staff_ref = actor;
  PERFORM slotlock.staff_log(actor, 'staff.passkey_added', NULL, label, NULL,
    jsonb_build_object('algorithm', alg));
  RETURN true;
END
$slotlock_admin_passkey_enroll$;

-- A passkey sign-in the console verified: move its counter on. False (and recorded) when the
-- counter did not move forward, which a cloned authenticator shows; true otherwise. Counters
-- that stay at zero are passkeys that keep none.
CREATE OR REPLACE FUNCTION slotlock.admin_passkey_used(actor text, credential bytea, counter bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_passkey_used$
DECLARE
  stored bigint;
BEGIN
  PERFORM slotlock.staff_require(actor, 'home');
  SELECT key.sign_count INTO stored FROM slotlock.staff_passkeys key
   WHERE key.credential_id = credential AND key.staff_ref = actor FOR UPDATE;
  IF stored IS NULL THEN
    PERFORM slotlock.staff_log(actor, 'staff.passkey_refused', NULL, NULL, 'unknown passkey', '{}'::jsonb);
    RETURN false;
  END IF;
  IF (stored > 0 OR coalesce(counter, 0) > 0) AND coalesce(counter, 0) <= stored THEN
    PERFORM slotlock.staff_log(actor, 'staff.passkey_refused', NULL, NULL, 'counter did not advance',
      jsonb_build_object('stored', stored, 'given', counter));
    RETURN false;
  END IF;
  UPDATE slotlock.staff_passkeys key SET sign_count = greatest(coalesce(counter, 0), 0),
         last_used_at = statement_timestamp()
   WHERE key.credential_id = credential;
  PERFORM slotlock.staff_log(actor, 'staff.passkey_verified', NULL, NULL, NULL, '{}'::jsonb);
  RETURN true;
END
$slotlock_admin_passkey_used$;

-- Add a member, or bring back a removed one, with a role and a one-time code for their first
-- passkey. Deployment role only (slotlock staff add).
CREATE OR REPLACE FUNCTION slotlock.staff_add(member_ref text, member_role text, actor text, code_hash bytea, code_expires timestamptz)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_add$
DECLARE
  existed boolean;
BEGIN
  SELECT true INTO existed FROM slotlock.staff_members member WHERE member.staff_ref = member_ref;
  INSERT INTO slotlock.staff_members AS member (staff_ref, role, status, added_by, enrollment_hash, enrollment_expires_at)
  VALUES (member_ref, member_role, 'active', actor, code_hash, code_expires)
  ON CONFLICT (staff_ref) DO UPDATE
    SET role = EXCLUDED.role, status = 'active', removed_at = NULL, added_by = EXCLUDED.added_by,
        added_at = statement_timestamp(), enrollment_hash = EXCLUDED.enrollment_hash,
        enrollment_expires_at = EXCLUDED.enrollment_expires_at;
  PERFORM slotlock.staff_log(actor, CASE WHEN existed THEN 'staff.readded' ELSE 'staff.added' END,
    NULL, member_ref, NULL, jsonb_build_object('role', member_role));
END
$slotlock_staff_add$;

-- Change a member's role. Deployment role only (slotlock staff role).
CREATE OR REPLACE FUNCTION slotlock.staff_set_role(member_ref text, member_role text, actor text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_set_role$
DECLARE
  previous_role text;
BEGIN
  SELECT member.role INTO previous_role FROM slotlock.staff_members member
   WHERE member.staff_ref = member_ref AND member.status = 'active' FOR UPDATE;
  IF previous_role IS NULL THEN
    RAISE EXCEPTION 'staff_not_found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE slotlock.staff_members member SET role = member_role WHERE member.staff_ref = member_ref;
  PERFORM slotlock.staff_log(actor, 'staff.role_changed', NULL, member_ref, NULL,
    jsonb_build_object('from', previous_role, 'to', member_role));
END
$slotlock_staff_set_role$;

-- A member who lost their passkeys: remove them all and issue a new one-time code. Deployment role
-- only (slotlock staff reset).
CREATE OR REPLACE FUNCTION slotlock.staff_reset(member_ref text, actor text, code_hash bytea, code_expires timestamptz)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_reset$
BEGIN
  UPDATE slotlock.staff_members member SET enrollment_hash = code_hash, enrollment_expires_at = code_expires
   WHERE member.staff_ref = member_ref AND member.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staff_not_found' USING ERRCODE = 'P0002';
  END IF;
  DELETE FROM slotlock.staff_passkeys key WHERE key.staff_ref = member_ref;
  PERFORM slotlock.staff_log(actor, 'staff.passkeys_reset', NULL, member_ref, NULL, '{}'::jsonb);
END
$slotlock_staff_reset$;

-- Remove a member: they can no longer sign in, and their passkeys go. The last active owner stays.
-- Deployment role only (slotlock staff remove).
CREATE OR REPLACE FUNCTION slotlock.staff_remove(member_ref text, actor text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_remove$
DECLARE
  removed_role text;
BEGIN
  SELECT member.role INTO removed_role FROM slotlock.staff_members member
   WHERE member.staff_ref = member_ref AND member.status = 'active' FOR UPDATE;
  IF removed_role IS NULL THEN
    RAISE EXCEPTION 'staff_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF removed_role = 'owner' AND NOT EXISTS (
    SELECT 1 FROM slotlock.staff_members other
     WHERE other.role = 'owner' AND other.status = 'active' AND other.staff_ref <> member_ref
  ) THEN
    RAISE EXCEPTION 'staff_last_owner' USING ERRCODE = '23514';
  END IF;
  UPDATE slotlock.staff_members member
     SET status = 'removed', removed_at = statement_timestamp(), enrollment_hash = NULL,
         enrollment_expires_at = NULL
   WHERE member.staff_ref = member_ref;
  DELETE FROM slotlock.staff_passkeys key WHERE key.staff_ref = member_ref;
  PERFORM slotlock.staff_log(actor, 'staff.removed', NULL, member_ref, NULL,
    jsonb_build_object('role', removed_role));
END
$slotlock_staff_remove$;

${[...STAFF_HELPER_FUNCTIONS, ...SLOTLOCK_ADMIN_FUNCTIONS, ...SLOTLOCK_STAFF_OPERATOR_FUNCTIONS]
  .map((signature) => `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`)
  .join('\n')}
`;

/** PostgreSQL role names this module will grant to, as createSlotlockApplicationRoleGrantsDdl takes. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const RESERVED = new Set(['public', 'current_role', 'current_user', 'session_user']);

/**
 * The console's grants: USAGE on the schema and EXECUTE on SLOTLOCK_ADMIN_FUNCTIONS. No table,
 * no other function: every read and write goes through a function that checks the staff member
 * and records the call. Rerun after every applySchema(), since a release may add a function.
 */
export function createSlotlockAdminRoleGrantsDdl(role: string): string {
  if (!ROLE_NAME.test(role) || RESERVED.has(role) || role.startsWith('pg_')) {
    throw Object.assign(
      new Error('Slotlock admin role must be a lowercase, non-reserved PostgreSQL role name'),
      { code: 'invalid_role_name' as const },
    );
  }
  return `GRANT USAGE ON SCHEMA slotlock TO "${role}";
GRANT EXECUTE ON FUNCTION ${SLOTLOCK_ADMIN_FUNCTIONS.join(', ')} TO "${role}";
`;
}
