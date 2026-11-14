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
 * What each role may do (RFC 0006, 4.3):
 * - `accounts.act` ends sessions, revokes keys and writes notes;
 * - `safety.act` suspends, lifts suspensions and works abuse cases;
 * - `billing.read` opens revenue, payments, partners and job runs;
 * - `billing.act` gives a plan override of up to 90 days and resolves billing alerts;
 * - `plans.approve` asks for an override longer than 90 days, and approves another Owner's (four
 *   eyes);
 * - `content.write` writes blog posts in the CMS and submits them for review;
 * - `content.publish` publishes or schedules a submitted post (E5: Owner only);
 * - `privacy.act` logs a privacy request, verifies who sent it, starts an export and closes it;
 * - `privacy.erase` asks for, approves (four eyes) and carries out an account's erasure;
 * - `site.read` opens the site's search and visit numbers (M9);
 * - `system.read` opens the System page: maintenance, failing webhooks, feature flags and
 *   announcements (M11);
 * - `system.act` writes announcements and service notices, turns features on or off and opens or
 *   updates incidents on the status page (M10, M11: Owner only).
 * The database checks the same map (slotlock.staff_require), so the console and the database cannot
 * disagree.
 */
export const SLOTLOCK_STAFF_CAPABILITIES = Object.freeze({
  owner: [
    'home', 'accounts.read', 'accounts.act', 'safety.act', 'billing.read', 'billing.act', 'plans.approve',
    'content.write', 'content.publish', 'privacy.act', 'privacy.erase', 'staff.read', 'staff.log',
    'site.read', 'system.read', 'system.act',
  ],
  support: ['home', 'accounts.read', 'accounts.act', 'safety.act', 'privacy.act', 'system.read'],
  billing: ['home', 'accounts.read', 'billing.read', 'billing.act'],
  editor: ['home', 'content.write', 'site.read'],
  viewer: ['home', 'billing.read', 'site.read'],
} as const satisfies Record<SlotlockStaffRole, readonly string[]>);
export type SlotlockStaffCapability = (typeof SLOTLOCK_STAFF_CAPABILITIES)[SlotlockStaffRole][number];

/** Whether a role may use a capability. */
export function slotlockStaffMay(role: SlotlockStaffRole, capability: SlotlockStaffCapability): boolean {
  return (SLOTLOCK_STAFF_CAPABILITIES[role] as readonly string[]).includes(capability);
}

/** A staff member's reference: their GitHub account id, as the dashboard's people are named. */
export const SLOTLOCK_STAFF_REF_PATTERN = '^github:[1-9][0-9]{0,19}$';
/** A GitHub login, as GitHub allows one: the staff member's, kept at each sign-in. */
export const SLOTLOCK_STAFF_LOGIN_PATTERN = '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$';
/**
 * Staff log actions that only read: a page or a list opened, a search. Every one is recorded (RFC
 * 0006, 4.4), and the Staff log page hides them unless asked, so what staff did stands out.
 */
export const SLOTLOCK_STAFF_VIEW_ACTION_PATTERN = '^([a-z_]+\\.([a-z_]+_)?(viewed|listed|searched)|search\\.[a-z_]+)$';
/** Who did something in the staff log: a staff member, or a deployment-role command (`cli:<user>`). */
const STAFF_ACTOR_PATTERN = '^(github:[1-9][0-9]{0,19}|cli:[a-z_][a-z0-9_.-]{0,63})$';
/** Days an enrollment code lasts: long enough to receive it, short enough to be worthless later. */
export const SLOTLOCK_STAFF_ENROLLMENT_DAYS = 2;
/** Minutes a staff session may sit unused before it ends. */
export const SLOTLOCK_STAFF_IDLE_MINUTES = 30;
/** Hours a staff session lasts from its first passkey sign-in. */
export const SLOTLOCK_STAFF_SESSION_HOURS = 8;
/** Minutes after a passkey sign-in in which an action, or a new passkey, needs no new one. */
export const SLOTLOCK_STAFF_FRESH_MINUTES = 15;
/** Events of the staff log the Staff log page checks the chain of, newest first. */
export const SLOTLOCK_STAFF_CHAIN_CHECKED = 10_000;
/** Passkeys one staff member may register. */
export const SLOTLOCK_STAFF_MAX_PASSKEYS = 10;
/** Rows one console call returns at most. */
export const SLOTLOCK_ADMIN_PAGE_LIMIT = 100;
/** Where an abuse case came from: a report (abuse@) or staff who saw something. */
export const SLOTLOCK_CASE_SOURCES = Object.freeze(['report', 'staff'] as const);
/** What was done about a case. */
export const SLOTLOCK_CASE_ACTIONS = Object.freeze(['none', 'warned', 'keys_revoked', 'suspended', 'other'] as const);
/** Longest internal note on an account, in characters. */
export const SLOTLOCK_STAFF_NOTE_MAX = 2000;
/** The longest plan override one person may give; a longer one needs a second Owner. */
export const SLOTLOCK_OVERRIDE_SOLO_DAYS = 90;
/**
 * Jobs whose runs the console shows: `slotlock billing daily` and `slotlock overage report`, and an
 * hour of each server's maintenance passes (`maintenance`).
 */
export const SLOTLOCK_MAINTENANCE_JOBS = Object.freeze(['billing_daily', 'overage_report', 'maintenance'] as const);
/** How long a cached provider read (Stripe) is kept, in seconds (RFC 0006, 4.6). */
export const SLOTLOCK_ADMIN_CACHE_SECONDS = 3600;
/** What a privacy request asks for (RFC 0006, M7). */
export const SLOTLOCK_PRIVACY_KINDS = Object.freeze(['access', 'export', 'correction', 'erasure', 'other'] as const);
/**
 * Whom it concerns: the account holder, whose data Slotlock controls, or one of the account's own
 * customers, whose controller is the account holder (the request is passed on to them).
 */
export const SLOTLOCK_PRIVACY_CONCERNS = Object.freeze(['account', 'customer'] as const);
/** How a privacy request ends. */
export const SLOTLOCK_PRIVACY_OUTCOMES = Object.freeze(['done', 'refused', 'withdrawn', 'passed_on'] as const);
/** Days an export made for a privacy request is kept once ready (an account's own: a day). */
export const SLOTLOCK_PRIVACY_EXPORT_DAYS = 7;
/**
 * Years the staff log, closed abuse cases and closed privacy requests with their erasure receipts
 * are kept, then deleted: the UK's limitation period for most claims.
 */
export const SLOTLOCK_STAFF_RECORD_YEARS = 6;
/** A blog post's slug, as site/src/lib/post-format.ts reads it (POST_SLUG). */
export const SLOTLOCK_POST_SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+){0,15}$';
/**
 * The CMS's steps, as the staff log names them (RFC 0006, 4.5). Writing needs content.write;
 * publishing, scheduling and unscheduling need content.publish.
 */
export const SLOTLOCK_CONTENT_STEPS = Object.freeze({
  write: ['content.saved', 'content.submitted', 'content.image_added', 'content.image_removed', 'content.renamed', 'content.discarded'],
  publish: ['content.published', 'content.scheduled', 'content.unscheduled', 'content.updated'],
} as const);
export type SlotlockContentStep = (typeof SLOTLOCK_CONTENT_STEPS)[keyof typeof SLOTLOCK_CONTENT_STEPS][number];
/** What an announcement is about, as the dashboard's banner names it (RFC 0006, M10). */
export const SLOTLOCK_ANNOUNCEMENT_KINDS = Object.freeze(['maintenance', 'change', 'incident', 'notice'] as const);
export type SlotlockAnnouncementKind = (typeof SLOTLOCK_ANNOUNCEMENT_KINDS)[number];
/** Who sees one: every account, the accounts on a plan, or one account (a service notice). */
export const SLOTLOCK_ANNOUNCEMENT_AUDIENCES = Object.freeze(['everyone', 'plan', 'account'] as const);
export type SlotlockAnnouncementAudience = (typeof SLOTLOCK_ANNOUNCEMENT_AUDIENCES)[number];
/** The longest announcement, in characters: one line of a banner. */
export const SLOTLOCK_ANNOUNCEMENT_MAX = 300;
/** The longest an announcement runs, in days. */
export const SLOTLOCK_ANNOUNCEMENT_MAX_DAYS = 90;
/** Announcements a dashboard shows at once, newest first. */
export const SLOTLOCK_ANNOUNCEMENTS_SHOWN = 3;
/** Plans an announcement or a feature flag can name. */
export const SLOTLOCK_STAFF_PLANS = Object.freeze(['free', 'developer', 'team'] as const);
/**
 * Features staff turn on or off for a plan or one account (RFC 0006, M11), where the deployment has
 * them configured: `assistant` (the dashboard's chat assistant, by the workspace in use) and
 * `team_workspaces` (creating a team workspace, by the person's own account). An account's setting
 * outranks its plan's; with neither, the deployment's configuration decides.
 */
export const SLOTLOCK_FEATURE_FLAGS = Object.freeze(['assistant', 'team_workspaces'] as const);
export type SlotlockFeatureFlag = (typeof SLOTLOCK_FEATURE_FLAGS)[number];
/** Days an account's maintenance failure is kept once it stops recurring. */
export const SLOTLOCK_MAINTENANCE_FAILURE_DAYS = 30;
/** Accounts with webhooks the System page counts failing endpoints across, at most. */
export const SLOTLOCK_WEBHOOK_HEALTH_ACCOUNTS = 5000;
/** Steps of an incident on the status page, as the staff log names them (RFC 0006, M10). */
export const SLOTLOCK_STATUS_STEPS = Object.freeze(['status.opened', 'status.updated', 'status.closed'] as const);
export type SlotlockStatusStep = (typeof SLOTLOCK_STATUS_STEPS)[number];

export const SLOTLOCK_STAFF_TABLES = Object.freeze([
  'staff_members',
  'staff_passkeys',
  'staff_audit_events',
  'account_notes',
  'abuse_cases',
  'maintenance_runs',
  'admin_cache',
  'privacy_requests',
  'privacy_erasure_receipts',
  'privacy_keys',
  'staff_console_keys',
  'staff_sessions',
  'announcements',
  'feature_flags',
  'maintenance_failures',
] as const);

/** The SECURITY DEFINER functions the console's role executes, and nothing else. */
export const SLOTLOCK_ADMIN_FUNCTIONS = Object.freeze([
  'slotlock.admin_sign_in(text, text)',
  'slotlock.admin_sign_out(text)',
  'slotlock.admin_session(text)',
  'slotlock.admin_passkey_challenge(text, text, bytea)',
  'slotlock.admin_record(text, text, text, text, text, jsonb)',
  'slotlock.admin_home(text)',
  'slotlock.admin_accounts(text, text, text, text, text, integer)',
  'slotlock.admin_account(text, text)',
  'slotlock.admin_account_keys(text, text)',
  'slotlock.admin_account_usage(text, text, integer)',
  'slotlock.admin_account_audit(text, text, integer)',
  'slotlock.admin_staff(text)',
  'slotlock.admin_staff_log(text, bigint, integer, text, text, text, timestamptz, timestamptz, boolean)',
  'slotlock.admin_staff_log_chain(text)',
  'slotlock.admin_passkeys(text)',
  'slotlock.admin_passkey_enroll(text, bytea, bytea, bytea, integer, bigint, text, bytea)',
  'slotlock.admin_passkey_used(text, bytea, bigint, bytea)',
  'slotlock.admin_suspend(text, text, text, text, bigint)',
  'slotlock.admin_unsuspend(text, text, text)',
  'slotlock.admin_revoke_key(text, text, uuid, text)',
  'slotlock.admin_account_sessions(text, text)',
  'slotlock.admin_end_sessions(text, text, text, text)',
  'slotlock.admin_account_notes(text, text)',
  'slotlock.admin_add_note(text, text, text)',
  'slotlock.admin_case_open(text, text, text, text, text, text)',
  'slotlock.admin_case_update(text, bigint, text, text, text)',
  'slotlock.admin_cases(text, text, text, bigint, integer)',
  'slotlock.admin_case(text, bigint)',
  'slotlock.admin_override_create(text, text, text, integer, integer, integer, bigint, bigint, integer, timestamptz, text)',
  'slotlock.admin_override_approve(text, bigint)',
  'slotlock.admin_override_end(text, bigint, text)',
  'slotlock.admin_account_overrides(text, text)',
  'slotlock.admin_overrides(text)',
  'slotlock.admin_billing(text)',
  'slotlock.admin_billing_alerts(text, boolean, bigint, integer)',
  'slotlock.admin_billing_alert_resolve(text, bigint, text)',
  'slotlock.admin_usage(text, integer)',
  'slotlock.admin_usage_accounts(text)',
  'slotlock.admin_partners(text)',
  'slotlock.admin_cache_read(text, text)',
  'slotlock.admin_cache_write(text, text, jsonb)',
  'slotlock.admin_content_record(text, text, text, jsonb)',
  'slotlock.admin_privacy_open(text, text, text, text, date, text)',
  'slotlock.admin_privacy_requests(text, boolean, bigint, integer)',
  'slotlock.admin_privacy_request(text, bigint)',
  'slotlock.admin_privacy_verify(text, bigint)',
  'slotlock.admin_privacy_export(text, bigint)',
  'slotlock.admin_privacy_erasure_ask(text, bigint)',
  'slotlock.admin_privacy_erasure_approve(text, bigint)',
  'slotlock.admin_privacy_erase(text, bigint)',
  'slotlock.admin_privacy_close(text, bigint, text, text)',
  'slotlock.admin_privacy_receipts(text, text)',
  'slotlock.admin_announcements(text, boolean)',
  'slotlock.admin_announce(text, text, text, text, text, text, text, timestamptz, timestamptz)',
  'slotlock.admin_announcement_end(text, bigint)',
  'slotlock.admin_flags(text)',
  'slotlock.admin_flag_set(text, text, text, text, boolean, text)',
  'slotlock.admin_flag_clear(text, bigint, text)',
  'slotlock.admin_system(text)',
  'slotlock.admin_status_record(text, text, integer, jsonb)',
  // Staff by their GitHub logins, kept at sign-in, so the console names who did what without
  // asking GitHub.
  'slotlock.admin_staff_login(text, text)',
  'slotlock.admin_staff_logins(text, text[])',
] as const);

/**
 * What the serving role runs for Phase 6 (RFC 0006, M10 and M11): a dashboard's announcements and
 * feature flags, and maintenance's record of its passes. Granted with the other tenant functions
 * (ddl.ts SLOTLOCK_TENANT_ADMIN_FUNCTIONS).
 */
export const SLOTLOCK_STAFF_SERVING_FUNCTIONS = Object.freeze([
  'slotlock.tenant_dashboard_notices(text)',
  'slotlock.note_maintenance_failure(text, text, text, text)',
  'slotlock.note_maintenance_recovered(text)',
  'slotlock.note_maintenance_round(timestamptz, boolean, jsonb)',
] as const);

/** Functions only the deployment role runs (`slotlock staff …`): granted to no role. */
export const SLOTLOCK_STAFF_OPERATOR_FUNCTIONS = Object.freeze([
  'slotlock.staff_add(text, text, text, bytea, timestamptz)',
  'slotlock.staff_set_role(text, text, text)',
  'slotlock.staff_reset(text, text, bytea, timestamptz)',
  'slotlock.staff_remove(text, text)',
  'slotlock.staff_operator_record(text, text, text, text)',
  'slotlock.staff_console_key(bytea, text)',
  'slotlock.record_maintenance_run(text, text, timestamptz, boolean, jsonb)',
] as const);

/** Internal helpers the functions above call; executable by their owner only. */
const STAFF_HELPER_FUNCTIONS = [
  'slotlock.staff_log(text, text, text, text, text, jsonb)',
  'slotlock.staff_require(text, text)',
  'slotlock.staff_session(text, text, boolean)',
  'slotlock.staff_sessions_end(text)',
  'slotlock.staff_challenge_spend(bytea, text, bytea)',
  'slotlock.staff_session_raise(bytea)',
  'slotlock.staff_directory()',
  'slotlock.staff_subscribed_plans()',
  'slotlock.staff_account_known(text)',
  'slotlock.staff_reason_valid(text)',
  'slotlock.staff_customer_audit(text, text, text, text, text, text)',
  'slotlock.staff_cache_capability(text)',
  'slotlock.staff_records_prune()',
  'slotlock.staff_audit_chain_check(integer)',
  'slotlock.privacy_digest(text)',
] as const;

/**
 * Drops a function whose result columns this release changes while the schema still has the shape
 * from before (no `column` among them): CREATE OR REPLACE cannot change what a function returns.
 * The console's grants come back with `slotlock migrate`, which reruns them after the schema.
 */
const reshaped = (signature: string, column: string) => `DO $slotlock_reshape$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc fn
     WHERE fn.oid = pg_catalog.to_regprocedure('${signature}')
       AND NOT ('${column}' = ANY (coalesce(fn.proargnames, ARRAY[]::text[])))
  ) THEN
    DROP FUNCTION ${signature};
  END IF;
END
$slotlock_reshape$;`;

const roleList = SLOTLOCK_STAFF_ROLES.map((role) => `'${role}'`).join(', ');
const capabilityCase = SLOTLOCK_STAFF_ROLES.map(
  (role) =>
    `      WHEN '${role}' THEN ARRAY[${SLOTLOCK_STAFF_CAPABILITIES[role].map((capability) => `'${capability}'`).join(', ')}]::text[]`,
).join('\n');
const caseSources = SLOTLOCK_CASE_SOURCES.map((value) => `'${value}'`).join(', ');
const caseActions = SLOTLOCK_CASE_ACTIONS.map((value) => `'${value}'`).join(', ');
/** Text that may span lines: no control characters but newlines and tabs. */
const multiline = (column: string) => `translate(${column}, E'\\n\\r\\t', '') !~ '[[:cntrl:]]'`;
const monthStart = `date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC')::date`;
const today = `(statement_timestamp() AT TIME ZONE 'UTC')::date`;

/**
 * Phase 2 (RFC 0006): what support may do to an account. Every action is written twice, in the same
 * transaction: in the staff log, and in the account's own audit log as "Slotlock staff (<role>)"
 * with the reason, so the customer sees what staff did (E8).
 */
const STAFF_SUPPORT_DDL = `
-- Internal notes on an account, by staff and for staff: never shown to the customer.
CREATE TABLE IF NOT EXISTS slotlock.account_notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_ref text NOT NULL,
  staff_ref text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_account_notes_valid CHECK (
    octet_length(account_ref) BETWEEN 1 AND 500
    AND staff_ref ~ '${STAFF_ACTOR_PATTERN}'
    AND char_length(body) BETWEEN 1 AND ${SLOTLOCK_STAFF_NOTE_MAX}
    AND ${multiline('body')}
  )
);
CREATE INDEX IF NOT EXISTS slotlock_account_notes_account_idx ON slotlock.account_notes (account_ref, id DESC);
ALTER TABLE slotlock.account_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.account_notes FROM PUBLIC;

-- Trust and safety cases (M6): a report or something staff saw, the Acceptable Use Policy section,
-- the evidence, what was done and how it ended. An account may be named later.
CREATE TABLE IF NOT EXISTS slotlock.abuse_cases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_ref text,
  source text NOT NULL,
  summary text NOT NULL,
  policy_section text,
  evidence text,
  action_taken text NOT NULL DEFAULT 'none',
  outcome text,
  status text NOT NULL DEFAULT 'open',
  opened_by text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  closed_by text,
  closed_at timestamptz,
  CONSTRAINT slotlock_abuse_cases_valid CHECK (
    (account_ref IS NULL OR octet_length(account_ref) BETWEEN 1 AND 500)
    AND source IN (${caseSources})
    AND char_length(summary) BETWEEN 1 AND 200 AND summary !~ '[[:cntrl:]]'
    AND (policy_section IS NULL OR (char_length(policy_section) BETWEEN 1 AND 100
                                    AND policy_section !~ '[[:cntrl:]]'))
    AND (evidence IS NULL OR (char_length(evidence) BETWEEN 1 AND 4000 AND ${multiline('evidence')}))
    AND action_taken IN (${caseActions})
    AND (outcome IS NULL OR (char_length(outcome) BETWEEN 1 AND 1000 AND ${multiline('outcome')}))
    AND status IN ('open', 'closed')
    AND opened_by ~ '${STAFF_ACTOR_PATTERN}'
    AND (closed_by IS NULL OR closed_by ~ '${STAFF_ACTOR_PATTERN}')
    AND (status = 'closed') = (closed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS slotlock_abuse_cases_status_idx ON slotlock.abuse_cases (status, id DESC);
CREATE INDEX IF NOT EXISTS slotlock_abuse_cases_account_idx ON slotlock.abuse_cases (account_ref, id DESC);
ALTER TABLE slotlock.abuse_cases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.abuse_cases FROM PUBLIC;

-- A case's history is the staff log's events about it (target case:<id>).
CREATE INDEX IF NOT EXISTS slotlock_staff_audit_events_target_idx
  ON slotlock.staff_audit_events (target, chain_index) WHERE target IS NOT NULL;

-- An account staff act on must exist: an error (22023) for a reference no account has.
CREATE OR REPLACE FUNCTION slotlock.staff_account_known(account text)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_account_known$
BEGIN
  IF account IS NULL OR NOT EXISTS (SELECT 1 FROM slotlock.staff_directory() listed WHERE listed.account_ref = account) THEN
    RAISE EXCEPTION 'admin_account_unknown' USING ERRCODE = '22023';
  END IF;
END
$slotlock_staff_account_known$;

-- Every staff action carries a reason the customer may read: 1-200 bytes, one line.
CREATE OR REPLACE FUNCTION slotlock.staff_reason_valid(why text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_reason_valid$
BEGIN
  IF why IS NULL OR octet_length(why) NOT BETWEEN 1 AND 200 OR why ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'admin_reason_invalid' USING ERRCODE = '22023';
  END IF;
END
$slotlock_staff_reason_valid$;

-- What staff did, in the account's own audit log (E8): by "Slotlock staff" and the role
-- (slotlock-staff:<role>, or slotlock-staff:operator for a deployment-role command), with the
-- reason (cut to fit the log's 200 bytes). Written under the account's row security, then the
-- setting is put back.
CREATE OR REPLACE FUNCTION slotlock.staff_customer_audit(actor text, account text, happened text, kind text, target text, why text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_customer_audit$
DECLARE
  previous text := current_setting('slotlock.tenant_ref', true);
  label text;
BEGIN
  IF actor LIKE 'cli:%' THEN
    label := 'operator';
  ELSE
    SELECT member.role INTO label FROM slotlock.staff_members member WHERE member.staff_ref = actor;
  END IF;
  PERFORM set_config('slotlock.tenant_ref', account, true);
  INSERT INTO slotlock.audit_events (tenant_ref, action, actor_type, actor_ref, target_type, target_ref, reason)
  VALUES (account, happened, 'system', 'slotlock-staff:' || coalesce(label, 'staff'), kind, target,
          CASE WHEN why IS NULL OR why = '' THEN NULL
               WHEN octet_length(why) <= 200 THEN why
               ELSE left(why, 49) || '…' END);
  PERFORM set_config('slotlock.tenant_ref', coalesce(previous, ''), true);
END
$slotlock_staff_customer_audit$;

-- Suspend an account (safety.act): from the next request it changes nothing, and its keys are
-- refused, as slotlock tenant suspend does. The reason goes to the staff log and the account's audit
-- log; the message, if any, is shown on every page of its dashboard. Linked to a case, the case
-- records the suspension. A suspension its partner made is taken over, as suspend_tenant takes it,
-- so the partner cannot lift staff's. False when it was suspended already otherwise.
CREATE OR REPLACE FUNCTION slotlock.admin_suspend(actor text, account text, why text, message text, case_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_suspend$
DECLARE
  previous text;
BEGIN
  actor := slotlock.staff_session(actor, 'safety.act', false);
  PERFORM slotlock.staff_account_known(account);
  PERFORM slotlock.staff_reason_valid(why);
  IF message IS NOT NULL AND (char_length(message) NOT BETWEEN 1 AND 500 OR message ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'admin_message_invalid' USING ERRCODE = '22023';
  END IF;
  -- Only an open case, about this account or about none yet, records the suspension.
  IF case_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM slotlock.abuse_cases opened
     WHERE opened.id = case_id AND opened.status = 'open'
       AND (opened.account_ref IS NULL OR opened.account_ref = account)
  ) THEN
    RAISE EXCEPTION 'admin_case_unknown' USING ERRCODE = '22023';
  END IF;
  -- As suspend_tenant: the tenant's lock and its key lock, so writes in flight finish first.
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:tenant:' || account, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:api-keys:' || account, 0));
  -- A partner's suspension is taken over, and the staff log says so; any other stays as it is.
  SELECT held.source INTO previous FROM slotlock.tenant_suspensions held
   WHERE held.tenant_ref = account FOR UPDATE;
  INSERT INTO slotlock.tenant_suspensions AS held (tenant_ref, reason, customer_message, suspended_by, source)
  VALUES (account, why, message, actor, 'staff')
  ON CONFLICT (tenant_ref) DO UPDATE
     SET reason = EXCLUDED.reason, customer_message = EXCLUDED.customer_message,
         suspended_by = EXCLUDED.suspended_by, source = EXCLUDED.source, suspended_at = EXCLUDED.suspended_at
   WHERE held.source = 'partner';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM slotlock.staff_log(actor, 'account.suspended', account,
    CASE WHEN case_id IS NULL THEN NULL ELSE 'case:' || case_id END, why,
    jsonb_build_object('message', message IS NOT NULL)
      || CASE WHEN previous = 'partner' THEN jsonb_build_object('took_over', 'partner') ELSE '{}'::jsonb END);
  PERFORM slotlock.staff_customer_audit(actor, account, 'staff.account_suspended', NULL, NULL, why);
  IF case_id IS NOT NULL THEN
    UPDATE slotlock.abuse_cases opened
       SET action_taken = 'suspended', account_ref = coalesce(opened.account_ref, account),
           updated_at = statement_timestamp()
     WHERE opened.id = case_id;
  END IF;
  RETURN true;
END
$slotlock_admin_suspend$;

-- Lift an account's suspension, whoever made it (safety.act). False when it was not suspended.
CREATE OR REPLACE FUNCTION slotlock.admin_unsuspend(actor text, account text, why text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_unsuspend$
BEGIN
  actor := slotlock.staff_session(actor, 'safety.act', false);
  PERFORM slotlock.staff_reason_valid(why);
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:tenant:' || account, 0));
  DELETE FROM slotlock.tenant_suspensions held WHERE held.tenant_ref = account;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM slotlock.staff_log(actor, 'account.unsuspended', account, NULL, why, '{}'::jsonb);
  PERFORM slotlock.staff_customer_audit(actor, account, 'staff.account_unsuspended', NULL, NULL, why);
  RETURN true;
END
$slotlock_admin_unsuspend$;

-- Revoke one of an account's API keys (accounts.act): refused from its next request, as when its
-- owner revokes it. False when the account has no such key, or it was revoked already.
CREATE OR REPLACE FUNCTION slotlock.admin_revoke_key(actor text, account text, key_id uuid, why text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_revoke_key$
BEGIN
  actor := slotlock.staff_session(actor, 'accounts.act', false);
  PERFORM slotlock.staff_reason_valid(why);
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:api-keys:' || account, 0));
  UPDATE slotlock.api_keys minted SET revoked_at = now()
   WHERE minted.tenant_ref = account AND minted.id = key_id AND minted.revoked_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM slotlock.staff_log(actor, 'account.key_revoked', account, 'api_key:' || key_id, why, '{}'::jsonb);
  PERFORM slotlock.staff_customer_audit(actor, account, 'staff.key_revoked', 'api_key', key_id::text, why);
  RETURN true;
END
$slotlock_admin_revoke_key$;

-- A person's dashboard sessions still going, most recently seen first: each named by the first 8
-- bytes of its digest, with when it began and was last seen. Not where from, nor which browser.
CREATE OR REPLACE FUNCTION slotlock.admin_account_sessions(actor text, account text)
RETURNS TABLE (handle text, started_at timestamptz, last_seen_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_account_sessions$
#variable_conflict use_column
BEGIN
  actor := slotlock.staff_session(actor, 'accounts.read', false);
  PERFORM slotlock.staff_log(actor, 'account.sessions_viewed', account, NULL, NULL, '{}'::jsonb);
  RETURN QUERY
  SELECT encode(substr(kept.sid_sha256, 1, 8), 'hex'), kept.started_at, kept.last_seen_at, kept.expires_at
    FROM slotlock.dashboard_sessions kept
   WHERE kept.person_ref = account AND kept.ended_at IS NULL AND kept.expires_at > statement_timestamp()
   ORDER BY kept.last_seen_at DESC
   LIMIT 50;
END
$slotlock_admin_account_sessions$;

-- Sign a person out (accounts.act): one session by its handle, or every one with NULL, which also
-- draws a new session epoch, as Sign out everywhere does. How many recorded sessions ended.
CREATE OR REPLACE FUNCTION slotlock.admin_end_sessions(actor text, account text, handle text, why text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_end_sessions$
DECLARE
  ended integer;
BEGIN
  actor := slotlock.staff_session(actor, 'accounts.act', false);
  PERFORM slotlock.staff_reason_valid(why);
  -- A person: by GitHub, by Google, or one a team's identity provider made (sso:).
  IF account IS NULL OR account !~ '^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255}|sso:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' THEN
    RAISE EXCEPTION 'admin_not_a_person' USING ERRCODE = '22023';
  END IF;
  IF handle IS NOT NULL AND handle !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'admin_session_invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM slotlock.staff_account_known(account);
  UPDATE slotlock.dashboard_sessions ending SET ended_at = statement_timestamp()
   WHERE ending.person_ref = account AND ending.ended_at IS NULL
     AND (handle IS NULL OR encode(substr(ending.sid_sha256, 1, 8), 'hex') = handle);
  GET DIAGNOSTICS ended = ROW_COUNT;
  IF handle IS NULL THEN
    PERFORM slotlock.dashboard_sign_out_everywhere(account);
  ELSIF ended = 0 THEN
    RETURN 0;
  END IF;
  PERFORM slotlock.staff_log(actor, 'account.sessions_ended', account, coalesce('session:' || handle, 'sessions:all'),
    why, jsonb_build_object('ended', ended));
  PERFORM slotlock.staff_customer_audit(actor, account, 'staff.sessions_ended', 'session', coalesce(handle, 'all'), why);
  RETURN ended;
END
$slotlock_admin_end_sessions$;

-- An account's internal notes, newest first.
CREATE OR REPLACE FUNCTION slotlock.admin_account_notes(actor text, account text)
RETURNS TABLE (id bigint, staff_ref text, body text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_account_notes$
#variable_conflict use_column
BEGIN
  actor := slotlock.staff_session(actor, 'accounts.read', false);
  PERFORM slotlock.staff_log(actor, 'account.notes_viewed', account, NULL, NULL, '{}'::jsonb);
  RETURN QUERY
  SELECT kept.id, kept.staff_ref, kept.body, kept.created_at FROM slotlock.account_notes kept
   WHERE kept.account_ref = account
   ORDER BY kept.id DESC
   LIMIT ${SLOTLOCK_ADMIN_PAGE_LIMIT};
END
$slotlock_admin_account_notes$;

-- Add an internal note to an account (accounts.act). The log records that a note was added, not
-- what it says. The note's id.
CREATE OR REPLACE FUNCTION slotlock.admin_add_note(actor text, account text, note_text text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_add_note$
DECLARE
  added bigint;
BEGIN
  actor := slotlock.staff_session(actor, 'accounts.act', false);
  PERFORM slotlock.staff_account_known(account);
  IF note_text IS NULL OR char_length(note_text) NOT BETWEEN 1 AND ${SLOTLOCK_STAFF_NOTE_MAX}
     OR NOT (${multiline('note_text')}) THEN
    RAISE EXCEPTION 'admin_note_invalid' USING ERRCODE = '22023';
  END IF;
  INSERT INTO slotlock.account_notes (account_ref, staff_ref, body) VALUES (account, actor, note_text)
  RETURNING account_notes.id INTO added;
  PERFORM slotlock.staff_log(actor, 'account.note_added', account, 'note:' || added, NULL, '{}'::jsonb);
  RETURN added;
END
$slotlock_admin_add_note$;

-- Open a case (safety.act), about an account or not yet. The case's id.
CREATE OR REPLACE FUNCTION slotlock.admin_case_open(actor text, account text, case_source text, case_summary text,
                                                    case_section text, case_evidence text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_case_open$
DECLARE
  opened bigint;
BEGIN
  actor := slotlock.staff_session(actor, 'safety.act', false);
  IF account IS NOT NULL THEN
    PERFORM slotlock.staff_account_known(account);
  END IF;
  BEGIN
    INSERT INTO slotlock.abuse_cases (account_ref, source, summary, policy_section, evidence, opened_by)
    VALUES (account, case_source, case_summary, nullif(case_section, ''), nullif(case_evidence, ''), actor)
    RETURNING abuse_cases.id INTO opened;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    RAISE EXCEPTION 'admin_case_invalid' USING ERRCODE = '22023';
  END;
  PERFORM slotlock.staff_log(actor, 'case.opened', account, 'case:' || opened, NULL,
    jsonb_build_object('source', case_source));
  RETURN opened;
END
$slotlock_admin_case_open$;

-- Change a case (safety.act): its status, what was done, how it ended; a NULL keeps what is there.
-- Closing records who and when; reopening clears it. False for no such case.
CREATE OR REPLACE FUNCTION slotlock.admin_case_update(actor text, case_id bigint, new_status text, new_action text,
                                                      new_outcome text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_case_update$
DECLARE
  was text;
  account text;
  now_status text;
BEGIN
  actor := slotlock.staff_session(actor, 'safety.act', false);
  SELECT opened.status, opened.account_ref INTO was, account FROM slotlock.abuse_cases opened
   WHERE opened.id = case_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  now_status := coalesce(new_status, was);
  BEGIN
    UPDATE slotlock.abuse_cases opened
       SET status = now_status,
           action_taken = coalesce(new_action, opened.action_taken),
           outcome = coalesce(nullif(new_outcome, ''), opened.outcome),
           updated_at = statement_timestamp(),
           closed_at = CASE WHEN now_status = 'closed' THEN coalesce(opened.closed_at, statement_timestamp()) END,
           closed_by = CASE WHEN now_status = 'closed' THEN coalesce(opened.closed_by, actor) END
     WHERE opened.id = case_id;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'admin_case_invalid' USING ERRCODE = '22023';
  END;
  PERFORM slotlock.staff_log(actor,
    CASE WHEN was = 'open' AND now_status = 'closed' THEN 'case.closed'
         WHEN was = 'closed' AND now_status = 'open' THEN 'case.reopened'
         ELSE 'case.updated' END,
    account, 'case:' || case_id, NULL,
    jsonb_strip_nulls(jsonb_build_object('status', now_status, 'action', new_action)));
  RETURN true;
END
$slotlock_admin_case_update$;

-- Cases, newest first, a page at a time (after: a case id): open, closed or all, for one account
-- or every one.
CREATE OR REPLACE FUNCTION slotlock.admin_cases(actor text, status_filter text, account text, after bigint, page_size integer)
RETURNS TABLE (id bigint, account_ref text, source text, summary text, policy_section text, action_taken text,
               status text, opened_by text, opened_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_cases$
#variable_conflict use_column
DECLARE
  shown integer := least(greatest(coalesce(page_size, 50), 1), ${SLOTLOCK_ADMIN_PAGE_LIMIT});
BEGIN
  actor := slotlock.staff_session(actor, 'safety.act', false);
  PERFORM slotlock.staff_log(actor, 'cases.listed', account, NULL, NULL,
    jsonb_strip_nulls(jsonb_build_object('status', status_filter)));
  RETURN QUERY
  SELECT opened.id, opened.account_ref, opened.source, opened.summary, opened.policy_section, opened.action_taken,
         opened.status, opened.opened_by, opened.opened_at, opened.updated_at
    FROM slotlock.abuse_cases opened
   WHERE (status_filter IS NULL OR opened.status = status_filter)
     AND (account IS NULL OR opened.account_ref = account)
     AND (after IS NULL OR opened.id < after)
   ORDER BY opened.id DESC
   LIMIT shown;
END
$slotlock_admin_cases$;

-- One case, with its evidence and outcome, and its history from the staff log. NULL for no such
-- case.
CREATE OR REPLACE FUNCTION slotlock.admin_case(actor text, case_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_case$
DECLARE
  result jsonb;
BEGIN
  actor := slotlock.staff_session(actor, 'safety.act', false);
  SELECT to_jsonb(opened) || jsonb_build_object('history', (
           SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'occurred_at', event.occurred_at, 'staff_ref', event.staff_ref, 'action', event.action,
                    'reason', event.reason) ORDER BY event.chain_index), '[]'::jsonb)
             FROM slotlock.staff_audit_events event WHERE event.target = 'case:' || case_id))
    INTO result
    FROM slotlock.abuse_cases opened WHERE opened.id = case_id;
  PERFORM slotlock.staff_log(actor, CASE WHEN result IS NULL THEN 'case.not_found' ELSE 'case.viewed' END,
    result ->> 'account_ref', 'case:' || case_id, NULL, '{}'::jsonb);
  RETURN result;
END
$slotlock_admin_case$;

-- What a deployment-role command did (slotlock tenant suspend, unsuspend and erase, slotlock plan
-- default), by cli:<user>: in the staff log, and for a suspension or its end in the account's own
-- audit log too. Deployment role only; the CLI calls it in the command's transaction where it can.
CREATE OR REPLACE FUNCTION slotlock.staff_operator_record(actor text, happened text, account text, why text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_operator_record$
BEGIN
  IF actor IS NULL OR actor !~ '^cli:[a-z_][a-z0-9_.-]{0,63}$' THEN
    RAISE EXCEPTION 'staff_operator_invalid' USING ERRCODE = '22023';
  END IF;
  IF happened NOT IN ('account.suspended', 'account.unsuspended', 'account.erased', 'plan.default_set',
                      'plan.default_removed') THEN
    RAISE EXCEPTION 'staff_operator_action' USING ERRCODE = '22023';
  END IF;
  PERFORM slotlock.staff_log(actor, happened, account, NULL, nullif(left(why, 500), ''), '{}'::jsonb);
  IF happened = 'account.suspended' THEN
    UPDATE slotlock.tenant_suspensions held SET suspended_by = coalesce(held.suspended_by, actor)
     WHERE held.tenant_ref = account;
    PERFORM slotlock.staff_customer_audit(actor, account, 'staff.account_suspended', NULL, NULL, why);
  ELSIF happened = 'account.unsuspended' THEN
    PERFORM slotlock.staff_customer_audit(actor, account, 'staff.account_unsuspended', NULL, NULL, why);
  END IF;
END
$slotlock_staff_operator_record$;
`;

const maintenanceJobs = SLOTLOCK_MAINTENANCE_JOBS.map((job) => `'${job}'`).join(', ');
/** Overrides in force now: approved, not ended, between their dates. */
const inForce = (alias: string) =>
  `${alias}.approved_at IS NOT NULL AND ${alias}.ended_at IS NULL AND ${alias}.starts_at <= statement_timestamp() AND ${alias}.ends_at > statement_timestamp()`;
/** An override's state, in words the console shows. */
const overrideState = (alias: string) => `CASE
      WHEN ${alias}.ended_at IS NOT NULL THEN 'ended'
      WHEN ${alias}.ends_at <= statement_timestamp() THEN 'expired'
      WHEN ${alias}.approved_at IS NULL THEN 'pending'
      ELSE 'in_force' END`;

/**
 * Phase 3 (RFC 0006): billing and usage. Plan overrides (tenant_plan_overrides, read by
 * slotlock.tenant_plan wherever limits are read), billing alerts from the Stripe webhook, the runs
 * of billing jobs, platform usage, partners' months, and an hour's cache of what Stripe said.
 */
const STAFF_BILLING_DDL = `
-- Each run of a billing job (slotlock billing daily, slotlock overage report): when, by whom, and
-- whether it needs a person, with the lines it printed; and each hour of a server's maintenance
-- (serve), with its passes and failures counted. The newest 400 of each job are kept.
CREATE TABLE IF NOT EXISTS slotlock.maintenance_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job text NOT NULL,
  actor text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  attention boolean NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT slotlock_maintenance_runs_valid CHECK (
    job IN (${maintenanceJobs})
    AND (actor ~ '^cli:[a-z_][a-z0-9_.-]{0,63}$' OR (job = 'maintenance' AND actor = 'serve'))
    AND finished_at >= started_at
    AND jsonb_typeof(summary) = 'object' AND pg_column_size(summary) <= 16384
  )
);
CREATE INDEX IF NOT EXISTS slotlock_maintenance_runs_job_idx ON slotlock.maintenance_runs (job, id DESC);
ALTER TABLE slotlock.maintenance_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.maintenance_runs FROM PUBLIC;

-- What the console read from a provider, kept an hour so pages stay fast and within the provider's
-- limits (RFC 0006, 4.6): Stripe (revenue: keys need billing.read, account: keys accounts.read);
-- Search Console, Bing and Cloudflare Web Analytics (site: keys, site.read); and GitHub's deploys
-- and the hosts' health (system: keys, system.read).
CREATE TABLE IF NOT EXISTS slotlock.admin_cache (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT slotlock_admin_cache_valid CHECK (
    key ~ '^(revenue|account|site|system):[A-Za-z0-9:_.~-]{1,200}$' AND pg_column_size(value) <= 262144
  )
);
ALTER TABLE slotlock.admin_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.admin_cache FROM PUBLIC;

-- The capability a cache key needs; an error (22023) for a key of no known kind.
CREATE OR REPLACE FUNCTION slotlock.staff_cache_capability(cache_key text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_cache_capability$
BEGIN
  IF cache_key LIKE 'revenue:%' THEN
    RETURN 'billing.read';
  ELSIF cache_key LIKE 'account:%' THEN
    RETURN 'accounts.read';
  ELSIF cache_key LIKE 'site:%' THEN
    RETURN 'site.read';
  ELSIF cache_key LIKE 'system:%' THEN
    RETURN 'system.read';
  END IF;
  RAISE EXCEPTION 'admin_cache_key' USING ERRCODE = '22023';
END
$slotlock_staff_cache_capability$;

-- Give an account a plan, limits or quotas until a date (billing.act), with a reason the customer
-- sees. Up to ${SLOTLOCK_OVERRIDE_SOLO_DAYS} days it is in force at once, and ends the account's
-- override in force before it. Longer, it needs an Owner to ask (plans.approve) and another Owner
-- to approve (admin_override_approve). The override's id.
CREATE OR REPLACE FUNCTION slotlock.admin_override_create(actor text, account text, new_plan text,
  new_resources integer, new_keys integer, new_webhooks integer, new_operations bigint, new_bookings bigint,
  new_stop integer, until timestamptz, why text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_override_create$
DECLARE
  added bigint;
  long boolean;
BEGIN
  actor := slotlock.staff_session(actor, 'billing.act', false);
  PERFORM slotlock.staff_account_known(account);
  PERFORM slotlock.staff_reason_valid(why);
  IF until IS NULL OR until <= statement_timestamp() THEN
    RAISE EXCEPTION 'admin_override_dates' USING ERRCODE = '22023';
  END IF;
  long := until > statement_timestamp() + interval '${SLOTLOCK_OVERRIDE_SOLO_DAYS} days';
  IF long THEN
    BEGIN
      PERFORM slotlock.staff_require(actor, 'plans.approve');
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'admin_override_needs_owner' USING ERRCODE = '22023';
    END;
  END IF;
  BEGIN
    INSERT INTO slotlock.tenant_plan_overrides (tenant_ref, plan, max_resources, max_api_keys,
      max_webhook_endpoints, quota_operations, quota_bookings, quota_stop_percent, ends_at, reason,
      created_by, approved_by, approved_at)
    VALUES (account, new_plan, new_resources, new_keys, new_webhooks, new_operations, new_bookings, new_stop,
      until, why, actor, CASE WHEN long THEN NULL ELSE actor END,
      CASE WHEN long THEN NULL ELSE statement_timestamp() END)
    RETURNING tenant_plan_overrides.id INTO added;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    RAISE EXCEPTION 'admin_override_invalid' USING ERRCODE = '22023';
  END;
  IF long THEN
    PERFORM slotlock.staff_log(actor, 'override.requested', account, 'override:' || added, why,
      jsonb_strip_nulls(jsonb_build_object('plan', new_plan, 'ends_at', until)));
    RETURN added;
  END IF;
  UPDATE slotlock.tenant_plan_overrides other
     SET ended_at = statement_timestamp(), ended_by = actor
   WHERE other.tenant_ref = account AND other.id <> added AND other.approved_at IS NOT NULL
     AND other.ended_at IS NULL AND other.ends_at > statement_timestamp();
  PERFORM slotlock.staff_log(actor, 'override.given', account, 'override:' || added, why,
    jsonb_strip_nulls(jsonb_build_object('plan', new_plan, 'ends_at', until)));
  PERFORM slotlock.staff_customer_audit(actor, account, 'staff.plan_overridden', 'override', added::text, why);
  RETURN added;
END
$slotlock_admin_override_create$;

-- Approve another Owner's override of more than ${SLOTLOCK_OVERRIDE_SOLO_DAYS} days (plans.approve): four
-- eyes, so never one's own. 'approved', 'own' (refused: the asker cannot approve), or 'not_pending'
-- (approved already, ended, past its end, or no such override).
CREATE OR REPLACE FUNCTION slotlock.admin_override_approve(actor text, override_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_override_approve$
DECLARE
  asked slotlock.tenant_plan_overrides%ROWTYPE;
BEGIN
  actor := slotlock.staff_session(actor, 'plans.approve', false);
  SELECT * INTO asked FROM slotlock.tenant_plan_overrides waiting WHERE waiting.id = override_id FOR UPDATE;
  IF NOT FOUND OR asked.approved_at IS NOT NULL OR asked.ended_at IS NOT NULL
     OR asked.ends_at <= statement_timestamp() THEN
    RETURN 'not_pending';
  END IF;
  IF asked.created_by = actor THEN
    PERFORM slotlock.staff_log(actor, 'override.approval_refused', asked.tenant_ref, 'override:' || override_id,
      'the Owner who asked cannot approve', '{}'::jsonb);
    RETURN 'own';
  END IF;
  UPDATE slotlock.tenant_plan_overrides waiting
     SET approved_by = actor, approved_at = statement_timestamp()
   WHERE waiting.id = override_id;
  UPDATE slotlock.tenant_plan_overrides other
     SET ended_at = statement_timestamp(), ended_by = actor
   WHERE other.tenant_ref = asked.tenant_ref AND other.id <> override_id AND other.approved_at IS NOT NULL
     AND other.ended_at IS NULL AND other.ends_at > statement_timestamp();
  PERFORM slotlock.staff_log(actor, 'override.approved', asked.tenant_ref, 'override:' || override_id, NULL,
    jsonb_build_object('asked_by', asked.created_by));
  PERFORM slotlock.staff_customer_audit(asked.created_by, asked.tenant_ref, 'staff.plan_overridden', 'override',
    override_id::text, asked.reason);
  RETURN 'approved';
END
$slotlock_admin_override_approve$;

-- End an override before its date, or withdraw one waiting for approval (billing.act). The
-- account is back on its own plan from the next read. False when it had ended already.
CREATE OR REPLACE FUNCTION slotlock.admin_override_end(actor text, override_id bigint, why text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_override_end$
DECLARE
  account text;
  was_approved boolean;
BEGIN
  actor := slotlock.staff_session(actor, 'billing.act', false);
  PERFORM slotlock.staff_reason_valid(why);
  UPDATE slotlock.tenant_plan_overrides ending
     SET ended_at = statement_timestamp(), ended_by = actor
   WHERE ending.id = override_id AND ending.ended_at IS NULL AND ending.ends_at > statement_timestamp()
  RETURNING ending.tenant_ref, ending.approved_at IS NOT NULL INTO account, was_approved;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM slotlock.staff_log(actor, CASE WHEN was_approved THEN 'override.ended' ELSE 'override.withdrawn' END,
    account, 'override:' || override_id, why, '{}'::jsonb);
  IF was_approved THEN
    PERFORM slotlock.staff_customer_audit(actor, account, 'staff.plan_override_ended', 'override', override_id::text, why);
  END IF;
  RETURN true;
END
$slotlock_admin_override_end$;

-- An account's overrides, newest first, with each one's state.
CREATE OR REPLACE FUNCTION slotlock.admin_account_overrides(actor text, account text)
RETURNS TABLE (id bigint, plan text, max_resources integer, max_api_keys integer, max_webhook_endpoints integer,
               quota_operations bigint, quota_bookings bigint, quota_stop_percent integer, starts_at timestamptz,
               ends_at timestamptz, reason text, created_by text, approved_by text, ended_by text,
               ended_at timestamptz, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_account_overrides$
#variable_conflict use_column
BEGIN
  actor := slotlock.staff_session(actor, 'accounts.read', false);
  PERFORM slotlock.staff_log(actor, 'account.overrides_viewed', account, NULL, NULL, '{}'::jsonb);
  RETURN QUERY
  SELECT given.id, given.plan, given.max_resources, given.max_api_keys, given.max_webhook_endpoints,
         given.quota_operations, given.quota_bookings, given.quota_stop_percent, given.starts_at, given.ends_at,
         given.reason, given.created_by, given.approved_by, given.ended_by, given.ended_at, ${overrideState('given')}
    FROM slotlock.tenant_plan_overrides given
   WHERE given.tenant_ref = account
   ORDER BY given.id DESC
   LIMIT 20;
END
$slotlock_admin_account_overrides$;

-- Overrides in force or waiting for approval, across accounts, newest first.
CREATE OR REPLACE FUNCTION slotlock.admin_overrides(actor text)
RETURNS TABLE (id bigint, account_ref text, plan text, starts_at timestamptz, ends_at timestamptz, reason text,
               created_by text, approved_by text, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_overrides$
#variable_conflict use_column
BEGIN
  actor := slotlock.staff_session(actor, 'billing.read', false);
  PERFORM slotlock.staff_log(actor, 'overrides.listed', NULL, NULL, NULL, '{}'::jsonb);
  RETURN QUERY
  SELECT given.id, given.tenant_ref, given.plan, given.starts_at, given.ends_at, given.reason, given.created_by,
         given.approved_by, ${overrideState('given')}
    FROM slotlock.tenant_plan_overrides given
   WHERE given.ended_at IS NULL AND given.ends_at > statement_timestamp()
   ORDER BY given.id DESC
   LIMIT ${SLOTLOCK_ADMIN_PAGE_LIMIT};
END
$slotlock_admin_overrides$;

-- Billing at a glance: paying accounts by plan (staff_subscribed_plans), those in a trial, those set
-- to end and when, past due, cancelled this month, open alerts, overrides in force and waiting, and
-- each billing job's last run. Test environments left out.
CREATE OR REPLACE FUNCTION slotlock.admin_billing(actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_billing$
DECLARE
  month_start date := ${monthStart};
  result jsonb;
BEGIN
  actor := slotlock.staff_session(actor, 'billing.read', false);
  SELECT jsonb_build_object(
    'paying', (SELECT coalesce(jsonb_object_agg(paid.plan, paid.total), '{}'::jsonb) FROM (
                 SELECT held.plan, count(*) AS total FROM slotlock.staff_subscribed_plans() held
                  WHERE held.paying GROUP BY held.plan) paid),
    'trialing', (SELECT count(*) FROM slotlock.staff_subscribed_plans() held WHERE held.trialing),
    'ending', (SELECT coalesce(jsonb_agg(jsonb_build_object('account_ref', ends.tenant_ref, 'plan', ends.plan,
                                                            'ends_at', ends.ends_at) ORDER BY ends.ends_at, ends.tenant_ref),
                               '[]'::jsonb)
                 FROM (SELECT held.tenant_ref, held.plan, held.ends_at FROM slotlock.staff_subscribed_plans() held
                        WHERE NOT held.trialing AND held.ends_at IS NOT NULL
                        ORDER BY held.ends_at, held.tenant_ref LIMIT ${SLOTLOCK_ADMIN_PAGE_LIMIT}) ends),
    'ending_total', (SELECT count(*) FROM slotlock.staff_subscribed_plans() held
                      WHERE NOT held.trialing AND held.ends_at IS NOT NULL),
    'past_due', (SELECT count(*) FROM slotlock.staff_subscribed_plans() held WHERE held.status = 'past_due'),
    'canceled_month', (SELECT count(*) FROM slotlock.tenant_plans planned
                        WHERE planned.status = 'canceled' AND planned.updated_at >= month_start
                          AND planned.tenant_ref !~ '~test$'),
    'alerts_open', (SELECT count(*) FROM slotlock.billing_alerts open WHERE open.resolved_at IS NULL),
    'overrides_in_force', (SELECT count(*) FROM slotlock.tenant_plan_overrides given WHERE ${inForce('given')}),
    'overrides_pending', (SELECT count(*) FROM slotlock.tenant_plan_overrides given
                           WHERE given.approved_at IS NULL AND given.ended_at IS NULL
                             AND given.ends_at > statement_timestamp()),
    'runs', (SELECT coalesce(jsonb_object_agg(latest.job, jsonb_build_object(
               'started_at', latest.started_at, 'finished_at', latest.finished_at, 'attention', latest.attention,
               'actor', latest.actor, 'summary', latest.summary)), '{}'::jsonb)
               FROM (SELECT DISTINCT ON (run.job) run.* FROM slotlock.maintenance_runs run
                      ORDER BY run.job, run.id DESC) latest)
  ) INTO result;
  PERFORM slotlock.staff_log(actor, 'billing.viewed', NULL, NULL, NULL, '{}'::jsonb);
  RETURN result;
END
$slotlock_admin_billing$;

-- Billing alerts, newest first, a page at a time (after: an alert id): open ones, or all.
CREATE OR REPLACE FUNCTION slotlock.admin_billing_alerts(actor text, open_only boolean, after bigint, page_size integer)
RETURNS TABLE (id bigint, kind text, account_ref text, stripe_ref text, detail jsonb, created_at timestamptz,
               resolved_at timestamptz, resolved_by text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_billing_alerts$
#variable_conflict use_column
DECLARE
  shown integer := least(greatest(coalesce(page_size, 50), 1), ${SLOTLOCK_ADMIN_PAGE_LIMIT});
BEGIN
  actor := slotlock.staff_session(actor, 'billing.read', false);
  PERFORM slotlock.staff_log(actor, 'billing.alerts_listed', NULL, NULL, NULL,
    jsonb_build_object('open_only', coalesce(open_only, true)));
  RETURN QUERY
  SELECT seen.id, seen.kind, seen.tenant_ref, seen.stripe_ref, seen.detail, seen.created_at, seen.resolved_at,
         seen.resolved_by
    FROM slotlock.billing_alerts seen
   WHERE (NOT coalesce(open_only, true) OR seen.resolved_at IS NULL)
     AND (after IS NULL OR seen.id < after)
   ORDER BY seen.id DESC
   LIMIT shown;
END
$slotlock_admin_billing_alerts$;

-- Mark a billing alert dealt with (billing.act), with what was done. False when it was already.
CREATE OR REPLACE FUNCTION slotlock.admin_billing_alert_resolve(actor text, alert_id bigint, why text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_billing_alert_resolve$
DECLARE
  account text;
BEGIN
  actor := slotlock.staff_session(actor, 'billing.act', false);
  PERFORM slotlock.staff_reason_valid(why);
  UPDATE slotlock.billing_alerts open
     SET resolved_at = statement_timestamp(), resolved_by = actor
   WHERE open.id = alert_id AND open.resolved_at IS NULL
  RETURNING open.tenant_ref INTO account;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM slotlock.staff_log(actor, 'billing.alert_resolved', account, 'alert:' || alert_id, why, '{}'::jsonb);
  RETURN true;
END
$slotlock_admin_billing_alert_resolve$;

-- The platform's use by day, metric and surface (usage_daily's origin) over its last days, test
-- environments left out.
CREATE OR REPLACE FUNCTION slotlock.admin_usage(actor text, days integer)
RETURNS TABLE (day date, metric text, origin text, count bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_usage$
#variable_conflict use_column
DECLARE
  span integer := least(greatest(coalesce(days, 30), 1), 400);
BEGIN
  actor := slotlock.staff_session(actor, 'accounts.read', false);
  PERFORM slotlock.staff_log(actor, 'usage.viewed', NULL, NULL, NULL, jsonb_build_object('days', span));
  RETURN QUERY
  SELECT used.day, used.metric, used.origin, sum(used.count)::bigint
    FROM slotlock.usage_daily used
   WHERE used.day > ${today} - span AND used.tenant_ref !~ '~test$'
   GROUP BY used.day, used.metric, used.origin
   ORDER BY used.day, used.metric, used.origin;
END
$slotlock_admin_usage$;

-- The accounts using most this month, with the quotas they are held to: their own or an
-- override's (null quotas are the plan's, plans.ts SLOTLOCK_PLAN_QUOTAS).
CREATE OR REPLACE FUNCTION slotlock.admin_usage_accounts(actor text)
RETURNS TABLE (account_ref text, plan text, operations bigint, bookings bigint, quota_operations bigint,
               quota_bookings bigint, quota_stop_percent integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_usage_accounts$
#variable_conflict use_column
DECLARE
  month_start date := ${monthStart};
BEGIN
  actor := slotlock.staff_session(actor, 'accounts.read', false);
  PERFORM slotlock.staff_log(actor, 'usage.accounts_listed', NULL, NULL, NULL, '{}'::jsonb);
  RETURN QUERY
  WITH month AS (
    SELECT used.tenant_ref,
           sum(used.count) FILTER (WHERE used.metric = 'operations')::bigint AS operations,
           sum(used.count) FILTER (WHERE used.metric = 'bookings')::bigint AS bookings
      FROM slotlock.usage_daily used
     WHERE used.day >= month_start AND used.tenant_ref !~ '~test$'
     GROUP BY used.tenant_ref
     ORDER BY 2 DESC NULLS LAST
     LIMIT 50
  )
  SELECT month.tenant_ref, quotas.plan, coalesce(month.operations, 0), coalesce(month.bookings, 0),
         quotas.operations, quotas.bookings, quotas.stop_percent
    FROM month
    LEFT JOIN LATERAL (SELECT * FROM slotlock.tenant_plan_quotas(month.tenant_ref)) quotas ON true
   ORDER BY 3 DESC;
END
$slotlock_admin_usage_accounts$;

-- Partners and their months: accounts, the last month closed, whether its webhook was delivered,
-- what it invoiced and what is not sent yet, and days in the last week whose counts disagreed.
CREATE OR REPLACE FUNCTION slotlock.admin_partners(actor text)
RETURNS TABLE (id text, name text, status text, accounts bigint, last_month date, closed_at timestamptz,
               webhook_status integer, invoiced bigint, currency text, unsent bigint, mismatched_days bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_partners$
#variable_conflict use_column
BEGIN
  actor := slotlock.staff_session(actor, 'billing.read', false);
  PERFORM slotlock.staff_log(actor, 'partners.viewed', NULL, NULL, NULL, '{}'::jsonb);
  RETURN QUERY
  SELECT partner.id, partner.name, partner.status,
         (SELECT count(*) FROM slotlock.partner_accounts owned WHERE owned.partner_id = partner.id),
         closed.month, closed.closed_at, closed.webhook_status,
         (SELECT sum(line.amount)::bigint FROM slotlock.partner_invoices line
           WHERE line.partner_id = partner.id AND line.month = closed.month),
         (SELECT min(line.currency) FROM slotlock.partner_invoices line
           WHERE line.partner_id = partner.id AND line.month = closed.month),
         (SELECT count(*) FROM slotlock.partner_invoices line
           WHERE line.partner_id = partner.id AND line.sent_at IS NULL),
         (SELECT count(*) FROM slotlock.partner_reconciliations checked
           WHERE checked.partner_id = partner.id AND checked.mismatched > 0 AND checked.day >= ${today} - 7)
    FROM slotlock.partners partner
    LEFT JOIN LATERAL (SELECT * FROM slotlock.partner_month_closes done
                        WHERE done.partner_id = partner.id ORDER BY done.month DESC LIMIT 1) closed ON true
   ORDER BY partner.id
   LIMIT ${SLOTLOCK_ADMIN_PAGE_LIMIT};
END
$slotlock_admin_partners$;

-- A provider read the console kept within the hour, or NULL. Not recorded in the staff log: the
-- page that reads it is.
CREATE OR REPLACE FUNCTION slotlock.admin_cache_read(actor text, cache_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_cache_read$
BEGIN
  actor := slotlock.staff_session(actor, 'home', false);
  PERFORM slotlock.staff_require(actor, slotlock.staff_cache_capability(cache_key));
  RETURN (SELECT kept.value FROM slotlock.admin_cache kept
           WHERE kept.key = cache_key AND kept.expires_at > statement_timestamp());
END
$slotlock_admin_cache_read$;

-- Keep a provider read for an hour; expired ones go.
CREATE OR REPLACE FUNCTION slotlock.admin_cache_write(actor text, cache_key text, cache_value jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_cache_write$
BEGIN
  actor := slotlock.staff_session(actor, 'home', false);
  PERFORM slotlock.staff_require(actor, slotlock.staff_cache_capability(cache_key));
  DELETE FROM slotlock.admin_cache old WHERE old.expires_at < statement_timestamp();
  INSERT INTO slotlock.admin_cache AS kept (key, value, expires_at)
  VALUES (cache_key, cache_value, statement_timestamp() + interval '${SLOTLOCK_ADMIN_CACHE_SECONDS} seconds')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, stored_at = statement_timestamp(),
                                  expires_at = EXCLUDED.expires_at;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'admin_cache_value' USING ERRCODE = '22023';
END
$slotlock_admin_cache_write$;

-- A billing job's run, from the CLI as the deployment role (slotlock billing daily, slotlock
-- overage report). Deployment role only.
CREATE OR REPLACE FUNCTION slotlock.record_maintenance_run(run_job text, actor text, began timestamptz,
  needs_attention boolean, run_summary jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_record_maintenance_run$
BEGIN
  INSERT INTO slotlock.maintenance_runs (job, actor, started_at, attention, summary)
  VALUES (run_job, actor, began, needs_attention, coalesce(run_summary, '{}'::jsonb));
  DELETE FROM slotlock.maintenance_runs old
   WHERE old.job = run_job
     AND old.id < (SELECT kept.id FROM slotlock.maintenance_runs kept WHERE kept.job = run_job
                    ORDER BY kept.id DESC OFFSET 399 LIMIT 1);
END
$slotlock_record_maintenance_run$;
`;

const contentSteps = (steps: readonly string[]) => steps.map((step) => `'${step}'`).join(', ');

/**
 * Phase 4 (RFC 0006, 4.5): the CMS. Posts live in the repository, not here, so the database only
 * checks the role for each step and records it, before the console calls GitHub.
 */
const STAFF_CONTENT_DDL = `
-- A step in the CMS, recorded before the console asks GitHub for it: content.write for writing a
-- post (saving, submitting, its images, renaming, discarding a draft), content.publish for
-- publishing, scheduling and unscheduling one. The post is named by its slug.
CREATE OR REPLACE FUNCTION slotlock.admin_content_record(actor text, happened text, post text, extra jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_content_record$
BEGIN
  actor := slotlock.staff_session(actor, 'content.write', false);
  IF happened IN (${contentSteps(SLOTLOCK_CONTENT_STEPS.publish)}) THEN
    PERFORM slotlock.staff_require(actor, 'content.publish');
  ELSIF happened IS NULL OR happened NOT IN (${contentSteps(SLOTLOCK_CONTENT_STEPS.write)}) THEN
    RAISE EXCEPTION 'admin_content_action' USING ERRCODE = '22023';
  END IF;
  IF post IS NULL OR post !~ '${SLOTLOCK_POST_SLUG_PATTERN}'
     OR (extra IS NOT NULL AND (jsonb_typeof(extra) <> 'object' OR pg_column_size(extra) > 4096)) THEN
    RAISE EXCEPTION 'admin_content_post' USING ERRCODE = '22023';
  END IF;
  PERFORM slotlock.staff_log(actor, happened, NULL, 'post:' || post, NULL, extra);
END
$slotlock_admin_content_record$;
`;

const privacyKinds = SLOTLOCK_PRIVACY_KINDS.map((value) => `'${value}'`).join(', ');
const privacyConcerns = SLOTLOCK_PRIVACY_CONCERNS.map((value) => `'${value}'`).join(', ');
const privacyOutcomes = SLOTLOCK_PRIVACY_OUTCOMES.map((value) => `'${value}'`).join(', ');
/** Free text the privacy queue keeps: one line, no control characters, and no email address. */
const privacyText = (column: string) => `char_length(${column}) BETWEEN 1 AND 200 AND ${column} !~ '[[:cntrl:]@]'`;

/**
 * Phase 5 (RFC 0006, M7): privacy requests. A request about an account holder is answered here:
 * verified by a key named with the word the request was sent, then an export to their dashboard, or
 * an erasure in an order that cannot change (Stripe first, a second Owner approves, erase, a
 * receipt). One about an account's own customers is passed on to the account holder. The queue
 * keeps no email address: a request is found by where it is in the privacy mailbox.
 */
const STAFF_PRIVACY_DDL = `
CREATE TABLE IF NOT EXISTS slotlock.privacy_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The account; null once it is erased, when only its digest (privacy_digest) is kept.
  account_ref text,
  account_digest text NOT NULL,
  kind text NOT NULL,
  concerns text NOT NULL,
  received_on date NOT NULL,
  -- One month to answer (UK GDPR, Article 12(3)).
  due_on date GENERATED ALWAYS AS ((received_on + interval '1 month')::date) STORED,
  -- Where the request is: the privacy mailbox thread's subject or id, never an address.
  reference text NOT NULL,
  -- The word sent back; a key with it as its name, made after the request, shows the account is theirs.
  verification_word text NOT NULL,
  verified_by text,
  verified_at timestamptz,
  verified_key text,
  export_id uuid,
  erasure_asked_by text,
  erasure_asked_at timestamptz,
  erasure_approved_by text,
  erasure_approved_at timestamptz,
  status text NOT NULL DEFAULT 'open',
  outcome text,
  opened_by text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  closed_by text,
  closed_at timestamptz,
  CONSTRAINT slotlock_privacy_requests_valid CHECK (
    (account_ref IS NULL OR octet_length(account_ref) BETWEEN 1 AND 500)
    AND (account_ref IS NOT NULL OR status <> 'open')
    AND account_digest ~ '^[0-9a-f]{64}$'
    AND kind IN (${privacyKinds}) AND concerns IN (${privacyConcerns})
    AND ${privacyText('reference')}
    AND verification_word ~ '^slotlock-[0-9a-f]{10}$'
    AND (verified_at IS NULL) = (verified_by IS NULL)
    AND (verified_key IS NULL OR verified_key ~ '^slk_(test_)?[0-9A-Za-z]{8}$')
    AND (export_id IS NULL OR (concerns = 'account' AND kind IN ('access', 'export')))
    AND (erasure_asked_at IS NULL) = (erasure_asked_by IS NULL)
    AND (erasure_approved_at IS NULL) = (erasure_approved_by IS NULL)
    AND (erasure_asked_at IS NULL OR (concerns = 'account' AND kind = 'erasure'))
    AND (erasure_approved_at IS NULL OR (erasure_asked_at IS NOT NULL AND erasure_approved_by <> erasure_asked_by))
    AND status IN ('open', ${privacyOutcomes})
    AND (status = 'open') = (closed_at IS NULL)
    AND (closed_at IS NULL) = (closed_by IS NULL)
    AND (outcome IS NULL OR (${privacyText('outcome')}))
    AND opened_by ~ '${STAFF_ACTOR_PATTERN}'
    AND (verified_by IS NULL OR verified_by ~ '${STAFF_ACTOR_PATTERN}')
    AND (closed_by IS NULL OR closed_by ~ '${STAFF_ACTOR_PATTERN}')
  )
);
CREATE INDEX IF NOT EXISTS slotlock_privacy_requests_open_idx ON slotlock.privacy_requests (due_on, id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS slotlock_privacy_requests_account_idx ON slotlock.privacy_requests (account_ref) WHERE account_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS slotlock_privacy_requests_closed_idx ON slotlock.privacy_requests (closed_at) WHERE closed_at IS NOT NULL;
ALTER TABLE slotlock.privacy_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.privacy_requests FROM PUBLIC;

-- An erasure's receipt (RFC 0006, M7, step 4): the request, the erased account's digest, how many
-- rows went, and who asked, approved and erased. No personal data of the account; it outlives it.
CREATE TABLE IF NOT EXISTS slotlock.privacy_erasure_receipts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id bigint NOT NULL UNIQUE REFERENCES slotlock.privacy_requests (id) ON DELETE CASCADE,
  account_digest text NOT NULL,
  rows_erased bigint NOT NULL,
  asked_by text NOT NULL,
  approved_by text NOT NULL,
  erased_by text NOT NULL,
  erased_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_privacy_erasure_receipts_valid CHECK (
    account_digest ~ '^[0-9a-f]{64}$' AND rows_erased >= 0 AND approved_by <> asked_by
    AND asked_by ~ '${STAFF_ACTOR_PATTERN}' AND approved_by ~ '${STAFF_ACTOR_PATTERN}'
    AND erased_by ~ '${STAFF_ACTOR_PATTERN}'
  )
);
ALTER TABLE slotlock.privacy_erasure_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.privacy_erasure_receipts FROM PUBLIC;

-- This deployment's secret for privacy_digest, made once: an erased account's digest cannot be
-- worked out from a guessed reference by anyone without the database.
CREATE TABLE IF NOT EXISTS slotlock.privacy_keys (
  singleton boolean PRIMARY KEY DEFAULT true,
  salt text NOT NULL,
  CONSTRAINT slotlock_privacy_keys_valid CHECK (singleton AND salt ~ '^[0-9a-f]{64}$')
);
ALTER TABLE slotlock.privacy_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.privacy_keys FROM PUBLIC;
INSERT INTO slotlock.privacy_keys (salt)
SELECT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
 WHERE NOT EXISTS (SELECT 1 FROM slotlock.privacy_keys);

CREATE INDEX IF NOT EXISTS slotlock_staff_audit_events_occurred_idx ON slotlock.staff_audit_events (occurred_at);
CREATE INDEX IF NOT EXISTS slotlock_abuse_cases_closed_idx ON slotlock.abuse_cases (closed_at) WHERE status = 'closed';

-- An account's digest: SHA-256 of this deployment's secret and its reference.
CREATE OR REPLACE FUNCTION slotlock.privacy_digest(account text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_privacy_digest$
  SELECT encode(sha256(convert_to(secret.salt || ':' || account, 'UTF8')), 'hex')
    FROM slotlock.privacy_keys secret WHERE secret.singleton;
$slotlock_privacy_digest$;

-- Log a privacy request (privacy.act): the account, what it asks for, whom it concerns, the day it
-- arrived and where it is in the mailbox. Its word to send back is made here. The request's id.
CREATE OR REPLACE FUNCTION slotlock.admin_privacy_open(actor text, account text, request_kind text,
  request_concerns text, received date, request_reference text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_privacy_open$
DECLARE
  added bigint;
BEGIN
  actor := slotlock.staff_session(actor, 'privacy.act', false);
  PERFORM slotlock.staff_account_known(account);
  IF received IS NULL OR received > ${today} OR received < ${today} - 366 THEN
    RAISE EXCEPTION 'privacy_received' USING ERRCODE = '22023';
  END IF;
  INSERT INTO slotlock.privacy_requests (account_ref, account_digest, kind, concerns, received_on, reference,
                                         verification_word, opened_by)
  VALUES (account, slotlock.privacy_digest(account), request_kind, request_concerns, received, request_reference,
          'slotlock-' || left(md5(gen_random_uuid()::text), 10), actor)
  RETURNING id INTO added;
  PERFORM slotlock.staff_log(actor, 'privacy.opened', account, 'privacy:' || added, NULL,
    jsonb_build_object('kind', request_kind, 'concerns', request_concerns));
  RETURN added;
EXCEPTION WHEN check_violation OR not_null_violation THEN
  RAISE EXCEPTION 'privacy_request_invalid' USING ERRCODE = '22023';
END
$slotlock_admin_privacy_open$;

-- The queue (privacy.act): open requests by due date, or every request, newest first.
CREATE OR REPLACE FUNCTION slotlock.admin_privacy_requests(actor text, open_only boolean, before bigint, page_limit integer)
RETURNS TABLE (id bigint, account_ref text, kind text, concerns text, received_on date, due_on date,
               status text, verified boolean, exporting boolean, erasure_asked boolean, erasure_approved boolean,
               opened_by text, opened_at timestamptz, closed_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_privacy_requests$
BEGIN
  actor := slotlock.staff_session(actor, 'privacy.act', false);
  PERFORM slotlock.staff_log(actor, 'privacy.listed', NULL, NULL, NULL, '{}'::jsonb);
  RETURN QUERY
  SELECT asked.id, asked.account_ref, asked.kind, asked.concerns, asked.received_on, asked.due_on, asked.status,
         asked.verified_at IS NOT NULL, asked.export_id IS NOT NULL, asked.erasure_asked_at IS NOT NULL,
         asked.erasure_approved_at IS NOT NULL, asked.opened_by, asked.opened_at, asked.closed_at
    FROM slotlock.privacy_requests asked
   WHERE (NOT coalesce(open_only, false) OR asked.status = 'open')
     AND (before IS NULL OR asked.id < before)
   ORDER BY CASE WHEN coalesce(open_only, false) THEN asked.due_on END, asked.id DESC
   LIMIT LEAST(GREATEST(coalesce(page_limit, ${SLOTLOCK_ADMIN_PAGE_LIMIT}), 1), ${SLOTLOCK_ADMIN_PAGE_LIMIT});
END
$slotlock_admin_privacy_requests$;

-- One request (privacy.act), with what its steps need: the key that would verify it, the export
-- made for it (its counts by table, never its rows), the account's plan and Stripe ids, and the
-- receipt once erased. Null when there is no such request.
CREATE OR REPLACE FUNCTION slotlock.admin_privacy_request(actor text, request_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_privacy_request$
DECLARE
  asked slotlock.privacy_requests%ROWTYPE;
  account text;
  previous text := current_setting('slotlock.tenant_ref', true);
  made jsonb;
  plan jsonb;
  proof jsonb;
  receipt jsonb;
BEGIN
  actor := slotlock.staff_session(actor, 'privacy.act', false);
  SELECT * INTO asked FROM slotlock.privacy_requests found WHERE found.id = request_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  account := asked.account_ref;
  IF account IS NOT NULL THEN
    SELECT jsonb_build_object('plan', held.plan, 'status', held.status, 'stripe_customer', held.stripe_customer,
                              'stripe_subscription', held.stripe_subscription,
                              'live', held.stripe_subscription IS NOT NULL)
      INTO plan FROM slotlock.tenant_plans held WHERE held.tenant_ref = account;
    SELECT jsonb_build_object('prefix', key.prefix, 'created_by', key.created_by, 'created_at', key.created_at)
      INTO proof FROM slotlock.api_keys key
     WHERE key.tenant_ref = account AND key.name = asked.verification_word AND key.revoked_at IS NULL
     ORDER BY key.created_at DESC LIMIT 1;
    PERFORM set_config('slotlock.tenant_ref', account, true);
    SELECT jsonb_build_object('id', made_export.id, 'status', made_export.status, 'created_at', made_export.created_at,
                              'finished_at', made_export.finished_at, 'expires_at', made_export.expires_at,
                              'rows', made_export.row_count, 'tables', made_export.tables, 'error', made_export.error)
      INTO made FROM slotlock.tenant_exports made_export
     WHERE made_export.id = asked.export_id AND made_export.tenant_ref = account;
    PERFORM set_config('slotlock.tenant_ref', coalesce(previous, ''), true);
  END IF;
  SELECT jsonb_build_object('rows', kept.rows_erased, 'asked_by', kept.asked_by, 'approved_by', kept.approved_by,
                            'erased_by', kept.erased_by, 'erased_at', kept.erased_at, 'digest', kept.account_digest)
    INTO receipt FROM slotlock.privacy_erasure_receipts kept WHERE kept.request_id = asked.id;
  PERFORM slotlock.staff_log(actor, 'privacy.viewed', account, 'privacy:' || asked.id, NULL, '{}'::jsonb);
  RETURN (to_jsonb(asked) - 'account_digest')
    || jsonb_build_object('export', made, 'plan', plan, 'proof', proof, 'receipt', receipt,
                          'export_kept', CASE WHEN asked.export_id IS NULL THEN NULL ELSE made IS NOT NULL END);
END
$slotlock_admin_privacy_request$;

-- Verify a request about an account (privacy.act): it is theirs when the account has a key, made
-- since the request was logged and not revoked, named with the request's word, made by the
-- person the account is or, for a team or an organization, by one of its Owners.
-- 'verified', 'not_found' (no such key yet) or 'closed'.
CREATE OR REPLACE FUNCTION slotlock.admin_privacy_verify(actor text, request_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_privacy_verify$
DECLARE
  asked slotlock.privacy_requests%ROWTYPE;
  proved text;
BEGIN
  actor := slotlock.staff_session(actor, 'privacy.act', false);
  SELECT * INTO asked FROM slotlock.privacy_requests waiting WHERE waiting.id = request_id FOR UPDATE;
  IF NOT FOUND OR asked.status <> 'open' THEN
    RETURN 'closed';
  END IF;
  IF asked.verified_at IS NOT NULL THEN
    RETURN 'verified';
  END IF;
  SELECT key.prefix INTO proved FROM slotlock.api_keys key
   WHERE key.tenant_ref = asked.account_ref AND key.name = asked.verification_word AND key.revoked_at IS NULL
     AND key.created_at >= asked.opened_at
     AND CASE
           WHEN asked.account_ref ~ '^(github|google|sso):' THEN key.created_by = asked.account_ref
           WHEN asked.account_ref ~ '^(team|github-org):' THEN EXISTS (
             SELECT 1 FROM slotlock.workspace_memberships member
              WHERE member.tenant_ref = asked.account_ref AND member.person_ref = key.created_by
                AND member.role = 'owner' AND member.status = 'active')
           ELSE key.created_by IS NOT NULL
         END
   ORDER BY key.created_at DESC LIMIT 1;
  IF proved IS NULL THEN
    PERFORM slotlock.staff_log(actor, 'privacy.verification_failed', asked.account_ref, 'privacy:' || asked.id,
      NULL, '{}'::jsonb);
    RETURN 'not_found';
  END IF;
  UPDATE slotlock.privacy_requests waiting
     SET verified_by = actor, verified_at = statement_timestamp(), verified_key = proved
   WHERE waiting.id = asked.id;
  PERFORM slotlock.staff_log(actor, 'privacy.verified', asked.account_ref, 'privacy:' || asked.id, NULL,
    jsonb_build_object('key', proved));
  RETURN 'verified';
END
$slotlock_admin_privacy_verify$;

-- Start the export a verified access or export request asks for (privacy.act): the account's own
-- export, built by the next maintenance pass and kept ${SLOTLOCK_PRIVACY_EXPORT_DAYS} days once ready, which its holder
-- downloads from their dashboard's Privacy page. Staff never see its rows. Recorded in the
-- account's audit log as Slotlock staff (E8). 'started', 'in_progress' (one is being built),
-- 'limit' (five are kept), 'not_verified', 'not_export' or 'closed'.
CREATE OR REPLACE FUNCTION slotlock.admin_privacy_export(actor text, request_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_privacy_export$
DECLARE
  asked slotlock.privacy_requests%ROWTYPE;
  account text;
  previous text := current_setting('slotlock.tenant_ref', true);
  pending integer;
  kept integer;
  made uuid;
BEGIN
  actor := slotlock.staff_session(actor, 'privacy.act', false);
  SELECT * INTO asked FROM slotlock.privacy_requests waiting WHERE waiting.id = request_id FOR UPDATE;
  IF NOT FOUND OR asked.status <> 'open' THEN
    RETURN 'closed';
  END IF;
  IF asked.concerns <> 'account' OR asked.kind NOT IN ('access', 'export') THEN
    RETURN 'not_export';
  END IF;
  IF asked.verified_at IS NULL THEN
    RETURN 'not_verified';
  END IF;
  account := asked.account_ref;
  -- The lock createTenantExport takes, so two exports are never asked for at once.
  PERFORM pg_advisory_xact_lock(hashtextextended('[' || to_json(account)::text || ',"tenant-export"]', 0));
  PERFORM set_config('slotlock.tenant_ref', account, true);
  SELECT count(*) FILTER (WHERE made_export.status = 'pending'), count(*) INTO pending, kept
    FROM slotlock.tenant_exports made_export
   WHERE made_export.tenant_ref = account AND made_export.expires_at > statement_timestamp();
  -- Five kept at most (SLOTLOCK_MAX_TENANT_EXPORTS).
  IF pending = 0 AND kept < 5 THEN
    INSERT INTO slotlock.tenant_exports (tenant_ref, requested_by, expires_at)
    VALUES (account, 'privacy:' || asked.id, statement_timestamp() + make_interval(days => ${SLOTLOCK_PRIVACY_EXPORT_DAYS}))
    RETURNING tenant_exports.id INTO made;
  END IF;
  PERFORM set_config('slotlock.tenant_ref', coalesce(previous, ''), true);
  IF made IS NULL THEN
    PERFORM slotlock.staff_log(actor, 'privacy.export_refused', account, 'privacy:' || asked.id, NULL,
      jsonb_build_object('pending', pending, 'kept', kept));
    RETURN CASE WHEN pending > 0 THEN 'in_progress' ELSE 'limit' END;
  END IF;
  -- Maintenance visits the accounts it knows; this one may have had nothing to visit for.
  INSERT INTO slotlock.maintenance_tenants (tenant_ref) VALUES (account) ON CONFLICT DO NOTHING;
  UPDATE slotlock.privacy_requests waiting SET export_id = made WHERE waiting.id = asked.id;
  PERFORM slotlock.staff_customer_audit(actor, account, 'export.created', 'export', made::text,
    'Asked for in a privacy request');
  PERFORM slotlock.staff_log(actor, 'privacy.export_started', account, 'privacy:' || asked.id, NULL,
    jsonb_build_object('export', made));
  RETURN 'started';
END
$slotlock_admin_privacy_export$;

-- Ask for a verified erasure (privacy.erase), the first of the two Owners it needs, once the
-- account's Stripe subscription is cancelled. 'asked', 'asked_already', 'subscription_live',
-- 'not_verified', 'not_erasure' or 'closed'.
CREATE OR REPLACE FUNCTION slotlock.admin_privacy_erasure_ask(actor text, request_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_privacy_erasure_ask$
DECLARE
  asked slotlock.privacy_requests%ROWTYPE;
BEGIN
  actor := slotlock.staff_session(actor, 'privacy.erase', false);
  SELECT * INTO asked FROM slotlock.privacy_requests waiting WHERE waiting.id = request_id FOR UPDATE;
  IF NOT FOUND OR asked.status <> 'open' THEN
    RETURN 'closed';
  END IF;
  IF asked.concerns <> 'account' OR asked.kind <> 'erasure' THEN
    RETURN 'not_erasure';
  END IF;
  IF asked.verified_at IS NULL THEN
    RETURN 'not_verified';
  END IF;
  IF asked.erasure_asked_at IS NOT NULL THEN
    RETURN 'asked_already';
  END IF;
  -- Step 1 comes first: the Stripe subscription is cancelled before an erasure is asked for.
  IF EXISTS (SELECT 1 FROM slotlock.tenant_plans held
              WHERE held.tenant_ref = asked.account_ref AND held.stripe_subscription IS NOT NULL) THEN
    PERFORM slotlock.staff_log(actor, 'privacy.erasure_refused', asked.account_ref, 'privacy:' || asked.id,
      'the Stripe subscription is live', '{}'::jsonb);
    RETURN 'subscription_live';
  END IF;
  UPDATE slotlock.privacy_requests waiting
     SET erasure_asked_by = actor, erasure_asked_at = statement_timestamp()
   WHERE waiting.id = asked.id;
  PERFORM slotlock.staff_log(actor, 'privacy.erasure_asked', asked.account_ref, 'privacy:' || asked.id, NULL,
    '{}'::jsonb);
  RETURN 'asked';
END
$slotlock_admin_privacy_erasure_ask$;

-- Approve an erasure another Owner asked for (privacy.erase; four eyes): the one who asked cannot,
-- and not while a Stripe subscription is live. 'approved', 'own', 'subscription_live',
-- 'approved_already', 'not_asked' or 'closed'.
CREATE OR REPLACE FUNCTION slotlock.admin_privacy_erasure_approve(actor text, request_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_privacy_erasure_approve$
DECLARE
  asked slotlock.privacy_requests%ROWTYPE;
BEGIN
  actor := slotlock.staff_session(actor, 'privacy.erase', false);
  SELECT * INTO asked FROM slotlock.privacy_requests waiting WHERE waiting.id = request_id FOR UPDATE;
  IF NOT FOUND OR asked.status <> 'open' THEN
    RETURN 'closed';
  END IF;
  IF asked.erasure_asked_at IS NULL THEN
    RETURN 'not_asked';
  END IF;
  IF asked.erasure_approved_at IS NOT NULL THEN
    RETURN 'approved_already';
  END IF;
  IF asked.erasure_asked_by = actor THEN
    PERFORM slotlock.staff_log(actor, 'privacy.erasure_approval_refused', asked.account_ref, 'privacy:' || asked.id,
      'the Owner who asked cannot approve', '{}'::jsonb);
    RETURN 'own';
  END IF;
  IF EXISTS (SELECT 1 FROM slotlock.tenant_plans held
              WHERE held.tenant_ref = asked.account_ref AND held.stripe_subscription IS NOT NULL) THEN
    PERFORM slotlock.staff_log(actor, 'privacy.erasure_refused', asked.account_ref, 'privacy:' || asked.id,
      'the Stripe subscription is live', '{}'::jsonb);
    RETURN 'subscription_live';
  END IF;
  UPDATE slotlock.privacy_requests waiting
     SET erasure_approved_by = actor, erasure_approved_at = statement_timestamp()
   WHERE waiting.id = asked.id;
  PERFORM slotlock.staff_log(actor, 'privacy.erasure_approved', asked.account_ref, 'privacy:' || asked.id, NULL,
    jsonb_build_object('asked_by', asked.erasure_asked_by));
  RETURN 'approved';
END
$slotlock_admin_privacy_erasure_approve$;

-- Erase the account an approved erasure request is about (privacy.erase), in the order that cannot
-- change: no live Stripe subscription, a second Owner's approval, then everything the account
-- keeps (slotlock.erase_tenant, with its test environment), its internal notes, its link from abuse
-- cases, what the console cached about it, and its reference on every privacy request, all in one
-- transaction with the receipt. 'erased', 'subscription_live', 'not_approved', 'not_verified',
-- 'not_erasure' or 'closed'.
CREATE OR REPLACE FUNCTION slotlock.admin_privacy_erase(actor text, request_id bigint)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_privacy_erase$
DECLARE
  asked slotlock.privacy_requests%ROWTYPE;
  customer text;
  gone bigint := 0;
BEGIN
  actor := slotlock.staff_session(actor, 'privacy.erase', false);
  SELECT * INTO asked FROM slotlock.privacy_requests waiting WHERE waiting.id = request_id FOR UPDATE;
  IF NOT FOUND OR asked.status <> 'open' THEN
    RETURN 'closed';
  END IF;
  IF asked.concerns <> 'account' OR asked.kind <> 'erasure' THEN
    RETURN 'not_erasure';
  END IF;
  IF asked.verified_at IS NULL THEN
    RETURN 'not_verified';
  END IF;
  IF asked.erasure_approved_at IS NULL THEN
    RETURN 'not_approved';
  END IF;
  -- 1. Stripe first, checked again: the subscription is cancelled in Stripe, whose webhook takes it
  -- off the plan, before anything goes (erase_tenant refuses an account that still has one).
  IF EXISTS (SELECT 1 FROM slotlock.tenant_plans held
              WHERE held.tenant_ref IN (asked.account_ref, asked.account_ref || '~test')
                AND held.stripe_subscription IS NOT NULL) THEN
    PERFORM slotlock.staff_log(actor, 'privacy.erasure_refused', asked.account_ref, 'privacy:' || asked.id,
      'the Stripe subscription is live', '{}'::jsonb);
    RETURN 'subscription_live';
  END IF;
  SELECT held.stripe_customer INTO customer FROM slotlock.tenant_plans held WHERE held.tenant_ref = asked.account_ref;
  -- 3. Erase: the account, and its test environment when it has one.
  SELECT gone + coalesce(sum(erased.erased_rows), 0) INTO gone FROM slotlock.erase_tenant(asked.account_ref) erased;
  IF asked.account_ref !~ '~test$' AND octet_length(asked.account_ref) <= 495 THEN
    SELECT gone + coalesce(sum(erased.erased_rows), 0) INTO gone
      FROM slotlock.erase_tenant(asked.account_ref || '~test') erased;
  END IF;
  DELETE FROM slotlock.account_notes note WHERE note.account_ref IN (asked.account_ref, asked.account_ref || '~test');
  UPDATE slotlock.abuse_cases linked SET account_ref = NULL, updated_at = statement_timestamp()
   WHERE linked.account_ref IN (asked.account_ref, asked.account_ref || '~test');
  DELETE FROM slotlock.admin_cache kept
   WHERE customer IS NOT NULL AND kept.key = 'account:stripe:' || customer;
  -- 4. The receipt, and the account's reference out of every privacy request.
  INSERT INTO slotlock.privacy_erasure_receipts (request_id, account_digest, rows_erased, asked_by, approved_by, erased_by)
  VALUES (asked.id, asked.account_digest, gone, asked.erasure_asked_by, asked.erasure_approved_by, actor);
  UPDATE slotlock.privacy_requests other
     SET account_ref = NULL,
         status = CASE WHEN other.status = 'open' THEN 'done' ELSE other.status END,
         outcome = CASE WHEN other.id = asked.id THEN 'Erased' ELSE coalesce(other.outcome, 'The account was erased') END,
         closed_by = coalesce(other.closed_by, actor),
         closed_at = coalesce(other.closed_at, statement_timestamp())
   WHERE other.account_ref = asked.account_ref;
  PERFORM slotlock.staff_log(actor, 'privacy.erased', asked.account_ref, 'privacy:' || asked.id, NULL,
    jsonb_build_object('rows', gone, 'asked_by', asked.erasure_asked_by, 'approved_by', asked.erasure_approved_by));
  RETURN 'erased';
END
$slotlock_admin_privacy_erase$;

-- Close a request (privacy.act) as done, refused, withdrawn, or passed on to the account holder (one
-- about their customer), with what was done in words. An erasure request is done only by erasing.
-- False when it was closed already.
CREATE OR REPLACE FUNCTION slotlock.admin_privacy_close(actor text, request_id bigint, new_status text, why text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_privacy_close$
DECLARE
  asked slotlock.privacy_requests%ROWTYPE;
BEGIN
  actor := slotlock.staff_session(actor, 'privacy.act', false);
  SELECT * INTO asked FROM slotlock.privacy_requests waiting WHERE waiting.id = request_id FOR UPDATE;
  IF NOT FOUND OR asked.status <> 'open' THEN
    RETURN false;
  END IF;
  IF new_status IS NULL OR new_status NOT IN (${privacyOutcomes})
     OR (new_status = 'done' AND asked.concerns = 'account' AND asked.kind = 'erasure')
     OR (new_status = 'passed_on' AND asked.concerns <> 'customer') THEN
    RAISE EXCEPTION 'privacy_close_invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE slotlock.privacy_requests waiting
     SET status = new_status, outcome = why, closed_by = actor, closed_at = statement_timestamp()
   WHERE waiting.id = asked.id;
  PERFORM slotlock.staff_log(actor, 'privacy.closed', asked.account_ref, 'privacy:' || asked.id, why,
    jsonb_build_object('status', new_status));
  RETURN true;
EXCEPTION WHEN check_violation THEN
  RAISE EXCEPTION 'privacy_close_invalid' USING ERRCODE = '22023';
END
$slotlock_admin_privacy_close$;

-- Whether an account was erased (privacy.act): the receipts whose digest is the given reference's,
-- for when someone asks. The reference itself is not recorded.
CREATE OR REPLACE FUNCTION slotlock.admin_privacy_receipts(actor text, account text)
RETURNS TABLE (request_id bigint, erased_at timestamptz, rows_erased bigint, asked_by text, approved_by text, erased_by text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_privacy_receipts$
BEGIN
  actor := slotlock.staff_session(actor, 'privacy.act', false);
  IF account IS NULL OR octet_length(account) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'admin_account_unknown' USING ERRCODE = '22023';
  END IF;
  PERFORM slotlock.staff_log(actor, 'privacy.receipts_checked', NULL, NULL, NULL, '{}'::jsonb);
  RETURN QUERY
  SELECT kept.request_id, kept.erased_at, kept.rows_erased, kept.asked_by, kept.approved_by, kept.erased_by
    FROM slotlock.privacy_erasure_receipts kept
   WHERE kept.account_digest = slotlock.privacy_digest(account)
   ORDER BY kept.erased_at DESC;
END
$slotlock_admin_privacy_receipts$;
`;

const announcementKinds = SLOTLOCK_ANNOUNCEMENT_KINDS.map((value) => `'${value}'`).join(', ');
const announcementAudiences = SLOTLOCK_ANNOUNCEMENT_AUDIENCES.map((value) => `'${value}'`).join(', ');
const staffPlans = SLOTLOCK_STAFF_PLANS.map((value) => `'${value}'`).join(', ');
const featureFlags = SLOTLOCK_FEATURE_FLAGS.map((value) => `'${value}'`).join(', ');
const statusSteps = SLOTLOCK_STATUS_STEPS.map((value) => `'${value}'`).join(', ');
/** One line of text a customer reads: no control characters. */
const oneLine = (column: string, max: number) => `char_length(${column}) BETWEEN 1 AND ${max} AND ${column} !~ '[[:cntrl:]]'`;
/** An account a staff record names: a live account, never its test environment. */
const liveAccount = (column: string) =>
  `(${column} IS NULL OR (octet_length(${column}) BETWEEN 1 AND 500 AND ${column} !~ '[[:cntrl:]]' AND ${column} !~ '~test$'))`;

/**
 * Phase 6 (RFC 0006, M10 and M11): what a dashboard shows besides the account's own data
 * (announcements and service notices), the features staff turn on or off per plan or account, and
 * maintenance's record of its passes and failures. The serving role writes the last and reads the
 * first two (SLOTLOCK_STAFF_SERVING_FUNCTIONS); the console reads all three.
 */
const STAFF_SYSTEM_DDL = `
-- Announcements (M10): a line above every page of the dashboard while it runs, for planned
-- maintenance, a change to the API, an incident or a notice. To every account, the accounts on a
-- plan, or one account (a service notice, which its audit log records too). An account's test
-- environment sees what its live account does. Ended or over ones go a year on.
CREATE TABLE IF NOT EXISTS slotlock.announcements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audience text NOT NULL,
  plan text,
  tenant_ref text,
  kind text NOT NULL,
  message text NOT NULL,
  link text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ended_by text,
  ended_at timestamptz,
  CONSTRAINT slotlock_announcements_valid CHECK (
    audience IN (${announcementAudiences})
    AND (plan IS NOT NULL) = (audience = 'plan')
    AND (plan IS NULL OR plan IN (${staffPlans}))
    AND (tenant_ref IS NOT NULL) = (audience = 'account')
    AND ${liveAccount('tenant_ref')}
    AND kind IN (${announcementKinds})
    AND ${oneLine('message', SLOTLOCK_ANNOUNCEMENT_MAX)}
    AND (link IS NULL OR (octet_length(link) BETWEEN 9 AND 300 AND link ~ '^https://[^[:space:][:cntrl:]"''<>]+$'))
    AND ends_at > starts_at AND ends_at <= starts_at + interval '${SLOTLOCK_ANNOUNCEMENT_MAX_DAYS} days'
    AND created_by ~ '${STAFF_ACTOR_PATTERN}'
    AND (ended_by IS NULL) = (ended_at IS NULL)
    AND (ended_by IS NULL OR ended_by ~ '${STAFF_ACTOR_PATTERN}')
  )
);
CREATE INDEX IF NOT EXISTS slotlock_announcements_running_idx
  ON slotlock.announcements (ends_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS slotlock_announcements_account_idx
  ON slotlock.announcements (tenant_ref) WHERE tenant_ref IS NOT NULL;
ALTER TABLE slotlock.announcements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.announcements FROM PUBLIC;

-- Feature flags (M11): a feature turned on or off for a plan or one account, with why and by whom.
-- Its history is the staff log's flag events. Nothing here turns on a feature the deployment has
-- not configured.
CREATE TABLE IF NOT EXISTS slotlock.feature_flags (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flag text NOT NULL,
  plan text,
  tenant_ref text,
  enabled boolean NOT NULL,
  reason text NOT NULL,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_feature_flags_valid CHECK (
    flag IN (${featureFlags})
    AND (plan IS NULL) <> (tenant_ref IS NULL)
    AND (plan IS NULL OR plan IN (${staffPlans}))
    AND ${liveAccount('tenant_ref')}
    AND octet_length(reason) BETWEEN 1 AND 200 AND reason !~ '[[:cntrl:]]'
    AND set_by ~ '${STAFF_ACTOR_PATTERN}'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_feature_flags_plan_key
  ON slotlock.feature_flags (flag, plan) WHERE plan IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS slotlock_feature_flags_account_key
  ON slotlock.feature_flags (flag, tenant_ref) WHERE tenant_ref IS NOT NULL;
ALTER TABLE slotlock.feature_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.feature_flags FROM PUBLIC;
-- A flag's history, newest first, without reading the whole staff log.
CREATE INDEX IF NOT EXISTS slotlock_staff_audit_events_flag_idx
  ON slotlock.staff_audit_events (chain_index) WHERE action IN ('flag.set', 'flag.cleared');

-- Accounts whose maintenance pass is failing (M11): one row each, with how many times and the last
-- error's class, code and message (cut to 200 characters, and at its first quotation mark by the
-- server). Cleared when a pass for the account runs again; kept ${SLOTLOCK_MAINTENANCE_FAILURE_DAYS} days after the last
-- failure otherwise.
CREATE TABLE IF NOT EXISTS slotlock.maintenance_failures (
  tenant_ref text PRIMARY KEY,
  first_failed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_failed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  failures integer NOT NULL DEFAULT 1,
  error text NOT NULL,
  code text,
  message text,
  CONSTRAINT slotlock_maintenance_failures_valid CHECK (
    octet_length(tenant_ref) BETWEEN 1 AND 500
    AND error ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
    AND (code IS NULL OR code ~ '^[A-Za-z0-9_.-]{1,64}$')
    AND (message IS NULL OR ${oneLine('message', 200)})
    AND failures >= 1 AND last_failed_at >= first_failed_at
  )
);
CREATE INDEX IF NOT EXISTS slotlock_maintenance_failures_recent_idx
  ON slotlock.maintenance_failures (last_failed_at DESC);
ALTER TABLE slotlock.maintenance_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.maintenance_failures FROM PUBLIC;

-- What a tenant's dashboard shows besides its own data: the announcements running now for every
-- account, its plan or the account (newest first, at most ${SLOTLOCK_ANNOUNCEMENTS_SHOWN}), and the features staff turned
-- on or off for its plan or the account, the account's setting first. A test environment reads
-- its live account's. Never who wrote them, or why. The serving role's.
CREATE OR REPLACE FUNCTION slotlock.tenant_dashboard_notices(requested_tenant_ref text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_tenant_dashboard_notices$
DECLARE
  live text := regexp_replace(requested_tenant_ref, '~test$', '');
  current_plan text;
BEGIN
  SELECT given.plan INTO current_plan FROM slotlock.tenant_plan(requested_tenant_ref) given LIMIT 1;
  RETURN jsonb_build_object(
    'announcements', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', shown.id, 'kind', shown.kind, 'message', shown.message,
                                                   'link', shown.link, 'starts_at', shown.starts_at,
                                                   'ends_at', shown.ends_at)
                                ORDER BY shown.starts_at DESC, shown.id DESC), '[]'::jsonb)
        FROM (SELECT running.* FROM slotlock.announcements running
               WHERE running.ended_at IS NULL
                 AND running.starts_at <= statement_timestamp() AND running.ends_at > statement_timestamp()
                 AND (running.audience = 'everyone'
                      OR (running.audience = 'plan' AND running.plan = current_plan)
                      OR (running.audience = 'account' AND running.tenant_ref = live))
               ORDER BY running.starts_at DESC, running.id DESC
               LIMIT ${SLOTLOCK_ANNOUNCEMENTS_SHOWN}) shown),
    'features', (
      SELECT coalesce(jsonb_object_agg(chosen.flag, chosen.enabled), '{}'::jsonb)
        FROM (SELECT DISTINCT ON (given.flag) given.flag, given.enabled FROM slotlock.feature_flags given
               WHERE given.tenant_ref = live OR given.plan = current_plan
               ORDER BY given.flag, (given.tenant_ref IS NOT NULL) DESC) chosen)
  );
END
$slotlock_tenant_dashboard_notices$;

-- A tenant's maintenance pass that failed (serve's scheduler): its failures counted, with the last
-- error. Failures not seen for ${SLOTLOCK_MAINTENANCE_FAILURE_DAYS} days go. The serving role's.
CREATE OR REPLACE FUNCTION slotlock.note_maintenance_failure(requested_tenant_ref text, error_name text, error_code text, error_message text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_note_maintenance_failure$
BEGIN
  INSERT INTO slotlock.maintenance_failures AS kept (tenant_ref, error, code, message)
  VALUES (requested_tenant_ref, error_name, error_code, error_message)
  ON CONFLICT (tenant_ref) DO UPDATE
     SET last_failed_at = statement_timestamp(), failures = least(kept.failures, 1000000) + 1,
         error = EXCLUDED.error, code = EXCLUDED.code, message = EXCLUDED.message;
  DELETE FROM slotlock.maintenance_failures old
   WHERE old.last_failed_at < statement_timestamp() - interval '${SLOTLOCK_MAINTENANCE_FAILURE_DAYS} days';
END
$slotlock_note_maintenance_failure$;

-- A tenant whose pass ran after failing: its failure is cleared. The serving role's.
CREATE OR REPLACE FUNCTION slotlock.note_maintenance_recovered(requested_tenant_ref text)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_note_maintenance_recovered$
  DELETE FROM slotlock.maintenance_failures failed WHERE failed.tenant_ref = requested_tenant_ref;
$slotlock_note_maintenance_recovered$;

-- An hour of one server's maintenance (serve's scheduler): its passes and failures counted, and
-- what they did, as maintenance_runs job 'maintenance'. Never a tenant. The serving role's.
CREATE OR REPLACE FUNCTION slotlock.note_maintenance_round(began timestamptz, needs_attention boolean, round_summary jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_note_maintenance_round$
BEGIN
  INSERT INTO slotlock.maintenance_runs (job, actor, started_at, attention, summary)
  VALUES ('maintenance', 'serve', least(coalesce(began, statement_timestamp()), statement_timestamp()),
          coalesce(needs_attention, false), coalesce(round_summary, '{}'::jsonb));
  DELETE FROM slotlock.maintenance_runs old
   WHERE old.job = 'maintenance'
     AND old.id < (SELECT kept.id FROM slotlock.maintenance_runs kept WHERE kept.job = 'maintenance'
                    ORDER BY kept.id DESC OFFSET 399 LIMIT 1);
END
$slotlock_note_maintenance_round$;

-- Announcements (system.read), soonest to end first: those running or to come, and with ended_too
-- the last 100 that ended or ran out too, each with its state.
CREATE OR REPLACE FUNCTION slotlock.admin_announcements(actor text, ended_too boolean)
RETURNS TABLE (id bigint, audience text, plan text, account_ref text, kind text, message text, link text,
               starts_at timestamptz, ends_at timestamptz, created_by text, created_at timestamptz,
               ended_by text, ended_at timestamptz, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_announcements$
#variable_conflict use_column
BEGIN
  actor := slotlock.staff_session(actor, 'system.read', false);
  PERFORM slotlock.staff_log(actor, 'announcement.list_viewed', NULL, NULL, NULL,
    jsonb_build_object('ended', coalesce(ended_too, false)));
  RETURN QUERY
  SELECT listed.id, listed.audience, listed.plan, listed.tenant_ref, listed.kind, listed.message, listed.link,
         listed.starts_at, listed.ends_at, listed.created_by, listed.created_at, listed.ended_by, listed.ended_at,
         CASE WHEN listed.ended_at IS NOT NULL THEN 'ended'
              WHEN listed.ends_at <= statement_timestamp() THEN 'over'
              WHEN listed.starts_at > statement_timestamp() THEN 'scheduled'
              ELSE 'live' END
    FROM slotlock.announcements listed
   WHERE coalesce(ended_too, false) OR (listed.ended_at IS NULL AND listed.ends_at > statement_timestamp())
   ORDER BY (listed.ended_at IS NULL AND listed.ends_at > statement_timestamp()) DESC,
            CASE WHEN listed.ended_at IS NULL AND listed.ends_at > statement_timestamp() THEN listed.starts_at END,
            coalesce(listed.ended_at, listed.ends_at) DESC, listed.id DESC
   LIMIT ${SLOTLOCK_ADMIN_PAGE_LIMIT};
END
$slotlock_admin_announcements$;

-- Write an announcement (system.act): to every account, a plan's accounts or one account (a
-- service notice, which the account's audit log records as sent by Slotlock staff). It runs from
-- starts (now when NULL) until ends, at most ${SLOTLOCK_ANNOUNCEMENT_MAX_DAYS} days, and must not be over already. Its id.
CREATE OR REPLACE FUNCTION slotlock.admin_announce(actor text, wanted_audience text, wanted_plan text, account text,
  wanted_kind text, words text, url text, starts timestamptz, ends timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_announce$
DECLARE
  begins timestamptz := coalesce(starts, statement_timestamp());
  added bigint;
BEGIN
  actor := slotlock.staff_session(actor, 'system.act', false);
  IF wanted_audience = 'account' THEN
    PERFORM slotlock.staff_account_known(account);
  END IF;
  IF ends IS NULL OR ends <= statement_timestamp() THEN
    RAISE EXCEPTION 'admin_announcement_over' USING ERRCODE = '22023';
  END IF;
  BEGIN
    INSERT INTO slotlock.announcements (audience, plan, tenant_ref, kind, message, link, starts_at, ends_at, created_by)
    VALUES (wanted_audience, wanted_plan, account, wanted_kind, btrim(words), nullif(btrim(url), ''), begins, ends, actor)
    RETURNING announcements.id INTO added;
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    RAISE EXCEPTION 'admin_announcement_invalid' USING ERRCODE = '22023';
  END;
  PERFORM slotlock.staff_log(actor, 'announcement.created', account, 'announcement:' || added, NULL,
    jsonb_strip_nulls(jsonb_build_object('audience', wanted_audience, 'plan', wanted_plan, 'kind', wanted_kind,
                                         'starts_at', begins, 'ends_at', ends)));
  IF account IS NOT NULL THEN
    PERFORM slotlock.staff_customer_audit(actor, account, 'staff.notice_sent', 'announcement', added::text, NULL);
  END IF;
  RETURN added;
END
$slotlock_admin_announce$;

-- End an announcement early (system.act): it leaves every dashboard at once. False when it had
-- ended or run out already.
CREATE OR REPLACE FUNCTION slotlock.admin_announcement_end(actor text, announcement_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_announcement_end$
DECLARE
  account text;
BEGIN
  actor := slotlock.staff_session(actor, 'system.act', false);
  UPDATE slotlock.announcements running
     SET ended_at = statement_timestamp(), ended_by = actor
   WHERE running.id = announcement_id AND running.ended_at IS NULL AND running.ends_at > statement_timestamp()
  RETURNING running.tenant_ref INTO account;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM slotlock.staff_log(actor, 'announcement.ended', account, 'announcement:' || announcement_id, NULL, '{}'::jsonb);
  RETURN true;
END
$slotlock_admin_announcement_end$;

-- Feature flags (system.read): each plan's and account's setting, and the last 50 changes from the
-- staff log.
CREATE OR REPLACE FUNCTION slotlock.admin_flags(actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_flags$
DECLARE
  result jsonb;
BEGIN
  actor := slotlock.staff_session(actor, 'system.read', false);
  SELECT jsonb_build_object(
    'flags', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'id', given.id, 'flag', given.flag, 'plan', given.plan, 'account_ref', given.tenant_ref,
                'enabled', given.enabled, 'reason', given.reason, 'set_by', given.set_by, 'set_at', given.set_at)
                ORDER BY given.flag, given.plan NULLS LAST, given.tenant_ref), '[]'::jsonb)
                FROM slotlock.feature_flags given),
    'history', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'occurred_at', changed.occurred_at, 'staff_ref', changed.staff_ref, 'action', changed.action,
                  'account_ref', changed.account_ref, 'reason', changed.reason, 'metadata', changed.metadata)
                  ORDER BY changed.chain_index DESC), '[]'::jsonb)
                  FROM (SELECT logged.* FROM slotlock.staff_audit_events logged
                         WHERE logged.action IN ('flag.set', 'flag.cleared')
                         ORDER BY logged.chain_index DESC LIMIT 50) changed)
  ) INTO result;
  PERFORM slotlock.staff_log(actor, 'flag.list_viewed', NULL, NULL, NULL, '{}'::jsonb);
  RETURN result;
END
$slotlock_admin_flags$;

-- Turn a feature on or off for a plan or for one account (system.act), with a reason: an account's
-- change is in its own audit log too (E8). Where the deployment has not configured the feature,
-- this turns nothing on. The flag's id.
CREATE OR REPLACE FUNCTION slotlock.admin_flag_set(actor text, wanted_flag text, wanted_plan text, account text, turned_on boolean, why text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_flag_set$
DECLARE
  before boolean;
  kept bigint;
BEGIN
  actor := slotlock.staff_session(actor, 'system.act', false);
  PERFORM slotlock.staff_reason_valid(why);
  IF wanted_flag IS NULL OR wanted_flag NOT IN (${featureFlags}) THEN
    RAISE EXCEPTION 'admin_flag_unknown' USING ERRCODE = '22023';
  END IF;
  IF (wanted_plan IS NULL) = (account IS NULL) OR turned_on IS NULL
     OR (wanted_plan IS NOT NULL AND wanted_plan NOT IN (${staffPlans})) THEN
    RAISE EXCEPTION 'admin_flag_scope' USING ERRCODE = '22023';
  END IF;
  IF account IS NOT NULL THEN
    PERFORM slotlock.staff_account_known(account);
    IF account ~ '~test$' THEN
      RAISE EXCEPTION 'admin_flag_scope' USING ERRCODE = '22023';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('slotlock:feature-flag:' || wanted_flag, 0));
  SELECT given.id, given.enabled INTO kept, before FROM slotlock.feature_flags given
   WHERE given.flag = wanted_flag AND (given.plan = wanted_plan OR given.tenant_ref = account);
  IF kept IS NULL THEN
    INSERT INTO slotlock.feature_flags (flag, plan, tenant_ref, enabled, reason, set_by)
    VALUES (wanted_flag, wanted_plan, account, turned_on, why, actor)
    RETURNING feature_flags.id INTO kept;
  ELSE
    UPDATE slotlock.feature_flags given
       SET enabled = turned_on, reason = why, set_by = actor, set_at = statement_timestamp()
     WHERE given.id = kept;
  END IF;
  PERFORM slotlock.staff_log(actor, 'flag.set', account, 'flag:' || wanted_flag, why,
    jsonb_build_object('flag', wanted_flag, 'plan', wanted_plan, 'from', before, 'to', turned_on));
  IF account IS NOT NULL THEN
    PERFORM slotlock.staff_customer_audit(actor, account, 'staff.feature_changed', 'feature', wanted_flag, why);
  END IF;
  RETURN kept;
END
$slotlock_admin_flag_set$;

-- Take a flag away (system.act), with a reason: the plan's setting, or the deployment's, decides
-- again. False when there was no such flag.
CREATE OR REPLACE FUNCTION slotlock.admin_flag_clear(actor text, flag_id bigint, why text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_flag_clear$
DECLARE
  gone slotlock.feature_flags;
BEGIN
  actor := slotlock.staff_session(actor, 'system.act', false);
  PERFORM slotlock.staff_reason_valid(why);
  DELETE FROM slotlock.feature_flags given WHERE given.id = flag_id RETURNING given.* INTO gone;
  IF gone.id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM slotlock.staff_log(actor, 'flag.cleared', gone.tenant_ref, 'flag:' || gone.flag, why,
    jsonb_build_object('flag', gone.flag, 'plan', gone.plan, 'from', gone.enabled, 'to', NULL));
  IF gone.tenant_ref IS NOT NULL THEN
    PERFORM slotlock.staff_customer_audit(actor, gone.tenant_ref, 'staff.feature_changed', 'feature', gone.flag, why);
  END IF;
  RETURN true;
END
$slotlock_admin_flag_clear$;

-- The System page (system.read): the last day of each server's maintenance hours, the accounts
-- whose pass is failing (the error's class, code and message, never their data), the last run of
-- each billing job, and webhook endpoints failing or turned off across up to ${SLOTLOCK_WEBHOOK_HEALTH_ACCOUNTS} accounts
-- with webhooks, as counts. Endpoints are counted under each account's own row security, then the
-- setting is put back.
CREATE OR REPLACE FUNCTION slotlock.admin_system(actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_system$
DECLARE
  previous text := current_setting('slotlock.tenant_ref', true);
  account text;
  checked integer := 0;
  active_count bigint;
  failing_count bigint;
  disabled_count bigint;
  failing_from timestamptz;
  endpoints bigint := 0;
  failing bigint := 0;
  disabled bigint := 0;
  failing_accounts integer := 0;
  oldest timestamptz;
  result jsonb;
BEGIN
  actor := slotlock.staff_session(actor, 'system.read', false);
  FOR account IN SELECT hooked.tenant_ref FROM slotlock.webhook_tenants hooked
                  ORDER BY hooked.tenant_ref LIMIT ${SLOTLOCK_WEBHOOK_HEALTH_ACCOUNTS} LOOP
    PERFORM set_config('slotlock.tenant_ref', account, true);
    SELECT count(*) FILTER (WHERE hook.disabled_at IS NULL),
           count(*) FILTER (WHERE hook.disabled_at IS NULL AND hook.failing_since IS NOT NULL),
           count(*) FILTER (WHERE hook.disabled_at IS NOT NULL),
           min(hook.failing_since) FILTER (WHERE hook.disabled_at IS NULL)
      INTO active_count, failing_count, disabled_count, failing_from
      FROM slotlock.webhook_endpoints hook WHERE hook.tenant_ref = account;
    endpoints := endpoints + active_count;
    failing := failing + failing_count;
    disabled := disabled + disabled_count;
    IF failing_count > 0 THEN
      failing_accounts := failing_accounts + 1;
      oldest := least(oldest, failing_from);
    END IF;
    checked := checked + 1;
  END LOOP;
  PERFORM set_config('slotlock.tenant_ref', coalesce(previous, ''), true);
  SELECT jsonb_build_object(
    'webhooks', jsonb_build_object('accounts', checked, 'capped', checked >= ${SLOTLOCK_WEBHOOK_HEALTH_ACCOUNTS},
                                   'endpoints', endpoints, 'failing', failing, 'failing_accounts', failing_accounts,
                                   'failing_since', oldest, 'disabled', disabled),
    'rounds', (SELECT coalesce(jsonb_agg(jsonb_build_object('started_at', run.started_at, 'finished_at', run.finished_at,
                                                            'attention', run.attention, 'summary', run.summary)
                                         ORDER BY run.id DESC), '[]'::jsonb)
                 FROM (SELECT kept.* FROM slotlock.maintenance_runs kept WHERE kept.job = 'maintenance'
                        ORDER BY kept.id DESC LIMIT 24) run),
    'failing', (SELECT coalesce(jsonb_agg(jsonb_build_object('account_ref', failed.tenant_ref,
                                                             'first_failed_at', failed.first_failed_at,
                                                             'last_failed_at', failed.last_failed_at,
                                                             'failures', failed.failures, 'error', failed.error,
                                                             'code', failed.code, 'message', failed.message)
                                          ORDER BY failed.last_failed_at DESC), '[]'::jsonb)
                  FROM (SELECT kept.* FROM slotlock.maintenance_failures kept
                         ORDER BY kept.last_failed_at DESC LIMIT ${SLOTLOCK_ADMIN_PAGE_LIMIT}) failed),
    'failing_total', (SELECT count(*) FROM slotlock.maintenance_failures),
    'jobs', (SELECT coalesce(jsonb_object_agg(last.job, jsonb_build_object('finished_at', last.finished_at,
                                                                           'attention', last.attention)), '{}'::jsonb)
               FROM (SELECT DISTINCT ON (run.job) run.job, run.finished_at, run.attention
                       FROM slotlock.maintenance_runs run ORDER BY run.job, run.id DESC) last)
  ) INTO result;
  PERFORM slotlock.staff_log(actor, 'system.viewed', NULL, NULL, NULL, '{}'::jsonb);
  RETURN result;
END
$slotlock_admin_system$;

-- A step on the status page (system.act), recorded before the console asks GitHub for it: opening
-- an incident (its issue not yet numbered), adding an update to one, or closing it.
CREATE OR REPLACE FUNCTION slotlock.admin_status_record(actor text, happened text, issue integer, extra jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_status_record$
BEGIN
  actor := slotlock.staff_session(actor, 'system.act', false);
  IF happened IS NULL OR happened NOT IN (${statusSteps})
     OR (issue IS NULL) <> (happened = 'status.opened') OR issue < 1
     OR (extra IS NOT NULL AND (jsonb_typeof(extra) <> 'object' OR pg_column_size(extra) > 4096)) THEN
    RAISE EXCEPTION 'admin_status_step' USING ERRCODE = '22023';
  END IF;
  PERFORM slotlock.staff_log(actor, happened, NULL, CASE WHEN issue IS NULL THEN NULL ELSE 'issue:' || issue END,
    NULL, extra);
END
$slotlock_admin_status_record$;
`;

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
-- The member's GitHub login, as GitHub gave it at their last sign-in to the console: the console
-- names staff by it without asking GitHub. Null until they sign in.
ALTER TABLE slotlock.staff_members ADD COLUMN IF NOT EXISTS login text;
DO $slotlock_staff_members_login$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'slotlock.staff_members'::regclass AND conname = 'slotlock_staff_members_login_valid'
  ) THEN
    -- NOT VALID: the column is new, and DEPLOYMENT_VALIDATE_CONSTRAINTS validates it after.
    ALTER TABLE slotlock.staff_members ADD CONSTRAINT slotlock_staff_members_login_valid
      CHECK (login IS NULL OR login ~ '${SLOTLOCK_STAFF_LOGIN_PATTERN}') NOT VALID;
  END IF;
END
$slotlock_staff_members_login$;
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

-- The console's key (RFC 0006, 4.4): a digest of a secret the console holds and the console's
-- database role cannot read, set by the deployment role (slotlock staff console-key). A staff
-- session opens only for a caller that shows the key, so the console's database credential alone
-- acts as no one.
CREATE TABLE IF NOT EXISTS slotlock.staff_console_keys (
  id smallint PRIMARY KEY DEFAULT 1,
  key_digest bytea NOT NULL,
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT slotlock_staff_console_keys_valid CHECK (
    id = 1 AND octet_length(key_digest) = 32 AND set_by ~ '${STAFF_ACTOR_PATTERN}'
  )
);
ALTER TABLE slotlock.staff_console_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.staff_console_keys FROM PUBLIC;

-- Staff sessions: opened by the console's key once GitHub named a member ('github', 15 minutes),
-- raised by a passkey ('full', 8 hours from then), and ended by signing out, by the member's
-- reset, removal or role change, after ${SLOTLOCK_STAFF_IDLE_MINUTES} idle minutes, or at their end. Every admin function
-- takes a session's token, never a member's reference: the database, not the caller, says who
-- acts. The token is kept only as its SHA-256. A passkey challenge waits on its session for five
-- minutes and is used once.
CREATE TABLE IF NOT EXISTS slotlock.staff_sessions (
  token_digest bytea PRIMARY KEY,
  staff_ref text NOT NULL REFERENCES slotlock.staff_members (staff_ref) ON DELETE CASCADE,
  stage text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  passkey_at timestamptz,
  ended_at timestamptz,
  challenge_digest bytea,
  challenge_purpose text,
  challenge_expires_at timestamptz,
  CONSTRAINT slotlock_staff_sessions_valid CHECK (
    octet_length(token_digest) = 32
    AND stage IN ('github', 'full')
    AND (stage = 'full') = (passkey_at IS NOT NULL)
    AND expires_at > created_at
    AND (challenge_digest IS NULL) = (challenge_purpose IS NULL)
    AND (challenge_digest IS NULL) = (challenge_expires_at IS NULL)
    AND (challenge_digest IS NULL OR octet_length(challenge_digest) = 32)
    AND (challenge_purpose IS NULL OR challenge_purpose IN ('create', 'get'))
  )
);
CREATE INDEX IF NOT EXISTS slotlock_staff_sessions_staff_idx ON slotlock.staff_sessions (staff_ref) WHERE ended_at IS NULL;
ALTER TABLE slotlock.staff_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON slotlock.staff_sessions FROM PUBLIC;

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
  -- Only an event past its ${SLOTLOCK_STAFF_RECORD_YEARS} years goes (staff_records_prune); nothing is ever changed,
  -- and the log is never emptied at once (TRUNCATE skips the row triggers, so it has its own).
  IF TG_OP = 'DELETE' AND OLD.occurred_at < statement_timestamp() - interval '${SLOTLOCK_STAFF_RECORD_YEARS} years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'the staff audit log only grows' USING ERRCODE = '42501';
END
$slotlock_refuse_staff_audit_change$;
DROP TRIGGER IF EXISTS slotlock_staff_audit_events_frozen ON slotlock.staff_audit_events;
CREATE TRIGGER slotlock_staff_audit_events_frozen BEFORE UPDATE OR DELETE ON slotlock.staff_audit_events
  FOR EACH ROW EXECUTE FUNCTION slotlock.refuse_staff_audit_change();
DROP TRIGGER IF EXISTS slotlock_staff_audit_events_not_emptied ON slotlock.staff_audit_events;
CREATE TRIGGER slotlock_staff_audit_events_not_emptied BEFORE TRUNCATE ON slotlock.staff_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION slotlock.refuse_staff_audit_change();

-- The chain, checked from the oldest of the newest events kept (all of them with NULL): each event
-- follows the one before and hashes what it says. The schema owner can still turn the triggers off
-- and rewrite the log, so the head (its index and hash) is worth recording somewhere the owner
-- cannot change: the Staff log page and \`slotlock staff verify-log\` show it. broken_at is the first
-- event that does not hold, NULL when all do.
CREATE OR REPLACE FUNCTION slotlock.staff_audit_chain_check(newest integer)
RETURNS TABLE (checked bigint, broken_at bigint, head_index bigint, head_hash bytea)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_audit_chain_check$
DECLARE
  event slotlock.staff_audit_events;
  started boolean := false;
BEGIN
  checked := 0;
  FOR event IN
    SELECT recent.* FROM (SELECT kept.* FROM slotlock.staff_audit_events kept
                           ORDER BY kept.chain_index DESC LIMIT coalesce(newest, 2147483647)) recent
     ORDER BY recent.chain_index
  LOOP
    IF (started AND (event.chain_index <> head_index + 1 OR event.prev_hash IS DISTINCT FROM head_hash))
       OR event.hash <> sha256(coalesce(event.prev_hash, ''::bytea) || convert_to(slotlock.staff_audit_event_text(event), 'UTF8')) THEN
      broken_at := event.chain_index;
      EXIT;
    END IF;
    started := true;
    checked := checked + 1;
    head_index := event.chain_index;
    head_hash := event.hash;
  END LOOP;
  RETURN NEXT;
END
$slotlock_staff_audit_chain_check$;

-- What the staff keep past their time goes, a little at a time, as staff use the console: events in
-- the staff log, closed abuse cases, and closed privacy requests with their erasure receipts, each
-- ${SLOTLOCK_STAFF_RECORD_YEARS} years after it happened or closed, and announcements a year after they ended. The
-- log's chain is then checked from the oldest event kept.
CREATE OR REPLACE FUNCTION slotlock.staff_records_prune()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_records_prune$
DECLARE
  cutoff timestamptz := statement_timestamp() - interval '${SLOTLOCK_STAFF_RECORD_YEARS} years';
BEGIN
  DELETE FROM slotlock.staff_audit_events old
   WHERE old.chain_index IN (SELECT kept.chain_index FROM slotlock.staff_audit_events kept
                              WHERE kept.occurred_at < cutoff ORDER BY kept.chain_index LIMIT 100);
  DELETE FROM slotlock.abuse_cases old
   WHERE old.id IN (SELECT kept.id FROM slotlock.abuse_cases kept
                     WHERE kept.status = 'closed' AND kept.closed_at < cutoff ORDER BY kept.id LIMIT 100);
  DELETE FROM slotlock.privacy_requests old
   WHERE old.id IN (SELECT kept.id FROM slotlock.privacy_requests kept
                     WHERE kept.closed_at < cutoff ORDER BY kept.id LIMIT 100);
  -- Announcements a year after they ended or ran out; the staff log keeps that they were made.
  DELETE FROM slotlock.announcements old
   WHERE old.id IN (SELECT kept.id FROM slotlock.announcements kept
                     WHERE coalesce(kept.ended_at, kept.ends_at) < statement_timestamp() - interval '1 year'
                     ORDER BY kept.id LIMIT 100);
END
$slotlock_staff_records_prune$;

-- Add one event to the staff log. Called inside the functions below, in their transaction, so an
-- action and its record commit together or not at all.
CREATE OR REPLACE FUNCTION slotlock.staff_log(actor text, happened text, account text, detail text, why text, extra jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_log$
BEGIN
  PERFORM slotlock.staff_records_prune();
  INSERT INTO slotlock.staff_audit_events (staff_ref, action, account_ref, target, reason, metadata)
  VALUES (actor, happened, account, detail, why, coalesce(extra, '{}'::jsonb));
END
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

-- The staff member a session's token names, when the session is open and its member may use the
-- capability; otherwise an error (42501), so nothing after it runs. Only a session raised by a
-- passkey reaches data; signed_in_only lets the passkey step itself through. Its last use is
-- kept to the minute, for the idle limit.
CREATE OR REPLACE FUNCTION slotlock.staff_session(token text, capability text, signed_in_only boolean)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_session$
DECLARE
  found slotlock.staff_sessions;
BEGIN
  IF token IS NULL OR token !~ '^stf_[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'staff_session' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO found FROM slotlock.staff_sessions held
   WHERE held.token_digest = sha256(convert_to(token, 'UTF8'));
  IF found.token_digest IS NULL OR found.ended_at IS NOT NULL OR found.expires_at <= statement_timestamp()
     OR found.last_seen_at < statement_timestamp() - interval '${SLOTLOCK_STAFF_IDLE_MINUTES} minutes'
     OR (found.stage <> 'full' AND NOT coalesce(signed_in_only, false)) THEN
    RAISE EXCEPTION 'staff_session' USING ERRCODE = '42501';
  END IF;
  PERFORM slotlock.staff_require(found.staff_ref, capability);
  IF found.last_seen_at < statement_timestamp() - interval '1 minute' THEN
    UPDATE slotlock.staff_sessions held SET last_seen_at = statement_timestamp()
     WHERE held.token_digest = found.token_digest;
  END IF;
  RETURN found.staff_ref;
END
$slotlock_staff_session$;

-- End every open session of a member: a reset, a removal, a role change.
CREATE OR REPLACE FUNCTION slotlock.staff_sessions_end(member_ref text)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_sessions_end$
  UPDATE slotlock.staff_sessions held SET ended_at = statement_timestamp()
   WHERE held.staff_ref = member_ref AND held.ended_at IS NULL;
$slotlock_staff_sessions_end$;

-- Every account: a person (github:, google:), an organization (github-org:), a team workspace
-- (team:), a partner's account (partner:), and any other tenant holding data or a plan. Test
-- environments (~test) are listed too; the console hides them unless asked. Its name: a team's or
-- partner account's own, an organization's GitHub login, or the name a person's provider gave at
-- their last sign-in; and a person's display, their GitHub login or verified Google email as they
-- last signed in. Both are kept only while team workspaces are offered, and go when the person is
-- erased (PRIVACY.md).
${reshaped('slotlock.staff_directory()', 'display')}
CREATE OR REPLACE FUNCTION slotlock.staff_directory()
RETURNS TABLE (account_ref text, kind text, name text, display text, created_at timestamptz)
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
           WHEN refs.ref LIKE 'github:%' OR refs.ref LIKE 'google:%' OR refs.ref LIKE 'sso:%' THEN 'person'
           WHEN refs.ref LIKE 'github-org:%' THEN 'organization'
           WHEN refs.ref LIKE 'team:%' THEN 'team'
           WHEN refs.ref LIKE 'partner:%' THEN 'partner'
           ELSE 'other'
         END,
         coalesce(team.name, org.login, partner.account, person.name),
         person.display,
         coalesce(person.created_at, team.created_at, partner.created_at)
    FROM refs
    LEFT JOIN slotlock.dashboard_people person ON person.person_ref = refs.ref
    LEFT JOIN slotlock.workspaces team ON team.tenant_ref = refs.ref
    LEFT JOIN slotlock.dashboard_organizations org ON 'github-org:' || org.org_id = refs.ref
    LEFT JOIN slotlock.partner_accounts partner ON partner.tenant_ref = refs.ref;
$slotlock_staff_directory$;

-- The plans Stripe sells that accounts hold now, and where each stands: the one rule Home and
-- Billing count by (the console's Stripe figures apply the same, src/admin/stripe.ts). Paying:
-- active or past due, out of any trial, and not set to end. A plan in a trial, or set to end, is
-- counted apart; Free, a cancelled plan, a partner's and a test environment's are none of these.
CREATE OR REPLACE FUNCTION slotlock.staff_subscribed_plans()
RETURNS TABLE (tenant_ref text, plan text, status text, trialing boolean, ends_at timestamptz, paying boolean)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_subscribed_plans$
  SELECT planned.tenant_ref, planned.plan, planned.status, planned.trialing, planned.ends_at,
         NOT planned.trialing AND planned.ends_at IS NULL
    FROM slotlock.tenant_plans planned
   WHERE planned.source = 'direct' AND planned.stripe_subscription IS NOT NULL
     AND planned.plan IN ('developer', 'team') AND planned.status IN ('active', 'past_due')
     AND planned.tenant_ref !~ '~test$';
$slotlock_staff_subscribed_plans$;

-- Signing in to the console, once GitHub named the member: with the console's key, a session at
-- the 'github' stage (enough for the passkey step, for 15 minutes) and the member's role, as
-- {"role", "session"}; NULL for anyone who is not active staff. Both are recorded. Without the
-- key, an error (42501) and nothing recorded: the console's database credential alone opens no
-- session, and learns no role.
CREATE OR REPLACE FUNCTION slotlock.admin_sign_in(member text, console_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_sign_in$
DECLARE
  found_role text;
  token text;
BEGIN
  IF console_key IS NULL OR octet_length(console_key) NOT BETWEEN 32 AND 200 OR NOT EXISTS (
    SELECT 1 FROM slotlock.staff_console_keys kept WHERE kept.key_digest = sha256(convert_to(console_key, 'UTF8'))
  ) THEN
    RAISE EXCEPTION 'admin_console_key' USING ERRCODE = '42501';
  END IF;
  IF member IS NULL OR member !~ '${SLOTLOCK_STAFF_REF_PATTERN}' THEN
    RETURN NULL;
  END IF;
  -- Sessions ended or run out a day ago go.
  DELETE FROM slotlock.staff_sessions old
   WHERE coalesce(old.ended_at, old.expires_at) < statement_timestamp() - interval '1 day';
  UPDATE slotlock.staff_members found SET last_seen_at = statement_timestamp()
   WHERE found.staff_ref = member AND found.status = 'active'
  RETURNING found.role INTO found_role;
  PERFORM slotlock.staff_log(member,
    CASE WHEN found_role IS NULL THEN 'staff.sign_in_refused' ELSE 'staff.signed_in' END,
    NULL, NULL, NULL, '{}'::jsonb);
  IF found_role IS NULL THEN
    RETURN NULL;
  END IF;
  token := 'stf_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO slotlock.staff_sessions (token_digest, staff_ref, stage, expires_at)
  VALUES (sha256(convert_to(token, 'UTF8')), member, 'github', statement_timestamp() + interval '15 minutes');
  RETURN jsonb_build_object('role', found_role, 'session', token);
END
$slotlock_admin_sign_in$;

-- Signing out: the session ends at once, wherever its cookie went. False when it had ended.
CREATE OR REPLACE FUNCTION slotlock.admin_sign_out(actor text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_sign_out$
DECLARE
  token_hash bytea := sha256(convert_to(coalesce(actor, ''), 'UTF8'));
BEGIN
  actor := slotlock.staff_session(actor, 'home', true);
  UPDATE slotlock.staff_sessions held SET ended_at = statement_timestamp()
   WHERE held.token_digest = token_hash AND held.ended_at IS NULL;
  PERFORM slotlock.staff_log(actor, 'staff.signed_out', NULL, NULL, NULL, '{}'::jsonb);
  RETURN FOUND;
END
$slotlock_admin_sign_out$;

-- The session as it stands, for each request the console serves: the member's role now (a role
-- changed since sign-in applies at once), or an error (42501) for a session that ended. Not
-- recorded: every request asks it, and the pages record themselves.
CREATE OR REPLACE FUNCTION slotlock.admin_session(actor text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_session$
BEGIN
  actor := slotlock.staff_session(actor, 'home', false);
  RETURN (SELECT member.role FROM slotlock.staff_members member WHERE member.staff_ref = actor);
END
$slotlock_admin_session$;

-- A passkey challenge the console made for this session: kept, as its SHA-256, for five minutes
-- and one use (admin_passkey_used, admin_passkey_enroll), so it serves no other session and no
-- second sign-in.
CREATE OR REPLACE FUNCTION slotlock.admin_passkey_challenge(actor text, purpose text, challenge_hash bytea)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_passkey_challenge$
DECLARE
  token_hash bytea := sha256(convert_to(coalesce(actor, ''), 'UTF8'));
BEGIN
  actor := slotlock.staff_session(actor, 'home', true);
  IF purpose IS NULL OR purpose NOT IN ('create', 'get') OR challenge_hash IS NULL OR octet_length(challenge_hash) <> 32 THEN
    RAISE EXCEPTION 'admin_passkey_challenge' USING ERRCODE = '22023';
  END IF;
  UPDATE slotlock.staff_sessions held
     SET challenge_digest = challenge_hash, challenge_purpose = purpose,
         challenge_expires_at = statement_timestamp() + interval '5 minutes'
   WHERE held.token_digest = token_hash;
END
$slotlock_admin_passkey_challenge$;

-- Use up this session's challenge for a purpose: true when it was the one waiting, and in time.
CREATE OR REPLACE FUNCTION slotlock.staff_challenge_spend(token_hash bytea, purpose text, challenge_hash bytea)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_challenge_spend$
BEGIN
  UPDATE slotlock.staff_sessions held
     SET challenge_digest = NULL, challenge_purpose = NULL, challenge_expires_at = NULL
   WHERE held.token_digest = token_hash AND held.challenge_digest = challenge_hash
     AND held.challenge_purpose = purpose AND held.challenge_expires_at > statement_timestamp();
  RETURN FOUND;
END
$slotlock_staff_challenge_spend$;

-- A session a passkey just confirmed: 'full', for 8 hours from its first passkey.
CREATE OR REPLACE FUNCTION slotlock.staff_session_raise(token_hash bytea)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_session_raise$
  UPDATE slotlock.staff_sessions held
     SET expires_at = CASE WHEN held.stage = 'full' THEN held.expires_at
                           ELSE statement_timestamp() + interval '${SLOTLOCK_STAFF_SESSION_HOURS} hours' END,
         stage = 'full', passkey_at = statement_timestamp()
   WHERE held.token_digest = token_hash;
$slotlock_staff_session_raise$;

-- What the console itself records: a sign-out, a passkey refused, a page refused, a lookup. Only
-- staff, and only staff., page. and search. events: an account action is recorded by its function.
CREATE OR REPLACE FUNCTION slotlock.admin_record(actor text, happened text, account text, detail text, why text, extra jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_record$
BEGIN
  actor := slotlock.staff_session(actor, 'home', true);
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
  actor := slotlock.staff_session(actor, 'home', false);
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
    'paying', (SELECT count(*) FROM slotlock.staff_subscribed_plans() held WHERE held.paying),
    'trialing', (SELECT count(*) FROM slotlock.staff_subscribed_plans() held WHERE held.trialing),
    'ending', (SELECT count(*) FROM slotlock.staff_subscribed_plans() held
                WHERE NOT held.trialing AND held.ends_at IS NOT NULL),
    'past_due', (SELECT count(*) FROM slotlock.staff_subscribed_plans() held WHERE held.status = 'past_due'),
    'suspended', (SELECT count(*) FROM slotlock.tenant_suspensions held WHERE held.tenant_ref !~ '~test$'),
    'active_7_days', (SELECT count(DISTINCT tenant_ref) FROM usage WHERE day > ${today} - 7),
    'operations_month', (SELECT coalesce(sum(count), 0) FROM usage WHERE day >= month_start AND metric = 'operations'),
    'bookings_month', (SELECT coalesce(sum(count), 0) FROM usage WHERE day >= month_start AND metric = 'bookings'),
    'operations_last_month', (SELECT coalesce(sum(count), 0) FROM usage WHERE day < month_start AND metric = 'operations'),
    'bookings_last_month', (SELECT coalesce(sum(count), 0) FROM usage WHERE day < month_start AND metric = 'bookings'),
    'signups', (SELECT coalesce(jsonb_agg(jsonb_build_object('day', day, 'count', added) ORDER BY day), '[]'::jsonb) FROM signups),
    'staff', (SELECT count(*) FROM slotlock.staff_members member WHERE member.status = 'active'),
    'cases_open', (SELECT count(*) FROM slotlock.abuse_cases opened WHERE opened.status = 'open'),
    'privacy_open', (SELECT count(*) FROM slotlock.privacy_requests asked WHERE asked.status = 'open'),
    'privacy_due_soon', (SELECT count(*) FROM slotlock.privacy_requests asked
                          WHERE asked.status = 'open' AND asked.due_on <= ${today} + 7),
    'billing_alerts_open', (SELECT count(*) FROM slotlock.billing_alerts open WHERE open.resolved_at IS NULL),
    'overrides_pending', (SELECT count(*) FROM slotlock.tenant_plan_overrides given
                           WHERE given.approved_at IS NULL AND given.ended_at IS NULL
                             AND given.ends_at > statement_timestamp()),
    'billing_daily', (SELECT jsonb_build_object('finished_at', run.finished_at, 'attention', run.attention)
                        FROM slotlock.maintenance_runs run WHERE run.job = 'billing_daily'
                       ORDER BY run.id DESC LIMIT 1),
    -- Accounts whose maintenance failed and has not run since (Phase 6, M11), and the last hour a
    -- server recorded.
    'maintenance_failing', (SELECT count(*) FROM slotlock.maintenance_failures),
    'maintenance_last', (SELECT jsonb_build_object('finished_at', run.finished_at, 'attention', run.attention)
                           FROM slotlock.maintenance_runs run WHERE run.job = 'maintenance'
                          ORDER BY run.id DESC LIMIT 1),
    'announcements_live', (SELECT count(*) FROM slotlock.announcements running
                            WHERE running.ended_at IS NULL AND running.starts_at <= statement_timestamp()
                              AND running.ends_at > statement_timestamp())
  ) INTO result;
  PERFORM slotlock.staff_log(actor, 'home.viewed', NULL, NULL, NULL, '{}'::jsonb);
  RETURN result;
END
$slotlock_admin_home$;

-- The account directory, a page at a time, by account reference. A query finds an account by its
-- reference (or the start of one), a GitHub account id, an API key (only its prefix is read or
-- recorded, never the rest), a Stripe customer, the name of a team, organization or partner
-- account, or a person's name or display (their login or email, a leading @ or not). Without a
-- query, test environments are left out. With each, when its subscription is set to end.
${reshaped('slotlock.admin_accounts(text, text, text, text, text, integer)', 'plan_ends_at')}
CREATE OR REPLACE FUNCTION slotlock.admin_accounts(actor text, query text, plan_filter text, status_filter text, after text, page_size integer)
RETURNS TABLE (account_ref text, kind text, name text, display text, created_at timestamptz, last_active date,
               plan text, plan_status text, plan_ends_at timestamptz, suspended boolean, stripe_customer text,
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
  actor := slotlock.staff_session(actor, 'accounts.read', false);
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
    SELECT listed.account_ref, listed.kind, listed.name, listed.display, listed.created_at
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
               OR strpos(lower(coalesce(listed.display, '')), lower(nullif(ltrim(wanted, '@'), ''))) > 0
           END
  )
  SELECT found.account_ref, found.kind, found.name, found.display, found.created_at,
         (SELECT max(used.day) FROM slotlock.usage_daily used WHERE used.tenant_ref = found.account_ref),
         coalesce(planned.plan, partner.plan, 'free'),
         planned.status,
         CASE WHEN planned.status <> 'canceled' AND planned.stripe_subscription IS NOT NULL THEN planned.ends_at END,
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
  actor := slotlock.staff_session(actor, 'accounts.read', false);
  IF requested IS NULL OR octet_length(requested) NOT BETWEEN 1 AND 500 OR requested ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'admin_account_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object(
    'account_ref', listed.account_ref, 'kind', listed.kind, 'name', listed.name, 'display', listed.display,
    'created_at', listed.created_at,
    'plan', coalesce(planned.plan, partner.plan, 'free'), 'plan_status', planned.status,
    'plan_ends_at', CASE WHEN planned.status <> 'canceled' AND planned.stripe_subscription IS NOT NULL
                         THEN planned.ends_at END,
    'plan_trialing', coalesce(planned.trialing, false),
    'stripe_customer', planned.stripe_customer, 'stripe_subscription', planned.stripe_subscription,
    'current_period_end', planned.current_period_end,
    'limits', CASE WHEN planned.tenant_ref IS NULL THEN NULL ELSE jsonb_build_object(
      'resources', planned.max_resources, 'api_keys', planned.max_api_keys,
      'webhook_endpoints', planned.max_webhook_endpoints) END,
    'partner', partner.partner_id,
    'suspended', held.tenant_ref IS NOT NULL, 'suspended_at', held.suspended_at,
    'suspension_reason', held.reason, 'suspension_message', held.customer_message,
    'suspended_by', held.suspended_by,
    'cases_open', (SELECT count(*) FROM slotlock.abuse_cases opened
                    WHERE opened.account_ref = listed.account_ref AND opened.status = 'open'),
    'notes', (SELECT count(*) FROM slotlock.account_notes kept WHERE kept.account_ref = listed.account_ref),
    -- What it is held to now: its plan, the default, or an override on top (tenant_plan).
    'effective', (SELECT to_jsonb(given) FROM slotlock.tenant_plan(listed.account_ref) given LIMIT 1),
    'effective_quotas', (SELECT to_jsonb(quotas) FROM slotlock.tenant_plan_quotas(listed.account_ref) quotas LIMIT 1),
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
  actor := slotlock.staff_session(actor, 'accounts.read', false);
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
  actor := slotlock.staff_session(actor, 'accounts.read', false);
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
  actor := slotlock.staff_session(actor, 'accounts.read', false);
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

-- The staff list, with each member's GitHub login as they last signed in and how many passkeys
-- they have. Owner only.
${reshaped('slotlock.admin_staff(text)', 'login')}
CREATE OR REPLACE FUNCTION slotlock.admin_staff(actor text)
RETURNS TABLE (staff_ref text, login text, role text, status text, added_by text, added_at timestamptz,
               last_seen_at timestamptz, passkeys integer, enrolling boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_staff$
#variable_conflict use_column
BEGIN
  actor := slotlock.staff_session(actor, 'staff.read', false);
  PERFORM slotlock.staff_log(actor, 'staff.list_viewed', NULL, NULL, NULL, '{}'::jsonb);
  RETURN QUERY
  SELECT member.staff_ref, member.login, member.role, member.status, member.added_by, member.added_at,
         member.last_seen_at,
         (SELECT count(*)::integer FROM slotlock.staff_passkeys key WHERE key.staff_ref = member.staff_ref),
         member.enrollment_expires_at IS NOT NULL AND member.enrollment_expires_at > statement_timestamp()
    FROM slotlock.staff_members member
   ORDER BY member.status, member.added_at;
END
$slotlock_admin_staff$;

-- The staff log, newest first, a page at a time (before: a chain index), with each member's GitHub
-- login as they last signed in. Narrowed to one member (who: a staff reference, or 'cli' for every
-- deployment-role command), one action, one account and a time range [since, until); views (a
-- page or list opened, a search: SLOTLOCK_STAFF_VIEW_ACTION_PATTERN) only with with_views. Owner
-- only. The form before the filters is dropped: the console asks with them.
DROP FUNCTION IF EXISTS slotlock.admin_staff_log(text, bigint, integer);
CREATE OR REPLACE FUNCTION slotlock.admin_staff_log(actor text, before bigint, page_size integer, who text,
  wanted_action text, account text, since timestamptz, until timestamptz, with_views boolean)
RETURNS TABLE (chain_index bigint, occurred_at timestamptz, staff_ref text, staff_login text, action text,
               account_ref text, target text, reason text, metadata jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_staff_log$
#variable_conflict use_column
DECLARE
  shown integer := least(greatest(coalesce(page_size, 50), 1), ${SLOTLOCK_ADMIN_PAGE_LIMIT});
BEGIN
  actor := slotlock.staff_session(actor, 'staff.log', false);
  RETURN QUERY
  SELECT event.chain_index, event.occurred_at, event.staff_ref, member.login, event.action, event.account_ref,
         event.target, event.reason, event.metadata
    FROM slotlock.staff_audit_events event
    LEFT JOIN slotlock.staff_members member ON member.staff_ref = event.staff_ref
   WHERE (before IS NULL OR event.chain_index < before)
     AND (who IS NULL OR event.staff_ref = who OR (who = 'cli' AND event.staff_ref LIKE 'cli:%'))
     AND (wanted_action IS NULL OR event.action = wanted_action)
     AND (account IS NULL OR event.account_ref = account)
     AND (since IS NULL OR event.occurred_at >= since)
     AND (until IS NULL OR event.occurred_at < until)
     AND (coalesce(with_views, false) OR event.action !~ '${SLOTLOCK_STAFF_VIEW_ACTION_PATTERN}')
   ORDER BY event.chain_index DESC
   LIMIT shown;
END
$slotlock_admin_staff_log$;

-- The staff log's chain (staff.log): its newest ${SLOTLOCK_STAFF_CHAIN_CHECKED} events checked, and its head, for an
-- Owner to record outside the database. Not itself recorded, like reading the log.
CREATE OR REPLACE FUNCTION slotlock.admin_staff_log_chain(actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_staff_log_chain$
DECLARE
  result jsonb;
BEGIN
  actor := slotlock.staff_session(actor, 'staff.log', false);
  SELECT jsonb_build_object('checked', checked, 'broken_at', broken_at, 'head_index', head_index,
                            'head_hash', encode(head_hash, 'hex'))
    INTO result FROM slotlock.staff_audit_chain_check(${SLOTLOCK_STAFF_CHAIN_CHECKED});
  RETURN result;
END
$slotlock_admin_staff_log_chain$;

-- The signed-in member's GitHub login, as GitHub gave it to the console at this sign-in: kept, so
-- pages name staff without asking GitHub. Not recorded: the sign-in is. False for a login GitHub
-- would not give.
CREATE OR REPLACE FUNCTION slotlock.admin_staff_login(actor text, member_login text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_staff_login$
BEGIN
  actor := slotlock.staff_session(actor, 'home', true);
  IF member_login IS NULL OR member_login !~ '${SLOTLOCK_STAFF_LOGIN_PATTERN}' THEN
    RETURN false;
  END IF;
  UPDATE slotlock.staff_members member SET login = member_login
   WHERE member.staff_ref = actor AND member.login IS DISTINCT FROM member_login;
  RETURN true;
END
$slotlock_admin_staff_login$;

-- Staff members' GitHub logins, for the few references a page names (who wrote a note, asked for
-- an override, set a flag): at most a page's worth, members only. Not recorded: the page is.
CREATE OR REPLACE FUNCTION slotlock.admin_staff_logins(actor text, refs text[])
RETURNS TABLE (staff_ref text, login text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_staff_logins$
#variable_conflict use_column
BEGIN
  actor := slotlock.staff_session(actor, 'home', false);
  IF cardinality(refs) > ${SLOTLOCK_ADMIN_PAGE_LIMIT} THEN
    RAISE EXCEPTION 'admin_staff_logins' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT member.staff_ref, member.login FROM slotlock.staff_members member
   WHERE member.staff_ref = ANY (refs) AND member.login IS NOT NULL;
END
$slotlock_admin_staff_logins$;

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
  actor := slotlock.staff_session(actor, 'home', true);
  RETURN QUERY
  SELECT key.credential_id, key.public_key, key.algorithm, key.sign_count, key.name, key.created_at,
         key.last_used_at
    FROM slotlock.staff_passkeys key
   WHERE key.staff_ref = actor
   ORDER BY key.created_at;
END
$slotlock_admin_passkeys$;

-- Register a passkey the console has verified, against this session's 'create' challenge. A
-- member's first passkey needs the one-time code the deployment role issued (slotlock staff add or
-- reset), which this uses up; a later one needs a passkey sign-in in this session in the last 15
-- minutes. Either raises the session, as a passkey sign-in does. False when the challenge, the
-- code or the sign-in does not hold, or the member has the most passkeys allowed.
CREATE OR REPLACE FUNCTION slotlock.admin_passkey_enroll(actor text, code_hash bytea, credential bytea, key bytea, alg integer, counter bigint, label text, challenge_hash bytea)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_passkey_enroll$
DECLARE
  token_hash bytea := sha256(convert_to(coalesce(actor, ''), 'UTF8'));
  held integer;
  member slotlock.staff_members;
  current slotlock.staff_sessions;
BEGIN
  actor := slotlock.staff_session(actor, 'home', true);
  SELECT * INTO member FROM slotlock.staff_members found WHERE found.staff_ref = actor FOR UPDATE;
  SELECT * INTO current FROM slotlock.staff_sessions here WHERE here.token_digest = token_hash;
  IF NOT slotlock.staff_challenge_spend(token_hash, 'create', challenge_hash) THEN
    PERFORM slotlock.staff_log(actor, 'staff.passkey_refused', NULL, NULL, 'challenge', '{}'::jsonb);
    RETURN false;
  END IF;
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
  ELSIF code_hash IS NOT NULL OR current.stage <> 'full'
        OR current.passkey_at < statement_timestamp() - interval '${SLOTLOCK_STAFF_FRESH_MINUTES} minutes' THEN
    PERFORM slotlock.staff_log(actor, 'staff.passkey_refused', NULL, NULL, 'needs a recent passkey sign-in', '{}'::jsonb);
    RETURN false;
  END IF;
  INSERT INTO slotlock.staff_passkeys (credential_id, staff_ref, public_key, algorithm, sign_count, name)
  VALUES (credential, actor, key, alg, greatest(coalesce(counter, 0), 0), label);
  UPDATE slotlock.staff_members found SET enrollment_hash = NULL, enrollment_expires_at = NULL
   WHERE found.staff_ref = actor;
  PERFORM slotlock.staff_session_raise(token_hash);
  PERFORM slotlock.staff_log(actor, 'staff.passkey_added', NULL, label, NULL,
    jsonb_build_object('algorithm', alg));
  RETURN true;
END
$slotlock_admin_passkey_enroll$;

-- A passkey sign-in the console verified against this session's 'get' challenge: the challenge is
-- used up, the passkey's counter moves on, and the session is raised. False (and recorded) when the
-- challenge is not this session's or was used, or the counter did not move forward, which a cloned
-- authenticator shows. Counters that stay at zero are passkeys that keep none.
CREATE OR REPLACE FUNCTION slotlock.admin_passkey_used(actor text, credential bytea, counter bigint, challenge_hash bytea)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_admin_passkey_used$
DECLARE
  token_hash bytea := sha256(convert_to(coalesce(actor, ''), 'UTF8'));
  stored bigint;
BEGIN
  actor := slotlock.staff_session(actor, 'home', true);
  IF NOT slotlock.staff_challenge_spend(token_hash, 'get', challenge_hash) THEN
    PERFORM slotlock.staff_log(actor, 'staff.passkey_refused', NULL, NULL, 'challenge', '{}'::jsonb);
    RETURN false;
  END IF;
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
  PERFORM slotlock.staff_session_raise(token_hash);
  PERFORM slotlock.staff_log(actor, 'staff.passkey_verified', NULL, NULL, NULL, '{}'::jsonb);
  RETURN true;
END
$slotlock_admin_passkey_used$;

-- The console's key: set, or replaced, by the deployment role (slotlock staff console-key), from
-- the digest of a key the console holds. Replacing it ends every staff session.
CREATE OR REPLACE FUNCTION slotlock.staff_console_key(key_hash bytea, actor text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, slotlock, pg_temp
AS $slotlock_staff_console_key$
BEGIN
  INSERT INTO slotlock.staff_console_keys AS kept (id, key_digest, set_by) VALUES (1, key_hash, actor)
  ON CONFLICT (id) DO UPDATE SET key_digest = EXCLUDED.key_digest, set_by = EXCLUDED.set_by,
                                 set_at = statement_timestamp();
  UPDATE slotlock.staff_sessions held SET ended_at = statement_timestamp() WHERE held.ended_at IS NULL;
  PERFORM slotlock.staff_log(actor, 'staff.console_key_set', NULL, NULL, NULL, '{}'::jsonb);
END
$slotlock_staff_console_key$;

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
  PERFORM slotlock.staff_sessions_end(member_ref);
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
  PERFORM slotlock.staff_sessions_end(member_ref);
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
  PERFORM slotlock.staff_sessions_end(member_ref);
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
  PERFORM slotlock.staff_sessions_end(member_ref);
  PERFORM slotlock.staff_log(actor, 'staff.removed', NULL, member_ref, NULL,
    jsonb_build_object('role', removed_role));
END
$slotlock_staff_remove$;

${STAFF_SUPPORT_DDL}
${STAFF_BILLING_DDL}
${STAFF_CONTENT_DDL}
${STAFF_PRIVACY_DDL}
${STAFF_SYSTEM_DDL}
${[...STAFF_HELPER_FUNCTIONS, ...SLOTLOCK_ADMIN_FUNCTIONS, ...SLOTLOCK_STAFF_OPERATOR_FUNCTIONS, ...SLOTLOCK_STAFF_SERVING_FUNCTIONS]
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
