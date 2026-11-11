// The dashboard: people sign in with GitHub and manage the API keys and calendar resources of a
// tenant: their own, `github:<user id>`, or with `organizations`, a GitHub organization's,
// `github-org:<organization id>`, shared by its owners and members. It is server-rendered HTML with no inline script or style,
// so its Content-Security-Policy allows nothing but this server's own stylesheet and script.
//
// Sign-in is GitHub's OAuth web flow with `state` and PKCE (S256), with no scope (`read:org` with
// organizations): the token is used once, to read who signed in and their memberships, and dropped. A session is an HMAC-sealed cookie (`__Host-`,
// HttpOnly, Secure, SameSite=Lax) that lasts 12 hours and is checked against the allowlist on every
// request. Every form carries a CSRF token bound to the session, and every POST must come from this
// server's own origin.
//
// The dashboard also records finished sign-ins (a callback works once), sent forms (a form runs
// once) and signed-out sessions (a copied cookie stays signed out). `createSlotlockDashboardState`
// keeps these in Postgres, so they hold on every server that shares the database; the resource cap
// is held in the database too.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import type { SlotlockDashboardTeams } from './teams.js';
import {
  SLOTLOCK_DASHBOARD_PAGE_CAPABILITIES,
  SLOTLOCK_DASHBOARD_POST_CAPABILITIES,
  SLOTLOCK_FRESH_CAPABILITIES,
  SLOTLOCK_WORKSPACE_ROLE_NAMES,
  SLOTLOCK_WORKSPACE_ROLES,
  type SlotlockWorkspaceCapability,
  type SlotlockWorkspaceRole,
  isSlotlockWorkspaceRole,
  slotlockRoleCan,
  slotlockRoleMayGrant,
} from './workspace-roles.js';
import type { SlotlockDashboardWorkspaces, SlotlockTeamRefusal, SlotlockTeamWorkspace } from './workspaces.js';
import type { SlotlockAuditEvent, SlotlockAuditEventInput } from './store.js';
import {
  SLOTLOCK_TEST_TENANT_SUFFIX,
  type SlotlockApiKey,
  type SlotlockApiKeyLimits,
  type SlotlockApiKeyScope,
  type SlotlockApiKeyStore,
} from './api-keys.js';
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentOperation,
  type SlotlockAgentOperationDispatchOptions,
  type SlotlockAgentOperationDispatchResult,
  type SlotlockAgentPrincipal,
  type SlotlockAgentUsage,
  type SlotlockAgentWriteOperation,
  describeSlotlockAgentWrite,
  invokeSlotlockAgentOperation,
  slotlockAgentTools,
} from './agent-server.js';
import {
  SLOTLOCK_ASSISTANT_API_KEY,
  SLOTLOCK_ASSISTANT_MAX_ACTION_BYTES,
  SLOTLOCK_ASSISTANT_MAX_MESSAGE,
  SLOTLOCK_ASSISTANT_MAX_PENDING,
  SLOTLOCK_ASSISTANT_MAX_PREVIOUS_SECRETS,
  SLOTLOCK_ASSISTANT_MODEL_NAME,
  SLOTLOCK_ASSISTANT_PRESETS,
  SLOTLOCK_ASSISTANT_TOOL_USE,
  type SlotlockAssistantAction,
  type SlotlockAssistantEntry,
  type SlotlockAssistantModel,
  type SlotlockAssistantStore,
  type SlotlockAssistantTurnEvent,
  boundSlotlockAssistantEntries,
  createSlotlockAssistantStore,
  openSlotlockAssistantKeyWithAny,
  pendingSlotlockAssistantActions,
  pruneSlotlockAssistantActions,
  checkSlotlockAssistantHost,
  readSlotlockAssistantBaseUrl,
  slotlockAssistantUrlAllowed,
  readSlotlockAssistantEntries,
  runSlotlockAssistantTurn,
  sealSlotlockAssistantKey,
  slotlockAssistantProviderMessage,
  SLOTLOCK_ASSISTANT_DIRECTORY_SIZE,
  slotlockAssistantSystemPrompt,
  testSlotlockAssistantModel,
  listSlotlockAssistantModels,
} from './assistant.js';
import { SLOTLOCK_DASHBOARD_NAME_PATTERN, type SlotlockRate } from './config.js';
import { createSlotlockRateLimiter } from './rate-limit.js';
import { createSlotlockGuardedFetch } from './webhooks.js';
import { lookup as dnsLookup } from 'node:dns/promises';
import { SLOTLOCK_ASSISTANT_CHAT_ID, SLOTLOCK_DASHBOARD_FORM_LIMIT } from './ddl.js';
import { ignoreRejection } from './hooks.js';
import { SLOTLOCK_BOOKING_RULE_LIMITS, type SlotlockBookingRules } from './booking-rules.js';
import { SLOTLOCK_DASHBOARD_ICON_SVG } from './dashboard-icon.js';
import { SLOTLOCK_SETTINGS_CSS } from './dashboard-settings-ui.js';
import { renderSlotlockMarkdown } from './dashboard-markdown.js';
import {
  SLOTLOCK_ASSISTANT_CSS,
  slotlockAssistantActionVerb,
  slotlockAssistantScript,
  slotlockAssistantStepLabel,
} from './dashboard-assistant-ui.js';
import { SLOTLOCK_PLAN_LIMITS, SLOTLOCK_PLAN_QUOTAS, type SlotlockPlan, type SlotlockTenantPlan } from './plans.js';
import {
  SLOTLOCK_MAX_GROUPS_PER_RESOURCE,
  SLOTLOCK_MAX_LOCATION_DEPTH,
  SLOTLOCK_MAX_LOCATIONS,
  SLOTLOCK_MAX_RESOURCE_GROUPS,
  SLOTLOCK_RESOURCE_KINDS,
  SLOTLOCK_RESOURCE_PROFILE_LIMITS,
  type SlotlockLocation,
  type SlotlockResourceGroup,
  type SlotlockResourceKind,
  type SlotlockResourceProfileInput,
} from './resource-profile.js';
import { slotlockQuotaPeriod } from './quotas.js';
import { type SlotlockUsageRow, slotlockUsageMonthToDate, summarizeSlotlockUsage } from './usage.js';
import {
  type CreateWebhookEndpointResult,
  SLOTLOCK_CHANGE_TYPES,
  type SlotlockChange,
  type SlotlockWebhookEndpoint,
} from './event-feed.js';
import type {
  SlotlockAssistantChatSummary,
  SlotlockSql,
  SlotlockStore,
  SlotlockWaitlistEntry,
} from './store.js';
import type {
  SlotlockAvailabilityDefaults,
  SlotlockAvailabilityExceptionInput,
  SlotlockHolidayCalendar,
  SlotlockOverrideResources,
} from './availability-store.js';
import { type SlotlockAvailabilityException, dayToDate, epochDay } from './hours.js';
import { SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES } from './holidays.js';
import { type SlotlockHolidaySource, readSlotlockHolidayCalendar } from './holiday-import.js';
import { SlotlockAgentOperationError } from './agent-server.js';
import { runSlotlockApprovalGrant } from './agent-store-backend.js';
import {
  SLOTLOCK_SANDBOX_SCENARIOS,
  type SlotlockSandboxScenario,
  fastForwardSlotlockSandbox,
  resetSlotlockSandbox,
  seedSlotlockSandbox,
} from './sandbox.js';
import type {
  Interval,
  SlotlockAgendaEntry,
  SlotlockApproval,
  SlotlockContact,
  SlotlockResource,
  SlotlockBookingRuleDefaults,
  WeeklyAvailabilityRule,
} from './types.js';
import {
  WEEKDAYS,
  WEEKDAY_NAMES as DAY_NAMES,
  type Weekday,
  type WeeklyHours,
  rulesToWeeklyHours,
  weeklyHoursToRules,
} from './weekly-hours.js';

/** Resources one dashboard tenant may hold. */
export const SLOTLOCK_DASHBOARD_MAX_RESOURCES = 500;
/** Closures the Closures page shows. */
const SLOTLOCK_DASHBOARD_MAX_EXCEPTIONS = 200;
/** Contacts the Contacts page shows at once. */
const SLOTLOCK_DASHBOARD_CONTACTS_PAGE = 100;
const SESSION_TTL_MS = 12 * 3_600_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
/**
 * How recent a sign-in must be to turn an organization on or off: who owns it is read from GitHub
 * as one signs in, so a change of owners reaches the dashboard by signing in again.
 */
const FRESH_SIGN_IN_MS = 15 * 60_000;
/** How long Google's signing keys are kept when its answer does not say (Cache-Control max-age). */
const GOOGLE_KEYS_DEFAULT_TTL_MS = 3_600_000;
const MAX_FORM_BYTES = 8_192;
/** A message to the assistant: 2,000 characters, each up to 9 bytes as a form encodes it. */
const MAX_ASSISTANT_FORM_BYTES = 24_576;
/** A holiday calendar import's form: the calendar (SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES) and its fields. */
const MAX_IMPORT_FORM_BYTES = SLOTLOCK_MAX_HOLIDAY_CALENDAR_BYTES + 65_536;
/**
 * Sign-ins (record, then GitHub's token and user) one instance runs at once; more are told to retry.
 * This also bounds how fast unauthenticated callbacks can write sign-in records.
 */
const MAX_SIGN_INS_IN_FLIGHT = 8;
/** Of those, how many one client address may run at once, so one client cannot take every slot. */
const MAX_SIGN_INS_IN_FLIGHT_PER_CLIENT = 2;
/** Entries each in-memory record keeps (createSlotlockMemoryDashboardState); past this the oldest go first. */
const MAX_REMEMBERED = 10_000;
/** A form's single-use value: 18 random bytes, then a MAC binding them to the session. */
const FORM_NONCE = /^([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/;
const POST_ROUTES: ReadonlySet<string> = new Set([
  '/sign-out',
  '/sign-out-everywhere',
  '/sessions/end',
  '/keys',
  '/keys/rotate',
  '/keys/revoke',
  '/keys/limits',
  '/resources',
  '/resources/rules',
  '/resources/pool',
  '/resources/profile',
  '/resources/place',
  '/resources/parent',
  '/locations',
  '/locations/delete',
  '/groups',
  '/groups/delete',
  '/webhooks',
  '/webhooks/delete',
  '/webhooks/enable',
  '/waitlist/leave',
  '/approvals/decide',
  '/sandbox/seed',
  '/sandbox/reset',
  '/sandbox/fast-forward',
  '/hours',
  '/closures',
  '/closures/delete',
  '/closures/import',
  '/closures/calendars/delete',
  '/contacts/forget',
  '/organization',
  '/environment',
  '/teams/enable',
  '/teams/disable',
  '/teams/create',
  '/teams/delete',
  '/teams/restore',
  '/invite/accept',
  '/members/invite',
  '/members/resend',
  '/members/revoke',
  '/members/role',
  '/members/remove',
  '/members/leave',
  '/assistant',
  '/assistant/stream',
  '/assistant/approve',
  '/assistant/dismiss',
  '/assistant/reset',
  '/assistant/rename',
  '/assistant/delete',
  '/settings/assistant',
  '/settings/assistant/test',
  '/settings/assistant/models',
  '/settings/assistant/remove',
  '/plan/upgrade',
  '/plan/manage',
]);
/** The forms whose success the audit log records, by the action it records. */
const AUDITED_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  '/keys': 'api_key.created',
  '/keys/rotate': 'api_key.rotated',
  '/keys/revoke': 'api_key.revoked',
  '/keys/limits': 'api_key.limits_changed',
  '/webhooks': 'webhook.created',
  '/webhooks/delete': 'webhook.deleted',
  '/webhooks/enable': 'webhook.enabled',
  '/contacts/forget': 'contact.forgotten',
  '/settings/assistant': 'assistant.settings_saved',
  '/settings/assistant/remove': 'assistant.settings_removed',
  '/plan/upgrade': 'billing.checkout_started',
  '/plan/manage': 'billing.portal_opened',
  '/teams/enable': 'organization.enabled',
  '/teams/disable': 'organization.disabled',
  '/sandbox/reset': 'sandbox.reset',
  '/sign-out-everywhere': 'session.signed_out_everywhere',
  '/sessions/end': 'session.ended',
});
/** What each capability lets a person do, as a refusal says it. */
const CAPABILITY_WORDS: Readonly<Record<SlotlockWorkspaceCapability, string>> = Object.freeze({
  'account.use': 'use this account',
  'workspace.read': 'see this workspace',
  'usage.read': 'see its usage',
  'assistant.chat': 'chat with the assistant',
  'operations.run': 'change bookings, hours or closures',
  'resources.manage': 'change resources',
  'sandbox.manage': 'change the test environment',
  'keys.manage_own': 'create or change API keys',
  'keys.full': 'create or change Full-access keys',
  'keys.manage_any': "change a key someone else created",
  'webhooks.manage': 'change webhooks',
  'contacts.forget': 'forget contacts',
  'assistant.settings': "change the assistant's model",
  'members.manage': 'manage members',
  'audit.read': 'read the audit log',
  'billing.manage': 'change the plan or billing',
  'workspace.own': 'change who owns this workspace',
});
/** The pages a sign-in may come back to: one made to confirm it's you, or to open an invitation. */
const STEP_UP_PAGES: ReadonlySet<string> = new Set([
  '/keys',
  '/webhooks',
  '/plan',
  '/settings',
  '/settings/members',
  '/settings/team',
  '/teams',
  '/contacts',
  '/invite',
]);
const SIGN_IN_AGAIN = 'That sign-in did not finish here, or took too long. Sign in again.';
const GITHUB_ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const MAX_COOKIE_CHARACTERS = 4_096;
const GITHUB_TIMEOUT_MS = 10_000;
/** A Google account's subject: ASCII, at most 255 characters (OpenID Connect); Google's are digits. */
const GOOGLE_SUBJECT = /^[A-Za-z0-9._-]{1,255}$/;
/** The REST API version GitHub documents for GET /user (docs.github.com, read 2026-10-10). */
const GITHUB_API_VERSION = '2026-03-10';
const USER_AGENT = 'slotlock-dashboard';
const SESSION_COOKIE = '__Host-slotlock-session';
const SIGN_IN_COOKIE = '__Host-slotlock-oauth';
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Only shown, never used as an identity; managed accounts add `_<shortcode>` to the handle. */
const GITHUB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
/** The invitation link being opened, for the sign-in that accepts it: sealed, for 30 minutes. */
const INVITE_COOKIE = '__Host-slotlock-invite';
const INVITE_LINK_TTL_MS = 30 * 60_000;
/** An invitation's token: 32 random bytes, base64url. Only its SHA-256 digest is stored. */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** How long an invitation stays open, and how many a team workspace may send in a day. */
const INVITATION_DAYS = 7;
const INVITATION_DAILY_LIMIT = 50;
/** People in a team workspace on the Free plan, its Owner and open invitations included. */
const FREE_TEAM_MEMBERS = 3;
/** Team workspaces on the Free plan each person may create, where plans apply. */
const FREE_TEAMS_PER_PERSON = 1;
/** A team workspace's id, as its tenant names it (`team:<id>`). */
const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL_ADDRESS = /^[^@\s<>"]{1,64}@[^@\s<>"]+\.[^@\s<>"]+$/;
/** Audit events a page of the audit log shows, and an export holds at most. */
const AUDIT_PAGE = 50;
const AUDIT_EXPORT_MOST = 10_000;
const AUDIT_EXPORT_EMPTY = Object.freeze({
  occurred_at: '', action: '', outcome: '', actor_type: '', actor_ref: '', actor_role: '', target_type: '',
  target_ref: '', reason: '', ip_address: '', user_agent: '', metadata: '', chain_index: '', hash: '',
});

/** A CSV cell, quoted; one a spreadsheet would read as a formula starts with an apostrophe. */
function csvCell(value: string): string {
  const safe = /^[\s]*[=+\-@]|^[\t\r\n]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
/** What each audited action did, as the audit log says it. */
const AUDIT_ACTION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'api_key.created': 'created an API key',
  'api_key.rotated': 'rotated an API key',
  'api_key.revoked': 'revoked an API key',
  'api_key.limits_changed': "changed an API key's limits",
  'webhook.created': 'added a webhook',
  'webhook.deleted': 'removed a webhook',
  'webhook.enabled': 'turned a webhook back on',
  'contact.forgotten': 'forgot a contact',
  'assistant.settings_saved': "changed the assistant's model",
  'assistant.settings_removed': "removed the assistant's model",
  'billing.checkout_started': 'started a checkout',
  'billing.portal_opened': 'opened billing',
  'organization.enabled': 'turned the organization on',
  'organization.disabled': 'turned the organization off',
  'sandbox.reset': 'reset the test environment',
  'session.signed_in': 'signed in',
  'session.signed_out_everywhere': 'signed out everywhere',
  'session.ended': 'signed a device out',
  'audit.exported': 'exported the audit log',
  'workspace.created': 'created the team',
  'workspace.deletion_scheduled': 'asked for the team to be deleted',
  'workspace.deletion_cancelled': 'kept the team',
  'member.invited': 'invited someone',
  'invitation.resent': 'sent an invitation again',
  'invitation.revoked': 'revoked an invitation',
  'member.joined': 'joined',
  'member.role_changed': "changed a member's role",
  'member.removed': 'removed a member',
  'member.left': 'left',
  'authz.denied': 'was refused',
});
const AUDIT_ACTION_GROUPS: readonly (readonly [string, readonly string[]])[] = Object.freeze([
  ['API keys', ['api_key.created', 'api_key.rotated', 'api_key.revoked', 'api_key.limits_changed']],
  ['Webhooks', ['webhook.created', 'webhook.deleted', 'webhook.enabled']],
  ['People', ['workspace.created', 'workspace.deletion_scheduled', 'workspace.deletion_cancelled', 'member.invited', 'invitation.resent', 'invitation.revoked', 'member.joined', 'member.role_changed', 'member.removed', 'member.left', 'organization.enabled', 'organization.disabled']],
  ['Billing', ['billing.checkout_started', 'billing.portal_opened']],
  ['Sessions', ['session.signed_in', 'session.signed_out_everywhere', 'session.ended']],
  ['Other', ['contact.forgotten', 'assistant.settings_saved', 'assistant.settings_removed', 'sandbox.reset', 'audit.exported', 'authz.denied']],
]);
const AUDIT_ACTION_NAMES: ReadonlySet<string> = new Set(AUDIT_ACTION_GROUPS.flatMap(([, actions]) => actions));

/** What a team change refused says, and its status. */
const TEAM_REFUSALS: Readonly<Record<SlotlockTeamRefusal, { status: number; text: string }>> = Object.freeze({
  invalid_handle: { status: 400, text: 'That name gives no usable handle. Try another.' },
  invalid_name: { status: 400, text: 'Name the team: 1 to 80 characters.' },
  handle_taken: { status: 409, text: 'That name is taken. Try another.' },
  team_limit: {
    status: 403,
    text: `Each person may create ${String(FREE_TEAMS_PER_PERSON)} team on the Free plan. Upgrade yours to create another.`,
  },
  not_found: { status: 404, text: 'That is no longer here.' },
  not_allowed: { status: 403, text: 'Your role can’t give that role, or change that member.' },
  already_member: { status: 409, text: 'They are already a member.' },
  invitation_limit: {
    status: 429,
    text: `This team sent ${String(INVITATION_DAILY_LIMIT)} invitations in the last day. Try again tomorrow.`,
  },
  member_cap: {
    status: 403,
    text: `A team on the Free plan has up to ${String(FREE_TEAM_MEMBERS)} people, open invitations included. Upgrade it to add more.`,
  },
  revoked: { status: 409, text: 'This invitation was withdrawn.' },
  accepted: { status: 409, text: 'This invitation was already used.' },
  expired: { status: 409, text: 'This invitation expired. Ask for a new one.' },
  not_for_you: { status: 403, text: 'This invitation is for another account.' },
  last_owner: { status: 409, text: 'A team keeps at least one owner. Make someone else an owner first.' },
  confirm: { status: 400, text: "Type the team's handle to confirm." },
  subscription_live: { status: 409, text: 'Cancel its Team plan on Usage first.' },
});

/** A handle from a team's name: lower-case letters, digits and dashes; later attempts add a random end. */
function teamHandleFrom(name: string, attempt: number): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 30)
      .replace(/-+$/, '') || 'team';
  return attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
}

/** A browser as people name it, from its User-Agent: `Firefox on macOS`. */
function deviceOf(agent: string | null): string {
  if (!agent) return 'A browser';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /OPR\//.test(agent)
      ? 'Opera'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Chrome\//.test(agent)
          ? 'Chrome'
          : /Safari\//.test(agent)
            ? 'Safari'
            : 'A browser';
  const system = /iPhone|iPad/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : '';
  return system ? `${browser} on ${system}` : browser;
}

/** An address as an invitation shows it before anyone signs in: its first letter and domain. */
function maskedEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  return `${email.slice(0, 1)}${'•'.repeat(Math.min(3, at - 1))}${email.slice(at)}`;
}

const tokenDigest = (raw: string | Buffer) => createHash('sha256').update(raw).digest();
const KEY_ACCESS: Readonly<Record<string, SlotlockApiKeyScope[]>> = Object.freeze({
  read: ['read'],
  read_write: ['read', 'write'],
  full: ['read', 'write', 'admin'],
});
const KEY_EXPIRY_DAYS: Readonly<Record<string, number | null>> = Object.freeze({
  never: null,
  '30': 30,
  '90': 90,
  '365': 365,
});
/**
 * `same-origin`, not `no-referrer`: under `no-referrer` a browser sends `Origin: null` with every
 * form POST (Fetch, "append a request `Origin` header"), which the origin check must refuse. This
 * still sends no referrer to any other site, so the callback URL's code never leaves.
 */
const REFERRER_POLICY = 'same-origin';
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The policy, with billing's origins allowed as form targets so Upgrade and Manage can redirect. */
function policyFor(billing: SlotlockDashboardBilling | undefined): string {
  if (!billing) return CONTENT_SECURITY_POLICY;
  const contact = new URL(billing.contact);
  if (contact.protocol !== 'https:' && contact.protocol !== 'mailto:') {
    throw new Error('billing.contact must be an https or mailto URL');
  }
  const origins = billing.formOrigins.map((value) => {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.origin !== value.replace(/\/$/, '')) {
      throw new Error(`billing.formOrigins must be https origins: ${value}`);
    }
    return parsed.origin;
  });
  return CONTENT_SECURITY_POLICY.replace(
    "form-action 'self'",
    ["form-action 'self'", ...origins].join(' '),
  );
}

/**
 * A tenant's calendar resources, as the dashboard lists and adds them. Each write takes, last, the
 * person who made it (`github:<user id>`) as `actor`, to record on the event feed.
 */
export interface SlotlockDashboardResources {
  list(tenantRef: string): Promise<SlotlockResource[]>;
  /** How many resources the tenant has, archived ones included, as a resource limit counts them. */
  count?(tenantRef: string): Promise<number>;
  /** The tenant's metered usage from `from` to `to`, UTC days inclusive (usage.ts). */
  usage?(tenantRef: string, from: string, to: string): Promise<SlotlockUsageRow[]>;
  /**
   * Create the resource, or re-zone the tenant's resource with that reference. Refuse a new one
   * (an error with `code: 'resource_limit_reached'`) once the tenant has
   * SLOTLOCK_DASHBOARD_MAX_RESOURCES, however many adds race, on however many servers.
   */
  add(
    tenantRef: string,
    externalRef: string,
    timezone: string,
    actor?: string,
  ): Promise<SlotlockResource>;
  /**
   * Set the bookable hours of one of the tenant's resources (`{ id }`), one of its locations
   * (`{ location }`), or the tenant's own (`'all'`), which every resource without its own inherits
   * (RFC 0004 B2); `null` hands them to what is above and `[]` closes. For the tenant's, `override`
   * says what becomes of resources' own hours (SlotlockOverrideResources: `none` keeps them).
   * Returns 0 for an id or location that is not the tenant's, else at least 1 (for the tenant's, how
   * many resources they now apply to).
   */
  setHours(
    tenantRef: string,
    target: { id: string } | { location: string } | 'all',
    rules: WeeklyAvailabilityRule[] | null,
    actor?: string,
    override?: SlotlockOverrideResources,
  ): Promise<number>;
  /** The people the tenant keeps to tell about bookings (RFC 0004 P3), and forgetting one. */
  contacts?: {
    list(tenantRef: string, limit: number, after?: string): Promise<SlotlockContact[]>;
    forget(tenantRef: string, ref: string, actor?: string): Promise<{ deleted: boolean; bookings: number }>;
  };
  /** The tenant's stored hours and its closures and special hours (RFC 0004 B1, B2). */
  hours?: {
    defaults(tenantRef: string): Promise<SlotlockAvailabilityDefaults>;
    exceptions(tenantRef: string, limit: number): Promise<SlotlockAvailabilityException[]>;
    addException(
      tenantRef: string,
      exception: Omit<SlotlockAvailabilityExceptionInput, 'tenantRef'>,
      actor?: string,
    ): Promise<SlotlockAvailabilityException>;
    deleteException(tenantRef: string, id: string, actor?: string): Promise<boolean>;
    /**
     * Import a holiday calendar (its text, or a URL with `byUrl`): each all-day event closes its
     * days for the next two years. Kept by name at its scope, so importing it again updates it and
     * removes the holidays it dropped; `subscribe` imports a URL again every 30 days.
     */
    importHolidays(
      tenantRef: string,
      source: SlotlockHolidaySource,
      scope: { location?: string; resourceId?: string },
      actor?: string,
    ): Promise<{ imported: number; skipped: number; removed: number }>;
    /** Whether importHolidays reads calendars by URL. */
    byUrl?: boolean;
    /** The tenant's holiday calendars, and deleting one with its closures (false: not the tenant's). */
    calendars?(tenantRef: string): Promise<SlotlockHolidayCalendar[]>;
    deleteCalendar?(tenantRef: string, id: string, actor?: string): Promise<boolean>;
  };
  /** What occupies the tenant's resources in `window`, by start: the overview's agenda. */
  agenda?(tenantRef: string, window: Interval, limit: number): Promise<SlotlockAgendaEntry[]>;
  /** The tenant's latest changes, newest first: the overview's activity. */
  recentChanges?(tenantRef: string, limit: number): Promise<SlotlockChange[]>;
  /**
   * Set the booking rules of one of the tenant's resources (null clears them): the resource, or
   * null when it is not the tenant's. Invalid rules throw with `code: 'invalid_booking_rules'`.
   */
  setRules?(
    tenantRef: string,
    id: string,
    rules: SlotlockBookingRules | null,
    actor?: string,
  ): Promise<SlotlockResource | null>;
  /** The tenant's default booking rules and its pools', which a resource's own rules overlay. */
  ruleDefaults?(tenantRef: string): Promise<SlotlockBookingRuleDefaults>;
  /**
   * Change one of the tenant's resources' profile (resource-profile.ts): the fields given, keeping
   * the rest. As setRules; `code: 'invalid_resource_profile'`, with the `field`.
   */
  setProfile?(
    tenantRef: string,
    id: string,
    profile: SlotlockResourceProfileInput,
    actor?: string,
  ): Promise<SlotlockResource | null>;
  /**
   * Make one of the tenant's resources a part of a composite (RFC 0003 G8), or no part. A refusal
   * carries the store's `code`: `parent_not_found`, `composite_too_deep`, `composite_parts_limit`
   * or `composite_busy`.
   */
  setParent?(tenantRef: string, id: string, parentId: string | null, actor?: string): Promise<SlotlockResource | null>;
  /** Put one of the tenant's resources in a pool, or none: as setRules; `code: 'invalid_pool'`. */
  setPool?(
    tenantRef: string,
    id: string,
    pool: string | null,
    actor?: string,
  ): Promise<SlotlockResource | null>;
  /**
   * The tenant's locations and groups (RFC 0003 G2, G3), and where each resource is in them. A
   * refusal carries the store's `code`: `invalid_location` or `invalid_group` (with the `field`),
   * `location_not_found`, `location_too_deep`, `location_cycle`, `location_limit_reached`,
   * `location_in_use`, `group_not_found`, `group_limit_reached` or `resource_group_limit_reached`.
   */
  grouping?: {
    /** Each under its parent, depth first, with how many resources are at each. */
    locations(tenantRef: string): Promise<SlotlockLocation[]>;
    /** Create the location with this reference, or change its name, parent and time zone. */
    putLocation(
      tenantRef: string,
      location: { ref: string; name: string; parentRef: string | null; timezone: string | null },
      actor?: string,
    ): Promise<SlotlockLocation>;
    /** False when the tenant has no such location. */
    deleteLocation(tenantRef: string, ref: string, actor?: string): Promise<boolean>;
    /** By reference, with how many resources are in each. */
    groups(tenantRef: string): Promise<SlotlockResourceGroup[]>;
    /** Create the group with this reference, or change its name and description. */
    putGroup(
      tenantRef: string,
      group: { ref: string; name: string; description: string | null },
      actor?: string,
    ): Promise<SlotlockResourceGroup>;
    /** Delete a group, its resources left as they are: false when the tenant has no such group. */
    deleteGroup(tenantRef: string, ref: string, actor?: string): Promise<boolean>;
    /**
     * Put one of the tenant's resources at a location (or none) and in exactly these groups, in one
     * transaction: the resource as it then is, or null when it is not the tenant's.
     */
    place(
      tenantRef: string,
      id: string,
      place: { location: string | null; groups: readonly string[] },
      actor?: string,
    ): Promise<SlotlockResource | null>;
  };
  /**
   * The tenant's approvals (RFC 0004 A4), newest first, and deciding one: a grant makes the booking
   * as the agent asked for it; a refusal says why (approval_not_pending, overlap, a booking rule).
   */
  approvals?: {
    list(tenantRef: string, limit: number): Promise<SlotlockApproval[]>;
    decide(
      tenantRef: string,
      id: string,
      decision: 'grant' | 'decline',
      actor?: string,
      reason?: string,
    ): Promise<{ ok: true } | { ok: false; code: string }>;
  };
  /**
   * The sandbox (RFC 0004 A6), for a test environment only: fill it with a scenario, empty it, and
   * make what would lapse within some minutes lapse now. Each refuses a live tenant.
   */
  sandbox?: {
    seed(tenantRef: string, scenario: SlotlockSandboxScenario): Promise<{ resources: number; bookings: number }>;
    reset(tenantRef: string): Promise<void>;
    fastForward(tenantRef: string, minutes: number): Promise<{ holds: number; approvals: number }>;
  };
  /** The tenant's waitlist, oldest first, and leaving it (false when the entry is not the tenant's). */
  waitlist?: {
    list(tenantRef: string, limit: number): Promise<SlotlockWaitlistEntry[]>;
    leave(tenantRef: string, id: string, actor?: string): Promise<boolean>;
  };
  /** The tenant's assistant settings and its members' conversations (assistant.ts). */
  assistant?: SlotlockAssistantStore;
  /**
   * The tenant's audit log (slotlock.audit_events): who changed keys, webhooks, billing and
   * settings, and every refusal. Append-only: record, and read newest first.
   */
  audit?: {
    /** Whether the workspace's chain holds from its oldest event kept (store verifyAuditChain). */
    verify?(tenantRef: string): Promise<{ checked: number; brokenAt: number | null }>;
    record(tenantRef: string, event: SlotlockAuditEventInput): Promise<void>;
    list(
      tenantRef: string,
      params?: { limit?: number; before?: { occurredAt: Date; id: string }; action?: string; actorRef?: string },
    ): Promise<SlotlockAuditEvent[]>;
  };
  /** The tenant's webhook endpoints, as the event feed keeps them. */
  webhooks?: {
    list(tenantRef: string): Promise<SlotlockWebhookEndpoint[]>;
    create(
      tenantRef: string,
      url: string,
      eventTypes: readonly string[] | undefined,
      actor?: string,
    ): Promise<CreateWebhookEndpointResult>;
    remove(tenantRef: string, id: string, actor?: string): Promise<boolean>;
    enable(
      tenantRef: string,
      id: string,
      actor?: string,
    ): Promise<SlotlockWebhookEndpoint | null | { code: 'changes_pruned' }>;
  };
}

/**
 * What the dashboard records so a sign-in callback works once, a sent form runs once and a
 * signed-out session stays out. Every server behind one dashboard origin must share it:
 * `createSlotlockDashboardState` keeps it in Postgres. `createSlotlockMemoryDashboardState` keeps it
 * in one process, for tests or a server that will only ever run as one process.
 */
export interface SlotlockDashboardState {
  /**
   * Record a sign-in or form `value` until `expiresAt` (ms since the epoch). True only the first
   * time, and never for a value whose expiry has passed or that claims to outlive a day, by the
   * state's own clock (the database's, for createSlotlockDashboardState). A form names its `owner`,
   * the GitHub user id: past SLOTLOCK_DASHBOARD_FORM_LIMIT live forms of one owner, `use` throws an
   * error with `code: 'dashboard_form_limit'`.
   */
  use(kind: 'sign_in' | 'form', value: string, expiresAt: number, owner?: string): Promise<boolean>;
  /** Record that the session `sid` signed out, until `expiresAt`. */
  endSession(sid: string, expiresAt: number): Promise<void>;
  /**
   * Whether the session `sid`, sealed to expire at `expiresAt`, signed out or is over by the
   * state's clock (past its expiry, or claiming to outlive a day).
   */
  sessionEnded(sid: string, expiresAt: number): Promise<boolean>;
}

/**
 * The chat assistant (assistant.ts): each tenant's admins connect a model of their own in Settings,
 * and every member may chat with it. Its reads and approved writes run through the agent operation
 * boundary with `backend`, as the principal `dashboard-assistant:<GitHub login>` of the member's
 * tenant, with `authorize` and `consumeRateLimit` as an agent's are. Needs the resources adapter's
 * `assistant` too.
 */
export interface SlotlockDashboardAssistantOptions {
  /** Seals each tenant's API key (SLOTLOCK_ASSISTANT_SECRET): 32+ random characters. */
  secret: string;
  /**
   * Secrets keys may still be sealed under (SLOTLOCK_ASSISTANT_PREVIOUS_SECRETS), newest first, at
   * most SLOTLOCK_ASSISTANT_MAX_PREVIOUS_SECRETS: a key one of them opens is used, and sealed again
   * under `secret` in the same request, so changing the secret makes no owner enter a key again.
   * Drop an old secret once every tenant has used the assistant since the change, or keys still
   * sealed under it stop opening.
   */
  previousSecrets?: readonly string[];
  /** Each operation the assistant runs, for usage metering (the agent server's `onUsage`). */
  onUsage?: (usage: SlotlockAgentUsage) => void;
  /** Each message a member sends that the assistant answers, for usage metering. Never awaited. */
  onMessage?: (tenantRef: string) => void;
  backend: SlotlockAgentCalendarBackend;
  /**
   * As the agent server's: false refuses an operation. Every offered operation by default. It also
   * checks a write the model proposes, so it must hold nothing: limits that hold a slot go in
   * `admit`.
   */
  authorize?: SlotlockAgentOperationDispatchOptions['authorize'];
  /**
   * Taken when a read runs and when an approved write runs, never for a proposal: the agent
   * request limits' `admit` (serve's series-write slots), which may hold a slot until the request
   * is answered, or throw a SlotlockAgentOperationError to refuse.
   */
  admit?: (args: {
    principal: SlotlockAgentPrincipal;
    operation: SlotlockAgentOperation;
    input: Record<string, unknown>;
  }) => Promise<void>;
  /** As the agent server's; charged for each read and each approved write, never for a proposal. */
  consumeRateLimit?: SlotlockAgentOperationDispatchOptions['consumeRateLimit'];
  /**
   * Allow a model at a local or private network address (SLOTLOCK_ASSISTANT_PRIVATE_URLS): a
   * base URL whose host is, or resolves to, a loopback, private, link-local, shared, unique-local
   * or metadata address. Off by default: such URLs are refused when saved and at each call.
   */
  privateUrls?: boolean;
  /**
   * Reaches the model providers. By default Node.js's http client, which checks every address a
   * host resolves to as the connection is made (createSlotlockGuardedFetch), so a name rebound to
   * a private address is refused too. A replacement must make that check itself, or reach no
   * private network (a Cloudflare Worker's fetch).
   */
  fetch?: typeof fetch;
  /** The addresses a host resolves to, to refuse a private one when saved: dns.lookup by default. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Messages and connection tests one member may send: 10 a minute, 10 at once, by default. */
  rate?: SlotlockRate;
  /** One model call's limit (30 s by default) and one message's (90 s). */
  timeoutMs?: number;
  turnTimeoutMs?: number;
  /** Model calls one message may make (8 by default, at most 20). */
  maxSteps?: number;
  /**
   * How long a conversation is kept after its last message (1 second to 3,650 days). Without it, a
   * member keeps each conversation until they delete it, up to SLOTLOCK_ASSISTANT_MAX_CHATS.
   */
  conversationTtlMs?: number;
}

/**
 * Hosted Slotlock's plans (plans.ts) and their billing: a Usage page with the tenant's plan and use,
 * Upgrade (to a checkout page) and Manage (to a billing portal). Off unless set.
 */
/**
 * The tenant's plan and the deployment's default, read whether or not anything sells plans: with it
 * the dashboard shows a Usage page (plan, limits and this month's use) and puts a tenant new to
 * plans on the default before it adds what plans limit.
 */
export interface SlotlockDashboardPlans {
  /** The tenant's plan (its own, or the default once it applies), or null (the server's limits apply). */
  plan(tenantRef: string): Promise<SlotlockTenantPlan | null>;
  /** Puts a tenant new to plans on the default plan before it adds a key, resource or webhook endpoint. */
  enrol?(tenantRef: string): Promise<void>;
  /** The deployment's default plan and the date it applies to every tenant, or null. */
  planDefault?(): Promise<{ plan: SlotlockPlan; limits: SlotlockTenantPlan['limits']; appliesFrom: Date } | null>;
  /**
   * Where asking for another plan goes (an https or mailto URL) when nothing sells plans here: with
   * it, the Usage page offers Developer or Team by asking.
   */
  contact?: string;
}

export interface SlotlockDashboardBilling {
  /** The tenant's plan (its own, or the default), or null when it has none (the server's limits apply). */
  plan(tenantRef: string): Promise<SlotlockTenantPlan | null>;
  /**
   * Puts a tenant new to plans on the default plan before it adds a key, resource or webhook
   * endpoint, while the default does not yet apply to every tenant (plans.ts).
   */
  enrol?(tenantRef: string): Promise<void>;
  /** A checkout URL for the Developer plan, or the Team plan for an organization (with `teamPrices`). */
  checkout(input: {
    tenantRef: string;
    interval: 'month' | 'year';
    plan?: 'developer' | 'team';
    customer: string | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string>;
  /** A billing portal URL for the tenant's customer. */
  portal(input: { customer: string; returnUrl: string }): Promise<string>;
  /** The Developer plan's prices as shown, such as `$10`. */
  prices: { month: string; year: string };
  /**
   * The Team plan's prices as shown (Teams on Cloud). With them, an organization's workspace is
   * offered Team instead of Developer.
   */
  teamPrices?: { month: string; year: string };
  /**
   * Metered overage on Developer (SLOTLOCK_OVERAGE, overage.ts): its price as shown, such as `$2
   * per 10,000 operations`, and the percent of the quota where use is refused.
   */
  overage?: { price: string; stopPercent: number };
  /** Where a Custom (self-hosted) enquiry goes: an https or mailto URL. */
  contact: string;
  /** The https origins Upgrade and Manage redirect to, allowed in the policy's form-action. */
  formOrigins: readonly string[];
}

/** Sends an invitation's link by email (hosted Slotlock); without one, the person inviting sends it. */
export interface SlotlockInvitationSender {
  send(invitation: {
    to: string;
    /** The team workspace's name, and how the person inviting is shown. */
    workspace: string;
    inviter: string;
    role: string;
    link: string;
    expiresAt: Date;
  }): Promise<void>;
}

export interface SlotlockDashboardOptions {
  /** Where people reach the server; the dashboard lives at `<publicUrl>/dashboard`. */
  publicUrl: string;
  /** What the deployment is called in the dashboard: 1-60 characters. Defaults to `Slotlock`. */
  name?: string;
  /**
   * The terms people accept by signing in, an https URL. The sign-in page links them beside the
   * button; without it, the page names no terms.
   */
  termsUrl?: string;
  /** The privacy notice the sign-in page links, an https URL. */
  privacyUrl?: string;
  /**
   * Where agents reach the server's MCP and A2A endpoints, which the dashboard shows, when it is
   * served from another origin (on Cloudflare Workers, with the server elsewhere). Defaults to
   * `publicUrl`.
   */
  serviceUrl?: string;
  /**
   * A GitHub OAuth app whose callback URL is `<publicUrl>/dashboard/callback`. The endpoint URLs
   * default to GitHub's and exist for tests.
   */
  github: {
    clientId: string;
    clientSecret: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    userUrl?: string;
    membershipsUrl?: string;
  };
  /**
   * Sign-in with Google (OpenID Connect), beside GitHub, for people without a GitHub account: each
   * is their own tenant, `google:<subject>`. Not offered with a fixed list of `organizations`,
   * which are GitHub's. Its redirect URI is the same `<publicUrl>/dashboard/callback`.
   */
  google?: {
    clientId: string;
    clientSecret: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    /** Google's signing keys (JWKS); https://www.googleapis.com/oauth2/v3/certs by default. */
    jwksUrl?: string;
  };
  /** Seals sessions and sign-in state and derives CSRF tokens: 32+ random characters. */
  sessionSecret: string;
  /**
   * GitHub user ids (numbers, as strings) and Google accounts (`google:<subject>`) that may sign in,
   * or `'*'` for every account.
   */
  allowedUsers: '*' | readonly string[];
  /**
   * GitHub organization ids (numbers, as strings) this dashboard serves. With them, a tenant is an
   * organization (`github-org:<id>`), not a person: sign-in asks for `read:org`, and a person signs
   * in to the served organizations they are an active member of, sharing each one's keys and
   * resources with its other members: owners and members, not billing managers, from the first
   * 100 memberships GitHub lists, up to 20 served organizations. Membership is read at each sign-in; leaving an organization
   * ends access at the next sign-in, at most a session (12 hours) later, and removing an
   * organization from this list signs its sessions out at once. Without it, each person is their
   * own tenant (`github:<id>`).
   *
   * `'enabled'` (Teams on Cloud, with `teams`): each person signs in to their own tenant and may
   * switch to any organization they belong to that an owner turned on, on the Teams page; turning
   * one off ends its use at once.
   */
  organizations?: readonly string[] | 'enabled';
  /** The organizations turned on, with `organizations: 'enabled'` (teams.ts). */
  teams?: SlotlockDashboardTeams;
  /**
   * Who belongs to which workspace, and as what (workspaces.ts, workspace-roles.ts): read on every
   * request, so a role changed or a membership ended applies at the next one, and "Sign out
   * everywhere" ends every session. Without it, a person is the Owner of their own workspace, and an
   * organization's GitHub owners are its Owners and its other members Developers, as read at sign-in.
   */
  workspaces?: SlotlockDashboardWorkspaces;
  /**
   * Team workspaces (`team:<id>`): anyone signed in creates one, invites people to it by email with
   * a role, and changes or removes them (workspaces.ts teams). Needs `workspaces` with its
   * database, and no fixed list of organizations. Off unless set.
   */
  teamWorkspaces?: boolean;
  /** Sends invitations by email; the person inviting is shown each link either way. */
  invitations?: SlotlockInvitationSender;
  keys: SlotlockApiKeyStore;
  resources: SlotlockDashboardResources;
  /** Shared by every server behind this origin: see SlotlockDashboardState. */
  state: SlotlockDashboardState;
  /** The server's bookable hours: shown, not edited, and used by resources without their own. */
  availability?: readonly WeeklyAvailabilityRule[];
  /** The chat assistant; off unless set. */
  assistant?: SlotlockDashboardAssistantOptions;
  /** Plans (hosted Slotlock): a Usage page, and enrolment on the default plan. Off unless set. */
  plans?: SlotlockDashboardPlans;
  /** Paying for plans through Stripe (hosted Slotlock); off unless set. Implies `plans` from its own. */
  billing?: SlotlockDashboardBilling;
  /**
   * The deployment meters usage (SLOTLOCK_USAGE=on): the Usage page shows this month's, from the
   * resources adapter's `usage`.
   */
  usage?: boolean;
  /**
   * The deployment holds tenants to their plans' monthly quotas (SLOTLOCK_QUOTAS=on): the Usage page
   * shows this month's use against them, and warns from 80%. Needs `usage`.
   */
  quotas?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /**
   * The address a request came from, as the server counts its clients (the socket's, or a trusted
   * proxy's field such as CF-Connecting-IP), so one client's sign-ins in flight are capped below
   * every client's. Without it, or when it returns undefined, only the cap on every client applies.
   */
  clientAddress?: (request: Request) => string | undefined;
  /**
   * Called with whatever a request handler throws; the person sees a generic error page. Not
   * awaited; what it throws, or its promise rejects with, is ignored.
   */
  onError?: (error: unknown) => void;
}

export interface SlotlockDashboard {
  /** Whether a request is for the dashboard, so a server can route it here. */
  handles(request: Request): boolean;
  fetch(request: Request): Promise<Response>;
}

/**
 * The dashboard's resources, in the store under each tenant's row-level security. Adds hold the cap
 * in the database (a READ COMMITTED transaction, under a per-tenant lock).
 */
export function createSlotlockDashboardResources(
  store: SlotlockStore,
  options: {
    /**
     * The agent backend (`createSlotlockStoreAgentBackend`) a granted approval's booking is made
     * through: with it, the dashboard lists approvals and decides them.
     */
    agentBackend?: SlotlockAgentCalendarBackend;
    /**
     * Fetches holiday calendars by URL (the guarded fetch under `serve`): with it, Closures imports
     * and subscribes to a calendar's address.
     */
    holidayFetch?: typeof fetch;
  } = {},
): SlotlockDashboardResources {
  // Every change here is the dashboard's, made by the person signed in (actor) when known.
  const by = (actor: string | undefined) =>
    actor === undefined ? { origin: 'dashboard' as const } : { origin: 'dashboard' as const, actor };
  const agentBackend = options.agentBackend;
  return {
    sandbox: {
      seed: (tenantRef, scenario) => seedSlotlockSandbox(store, tenantRef, scenario),
      async reset(tenantRef) {
        await resetSlotlockSandbox(store, tenantRef);
      },
      async fastForward(tenantRef, minutes) {
        const forward = await fastForwardSlotlockSandbox(store, tenantRef, minutes);
        return { holds: forward.holds, approvals: forward.approvals };
      },
    },
    ...(agentBackend
      ? {
          approvals: {
            list: (tenantRef: string, limit: number) =>
              store.withTenant(tenantRef, (tenant) => tenant.listApprovals({ tenantRef, limit })),
            async decide(tenantRef: string, id: string, decision: 'grant' | 'decline', actor?: string, reason?: string) {
              const decidedBy = actor ?? 'dashboard';
              if (decision === 'decline') {
                const declined = await store.withTenant(
                  tenantRef,
                  (tenant) => tenant.declineApproval({ tenantRef, id, decidedBy, ...(reason ? { reason } : {}) }),
                  by(actor),
                );
                if (!declined.ok) return declined;
                // Its held time is free: offer it to the waitlist, as a release does.
                await store
                  .withTenant(tenantRef, (tenant) => tenant.offerWaitlist({ tenantRef, limit: 20 }), { origin: 'maintenance' })
                  .catch(() => undefined);
                return { ok: true as const };
              }
              const approval = await store.withTenant(tenantRef, (tenant) => tenant.getApproval({ tenantRef, id }));
              if (!approval) return { ok: false as const, code: 'approval_not_found' };
              if (approval.status !== 'pending') return { ok: false as const, code: 'approval_not_pending' };
              try {
                await runSlotlockApprovalGrant(agentBackend, approval, {
                  tenantRef,
                  decidedBy,
                  signal: new AbortController().signal,
                  origin: 'dashboard',
                });
              } catch (error) {
                if (error instanceof SlotlockAgentOperationError) return { ok: false as const, code: error.code };
                throw error;
              }
              return { ok: true as const };
            },
          },
        }
      : {}),
    list: (tenantRef) =>
      store.withTenant(tenantRef, (tenant) =>
        tenant.listResources({ tenantRef, limit: SLOTLOCK_DASHBOARD_MAX_RESOURCES + 1 }),
      ),
    count: (tenantRef) =>
      store.withTenant(tenantRef, (tenant) => tenant.countResources({ tenantRef })),
    usage: (tenantRef, from, to) =>
      store.withTenant(tenantRef, (tenant) => tenant.readUsage({ tenantRef, from, to })),
    add: (tenantRef, externalRef, timezone, actor) =>
      store.withTenant(
        tenantRef,
        (tenant) =>
          tenant.createResource({
            tenantRef,
            externalRef,
            timezone,
            maxTenantResources: SLOTLOCK_DASHBOARD_MAX_RESOURCES,
          }),
        { isolation: 'read committed', ...by(actor) },
      ),
    setHours: (tenantRef, target, rules, actor, override) =>
      store.withTenant(
        tenantRef,
        async (tenant) => {
          if (target === 'all') {
            return (await tenant.storeTenantAvailability({ tenantRef, rules, overrideResources: override ?? 'none' })).inheriting;
          }
          if ('location' in target) {
            const result = await tenant.setLocationAvailability({ tenantRef, location: target.location, rules });
            return result === null ? 0 : Math.max(1, result.inheriting);
          }
          const updated = await tenant.setResourceAvailability({ tenantRef, id: target.id, rules });
          return updated ? 1 : 0;
        },
        by(actor),
      ),
    contacts: {
      list: (tenantRef, limit, after) =>
        store.withTenant(tenantRef, (tenant) => tenant.listContacts({ tenantRef, limit, ...(after ? { after } : {}) })),
      forget: (tenantRef, ref, actor) =>
        store.withTenant(tenantRef, (tenant) => tenant.deleteContact({ tenantRef, ref }), { isolation: 'read committed', ...by(actor) }),
    },
    hours: {
      defaults: (tenantRef) =>
        store.withTenant(tenantRef, (tenant) => tenant.getAvailabilityDefaults({ tenantRef })),
      exceptions: (tenantRef, limit) =>
        store.withTenant(tenantRef, (tenant) =>
          tenant.listAvailabilityExceptions({
            tenantRef,
            from: dayToDate(Math.floor(Date.now() / 86_400_000) - 1),
            limit,
          }),
        ),
      addException: (tenantRef, exception, actor) =>
        store.withTenant(tenantRef, (tenant) => tenant.createAvailabilityException({ ...exception, tenantRef }), by(actor)),
      deleteException: (tenantRef, id, actor) =>
        store.withTenant(tenantRef, (tenant) => tenant.deleteAvailabilityException({ tenantRef, id }), by(actor)),
      importHolidays: async (tenantRef, source, scope, actor) => {
        // Read (a URL fetched) before the transaction opens.
        const read = await readSlotlockHolidayCalendar(source, options.holidayFetch);
        return store.withTenant(
          tenantRef,
          async (tenant) => {
            const result = await tenant.importHolidayCalendar({
              tenantRef,
              ...scope,
              name: read.name,
              ...(read.url !== undefined ? { url: read.url } : {}),
              holidays: read.holidays,
              span: read.span,
            });
            return { imported: result.imported, skipped: read.skipped, removed: result.removed };
          },
          by(actor),
        );
      },
      byUrl: options.holidayFetch !== undefined,
      calendars: (tenantRef) => store.withTenant(tenantRef, (tenant) => tenant.listHolidayCalendars({ tenantRef })),
      deleteCalendar: (tenantRef, id, actor) =>
        store.withTenant(tenantRef, async (tenant) => (await tenant.deleteHolidayCalendar({ tenantRef, id })) !== null, by(actor)),
    },
    agenda: (tenantRef, window, limit) =>
      store.withTenant(tenantRef, (tenant) => tenant.listAgenda({ tenantRef, window, limit })),
    recentChanges: (tenantRef, limit) =>
      store.withTenant(tenantRef, (tenant) => tenant.listRecentChanges({ tenantRef, limit })),
    setRules: (tenantRef, id, rules, actor) =>
      store.withTenant(
        tenantRef,
        (tenant) => tenant.setResourceBookingRules({ tenantRef, id, rules }),
        by(actor),
      ),
    ruleDefaults: (tenantRef) =>
      store.withTenant(tenantRef, (tenant) => tenant.getBookingRuleDefaults({ tenantRef })),
    setPool: (tenantRef, id, pool, actor) =>
      store.withTenant(tenantRef, (tenant) => tenant.setResourcePool({ tenantRef, id, pool }), by(actor)),
    setParent: (tenantRef, id, parentId, actor) =>
      store.withTenant(tenantRef, (tenant) => tenant.setResourceParent({ tenantRef, id, parentId }), by(actor)),
    setProfile: (tenantRef, id, profile, actor) =>
      store.withTenant(
        tenantRef,
        (tenant) => tenant.updateResourceProfile({ tenantRef, id, profile }),
        by(actor),
      ),
    grouping: {
      locations: (tenantRef) =>
        store.withTenant(tenantRef, (tenant) => tenant.listLocations({ tenantRef })),
      putLocation: (tenantRef, location, actor) =>
        store.withTenant(tenantRef, (tenant) => tenant.putLocation({ tenantRef, ...location }), by(actor)),
      deleteLocation: (tenantRef, ref, actor) =>
        store.withTenant(tenantRef, (tenant) => tenant.deleteLocation({ tenantRef, ref }), by(actor)),
      groups: (tenantRef) => store.withTenant(tenantRef, (tenant) => tenant.listGroups({ tenantRef })),
      putGroup: (tenantRef, group, actor) =>
        store.withTenant(tenantRef, (tenant) => tenant.putGroup({ tenantRef, ...group }), by(actor)),
      deleteGroup: (tenantRef, ref, actor) =>
        store.withTenant(tenantRef, (tenant) => tenant.deleteGroup({ tenantRef, ref }), by(actor)),
      place: (tenantRef, id, place, actor) =>
        store.withTenant(
          tenantRef,
          async (tenant) => {
            // The location first, which finds the resource (null when it is not the tenant's);
            // then its groups, in the same transaction, so a refused group moves nothing.
            const moved = await tenant.updateResourceProfile({
              tenantRef,
              id,
              profile: {},
              location: place.location,
            });
            if (!moved) return null;
            const wanted = new Set(place.groups);
            const current = new Set(moved.groups ?? []);
            for (const group of current) {
              if (!wanted.has(group)) await tenant.removeGroupMember({ tenantRef, group, resourceId: id });
            }
            for (const group of wanted) {
              if (!current.has(group)) await tenant.addGroupMember({ tenantRef, group, resourceId: id });
            }
            return tenant.getResource({ tenantRef, id });
          },
          by(actor),
        ),
    },
    waitlist: {
      list: (tenantRef, limit) =>
        store.withTenant(tenantRef, (tenant) => tenant.listWaitlist({ tenantRef, limit })),
      async leave(tenantRef, id, actor) {
        const left = await store.withTenant(
          tenantRef,
          (tenant) => tenant.leaveWaitlist({ tenantRef, id }),
          by(actor),
        );
        // An offered entry's hold went with it: offer that time to the next, as the API does.
        if (left) {
          await store
            .withTenant(tenantRef, (tenant) => tenant.offerWaitlist({ tenantRef, limit: 20 }), {
              origin: 'maintenance',
            })
            .catch(() => undefined);
        }
        return left;
      },
    },
    webhooks: {
      list: (tenantRef) =>
        store.withTenant(tenantRef, (tenant) => tenant.listWebhookEndpoints({ tenantRef })),
      create: (tenantRef, url, eventTypes, actor) =>
        store.withTenant(
          tenantRef,
          (tenant) =>
            tenant.createWebhookEndpoint({
              tenantRef,
              url,
              ...(eventTypes !== undefined ? { eventTypes } : {}),
            }),
          by(actor),
        ),
      remove: async (tenantRef, id, actor) =>
        (
          await store.withTenant(
            tenantRef,
            (tenant) => tenant.deleteWebhookEndpoint({ tenantRef, id }),
            by(actor),
          )
        ).deleted,
      enable: (tenantRef, id, actor) =>
        store.withTenant(
          tenantRef,
          (tenant) => tenant.enableWebhookEndpoint({ tenantRef, id }),
          by(actor),
        ),
    },
    assistant: createSlotlockAssistantStore(store),
    audit: {
      verify: (tenantRef) => store.withTenant(tenantRef, (tenant) => tenant.verifyAuditChain({ tenantRef })),
      record: (tenantRef, event) => store.withTenant(tenantRef, (tenant) => tenant.recordAuditEvent({ tenantRef, event })),
      list: (tenantRef, params = {}) =>
        store.withTenant(tenantRef, (tenant) => tenant.listAuditEvents({ tenantRef, ...params })),
    },
  };
}

function assertExpiry(expiresAt: number): Date {
  if (!Number.isFinite(expiresAt))
    throw new Error('Slotlock dashboard record needs a finite expiry');
  return new Date(expiresAt);
}

function formLimitError(): Error & { code: 'dashboard_form_limit' } {
  return Object.assign(
    new Error(
      `Slotlock dashboard: ${SLOTLOCK_DASHBOARD_FORM_LIMIT} forms are live for this person`,
    ),
    { code: 'dashboard_form_limit' as const },
  );
}

const ownerDigest = (owner: string) =>
  createHash('sha256').update(`slotlock-dashboard-owner.${owner}`).digest();

/**
 * Records accepted write confirmations (`SlotlockAgentConfirmationOptions.consumeAcceptance`) in
 * Postgres, shared by every server on the database: true the first time a confirmation's nonce is
 * recorded, false while it stays recorded, so an accepted confirmation runs its write once on any
 * server. Kept until the confirmation's own expiry, through the same function and table as the
 * dashboard's records (only a SHA-256 digest of the nonce is stored); pass a client, not a
 * transaction.
 */
export function createSlotlockAcceptanceRecords(
  sql: SlotlockSql,
): (acceptance: { nonce: string; expiresAt: Date }) => Promise<boolean> {
  if (!('begin' in sql)) {
    throw new Error(
      'createSlotlockAcceptanceRecords needs a client, not a transaction: a rollback would undo its records',
    );
  }
  const client = sql as Sql;
  return async ({ nonce, expiresAt }) => {
    const digest = createHash('sha256').update(`slotlock-confirmation.${nonce}`).digest();
    return (await client.begin('isolation level read committed', async (tx) => {
      const [row] = await tx<{ used: boolean }[]>`
        SELECT slotlock.use_dashboard_token('confirmation', ${digest}, ${expiresAt}, NULL::bytea) AS used`;
      return row?.used === true;
    })) as boolean;
  };
}

/**
 * The dashboard's records in Postgres, shared by every server on the database. Run `applySchema()`
 * and `grantApplicationRole()` first: the serving role reaches the records only through
 * SLOTLOCK_DASHBOARD_FUNCTIONS. Only SHA-256 digests of the values are stored.
 *
 * Each record is written in a READ COMMITTED transaction of its own, whatever the role's default:
 * under REPEATABLE READ, a use racing another of the same value, or two prunes of the same expired
 * rows, would fail with a serialization error instead of answering, and the per-person form count
 * would not be exact. Pass a client, not a transaction: a caller's rollback would undo a record.
 */
export function createSlotlockDashboardState(sql: SlotlockSql): SlotlockDashboardState {
  if (!('begin' in sql)) {
    throw new Error(
      'createSlotlockDashboardState needs a client, not a transaction: a rollback would undo its records',
    );
  }
  const client = sql as Sql;
  const digest = (kind: string, value: string) =>
    createHash('sha256').update(`slotlock-dashboard-${kind}.${value}`).digest();
  const record = async (
    kind: 'sign_in' | 'form' | 'ended_session',
    value: string,
    expiresAt: number,
    owner?: string,
  ): Promise<boolean> => {
    const expires = assertExpiry(expiresAt);
    if (kind === 'form' && owner === undefined) {
      throw new Error('Slotlock dashboard form records name their owner');
    }
    const ownerHash = owner === undefined ? null : ownerDigest(owner);
    try {
      return (await client.begin('isolation level read committed', async (tx) => {
        const [row] = await tx<{ used: boolean }[]>`
          SELECT slotlock.use_dashboard_token(
            ${kind}, ${digest(kind, value)}, ${expires}, ${ownerHash}::bytea) AS used`;
        return row?.used === true;
      })) as boolean;
    } catch (error) {
      if ((error as { code?: unknown }).code === '54000') throw formLimitError();
      throw error;
    }
  };
  return {
    use: (kind, value, expiresAt, owner) => record(kind, value, expiresAt, owner),
    async endSession(sid, expiresAt) {
      await record('ended_session', sid, expiresAt);
    },
    async sessionEnded(sid, expiresAt) {
      const [row] = await client<{ ended: boolean }[]>`
        SELECT slotlock.dashboard_session_ended(
          ${digest('ended_session', sid)}, ${assertExpiry(expiresAt)}) AS ended`;
      return row?.ended === true;
    },
  };
}

/**
 * The dashboard's records in this process: bounded (the oldest go first past 10,000 of a kind) and
 * seen by no other process. For tests, or a server that only ever runs as one process.
 */
export function createSlotlockMemoryDashboardState(
  now: () => number = Date.now,
): SlotlockDashboardState {
  const records = { sign_in: remember(now), form: remember(now), ended_session: remember(now) };
  const formsByOwner = new Map<string, number[]>();
  const live = (expiresAt: number) => expiresAt > now() && expiresAt <= now() + DAY_MS;
  return {
    async use(kind, value, expiresAt, owner) {
      assertExpiry(expiresAt);
      if (!live(expiresAt)) return false;
      const record = records[kind];
      if (record.has(value)) return false;
      if (kind === 'form') {
        if (owner === undefined)
          throw new Error('Slotlock dashboard form records name their owner');
        const forms = (formsByOwner.get(owner) ?? []).filter((until) => until > now());
        if (forms.length >= SLOTLOCK_DASHBOARD_FORM_LIMIT) throw formLimitError();
        formsByOwner.set(owner, [...forms, expiresAt]);
      }
      record.add(value, expiresAt);
      return true;
    },
    async endSession(sid, expiresAt) {
      assertExpiry(expiresAt);
      if (live(expiresAt)) records.ended_session.add(sid, expiresAt);
    },
    async sessionEnded(sid, expiresAt) {
      assertExpiry(expiresAt);
      return !live(expiresAt) || records.ended_session.has(sid);
    },
  };
}

interface Session {
  /** GitHub user id. */
  uid: string;
  login: string;
  /** Random per session; the CSRF token is derived from it. */
  sid: string;
  exp: number;
  /** With organizations: the served ones the person belongs to, read at sign-in, and the one in use. */
  orgs?: Organization[];
  org?: string;
  /** The test environment (RFC 0003 G9): the workspace's `<tenant>~test`. Live when absent. */
  env?: 'test';
  /** Signed in with Google: `uid` is the Google subject, `login` the account's email. GitHub when absent. */
  idp?: 'google';
  /** The person's session epoch when sealed (workspaces): "Sign out everywhere" moves it on. */
  ep?: number;
  /** The team workspace in use, by its id (`team:<id>`), with team workspaces; never with `org`. */
  team?: string;
  /** Addresses GitHub verified, kept only for the invitation being opened: at most its own. */
  em?: string[];
}

interface Organization {
  id: string;
  login: string;
  /** The person's role in it, read at sign-in: owners are `admin`. Older sessions have none: members. */
  role?: 'admin' | 'member';
}

/** Served organizations one session lists at most: the session is a cookie of at most 4 KB. */
const MAX_SESSION_ORGANIZATIONS = 20;
const ORGANIZATION_ID = /^[1-9]\d{0,19}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Tagged template that escapes every interpolated value unless it is already `Html`. */
class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}
function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  values.forEach((value, index) => {
    const parts = Array.isArray(value) ? value : [value];
    for (const part of parts) {
      out += part instanceof Html ? part.value : escapeHtml(String(part ?? ''));
    }
    out += strings[index + 1] ?? '';
  });
  return new Html(out);
}

/** Days of bookings the overview shows, how many it reads and lists, and its activity's length. */
const AGENDA_DAYS = 7;
const AGENDA_LIMIT = 200;
const AGENDA_SHOWN = 30;
const ACTIVITY_LIMIT = 20;
const WAITLIST_SHOWN = 200;
/** Approvals the dashboard lists, pending and recent decided together, newest first. */
const APPROVALS_SHOWN = 100;
const RESOURCE_PAGE = /^\/resources\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** How the booking rules form names each rule. */
const RULE_LIMITS = SLOTLOCK_BOOKING_RULE_LIMITS;
const RULE_NAMES = Object.freeze({
  minNoticeMinutes: 'Minimum notice',
  maxAdvanceDays: 'Book up to',
  slotStepMinutes: 'Start step',
  stepOffsetMinutes: 'Step offset',
  bufferBeforeMinutes: 'Buffer before',
  turnaroundMinutes: 'Turnaround',
  checkInMinutes: 'Check-in release',
  minDurationMinutes: 'Shortest booking',
  maxDurationMinutes: 'Longest booking',
  defaultDurationMinutes: 'Usual length',
  cancelCutoffMinutes: 'Cancel cutoff',
  rescheduleCutoffMinutes: 'Move cutoff',
} as const);
/** The booking rules form's fields, by rule. */
const RULE_FIELDS = Object.freeze({
  minNoticeMinutes: 'min_notice_minutes',
  maxAdvanceDays: 'max_advance_days',
  slotStepMinutes: 'slot_step_minutes',
  stepOffsetMinutes: 'step_offset_minutes',
  bufferBeforeMinutes: 'buffer_before_minutes',
  turnaroundMinutes: 'turnaround_minutes',
  checkInMinutes: 'check_in_minutes',
  minDurationMinutes: 'min_duration_minutes',
  maxDurationMinutes: 'max_duration_minutes',
  defaultDurationMinutes: 'default_duration_minutes',
  cancelCutoffMinutes: 'cancel_cutoff_minutes',
  rescheduleCutoffMinutes: 'reschedule_cutoff_minutes',
} as const);

/** How the inherited-rules note names each rule, with its unit. */
const INHERITED_NAMES: Readonly<Record<keyof SlotlockBookingRules, string>> = Object.freeze({
  ...RULE_NAMES,
  maxAdvanceDays: 'Book up to (days ahead)',
  enforceHours: 'Only inside bookable hours',
  requireCertain: 'Only in time its calendar syncs have read today',
  allowedDurations: 'Lengths (min)',
  pickupTimes: 'Pick-up times',
  returnTimes: 'Return times',
  cancellationFee: 'Cancellation fee',
  hoursApply: 'Hours hold a hire at',
});

type RuleValue =
  | number
  | boolean
  | string
  | readonly number[]
  | readonly { startMinutes: number; durationMinutes: number }[]
  | { amountMinor: number; currency: string; withinMinutes?: number };
type InheritedRules = Map<keyof SlotlockBookingRules, { value: RuleValue; from: string }>;

/** A rule's value as the dashboard shows it. */
function ruleValueText(value: RuleValue): string {
  if (typeof value === 'number') return value.toLocaleString('en');
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'string') return value === 'ends' ? 'its start and end' : 'all of it';
  if (!Array.isArray(value)) {
    const fee = value as { amountMinor: number; currency: string; withinMinutes?: number };
    return `${(fee.amountMinor / 100).toFixed(2)} ${fee.currency}${fee.withinMinutes !== undefined ? ` within ${fee.withinMinutes.toLocaleString('en')} min` : ''}`;
  }
  return (value as readonly (number | { startMinutes: number; durationMinutes: number })[])
    .map((item) => (typeof item === 'number' ? item.toLocaleString('en') : hoursOf(item.startMinutes, item.durationMinutes)))
    .join(', ');
}

/**
 * The rules a resource takes from defaults, each with where it comes from: a rule its pool's
 * defaults set, else one the tenant's set, where its own rules do not. Without the defaults, the
 * rules that apply less its own, from "defaults".
 */
function inheritedRules(resource: SlotlockResource, defaults: SlotlockBookingRuleDefaults | undefined): InheritedRules {
  const own = resource.bookingRules ?? {};
  const levels: [string, SlotlockBookingRules | null | undefined][] = defaults
    ? [
        ['every resource', defaults.tenant],
        [`pool ${resource.pool ?? ''}`, resource.pool === undefined ? undefined : defaults.pools[resource.pool]],
      ]
    : [['defaults', resource.effectiveBookingRules]];
  const inherited: InheritedRules = new Map();
  for (const [from, rules] of levels) {
    for (const [name, value] of Object.entries(rules ?? {}) as [keyof SlotlockBookingRules, RuleValue][]) {
      if (own[name] === undefined) inherited.set(name, { value, from });
    }
  }
  return inherited;
}

function inheritedNote(inherited: InheritedRules): Html {
  if (inherited.size === 0) return html``;
  const parts = [...inherited].map(([name, { value, from }]) =>
    typeof value === 'boolean'
      ? `${INHERITED_NAMES[name]}${value ? '' : ': off'} (${from})`
      : `${INHERITED_NAMES[name]} ${ruleValueText(value)} (${from})`,
  );
  return html`<p class="fine">Inherited: ${parts.join('; ')}.</p>`;
}

const icon = (paths: string) =>
  new Html(
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`,
  );
const ICONS = Object.freeze({
  mark: new Html(
    // The Slotlock mark: a padlock whose body holds one booked slot (the site's logo, without the wordmark).
    '<svg class="mark" viewBox="0 0 85.32 77.12" aria-hidden="true" focusable="false"><path class="mark-ink" d="M13.13 34.46L72.2 34.46C79.45 34.46 85.32 40.33 85.32 47.58L85.32 63.99C85.32 71.24 79.45 77.12 72.2 77.12L13.13 77.12C5.88 77.12 0 71.24 0 63.99L0 47.58C0 40.33 5.88 34.46 13.13 34.46ZM22.97 39.38L22.97 19.69C22.97 8.82 31.79 0 42.66 0C53.54 0 62.35 8.82 62.35 19.69L62.35 39.38L56.61 39.38L56.61 19.69C56.61 11.99 50.36 5.74 42.66 5.74C34.96 5.74 28.71 11.99 28.71 19.69L28.71 39.38Z"></path><path class="mark-slot" d="M19.69 52.51L65.63 52.51C67.45 52.51 68.91 53.98 68.91 55.79C68.91 57.6 67.45 59.07 65.63 59.07L19.69 59.07C17.88 59.07 16.41 57.6 16.41 55.79C16.41 53.98 17.88 52.51 19.69 52.51Z"></path></svg>',
  ),
  overview: icon('<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z"/>'),
  resources: icon('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  keys: icon('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>'),
  waitlist: icon('<path d="M4 6h16M4 12h10M4 18h6"/><circle cx="18" cy="16" r="3"/>'),
  webhooks: icon('<path d="M9 7a3 3 0 1 1 4 2.8L16 15M6.5 13.5A3 3 0 1 0 9 18h6M15 18a3 3 0 1 0 1.5-5.6"/>'),
  assistant: icon('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'),
  plan: icon('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>'),
  teams: icon('<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3.3 2.7-5 6-5s6 1.7 6 5M15 14.5c3 0 6 1.4 6 4.5"/>'),
  settings: icon(
    '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  ),
  check: icon('<path d="M5 12l5 5L20 7"/>'),
  approvals: icon('<circle cx="12" cy="12" r="8"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>'),
  signOut: icon('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  google: new Html(
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path class="fill" d="M15.68 8.18c0-.57-.05-1.11-.15-1.64H8v3.1h4.3a3.68 3.68 0 0 1-1.6 2.41v2h2.58c1.51-1.39 2.4-3.44 2.4-5.87zM8 16c2.16 0 3.97-.72 5.29-1.94l-2.58-2c-.72.48-1.63.76-2.71.76-2.08 0-3.85-1.41-4.48-3.3H.86v2.07A8 8 0 0 0 8 16zM3.52 9.52a4.8 4.8 0 0 1 0-3.04V4.41H.86a8 8 0 0 0 0 7.18zM8 3.18c1.17 0 2.23.4 3.06 1.2l2.29-2.3A8 8 0 0 0 .86 4.41l2.66 2.07C4.15 4.59 5.92 3.18 8 3.18z"/></svg>',
  ),
  github: new Html(
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path class="fill" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  ),
});

/** How the dashboard names each kind of resource. */
const KIND_NAMES: Readonly<Record<SlotlockResourceKind, string>> = Object.freeze({
  person: 'Person',
  room: 'Room',
  desk: 'Desk',
  space: 'Space',
  vehicle: 'Vehicle',
  machine: 'Machine',
  equipment: 'Equipment',
  service: 'Service',
  other: 'Not said',
});

/** What a profile field it could not keep must be, in a person's words. */
const PROFILE_PROBLEMS = Object.freeze({
  name: `A name is 1 to ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.name} characters on one line.`,
  description: `A description is at most ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.description.toLocaleString('en')} characters.`,
  kind: 'Choose a kind from the list.',
  capacity: `Capacity is a whole number from 1 to ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.capacity.toLocaleString('en')}. Leave it empty for none.`,
  labels: `Up to ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.labels} labels, each 1 to 64 letters, digits, dots, dashes or underscores.`,
  attributes: 'Those attributes are not ones Slotlock can keep.',
  other: 'That profile is not one Slotlock can keep.',
});

const GROUPING_REF_RULE =
  'A reference is 1 to 100 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.';
/** What a person is told when a location or group change is refused, by the store's code. */
const GROUPING_PROBLEMS: Readonly<Record<string, { status: number; text: string }>> = Object.freeze({
  location_ref: { status: 400, text: GROUPING_REF_RULE },
  location_name: { status: 400, text: `A name is 1 to ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.name} characters on one line.` },
  location_parent: { status: 400, text: 'Choose where it is from the list, or nowhere.' },
  location_timezone: {
    status: 400,
    text: 'A time zone is a name such as Europe/London. Leave it empty to take the one of the location it is in.',
  },
  location_other: { status: 400, text: 'That location is not one Slotlock can keep.' },
  location_not_found: { status: 404, text: 'That location is not one of yours.' },
  location_too_deep: { status: 409, text: `Locations go ${SLOTLOCK_MAX_LOCATION_DEPTH} levels deep at most.` },
  location_cycle: { status: 409, text: 'A location cannot be inside itself, or inside a location that is inside it.' },
  location_limit_reached: {
    status: 409,
    text: `You have ${SLOTLOCK_MAX_LOCATIONS.toLocaleString('en')} locations, the most there can be.`,
  },
  location_in_use: {
    status: 409,
    text: 'Move its resources, and the locations inside it, somewhere else first.',
  },
  group_ref: { status: 400, text: GROUPING_REF_RULE },
  group_name: { status: 400, text: `A name is 1 to ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.name} characters on one line.` },
  group_description: {
    status: 400,
    text: `A description is at most ${SLOTLOCK_RESOURCE_PROFILE_LIMITS.description.toLocaleString('en')} characters.`,
  },
  group_other: { status: 400, text: 'That group is not one Slotlock can keep.' },
  group_not_found: { status: 404, text: 'That group is not one of yours.' },
  group_limit_reached: {
    status: 409,
    text: `You have ${SLOTLOCK_MAX_RESOURCE_GROUPS.toLocaleString('en')} groups, the most there can be.`,
  },
  resource_group_limit_reached: {
    status: 409,
    text: `A resource is in ${SLOTLOCK_MAX_GROUPS_PER_RESOURCE} groups at most.`,
  },
});

/** The sentence for a refused location or group change, or null when it is not one. */
function groupingProblem(error: unknown): { status: number; text: string } | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'invalid_location' || code === 'invalid_group') {
    const kind = code === 'invalid_location' ? 'location' : 'group';
    const field = (error as { field?: unknown }).field;
    return GROUPING_PROBLEMS[`${kind}_${typeof field === 'string' ? field : 'other'}`] ?? GROUPING_PROBLEMS[`${kind}_other`] ?? null;
  }
  return typeof code === 'string' ? (GROUPING_PROBLEMS[code] ?? null) : null;
}

/** Each location's place from the top, as "London › Floor 3", by reference. */
function locationPaths(locations: readonly SlotlockLocation[]): Map<string, string> {
  const byRef = new Map(locations.map((location) => [location.ref, location]));
  const paths = new Map<string, string>();
  for (const location of locations) {
    const names: string[] = [];
    let at: SlotlockLocation | undefined = location;
    for (let steps = 0; at && steps <= SLOTLOCK_MAX_LOCATION_DEPTH; steps += 1) {
      names.unshift(at.name);
      at = at.parentRef === null ? undefined : byRef.get(at.parentRef);
    }
    paths.set(location.ref, names.join(' › '));
  }
  return paths;
}

/** Whether `ref` is `ancestor`, or a location inside it. */
function locationWithin(locations: ReadonlyMap<string, SlotlockLocation>, ref: string, ancestor: string): boolean {
  let at: string | null = ref;
  for (let steps = 0; at !== null && steps <= SLOTLOCK_MAX_LOCATION_DEPTH; steps += 1) {
    if (at === ancestor) return true;
    at = locations.get(at)?.parentRef ?? null;
  }
  return false;
}

/** The time zone a location gives a resource: its own, or the nearest one above it, and where from. */
function locationZone(
  locations: ReadonlyMap<string, SlotlockLocation>,
  location: SlotlockLocation,
): { timezone: string; from: SlotlockLocation } | null {
  let at: SlotlockLocation | undefined = location;
  for (let steps = 0; at && steps <= SLOTLOCK_MAX_LOCATION_DEPTH; steps += 1) {
    if (at.timezone !== null) return { timezone: at.timezone, from: at };
    at = at.parentRef === null ? undefined : locations.get(at.parentRef);
  }
  return null;
}

type Tone = 'good' | 'bad' | 'neutral';
/** How the overview names each change the feed records. */
const CHANGE_LABELS: Readonly<Record<string, { text: string; tone: Tone }>> = Object.freeze({
  'hold.created': { text: 'Hold placed', tone: 'neutral' },
  'hold.updated': { text: 'Hold changed', tone: 'neutral' },
  'hold.confirmed': { text: 'Hold booked', tone: 'good' },
  'hold.released': { text: 'Hold released', tone: 'neutral' },
  'hold.expired': { text: 'Hold expired', tone: 'neutral' },
  'reservation.created': { text: 'Booked', tone: 'good' },
  'reservation.updated': { text: 'Booking moved', tone: 'neutral' },
  'reservation.cancelled': { text: 'Booking cancelled', tone: 'bad' },
  'reservation.checked_in': { text: 'Checked in', tone: 'good' },
  'reservation.no_show': { text: 'No-show released', tone: 'bad' },
  'event.created': { text: 'Event added', tone: 'good' },
  'event.updated': { text: 'Event changed', tone: 'neutral' },
  'event.cancelled': { text: 'Event cancelled', tone: 'bad' },
  'event.timezone_shifted': { text: 'Event moved by a time zone change', tone: 'neutral' },
  'event.timezone_conflict': { text: 'Event clashes after a time zone change', tone: 'bad' },
  'coverage.stale': { text: 'Calendar sync is behind', tone: 'bad' },
  'waitlist.offered': { text: 'Waitlist offer sent', tone: 'good' },
  'waitlist.expired': { text: 'Waitlist offer lapsed', tone: 'neutral' },
  'approval.requested': { text: 'Waiting for approval', tone: 'neutral' },
  'approval.granted': { text: 'Approved and booked', tone: 'good' },
  'approval.declined': { text: 'Approval declined', tone: 'bad' },
  'approval.expired': { text: 'Approval not decided in time', tone: 'bad' },
  'webhook.disabled': { text: 'Webhook disabled', tone: 'bad' },
  'usage.threshold_reached': { text: 'Monthly quota nearly or fully used', tone: 'bad' },
  'usage.period_closed': { text: 'Month of use closed', tone: 'neutral' },
  'resource.created': { text: 'Resource added', tone: 'good' },
  'resource.updated': { text: 'Resource changed', tone: 'neutral' },
  'resource.archived': { text: 'Resource archived', tone: 'neutral' },
  'resource.restored': { text: 'Resource restored', tone: 'good' },
  'resource.deleted': { text: 'Resource deleted', tone: 'bad' },
  'key.created': { text: 'API key created', tone: 'good' },
  'key.rotated': { text: 'API key rotated', tone: 'neutral' },
  'key.revoked': { text: 'API key revoked', tone: 'bad' },
  'webhook.created': { text: 'Webhook added', tone: 'good' },
  'webhook.enabled': { text: 'Webhook enabled', tone: 'good' },
  'webhook.deleted': { text: 'Webhook deleted', tone: 'neutral' },
  'coverage.recorded': { text: 'Calendar synced', tone: 'neutral' },
  'coverage.deleted': { text: 'Calendar sync removed', tone: 'neutral' },
});

const zoned = (zone: string, parts: Intl.DateTimeFormatOptions) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...parts, timeZone: zone });
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...parts, timeZone: 'UTC' });
  }
};

/** `14:30` in the resource's own time zone. */
function clock(date: Date, zone: string): string {
  return zoned(zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** The day a time falls on in a zone: `Today`, `Tomorrow`, or `Thu 30 Oct`, with a key to group by. */
function dayLabel(date: Date, zone: string, nowMs: number): { key: string; label: string } {
  const key = (at: Date) =>
    zoned(zone, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  const day = key(date);
  if (day === key(new Date(nowMs))) return { key: day, label: 'Today' };
  if (day === key(new Date(nowMs + DAY_MS))) return { key: day, label: 'Tomorrow' };
  return {
    key: day,
    label: zoned(zone, { weekday: 'short', day: 'numeric', month: 'short' }).format(date),
  };
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`. */
function ago(date: Date, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - date.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1_440)} d ago`;
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right) && a === b;
}

/** Values remembered until they expire, the oldest dropped first past MAX_REMEMBERED. */
function remember(now: () => number) {
  const entries = new Map<string, number>();
  return {
    has(value: string): boolean {
      const expires = entries.get(value);
      if (expires === undefined) return false;
      if (expires > now()) return true;
      entries.delete(value);
      return false;
    },
    add(value: string, expires: number): void {
      entries.set(value, expires);
      if (entries.size <= MAX_REMEMBERED) return;
      for (const [key, until] of entries) {
        if (until <= now()) entries.delete(key);
      }
      for (const key of entries.keys()) {
        if (entries.size <= MAX_REMEMBERED) break;
        entries.delete(key);
      }
    },
  };
}

function readCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name === SESSION_COOKIE || name === SIGN_IN_COOKIE || name === INVITE_COOKIE) {
      cookies.set(name, part.slice(index + 1).trim());
    }
  }
  return cookies;
}

function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * A stylesheet or script. Pages link each with `?v=<hash of its content>`, so a versioned URL may be
 * cached for good and a new release is fetched at once; any other URL is revalidated.
 */
function asset(body: string, type: string, url: URL, version: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Cache-Control':
        url.searchParams.get('v') === version ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function formatDate(date: Date | null): string {
  if (!date) return '—';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A UTC day as people write it: `9 Dec 2026`. */
function dayOf(date: Date): string {
  return zoned('UTC', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** A table's date: the day (`19 Oct 2026`), with the full UTC time on hover and for machines. */
function dateCell(date: Date): Html {
  return html`<time datetime="${date.toISOString()}" title="${formatDate(date)}">${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}</time>`;
}

const WEEKDAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
});

function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `09:00–17:00`, `22:00–06:00 next day`, `all day`, or `from 09:00 for 2 d 2 h` beyond that. */
function hoursOf(startMinutes: number, durationMinutes: number): string {
  if (startMinutes === 0 && durationMinutes === 1_440) return 'all day';
  const end = startMinutes + durationMinutes;
  if (end <= 1_440) return `${formatMinutes(startMinutes)}–${formatMinutes(end)}`;
  if (end <= 2_880) return `${formatMinutes(startMinutes)}–${formatMinutes(end - 1_440)} next day`;
  const parts: Array<[number, string]> = [
    [Math.floor(durationMinutes / 1_440), 'd'],
    [Math.floor((durationMinutes % 1_440) / 60), 'h'],
    [durationMinutes % 60, 'min'],
  ];
  const length = parts.filter(([count]) => count > 0).map(([count, unit]) => `${count} ${unit}`);
  return `from ${formatMinutes(startMinutes)} for ${length.join(' ')}`;
}

/** `Mon–Fri`, `Sat, Sun`, `Mon, Wed`: three or more days in a row as a range. */
function dayNames(days: readonly string[]): string {
  const runs: string[][] = [];
  for (const day of days) {
    const run = runs.at(-1);
    const previous = WEEKDAYS.indexOf(run?.at(-1) as Weekday);
    if (run && previous >= 0 && WEEKDAYS.indexOf(day as Weekday) === previous + 1) run.push(day);
    else runs.push([day]);
  }
  const name = (day: string | undefined) => WEEKDAY_NAMES[day ?? ''] ?? day ?? '';
  return runs
    .map((run) =>
      run.length >= 3 ? `${name(run[0])}–${name(run.at(-1))}` : run.map(name).join(', '),
    )
    .join(', ');
}

const daysOf = (rrule: string) => dayNames((/BYDAY=([A-Z,]+)/.exec(rrule)?.[1] ?? '').split(','));

/**
 * One line for a resource's hours: the server's, closed, or its own. Days with the same windows
 * share a line; rules a week of windows cannot express are listed one by one.
 */
function hoursSummary(rules: readonly WeeklyAvailabilityRule[] | undefined): string {
  if (rules === undefined) return "Server's hours";
  if (rules.length === 0) return 'Closed';
  const week = rulesToWeeklyHours(rules);
  if (week === null) {
    return rules
      .map((rule) => `${daysOf(rule.rrule)} ${hoursOf(rule.startMinutes, rule.durationMinutes)}`)
      .join('; ');
  }
  const days = new Map<string, Weekday[]>();
  for (const day of WEEKDAYS) {
    if (week[day].length === 0) continue;
    const windows = week[day]
      .map(({ from, to }) => hoursOf(from, to > from ? to - from : to + 1_440 - from))
      .join(', ');
    days.set(windows, [...(days.get(windows) ?? []), day]);
  }
  return [...days].map(([windows, byDay]) => `${dayNames(byDay)} ${windows}`).join('; ');
}

type HoursMode = 'server' | 'closed' | 'custom';
/** The editor's fields as typed: two windows a day, each an opening and a closing `HH:MM`. */
type WeekForm = Record<Weekday, { from: string; to: string }[]>;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WINDOW_NAMES = ['first', 'second'] as const;

function emptyWeekForm(): WeekForm {
  const form = {} as WeekForm;
  for (const day of WEEKDAYS) form[day] = WINDOW_NAMES.map(() => ({ from: '', to: '' }));
  return form;
}

function weekFormOf(week: WeeklyHours | null): WeekForm {
  const form = emptyWeekForm();
  if (!week) return form;
  for (const day of WEEKDAYS) {
    week[day].forEach((window, index) => {
      form[day][index] = { from: formatMinutes(window.from), to: formatMinutes(window.to) };
    });
  }
  return form;
}

function readWeekForm(form: URLSearchParams): WeekForm {
  const week = emptyWeekForm();
  for (const day of WEEKDAYS) {
    WINDOW_NAMES.forEach((_name, index) => {
      const field = (end: string) =>
        (form.get(`${day.toLowerCase()}_${end}_${index + 1}`) ?? '').trim().slice(0, 16);
      week[day][index] = { from: field('from'), to: field('to') };
    });
  }
  return week;
}

/** The week typed, or `invalid_availability` naming the day and window that cannot be read. */
function weekFromForm(form: WeekForm): WeeklyHours {
  const invalid = (message: string) =>
    Object.assign(new Error(message), { code: 'invalid_availability' });
  const week: WeeklyHours = { MO: [], TU: [], WE: [], TH: [], FR: [], SA: [], SU: [] };
  for (const day of WEEKDAYS) {
    form[day].forEach(({ from, to }, index) => {
      if (from === '' && to === '') return;
      const name = `${DAY_NAMES[day]}'s ${WINDOW_NAMES[index]} window`;
      if (from === '' || to === '') {
        throw invalid(`Give ${name} both an opening and a closing time.`);
      }
      const [opens, closes] = [TIME.exec(from), TIME.exec(to)];
      if (!opens || !closes) throw invalid(`${name} needs times like 09:30.`);
      week[day].push({
        from: Number(opens[1]) * 60 + Number(opens[2]),
        to: Number(closes[1]) * 60 + Number(closes[2]),
      });
    });
  }
  return week;
}

/** Minutes after midnight for `HH:MM`, or null. */
function minutesOf(value: string): number | null {
  const match = TIME.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * A resource's hours in one line: its own, or what it inherits and from where (RFC 0004 B2), or the
 * server's.
 */
function resourceHours(resource: SlotlockResource, server: readonly WeeklyAvailabilityRule[]): string {
  if (resource.availabilityRules !== undefined) return hoursSummary(resource.availabilityRules);
  const inherited = resource.inheritedAvailability;
  if (inherited) {
    const from = inherited.source === 'location' ? `${inherited.location ?? 'Location'}'s hours` : 'Your hours';
    return `${from}: ${hoursSummary(inherited.rules)}`;
  }
  return server.length === 0 ? "Server's hours (none)" : `Server's hours: ${hoursSummary(server)}`;
}

export function createSlotlockDashboard(options: SlotlockDashboardOptions): SlotlockDashboard {
  const publicUrl = new URL(options.publicUrl);
  const origin = publicUrl.origin;
  const base = publicUrl.pathname.replace(/\/$/, '');
  const root = `${base}/dashboard`;
  const callbackUrl = `${origin}${root}/callback`;
  const publicRoot = `${origin}${root}`;
  const contentSecurityPolicy = policyFor(options.billing);
  // Its cookies are Secure, but a first visit over http:// could still be answered by someone else:
  // a browser that has seen this goes straight to https:// for a year. Not for a local http one.
  const hsts: Record<string, string> =
    publicUrl.protocol === 'https:' ? { 'Strict-Transport-Security': 'max-age=31536000' } : {};
  const service = new URL(options.serviceUrl ?? options.publicUrl);
  const serviceRoot = `${service.origin}${service.pathname.replace(/\/$/, '')}`;
  const mcpUrl = `${serviceRoot}/mcp`;
  const a2aUrl = `${serviceRoot}/a2a`;
  const authorizeUrl = options.github.authorizeUrl ?? 'https://github.com/login/oauth/authorize';
  const tokenUrl = options.github.tokenUrl ?? 'https://github.com/login/oauth/access_token';
  const userUrl = options.github.userUrl ?? 'https://api.github.com/user';
  const membershipsUrl =
    options.github.membershipsUrl ??
    'https://api.github.com/user/memberships/orgs?state=active&per_page=100';
  const served = Array.isArray(options.organizations) ? new Set<string>(options.organizations) : null;
  if (served && (served.size === 0 || [...served].some((id) => !ORGANIZATION_ID.test(id)))) {
    throw new Error('Slotlock dashboard organizations must be GitHub organization ids');
  }
  // Teams on Cloud: organizations turned on in the database, beside every person's own tenant.
  const teams = options.organizations === 'enabled' ? (options.teams ?? null) : null;
  const workspaces = options.workspaces ?? null;
  // Team workspaces: with the membership store's database, where people have workspaces of their own.
  const teamStore = options.teamWorkspaces && !served ? (workspaces?.teams ?? null) : null;
  /** Each session's role in the workspace it acts in, as the database said when it was read. */
  const roles = new WeakMap<Session, SlotlockWorkspaceRole>();
  /** Where each request came from, for the audit log. */
  const origins = new WeakMap<Session, { ipAddress?: string; userAgent?: string }>();
  // Plans whether or not billing sells them; billing's own reader when only it is given.
  const plans: SlotlockDashboardPlans | undefined =
    options.plans ??
    (options.billing
      ? {
          plan: options.billing.plan,
          ...(options.billing.enrol ? { enrol: options.billing.enrol } : {}),
          contact: options.billing.contact,
        }
      : undefined);
  if (plans?.contact) {
    const protocol = new URL(plans.contact).protocol;
    if (protocol !== 'https:' && protocol !== 'mailto:') throw new Error('plans.contact must be an https or mailto URL');
  }
  if (options.organizations === 'enabled' && !teams) {
    throw new Error('Slotlock dashboard organizations "enabled" needs the teams store');
  }
  /** Sign-in reads the person's organizations: a fixed list, or those turned on. */
  const readsOrganizations = served !== null || teams !== null;
  /** Each session's organizations turned on, read with it (teams mode). */
  const enabledOf = new WeakMap<Session, ReadonlySet<string>>();
  /** The team workspaces the session's person is a member of, read with their standing. */
  const teamListOf = new WeakMap<Session, readonly SlotlockTeamWorkspace[]>();
  /** When the session's team, being deleted, goes. */
  const deletingOf = new WeakMap<Session, Date>();
  const brandName = options.name ?? 'Slotlock';
  if (!SLOTLOCK_DASHBOARD_NAME_PATTERN.test(brandName) || brandName.trim() !== brandName) {
    throw new Error('Slotlock dashboard name must be 1-60 characters, without <, > or control or invisible characters');
  }
  for (const [label, url] of [
    ['termsUrl', options.termsUrl],
    ['privacyUrl', options.privacyUrl],
  ] as const) {
    if (url !== undefined && !/^https:\/\/[^\s"'<>`]+$/.test(url)) {
      throw new Error(`Slotlock dashboard ${label} must be an https URL`);
    }
  }
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  if (Buffer.byteLength(options.sessionSecret, 'utf8') < 32) {
    throw new Error('Slotlock dashboard sessionSecret must be at least 32 bytes');
  }
  const secret = Buffer.from(options.sessionSecret, 'utf8');
  // A list, or exactly '*': any other string would match ids by substring.
  // A GitHub person by their bare id, a Google one as google:<subject>.
  const allowed = (uid: string, idp?: 'google') =>
    options.allowedUsers === '*' ||
    (Array.isArray(options.allowedUsers) && options.allowedUsers.includes(idp === 'google' ? `google:${uid}` : uid));
  const google = served ? null : (options.google ?? null);
  let signInsInFlight = 0;
  /** Sign-ins in flight by client address. */
  const signInsByClient = new Map<string, number>();

  function report(message: string): void {
    try {
      ignoreRejection(options.onError?.(new Error(message)));
    } catch {
      // A failing reporter must not change the response.
    }
  }

  /** The workspace a form is bound to: its organization's id, `team:<id>`, or '' for one's own. */
  function workspaceKeyOf(session: Session): string {
    return session.team !== undefined ? `team:${session.team}` : (session.org ?? '');
  }
  // Bound to the workspace too: a page opened before a switch cannot write into the new one.
  const formMac = (session: Session, nonce: string, org = workspaceKeyOf(session)) =>
    createHmac('sha256', secret)
      .update(`slotlock-dashboard-form-v2.${session.sid}.${org}.${nonce}`)
      .digest('base64url');
  /** Random, and bound to the session by a MAC: a made-up or another session's value is refused unwritten. */
  const formNonce = (session: Session) => {
    const nonce = randomBytes(18).toString('base64url');
    return `${nonce}.${formMac(session, nonce)}`;
  };
  /** `ok`, `other_org` for a form from a page of another of the session's organizations, else `bad`. */
  const checkFormNonce = (session: Session, once: string): 'ok' | 'other_org' | 'bad' => {
    const match = FORM_NONCE.exec(once);
    if (match === null) return 'bad';
    const [, nonce, mac] = match as unknown as [string, string, string];
    // Compared as text, like the cookie MACs: decoding would drop the last character's spare bits.
    if (safeEqual(mac, formMac(session, nonce))) return 'ok';
    const current = workspaceKeyOf(session);
    const others = [
      ...(session.orgs ?? []).map((org) => org.id),
      ...(teamListOf.get(session) ?? []).map((ws) => ws.tenantRef),
      ...(teamStore ? [''] : []),
    ].filter((other) => other !== current);
    return others.some((other) => safeEqual(mac, formMac(session, nonce, other))) ? 'other_org' : 'bad';
  };

  function seal(context: string, payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const mac = createHmac('sha256', secret).update(`${context}.${body}`).digest('base64url');
    return `${body}.${mac}`;
  }

  function unseal(context: string, value: string | undefined): Record<string, unknown> | null {
    if (value === undefined || value.length > MAX_COOKIE_CHARACTERS) return null;
    const [body, mac, ...rest] = value.split('.');
    if (!body || !mac || rest.length > 0 || !BASE64URL.test(body) || !BASE64URL.test(mac)) {
      return null;
    }
    // Compared as text: decoding would drop the two spare bits of the last character, so three
    // other spellings of the same MAC would pass.
    const expected = Buffer.from(
      createHmac('sha256', secret).update(`${context}.${body}`).digest('base64url'),
    );
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!isRecord(payload) || typeof payload.exp !== 'number' || payload.exp <= now()) return null;
    return payload;
  }

  async function readSession(request: Request): Promise<Session | null> {
    const payload = unseal(
      'slotlock-dashboard-session-v1',
      readCookies(request).get(SESSION_COOKIE),
    );
    if (
      !payload ||
      typeof payload.uid !== 'string' ||
      typeof payload.login !== 'string' ||
      typeof payload.sid !== 'string' ||
      (payload.idp !== undefined && (payload.idp !== 'google' || !google)) ||
      !allowed(payload.uid, payload.idp as 'google' | undefined) ||
      !organizationsHold(payload) ||
      !teamHolds(payload) ||
      (payload.env !== undefined && payload.env !== 'test') ||
      (await options.state.sessionEnded(payload.sid, payload.exp as number))
    ) {
      return null;
    }
    let session = payload as unknown as Session;
    if (teams) {
      // Which of the person's organizations are on now: one turned off since is left at once.
      const enabled = session.orgs?.length ? await teams.enabled(session.orgs.map((org) => org.id)) : new Set<string>();
      if (session.org !== undefined && !enabled.has(session.org)) {
        const { org: _, ...personal } = session;
        session = personal;
      }
      enabledOf.set(session, enabled);
    }
    return await withStanding(session);
  }

  /**
   * The session with the person's role in its workspace as the database says now (workspaces): one
   * signed out everywhere since it was sealed is refused, and one whose membership ended falls back
   * to the person's own workspace or, where there is none (a fixed list of organizations), ends.
   */
  async function withStanding(session: Session): Promise<Session | null> {
    if (!workspaces) {
      roles.set(session, derivedRole(session));
      return session;
    }
    const person = personOf(session);
    const [standing, listed, alive, deleting] = await Promise.all([
      workspaces.standing(tenantOf(session), person),
      teamStore ? teamStore.workspacesOf(person) : Promise.resolve([]),
      workspaces.sessions ? workspaces.sessions.seen(person, session.sid) : Promise.resolve(true),
      teamStore && session.team !== undefined ? teamStore.deleteAfter(`team:${session.team}`) : Promise.resolve(null),
    ]);
    if (deleting) deletingOf.set(session, deleting);
    // Sealed under the person's current epoch, or refused: one from before Sign out everywhere,
    // from before this store, or of a person erased since (no record, no epoch) never passes; nor
    // one the person signed out from another device.
    if (!alive || session.ep === undefined || standing.sessionEpoch === null || session.ep !== standing.sessionEpoch) return null;
    if (standing.role !== null) {
      roles.set(session, standing.role);
      teamListOf.set(session, listed);
      return session;
    }
    if ((session.org === undefined && session.team === undefined) || served) return null;
    const { org: _, team: _team, ...personal } = session;
    const enabled = enabledOf.get(session);
    if (enabled) enabledOf.set(personal, enabled);
    teamListOf.set(personal, listed);
    roles.set(personal, 'owner');
    return personal;
  }

  /** A team workspace only with team workspaces on, never beside an organization; addresses as kept. */
  function teamHolds(payload: Record<string, unknown>): boolean {
    if (
      payload.team !== undefined &&
      (!teamStore || typeof payload.team !== 'string' || !TEAM_ID.test(payload.team) || payload.org !== undefined)
    ) {
      return false;
    }
    if (payload.em === undefined) return true;
    return (
      Array.isArray(payload.em) &&
      payload.em.length <= 3 &&
      payload.em.every((email) => typeof email === 'string' && email.length <= 254)
    );
  }

  /** A workspace people share (an organization's or a team's), not a person's own. */
  const sharedWorkspace = (session: Session) => session.org !== undefined || session.team !== undefined;
  /** The team workspace the session acts in (`team:<id>`, Live), or undefined. */
  const teamTenantOf = (session: Session) => (session.team !== undefined ? `team:${session.team}` : undefined);
  const currentTeam = (session: Session) =>
    session.team === undefined ? undefined : teamListOf.get(session)?.find((ws) => ws.tenantRef === `team:${session.team}`);
  /** Addresses the person holds verified: their Google account's, or those GitHub confirmed for an invitation. */
  const verifiedEmails = (session: Session): string[] =>
    session.idp === 'google' ? (session.login.includes('@') ? [session.login.toLowerCase()] : []) : (session.em ?? []);

  /**
   * Without a membership store: the Owner of one's own workspace; in an organization's, its GitHub
   * owners are Owners and its other members Developers, as GitHub said at sign-in.
   */
  function derivedRole(session: Session): SlotlockWorkspaceRole {
    if (session.org === undefined) return 'owner';
    return session.orgs?.find((org) => org.id === session.org)?.role === 'admin' ? 'owner' : 'developer';
  }
  const roleOf = (session: Session): SlotlockWorkspaceRole => roles.get(session) ?? derivedRole(session);
  const can = (session: Session, capability: SlotlockWorkspaceCapability) => slotlockRoleCan(roleOf(session), capability);
  /** Signed in within the last 15 minutes: what a fresh capability needs. */
  const freshlySignedIn = (session: Session) => now() - (session.exp - SESSION_TTL_MS) <= FRESH_SIGN_IN_MS;

  /**
   * With organizations, the session names one the server still serves, from its own list; without
   * them, it names none. A session from the other mode is signed out.
   */
  function organizationsHold(payload: Record<string, unknown>): boolean {
    if (teams) {
      if (payload.orgs === undefined) return payload.org === undefined;
      if (!Array.isArray(payload.orgs)) return false;
      const listed = (payload.orgs as unknown[]).filter(
        (org): org is Organization => isRecord(org) && typeof org.id === 'string' && typeof org.login === 'string',
      );
      return payload.org === undefined || (typeof payload.org === 'string' && listed.some((org) => org.id === payload.org));
    }
    if (!served) return payload.org === undefined && payload.orgs === undefined;
    if (typeof payload.org !== 'string' || !served.has(payload.org) || !Array.isArray(payload.orgs)) {
      return false;
    }
    return (payload.orgs as unknown[]).some(
      (org) => isRecord(org) && org.id === payload.org && typeof org.login === 'string',
    );
  }

  const csrfToken = (session: Session) =>
    createHmac('sha256', secret)
      .update(`slotlock-dashboard-csrf-v1.${session.sid}`)
      .digest('base64url');
  /** The tenant the session acts in: the workspace's, or its test environment's (`~test`). */
  const tenantOf = (session: Session) =>
    `${
      session.team !== undefined
        ? `team:${session.team}`
        : session.org !== undefined
          ? `github-org:${session.org}`
          : personOf(session)
    }${session.env === 'test' ? SLOTLOCK_TEST_TENANT_SUFFIX : ''}`;
  /** Who did something, for the record: the person, whatever tenant they act in. */
  function personOf(session: Session): string {
    return session.idp === 'google' ? `google:${session.uid}` : `github:${session.uid}`;
  }
  /** How the dashboard shows the person: their GitHub login, or their Google account's email. */
  const shownAs = (session: Session) => (session.idp === 'google' ? session.login : `@${session.login}`);

  function respond(
    status: number,
    body: string | Html,
    headers: Record<string, string> = {},
    cookies: string[] = [],
  ): Response {
    const response = new Response(String(body), {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': contentSecurityPolicy,
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': REFERRER_POLICY,
        'Cross-Origin-Opener-Policy': 'same-origin',
        ...hsts,
        ...headers,
      },
    });
    for (const value of cookies) response.headers.append('Set-Cookie', value);
    return response;
  }

  const redirect = (status: number, location: string, cookies: string[] = []) =>
    respond(status, '', { Location: location }, cookies);

  type Section =
    | 'overview'
    | 'resources'
    | 'waitlist'
    | 'approvals'
    | 'keys'
    | 'webhooks'
    | 'assistant'
    | 'plan'
    | 'teams'
    | 'settings';
  // Pages for what the adapter offers, so a custom one without a waitlist shows none. Read per
  // request: on Workers the adapter exists only inside one.
  const nav = (): ReadonlyArray<{ section: Section; label: string; path: string; icon: Html }> => [
    { section: 'overview', label: 'Overview', path: '', icon: ICONS.overview },
    { section: 'resources', label: 'Resources', path: '/resources', icon: ICONS.resources },
    ...(options.resources.waitlist
      ? [{ section: 'waitlist' as const, label: 'Waitlist', path: '/waitlist', icon: ICONS.waitlist }]
      : []),
    ...(options.resources.approvals
      ? [{ section: 'approvals' as const, label: 'Approvals', path: '/approvals', icon: ICONS.approvals }]
      : []),
    { section: 'keys', label: 'API keys', path: '/keys', icon: ICONS.keys },
    ...(options.resources.webhooks
      ? [{ section: 'webhooks' as const, label: 'Webhooks', path: '/webhooks', icon: ICONS.webhooks }]
      : []),
    ...(assistantStore()
      ? [{ section: 'assistant' as const, label: 'Assistant', path: '/assistant', icon: ICONS.assistant }]
      : []),
    ...(plans ? [{ section: 'plan' as const, label: 'Usage', path: '/plan', icon: ICONS.plan }] : []),
    ...(teams || teamStore ? [{ section: 'teams' as const, label: 'Teams', path: '/teams', icon: ICONS.teams }] : []),
    { section: 'settings', label: 'Settings', path: '/settings', icon: ICONS.settings },
  ];

  /** Live or Test (RFC 0003 G9): the same workspace, a tenant of its own for trying things. */
  function environmentSwitch(session: Session): Html {
    const choice = (value: 'live' | 'test', label: string) =>
      html`<button type="submit" name="environment" value="${value}"${(session.env === 'test') === (value === 'test') ? html` aria-pressed="true"` : html` aria-pressed="false"`}>${label}</button>`;
    return html`<form class="environment" method="post" action="${root}/environment" aria-label="Environment"><input type="hidden" name="csrf" value="${csrfToken(session)}"><input type="hidden" name="once" value="${formNonce(session)}">${choice('live', 'Live')}${choice('test', 'Test')}</form>`;
  }

  /** The workspace the session acts in: its organization, or the person themselves. */
  function workspace(session: Session): Html {
    const current = session.orgs?.find((org) => org.id === session.org);
    const team = currentTeam(session);
    const choices = (session.orgs ?? []).filter((org) => served?.has(org.id));
    const name = team?.name ?? current?.login ?? session.login;
    const badge = html`<span class="avatar" aria-hidden="true">${name.slice(0, 1).toUpperCase()}</span>`;
    const enabled = teams ? (session.orgs ?? []).filter((org) => enabledOf.get(session)?.has(org.id)) : [];
    const listed = teamListOf.get(session) ?? [];
    if (enabled.length > 0 || listed.length > 0) {
      const personal = !current && !team;
      return html`<form class="workspace" method="post" action="${root}/organization">${badge}<input type="hidden" name="csrf" value="${csrfToken(session)}"><input type="hidden" name="once" value="${formNonce(session)}"><label class="visually-hidden" for="organization">Workspace</label><select id="organization" name="organization" title="${name}"><option value=""${personal ? html` selected` : html``}>${shownAs(session)}</option>${enabled.map((org) => html`<option value="${org.id}"${org.id === current?.id ? html` selected` : html``}>${org.login}</option>`)}${listed.map((ws) => html`<option value="${ws.tenantRef}"${ws.tenantRef === team?.tenantRef ? html` selected` : html``}>${ws.name}</option>`)}</select><button class="quiet" type="submit">Switch</button></form>`;
    }
    if (current && choices.length > 1) {
      return html`<form class="workspace" method="post" action="${root}/organization">${badge}<input type="hidden" name="csrf" value="${csrfToken(session)}"><input type="hidden" name="once" value="${formNonce(session)}"><label class="visually-hidden" for="organization">Organization</label><select id="organization" name="organization" title="${current.login}">${choices.map((org) => html`<option value="${org.id}"${org.id === current.id ? html` selected` : html``}>${org.login}</option>`)}</select><button class="quiet" type="submit">Switch</button></form>`;
    }
    const shown = current ? name : `@${name}`;
    return html`<div class="workspace">${badge}<span class="workspace-name" title="${shown}">${shown}</span></div>`;
  }

  function layout(title: string, content: Html, session: Session | null, section?: Section): Html {
    const head = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="${REFERRER_POLICY}">
<title>${title} · ${brandName}</title>
<link rel="icon" href="${root}/favicon.svg?v=${ASSET_VERSIONS.icon}" type="image/svg+xml">
<link rel="stylesheet" href="${root}/style.css?v=${ASSET_VERSIONS.css}">
<script src="${root}/app.js?v=${ASSET_VERSIONS.js}" defer></script>
</head>`;
    const brand = html`<a class="brand" href="${root}">${ICONS.mark}<span class="name">${brandName}</span></a>`;
    const skip = html`<a class="skip" href="#main">Skip to content</a>`;
    // Copy buttons say what they did here, for screen readers (app.js).
    const live = html`<p class="visually-hidden" id="live" aria-live="polite"></p>`;
    if (!session) {
      return html`${head}
<body class="bare">
${skip}
<header class="bare-bar">${brand}</header>
<main class="bare-main" id="main">${content}</main>
${live}
</body>
</html>`;
    }
    const links = nav()
      .filter((item) => can(session, SLOTLOCK_DASHBOARD_PAGE_CAPABILITIES[item.path || '/'] ?? 'workspace.read'))
      .map(
      (item) =>
        html`<a href="${root}${item.path}"${item.section === section ? html` aria-current="page"` : html``}>${item.icon}<span>${item.label}</span></a>`,
    );
    return html`${head}
<body>
${skip}
<div class="app">
<header class="side">
<div class="side-top">${brand}${workspace(session)}${environmentSwitch(session)}</div>
<nav class="nav" aria-label="Dashboard">${links}</nav>
<div class="me"><span class="avatar me-avatar" aria-hidden="true">${session.login.slice(0, 1).toUpperCase()}</span><span class="login" title="${shownAs(session)}">${shownAs(session)}</span><form method="post" action="${root}/sign-out"><input type="hidden" name="csrf" value="${csrfToken(session)}"><button class="quiet sign-out" type="submit" title="Sign out">${ICONS.signOut}<span class="sign-out-label">Sign out</span></button></form></div>
</header>
<main class="page" id="main">${
      session.env === 'test'
        ? html`<p class="test-banner">Test environment: its own resources, keys, webhooks and history, on your plan's limits and never billed. Its keys start <code>slk_test_</code>.</p>`
        : html``
    }${
      deletingOf.has(session)
        ? html`<p class="test-banner deleting-banner">This team is deleted on ${formatDate(deletingOf.get(session) as Date)}; its keys have stopped.${
            can(session, 'workspace.own') ? html` <a href="${root}/settings/team">Keep it</a>` : html``
          }</p>`
        : html``
    }${content}</main>
</div>
${live}
</body>
</html>`;
  }

  // A notice is an alert only when the page answers with an error: a done or saved message is a
  // status, so success is never painted in the error colour.
  const noticeOf = (notice?: string | Html, status = 200) =>
    notice
      ? status >= 400
        ? html`<p class="notice" role="alert">${notice}</p>`
        : html`<p class="notice done" role="status">${notice}</p>`
      : html``;

  function signedOutPage(status: number, notice?: string, cookies: string[] = []): Response {
    const content = html`<section class="sign-in">
<span class="sign-in-mark">${ICONS.mark}</span>
<h1>Sign in to ${brandName}</h1>
<p>Create keys for your agents, add what they book, and watch what they do.</p>
${noticeOf(notice, status)}
<a class="button primary wide" href="${root}/sign-in">${ICONS.github}Continue with GitHub</a>${
      google ? html`<a class="button wide" href="${root}/sign-in?with=google">${ICONS.google}Continue with Google</a>` : html``
    }
${
      options.termsUrl
        ? html`<p class="fine">By continuing you agree to the <a href="${options.termsUrl}">Terms of Service</a>.${
            options.privacyUrl
              ? html` The <a href="${options.privacyUrl}">Privacy notice</a> says what is kept.`
              : html``
          }</p>`
        : html``
    }
<p class="fine">${
      teams
        ? `${brandName} reads your GitHub profile and which organizations you belong to, and keeps only your user id, login and up to ${String(MAX_SESSION_ORGANIZATIONS)} of those organizations, for you to work in the ones turned on.`
        : served
        ? `${brandName} reads your GitHub profile and which organizations you belong to, and keeps only your user id, login and the organizations it serves.`
        : `${brandName} reads only your public GitHub profile, and keeps only your user id and login.`
    }${google ? ` With Google, it reads your account's id and email address, and keeps only those.` : ''}</p>
</section>`;
    return respond(status, layout('Sign in', content, null), {}, cookies);
  }

  /** A key's own limits (RFC 0004 A5) as fields, filled with what it has. */
  const keyLimitFields = (limits?: SlotlockApiKeyLimits) =>
    html`<label>Live holds at most<input name="max_holds" inputmode="numeric" pattern="[0-9]*" maxlength="5" value="${limits?.maxHolds !== undefined ? String(limits.maxHolds) : ''}" placeholder="Server's"></label>
<label>Hours held at most<input name="max_held_hours" inputmode="numeric" pattern="[0-9]*" maxlength="6" value="${limits?.maxHeldHours !== undefined ? String(limits.maxHeldHours) : ''}" placeholder="Server's"></label>
<label>Requests a minute<input name="requests_per_minute" inputmode="numeric" pattern="[0-9]*" maxlength="6" value="${limits?.requestsPerMinute !== undefined ? String(limits.requestsPerMinute) : ''}" placeholder="Server's"></label>
<label class="choice"><input type="checkbox" name="requires_approval" value="on"${limits?.requiresApproval ? html` checked` : html``}> Its bookings wait for approval</label>`;

  /** A key's limits in words, for its row. */
  const keyLimitsText = (limits: SlotlockApiKeyLimits) =>
    [
      limits.maxHolds !== undefined ? `${String(limits.maxHolds)} live holds` : '',
      limits.maxHeldHours !== undefined ? `${String(limits.maxHeldHours)} hours held` : '',
      limits.requestsPerMinute !== undefined ? `${String(limits.requestsPerMinute)} requests a minute` : '',
      limits.requiresApproval ? 'bookings need approval' : '',
    ]
      .filter(Boolean)
      .join(', ');

  function keyRows(keys: SlotlockApiKey[], token: string, session: Session, names: ReadonlyMap<string, string> = new Map()): Html[] {
    return keys.map((key) => {
      const expired = key.expiresAt !== null && key.expiresAt.getTime() <= now();
      const status = key.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active';
      const actions =
        status === 'Active'
          ? html`<details class="act"><summary>Limits</summary><div class="pop"><p>Hold this key below the server's limits. Empty is the server's.</p>
<form method="post" action="${root}/keys/limits"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${key.id}">${keyLimitFields(key.limits)}<button type="submit">Save limits</button></form></div></details>
<details class="act"><summary>Rotate</summary><div class="pop"><p>A new secret replaces this one at once. The key keeps its name, access and bookings.</p>
<form method="post" action="${root}/keys/rotate"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${key.id}"><button type="submit">Rotate key</button></form></div></details>
<details class="act danger"><summary>Revoke</summary><div class="pop"><p>Requests with this key fail at once. What it booked stays on the calendar.</p>
<form method="post" action="${root}/keys/revoke"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${key.id}"><button class="danger" type="submit">Revoke key</button></form></div></details>`
          : html``;
      return html`<tr>
<td data-label="Name" class="strong"><span class="cell"><span class="truncate" title="${key.name}">${key.name}</span>${sharedWorkspace(session) ? html`<span class="meta">Created by ${key.createdBy === personOf(session) ? 'you' : (key.createdBy && names.get(key.createdBy)) ?? (key.createdBy?.startsWith('github:') ? `GitHub user ${key.createdBy.slice(7)}` : key.createdBy?.startsWith('google:') ? 'a Google user' : 'someone unknown')}</span>` : html``}</span></td>
<td data-label="Key"><code class="chip">${key.prefix}…</code></td>
<td data-label="Access">${
        key.resourceScope || key.limits
          ? html`<span class="cell"><span>${accessOf(key)}</span>${key.resourceScope ? html`<span class="meta wrap">Only ${[...key.resourceScope.locations, ...key.resourceScope.groups.map((group) => `group ${group}`)].join(', ')}</span>` : html``}${key.limits ? html`<span class="meta wrap">At most ${keyLimitsText(key.limits)}</span>` : html``}</span>`
          : accessOf(key)
      }</td>
<td data-label="Created">${dateCell(key.createdAt)}</td>
<td data-label="Last used">${key.lastUsedAt ? dateCell(key.lastUsedAt) : html`<span class="muted">Never</span>`}</td>
<td data-label="Expires">${key.expiresAt ? dateCell(key.expiresAt) : html`<span class="muted">Never</span>`}</td>
<td data-label="Status"><span class="pill ${status.toLowerCase()}">${status}</span></td>
<td class="actions">${actions}</td>
</tr>`;
    });
  }

  const pageHead = (title: string, action?: Html) =>
    html`<header class="page-head"><h1>${title}</h1>${action ?? html``}</header>`;

  /** A list with nothing in it yet: what goes here, and the one thing to do next. */
  const emptyState = (glyph: Html, text: string, action?: { href: string; label: string }) =>
    html`<div class="empty-state"><span class="empty-icon">${glyph}</span><p class="empty">${text}</p>${
      action ? html`<a class="button" href="${action.href}">${ICONS.plus}${action.label}</a>` : html``
    }</div>`;

  /** A resource as people name it: its reference, else the start of its id. */
  // Its profile's name, else its reference, else the start of its id.
  const resourceName = (resource: SlotlockResource | undefined, id: string) =>
    resource?.name ?? resource?.externalRef ?? `${id.slice(0, 8)}…`;

  function agendaPanel(
    entries: readonly SlotlockAgendaEntry[],
    byId: ReadonlyMap<string, SlotlockResource>,
    more: boolean,
  ): Html {
    if (entries.length === 0) {
      return html`<p class="empty">Nothing booked in the next ${String(AGENDA_DAYS)} days.</p>`;
    }
    const zones = new Set(entries.map((entry) => byId.get(entry.resourceId)?.timezone ?? 'UTC'));
    const groups = new Map<string, { label: string; rows: Html[] }>();
    for (const entry of entries.slice(0, AGENDA_SHOWN)) {
      const resource = byId.get(entry.resourceId);
      const zone = resource?.timezone ?? 'UTC';
      const day = dayLabel(entry.start, zone, now());
      const group = groups.get(day.key) ?? { label: day.label, rows: [] };
      const name = resourceName(resource, entry.resourceId);
      // An event by its summary; a booking or hold by what it occupies, and a booking's own
      // reference when it is one a person chose (not the id Slotlock gave it).
      const title = entry.kind === 'event' ? (entry.summary ?? name) : name;
      const meta = [
        entry.kind === 'event' ? name : null,
        entry.reference && !UUID_PATTERN.test(entry.reference) ? entry.reference : null,
        zones.size > 1 ? zone : null,
        entry.source && !entry.source.startsWith('calendar-event:') ? entry.source : null,
      ].filter((part): part is string => part !== null);
      const pill =
        entry.kind === 'hold' && entry.expiresAt
          ? html`<span class="pill held">Held until ${clock(entry.expiresAt, zone)}</span>`
          : html`<span class="pill ${entry.kind}">${entry.kind === 'event' ? 'Event' : 'Booked'}</span>`;
      group.rows.push(html`<li class="slot"><span class="when">${clock(entry.start, zone)}<span class="until">${clock(entry.end, zone)}</span></span><span class="what" title="${[title, ...meta].join(' · ')}"><span class="title">${title}</span>${meta.length > 0 ? html`<span class="meta">${meta.join(' · ')}</span>` : html``}</span>${pill}</li>`);
      groups.set(day.key, group);
    }
    return html`${[...groups.values()].map(
      (group) => html`<h3 class="day">${group.label}</h3><ul class="slots">${group.rows}</ul>`,
    )}${more ? html`<p class="fine">Showing the first ${String(AGENDA_SHOWN)}.</p>` : html``}`;
  }

  /**
   * What each change says in the feed, as a sentence: who did it (`verb` then the resource), or what
   * happened (`passive`, the resource in place of {X}). Every change type the feed records has one,
   * so the feed never shows a raw type such as resource.updated.
   */
  const ACTIVITY: Readonly<Record<string, { verb?: string; after?: string; passive?: string }>> = Object.freeze({
    'hold.created': { verb: 'held' },
    'hold.updated': { verb: 'changed the hold on' },
    'hold.confirmed': { verb: 'booked', after: ' from a hold' },
    'hold.released': { verb: 'released the hold on' },
    'hold.expired': { passive: 'The hold on {X} expired' },
    'reservation.created': { verb: 'booked' },
    'reservation.updated': { verb: 'moved a booking on' },
    'reservation.cancelled': { verb: 'cancelled a booking on' },
    'reservation.checked_in': { verb: 'checked in to' },
    'reservation.no_show': { passive: '{X} was released after a no-show' },
    'event.created': { verb: 'added an event on' },
    'event.updated': { verb: 'changed an event on' },
    'event.cancelled': { verb: 'cancelled an event on' },
    'event.timezone_shifted': { passive: 'An event on {X} moved with a time zone change' },
    'event.timezone_conflict': { passive: 'An event on {X} clashes after a time zone change' },
    'coverage.stale': { passive: 'The calendar sync for {X} is behind' },
    'coverage.recorded': { passive: 'The calendar for {X} synced' },
    'coverage.deleted': { verb: 'removed the calendar sync for' },
    'waitlist.offered': { passive: 'A waitlist offer went out for {X}' },
    'waitlist.expired': { passive: 'A waitlist offer for {X} lapsed' },
    'approval.requested': { passive: 'A booking on {X} waits for approval' },
    'approval.granted': { verb: 'approved a booking on' },
    'approval.declined': { verb: 'declined a booking on' },
    'approval.expired': { passive: 'A booking on {X} was not approved in time' },
    'resource.created': { verb: 'added' },
    'resource.updated': { verb: 'edited' },
    'resource.archived': { verb: 'archived' },
    'resource.restored': { verb: 'restored' },
    'resource.deleted': { verb: 'deleted' },
    'key.created': { verb: 'created an API key' },
    'key.rotated': { verb: 'rotated an API key' },
    'key.revoked': { verb: 'revoked an API key' },
    'webhook.created': { verb: 'added a webhook' },
    'webhook.enabled': { verb: 'turned a webhook back on' },
    'webhook.disabled': { passive: 'A webhook was turned off' },
    'webhook.deleted': { verb: 'deleted a webhook' },
    'usage.period_closed': { passive: 'A month of use closed' },
  });
  /** Changes about a resource, which name it; the rest stand alone. */
  const ABOUT_A_RESOURCE = /^(hold|reservation|event|coverage|waitlist|approval|resource)\./;

  function activityPanel(
    changes: readonly SlotlockChange[],
    byId: ReadonlyMap<string, SlotlockResource>,
    keys: readonly SlotlockApiKey[],
    session: Session,
  ): Html {
    if (changes.length === 0) {
      return html`<p class="empty">No activity yet. What agents book, move and cancel shows here.</p>`;
    }
    const keyNames = new Map(keys.map((key) => [`api_key:${key.id}`, key.name]));
    const whoOf = (actor: string | null) =>
      actor === null
        ? brandName
        : actor === personOf(session)
          ? 'You'
          : (keyNames.get(actor) ??
            (actor.startsWith('api_key:')
              ? 'A deleted key'
              : /^github:\d+$/.test(actor)
                ? `GitHub user ${actor.slice(7)}`
                : /^google:/.test(actor)
                  ? 'A Google user'
                  : /^dashboard-assistant:(github|google):/.test(actor)
                    ? actor === assistantActor(session)
                      ? `Assistant for ${shownAs(session)}`
                      : actor.startsWith('dashboard-assistant:google:')
                        ? 'Assistant for a Google user'
                        : `Assistant for GitHub user ${actor.slice(27)}`
                    : actor.slice(0, 60)));
    // Repeats in a row (one actor, one change, one resource) read as one line with a count.
    const runs: { change: SlotlockChange; times: number }[] = [];
    for (const change of changes) {
      const last = runs.at(-1);
      if (last && last.change.actor === change.actor && last.change.type === change.type && last.change.resourceId === change.resourceId) {
        last.times += 1;
      } else {
        runs.push({ change, times: 1 });
      }
    }
    // Own entries only: a type such as `constructor` names nothing here.
    const own = <T,>(map: Readonly<Record<string, T>>, type: string) => (Object.hasOwn(map, type) ? map[type] : undefined);
    return html`<ol class="feed">${runs.map(({ change, times }) => {
      const tone = own(CHANGE_LABELS, change.type)?.tone ?? 'neutral';
      const where = change.resourceId ? resourceName(byId.get(change.resourceId), change.resourceId) : null;
      const object = where ?? (ABOUT_A_RESOURCE.test(change.type) ? 'a resource' : null);
      const words = own(ACTIVITY, change.type);
      let sentence: Html;
      if (change.type === 'usage.threshold_reached') {
        const metric = typeof change.data.metric === 'string' ? change.data.metric : 'use';
        const percent = typeof change.data.percent === 'number' ? change.data.percent : null;
        sentence = html`${percent === null ? 'A monthly quota' : `${String(percent)}% of this month's ${metric}`} used`;
      } else if (words?.verb) {
        sentence = html`<strong>${whoOf(change.actor)}</strong> ${words.verb}${object ? html` <strong>${object}</strong>` : html``}${words.after ?? ''}`;
      } else if (words?.passive) {
        const [before, rest] = words.passive.split('{X}') as [string, string | undefined];
        sentence = rest === undefined ? html`${before}` : html`${before}<strong>${object ?? 'a resource'}</strong>${rest}`;
      } else {
        // A change this dashboard has no words for (a newer server's): its label, never its type.
        const label = own(CHANGE_LABELS, change.type)?.text;
        sentence = label
          ? html`${label}${object ? html` <span class="on">on</span> <strong>${object}</strong>` : html``}`
          : html`Something changed${where ? html` on <strong>${where}</strong>` : html``}`;
      }
      return html`<li class="event"><span class="dot ${tone}" aria-hidden="true"></span><span class="what"><span class="title">${sentence}${
        times > 1 ? html` <span class="times">${times === 2 ? 'twice' : `${String(times)} times`}</span>` : html``
      }</span></span><time class="when" datetime="${change.occurredAt.toISOString()}" title="${formatDate(change.occurredAt)}">${ago(change.occurredAt, now())}</time></li>`;
    })}</ol>`;
  }

  /** The MCP and A2A endpoints with Copy, and the command that adds Slotlock to an MCP client. */
  const connectAgent = () =>
    html`${endpoints()}<details class="command"><summary>Claude Code command</summary><div class="copy-block"><pre><code id="mcp-command">claude mcp add --transport http slotlock ${mcpUrl} --header "Authorization: Bearer YOUR_KEY"</code></pre><button class="quiet" type="button" data-copy="mcp-command">Copy</button></div></details>`;

  async function overviewPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const tenantRef = tenantOf(session);
    const start = new Date(now());
    const window = { start, end: new Date(start.getTime() + AGENDA_DAYS * DAY_MS) };
    const assistant = assistantStore();
    const [keys, resources, agenda, changes, approvals, waitlist, model] = await Promise.all([
      options.keys.list({ tenantRef }),
      options.resources.list(tenantRef),
      options.resources.agenda?.(tenantRef, window, AGENDA_LIMIT),
      options.resources.recentChanges?.(tenantRef, ACTIVITY_LIMIT),
      options.resources.approvals?.list(tenantRef, APPROVALS_SHOWN),
      options.resources.waitlist?.list(tenantRef, WAITLIST_SHOWN),
      assistant?.getSettings(tenantRef),
    ]);
    // The plan is Live's: the test environment has none of its own.
    const standing = plans && session.env !== 'test' ? await planStanding(session, 'overview', keys) : null;
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    const active = keys.filter(
      (key) => !key.revokedAt && (key.expiresAt === null || key.expiresAt.getTime() > now()),
    );
    const counted = (count: number) =>
      agenda && agenda.length >= AGENDA_LIMIT ? `${count}+` : String(count);
    const booked = agenda?.filter((entry) => entry.kind !== 'hold').length ?? 0;
    const held = agenda?.filter((entry) => entry.kind === 'hold').length ?? 0;
    const waiting = approvals?.filter((approval) => approval.status === 'pending').length ?? 0;
    const attention = [
      ...(standing?.attention ?? []),
      ...(waiting > 0
        ? [
            attentionItem('info', `${String(waiting)} ${waiting === 1 ? 'booking waits' : 'bookings wait'} for your approval.`, {
              href: `${root}/approvals`,
              label: 'Review',
            }),
          ]
        : []),
    ];
    const admin = isAdmin(session);
    const steps: { done: boolean; title: string; action: { href: string; label: string } }[] = [
      { done: resources.length > 0, title: 'Add a resource', action: { href: `${root}/resources`, label: 'Add resource' } },
      { done: active.length > 0, title: 'Create an API key', action: { href: `${root}/keys#new-key`, label: 'Create key' } },
      // Done once an agent has used a key.
      { done: active.some((key) => key.lastUsedAt !== null), title: 'Connect an agent', action: { href: `${root}#connect`, label: 'Connect' } },
      ...(assistant
        ? [
            admin
              ? { done: Boolean(model), title: 'Connect a model to the assistant', action: { href: `${root}/settings`, label: 'Connect' } }
              : { done: Boolean(model), title: 'Try the assistant', action: { href: `${root}/assistant`, label: 'Open' } },
          ]
        : []),
    ];
    const done = steps.filter((step) => step.done).length;
    const next = steps.findIndex((step) => !step.done);
    // Nothing made and nothing happened yet: only the way in.
    const fresh = resources.length === 0 && active.length === 0 && (changes?.length ?? 0) === 0;
    const setupCard =
      next === -1
        ? html``
        : html`<section class="panel setup-card"><div class="panel-head"><h2>Get started</h2><span class="meta">${String(done)} of ${String(steps.length)}</span></div><div class="segments" aria-hidden="true">${steps.map(
            (step) => html`<span${step.done ? html` class="done"` : html``}></span>`,
          )}</div><ol class="setup-steps">${steps.map(
            (step, index) =>
              html`<li class="${step.done ? 'done' : index === next ? 'next' : ''}"><span class="check" aria-hidden="true">${step.done ? ICONS.check : html``}</span><span class="step-title">${step.title}${
                step.done ? html`<span class="visually-hidden"> (done)</span>` : html``
              }</span>${index === next ? html`<a class="button primary" href="${step.action.href}">${step.action.label}</a>` : html``}</li>`,
          )}</ol></section>`;
    // Mostly set up: one line that leads to the next step.
    const setupRow =
      next === -1
        ? html``
        : html`<a class="setup-row" href="${steps[next]?.action.href ?? root}"><span class="segments" aria-hidden="true">${steps.map(
            (step) => html`<span${step.done ? html` class="done"` : html``}></span>`,
          )}</span><span>Get started · ${String(done)} of ${String(steps.length)} · <strong>${steps[next]?.title ?? ''}</strong></span></a>`;
    const stat = (label: string, value: string, href: string, tone = '') =>
      html`<a class="stat${tone}" href="${href}"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></a>`;
    const tiles: Html[] = [
      ...(agenda ? [stat(`Bookings, next ${AGENDA_DAYS} days`, counted(booked), `${root}#upcoming`), stat('Live holds', counted(held), `${root}#upcoming`)] : []),
      ...(approvals ? [stat('Waiting for approval', String(waiting), `${root}/approvals`, waiting > 0 ? ' attention-stat' : '')] : []),
      ...(waitlist ? [stat('On the waitlist', String(waitlist.filter((entry) => entry.status !== 'expired').length), `${root}/waitlist`)] : []),
      stat('Resources', String(resources.length), `${root}/resources`),
      stat('Active keys', String(active.length), `${root}/keys`),
    ].slice(0, 4);
    const planCard = standing
      ? html`<section class="panel plan-card"><div class="panel-head"><h2>${standing.name}</h2><a href="${root}/plan">Usage</a></div><div class="meters stacked">${standing.meters}</div>${
          standing.canUpgrade && standing.pressing
            ? html`<a class="button primary" href="${root}/plan#upgrade">Upgrade</a>`
            : html``
        }</section>`
      : html``;
    const connectCard = html`<section class="panel" id="connect"><h2>Connect an agent</h2>${connectAgent()}</section>`;
    const body = fresh
      ? standing
        ? html`<div class="split">${setupCard}<div class="column">${planCard}</div></div>`
        : setupCard
      : html`${done * 2 >= steps.length ? setupRow : setupCard}
<div class="stats">${tiles}</div>
${session.env === 'test' && options.resources.sandbox ? sandboxPanel(session, resources.length) : html``}
<div class="split">
<div class="column">
${agenda ? html`<section class="panel" id="upcoming"><h2>Upcoming</h2>${agendaPanel(agenda, byId, agenda.length > AGENDA_SHOWN)}</section>` : html``}
${changes ? html`<section class="panel"><h2>Activity</h2>${activityPanel(changes, byId, keys, session)}</section>` : html``}
</div>
<div class="column">${planCard}${connectCard}</div>
</div>`;
    const content = html`${noticeOf(notice, status)}
${pageHead('Overview')}
${attentionList(attention)}
${fresh && session.env === 'test' && options.resources.sandbox ? sandboxPanel(session, resources.length) : html``}
${body}`;
    return respond(status, layout('Overview', content, session, 'overview'));
  }

  /** In Test: load a scenario to try an agent against, move waiting forward, or start again (RFC 0004 A6). */
  function sandboxPanel(session: Session, resourceCount: number): Html {
    const token = csrfToken(session);
    const hidden = html`<input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}">`;
    const names: Record<SlotlockSandboxScenario, string> = { 'car-rental': 'Car rental', clinic: 'Clinic', desks: 'Desks and a hall' };
    return html`<section class="panel" id="sandbox"><h2>Sandbox</h2>
<p class="fine">Test only. Try an agent against sample data, make holds and approvals that would lapse lapse now, or start again. Keys and webhooks stay.</p>
${
  resourceCount === 0
    ? html`<form class="create" method="post" action="${root}/sandbox/seed">${hidden}<label>Sample data<select name="scenario">${SLOTLOCK_SANDBOX_SCENARIOS.map(
        (scenario) => html`<option value="${scenario}">${names[scenario]}</option>`,
      )}</select></label><button class="primary" type="submit">Load it</button></form>`
    : html`<form class="create" method="post" action="${root}/sandbox/fast-forward">${hidden}<label>Move waiting forward<select name="minutes"><option value="15">15 minutes</option><option value="60">An hour</option><option value="1440">A day</option></select></label><button type="submit">Move forward</button></form>
<details class="act danger"><summary>Start again</summary><div class="pop"><p>Every resource, booking, hold and policy in Test goes. Keys and webhooks stay.</p><form method="post" action="${root}/sandbox/reset">${hidden}<button class="danger" type="submit">Empty Test</button></form></div></details>`
}
</section>`;
  }

  async function sandboxAction(session: Session, form: URLSearchParams, action: 'seed' | 'reset' | 'fast-forward'): Promise<Response> {
    const sandbox = options.resources.sandbox;
    if (!sandbox || session.env !== 'test') return overviewPage(session, 400, 'The sandbox is in Test only.');
    const tenantRef = tenantOf(session);
    try {
      if (action === 'seed') {
        const scenario = form.get('scenario') as SlotlockSandboxScenario;
        if (!SLOTLOCK_SANDBOX_SCENARIOS.includes(scenario)) return overviewPage(session, 400, 'Choose a sample from the list.');
        const seeded = await sandbox.seed(tenantRef, scenario);
        return overviewPage(session, 200, `Loaded ${String(seeded.resources)} resources and ${String(seeded.bookings)} bookings for tomorrow.`);
      }
      if (action === 'reset') {
        await sandbox.reset(tenantRef);
        return redirect(303, `${root}#sandbox`);
      }
      const minutes = Number(form.get('minutes'));
      if (![15, 60, 1440].includes(minutes)) return overviewPage(session, 400, 'Choose how far from the list.');
      const moved = await sandbox.fastForward(tenantRef, minutes);
      return overviewPage(session, 200, `${String(moved.holds)} holds and ${String(moved.approvals)} approvals lapsed.`);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'sandbox_not_empty') {
        return overviewPage(session, 409, 'Test has resources already. Start again first.');
      }
      throw error;
    }
  }

  function endpoints(): Html {
    return html`<dl class="endpoints"><dt>MCP</dt><dd><code id="mcp-url">${mcpUrl}</code><button class="quiet" type="button" data-copy="mcp-url">Copy</button></dd><dt>A2A</dt><dd><code id="a2a-url">${a2aUrl}</code><button class="quiet" type="button" data-copy="a2a-url">Copy</button></dd></dl>`;
  }

  const accessOf = (key: SlotlockApiKey) =>
    key.scopes.includes('admin') ? 'Full' : key.scopes.includes('write') ? 'Read and write' : 'Read only';

  async function keysPage(session: Session, status = 200, notice?: string | Html): Promise<Response> {
    const tenantRef = tenantOf(session);
    const grouping = options.resources.grouping;
    const team = teamTenantOf(session);
    const [keys, locations, groups, members] = await Promise.all([
      options.keys.list({ tenantRef }),
      grouping?.locations(tenantRef),
      grouping?.groups(tenantRef),
      teamStore && team !== undefined ? teamStore.members(team) : Promise.resolve([]),
    ]);
    const names = new Map(members.map((member) => [member.person, memberName(member)]));
    const token = csrfToken(session);
    const paths = locationPaths(locations ?? []);
    // A key limited to locations or groups (RFC 0003 G6), when the tenant has any to choose.
    const limitChoices =
      (locations?.length ?? 0) + (groups?.length ?? 0) > 0
        ? html`<details class="types"><summary>Limit to locations or groups (optional)</summary><div class="checks">${(locations ?? []).map(
            (location) =>
              html`<label class="choice"><input type="checkbox" name="limit_location" value="${location.ref}"> ${paths.get(location.ref) ?? location.name}</label>`,
          )}${(groups ?? []).map(
            (group) =>
              html`<label class="choice"><input type="checkbox" name="limit_group" value="${group.ref}"> Group: ${group.name}</label>`,
          )}</div><p class="fine">The key then reaches only the resources there (a location with every location in it), read and write only. Developer plan and up.</p></details>`
        : html``;
    const content = html`${noticeOf(notice, status)}
${pageHead('API keys')}
<section class="panel">
<h2>Connect an agent</h2>
<p>Agents call ${brandName} over MCP or A2A with a key: <code>Authorization: Bearer slk_…</code></p>
${endpoints()}
</section>
<section class="panel" id="new-key">
<h2>New key</h2>
<form class="create" method="post" action="${root}/keys">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<label class="grow">Name<input id="key-name" name="name" required maxlength="100" placeholder="Booking agent"></label>
<label>Access<select name="access"><option value="read_write">Read and write</option><option value="read">Read only</option><option value="full">Full, with the application API</option></select></label>
<label>Expires<select name="expires"><option value="90">In 90 days</option><option value="30">In 30 days</option><option value="365">In a year</option><option value="never">Never</option></select></label>
<button class="primary" type="submit">Create key</button>
${limitChoices}
<details class="types"><summary>Agent limits (optional)</summary><div class="checks">${keyLimitFields()}</div><p class="fine">Below the server's own limits, never above them. A key whose bookings wait for approval sends each to the Approvals page.</p></details>
</form>
</section>
${
  keys.length === 0
    ? emptyState(ICONS.keys, 'No keys yet. Give every agent its own, with the least access it needs.', { href: '#key-name', label: 'Create a key' })
    : html`<div class="table"><table><thead><tr><th>Name</th><th>Key</th><th>Access</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
<tbody>${keyRows(keys, token, session, names)}</tbody></table></div>`
}`;
    return respond(status, layout('API keys', content, session, 'keys'));
  }

  /**
   * How many resources the tenant may have here, and how many it has as that limit counts them: the
   * dashboard's own limit, or its plan's when lower (archived resources count against a plan).
   */
  async function resourceAllowance(
    tenantRef: string,
    resources: readonly SlotlockResource[],
  ): Promise<{ used: number; limit: number; planned: boolean; archived: number }> {
    const plan = plans ? await plans.plan(tenantRef) : null;
    if (!plan || plan.limits.resources >= SLOTLOCK_DASHBOARD_MAX_RESOURCES) {
      return { used: resources.length, limit: SLOTLOCK_DASHBOARD_MAX_RESOURCES, planned: false, archived: 0 };
    }
    const counted = options.resources.count ? await options.resources.count(tenantRef) : resources.length;
    return {
      used: counted,
      limit: plan.limits.resources,
      planned: true,
      archived: Math.max(0, counted - resources.length),
    };
  }

  async function resourcesPage(session: Session, status = 200, notice?: string | Html, ownHoursOnly = false): Promise<Response> {
    const every = await options.resources.list(tenantOf(session));
    const allowance = await resourceAllowance(tenantOf(session), every);
    // `?hours=own`: those that keep hours of their own, which the tenant's hours do not reach.
    const resources = ownHoursOnly
      ? every.filter((resource) => resource.archivedAt === undefined && resource.availabilityRules !== undefined)
      : every;
    const token = csrfToken(session);
    const content = html`${noticeOf(notice, status)}
${pageHead(
  'Resources',
  html`<div class="row-actions">${options.resources.grouping ? html`<a class="button" href="${root}/locations">Locations and groups</a>` : html``}<a class="button" href="${root}/hours">Your hours</a>${options.resources.hours ? html`<a class="button" href="${root}/closures">Closures</a>` : html``}${options.resources.contacts ? html`<a class="button" href="${root}/contacts">Contacts</a>` : html``}</div>`,
)}
<section class="panel" id="add-resource">
<h2>Add a resource</h2>
<form class="create" method="post" action="${root}/resources">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<label class="grow">Reference<input id="reference" name="reference" required maxlength="200" placeholder="vehicle-42"></label>
<label>Time zone<input name="timezone" required maxlength="64" value="UTC" placeholder="Europe/London"></label>
<button class="primary" type="submit">Add resource</button>
</form>
<p class="fine">${String(allowance.used)} of ${String(allowance.limit)}${allowance.planned ? html` on your plan${allowance.archived > 0 ? html`, ${String(allowance.archived)} of them archived (archived resources count until deleted)` : html``}` : html``}. Adding a reference you have changes its time zone.</p>
</section>
${
  ownHoursOnly
    ? html`<p class="notice" role="status">${String(resources.length)} ${resources.length === 1 ? 'resource keeps hours of its own' : 'resources keep hours of their own'}, so <a href="${root}/hours">your hours</a> do not reach ${resources.length === 1 ? 'it' : 'them'}. <a href="${root}/resources">Show every resource</a></p>`
    : html``
}${
  resources.length === 0 && !ownHoursOnly
    ? emptyState(ICONS.resources, 'No resources yet. Agents can only book what is listed here.', { href: '#reference', label: 'Add a resource' })
    : html`<div class="table"><table><thead><tr><th>Reference</th><th>Time zone</th><th>Bookable hours</th><th>Resource id</th></tr></thead><tbody>${resources.map(
        (resource) =>
          html`<tr><td data-label="Reference" class="strong"><span class="cell"><a class="truncate" href="${root}/resources/${resource.id}" title="${resourceName(resource, resource.id)}">${resourceName(resource, resource.id)}</a>${resource.name && resource.externalRef ? html`<span class="meta" title="Reference ${resource.externalRef}">${resource.externalRef}</span>` : html``}${resource.pool ? html`<span class="meta" title="Pool ${resource.pool}">Pool ${resource.pool}</span>` : html``}</span></td><td data-label="Time zone">${resource.timezone}</td><td data-label="Bookable hours"><span class="cell"><span>${resourceHours(resource, options.availability ?? [])}</span><a class="meta-link" href="${root}/hours?resource=${resource.id}">Set hours</a></span></td><td data-label="Resource id"><code class="muted truncate id" title="${resource.id}">${resource.id}</code></td></tr>`,
      )}</tbody></table></div>`
}`;
    return respond(status, layout('Resources', content, session, 'resources'));
  }

  /** The tenant's locations and groups (RFC 0003 G2, G3): what they are, and adding and changing them. */
  async function locationsPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const grouping = options.resources.grouping;
    if (!grouping) return nothingHere(session);
    const tenantRef = tenantOf(session);
    const [locations, groups] = await Promise.all([grouping.locations(tenantRef), grouping.groups(tenantRef)]);
    const token = csrfToken(session);
    const byRef = new Map(locations.map((location) => [location.ref, location]));
    const paths = locationPaths(locations);
    const sent = () =>
      html`<input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}">`;
    // Where a location may be: nowhere, or any location but itself and those inside it.
    const insideChoices = (selected: string | null, except?: string) =>
      html`<option value=""${selected === null ? html` selected` : html``}>Nowhere (at the top)</option>${locations
        .filter((location) => except === undefined || !locationWithin(byRef, location.ref, except))
        .map(
          (location) =>
            html`<option value="${location.ref}"${location.ref === selected ? html` selected` : html``}>${paths.get(location.ref) ?? location.name}</option>`,
        )}`;
    const nameLimit = String(SLOTLOCK_RESOURCE_PROFILE_LIMITS.name);
    const locationRows = locations.map((location) => {
      const parent = location.parentRef === null ? undefined : paths.get(location.parentRef);
      const zone = locationZone(byRef, location);
      return html`<tr>
<td data-label="Location" class="strong"><span class="cell"><span class="truncate" title="${paths.get(location.ref) ?? location.name}">${location.name}</span><span class="meta">${location.ref}${parent ? ` · in ${parent}` : ''}</span></span></td>
<td data-label="Time zone">${zone ? (zone.from === location ? zone.timezone : html`<span class="cell"><span>${zone.timezone}</span><span class="meta">from ${zone.from.name}</span></span>`) : html`<span class="muted">None</span>`}</td>
<td data-label="Resources">${String(location.resources)}</td>
<td class="actions">${options.resources.hours ? html`<a class="button" href="${root}/hours?location=${location.ref}">Hours</a>` : html``}<details class="act"><summary>Edit</summary><div class="pop"><form method="post" action="${root}/locations">${sent()}<input type="hidden" name="ref" value="${location.ref}">
<label>Name<input name="name" required maxlength="${nameLimit}" value="${location.name}"></label>
<label>Inside<select name="parent">${insideChoices(location.parentRef, location.ref)}</select></label>
<label>Time zone<input name="timezone" maxlength="100" value="${location.timezone ?? ''}" placeholder="As where it is"></label>
<button type="submit">Save location</button></form></div></details><details class="act danger"><summary>Delete</summary><div class="pop"><p>${location.resources > 0 ? 'Move its resources somewhere else first.' : 'Locations inside it must be moved or deleted first.'}</p>
<form method="post" action="${root}/locations/delete">${sent()}<input type="hidden" name="ref" value="${location.ref}"><button class="danger" type="submit">Delete location</button></form></div></details></td>
</tr>`;
    });
    const groupRows = groups.map(
      (group) => html`<tr>
<td data-label="Group" class="strong"><span class="cell"><span class="truncate" title="${group.name}">${group.name}</span><span class="meta">${group.ref}</span></span></td>
<td data-label="Description" class="wrap">${group.description ?? ''}</td>
<td data-label="Resources">${String(group.members)}</td>
<td class="actions"><details class="act"><summary>Edit</summary><div class="pop"><form method="post" action="${root}/groups">${sent()}<input type="hidden" name="ref" value="${group.ref}">
<label>Name<input name="name" required maxlength="${nameLimit}" value="${group.name}"></label>
<label>Description<textarea name="description" rows="2" maxlength="${String(SLOTLOCK_RESOURCE_PROFILE_LIMITS.description)}">${group.description ?? ''}</textarea></label>
<button type="submit">Save group</button></form></div></details><details class="act danger"><summary>Delete</summary><div class="pop"><p>Its resources stay as they are, in no group of this name.</p>
<form method="post" action="${root}/groups/delete">${sent()}<input type="hidden" name="ref" value="${group.ref}"><button class="danger" type="submit">Delete group</button></form></div></details></td>
</tr>`,
    );
    const content = html`${noticeOf(notice, status)}
<p><a class="back" href="${root}/resources">Resources</a></p>
${pageHead('Locations and groups')}
<section class="panel" id="locations">
<h2>Locations</h2>
<form class="create" method="post" action="${root}/locations">${sent()}
<label>Reference<input id="location-ref" name="ref" required maxlength="100" placeholder="floor-3"></label>
<label class="grow">Name<input name="name" required maxlength="${nameLimit}" placeholder="Floor 3"></label>
<label>Inside<select name="parent">${insideChoices(null)}</select></label>
<label>Time zone<input name="timezone" maxlength="100" placeholder="As where it is"></label>
<button class="primary" type="submit">Add location</button>
</form>
<p class="fine">Where resources are: a site, a building, a floor, up to ${String(SLOTLOCK_MAX_LOCATION_DEPTH)} levels. Agents searching a location search every location inside it too. A resource added at a location over the API without a time zone takes the location's, or the nearest one above it. Adding a reference you have changes that location.</p>
${
  locations.length === 0
    ? html`<p class="empty">No locations yet.</p>`
    : html`<div class="table"><table><thead><tr><th>Location</th><th>Time zone</th><th>Resources</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${locationRows}</tbody></table></div>`
}
</section>
<section class="panel" id="groups">
<h2>Groups</h2>
<form class="create" method="post" action="${root}/groups">${sent()}
<label>Reference<input id="group-ref" name="ref" required maxlength="100" placeholder="video-rooms"></label>
<label class="grow">Name<input name="name" required maxlength="${nameLimit}" placeholder="Rooms with video"></label>
<label class="grow">Description<input name="description" maxlength="${String(SLOTLOCK_RESOURCE_PROFILE_LIMITS.description)}" placeholder="Optional"></label>
<button class="primary" type="submit">Add group</button>
</form>
<p class="fine">Any set of resources, such as a team or the rooms with video, wherever they are. A resource is in up to ${String(SLOTLOCK_MAX_GROUPS_PER_RESOURCE)} groups; choose them on its page. Adding a reference you have changes that group.</p>
${
  groups.length === 0
    ? html`<p class="empty">No groups yet.</p>`
    : html`<div class="table"><table><thead><tr><th>Group</th><th>Description</th><th>Resources</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${groupRows}</tbody></table></div>`
}
</section>`;
    return respond(status, layout('Locations and groups', content, session, 'resources'));
  }

  type SettingsSection = 'assistant' | 'members' | 'team' | 'audit' | 'endpoints' | 'hours' | 'account';
  /** An invitation's link, shown once to the person who made it. */
  type InvitationShown = { link: string; to: string; expiresAt: Date };

  /** Resources with hours of their own the tenant's hours page names; the rest are counted. */
  const OWN_HOURS_NAMED = 8;

  /** Settings' sections, each its own page: the assistant's form apart from what is only read. */
  const SETTINGS_SECTIONS: readonly { id: SettingsSection; label: string; path: string }[] = Object.freeze([
    { id: 'assistant', label: 'Assistant', path: '/settings' },
    { id: 'members', label: 'Members', path: '/settings/members' },
    { id: 'team', label: 'Team', path: '/settings/team' },
    { id: 'audit', label: 'Audit log', path: '/settings/audit' },
    { id: 'endpoints', label: 'Endpoints', path: '/settings/endpoints' },
    { id: 'hours', label: 'Hours', path: '/settings/hours' },
    { id: 'account', label: 'Account', path: '/settings/account' },
  ]);

  async function settingsPage(
    session: Session,
    status = 200,
    notice?: string,
    draft?: AssistantDraft,
    section: SettingsSection = 'assistant',
    invitation?: InvitationShown,
    query?: URLSearchParams,
  ): Promise<Response> {
    const store = assistantStore();
    // Members are a team workspace's: its people come from invitations, not from GitHub.
    const sections = SETTINGS_SECTIONS.filter(
      (entry) =>
        (entry.id !== 'assistant' || store) &&
        (entry.id !== 'members' || (teamStore && session.team !== undefined)) &&
        (entry.id !== 'team' || (teamStore && session.team !== undefined && can(session, 'workspace.own'))) &&
        (entry.id !== 'audit' || (options.resources.audit && can(session, 'audit.read'))),
    );
    const shown: SettingsSection =
      section === 'assistant' && !store
        ? 'endpoints'
        : (section === 'members' || section === 'audit' || section === 'team') && !sections.some((entry) => entry.id === section)
          ? 'account'
          : section;
    const connected = store ? Boolean(await store.getSettings(tenantOf(session))) : false;
    const nav = html`<nav class="subnav" aria-label="Settings">${sections.map(
      (entry) =>
        html`<a href="${root}${entry.path}"${entry.id === shown ? html` aria-current="page"` : html``}>${entry.label}${
          entry.id === 'assistant' && connected ? html`<span class="nav-dot" aria-hidden="true"></span>` : html``
        }</a>`,
    )}</nav>`;
    let body: Html;
    if (shown === 'assistant') {
      body = await assistantSettingsSection(session, status, notice, draft);
    } else if (shown === 'members') {
      body = await membersSection(session, status, notice, invitation);
    } else if (shown === 'team') {
      body = await teamSection(session, status, notice);
    } else if (shown === 'audit') {
      body = await auditSection(session, status, notice, query ?? new URLSearchParams());
    } else if (shown === 'endpoints') {
      body = html`${noticeOf(notice, status)}<div class="set-card"><div class="row"><span class="row-label">MCP</span><div class="row-value">${copyField('mcp-url', mcpUrl)}</div></div><div class="row"><span class="row-label">A2A</span><div class="row-value">${copyField('a2a-url', a2aUrl)}</div></div></div>`;
    } else if (shown === 'hours') {
      const rules = options.availability ?? [];
      body = html`${noticeOf(notice, status)}<div class="set-card"><div class="row"><span class="row-label">Default hours</span><div class="row-value${rules.length === 0 ? ' muted' : ''}">${
        rules.length === 0
          ? "None. Agents find free time only on resources with hours of their own, their location's or yours."
          : html`${rules.map(
              (rule, index) =>
                html`${index > 0 ? html`<br>` : html``}${daysOf(rule.rrule)}: ${hoursOf(rule.startMinutes, rule.durationMinutes)}`,
            )}`
      }</div></div></div><p class="fine">In each resource's own time zone, for resources with no hours of their own, their location's or <a href="${root}/hours">yours</a>. Set by the server's operator.</p>`;
    } else {
      const current = session.orgs?.find((org) => org.id === session.org);
      const team = currentTeam(session);
      const others = (session.orgs ?? []).filter((org) => org.id !== current?.id);
      body = html`${noticeOf(notice, status)}<div class="set-card"><div class="row"><span class="row-label">Signed in as</span><div class="row-value">${shownAs(session)}</div></div><div class="row"><span class="row-label">${current ? 'Organization' : team ? 'Team' : 'Workspace'}</span><div class="row-value">${current ? current.login : team ? team.name : 'Personal'}</div></div>${
        current && others.length > 0
          ? html`<div class="row"><span class="row-label">Also a member of</span><div class="row-value">${others.map((org) => org.login).join(', ')}</div></div>`
          : html``
      }<div class="row"><span class="row-label">Role</span><div class="row-value">${SLOTLOCK_WORKSPACE_ROLE_NAMES[roleOf(session)]}</div></div><div class="row"><span class="row-label">Session ends</span><div class="row-value">${formatDate(new Date(session.exp))}</div></div>${
        workspaces
          ? html`<div class="row"><span class="row-label">Sessions</span><div class="row-value"><form method="post" action="${root}/sign-out-everywhere"><input type="hidden" name="csrf" value="${csrfToken(session)}"><input type="hidden" name="once" value="${formNonce(session)}"><button type="submit">Sign out everywhere</button></form></div></div>`
          : html``
      }</div>${current ? html`<p class="fine">Membership is read from GitHub when you sign in.</p>` : html``}${await sessionsList(session)}`;
    }
    const content = html`${pageHead('Settings')}<div class="settings">${nav}<div class="settings-body">${body}</div></div>`;
    return respond(status, layout('Settings', content, session, 'settings'));
  }

  /** Where the person is signed in, each but this one with Sign out. */
  async function sessionsList(session: Session): Promise<Html> {
    const kept = workspaces?.sessions;
    if (!kept) return html``;
    const person = personOf(session);
    const listed = await kept.list(person);
    if (listed.length === 0) return html``;
    const mine = kept.idOf(session.sid);
    const rows = listed.map(
      (entry) =>
        html`<tr><td data-label="Device" class="strong">${deviceOf(entry.userAgent)}${entry.id === mine ? html` <span class="pill active">This device</span>` : html``}</td><td data-label="Address">${entry.ipAddress ?? '—'}</td><td data-label="Signed in">${formatDate(entry.startedAt)}</td><td data-label="Last seen">${formatDate(entry.lastSeenAt)}</td><td class="actions">${
          entry.id === mine
            ? html``
            : html`<form class="inline" method="post" action="${root}/sessions/end"><input type="hidden" name="csrf" value="${csrfToken(session)}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${entry.id}"><button type="submit">Sign out<span class="visually-hidden"> ${deviceOf(entry.userAgent)}, signed in ${formatDate(entry.startedAt)}</span></button></form>`
        }</td></tr>`,
    );
    return html`<h2 class="sessions-head">Signed in</h2><div class="table"><table><thead><tr><th>Device</th><th>Address</th><th>Signed in</th><th>Last seen</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  async function endSession(session: Session, form: URLSearchParams): Promise<Response> {
    const kept = workspaces?.sessions;
    if (!kept) return nothingHere(session);
    const id = (form.get('id') ?? '').toLowerCase();
    if (id === kept.idOf(session.sid)) {
      return settingsPage(session, 400, 'To sign out of this device, use Sign out.', undefined, 'account');
    }
    if (!(await kept.end(personOf(session), id))) {
      return settingsPage(session, 404, 'That session has ended already.', undefined, 'account');
    }
    return settingsPage(session, 200, 'Signed out of that device.', undefined, 'account');
  }

  /** A value to copy: monospace, cut with an ellipsis, with a Copy button (app.js). */
  const copyField = (id: string, value: string) =>
    html`<dl class="endpoints"><dd><code id="${id}">${value}</code><button class="quiet" type="button" data-copy="${id}">Copy</button></dd></dl>`;

  /** The tenant's resource with that id and every resource (for names), or null for anything else. */
  async function resourceDetailPage(
    session: Session,
    id: string,
    status = 200,
    notice?: string,
  ): Promise<Response> {
    const tenantRef = tenantOf(session);
    const resource = await ownResource(session, id);
    if (!resource) return notFound(session);
    const start = new Date(now());
    const window = { start, end: new Date(start.getTime() + AGENDA_DAYS * DAY_MS) };
    const grouping = options.resources.grouping;
    const [agenda, changes, keys, defaults, locations, groups, everyResource] = await Promise.all([
      options.resources.agenda?.(tenantRef, window, AGENDA_LIMIT),
      options.resources.recentChanges?.(tenantRef, 100),
      options.keys.list({ tenantRef }),
      options.resources.ruleDefaults?.(tenantRef),
      grouping?.locations(tenantRef),
      grouping?.groups(tenantRef),
      // For a composite: its parts, or the wholes it can be a part of.
      options.resources.setParent ? options.resources.list(tenantRef) : undefined,
    ]);
    const parts = (everyResource?.filter((other) => other.parentId === resource.id) ?? []).sort(
      (one, other) => (one.partIndex ?? 0) - (other.partIndex ?? 0),
    );
    const wholes =
      everyResource?.filter((other) => other.id !== resource.id && other.parentId === undefined && other.archivedAt === undefined) ?? [];
    const paths = locationPaths(locations ?? []);
    const groupNames = new Map((groups ?? []).map((group) => [group.ref, group.name]));
    const byId = new Map([[resource.id, resource]]);
    const mine = agenda?.filter((entry) => entry.resourceId === resource.id);
    const activity = changes?.filter((change) => change.resourceId === resource.id).slice(0, 10);
    const token = csrfToken(session);
    const rules = resource.bookingRules ?? {};
    const inherited = inheritedRules(resource, defaults);
    const field = (name: keyof typeof RULE_FIELDS, label: string, unit: string) => {
      const from = inherited.get(name);
      return html`<label>${label}<span class="unit-input"><input type="number" inputmode="numeric" min="${String(RULE_LIMITS[name][0])}" max="${String(RULE_LIMITS[name][1])}" name="${RULE_FIELDS[name]}" value="${rules[name] === undefined ? '' : String(rules[name])}"${from ? html` placeholder="${String(from.value)}"` : html``}><span>${unit}</span></span></label>`;
    };
    // On or off: a checkbox, or, once a default sets it (or the resource turned it off), a choice
    // of the default, on or off, so a resource can turn an inherited rule off.
    const toggle = (name: 'enforceHours' | 'requireCertain', key: string, label: string) => {
      const from = inherited.get(name);
      if (from === undefined && rules[name] !== false) {
        return html`<label class="choice"><input type="checkbox" name="${key}" value="1"${rules[name] ? html` checked` : html``}> ${label}</label>`;
      }
      const chosen = (value: boolean | undefined) => (rules[name] === value ? html` selected` : html``);
      const fallback = from ? `As its default (${from.value ? 'on' : 'off'}, ${from.from})` : 'Off';
      return html`<label>${label}<select name="${key}"><option value=""${chosen(undefined)}>${fallback}</option><option value="1"${chosen(true)}>On</option><option value="0"${chosen(false)}>Off</option></select></label>`;
    };
    const content = html`${noticeOf(notice, status)}
<p><a class="back" href="${root}/resources">Resources</a></p>
${pageHead(resourceName(resource, resource.id))}
${resource.description ? html`<p>${resource.description}</p>` : html``}
<dl class="facts">${resource.name && resource.externalRef ? html`<dt>Reference</dt><dd>${resource.externalRef}</dd>` : html``}${resource.kind ? html`<dt>Kind</dt><dd>${KIND_NAMES[resource.kind]}</dd>` : html``}${resource.capacity !== undefined ? html`<dt>Capacity</dt><dd>${String(resource.capacity)}</dd>` : html``}${resource.labels ? html`<dt>Labels</dt><dd>${resource.labels.join(', ')}</dd>` : html``}${resource.location ? html`<dt>Location</dt><dd>${paths.get(resource.location) ?? resource.locationName ?? resource.location}</dd>` : html``}${resource.groups ? html`<dt>Groups</dt><dd>${resource.groups.map((ref) => groupNames.get(ref) ?? ref).join(', ')}</dd>` : html``}<dt>Time zone</dt><dd>${resource.timezone}</dd><dt>Bookable hours</dt><dd>${resourceHours(resource, options.availability ?? [])} <a href="${root}/hours?resource=${resource.id}">Set hours</a></dd><dt>Resource id</dt><dd><code class="muted">${resource.id}</code></dd></dl>
<div class="split">
<div class="stack">
${
  options.resources.setRules
    ? html`<section class="panel">
<h2>Booking rules</h2>
<form method="post" action="${root}/resources/rules">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<input type="hidden" name="id" value="${resource.id}">
<div class="grid-form">
${field('minNoticeMinutes', 'Minimum notice', 'min')}
${field('maxAdvanceDays', 'Book up to', 'days ahead')}
${field('slotStepMinutes', 'Start on a step of', 'min')}
${field('stepOffsetMinutes', 'Steps start past each step by', 'min')}
${field('bufferBeforeMinutes', 'Kept free before each booking', 'min')}
${field('turnaroundMinutes', 'Turnaround after each booking', 'min')}
${field('checkInMinutes', 'Release if not checked in after', 'min')}
${field('minDurationMinutes', 'Shortest booking', 'min')}
${field('maxDurationMinutes', 'Longest booking', 'min')}
${field('defaultDurationMinutes', 'Usual length, offered when none is asked', 'min')}
${field('cancelCutoffMinutes', 'Cancel up to, before the start', 'min')}
${field('rescheduleCutoffMinutes', 'Move up to, before the start', 'min')}
</div>
${resource.bookingRules?.allowedDurations || resource.bookingRules?.pickupTimes || resource.bookingRules?.returnTimes || resource.bookingRules?.cancellationFee ? html`<p class="fine">Set through the API, and kept when you save: ${[
      resource.bookingRules.allowedDurations ? `lengths ${ruleValueText(resource.bookingRules.allowedDurations)} min` : '',
      resource.bookingRules.pickupTimes ? `pick-up ${ruleValueText(resource.bookingRules.pickupTimes)}` : '',
      resource.bookingRules.returnTimes ? `return ${ruleValueText(resource.bookingRules.returnTimes)}` : '',
      resource.bookingRules.cancellationFee ? `cancellation fee ${ruleValueText(resource.bookingRules.cancellationFee)}` : '',
    ].filter(Boolean).join('; ')}.</p>` : html``}
${toggle('enforceHours', 'enforce_hours', 'Only inside bookable hours')}
${toggle('requireCertain', 'require_certain', 'Only in time its calendar syncs have read today')}
${inheritedNote(inherited)}
<p class="fine">Leave a field empty for no rule${inherited.size > 0 ? ' of its own' : ''}.</p>
<button class="primary" type="submit">Save rules</button>
</form>
</section>`
    : html``
}
${
  options.resources.setProfile
    ? html`<section class="panel">
<h2>Profile</h2>
<form method="post" action="${root}/resources/profile">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<input type="hidden" name="id" value="${resource.id}">
<div class="grid-form">
<label>Name<input name="name" maxlength="${String(SLOTLOCK_RESOURCE_PROFILE_LIMITS.name)}" value="${resource.name ?? ''}" placeholder="${resource.externalRef ?? ''}"></label>
<label>Kind<select name="kind">${SLOTLOCK_RESOURCE_KINDS.map(
        (kind) =>
          html`<option value="${kind}"${(resource.kind ?? 'other') === kind ? html` selected` : html``}>${KIND_NAMES[kind]}</option>`,
      )}</select></label>
<label>Capacity<span class="unit-input"><input type="number" inputmode="numeric" min="1" max="${String(SLOTLOCK_RESOURCE_PROFILE_LIMITS.capacity)}" name="capacity" value="${resource.capacity === undefined ? '' : String(resource.capacity)}"><span>people or seats</span></span></label>
<label>Labels<input name="labels" value="${(resource.labels ?? []).join(', ')}" placeholder="video, accessible"></label>
</div>
<label>Description<textarea name="description" rows="3" maxlength="${String(SLOTLOCK_RESOURCE_PROFILE_LIMITS.description)}">${resource.description ?? ''}</textarea></label>
<p class="fine">Agents and people see the name instead of the reference. Kind, capacity and labels help them find it, and change nothing about how it is booked.${resource.attributes ? html` Its attributes (${Object.keys(resource.attributes).join(', ')}) are set over the API.` : html``}</p>
<button class="primary" type="submit">Save profile</button>
</form>
</section>`
    : html``
}
${
  options.resources.setPool
    ? html`<section class="panel">
<h2>Pool</h2>
<form class="create" method="post" action="${root}/resources/pool">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<input type="hidden" name="id" value="${resource.id}">
<label>Pool name<input name="pool" maxlength="100" value="${resource.pool ?? ''}" placeholder="suv"></label>
<button type="submit">Save pool</button>
</form>
<p class="fine">Agents can book any free member of a pool. Leave it empty for none.</p>
</section>`
    : html``
}
${
  options.resources.setParent && everyResource
    ? html`<section class="panel" id="composite">
<h2>Composite</h2>
${
  parts.length > 0
    ? html`<p>A whole of ${String(parts.length)} part${parts.length === 1 ? '' : 's'}: ${parts.map((part, index) => html`${index > 0 ? ', ' : ''}<a href="${root}/resources/${part.id}">${resourceName(part, part.id)}</a>`)}. Booking it takes every part, and a booking of any part keeps it from being booked.</p>`
    : html`<form class="create" method="post" action="${root}/resources/parent">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<input type="hidden" name="id" value="${resource.id}">
<label>Part of<select name="parent"><option value=""${resource.parentId ? html`` : html` selected`}>Nothing: it stands alone</option>${wholes.map(
        (whole) =>
          html`<option value="${whole.id}"${resource.parentId === whole.id ? html` selected` : html``}>${resourceName(whole, whole.id)}</option>`,
      )}</select></label>
<button type="submit">Save</button>
</form>
<p class="fine">A room of a hall, a half of a court: booking the whole then takes every part, and two parts never get in each other's way. It changes only while neither has a booking or hold to come.</p>`
}
</section>`
    : html``
}
${
  grouping && locations && groups
    ? html`<section class="panel" id="place">
<h2>Location and groups</h2>
${
  locations.length === 0 && groups.length === 0
    ? html`<p class="empty">No locations or groups yet. <a href="${root}/locations">Add them</a>, then choose them here.</p>`
    : html`<form method="post" action="${root}/resources/place">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<input type="hidden" name="id" value="${resource.id}">
<label>Location<select name="location"><option value=""${resource.location ? html`` : html` selected`}>None</option>${locations.map(
        (location) =>
          html`<option value="${location.ref}"${resource.location === location.ref ? html` selected` : html``}>${paths.get(location.ref) ?? location.name}</option>`,
      )}</select></label>
${
  groups.length > 0
    ? html`<fieldset class="choices"><legend>Groups</legend><div class="checks">${groups.map(
        (group) =>
          html`<label class="choice"><input type="checkbox" name="group" value="${group.ref}"${resource.groups?.includes(group.ref) ? html` checked` : html``}> ${group.name}</label>`,
      )}</div></fieldset>`
    : html``
}
<button class="primary" type="submit">Save location and groups</button>
</form>
<p class="fine">Agents can search a location, with every location inside it, or a group, in one call. <a href="${root}/locations">Locations and groups</a></p>`
}
</section>`
    : html``
}
</div>
<div class="stack">
${mine ? html`<section class="panel"><h2>Upcoming</h2>${agendaPanel(mine, byId, mine.length > AGENDA_SHOWN)}</section>` : html``}
${activity ? html`<section class="panel"><h2>Activity</h2>${activityPanel(activity, byId, keys, session)}</section>` : html``}
</div>
</div>`;
    return respond(status, layout(resourceName(resource, resource.id), content, session, 'resources'));
  }

  async function saveRules(session: Session, form: URLSearchParams): Promise<Response> {
    const id = form.get('id') ?? '';
    const resource = await ownResource(session, id);
    if (!resource || !options.resources.setRules) return notFound(session);
    const rules: SlotlockBookingRules = {};
    for (const [name, key] of Object.entries(RULE_FIELDS) as [keyof typeof RULE_FIELDS, string][]) {
      const value = (form.get(key) ?? '').trim();
      if (value === '') continue;
      const [min, max] = RULE_LIMITS[name];
      if (!/^\d{1,7}$/.test(value) || Number(value) < min || Number(value) > max) {
        return resourceDetailPage(
          session,
          id,
          400,
          `${RULE_NAMES[name]} is a whole number from ${min.toLocaleString('en')} to ${max.toLocaleString('en')}. Leave it empty for none.`,
        );
      }
      rules[name] = Number(value);
    }
    // '1' on, '0' off (over a default that is on), anything else not set.
    const choice = (key: string) => {
      const value = form.get(key);
      return value === '1' ? true : value === '0' ? false : undefined;
    };
    const enforceHours = choice('enforce_hours');
    if (enforceHours !== undefined) rules.enforceHours = enforceHours;
    const requireCertain = choice('require_certain');
    if (requireCertain !== undefined) rules.requireCertain = requireCertain;
    // Rules the form does not edit (set through the API) are kept.
    for (const name of ['allowedDurations', 'pickupTimes', 'returnTimes', 'cancellationFee'] as const) {
      const kept = resource.bookingRules?.[name];
      if (kept !== undefined) (rules as Record<string, unknown>)[name] = kept;
    }
    try {
      await options.resources.setRules(
        tenantOf(session),
        id,
        Object.keys(rules).length === 0 ? null : rules,
        personOf(session),
      );
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'invalid_booking_rules') throw error;
      return resourceDetailPage(session, id, 400, 'Those rules are not ones Slotlock can keep.');
    }
    return redirect(303, `${root}/resources/${id}`);
  }

  async function saveProfile(session: Session, form: URLSearchParams): Promise<Response> {
    const id = form.get('id') ?? '';
    const resource = await ownResource(session, id);
    if (!resource || !options.resources.setProfile) return notFound(session);
    const text = (key: string) => optionalField(form, key);
    const capacity = text('capacity');
    if (capacity !== null && !/^\d{1,6}$/.test(capacity)) {
      return resourceDetailPage(session, id, 400, PROFILE_PROBLEMS.capacity);
    }
    const kind = form.get('kind') ?? 'other';
    try {
      await options.resources.setProfile(
        tenantOf(session),
        id,
        {
          name: text('name'),
          description: text('description'),
          kind: kind as SlotlockResourceKind,
          capacity: capacity === null ? null : Number(capacity),
          // Commas or spaces between them; a person may type them in capitals.
          labels: (form.get('labels') ?? '')
            .split(/[\s,]+/)
            .map((label) => label.trim().toLowerCase())
            .filter((label) => label !== ''),
        },
        personOf(session),
      );
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'invalid_resource_profile') throw error;
      const field = (error as { field?: unknown }).field;
      return resourceDetailPage(
        session,
        id,
        400,
        PROFILE_PROBLEMS[typeof field === 'string' && field in PROFILE_PROBLEMS ? (field as keyof typeof PROFILE_PROBLEMS) : 'other'],
      );
    }
    return redirect(303, `${root}/resources/${id}`);
  }

  /** Text from a form, trimmed, or null when empty. */
  function optionalField(form: URLSearchParams, key: string): string | null {
    const value = (form.get(key) ?? '').trim();
    return value === '' ? null : value;
  }

  async function saveLocation(session: Session, form: URLSearchParams): Promise<Response> {
    const grouping = options.resources.grouping;
    if (!grouping) return nothingHere(session);
    try {
      await grouping.putLocation(
        tenantOf(session),
        {
          // A person may type a reference in capitals; references are lowercase.
          ref: (form.get('ref') ?? '').trim().toLowerCase(),
          name: (form.get('name') ?? '').trim(),
          parentRef: optionalField(form, 'parent'),
          timezone: optionalField(form, 'timezone'),
        },
        personOf(session),
      );
    } catch (error) {
      const problem = groupingProblem(error);
      if (!problem) throw error;
      return locationsPage(session, problem.status, problem.text);
    }
    return redirect(303, `${root}/locations`);
  }

  async function saveGroup(session: Session, form: URLSearchParams): Promise<Response> {
    const grouping = options.resources.grouping;
    if (!grouping) return nothingHere(session);
    try {
      await grouping.putGroup(
        tenantOf(session),
        {
          ref: (form.get('ref') ?? '').trim().toLowerCase(),
          name: (form.get('name') ?? '').trim(),
          description: optionalField(form, 'description'),
        },
        personOf(session),
      );
    } catch (error) {
      const problem = groupingProblem(error);
      if (!problem) throw error;
      return locationsPage(session, problem.status, problem.text);
    }
    return redirect(303, `${root}/locations#groups`);
  }

  async function deleteGrouping(
    session: Session,
    form: URLSearchParams,
    kind: 'location' | 'group',
  ): Promise<Response> {
    const grouping = options.resources.grouping;
    if (!grouping) return nothingHere(session);
    const ref = form.get('ref') ?? '';
    let deleted: boolean;
    try {
      deleted =
        kind === 'location'
          ? await grouping.deleteLocation(tenantOf(session), ref, personOf(session))
          : await grouping.deleteGroup(tenantOf(session), ref, personOf(session));
    } catch (error) {
      const problem = groupingProblem(error);
      if (!problem) throw error;
      return locationsPage(session, problem.status, problem.text);
    }
    if (!deleted) {
      const problem = GROUPING_PROBLEMS[`${kind}_not_found`] as { status: number; text: string };
      return locationsPage(session, problem.status, problem.text);
    }
    return redirect(303, `${root}/locations${kind === 'group' ? '#groups' : ''}`);
  }

  async function savePlace(session: Session, form: URLSearchParams): Promise<Response> {
    const id = form.get('id') ?? '';
    const resource = await ownResource(session, id);
    const grouping = options.resources.grouping;
    if (!resource || !grouping) return notFound(session);
    const groups = [...new Set(form.getAll('group'))];
    if (groups.length > SLOTLOCK_MAX_GROUPS_PER_RESOURCE) {
      const problem = GROUPING_PROBLEMS.resource_group_limit_reached as { status: number; text: string };
      return resourceDetailPage(session, id, problem.status, problem.text);
    }
    try {
      const placed = await grouping.place(
        tenantOf(session),
        id,
        { location: optionalField(form, 'location'), groups },
        personOf(session),
      );
      if (!placed) return notFound(session);
    } catch (error) {
      const problem = groupingProblem(error);
      if (!problem) throw error;
      return resourceDetailPage(session, id, problem.status, problem.text);
    }
    return redirect(303, `${root}/resources/${id}`);
  }

  async function saveParent(session: Session, form: URLSearchParams): Promise<Response> {
    const id = form.get('id') ?? '';
    const resource = await ownResource(session, id);
    if (!resource || !options.resources.setParent) return notFound(session);
    const wanted = (form.get('parent') ?? '').trim();
    const parent = wanted === '' ? null : await ownResource(session, wanted);
    if (wanted !== '' && !parent) return resourceDetailPage(session, id, 400, 'That is not one of your resources.');
    try {
      const changed = await options.resources.setParent(tenantOf(session), id, parent?.id ?? null, personOf(session));
      if (!changed) return notFound(session);
    } catch (error) {
      const text = COMPOSITE_PROBLEMS[String((error as { code?: unknown } | null)?.code)];
      if (!text) throw error;
      return resourceDetailPage(session, id, 409, text);
    }
    return redirect(303, `${root}/resources/${id}`);
  }

  async function savePool(session: Session, form: URLSearchParams): Promise<Response> {
    const id = form.get('id') ?? '';
    const resource = await ownResource(session, id);
    if (!resource || !options.resources.setPool) return notFound(session);
    const pool = (form.get('pool') ?? '').trim();
    try {
      await options.resources.setPool(
        tenantOf(session),
        id,
        pool === '' ? null : pool,
        personOf(session),
      );
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'invalid_pool') throw error;
      return resourceDetailPage(
        session,
        id,
        400,
        'A pool name is 1 to 100 letters, digits, dots, dashes or underscores.',
      );
    }
    return redirect(303, `${root}/resources/${id}`);
  }

  /** An endpoint's filter (set over the API), in a few words. */
  function webhookFilterText(filter: NonNullable<SlotlockWebhookEndpoint['filter']>): string {
    return [
      filter.resourceIds ? `${filter.resourceIds.length} resource${filter.resourceIds.length === 1 ? '' : 's'}` : null,
      filter.pools ? `pools ${filter.pools.join(', ')}` : null,
      filter.locations ? `locations ${filter.locations.join(', ')}` : null,
      filter.groups ? `groups ${filter.groups.join(', ')}` : null,
    ]
      .filter((part) => part !== null)
      .join('; ');
  }

  function endpointState(endpoint: SlotlockWebhookEndpoint): { text: string; tone: string } {
    if (endpoint.disabledAt) return { text: 'Disabled', tone: 'revoked' };
    if (endpoint.failingSince) return { text: 'Failing', tone: 'held' };
    return { text: 'Delivering', tone: 'active' };
  }

  async function webhooksPage(session: Session, status = 200, notice?: string | Html): Promise<Response> {
    const hooks = options.resources.webhooks;
    if (!hooks) return notFound(session);
    const endpoints = await hooks.list(tenantOf(session));
    const token = csrfToken(session);
    const failing = endpoints.filter((endpoint) => endpoint.failingSince && !endpoint.disabledAt);
    const disabled = endpoints.filter((endpoint) => endpoint.disabledAt);
    const rows = endpoints.map((endpoint) => {
      const state = endpointState(endpoint);
      const problem = endpoint.disabledAt
        ? `${endpoint.disabledReason ?? 'Disabled'} (${formatDate(endpoint.disabledAt)})`
        : endpoint.failingSince
          ? `Since ${formatDate(endpoint.failingSince)}, ${String(endpoint.attempts)} attempts${endpoint.lastStatus ? `, last HTTP ${endpoint.lastStatus}` : ''}${endpoint.lastError ? `: ${endpoint.lastError.slice(0, 120)}` : ''}`
          : '';
      return html`<tr>
<td data-label="URL" class="strong"><code class="truncate url" title="${endpoint.url}">${endpoint.url}</code></td>
<td data-label="Events" class="wrap">${endpoint.eventTypes ? endpoint.eventTypes.join(', ') : 'All'}${endpoint.filter ? html`<span class="meta">Only ${webhookFilterText(endpoint.filter)}</span>` : html``}</td>
<td data-label="Status"><span class="cell"><span class="pill ${state.tone}">${state.text}</span>${problem ? html`<span class="meta wrap">${problem}</span>` : html``}</span></td>
<td data-label="Added">${dateCell(endpoint.createdAt)}</td>
<td class="actions">${
        endpoint.disabledAt
          ? html`<form class="inline" method="post" action="${root}/webhooks/enable"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${endpoint.id}"><button type="submit">Enable</button></form>`
          : html``
      }<details class="act danger"><summary>Delete</summary><div class="pop"><p>Nothing more is sent to it. The feed keeps its changes.</p>
<form method="post" action="${root}/webhooks/delete"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${endpoint.id}"><button class="danger" type="submit">Delete webhook</button></form></div></details></td>
</tr>`;
    });
    const content = html`${noticeOf(notice, status)}
${pageHead('Webhooks')}
<div class="stats">
<div class="stat"><span class="stat-label">Endpoints</span><span class="stat-value">${String(endpoints.length)}</span></div>
<div class="stat"><span class="stat-label">Failing</span><span class="stat-value">${String(failing.length)}</span></div>
<div class="stat"><span class="stat-label">Disabled</span><span class="stat-value">${String(disabled.length)}</span></div>
</div>
<section class="panel" id="add-endpoint">
<h2>Add an endpoint</h2>
<form method="post" action="${root}/webhooks">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<label>URL<input id="webhook-url" name="url" type="url" required maxlength="2048" placeholder="https://example.com/slotlock"></label>
<details class="types"><summary>Events: all, or choose</summary><div class="checks">${SLOTLOCK_CHANGE_TYPES.map(
      (type) =>
        html`<label class="choice"><input type="checkbox" name="event_type" value="${type}"> <code>${type}</code></label>`,
    )}</div></details>
<button class="primary" type="submit">Add endpoint</button>
</form>
<p class="fine">Signed as Standard Webhooks with a secret shown once. An endpoint failing for a day is disabled.</p>
</section>
${
  endpoints.length === 0
    ? emptyState(ICONS.webhooks, 'No webhooks. Add one to hear about bookings as they change.', { href: '#webhook-url', label: 'Add an endpoint' })
    : html`<div class="table"><table><thead><tr><th>URL</th><th>Events</th><th>Status</th><th>Added</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
}`;
    return respond(status, layout('Webhooks', content, session, 'webhooks'));
  }

  async function addWebhook(session: Session, form: URLSearchParams): Promise<Response> {
    const hooks = options.resources.webhooks;
    if (!hooks) return notFound(session);
    const types = form.getAll('event_type');
    const created = await hooks.create(
      tenantOf(session),
      (form.get('url') ?? '').trim(),
      types.length === 0 ? undefined : types,
      personOf(session),
    );
    if (!created.ok) {
      const message =
        created.code === 'webhook_limit_reached'
          ? plans
            ? html`You have ${String(created.limit)} webhooks, as many as your plan allows. Delete one first, or ${await pastLimit(session)}.`
            : `You have ${String(created.limit)} webhooks, as many as Slotlock allows. Delete one first.`
          : created.code === 'invalid_webhook_url'
            ? 'Give an https URL, with no user name, password or #fragment.'
            : 'Choose events from the list.';
      return webhooksPage(session, created.code === 'webhook_limit_reached' ? 409 : 400, message);
    }
    const content = html`<section class="card once">
<h1>Webhook added</h1>
<p><code>${created.endpoint.url}</code></p>
<p class="notice warn" role="alert">Copy the signing secret now. It will not be shown again.</p>
<div class="copy"><input id="secret" readonly value="${created.secret}" aria-label="Signing secret"><button type="button" data-copy="secret">Copy</button></div>
<p>Verify each delivery's <code>webhook-signature</code> with it, using a Standard Webhooks library.</p>
<a class="button primary" href="${root}/webhooks">Done</a>
</section>`;
    return respond(200, layout('Webhook added', content, session, 'webhooks'));
  }

  async function changeWebhook(
    session: Session,
    form: URLSearchParams,
    change: 'remove' | 'enable',
  ): Promise<Response> {
    const hooks = options.resources.webhooks;
    if (!hooks) return notFound(session);
    const id = form.get('id') ?? '';
    if (change === 'remove') {
      if (!(await hooks.remove(tenantOf(session), id, personOf(session)))) {
        return webhooksPage(session, 404, 'That webhook is not one of yours.');
      }
      return redirect(303, `${root}/webhooks`);
    }
    const enabled = await hooks.enable(tenantOf(session), id, personOf(session));
    if (enabled === null) return webhooksPage(session, 404, 'That webhook is not one of yours.');
    if ('code' in enabled) {
      return webhooksPage(
        session,
        409,
        'It missed changes older than the feed keeps. Delete it, add it again, and read what it missed from the feed.',
      );
    }
    return redirect(303, `${root}/webhooks`);
  }

  async function waitlistPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const waitlist = options.resources.waitlist;
    if (!waitlist) return notFound(session);
    const tenantRef = tenantOf(session);
    const [entries, resources] = await Promise.all([
      waitlist.list(tenantRef, WAITLIST_SHOWN),
      options.resources.list(tenantRef),
    ]);
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    const token = csrfToken(session);
    const rows = entries.map((entry) => {
      const resource = entry.resourceId ? byId.get(entry.resourceId) : undefined;
      const zone = resource?.timezone ?? 'UTC';
      const day = dayLabel(entry.start, zone, now());
      const what = entry.resourceId
        ? resourceName(resource, entry.resourceId)
        : `Pool ${entry.pool ?? ''}`;
      const offered = entry.offeredResourceId
        ? resourceName(byId.get(entry.offeredResourceId), entry.offeredResourceId)
        : null;
      const tone = entry.status === 'offered' ? 'active' : entry.status === 'expired' ? 'revoked' : 'held';
      return html`<tr>
<td data-label="When" class="strong">${day.label} ${clock(entry.start, zone)}–${clock(entry.end, zone)}</td>
<td data-label="For"><span class="truncate" title="${what}">${what}</span></td>
<td data-label="Holder"><code class="truncate" title="${entry.holderRef}">${entry.holderRef}</code></td>
<td data-label="Status"><span class="cell"><span class="pill ${tone}">${entry.status === 'offered' ? 'Offered' : entry.status === 'expired' ? 'Expired' : 'Waiting'}</span>${offered && entry.offeredAt ? html`<span class="meta" title="${offered}">${offered}, ${ago(entry.offeredAt, now())}</span>` : html``}</span></td>
<td data-label="Joined">${ago(entry.createdAt, now())}</td>
<td class="actions"><details class="act danger"><summary>Remove</summary><div class="pop"><p>${entry.status === 'offered' ? 'Its offered hold is released and offered to the next.' : 'It stops waiting.'}</p>
<form method="post" action="${root}/waitlist/leave"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${entry.id}"><button class="danger" type="submit">Remove entry</button></form></div></details></td>
</tr>`;
    });
    const waiting = entries.filter((entry) => entry.status === 'waiting').length;
    const offered = entries.filter((entry) => entry.status === 'offered').length;
    const content = html`${noticeOf(notice, status)}
${pageHead('Waitlist')}
<div class="stats">
<div class="stat"><span class="stat-label">Waiting</span><span class="stat-value">${String(waiting)}</span></div>
<div class="stat"><span class="stat-label">Offered</span><span class="stat-value">${String(offered)}</span></div>
</div>
${
  entries.length === 0
    ? emptyState(ICONS.waitlist, 'Nobody is waiting. Agents add entries when the time they want is taken.')
    : html`<div class="table"><table><thead><tr><th>When</th><th>For</th><th>Holder</th><th>Status</th><th>Joined</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>${entries.length >= WAITLIST_SHOWN ? html`<p class="fine">Showing the first ${String(WAITLIST_SHOWN)}.</p>` : html``}`
}`;
    return respond(status, layout('Waitlist', content, session, 'waitlist'));
  }

  async function leaveWaitlist(session: Session, form: URLSearchParams): Promise<Response> {
    const waitlist = options.resources.waitlist;
    if (!waitlist) return notFound(session);
    if (!(await waitlist.leave(tenantOf(session), form.get('id') ?? '', personOf(session)))) {
      return waitlistPage(session, 404, 'That entry is not on your waitlist.');
    }
    return redirect(303, `${root}/waitlist`);
  }

  // ---- Approvals (RFC 0004 A4) ----

  async function approvalsPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const approvals = options.resources.approvals;
    if (!approvals) return notFound(session);
    const tenantRef = tenantOf(session);
    const [entries, resources] = await Promise.all([
      approvals.list(tenantRef, APPROVALS_SHOWN),
      options.resources.list(tenantRef),
    ]);
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    const token = csrfToken(session);
    const pending = entries.filter((entry) => entry.status === 'pending' && entry.expiresAt.getTime() > now());
    const decided = entries.filter((entry) => !pending.includes(entry));
    const what = (entry: SlotlockApproval) =>
      entry.resourceIds.map((id) => resourceName(byId.get(id), id)).join(', ');
    const when = (entry: SlotlockApproval) => {
      const zone = byId.get(entry.resourceIds[0] ?? '')?.timezone ?? 'UTC';
      const day = dayLabel(entry.start, zone, now());
      return `${day.label} ${clock(entry.start, zone)}–${clock(entry.end, zone)}`;
    };
    const KINDS: Record<SlotlockApproval['operation'], string> = {
      slotlock_create_event: 'Booking',
      slotlock_book_together: 'Bundle',
      slotlock_update_event: 'Move',
    };
    const form = (entry: SlotlockApproval, decision: 'grant' | 'decline', body: Html) =>
      html`<form method="post" action="${root}/approvals/decide"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${entry.id}"><input type="hidden" name="decision" value="${decision}">${body}</form>`;
    const pendingRows = pending.map(
      (entry) => html`<tr>
<td data-label="When" class="strong">${when(entry)}</td>
<td data-label="What"><span class="cell"><span class="truncate" title="${what(entry)}">${what(entry)}</span><span class="meta">${KINDS[entry.operation]}, policy ${entry.policyRef}</span></span></td>
<td data-label="Asked by"><code class="truncate" title="${entry.requestedBy ?? ''}">${entry.requestedBy ?? 'unknown'}</code></td>
<td data-label="Decide by">${clock(entry.expiresAt, 'UTC')} UTC, ${dayLabel(entry.expiresAt, 'UTC', now()).label}</td>
<td class="actions">${form(entry, 'grant', html`<button type="submit">Approve</button>`)}<details class="act danger"><summary>Decline</summary><div class="pop"><p>The held time is freed. The agent is told on its next try.</p>${form(entry, 'decline', html`<label>Reason (optional)<input name="reason" maxlength="500" autocomplete="off"></label><button class="danger" type="submit">Decline</button>`)}</div></details></td>
</tr>`,
    );
    const STATUS: Record<SlotlockApproval['status'], { text: string; tone: string }> = {
      pending: { text: 'Lapsed', tone: 'revoked' },
      granted: { text: 'Approved', tone: 'active' },
      declined: { text: 'Declined', tone: 'revoked' },
      expired: { text: 'Expired', tone: 'revoked' },
    };
    const decidedRows = decided.map(
      (entry) => html`<tr>
<td data-label="When" class="strong">${when(entry)}</td>
<td data-label="What"><span class="truncate" title="${what(entry)}">${what(entry)}</span></td>
<td data-label="Status"><span class="cell"><span class="pill ${STATUS[entry.status].tone}">${STATUS[entry.status].text}</span>${entry.reason ? html`<span class="meta" title="${entry.reason}">${entry.reason}</span>` : html``}</span></td>
<td data-label="Decided by"><code class="truncate" title="${entry.decidedBy ?? ''}">${entry.decidedBy ?? '—'}</code></td>
<td data-label="Asked">${ago(entry.createdAt, now())}</td>
</tr>`,
    );
    const content = html`${noticeOf(notice, status)}
${pageHead('Approvals')}
<p class="fine">Bookings an approval policy holds for a person. Their time stays held until you decide or the wait ends. Policies are set through the API (slotlock_put_approval_policy).</p>
<div class="stats">
<div class="stat"><span class="stat-label">Waiting for you</span><span class="stat-value">${String(pending.length)}</span></div>
</div>
${
  pending.length === 0
    ? emptyState(ICONS.approvals, 'Nothing is waiting. A policy that holds bookings for a person sends them here.')
    : html`<div class="table"><table><thead><tr><th>When</th><th>What</th><th>Asked by</th><th>Decide by</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${pendingRows}</tbody></table></div>`
}
${
  decided.length === 0
    ? html``
    : html`<h2>Decided</h2><div class="table"><table><thead><tr><th>When</th><th>What</th><th>Status</th><th>Decided by</th><th>Asked</th></tr></thead><tbody>${decidedRows}</tbody></table></div>`
}`;
    return respond(status, layout('Approvals', content, session, 'approvals'));
  }

  async function decideApproval(session: Session, form: URLSearchParams): Promise<Response> {
    const approvals = options.resources.approvals;
    if (!approvals) return notFound(session);
    const decision = form.get('decision');
    if (decision !== 'grant' && decision !== 'decline') return approvalsPage(session, 400, 'Choose approve or decline.');
    const reason = (form.get('reason') ?? '').trim().slice(0, 500);
    const decided = await approvals.decide(tenantOf(session), form.get('id') ?? '', decision, personOf(session), reason || undefined);
    if (!decided.ok) {
      const messages: Record<string, string> = {
        approval_not_found: 'That approval is not one of yours.',
        approval_not_pending: 'That approval was already decided.',
        approval_expired: 'The wait for that approval ended: its time is no longer held.',
        overlap: 'That time is taken now, so it cannot be booked. Decline it instead.',
        revision_conflict: 'The agent changed that event since it asked. Decline this one; it can ask again.',
      };
      return approvalsPage(session, 409, messages[decided.code] ?? `That booking cannot be made now (${decided.code}). Decline it instead.`);
    }
    return redirect(303, `${root}/approvals`);
  }


  // ---- The assistant ----

  const assistantOptions = options.assistant;
  /** The assistant's records, when the assistant is on and the adapter keeps them. Per request (Workers). */
  const assistantStore = (): SlotlockAssistantStore | undefined =>
    assistantOptions ? options.resources.assistant : undefined;
  const privateUrls = assistantOptions?.privateUrls === true;
  const assistantFetch =
    assistantOptions?.fetch ?? createSlotlockGuardedFetch({ allowPrivateNetworks: privateUrls });
  const resolveHost =
    assistantOptions?.resolve ??
    (async (hostname: string) =>
      (await dnsLookup(hostname, { all: true })).map(({ address }) => address));
  const PRIVATE_URL_REFUSAL =
    'That URL is, or resolves to, a local or private network address (loopback, private, link-local, shared, unique-local or cloud metadata), which this server does not reach. For a model on its own machine or network, the server’s operator can allow them with SLOTLOCK_ASSISTANT_PRIVATE_URLS=on.';
  // The dashboard's own host and the server's: a model there would be sent the organization's key
  // and the conversation by this deployment itself, on a public name the private-address check passes.
  const ownHosts = new Set([publicUrl.hostname, service.hostname]);
  const namesOwnHost = (baseUrl: string) => ownHosts.has(new URL(baseUrl).hostname);
  const OWN_HOST_REFUSAL =
    'That URL is this Slotlock deployment’s own address. Give the address of the model’s API.';
  const assistantTimeout = assistantOptions?.timeoutMs ?? 30_000;
  const assistantTurnTimeout = assistantOptions?.turnTimeoutMs ?? 90_000;
  // Kept until the member deletes a conversation, unless the deployment gives them a lifetime.
  const conversationTtl: number | null = assistantOptions?.conversationTtlMs ?? null;
  /** How recently a conversation was used for the assistant page to open on it rather than a new one. */
  const CHAT_RESUME_MS = 2 * 3_600_000;
  const newChatId = () => randomBytes(12).toString('base64url');
  /** The conversation a page or form names, or null for a new one. */
  const chatOf = (value: string | null | undefined): string | null =>
    value && SLOTLOCK_ASSISTANT_CHAT_ID.test(value) ? value : null;
  const chatUrl = (id: string | null) => `${root}/assistant?c=${id ?? 'new'}`;
  /**
   * The conversation a form goes to: the one its `chat` names, a new one when it is empty, and with
   * no `chat` at all (a page of an earlier release), the one the page would open: the member's most
   * recent, used in the past two hours (`anyAge`: however long ago).
   */
  async function chatOfForm(
    store: SlotlockAssistantStore,
    session: Session,
    form: URLSearchParams,
    anyAge = false,
  ): Promise<string | null> {
    if (form.has('chat')) return chatOf(form.get('chat'));
    const [latest] = await store.listChats(tenantOf(session), personOf(session), 1);
    return latest && (anyAge || now() - latest.updatedAt.getTime() < CHAT_RESUME_MS) ? latest.id : null;
  }
  /** A conversation's first title: its first message on one line, cut at a word near 60 characters. */
  const chatTitle = (text: string): string => {
    const line = text.replace(/\s+/gu, ' ').trim();
    const chars = [...line];
    if (chars.length <= 60) return line || 'New chat';
    const cut = chars.slice(0, 60).join('');
    const space = cut.lastIndexOf(' ');
    return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/u, '')}…`;
  };
  if (assistantOptions && Buffer.byteLength(assistantOptions.secret, 'utf8') < 32) {
    throw new Error('Slotlock dashboard assistant secret must be at least 32 bytes');
  }
  if (assistantOptions && assistantOptions.secret === options.sessionSecret) {
    throw new Error('Slotlock dashboard assistant secret must differ from the session secret');
  }
  const previousSecrets = [...(assistantOptions?.previousSecrets ?? [])];
  if (previousSecrets.length > SLOTLOCK_ASSISTANT_MAX_PREVIOUS_SECRETS) {
    throw new Error(
      `Slotlock dashboard assistant takes at most ${String(SLOTLOCK_ASSISTANT_MAX_PREVIOUS_SECRETS)} previous secrets`,
    );
  }
  for (const previous of previousSecrets) {
    if (Buffer.byteLength(previous, 'utf8') < 32) {
      throw new Error('Slotlock dashboard assistant previous secrets must each be at least 32 bytes');
    }
    if (previous === assistantOptions?.secret || previous === options.sessionSecret) {
      throw new Error(
        'Slotlock dashboard assistant previous secrets must differ from the assistant and session secrets',
      );
    }
  }
  if (new Set(previousSecrets).size !== previousSecrets.length) {
    throw new Error('Slotlock dashboard assistant previous secrets must differ from each other');
  }
  /** The current secret, then the previous ones: a stored key is tried with each in turn. */
  const assistantSecrets = assistantOptions ? [assistantOptions.secret, ...previousSecrets] : [];
  const memberMessages = createSlotlockRateLimiter(
    assistantOptions?.rate ?? { perSecond: 10 / 60, burst: 10 },
    now,
  );
  const toolTitles = new Map(slotlockAgentTools().map((tool) => [tool.name as string, tool.title]));
  /** The writes that take an idempotency key: the dashboard sets it, from the action's id. */
  const keyed = new Set(
    slotlockAgentTools()
      .filter((tool) => 'idempotency_key' in ((tool.inputSchema as { properties?: object }).properties ?? {}))
      .map((tool) => tool.name as string),
  );
  const ACTION_ID = /^[A-Za-z0-9_-]{16}$/;
  /** Reads one member message may make, and the resource-days they may cover together. */
  const MAX_READS_PER_TURN = 16;
  const MAX_READ_COST_PER_TURN = 400;
  /** What a read costs the turn: the resources it names times the days its window spans. */
  const readCostOf = (input: unknown): number => {
    if (!isRecord(input)) return 1;
    const ids = Array.isArray(input.resource_ids) ? input.resource_ids.length : 1;
    const start = typeof input.start === 'string' ? Date.parse(input.start) : Number.NaN;
    const end = typeof input.end === 'string' ? Date.parse(input.end) : Number.NaN;
    const days = Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.ceil((end - start) / DAY_MS) : 1;
    return Math.max(1, ids) * Math.max(1, days);
  };
  /**
   * Who the assistant acts as, for the record and for ownership: the member by GitHub user id,
   * which a rename does not change. Shown as "Assistant for @login".
   */
  const assistantActor = (session: Session) => `dashboard-assistant:${personOf(session)}`;
  const CONFIRMED_WRITES: ReadonlySet<string> = new Set<SlotlockAgentWriteOperation>([
    'slotlock_create_event',
    'slotlock_update_event',
    'slotlock_delete_event',
    'slotlock_book_together',
    'slotlock_book_pool',
  ]);

  /**
   * The sentence a proposed change's card leads with: the agent server's confirmation question
   * (the resource by name, the times in its zone, an event as it stands: its title, resource and
   * time), or for holds the slots by resource. Read as the member's assistant, under `authorize`.
   */
  async function summarize(
    session: Session,
    operation: SlotlockAgentOperation,
    input: Record<string, unknown>,
  ): Promise<string> {
    const assistant = assistantOptions as SlotlockDashboardAssistantOptions;
    let text: string;
    if (CONFIRMED_WRITES.has(operation)) {
      text = await describeSlotlockAgentWrite({
        backend: assistant.backend,
        authorize: assistantAuthorize,
        principal: assistantPrincipal(session),
        operation: operation as SlotlockAgentWriteOperation,
        input,
        signal: AbortSignal.timeout(assistantTimeout),
      }).catch(() => '');
    } else if (operation === 'slotlock_hold_slots' && Array.isArray(input.slots)) {
      const names = new Map(
        (await options.resources.list(tenantOf(session))).map((resource) => [resource.id, resourceName(resource, resource.id)]),
      );
      const slots = (input.slots as Array<Record<string, unknown>>).map(
        (slot) => `${names.get(String(slot.resource_id)) ?? `resource ${String(slot.resource_id)}`} ${String(slot.start)} to ${String(slot.end)}`,
      );
      text = `Hold ${slots.join('; ')} for ${String(input.ttl_seconds ?? '')} seconds, as alternatives.`;
    } else if (operation === 'slotlock_release_slots') {
      text = `Release the hold ${String(input.hold_id)} and every slot held with it.`;
    } else if (operation === 'slotlock_confirm_slot') {
      text = `Book the time held by ${String(input.hold_id)}${input.title ? `, as "${String(input.title)}"` : ''}, and release the other holds made with it.`;
    } else if (operation === 'slotlock_reschedule') {
      text = `Move the event ${String(input.event_id)} to ${String(input.starts_at)} to ${String(input.ends_at)}${input.resource_id ? ` on resource ${String(input.resource_id)}` : ''}.`;
    } else if (operation === 'slotlock_cancel') {
      text = `Cancel the event ${String(input.event_id)}.`;
    } else {
      text = '';
    }
    // At most 1,500 UTF-8 bytes, so four waiting changes stay within the conversation's bound.
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }

  /** Owners of the organization in use may change its assistant; a person always may their own. */
  /** An owner of the workspace: the person in their own, an organization's owner in its. */
  /** May connect or change the assistant's model (Owner, Admin). */
  const isAdmin = (session: Session) => can(session, 'assistant.settings');
  /** May change the plan and open billing (Owner, Billing). */
  const mayBill = (session: Session) => can(session, 'billing.manage');
  /** Never more than the person may do: a Viewer's assistant only reads; it never holds admin. */
  const assistantPrincipal = (session: Session): SlotlockAgentPrincipal => ({
    subject: assistantActor(session),
    tenantRef: tenantOf(session),
    scopes: can(session, 'operations.run') ? ['read', 'write'] : ['read'],
  });
  /** The fixed list, then the embedder's check: nothing the model sends adds to it. */
  const assistantAuthorize: SlotlockAgentOperationDispatchOptions['authorize'] = async (args) =>
    SLOTLOCK_ASSISTANT_TOOL_USE[args.operation] !== 'excluded' &&
    (assistantOptions?.authorize ? await assistantOptions.authorize(args) : true);

  /**
   * One agent operation as the member's assistant. A `propose` call is checked as an agent's is
   * (arguments, scopes, authorize) and halted by `confirm` before it runs; it takes no admission
   * slot and no rate token, which the write takes when it runs, approved (`run`).
   */
  function dispatch(
    session: Session,
    operation: SlotlockAgentOperation,
    input: unknown,
    mode: 'run' | 'propose',
    confirm?: SlotlockAgentOperationDispatchOptions['confirm'],
  ): Promise<SlotlockAgentOperationDispatchResult> {
    const assistant = assistantOptions as SlotlockDashboardAssistantOptions;
    const principal = assistantPrincipal(session);
    return invokeSlotlockAgentOperation({
      operation,
      origin: 'dashboard-assistant',
      input,
      request: new Request(`${origin}${root}/assistant`, {
        signal: AbortSignal.timeout(assistantTimeout),
      }),
      options: {
        backend: assistant.backend,
        authenticate: async () => principal,
        authorize: async (args) => {
          if (!(await assistantAuthorize(args))) return false;
          if (mode === 'run') await assistant.admit?.(args);
          return true;
        },
        ...(assistant.consumeRateLimit && mode === 'run'
          ? { consumeRateLimit: assistant.consumeRateLimit }
          : {}),
        ...(confirm ? { confirm } : {}),
        // A proposal halts at `confirm` and never reaches the backend, so only what runs counts.
        ...(assistant.onUsage ? { onUsage: assistant.onUsage } : {}),
        onError: (error) => {
          try {
            ignoreRejection(options.onError?.(error));
          } catch {
            // A failing reporter must not change the answer.
          }
        },
      },
    });
  }

  async function assistantModel(
    session: Session,
  ): Promise<{ model: SlotlockAssistantModel } | { problem: string } | null> {
    const store = assistantStore();
    const settings = store ? await store.getSettings(tenantOf(session)) : null;
    if (!settings || !assistantOptions) return null;
    if (namesOwnHost(settings.baseUrl)) return { problem: OWN_HOST_REFUSAL };
    if (
      !slotlockAssistantUrlAllowed(settings.baseUrl, privateUrls) ||
      !(await checkSlotlockAssistantHost(settings.baseUrl, { privateUrls, resolve: resolveHost }))
    ) {
      return { problem: PRIVATE_URL_REFUSAL };
    }
    let apiKey: string | null = null;
    if (settings.sealedKey !== null) {
      const tenantRef = tenantOf(session);
      const opened = await openSlotlockAssistantKeyWithAny(assistantSecrets, tenantRef, settings.sealedKey);
      if (opened === null) {
        return {
          problem:
            'The stored API key cannot be opened: the server’s assistant secret changed. An admin can enter the key again in Settings.',
        };
      }
      apiKey = opened.apiKey;
      // Sealed under a previous secret: sealed again under the current one, unless an owner saved
      // another key meanwhile. Best effort: the key opened either way.
      if (opened.secretIndex > 0 && store?.resealKey) {
        try {
          const resealed = await sealSlotlockAssistantKey(assistantOptions.secret, tenantRef, apiKey);
          await store.resealKey(tenantRef, settings.sealedKey, resealed);
        } catch (error) {
          // A suspended tenant reads and writes nothing, this included: it opens the old way.
          if ((error as { code?: unknown } | null)?.code !== 'tenant_suspended') {
            ignoreRejection(options.onError?.(error));
          }
        }
      }
    }
    return {
      model: { provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey },
    };
  }

  /** When a change happens, in its resource's time zone when the card knows it, else UTC. */
  function whenOf(start: unknown, end: unknown, zone: string | undefined): string | null {
    if (typeof start !== 'string') return null;
    const from = new Date(start);
    if (Number.isNaN(from.getTime())) return null;
    const timeZone = zone ?? 'UTC';
    let day: Intl.DateTimeFormat;
    let time: Intl.DateTimeFormat;
    try {
      day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone });
      time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
    } catch {
      return null;
    }
    const to = typeof end === 'string' ? new Date(end) : null;
    const span =
      to && !Number.isNaN(to.getTime())
        ? day.format(from) === day.format(to)
          ? `${time.format(from)}–${time.format(to)}`
          : `${time.format(from)} – ${day.format(to)}, ${time.format(to)}`
        : time.format(from);
    return `${day.format(from)}, ${span} ${timeZone}`;
  }

  /** What a proposed change's fields are called on its card. */
  const FACT_NAMES: Readonly<Record<string, string>> = Object.freeze({
    resource_id: 'Resource',
    resource_ids: 'Resources',
    pool_id: 'Pool',
    title: 'Title',
    external_ref: 'Reference',
    event_id: 'Booking',
    hold_id: 'Hold',
    hold_group_id: 'Held together',
    ttl_seconds: 'Held for',
    notes: 'Note',
    description: 'Note',
    metadata: 'Details',
    slots: 'Times',
  });

  /**
   * A field of a proposed change, as the card shows it: all of it, wrapped, never cut (the proposal
   * is bounded instead). A resource is named; its id is the name's title.
   */
  function fieldValue(name: string, value: unknown, names: ReadonlyMap<string, string>): Html {
    const named = (id: string) =>
      names.has(id) ? html`<span title="${id}">${names.get(id) as string}</span>` : html`<code>${id}</code>`;
    if (name === 'resource_id' && typeof value === 'string') return named(value);
    if (name === 'resource_ids' && Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return html`${(value as string[]).map((id, index) => html`${index > 0 ? ', ' : ''}${named(id)}`)}`;
    }
    if (name === 'ttl_seconds' && typeof value === 'number') {
      return html`${value >= 60 ? `${Math.round(value / 60)} min` : `${value} s`}`;
    }
    if ((name === 'event_id' || name === 'hold_id' || name === 'hold_group_id') && typeof value === 'string') return html`<code>${value}</code>`;
    if (typeof value === 'string') return html`<span class="wrap">${value}</span>`;
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return html`<span class="wrap">${(value as string[]).join(', ')}</span>`;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return html`${String(value)}`;
    return html`<pre>${JSON.stringify(value, null, 2)}</pre>`;
  }

  /** Why a change or a step was refused, in words, for the codes a member meets. */
  const REFUSALS: Readonly<Record<string, string>> = Object.freeze({
    overlap: 'that time was just taken',
    pool_full: 'the pool is full then',
    not_found: 'it no longer exists',
    resource_not_found: 'the resource no longer exists',
    event_not_found: 'the booking no longer exists',
    invalid_input: 'the request was incomplete',
    invalid_arguments: 'the request was incomplete',
    validation_error: 'the request was incomplete',
    turn_read_budget_exceeded: 'one message may read only so much',
    too_many_pending_changes: 'too many changes are waiting for you',
    change_too_large_to_show: 'the change was too large to show',
    tool_not_available: 'the assistant may not do that',
    too_many_calls: 'too many at once',
    quota_exceeded: "this month's allowance is used up",
    approval_pending: 'it is waiting for an approval',
  });
  const refusal = (code: string) => REFUSALS[code] ?? code.replaceAll('_', ' ');

  function actionCard(
    session: Session,
    action: SlotlockAssistantAction,
    names: ReadonlyMap<string, string>,
    zones: ReadonlyMap<string, string>,
    chatId: string | null,
  ): Html {
    const verb = slotlockAssistantActionVerb(action.operation);
    const title = action.summary || `${verb.verb}: ${toolTitles.get(action.operation) ?? action.operation}`;
    if (action.status !== 'pending') {
      const [tone, word] =
        action.status === 'done'
          ? ['ok', verb.done]
          : action.status === 'dismissed'
            ? ['', 'Declined']
            : action.status === 'approved'
              ? ['', 'Running…']
              : ['bad', `Refused: ${refusal(action.outcome ?? 'failed')}`];
      return html`<li class="turn action" id="action-${action.id}"><p class="receipt ${tone}"><span>${title}</span><span class="why">${word}</span></p></li>`;
    }
    const token = csrfToken(session);
    const input = Object.entries(action.input).filter(([name]) => name !== 'idempotency_key');
    // The change's own time zone when it gives one, else its resource's.
    const zone =
      typeof action.input.timezone === 'string'
        ? action.input.timezone
        : typeof action.input.resource_id === 'string'
          ? zones.get(action.input.resource_id)
          : undefined;
    const when = whenOf(action.input.starts_at, action.input.ends_at, zone);
    const facts: Html[] = [];
    const more: Html[] = [];
    if (when) facts.push(html`<dt>When</dt><dd>${when}</dd>`);
    for (const [name, value] of input) {
      if (when && (name === 'starts_at' || name === 'ends_at' || name === 'timezone')) continue;
      const label = FACT_NAMES[name] ?? name.charAt(0).toUpperCase() + name.slice(1).replaceAll('_', ' ');
      (name in FACT_NAMES || name === 'attendees' ? facts : more).push(
        html`<dt>${label}</dt><dd>${fieldValue(name, value, names)}</dd>`,
      );
    }
    const hidden = (id: string) =>
      html`<input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="chat" value="${chatId ?? ''}"><input type="hidden" name="action" value="${id}">`;
    return html`<li class="turn action" id="action-${action.id}"><div class="change"><p class="change-title">${title}</p>${
      facts.length > 0 ? html`<dl class="facts">${facts}</dl>` : html``
    }${
      more.length > 0
        ? html`<details class="more"><summary>All details</summary><dl class="facts">${more}</dl></details>`
        : html``
    }<div class="change-buttons"><form method="post" action="${root}/assistant/approve">${hidden(action.id)}<button class="${verb.danger ? 'danger' : 'primary'}" type="submit" data-busy="${verb.busy}">${verb.verb}</button></form><form method="post" action="${root}/assistant/dismiss">${hidden(action.id)}<button class="ghost" type="submit">Decline</button></form></div></div></li>`;
  }

  function readAction(id: string, value: unknown): SlotlockAssistantAction | null {
    if (!isRecord(value) || typeof value.operation !== 'string') return null;
    return {
      id,
      operation: value.operation as SlotlockAgentOperation,
      input: isRecord(value.input) ? value.input : {},
      ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
      status: (typeof value.status === 'string' ? value.status : 'failed') as SlotlockAssistantAction['status'],
      ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
    };
  }

  /** The code a tool result was refused with, from the JSON the model was given. */
  function refusedCode(content: string): string | null {
    try {
      const parsed = JSON.parse(content) as unknown;
      const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
      return error && typeof error.code === 'string' ? error.code : null;
    } catch {
      return null;
    }
  }

  /** Notes the turn ends with that are not a failure: a member's Stop, and the step bound. */
  const quietNote = (text: string) => text === 'Stopped.' || text.startsWith('The assistant stopped after');

  /**
   * The conversation as the thread shows it: the member's messages as bubbles, the replies as
   * rendered Markdown, each run of tool steps folded into one line, proposed changes as cards, and
   * a failure that ends it with a way to send the last message again.
   */
  function assistantItems(
    session: Session,
    entries: readonly SlotlockAssistantEntry[],
    actions: Record<string, unknown>,
    names: ReadonlyMap<string, string>,
    zones: ReadonlyMap<string, string>,
    chatId: string | null,
  ): Html[] {
    const items: Html[] = [];
    let steps: { label: string; ok: boolean; why: string | null }[] = [];
    let cards: Html[] = [];
    const flush = () => {
      if (steps.length > 0) {
        const bad = steps.some((step) => !step.ok);
        const seen: string[] = [];
        for (const step of steps) if (!seen.includes(step.label)) seen.push(step.label);
        const summary = seen.map((label, index) => (index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1))).join(', ');
        items.push(
          html`<li class="turn steps"><details class="steps${bad ? ' has-bad' : ''}"><summary>${summary}</summary><ul class="step-list">${steps.map(
            (step) =>
              html`<li class="step ${step.ok ? 'ok' : 'bad'}">${step.label}${step.why ? html` <span class="why">${step.why}</span>` : html``}</li>`,
          )}</ul></details></li>`,
        );
        steps = [];
      }
      items.push(...cards);
      cards = [];
    };
    const lastUser = [...entries].reverse().find((entry) => entry.role === 'user');
    for (const [index, entry] of entries.entries()) {
      if (entry.role === 'user') {
        flush();
        items.push(html`<li class="turn mine"><div class="bubble">${entry.text}</div></li>`);
      } else if (entry.role === 'assistant') {
        if (entry.text.trim() === '') continue;
        flush();
        items.push(html`<li class="turn bot"><div class="prose">${new Html(renderSlotlockMarkdown(entry.text))}</div></li>`);
      } else if (entry.role === 'tool') {
        for (const result of entry.results) {
          const write = SLOTLOCK_ASSISTANT_TOOL_USE[result.name as SlotlockAgentOperation] === 'propose';
          const action = result.action ? readAction(result.action, actions[result.action]) : null;
          if (action) {
            cards.push(actionCard(session, action, names, zones, chatId));
            continue;
          }
          const title = toolTitles.get(result.name) ?? result.name;
          const code = result.error ? refusedCode(result.content) : null;
          steps.push({
            label: slotlockAssistantStepLabel(result.name, title, result.error ? 'bad' : 'ok', write),
            ok: !result.error,
            why: code ? refusal(code) : null,
          });
        }
      } else if (entry.role === 'note') {
        flush();
        const last = index === entries.length - 1;
        if (last && !quietNote(entry.text) && lastUser?.role === 'user') {
          items.push(
            html`<li class="turn error" role="alert"><span>${entry.text}</span><form method="post" action="${root}/assistant"><input type="hidden" name="csrf" value="${csrfToken(session)}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="chat" value="${chatId ?? ''}"><input type="hidden" name="message" value="${lastUser.text}"><button class="text-button" type="submit">Retry</button></form></li>`,
          );
        } else {
          items.push(html`<li class="turn note">${entry.text}</li>`);
        }
      }
    }
    flush();
    return items;
  }

  /** The tenant's resources as a proposed change's card names them, and each one's time zone. */
  async function resourceLookups(tenantRef: string) {
    const resources = await options.resources.list(tenantRef);
    return {
      resources,
      names: new Map(resources.map((resource) => [resource.id, resourceName(resource, resource.id)])),
      zones: new Map(resources.flatMap((resource) => (resource.timezone ? [[resource.id, resource.timezone] as const] : []))),
    };
  }

  const ASSISTANT_ICONS = {
    send: new Html('<svg class="arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>'),
    stop: new Html('<svg class="stop" viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>'),
    down: new Html('<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5"/></svg>'),
    plus: new Html('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>'),
    more: new Html('<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>'),
    chats: new Html('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6"/></svg>'),
  };

  /** How long ago a chat was used, as briefly as the list has room for: 4m, 3h, 5d, then the date. */
  function chatSince(at: Date): string {
    const minutes = Math.max(0, Math.floor((now() - at.getTime()) / 60_000));
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${String(minutes)}m`;
    if (minutes < 24 * 60) return `${String(Math.floor(minutes / 60))}h`;
    if (minutes < 7 * 24 * 60) return `${String(Math.floor(minutes / (24 * 60)))}d`;
    return zoned('UTC', { day: 'numeric', month: 'short' }).format(at);
  }

  /** When a conversation was last used, as the Chats list groups them: by day, in UTC. */
  function chatGroup(at: Date): string {
    const day = (ms: number) => Math.floor(ms / DAY_MS);
    const daysAgo = day(now()) - day(at.getTime());
    if (daysAgo <= 0) return 'Today';
    if (daysAgo === 1) return 'Yesterday';
    if (daysAgo < 7) return 'Previous 7 days';
    if (daysAgo < 30) return 'Previous 30 days';
    return 'Older';
  }

  /**
   * A member's conversations, the most recent first, grouped by when they were last used: each
   * opens with a link, and has Rename and Delete behind its menu. `current` is the one shown.
   */
  function chatsPanel(session: Session, chats: readonly SlotlockAssistantChatSummary[], current: string | null): Html {
    const token = csrfToken(session);
    const hidden = (id: string) =>
      html`<input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="chat" value="${id}">`;
    const groups: { label: string; rows: Html[] }[] = [];
    for (const chat of chats) {
      const label = chatGroup(chat.updatedAt);
      let group = groups.at(-1);
      if (!group || group.label !== label) {
        group = { label, rows: [] };
        groups.push(group);
      }
      const here = chat.id === current;
      group.rows.push(html`<li class="chat-row${here ? ' current' : ''}"><a class="chat-link" href="${chatUrl(chat.id)}"${here ? html` aria-current="page"` : html``}><span class="chat-title">${chat.title}</span><time class="chat-when" datetime="${chat.updatedAt.toISOString()}" title="${formatDate(chat.updatedAt)}">${chatSince(chat.updatedAt)}</time></a><details class="chat-menu"><summary aria-label="Options for ${chat.title}">${ASSISTANT_ICONS.more}</summary><div class="pop"><form class="chat-rename" method="post" action="${root}/assistant/rename">${hidden(chat.id)}<label class="visually-hidden" for="title-${chat.id}">Title</label><input id="title-${chat.id}" name="title" value="${chat.title}" maxlength="120" required><button type="submit">Rename</button></form><form method="post" action="${root}/assistant/delete">${hidden(chat.id)}<button class="danger" type="submit">Delete chat</button></form></div></details></li>`);
    }
    const list =
      groups.length === 0
        ? html`<p class="empty chats-empty">No chats yet.</p>`
        : html`${groups.map((group) => html`<h3 class="chat-group">${group.label}</h3><ul class="chat-rows">${group.rows}</ul>`)}`;
    return html`<aside class="chats" aria-label="Chats"><div class="chats-head"><h2>Chats</h2><a class="icon-button" href="${chatUrl(null)}" aria-label="New chat" title="New chat">${ASSISTANT_ICONS.plus}</a></div><label class="visually-hidden" for="chats-filter">Search chats</label><input id="chats-filter" class="chats-filter" type="search" placeholder="Search chats" autocomplete="off" hidden><nav class="chat-list" aria-label="Your chats">${list}</nav></aside>`;
  }

  /**
   * The assistant: a conversation, with the member's others beside it. `requested` is the page's
   * `c`: a conversation's id, `new` for a new one, or nothing for the last one used in the past two
   * hours (else a new one).
   */
  async function assistantPage(
    session: Session,
    status = 200,
    notice?: string,
    requested?: string,
  ): Promise<Response> {
    const store = assistantStore();
    if (!store) return notFound(session);
    const tenantRef = tenantOf(session);
    const member = personOf(session);
    const [settings, chats] = await Promise.all([store.getSettings(tenantRef), store.listChats(tenantRef, member)]);
    if (!settings) {
      const content = html`${noticeOf(notice, status)}${pageHead('Assistant')}${emptyState(
        ICONS.assistant,
        isAdmin(session) ? 'Connect a model to use the assistant.' : 'An admin of this organization connects a model in Settings.',
        isAdmin(session) ? { href: `${root}/settings#assistant`, label: 'Connect a model' } : undefined,
      )}`;
      return respond(status, layout('Assistant', content, session, 'assistant'));
    }
    let chatId = chatOf(requested);
    if (requested === undefined) {
      const latest = chats[0];
      if (latest && now() - latest.updatedAt.getTime() < CHAT_RESUME_MS) chatId = latest.id;
    }
    const conversation = chatId ? await store.getChat(tenantRef, member, chatId) : null;
    if (chatId && !conversation) {
      // Deleted, or never this member's: a new one instead, saying so.
      chatId = null;
      if (requested !== undefined && notice === undefined) {
        notice = 'That chat is not here: it was deleted.';
        status = 404;
      }
    }
    const entries = readSlotlockAssistantEntries(conversation?.messages);
    const actions = conversation?.actions ?? {};
    const empty = entries.length === 0;
    const { resources, names, zones } =
      empty || Object.keys(actions).length > 0
        ? await resourceLookups(tenantRef)
        : { resources: [], names: new Map<string, string>(), zones: new Map<string, string>() };
    const token = csrfToken(session);
    const hidden = () =>
      html`<input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="chat" value="${chatId ?? ''}">`;
    const first = resources.find((resource) => !resource.archivedAt);
    const named = first ? resourceName(first, first.id) : null;
    // A read chip asks at once; a write chip fills the box to finish (app.js), or asks (no script).
    const prompts: { label: string; message: string; fill?: true }[] = [
      { label: "What's on today", message: "What's booked today?" },
      { label: 'Find free time', message: named ? `When is ${named} free tomorrow morning?` : 'What is free tomorrow morning?' },
      { label: 'Book', message: named ? `Book ${named} tomorrow 9:00–10:00` : 'Book ', fill: true },
      { label: 'Move a booking', message: 'Move the next booking one hour later', fill: true },
      { label: 'Cancel a booking', message: 'Cancel the next booking', fill: true },
    ];
    const chips = html`<div class="assistant-start"><div class="chips">${prompts.map(
      (prompt) =>
        html`<form method="post" action="${root}/assistant">${hidden()}<button class="chip" type="submit" name="message" value="${prompt.message}"${
          prompt.fill ? html` data-fill="${prompt.message}"` : html``
        }>${prompt.label}</button></form>`,
    )}</div></div>`;
    const composer = html`<div class="dock"><button class="jump" type="button" hidden aria-label="Jump to the latest message">${ASSISTANT_ICONS.down}</button><form class="composer" method="post" action="${root}/assistant">${hidden()}<label class="visually-hidden" for="message">Message</label><textarea id="message" name="message" rows="2" maxlength="${String(SLOTLOCK_ASSISTANT_MAX_MESSAGE)}" required placeholder="${empty ? 'Ask about bookings' : 'Reply…'}"></textarea><div class="composer-bar"><span class="count" hidden></span><button class="send" type="submit" aria-label="Send">${ASSISTANT_ICONS.send}${ASSISTANT_ICONS.stop}</button></div></form></div>`;
    const actionsHead = html`<div class="assistant-actions"><a class="button ghost chats-link" href="${root}/assistant/chats">${ASSISTANT_ICONS.chats}Chats</a><a class="button ghost new-chat" href="${chatUrl(null)}">${ASSISTANT_ICONS.plus}New chat</a></div>`;
    const flag = empty ? new Html(' data-empty') : html``;
    const content = html`${noticeOf(notice, status)}<div class="assistant-shell">${chatsPanel(session, chats, chatId)}<div class="assistant-page"${flag}>${pageHead(
      conversation?.title ?? 'Assistant',
      actionsHead,
    )}<div class="assistant" data-assistant data-stream="${root}/assistant/stream" data-page="${root}/assistant"${flag}><ol class="thread">${assistantItems(
      session,
      entries,
      actions,
      names,
      zones,
      chatId,
    )}</ol><span id="latest"></span>${chips}${composer}</div></div></div>`;
    return respond(status, layout('Assistant', content, session, 'assistant'));
  }

  /** The member's conversations on a page of their own: the Chats list where the page is narrow. */
  async function chatsPage(session: Session): Promise<Response> {
    const store = assistantStore();
    if (!store) return notFound(session);
    const chats = await store.listChats(tenantOf(session), personOf(session));
    const content = html`<div class="chats-page">${pageHead('Chats', html`<a class="button ghost" href="${chatUrl(null)}">${ASSISTANT_ICONS.plus}New chat</a>`)}${chatsPanel(session, chats, null)}</div>`;
    return respond(200, layout('Chats', content, session, 'assistant'));
  }

  /** The assistant form as a preset or a model list leaves it, not yet saved. */
  type AssistantDraft = {
    provider: 'anthropic' | 'openai';
    baseUrl: string;
    model?: string;
    /** The models the provider listed, offered for the Model field. */
    models?: readonly string[];
  };

  /** The named provider a provider and base URL are, or none (Custom). */
  const presetOf = (provider: string, baseUrl: string) =>
    SLOTLOCK_ASSISTANT_PRESETS.find(
      (preset) => preset.id !== 'custom' && preset.provider === provider && preset.baseUrl === baseUrl,
    );

  /**
   * The assistant's settings: what is connected and whether it answers (Test, its result in place),
   * then the form, one provider chosen from tiles, and Disconnect apart. A member sees only what is
   * connected, and where their messages go.
   */
  async function assistantSettingsSection(
    session: Session,
    status: number,
    notice: string | undefined,
    draft?: AssistantDraft,
  ): Promise<Html> {
    const store = assistantStore() as SlotlockAssistantStore;
    const settings = await store.getSettings(tenantOf(session));
    const token = csrfToken(session);
    const hidden = () =>
      html`<input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}">`;
    const savedName = settings ? (presetOf(settings.provider, settings.baseUrl)?.name ?? 'Custom') : null;
    // Where messages go, in words: the provider's name, or a custom one's host.
    const hostOf = (url: string) => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    };
    const savedTo = settings ? (savedName === 'Custom' ? hostOf(settings.baseUrl) : savedName) : null;
    const admin = isAdmin(session);
    const badge = !settings
      ? html`<span class="badge">Not set up</span>`
      : notice && status === 200 && notice.startsWith('Connected')
        ? html`<span class="badge ok">Connected</span>`
        : notice && status === 502
          ? html`<span class="badge bad">Failing</span>`
          : html`<span class="badge ok">Set up</span>`;
    const test =
      settings && admin
        ? html`<form method="post" action="${root}/settings/assistant/test">${hidden()}<button type="submit">Test</button></form>`
        : html``;
    const statusCard = html`<div class="set-card status-card" id="assistant"><div class="status-head"><span class="mono-tile" aria-hidden="true">${
      savedName ? savedName.charAt(0) : '–'
    }</span><div class="status-name"><strong>${savedName ?? 'No model connected'}</strong>${
      settings ? html`<code>${settings.model}</code>` : html``
    }</div>${badge}${test}</div>${noticeOf(notice, status)}</div>`;
    const sentTo = (name: string | null) =>
      html`<p class="fine">Members' messages, and the bookings they ask about, are sent to ${name ?? 'the provider you choose'}.</p>`;
    if (!admin) {
      return html`${statusCard}${settings ? sentTo(savedTo) : html`<p class="fine">An admin of this organization connects a model here.</p>`}`;
    }
    // What the form shows: a draft (a preset, or a model list) over what is saved.
    const provider = draft?.provider ?? settings?.provider ?? 'anthropic';
    const baseUrl = draft ? draft.baseUrl : (settings?.baseUrl ?? '');
    const model = draft?.model ?? settings?.model ?? '';
    const chosen = settings || draft ? (presetOf(provider, baseUrl)?.id ?? 'custom') : 'anthropic';
    const chosenName =
      chosen === 'custom' ? (baseUrl ? hostOf(baseUrl) : null) : (SLOTLOCK_ASSISTANT_PRESETS.find((preset) => preset.id === chosen)?.name ?? null);
    const models = draft?.models ?? [];
    const tiles = html`<div class="tiles" role="radiogroup" aria-label="Provider">${SLOTLOCK_ASSISTANT_PRESETS.map(
      (preset) =>
        html`<label class="tile"><input type="radio" name="preset" value="${preset.id}"${
          preset.id === chosen ? html` checked` : html``
        }><span class="tile-mark" aria-hidden="true">${preset.name.charAt(0)}</span>${preset.name}</label>`,
    )}</div>`;
    const format = (value: 'anthropic' | 'openai', label: string) =>
      html`<label><input type="radio" name="provider" value="${value}"${provider === value ? html` checked` : html``}>${label}</label>`;
    const keyField = settings?.keyHint
      ? html`<div class="key-set"><code>•••• ${settings.keyHint}</code><details><summary>Replace</summary><input id="api-key" name="api_key" type="password" autocomplete="off" maxlength="4096" aria-label="New API key"></details></div>`
      : html`<input id="api-key" name="api_key" type="password" autocomplete="off" maxlength="4096" placeholder="Optional for a local model">`;
    const form = html`<form class="set-card provider-form" method="post" action="${root}/settings/assistant">${hidden()}<div class="row stack"><span class="row-label">Provider</span>${tiles}</div><div class="row custom-only"><span class="row-label">API format</span><div class="segmented">${format(
      'anthropic',
      'Anthropic Messages',
    )}${format('openai', 'OpenAI-compatible')}</div></div><div class="row custom-only"><label class="row-label" for="base-url">Base URL</label><input id="base-url" class="mono" name="base_url" maxlength="2048" value="${baseUrl}" placeholder="https://host/v1"></div><div class="row"><label class="row-label" for="model">Model</label><div class="field-with-button"><input id="model" class="mono" name="model" required maxlength="200" value="${model}" placeholder="Model name"${
      models.length > 0 ? html` list="assistant-models"` : html``
    }><button type="submit" formaction="${root}/settings/assistant/models" formnovalidate>Load models</button></div>${
      models.length > 0
        ? html`<datalist id="assistant-models">${models.map((id) => html`<option value="${id}"></option>`)}</datalist>`
        : html``
    }</div><div class="row"><label class="row-label" for="api-key">API key</label>${keyField}</div><div class="card-foot">${sentTo(
      chosenName,
    )}<button class="primary" type="submit">Save</button></div></form>`;
    const disconnect = settings
      ? html`<div class="set-card"><div class="danger-row"><strong>Disconnect ${savedName}</strong><details class="act danger"><summary>Disconnect…</summary><div class="pop"><p>The key is deleted. Members can't use the assistant until a model is connected again.</p><form method="post" action="${root}/settings/assistant/remove">${hidden()}<button class="danger" type="submit">Disconnect</button></form></div></details></div></div>`
      : html``;
    return html`${statusCard}${form}${disconnect}`;
  }

  /** The provider and base URL a form names: a named provider's own, or Custom's two fields. */
  function formEndpoint(form: URLSearchParams): { provider: string | null; baseUrl: string } {
    const preset = SLOTLOCK_ASSISTANT_PRESETS.find((candidate) => candidate.id === form.get('preset'));
    if (preset && preset.id !== 'custom') return { provider: preset.provider, baseUrl: preset.baseUrl };
    return { provider: form.get('provider'), baseUrl: (form.get('base_url') ?? '').trim() };
  }

  const adminOnly = (session: Session) =>
    settingsPage(session, 403, 'Only an owner or an admin of this workspace can change the assistant.');

  async function saveAssistantSettings(session: Session, form: URLSearchParams): Promise<Response> {
    const store = assistantStore();
    if (!store || !assistantOptions) return notFound(session);
    if (!isAdmin(session)) return adminOnly(session);
    const { provider, baseUrl: givenUrl } = formEndpoint(form);
    const checkedUrl = readSlotlockAssistantBaseUrl(givenUrl, { privateUrls });
    const model = (form.get('model') ?? '').trim();
    const apiKey = (form.get('api_key') ?? '').trim();
    if (provider !== 'anthropic' && provider !== 'openai') {
      return settingsPage(session, 400, 'Choose a provider from the list.');
    }
    if (!checkedUrl.ok) {
      return settingsPage(
        session,
        400,
        checkedUrl.reason === 'private'
          ? PRIVATE_URL_REFUSAL
          : 'Give an https base URL (http only for localhost or 127.0.0.1), with no user name, query or #fragment.',
      );
    }
    const baseUrl = checkedUrl.url;
    if (namesOwnHost(baseUrl)) return settingsPage(session, 400, OWN_HOST_REFUSAL);
    if (!(await checkSlotlockAssistantHost(baseUrl, { privateUrls, resolve: resolveHost }))) {
      return settingsPage(session, 400, PRIVATE_URL_REFUSAL);
    }
    if (!SLOTLOCK_ASSISTANT_MODEL_NAME.test(model)) {
      return settingsPage(session, 400, 'Give the model name, 1 to 200 characters without spaces.');
    }
    if (apiKey !== '' && !SLOTLOCK_ASSISTANT_API_KEY.test(apiKey)) {
      return settingsPage(session, 400, 'An API key is up to 4,096 characters without spaces.');
    }
    const tenantRef = tenantOf(session);
    const key =
      apiKey !== ''
        ? { sealed: await sealSlotlockAssistantKey(assistantOptions.secret, tenantRef, apiKey), hint: apiKey.slice(-4) }
        : form.get('clear_key') === '1'
          ? null
          : ('keep' as const);
    // The stored key is only kept for the provider and URL it was entered for: the store decides
    // that in the write itself, so an owner cannot send it elsewhere, however saves race.
    const { saved } = await store.putSettings(tenantRef, { provider, baseUrl, model, key }, personOf(session));
    if (!saved) {
      return settingsPage(
        session,
        400,
        'Enter the API key again: the provider or the base URL changed, and the stored key is only sent where it was entered for. Or remove the key.',
      );
    }
    return redirect(303, `${root}/settings#assistant`);
  }

  /**
   * The provider's models for the Model field (Load models): the form's provider and base URL,
   * checked as saving checks them, with the key given, or the saved one when it is for that same
   * provider and URL. Saves nothing; counted as a message to the assistant.
   */
  async function loadAssistantModels(session: Session, form: URLSearchParams): Promise<Response> {
    const store = assistantStore();
    if (!store || !assistantOptions) return notFound(session);
    if (!isAdmin(session)) return adminOnly(session);
    if (!memberMessages.take(`${tenantOf(session)}\0${session.uid}`)) {
      return tooManyMessages(session, settingsPage);
    }
    const { provider, baseUrl: givenUrl } = formEndpoint(form);
    if (provider !== 'anthropic' && provider !== 'openai') {
      return settingsPage(session, 400, 'Choose a provider from the list.');
    }
    const typedModel = (form.get('model') ?? '').trim();
    const draft: AssistantDraft = {
      provider,
      baseUrl: givenUrl,
      ...(typedModel !== '' ? { model: typedModel } : {}),
    };
    const checkedUrl = readSlotlockAssistantBaseUrl(draft.baseUrl, { privateUrls });
    if (!checkedUrl.ok) {
      return settingsPage(
        session,
        400,
        checkedUrl.reason === 'private'
          ? PRIVATE_URL_REFUSAL
          : 'Give an https base URL (http only for localhost or 127.0.0.1), with no user name, query or #fragment.',
        draft,
      );
    }
    const baseUrl = checkedUrl.url;
    if (namesOwnHost(baseUrl)) return settingsPage(session, 400, OWN_HOST_REFUSAL, draft);
    if (!(await checkSlotlockAssistantHost(baseUrl, { privateUrls, resolve: resolveHost }))) {
      return settingsPage(session, 400, PRIVATE_URL_REFUSAL, draft);
    }
    const typedKey = (form.get('api_key') ?? '').trim();
    if (typedKey !== '' && !SLOTLOCK_ASSISTANT_API_KEY.test(typedKey)) {
      return settingsPage(session, 400, 'An API key is up to 4,096 characters without spaces.', draft);
    }
    // The saved key only for the provider and URL it was entered for, as a model call sends it.
    let apiKey: string | null = typedKey !== '' ? typedKey : null;
    if (apiKey === null) {
      const found = await assistantModel(session);
      if (found && !('problem' in found) && found.model.provider === provider && found.model.baseUrl === baseUrl) {
        apiKey = found.model.apiKey;
      }
    }
    try {
      const listed = await listSlotlockAssistantModels({
        provider,
        baseUrl,
        apiKey,
        fetch: assistantFetch,
        timeoutMs: assistantTimeout,
      });
      return settingsPage(
        session,
        200,
        listed.length > 0
          ? `${listed.length.toLocaleString('en')} model${listed.length === 1 ? '' : 's'} listed: choose one for Model, then Save.${typedKey !== '' ? ' Enter the API key again when you save.' : ''}`
          : 'The provider listed no models. Type the model name.',
        { ...draft, baseUrl, models: listed },
      );
    } catch (error) {
      report(error instanceof Error ? error.message : 'assistant model list failed');
      return settingsPage(session, 502, slotlockAssistantProviderMessage(error), { ...draft, baseUrl });
    }
  }

  async function removeAssistantSettings(session: Session): Promise<Response> {
    const store = assistantStore();
    if (!store) return notFound(session);
    if (!isAdmin(session)) return adminOnly(session);
    await store.deleteSettings(tenantOf(session), personOf(session));
    return redirect(303, `${root}/settings#assistant`);
  }

  const tooManyMessages = (session: Session, page: typeof settingsPage) =>
    page(session, 429, 'You have sent the assistant a lot in the last minute. Wait a moment and try again.');

  async function testAssistant(session: Session): Promise<Response> {
    if (!assistantStore()) return notFound(session);
    if (!isAdmin(session)) return adminOnly(session);
    if (!memberMessages.take(`${tenantOf(session)}\0${session.uid}`)) {
      return tooManyMessages(session, settingsPage);
    }
    const found = await assistantModel(session);
    if (found === null) return settingsPage(session, 409, 'Connect a model first.');
    if ('problem' in found) return settingsPage(session, 409, found.problem);
    try {
      const ok = await testSlotlockAssistantModel({
        model: found.model,
        fetch: assistantFetch,
        timeoutMs: assistantTimeout,
      });
      return settingsPage(
        session,
        ok ? 200 : 502,
        ok
          ? `Connected: ${found.model.model} answered and called a tool correctly.`
          : `${found.model.model} answered, but did not call the tool it was given. Choose a model that supports tool calls.`,
      );
    } catch (error) {
      report(error instanceof Error ? error.message : 'assistant connection test failed');
      return settingsPage(session, 502, slotlockAssistantProviderMessage(error));
    }
  }

  type AssistantRun =
    | { ok: false; status: number; message: string }
    | { ok: true; messages: SlotlockAssistantEntry[]; actions: Record<string, unknown>; chatId: string; title: string };

  /**
   * One member message: check it, run the turn (streaming its text and steps to `onEvent` when
   * given, stopping when `signal` aborts), and keep the conversation. Both ways to send share it.
   */
  async function runAssistantMessage(
    session: Session,
    form: URLSearchParams,
    hooks: { onEvent?: (event: SlotlockAssistantTurnEvent) => void; signal?: AbortSignal } = {},
  ): Promise<AssistantRun> {
    const store = assistantStore();
    if (!store || !assistantOptions) return { ok: false, status: 404, message: 'Nothing is here.' };
    const text = (form.get('message') ?? '').trim();
    if (text === '' || text.length > SLOTLOCK_ASSISTANT_MAX_MESSAGE) {
      return {
        ok: false,
        status: 400,
        message: `Write a message of 1 to ${SLOTLOCK_ASSISTANT_MAX_MESSAGE.toLocaleString('en')} characters.`,
      };
    }
    if (!memberMessages.take(`${tenantOf(session)}\0${session.uid}`)) {
      return {
        ok: false,
        status: 429,
        message: 'You have sent the assistant a lot in the last minute. Wait a moment and try again.',
      };
    }
    const found = await assistantModel(session);
    if (found === null) return { ok: false, status: 409, message: 'No model is connected.' };
    if ('problem' in found) return { ok: false, status: 409, message: found.problem };
    const tenantRef = tenantOf(session);
    const member = personOf(session);
    try {
      ignoreRejection(assistantOptions?.onMessage?.(tenantRef));
    } catch {
      // Metering never changes an answer.
    }
    // The conversation the form continues (a new one when it names none, or one deleted meanwhile),
    // and the resources agents may see, so a name is matched to its id without a lookup.
    const asked = await chatOfForm(store, session, form);
    const [stored, listed] = await Promise.all([
      asked ? store.getChat(tenantRef, member, asked) : Promise.resolve(null),
      options.resources.list(tenantRef).catch(() => [] as SlotlockResource[]),
    ]);
    const chatId = stored?.id ?? newChatId();
    const title = stored?.title ?? chatTitle(text);
    const bookable = listed.filter((resource) => resource.visibility !== 'private' && resource.archivedAt === undefined);
    const entries = boundSlotlockAssistantEntries([
      ...readSlotlockAssistantEntries(stored?.messages),
      { role: 'user', text },
    ]);
    const proposed: Record<string, Record<string, unknown>> = {};
    const pendingBefore = pendingSlotlockAssistantActions(stored?.actions ?? {});
    let reads = 0;
    let readCost = 0;
    const current = session.orgs?.find((org) => org.id === session.org);
    const turn = await runSlotlockAssistantTurn({
      model: found.model,
      system: slotlockAssistantSystemPrompt({
        brand: brandName,
        workspace: current?.login ?? session.login,
        login: session.login,
        now: new Date(now()),
        resources: bookable.slice(0, SLOTLOCK_ASSISTANT_DIRECTORY_SIZE).map((resource) => ({
          id: resource.id,
          ...(resource.name !== undefined ? { name: resource.name } : {}),
          ...(resource.externalRef ? { ref: resource.externalRef } : {}),
          ...(resource.kind !== undefined ? { kind: resource.kind } : {}),
          ...(resource.locationName !== undefined || resource.location !== undefined
            ? { location: (resource.locationName ?? resource.location) as string }
            : {}),
          timezone: resource.timezone,
        })),
        resourceCount: bookable.length,
      }),
      entries,
      fetch: assistantFetch,
      timeoutMs: assistantTimeout,
      turnTimeoutMs: assistantTurnTimeout,
      ...(assistantOptions.maxSteps !== undefined ? { maxSteps: assistantOptions.maxSteps } : {}),
      ...(hooks.onEvent ? { onEvent: hooks.onEvent } : {}),
      ...(hooks.signal ? { signal: hooks.signal } : {}),
      read: async (operation, input) => {
        // A turn's reads share one budget of resource-days, so 8 steps of wide reads cannot each
        // scan a hundred resources over years.
        reads += 1;
        readCost += readCostOf(input);
        if (reads > MAX_READS_PER_TURN || readCost > MAX_READ_COST_PER_TURN) {
          return { ok: false, code: 'turn_read_budget_exceeded' };
        }
        const outcome = await dispatch(session, operation, input, 'run');
        return outcome.ok
          ? outcome
          : { ok: false, code: outcome.code, ...(outcome.details ? { details: outcome.details } : {}) };
      },
      propose: async (operation, input) => {
        if (pendingBefore + Object.keys(proposed).length >= SLOTLOCK_ASSISTANT_MAX_PENDING) {
          return { ok: false, code: 'too_many_pending_changes' };
        }
        const id = randomBytes(12).toString('base64url');
        const prepared =
          isRecord(input) && keyed.has(operation)
            ? { ...input, idempotency_key: `dashboard-assistant.${id}` }
            : input;
        let checked: Record<string, unknown> | undefined;
        // Every check an agent's call passes (arguments, scopes, authorize, rate limit), then halted
        // here: it runs only when the member approves it.
        const outcome = await dispatch(session, operation, prepared, 'propose', async ({ input: parsed }) => {
          checked = parsed;
          return { status: 409, code: 'approval_required' };
        });
        if (checked === undefined || outcome.ok || outcome.code !== 'approval_required') {
          return { ok: false, code: outcome.ok ? 'internal_error' : outcome.code };
        }
        // The card shows every argument: one too large to show is not proposed.
        if (Buffer.byteLength(JSON.stringify(checked), 'utf8') > SLOTLOCK_ASSISTANT_MAX_ACTION_BYTES) {
          return { ok: false, code: 'change_too_large_to_show' };
        }
        proposed[id] = {
          operation,
          input: checked,
          status: 'pending',
          summary: await summarize(session, operation, checked),
        };
        return { ok: true, actionId: id };
      },
    });
    if (turn.failure !== undefined) {
      report(turn.failure instanceof Error ? turn.failure.message : 'assistant provider failed');
    }
    const messages = boundSlotlockAssistantEntries([...entries, ...turn.added]);
    // Only this turn's proposals are added; the rest are kept as the row holds them now, so one
    // approved (or a conversation reset) while the turn ran is never put back as it stood.
    const kept = pruneSlotlockAssistantActions(messages, { ...(stored?.actions ?? {}), ...proposed });
    await store.putChat(
      tenantRef,
      member,
      chatId,
      {
        title,
        messages,
        added: Object.fromEntries(Object.entries(proposed).filter(([id]) => id in kept)),
        keep: Object.keys(kept),
        // A chat it continued, only while it is still there: deleted during the turn, it stays so.
        create: stored === null,
      },
      conversationTtl,
    );
    return { ok: true, messages, actions: kept, chatId, title };
  }

  /** The form's way (no script): run the turn, then show the conversation at its latest message. */
  async function sendToAssistant(session: Session, form: URLSearchParams): Promise<Response> {
    const run = await runAssistantMessage(session, form);
    if (!run.ok) {
      return run.status === 404
        ? notFound(session)
        : assistantPage(session, run.status, run.message, chatOf(form.get('chat')) ?? 'new');
    }
    return redirect(303, `${chatUrl(run.chatId)}#latest`);
  }

  /**
   * app.js's way: the same turn, answered as it happens, one JSON object a line. `text` carries a
   * piece of the reply, `step` a tool step as it starts and ends, and the last line is `done` (the
   * turn as the page renders it, which replaces what was streamed) or `error`, each with a fresh
   * single-use value for the next send. The member's Stop aborts the request, and the turn with it.
   */
  async function streamToAssistant(session: Session, form: URLSearchParams, request: Request): Promise<Response> {
    const encoder = new TextEncoder();
    // Stop, or a client gone, cancels the body. That stops the turn, which keeps what it had, and
    // the cancel settles only once it has: a Worker closes the request's connection then, and a
    // runtime that never aborts request.signal on a disconnect stops the turn all the same.
    const stop = new AbortController();
    let open = true;
    let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
    let work: Promise<void> = Promise.resolve();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        sink = controller;
      },
      cancel() {
        open = false;
        stop.abort();
        return work;
      },
    });
    const write = (event: Record<string, unknown>) => {
      if (!open) return;
      try {
        sink?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      } catch {
        open = false;
      }
    };
    const label = (name: string, state: 'run' | 'ok' | 'bad') =>
      slotlockAssistantStepLabel(
        name,
        toolTitles.get(name) ?? name,
        state,
        SLOTLOCK_ASSISTANT_TOOL_USE[name as SlotlockAgentOperation] === 'propose',
      );
    const failed = (message: string) =>
      write({
        t: 'error',
        html: html`<li class="turn error" role="alert"><span>${message}</span></li>`.value,
        once: formNonce(session),
      });
    work = (async () => {
      try {
        const run = await runAssistantMessage(session, form, {
          signal: AbortSignal.any([request.signal, stop.signal]),
          onEvent: (event) => {
            if (event.type === 'text') write({ t: 'text', d: event.delta });
            else if (event.type === 'call') write({ t: 'step', id: event.id, s: 'run', label: label(event.name, 'run') });
            else write({ t: 'step', id: event.id, s: event.ok ? 'ok' : 'bad', label: label(event.name, event.ok ? 'ok' : 'bad') });
          },
        });
        if (!run.ok) {
          failed(run.message);
          return;
        }
        // The turn from the member's message on, as a reload would show it.
        const start = run.messages.map((entry) => entry.role).lastIndexOf('user');
        const turn = run.messages.slice(Math.max(0, start));
        const lookups =
          Object.keys(run.actions).length > 0
            ? await resourceLookups(tenantOf(session))
            : { names: new Map<string, string>(), zones: new Map<string, string>() };
        const chats = await assistantStore()?.listChats(tenantOf(session), personOf(session));
        write({
          t: 'done',
          html: assistantItems(session, turn, run.actions, lookups.names, lookups.zones, run.chatId).join(''),
          once: formNonce(session),
          // The conversation it went to (a new one has its id now), its address, and the list again.
          chat: run.chatId,
          title: run.title,
          url: chatUrl(run.chatId),
          chats: chats ? chatsPanel(session, chats, run.chatId).value : undefined,
        });
      } catch (error) {
        report(error instanceof Error ? error.message : 'assistant stream failed');
        failed('Something went wrong. Reload the page and try again.');
      } finally {
        if (open) {
          open = false;
          try {
            sink?.close();
          } catch {
            // Cancelled meanwhile.
          }
        }
      }
    })();
    ignoreRejection(work);
    const page = respond(200, '');
    const headers = new Headers(page.headers);
    headers.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    // Proxies that buffer (nginx) send each line as it is written.
    headers.set('X-Accel-Buffering', 'no');
    return new Response(body, { status: 200, headers });
  }

  async function settleAction(
    session: Session,
    form: URLSearchParams,
    decision: 'approve' | 'dismiss',
  ): Promise<Response> {
    const store = assistantStore();
    if (!store || !assistantOptions) return notFound(session);
    const id = form.get('action') ?? '';
    const chatId = await chatOfForm(store, session, form, true);
    const tenantRef = tenantOf(session);
    const member = personOf(session);
    const claimed = ACTION_ID.test(id) && chatId
      ? await store.settleAction(
          tenantRef,
          member,
          chatId,
          id,
          'pending',
          decision === 'approve' ? { status: 'approved' } : { status: 'dismissed', input: {} },
        )
      : null;
    const action = claimed ? readAction(id, claimed) : null;
    if (!action || !chatId) {
      return assistantPage(session, 409, 'That change was already approved or dismissed.', chatId ?? undefined);
    }
    const title = toolTitles.get(action.operation) ?? action.operation;
    let event: string;
    if (decision === 'dismiss') {
      event = `The member dismissed the proposed change ${id} (${title}); it did not run.`;
    } else if (SLOTLOCK_ASSISTANT_TOOL_USE[action.operation] !== 'propose') {
      await store.settleAction(tenantRef, member, chatId, id, 'approved', { status: 'failed', outcome: 'tool_not_available', input: {} });
      event = `The proposed change ${id} (${title}) could not run: tool_not_available.`;
    } else {
      const outcome = await dispatch(session, action.operation, action.input, 'run');
      // Settled, the card keeps what it said, not the arguments: the actions stay small.
      await store.settleAction(
        tenantRef,
        member,
        chatId,
        id,
        'approved',
        outcome.ok ? { status: 'done', input: {} } : { status: 'failed', outcome: outcome.code, input: {} },
      );
      const result = JSON.stringify(outcome.ok ? outcome.data : { error: { code: outcome.code } });
      event = `The member approved the proposed change ${id} (${title}). ${outcome.ok ? 'It ran' : 'It was refused'}: ${result.length > 4_000 ? `${result.slice(0, 4_000)} …[truncated]` : result}`;
    }
    const stored = await store.getChat(tenantRef, member, chatId);
    if (stored) {
      const entries: SlotlockAssistantEntry[] = [
        ...readSlotlockAssistantEntries(stored.messages),
        { role: 'event', text: event },
      ];
      const messages = boundSlotlockAssistantEntries(entries);
      await store.putChat(
        tenantRef,
        member,
        chatId,
        {
          title: stored.title,
          messages,
          added: {},
          keep: Object.keys(pruneSlotlockAssistantActions(messages, stored.actions)),
          create: false,
        },
        conversationTtl,
      );
    }
    return redirect(303, `${chatUrl(chatId)}#action-${id}`);
  }

  /** A new conversation: the others are kept, in Chats. (A form of an earlier release posts here.) */
  async function resetAssistant(session: Session): Promise<Response> {
    if (!assistantStore()) return notFound(session);
    return redirect(303, chatUrl(null));
  }

  /** Give one of the member's conversations a title of their own. */
  async function renameChat(session: Session, form: URLSearchParams): Promise<Response> {
    const store = assistantStore();
    if (!store) return notFound(session);
    const chatId = chatOf(form.get('chat'));
    const title = (form.get('title') ?? '').replace(/\s+/gu, ' ').trim();
    if (!chatId) return assistantPage(session, 404, 'That chat is not here: it was deleted.', 'new');
    if ([...title].length < 1 || [...title].length > 120) {
      return assistantPage(session, 400, 'Give the chat a title of 1 to 120 characters.', chatId);
    }
    const renamed = await store.renameChat(tenantOf(session), personOf(session), chatId, title);
    if (!renamed) return assistantPage(session, 404, 'That chat is not here: it was deleted.', 'new');
    return redirect(303, chatUrl(chatId));
  }

  /** Delete one of the member's conversations, at once and for good. */
  async function deleteChat(session: Session, form: URLSearchParams): Promise<Response> {
    const store = assistantStore();
    if (!store) return notFound(session);
    const chatId = chatOf(form.get('chat'));
    if (chatId) await store.deleteChat(tenantOf(session), personOf(session), chatId);
    return redirect(303, chatUrl(null));
  }

  /**
   * A workspace's plan as both the Usage page and the overview show it: the plan (or the default it
   * moves to), what it has against the limits, this month's use against the quotas, and what needs a
   * person: a failed payment, a quota used up or nearly, more than the coming plan allows.
   * `here` is the page asking, so an item's action points to the page that resolves it.
   */
  async function planStanding(session: Session, here: 'usage' | 'overview', given?: readonly SlotlockApiKey[]) {
    const active = plans as SlotlockDashboardPlans;
    const billing = options.billing;
    const tenantRef = tenantOf(session);
    const [plan, planDefault, resourceCount, keys, webhooks] = await Promise.all([
      active.plan(tenantRef),
      active.planDefault ? active.planDefault() : Promise.resolve(null),
      // As the limit counts them: archived resources included.
      options.resources.count
        ? options.resources.count(tenantRef)
        : options.resources.list(tenantRef).then((listed) => listed.length),
      given ?? options.keys.list({ tenantRef }),
      options.resources.webhooks?.list(tenantRef),
    ]);
    const month = slotlockUsageMonthToDate(now());
    const used =
      options.usage && options.resources.usage
        ? summarizeSlotlockUsage(await options.resources.usage(tenantRef, month.from, month.to))
        : null;
    const keyCount = keys.filter(
      (key) => !key.revokedAt && (key.expiresAt === null || key.expiresAt.getTime() > now()),
    ).length;
    const admin = mayBill(session);
    const paying = plan !== null && plan.plan !== 'free';
    const upcoming = !plan && planDefault && planDefault.appliesFrom.getTime() > now() ? planDefault : null;
    const limits = plan?.limits ?? upcoming?.limits;
    const quotas = options.quotas && plan ? SLOTLOCK_PLAN_QUOTAS[plan.plan] : null;
    const resets = formatDate(slotlockQuotaPeriod(now()).resetsAt);
    const counted = (value: number) => value.toLocaleString('en-GB');
    const usagePage = `${root}/plan`;
    const upgradeAt = here === 'usage' ? '#upgrade' : `${usagePage}#upgrade`;
    // Only where the deployment sells plans (Stripe) or arranges them (a contact) is there an upgrade.
    const offersPlans = Boolean(billing || active.contact);
    const canUpgrade = !paying && admin && offersPlans;
    const upgradeHint = paying || !offersPlans ? '' : admin ? ' Upgrade for more.' : ' An owner of this organization can upgrade.';
    const attention: Html[] = [];
    // Whether anything is near or past a limit: the overview then offers the upgrade.
    let pressing = false;
    if (plan?.status === 'past_due') {
      attention.push(
        attentionItem(
          'bad',
          `Your last payment failed. ${admin && billing && plan.stripeCustomer ? 'Update your payment method in Manage billing' : 'An owner updates the payment method'} to keep the ${PLAN_NAMES[plan.plan]} plan.`,
          here === 'overview' ? { href: usagePage, label: 'Usage' } : undefined,
        ),
      );
    }
    if (quotas && used) {
      for (const metric of ['operations', 'bookings'] as const) {
        const quota = quotas[metric];
        const stop = Math.floor((quota * quotas.stopPercent) / 100);
        const spent = used.totals[metric];
        const refused = metric === 'operations' ? 'every call but reading usage' : 'new bookings and holds';
        const upgrade = canUpgrade ? { href: upgradeAt, label: 'Upgrade' } : here === 'overview' ? { href: usagePage, label: 'Usage' } : undefined;
        if (spent * 100 >= quota * 80) pressing = true;
        if (spent >= stop) {
          attention.push(attentionItem('bad', `This month's ${metric} are used up: Slotlock refuses ${refused} with quota_exceeded until ${resets}.${upgradeHint}`, upgrade));
        } else if (spent >= quota) {
          const billed = metric === 'operations' && billing?.overage && plan?.plan === 'developer' && paying;
          attention.push(
            attentionItem(
              'warn',
              `You have used this month's ${counted(quota)} ${metric}.${billed ? ` Those past it are billed at ${billing?.overage?.price ?? ''}.` : ''} Slotlock refuses ${refused} past ${counted(stop)}, until ${resets}.${billed ? '' : upgradeHint}`,
              billed ? undefined : upgrade,
            ),
          );
        } else if (spent * 100 >= quota * 80) {
          attention.push(
            attentionItem(
              'warn',
              `You have used ${String(Math.floor((spent * 100) / quota))}% of this month's ${metric}. They start again on ${resets}.`,
              upgrade,
            ),
          );
        }
      }
    }
    // What the workspace has against its plan's limits (or the coming plan's): at one, adding another
    // is refused; past one (a plan that allows less than it has), nothing is removed.
    const full = limits
      ? (
          [
            ['resources', resourceCount, limits.resources],
            ['active API keys', keyCount, limits.apiKeys],
            ...(webhooks ? ([['webhooks', webhooks.length, limits.webhookEndpoints]] as const) : []),
          ] as const
        ).filter(([, have, allowed]) => have >= allowed)
      : [];
    const over = full.filter(([, have, allowed]) => have > allowed);
    const holding = full.map(([what, have, allowed]) => `${counted(have)} of ${counted(allowed)} ${what}`).join(' and ');
    if (full.length > 0) pressing = true;
    const limitAction = canUpgrade
      ? { href: upgradeAt, label: 'Upgrade' }
      : here === 'overview'
        ? { href: usagePage, label: 'Usage' }
        : undefined;
    if (upcoming) {
      attention.push(
        attentionItem(
          full.length > 0 ? 'warn' : 'info',
          `From ${formatDate(upcoming.appliesFrom)}, this workspace is on ${PLAN_NAMES[upcoming.plan]}: ${String(upcoming.limits.resources)} resources, ${String(upcoming.limits.apiKeys)} API keys and ${String(upcoming.limits.webhookEndpoints)} webhooks.${
            full.length > 0
              ? ` You have ${holding}: ${over.length > 0 ? 'nothing is removed, but ' : ''}from then, adding another is refused.${upgradeHint}`
              : ''
          }`,
          full.length > 0 ? limitAction : undefined,
        ),
      );
    } else if (plan && full.length > 0) {
      attention.push(
        attentionItem(
          over.length > 0 ? 'bad' : 'warn',
          `On ${PLAN_NAMES[plan.plan]}, you have ${holding}: ${over.length > 0 ? 'nothing is removed, but ' : ''}adding another is refused.${upgradeHint}`,
          limitAction,
        ),
      );
    }
    /** One use against its allowance: a bar, amber from 80%, red at the limit. */
    const meter = (label: string, value: number, limit: number | undefined) => {
      if (limit === undefined) {
        return html`<div class="meter"><div class="meter-head"><span>${label}</span><span class="meter-value">${counted(value)}</span></div></div>`;
      }
      const tone = value >= limit ? ' bad' : value * 100 >= limit * 80 ? ' warn' : '';
      return html`<div class="meter${tone}"><div class="meter-head"><span>${label}</span><span class="meter-value">${counted(value)}<span class="meta"> of ${counted(limit)}</span></span></div><progress value="${String(Math.min(value, limit))}" max="${String(limit)}" aria-label="${label}: ${counted(value)} of ${counted(limit)}"></progress></div>`;
    };
    const limitMeters = html`${meter('Resources', resourceCount, limits?.resources)}${meter('Active API keys', keyCount, limits?.apiKeys)}${
      webhooks ? meter('Webhooks', webhooks.length, limits?.webhookEndpoints) : html``
    }`;
    // Under a "This month" heading, or beside the limits with the month in each label.
    const monthMeters = (suffix: string) =>
      used
        ? html`${meter(`Operations${suffix}`, used.totals.operations, quotas?.operations)}${meter(`Bookings${suffix}`, used.totals.bookings, quotas?.bookings)}${meter(`Holds${suffix}`, used.totals.holds, undefined)}`
        : html``;
    const name = plan
      ? PLAN_NAMES[plan.plan]
      : upcoming
        ? `${PLAN_NAMES[upcoming.plan]} from ${dayOf(upcoming.appliesFrom)}`
        : 'No plan';
    return {
      plan,
      upcoming,
      paying,
      admin,
      used,
      month,
      resets,
      keys,
      name,
      limitMeters,
      monthMeters,
      meters: html`${limitMeters}${monthMeters(' this month')}`,
      attention,
      canUpgrade,
      pressing,
    };
  }

  /**
   * What resolves an add refused at a plan limit, as a link: the upgrade on Usage, for an owner of a
   * workspace that does not pay yet where the deployment sells or arranges plans; else Usage.
   */
  async function pastLimit(session: Session): Promise<Html> {
    const plan = plans ? await plans.plan(tenantOf(session)).catch(() => null) : null;
    const paying = plan !== null && plan.plan !== 'free';
    return !paying && mayBill(session) && Boolean(options.billing || plans?.contact)
      ? html`<a href="${root}/plan#upgrade">upgrade</a>`
      : html`see <a href="${root}/plan">Usage</a>`;
  }

  /** One thing that needs a person: a sentence, its tone, and what resolves it. */
  const attentionItem = (tone: 'bad' | 'warn' | 'info', text: string, action?: { href: string; label: string }) =>
    html`<li class="attention ${tone}"><span class="attention-text">${text}</span>${
      action ? html`<a class="attention-action" href="${action.href}">${action.label}</a>` : html``
    }</li>`;

  /** The list of things that need a person, or nothing. */
  const attentionList = (items: readonly Html[]) =>
    items.length > 0 ? html`<ul class="attention-list" aria-label="Needs attention">${items}</ul>` : html``;

  async function planPage(
    session: Session,
    status = 200,
    notice?: string,
    thanks = false,
  ): Promise<Response> {
    if (!plans) return notFound(session);
    const billing = options.billing;
    const counted = (value: number) => value.toLocaleString('en-GB');
    if (session.env === 'test') {
      // Its own use, counted apart from Live's and never billed.
      const range = slotlockUsageMonthToDate(now());
      const tested =
        options.usage && options.resources.usage
          ? summarizeSlotlockUsage(await options.resources.usage(tenantOf(session), range.from, range.to))
          : null;
      const meter = (label: string, value: number) =>
        html`<div class="meter"><div class="meter-head"><span>${label}</span><span class="meter-value">${counted(value)}</span></div></div>`;
      return respond(
        status,
        layout(
          'Usage',
          html`${pageHead('Usage')}${noticeOf(notice, status)}<p>The test environment is on your live plan's limits and is never billed. Switch to Live to see your plan, or to change it.</p>${
            tested
              ? html`<section class="panel" id="usage"><h2>This month, in Test</h2><div class="meters">${meter('Operations', tested.totals.operations)}${meter('Bookings', tested.totals.bookings)}${meter('Holds', tested.totals.holds)}</div><p class="fine">Since ${range.from}, in UTC, counted apart from Live, against the same monthly quotas.</p></section>`
              : html``
          }`,
          session,
          'plan',
        ),
      );
    }
    const standing = await planStanding(session, 'usage');
    const { plan, paying, admin, used, month, resets, keys } = standing;
    const token = csrfToken(session);
    const keyName = new Map(keys.map((key) => [key.id, key.name]));
    // An organization is offered Team (where billing sells it, or by asking); a person, Developer.
    const offered: 'developer' | 'team' =
      sharedWorkspace(session) && (billing ? Boolean(billing.teamPrices) : true) ? 'team' : 'developer';
    const contact = plans.contact ?? billing?.contact;
    const manage =
      billing && plan?.stripeCustomer && admin
        ? html`<form class="inline" method="post" action="${root}/plan/manage"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><button type="submit">Manage billing</button></form>`
        : html``;
    const renews =
      paying && plan?.currentPeriodEnd
        ? html`<span class="meta">${plan.status === 'past_due' ? 'Payment due since' : 'Renews'} ${formatDate(plan.currentPeriodEnd)}</span>`
        : html``;
    const planCard = html`<section class="panel plan-card" id="plan"><div class="plan-head"><h2>${standing.name}</h2>${renews}</div><div class="meters">${standing.limitMeters}</div>${
      used ? html`` : html`<p class="fine">This server does not count use yet.</p>`
    }</section>${
      used
        ? html`<section class="panel" id="month"><h2>This month</h2><div class="meters">${standing.monthMeters('')}</div><p class="fine">Since ${month.from} (UTC); the month starts again on ${resets}. An operation is a call that reached Slotlock, whatever it answered.</p></section>`
        : html``
    }`;
    const byKey =
      used && used.keys.length > 0
        ? html`<section class="panel" id="usage"><h2>Used by</h2><div class="table"><table><thead><tr><th>Key</th><th>Operations</th><th>Bookings</th><th>Holds</th></tr></thead><tbody>${used.keys.map(
            (row) =>
              html`<tr><td data-label="Key">${row.keyId === null ? 'The dashboard and its assistant' : (keyName.get(row.keyId) ?? 'A deleted key')}</td><td data-label="Operations">${counted(row.operations)}</td><td data-label="Bookings">${counted(row.bookings)}</td><td data-label="Holds">${counted(row.holds)}</td></tr>`,
          )}</tbody></table></div><p class="fine">Webhook deliveries ${counted(used.totals.webhook_deliveries)} · assistant messages ${counted(used.totals.assistant_messages)}.</p></section>`
        : html``;
    const offeredLimits = SLOTLOCK_PLAN_LIMITS[offered];
    const offeredText = html`${String(offeredLimits.resources)} resources, ${String(offeredLimits.apiKeys)} API keys and ${String(offeredLimits.webhookEndpoints)} webhook endpoints${
      options.quotas
        ? html`, with ${counted(SLOTLOCK_PLAN_QUOTAS[offered].operations)} operations and ${counted(SLOTLOCK_PLAN_QUOTAS[offered].bookings)} bookings a month${offered === 'team' ? ' shared by the organization' : ''}`
        : html``
    }.`;
    let upgrade: Html = html``;
    if (!paying) {
      if (!admin) {
        upgrade = html`<p class="fine">An owner of this organization can change its plan.</p>`;
      } else if (billing) {
        const offeredPrices = offered === 'team' ? (billing.teamPrices as { month: string; year: string }) : billing.prices;
        upgrade = html`<section class="panel" id="upgrade">
<h2>${PLAN_NAMES[offered]}</h2>
<p>${offeredText}${
          offered === 'developer' && billing.overage && options.quotas
            ? ` Operations past them are billed at ${billing.overage.price}, up to ${String(billing.overage.stopPercent)}% of them.`
            : ''
        }</p>
<form method="post" action="${root}/plan/upgrade">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<fieldset class="modes"><legend>Billed</legend>
<label class="choice"><input type="radio" name="interval" value="month" checked> Monthly, ${offeredPrices.month} a month</label>
<label class="choice"><input type="radio" name="interval" value="year"> Yearly, ${offeredPrices.year} a year</label>
</fieldset>
<button class="primary" type="submit">Upgrade to ${PLAN_NAMES[offered]}</button>
</form>
<p class="fine">Paid through Stripe, in your currency, with tax added where it applies. Cancel at any time.</p>
</section>`;
      } else if (contact) {
        // No payment here yet: the plan is arranged by asking.
        upgrade = html`<section class="panel" id="upgrade"><h2>${PLAN_NAMES[offered]}</h2><p>${offeredText}</p><a class="button primary" href="${contact}">Talk to us about ${PLAN_NAMES[offered]}</a></section>`;
      }
    }
    const content = html`${thanks ? html`<p class="notice done" role="status">${notice ?? ''}</p>` : noticeOf(notice, status)}
${pageHead('Usage', manage)}
${attentionList(standing.attention)}
${planCard}
${byKey}
${upgrade}
${
  contact
    ? html`<section class="panel" id="custom"><h2>Custom</h2><p>Slotlock on your own servers, with support from the people who build it.</p><a class="button" href="${contact}">Talk to the founder</a></section>`
    : html``
}`;
    return respond(status, layout('Usage', content, session, 'plan'));
  }

  async function upgradePlan(session: Session, form: URLSearchParams): Promise<Response> {
    const billing = options.billing;
    if (!billing) return notFound(session);
    if (session.env === 'test') return planPage(session, 400, 'Plans are changed in Live.');
    if (!mayBill(session)) return planPage(session, 403, 'Only an owner or a billing manager of this workspace can change its plan.');
    const interval = form.get('interval') === 'year' ? 'year' : 'month';
    const tenantRef = tenantOf(session);
    const plan = await billing.plan(tenantRef);
    if (plan && plan.plan !== 'free') {
      return planPage(session, 409, `You are on the ${PLAN_NAMES[plan.plan]} plan already.`);
    }
    let url: string;
    try {
      url = await billing.checkout({
        tenantRef,
        interval,
        ...(sharedWorkspace(session) && billing.teamPrices ? { plan: 'team' as const } : {}),
        customer: plan?.stripeCustomer ?? null,
        successUrl: `${publicRoot}/plan?checkout=done`,
        cancelUrl: `${publicRoot}/plan`,
      });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'subscription_exists') {
        return planPage(
          session,
          409,
          'You pay for a subscription already. Its plan shows here once Stripe confirms it; to change it, use Manage billing.',
        );
      }
      ignoreRejection(options.onError?.(error));
      return planPage(session, 502, 'The payment page did not open. Try again in a minute.');
    }
    return redirect(303, url);
  }

  async function manageBilling(session: Session): Promise<Response> {
    const billing = options.billing;
    if (!billing) return notFound(session);
    if (session.env === 'test') return planPage(session, 400, 'Billing is managed in Live.');
    if (!mayBill(session)) return planPage(session, 403, 'Only an owner or a billing manager of this workspace can manage its billing.');
    const plan = await billing.plan(tenantOf(session));
    if (!plan?.stripeCustomer) return planPage(session, 409, 'There is no billing to manage yet.');
    let url: string;
    try {
      url = await billing.portal({ customer: plan.stripeCustomer, returnUrl: `${publicRoot}/plan` });
    } catch (error) {
      ignoreRejection(options.onError?.(error));
      return planPage(session, 502, 'Billing did not open. Try again in a minute.');
    }
    return redirect(303, url);
  }

  /** The page a form was sent from, to show what went wrong with it. */
  /** Where a request came from, as the audit log keeps it: the client's address, and its browser. */
  function requestOrigin(request: Request): { ipAddress?: string; userAgent?: string } {
    const address = options.clientAddress?.(request);
    const agent = request.headers.get('user-agent')?.slice(0, 256);
    return { ...(address ? { ipAddress: address.slice(0, 64) } : {}), ...(agent ? { userAgent: agent } : {}) };
  }

  /**
   * Record what the person did (or was refused) in the workspace's audit log. An action already done
   * is not undone because its record failed: the failure goes to onError.
   */
  async function audit(
    session: Session,
    event: { action: string } & Partial<Omit<SlotlockAuditEventInput, 'action' | 'actorType' | 'actorRef'>>,
    tenantRef = tenantOf(session),
  ): Promise<void> {
    const log = options.resources.audit;
    if (!log) return;
    const from = origins.get(session) ?? {};
    try {
      await log.record(tenantRef, {
        actorType: 'person',
        actorRef: personOf(session),
        actorRole: roleOf(session),
        ...from,
        ...event,
      });
    } catch (error) {
      try {
        ignoreRejection(options.onError?.(error));
      } catch {
        // A failing reporter must not change the response.
      }
    }
  }

  /** What an audited form changed: its target, and what describes the change (never a secret). */
  function auditDetails(route: string, form: URLSearchParams): Partial<SlotlockAuditEventInput> {
    const id = form.get('id') ?? '';
    if (route === '/keys') {
      return { targetType: 'api_key', metadata: { access: form.get('access') ?? '', expires: form.get('expires') ?? '' } };
    }
    if (route.startsWith('/keys/') && UUID_PATTERN.test(id)) return { targetType: 'api_key', targetRef: id };
    if (route === '/webhooks') {
      let host = '';
      try {
        host = new URL(form.get('url') ?? '').host;
      } catch {
        // An address the form refused names no host.
      }
      return { targetType: 'webhook', metadata: host ? { host } : {} };
    }
    if (route.startsWith('/webhooks/') && UUID_PATTERN.test(id)) return { targetType: 'webhook', targetRef: id };
    if (route.startsWith('/teams/')) {
      const org = form.get('organization') ?? '';
      return ORGANIZATION_ID.test(org) ? { targetType: 'organization', targetRef: `github-org:${org}` } : {};
    }
    if (route === '/settings/assistant') {
      return { metadata: { provider: (form.get('provider') ?? '').slice(0, 40), model: (form.get('model') ?? '').slice(0, 120) } };
    }
    return {};
  }

  /**
   * Every capability a form needs: its route's, and more where the form decides. A Full-access key
   * asks `keys.full`; a key someone else created asks `keys.manage_any`; rotating or limiting a
   * Full-access key asks `keys.full` as well, so a person who lost that power cannot keep it by
   * rotating, and anyone rotating one signed in recently. An empty list is a route with none.
   */
  async function capabilitiesOf(session: Session, route: string, form: URLSearchParams): Promise<SlotlockWorkspaceCapability[]> {
    const base = SLOTLOCK_DASHBOARD_POST_CAPABILITIES[route];
    if (base === undefined) return [];
    const needed: SlotlockWorkspaceCapability[] = [base];
    if (route === '/keys' && form.get('access') === 'full') needed.push('keys.full');
    // Giving a role needs its powers: making an Owner `workspace.own`, a Billing manager `billing.manage`.
    if (route === '/members/invite' || route === '/members/role') {
      const role = form.get('role');
      if (role === 'owner') needed.push('workspace.own');
      if (role === 'billing') needed.push('billing.manage');
    }
    if (route === '/keys/rotate' || route === '/keys/revoke' || route === '/keys/limits') {
      // As PostgreSQL reads a uuid, whatever its case: the key the handler would act on.
      const id = (form.get('id') ?? '').toLowerCase();
      if (UUID_PATTERN.test(id)) {
        const key = (await options.keys.list({ tenantRef: tenantOf(session) })).find((candidate) => candidate.id.toLowerCase() === id);
        // A key not listed here is not one the person made: only who may change anyone's tries it.
        if (!key || key.createdBy !== personOf(session)) needed.push('keys.manage_any');
        if (key?.scopes.includes('admin') && route !== '/keys/revoke') needed.push('keys.full');
      }
    }
    return needed;
  }

  /** The page a form's route belongs to, to go back to. */
  const backOf = (route: string) => {
    if (route.startsWith('/members/')) return '/settings/members';
    if (route === '/teams/delete' || route === '/teams/restore') return '/settings/team';
    const first = `/${route.split('/')[1] ?? ''}`;
    return first === '/' ? '' : first;
  };

  /** Refuse a form the person's role does not allow, or ask them to sign in again for a fresh one. */
  async function authorizePost(session: Session, route: string, form: URLSearchParams): Promise<Response | null> {
    const needed = await capabilitiesOf(session, route, form);
    const missing = needed.length === 0 ? undefined : needed.find((capability) => !can(session, capability));
    if (needed.length === 0 || missing !== undefined) {
      await audit(session, {
        action: 'authz.denied',
        outcome: 'denied',
        reason: missing ? `needs ${missing}` : 'not a listed route',
        metadata: { route },
      });
      return deniedPage(session, missing, backOf(route));
    }
    const fresh = needed.find((capability) => SLOTLOCK_FRESH_CAPABILITIES.has(capability));
    if (fresh !== undefined && !freshlySignedIn(session)) return confirmPage(session, fresh, backOf(route));
    return null;
  }

  /** Refuse a page the person's role does not reach; a billing manager's overview is Usage. */
  function authorizePage(session: Session, page: string): Response | null {
    const capability = SLOTLOCK_DASHBOARD_PAGE_CAPABILITIES[page];
    if (capability !== undefined && can(session, capability)) return null;
    if (page === '/' && plans && can(session, 'usage.read')) return redirect(303, `${root}/plan`);
    return deniedPage(session, capability, plans && can(session, 'usage.read') ? '/plan' : '');
  }

  function deniedPage(session: Session, capability: SlotlockWorkspaceCapability | undefined, back: string): Response {
    const role = SLOTLOCK_WORKSPACE_ROLE_NAMES[roleOf(session)];
    const text = capability
      ? `As ${/^[AEIOU]/.test(role) ? 'an' : 'a'} ${role} in this workspace, you can't ${CAPABILITY_WORDS[capability]}.`
      : 'Nothing is here.';
    return respond(
      403,
      layout('Not allowed', html`<p class="notice" role="alert">${text}</p><p><a href="${root}${back}">Back</a></p>`, session),
    );
  }

  /** A fresh capability after more than 15 minutes: sign in again, then come back to the page. */
  function confirmPage(session: Session, capability: SlotlockWorkspaceCapability, back: string): Response {
    const query = new URLSearchParams({
      ...(session.idp === 'google' ? { with: 'google' } : {}),
      ...(STEP_UP_PAGES.has(back) ? { then: back } : {}),
    }).toString();
    return respond(
      403,
      layout(
        'Confirm it’s you',
        html`${pageHead('Confirm it’s you')}<p>To ${CAPABILITY_WORDS[capability]}, sign in again: your last sign-in was more than 15 minutes ago.</p><p class="actions"><a class="button primary" href="${root}/sign-in${query ? `?${query}` : ''}">Sign in again</a> <a class="button" href="${root}${back}">Cancel</a></p>`,
        session,
      ),
    );
  }

  /** A page as the answers about a form render it: the person, the status, and a notice. */
  type FormAnswerPage = (session: Session, status: number, notice: string) => Promise<Response> | Response;

  /**
   * The page a form's route belongs to, and the page path whose capability reading it needs: the
   * page rendered, not the one the route names (without the store a page needs, it is the overview).
   */
  function pageEntryFor(route: string): { path: string; page: FormAnswerPage } {
    if (route.startsWith('/keys')) return { path: '/keys', page: keysPage };
    if (route.startsWith('/webhooks') && options.resources.webhooks) return { path: '/webhooks', page: webhooksPage };
    if (route.startsWith('/waitlist') && options.resources.waitlist) return { path: '/waitlist', page: waitlistPage };
    if (route.startsWith('/approvals') && options.resources.approvals) return { path: '/approvals', page: approvalsPage };
    if ((route.startsWith('/locations') || route.startsWith('/groups')) && options.resources.grouping) {
      return { path: '/locations', page: locationsPage };
    }
    if (route.startsWith('/closures') && options.resources.hours) return { path: '/closures', page: closuresPage };
    if (route.startsWith('/contacts') && options.resources.contacts) return { path: '/contacts', page: contactsPage };
    if (route.startsWith('/resources') || route === '/hours') return { path: '/resources', page: resourcesPage };
    if (route.startsWith('/assistant') && assistantStore()) return { path: '/assistant', page: assistantPage };
    if ((route === '/teams/delete' || route === '/teams/restore') && teamStore) {
      return { path: '/settings/team', page: (session, status, notice) => settingsPage(session, status, notice, undefined, 'team') };
    }
    if (route.startsWith('/members/') && teamStore) {
      return { path: '/settings/members', page: (session, status, notice) => settingsPage(session, status, notice, undefined, 'members') };
    }
    if (route.startsWith('/settings')) return { path: '/settings', page: settingsPage };
    if (route.startsWith('/plan') && plans) return { path: '/plan', page: planPage };
    if ((route.startsWith('/teams') || route.startsWith('/invite')) && (teams || teamStore)) return { path: '/teams', page: teamsPage };
    return { path: '/', page: overviewPage };
  }

  /**
   * The page a form's route belongs to, for an answer about the form itself (already sent, too many
   * forms, another organization's page), only to a person whose role reads the page rendered:
   * anyone else gets the notice alone. These answers come before the role is checked.
   */
  function pageOrNotice(route: string): FormAnswerPage {
    const { path, page } = pageEntryFor(route);
    return (session, status, notice) => {
      const capability = SLOTLOCK_DASHBOARD_PAGE_CAPABILITIES[path];
      if (capability !== undefined && can(session, capability)) return page(session, status, notice);
      return respond(status, layout('Refused', html`<p class="notice" role="alert">${notice}</p>`, session));
    };
  }

  /** Whose hours an editor sets: the tenant's, one location's, or one resource's. */
  type HoursTarget = 'all' | { location: SlotlockLocation } | SlotlockResource;
  const isLocationTarget = (target: HoursTarget): target is { location: SlotlockLocation } =>
    typeof target === 'object' && 'location' in target && typeof target.location === 'object';

  /** How many resources keep hours of their own, a few by name, and what saving does to them. */
  function ownHoursChoice(own: readonly SlotlockResource[]): Html {
    if (own.length === 0) return html``;
    const named = own.slice(0, OWN_HOURS_NAMED);
    const word = own.length === 1 ? 'resource keeps hours of its own' : 'resources keep hours of their own';
    return html`<fieldset class="modes"><legend>${String(own.length)} ${word}</legend>
<p class="fine">${named.map(
      (resource, index) =>
        html`${index > 0 ? ', ' : ''}<a href="${root}/hours?resource=${resource.id}">${resourceName(resource, resource.id)}</a>`,
    )}${own.length > named.length ? html` and ${String(own.length - named.length)} more` : html``}. <a href="${root}/resources?hours=own">See them all</a></p>
<label class="choice"><input type="radio" name="override" value="none" checked> Keep them</label>
<label class="choice"><input type="radio" name="override" value="matching"> Clear those with the same hours as yours were, or as these: copies an earlier version made when your hours were set</label>
<label class="choice"><input type="radio" name="override" value="all"> Clear them all, so every resource uses these</label>
</fieldset>`;
  }

  function hoursPage(
    session: Session,
    state: {
      target: HoursTarget;
      mode: HoursMode;
      week: WeekForm;
      unshown?: readonly WeeklyAvailabilityRule[];
      status?: number;
      notice?: string;
      /** For the tenant's hours: the resources in use that keep hours of their own. */
      own?: readonly SlotlockResource[] | undefined;
    },
  ): Response {
    const { target, mode } = state;
    const checked = (value: HoursMode) => (mode === value ? html` checked` : html``);
    const server = options.availability ?? [];
    const place = isLocationTarget(target) ? target.location : null;
    const resource = target !== 'all' && !place ? (target as SlotlockResource) : null;
    const title =
      target === 'all'
        ? 'Your hours'
        : place
          ? `Hours at ${place.name}`
          : `Hours for ${resource?.externalRef ?? resource?.id ?? ''}`;
    const inheritLabel =
      target === 'all'
        ? html`The server's hours (${server.length === 0 ? 'none' : hoursSummary(server)})`
        : place
          ? html`Inherit: a location it is in, else your hours, else the server's`
          : resource && resource.availabilityRules === undefined
            ? html`Inherit (${resourceHours(resource, server)})`
            : html`Inherit: its location's hours, else yours, else the server's`;
    const rows = WEEKDAYS.map((day) => {
      const cells = state.week[day].flatMap(({ from, to }, index) => {
        const which = index + 1;
        const lower = day.toLowerCase();
        return [
          html`<td data-label="Opens"><input type="time" name="${lower}_from_${which}" value="${from}" aria-label="${DAY_NAMES[day]} opens (${WINDOW_NAMES[index]} window)"></td>`,
          html`<td data-label="Closes"><input type="time" name="${lower}_to_${which}" value="${to}" aria-label="${DAY_NAMES[day]} closes (${WINDOW_NAMES[index]} window)"></td>`,
        ];
      });
      return html`<tr><th scope="row">${DAY_NAMES[day]}</th>${cells}</tr>`;
    });
    const content = html`${state.notice ? html`<p class="notice" role="alert">${state.notice}</p>` : html``}
<section>
<p><a class="back" href="${root}/${place ? 'locations' : 'resources'}">${place ? 'Locations' : 'Resources'}</a></p>
<h1>${title}</h1>
<p>${
      target === 'all'
        ? 'Every resource without hours of its own uses these, each in its own time zone, unless its location has hours. Resources you add later too.'
        : place
          ? `Resources at ${place.name}, or at a location inside it, without hours of their own use these, each in its own time zone, unless a location nearer them has hours.`
          : `When agents may book it, in its time zone: ${resource?.timezone ?? ''}.`
    }${options.resources.hours ? html` <a href="${root}/closures">Closures and special days</a> change single days.` : html``}</p>
${
  state.unshown
    ? html`<div class="notice warn" role="alert"><p>These hours were set outside the dashboard, so the week below cannot show them. Saving replaces them.</p><ul class="hours">${state.unshown.map(
        (rule) =>
          html`<li><code>${rule.rrule}</code> from ${formatMinutes(rule.startMinutes)} for ${String(rule.durationMinutes)} min</li>`,
      )}</ul></div>`
    : html``
}
<form method="post" action="${root}/hours">
<input type="hidden" name="csrf" value="${csrfToken(session)}">
<input type="hidden" name="once" value="${formNonce(session)}">
${place ? html`<input type="hidden" name="location" value="${place.ref}">` : html`<input type="hidden" name="resource" value="${target === 'all' ? 'all' : (resource?.id ?? '')}">`}
<fieldset class="modes"><legend>Bookable hours</legend>
<label class="choice"><input type="radio" name="mode" value="server"${checked('server')}> ${inheritLabel}</label>
<label class="choice"><input type="radio" name="mode" value="closed"${checked('closed')}> Closed: agents find no free slot</label>
<label class="choice"><input type="radio" name="mode" value="custom"${checked('custom')}> These hours</label>
</fieldset>
<div class="table"><table class="week"><thead><tr><th>Day</th><th>Opens</th><th>Closes</th><th>Opens</th><th>Closes</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="fine">A closing time at or before the opening time closes the next day; 00:00 to 00:00 is the whole day. Leave a window empty for none.</p>
${target === 'all' ? ownHoursChoice(state.own ?? []) : html``}
<button class="primary" type="submit">Save hours</button>
</form>
</section>`;
    return respond(state.status ?? 200, layout('Bookable hours', content, session, 'resources'));
  }

  /** The editor's state for stored rules: inherit (null), closed ([]), or a week. */
  function hoursState(rules: readonly WeeklyAvailabilityRule[] | null | undefined): {
    mode: HoursMode;
    week: WeekForm;
    unshown?: readonly WeeklyAvailabilityRule[];
  } {
    if (rules === undefined || rules === null) {
      return { mode: 'server', week: weekFormOf(rulesToWeeklyHours(options.availability ?? [])) };
    }
    if (rules.length === 0) return { mode: 'closed', week: emptyWeekForm() };
    const week = rulesToWeeklyHours(rules);
    return { mode: 'custom', week: weekFormOf(week), ...(week === null ? { unshown: rules } : {}) };
  }

  /** The tenant's location with that reference, or null. */
  async function ownLocation(session: Session, ref: string): Promise<SlotlockLocation | null> {
    const grouping = options.resources.grouping;
    if (!grouping || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(ref)) return null;
    return (await grouping.locations(tenantOf(session))).find((location) => location.ref === ref) ?? null;
  }

  /** The tenant's resource with that id, or null for anything else. */
  async function ownResource(session: Session, id: string): Promise<SlotlockResource | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const resources = await options.resources.list(tenantOf(session));
    return resources.find((resource) => resource.id === id) ?? null;
  }

  const notFound = (session: Session) =>
    respond(
      404,
      layout('Not found', html`<p class="notice">That resource is not one of yours.</p>`, session),
    );
  const nothingHere = (session: Session) =>
    respond(404, layout('Not found', html`<p class="notice">Nothing is here.</p>`, session));
  const nothingHere404 = () =>
    respond(404, layout('Not found', html`<p class="notice">Nothing is here.</p>`, null), { 'Referrer-Policy': 'no-referrer' });

  /** The tenant's resources in use that keep hours of their own, by name. */
  async function ownHoursOf(session: Session): Promise<SlotlockResource[]> {
    const resources = await options.resources.list(tenantOf(session));
    return resources
      .filter((resource) => resource.archivedAt === undefined && resource.availabilityRules !== undefined)
      .sort((one, other) => resourceName(one, one.id).localeCompare(resourceName(other, other.id)));
  }

  async function hoursEditor(session: Session, url: URL): Promise<Response> {
    const ref = url.searchParams.get('location');
    if (ref !== null) {
      const location = await ownLocation(session, ref);
      if (!location || !options.resources.hours) return nothingHere(session);
      const defaults = await options.resources.hours.defaults(tenantOf(session));
      const rules = defaults.locations.find((entry) => entry.location === ref)?.rules ?? null;
      return hoursPage(session, { target: { location }, ...hoursState(rules) });
    }
    const id = url.searchParams.get('resource');
    if (id === null) {
      const [defaults, own] = await Promise.all([options.resources.hours?.defaults(tenantOf(session)), ownHoursOf(session)]);
      return hoursPage(session, { target: 'all', ...hoursState(defaults?.tenant ?? null), own });
    }
    const resource = await ownResource(session, id);
    if (!resource) return notFound(session);
    return hoursPage(session, { target: resource, ...hoursState(resource.availabilityRules) });
  }

  /** The form's choice for resources' own hours (`yes`: the checkbox of a page from before); anything else keeps them. */
  const overrideOf = (value: string | null): SlotlockOverrideResources =>
    value === 'all' || value === 'yes' ? 'all' : value === 'matching' ? 'matching' : 'none';

  async function saveHours(session: Session, form: URLSearchParams): Promise<Response> {
    const ref = form.get('location');
    const id = form.get('resource') ?? '';
    let target: HoursTarget | null;
    if (ref !== null) {
      const location = await ownLocation(session, ref);
      target = location && options.resources.hours ? { location } : null;
    } else {
      target = id === 'all' ? 'all' : await ownResource(session, id);
    }
    if (!target) return notFound(session);
    const mode = form.get('mode');
    const week = readWeekForm(form);
    const own = target === 'all' ? await ownHoursOf(session) : undefined;
    if (mode !== 'server' && mode !== 'closed' && mode !== 'custom') {
      return hoursPage(session, {
        target,
        mode: 'custom',
        week,
        status: 400,
        notice: 'Choose which hours to use.',
        own,
      });
    }
    let rules: WeeklyAvailabilityRule[] | null = mode === 'server' ? null : [];
    if (mode === 'custom') {
      try {
        rules = weeklyHoursToRules(weekFromForm(week));
        if (rules.length === 0) {
          throw Object.assign(new Error('Add a window to at least one day, or choose Closed.'), {
            code: 'invalid_availability',
          });
        }
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'invalid_availability') throw error;
        return hoursPage(session, {
          target,
          mode,
          week,
          status: 400,
          notice: (error as Error).message,
          own,
        });
      }
    }
    const place = isLocationTarget(target) ? target.location : null;
    const changed =
      target === 'all'
        ? await options.resources.setHours(tenantOf(session), 'all', rules, personOf(session), overrideOf(form.get('override')))
        : await options.resources.setHours(
            tenantOf(session),
            place ? { location: place.ref } : { id: (target as SlotlockResource).id },
            rules,
            personOf(session),
          );
    if (changed === 0 && target !== 'all') return notFound(session);
    return redirect(303, `${root}/${place ? 'locations' : 'resources'}`);
  }

  /** A subscription's address as the page names it: its host, never its path or query (which may hold a token). */
  const hostOfUrl = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return 'its address';
    }
  };

  /** The tenant's closures and special days from yesterday on, with forms to add and import more. */
  async function closuresPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const hours = options.resources.hours;
    if (!hours) return nothingHere(session);
    const tenantRef = tenantOf(session);
    const [exceptions, locations, resources, calendars] = await Promise.all([
      hours.exceptions(tenantRef, SLOTLOCK_DASHBOARD_MAX_EXCEPTIONS + 1),
      options.resources.grouping?.locations(tenantRef) ?? Promise.resolve([] as SlotlockLocation[]),
      options.resources.list(tenantRef),
      hours.calendars?.(tenantRef) ?? Promise.resolve([] as SlotlockHolidayCalendar[]),
    ]);
    const token = csrfToken(session);
    const sent = () => html`<input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}">`;
    const names = new Map(resources.map((resource) => [resource.id, resourceName(resource, resource.id)]));
    const places = new Map(locations.map((location) => [location.ref, location.name]));
    const scopeOf = (exception: SlotlockAvailabilityException) =>
      exception.resourceId
        ? names.get(exception.resourceId) ?? exception.resourceId
        : exception.location
          ? `${places.get(exception.location) ?? exception.location} (location)`
          : 'Everywhere';
    const days = (exception: SlotlockAvailabilityException) =>
      exception.startsOn === exception.endsOn ? exception.startsOn : `${exception.startsOn} to ${exception.endsOn}`;
    const what = (exception: SlotlockAvailabilityException) =>
      exception.outcome === 'closed'
        ? 'Closed'
        : `Open ${(exception.hours ?? []).map((window) => hoursOf(window.startMinutes, window.durationMinutes)).join(', ')}`;
    const scopeOptions = html`<option value="">Everywhere</option>${locations.map(
      (location) => html`<option value="location:${location.ref}">${location.name} (location)</option>`,
    )}${resources.slice(0, SLOTLOCK_DASHBOARD_MAX_RESOURCES).map(
      (resource) => html`<option value="resource:${resource.id}">${resourceName(resource, resource.id)}</option>`,
    )}`;
    const shown = exceptions.slice(0, SLOTLOCK_DASHBOARD_MAX_EXCEPTIONS);
    const content = html`${noticeOf(notice)}
<section>
<p><a class="back" href="${root}/resources">Resources</a></p>
<h1>Closures and special days</h1>
<p>Each closes whole days, or gives them hours of their own instead of the weekly hours, read in each resource's time zone. Where several apply to a day, the nearest wins: a resource's own, then its location's, then everywhere's.</p>
<div class="table"><table><thead><tr><th>Days</th><th>Applies to</th><th>Hours</th><th>Label</th><th></th></tr></thead><tbody>${
      shown.length === 0
        ? html`<tr><td colspan="5" class="muted">No closures from today on.</td></tr>`
        : shown.map(
            (exception) => html`<tr><td data-label="Days">${days(exception)}</td><td data-label="Applies to">${scopeOf(exception)}</td><td data-label="Hours">${what(exception)}</td><td data-label="Label" class="wrap">${exception.label}${exception.source === 'ics' ? html` <span class="meta">imported</span>` : html``}</td><td class="actions"><form method="post" action="${root}/closures/delete">${sent()}<input type="hidden" name="id" value="${exception.id}"><button type="submit">Delete</button></form></td></tr>`,
          )
    }</tbody></table></div>
${exceptions.length > SLOTLOCK_DASHBOARD_MAX_EXCEPTIONS ? html`<p class="fine">The first ${String(SLOTLOCK_DASHBOARD_MAX_EXCEPTIONS)} are shown; the API lists them all.</p>` : html``}
<h2>Add a closure or special day</h2>
<form method="post" action="${root}/closures" class="stack">${sent()}
<label>Applies to <select name="scope">${scopeOptions}</select></label>
<label>First day <input type="date" name="starts_on" required></label>
<label>Last day <input type="date" name="ends_on"></label>
<fieldset class="modes"><legend>Those days</legend>
<label class="choice"><input type="radio" name="outcome" value="closed" checked> Closed</label>
<label class="choice"><input type="radio" name="outcome" value="open"> Open only from <input type="time" name="opens" aria-label="Opens"> to <input type="time" name="closes" aria-label="Closes"></label>
</fieldset>
<label>Label <input name="label" maxlength="200" required placeholder="Christmas Day"></label>
<button class="primary" type="submit">Add</button>
</form>
${calendars.length > 0 ? html`<h2>Holiday calendars</h2>
<div class="table"><table><thead><tr><th>Calendar</th><th>Applies to</th><th>From</th><th>Closures</th><th></th></tr></thead><tbody>${calendars.map(
        (calendar) => html`<tr><td data-label="Calendar" class="wrap">${calendar.name}${
          calendar.lastError ? html`<span class="meta bad" role="status">The last import failed: ${calendar.lastError}</span>` : html``
        }</td><td data-label="Applies to">${
          calendar.resourceId
            ? names.get(calendar.resourceId) ?? calendar.resourceId
            : calendar.location
              ? `${places.get(calendar.location) ?? calendar.location} (location)`
              : 'Everywhere'
        }</td><td data-label="From" class="wrap">${
          calendar.url
            ? html`${hostOfUrl(calendar.url)}<span class="meta">Imported again every 30 days${calendar.nextImportAt ? html`, next ${calendar.nextImportAt.toISOString().slice(0, 10)}` : html``}</span>`
            : html`Uploaded or pasted${calendar.importedAt ? html`<span class="meta">${calendar.importedAt.toISOString().slice(0, 10)}</span>` : html``}`
        }</td><td data-label="Closures">${String(calendar.closures)}</td><td class="actions">${
          hours.deleteCalendar
            ? html`<form method="post" action="${root}/closures/calendars/delete">${sent()}<input type="hidden" name="id" value="${calendar.id}"><button type="submit" class="danger">Delete</button></form>`
            : html``
        }</td></tr>`,
      )}</tbody></table></div>
<p class="fine">Deleting a calendar deletes its closures too.</p>` : html``}
<h2>Import a holiday calendar</h2>
<p>Upload or paste an iCalendar file of days off${hours.byUrl ? html`, or give its address` : html``}: each all-day event closes its days for the next two years. A calendar is kept by its name where it applies: importing it again updates its closures and removes the holidays it no longer has.</p>
<form method="post" action="${root}/closures/import" class="stack" enctype="multipart/form-data">${sent()}
<label>Applies to <select name="scope">${scopeOptions}</select></label>
<label>Name <input name="name" maxlength="200" placeholder="Its own name, else its address, else Holidays"></label>
<label>File <input type="file" name="icalendar_file" accept=".ics,text/calendar"></label>
<label>Or paste it <textarea name="icalendar" rows="6" placeholder="BEGIN:VCALENDAR"></textarea></label>
${hours.byUrl ? html`<label>Or its address <input type="url" name="url" maxlength="2000" placeholder="https://example.com/holidays.ics"></label>
<label class="choice"><input type="checkbox" name="subscribe" value="on"> Import it again every 30 days</label>` : html``}
<button type="submit">Import</button>
</form>
</section>`;
    return respond(status, layout('Closures', content, session, 'resources'));
  }

  /**
   * The people the tenant keeps to tell about bookings (RFC 0004 P3): how to reach each, what they
   * agreed to and when, and a button that forgets one (their reference leaves every booking too).
   * Contacts are added by the tenant's own systems, through the API.
   */
  async function contactsPage(session: Session, status = 200, notice?: string, after?: string): Promise<Response> {
    const contacts = options.resources.contacts;
    if (!contacts) return nothingHere(session);
    const listed = await contacts.list(tenantOf(session), SLOTLOCK_DASHBOARD_CONTACTS_PAGE + 1, after);
    const shown = listed.slice(0, SLOTLOCK_DASHBOARD_CONTACTS_PAGE);
    const token = csrfToken(session);
    const reach = (contact: SlotlockContact) =>
      [contact.email, contact.phone ? `SMS ${contact.phone}` : null, contact.whatsapp ? `WhatsApp ${contact.whatsapp}` : null]
        .filter(Boolean)
        .join(', ') || 'No way to reach them';
    const agreed = (contact: SlotlockContact) =>
      (['email', 'sms', 'whatsapp'] as const)
        .filter((channel) => contact.consent[channel] !== undefined)
        .map((channel) => `${channel === 'sms' ? 'SMS' : channel === 'whatsapp' ? 'WhatsApp' : 'Email'}: ${contact.consent[channel] ? 'yes' : 'no'}${contact.consentAt[channel] ? ` (${contact.consentAt[channel]?.toISOString().slice(0, 10)})` : ''}`)
        .join('; ') || 'Not asked';
    const content = html`${noticeOf(notice)}
<section>
<p><a class="back" href="${root}/resources">Resources</a></p>
<h1>Contacts</h1>
<p>The people your bookings name to be told about them, kept by your own systems through the API (<code>PUT /v1/contacts/{contact_ref}</code>). Forgetting one deletes them and takes their reference off every booking, for an erasure request.</p>
<table><thead><tr><th>Reference</th><th>Name</th><th>Reach by</th><th>Agreed to</th><th></th></tr></thead><tbody>${
      shown.length === 0
        ? html`<tr><td colspan="5" class="muted">No contacts yet.</td></tr>`
        : shown.map(
            (contact) => html`<tr><td data-label="Reference"><code>${contact.ref}</code></td><td data-label="Name">${contact.name ?? ''}</td><td data-label="Reach by" class="wrap">${reach(contact)}</td><td data-label="Agreed to" class="wrap">${agreed(contact)}</td><td class="actions"><form method="post" action="${root}/contacts/forget"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="ref" value="${contact.ref}"><button type="submit" class="danger">Forget</button></form></td></tr>`,
          )
    }</tbody></table>
${listed.length > SLOTLOCK_DASHBOARD_CONTACTS_PAGE ? html`<p><a class="button" href="${root}/contacts?after=${encodeURIComponent(shown.at(-1)?.ref ?? '')}">More</a></p>` : html``}
</section>`;
    return respond(status, layout('Contacts', content, session, 'resources'));
  }

  async function forgetContact(session: Session, form: URLSearchParams): Promise<Response> {
    const contacts = options.resources.contacts;
    if (!contacts) return nothingHere(session);
    const ref = form.get('ref') ?? '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(ref)) return contactsPage(session, 400, 'That is not a contact reference.');
    const forgotten = await contacts.forget(tenantOf(session), ref, personOf(session));
    if (!forgotten.deleted) return contactsPage(session, 404, 'That contact is not one of yours.');
    return contactsPage(
      session,
      200,
      `Forgotten. ${forgotten.bookings} booking${forgotten.bookings === 1 ? '' : 's'} no longer name them.`,
    );
  }

  /** `location:<ref>` or `resource:<id>` from a closures form, checked against the tenant's. */
  async function closureScope(session: Session, value: string): Promise<{ location?: string; resourceId?: string } | null> {
    if (value === '') return {};
    if (value.startsWith('location:')) {
      const location = await ownLocation(session, value.slice(9));
      return location ? { location: location.ref } : null;
    }
    if (value.startsWith('resource:')) {
      const resource = await ownResource(session, value.slice(9));
      return resource ? { resourceId: resource.id } : null;
    }
    return null;
  }

  async function saveClosure(session: Session, form: URLSearchParams): Promise<Response> {
    const hours = options.resources.hours;
    if (!hours) return nothingHere(session);
    const scope = await closureScope(session, form.get('scope') ?? '');
    if (!scope) return closuresPage(session, 400, 'Choose where it applies.');
    const outcome = form.get('outcome') === 'open' ? 'open' : 'closed';
    const startsOn = form.get('starts_on') ?? '';
    const endsOn = form.get('ends_on') || startsOn;
    let windows: { startMinutes: number; durationMinutes: number }[] | undefined;
    if (outcome === 'open') {
      const opens = minutesOf(form.get('opens') ?? '');
      const closes = minutesOf(form.get('closes') ?? '');
      if (opens === null || closes === null) return closuresPage(session, 400, 'Give the hours those days open.');
      windows = [{ startMinutes: opens, durationMinutes: closes > opens ? closes - opens : closes + 1_440 - opens }];
    }
    try {
      await hours.addException(
        tenantOf(session),
        {
          ...scope,
          startsOn,
          endsOn,
          outcome,
          ...(windows ? { hours: windows } : {}),
          label: form.get('label') ?? '',
        },
        personOf(session),
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'invalid_availability_exception' || code === 'availability_exceptions_limit_reached') {
        return closuresPage(session, code === 'invalid_availability_exception' ? 400 : 409, (error as Error).message);
      }
      throw error;
    }
    return redirect(303, `${root}/closures`);
  }

  async function deleteClosure(session: Session, form: URLSearchParams): Promise<Response> {
    const hours = options.resources.hours;
    if (!hours) return nothingHere(session);
    const id = form.get('id') ?? '';
    if (!UUID_PATTERN.test(id) || !(await hours.deleteException(tenantOf(session), id, personOf(session)))) {
      return closuresPage(session, 404, 'That closure is not one of yours.');
    }
    return redirect(303, `${root}/closures`);
  }

  async function importClosures(session: Session, form: URLSearchParams): Promise<Response> {
    const hours = options.resources.hours;
    if (!hours) return nothingHere(session);
    const scope = await closureScope(session, form.get('scope') ?? '');
    if (!scope) return closuresPage(session, 400, 'Choose where it applies.');
    // An uploaded file, else what was pasted, else (where the server reads them) an address.
    const text = (form.get('icalendar_file') ?? '').trim() || (form.get('icalendar') ?? '').trim();
    const url = hours.byUrl ? (form.get('url') ?? '').trim() : '';
    if ((text === '') === (url === '')) {
      return closuresPage(session, 400, hours.byUrl ? 'Upload or paste a calendar, or give its address: one of them.' : 'Upload or paste a calendar.');
    }
    const name = (form.get('name') ?? '').trim();
    const source: SlotlockHolidaySource = {
      ...(text !== '' ? { icalendar: text } : { url }),
      ...(name !== '' ? { name } : {}),
      ...(url !== '' && form.get('subscribe') === 'on' ? { subscribe: true } : {}),
    };
    try {
      const result = await hours.importHolidays(tenantOf(session), source, scope, personOf(session));
      const plural = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`;
      return closuresPage(
        session,
        200,
        `Imported ${plural(result.imported, 'closure')}${
          result.removed > 0 ? `; removed ${plural(result.removed, 'holiday')} the calendar no longer has` : ''
        }${result.skipped > 0 ? `; skipped ${plural(result.skipped, 'event')} that were not all-day or not in the next two years` : ''}.`,
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (
        code === 'invalid_holiday_calendar' ||
        code === 'invalid_availability_exception' ||
        code === 'holiday_calendar_unreachable' ||
        code === 'holiday_url_not_served' ||
        code === 'location_not_found' ||
        code === 'resource_not_found'
      ) {
        return closuresPage(session, 400, (error as Error).message);
      }
      if (code === 'availability_exceptions_limit_reached' || code === 'holiday_calendars_limit_reached') {
        return closuresPage(session, 409, (error as Error).message);
      }
      throw error;
    }
  }

  /** Delete a holiday calendar and the closures it made. */
  async function deleteHolidayCalendar(session: Session, form: URLSearchParams): Promise<Response> {
    const hours = options.resources.hours;
    if (!hours?.deleteCalendar) return nothingHere(session);
    const id = form.get('id') ?? '';
    if (!(await hours.deleteCalendar(tenantOf(session), id, personOf(session)))) {
      return closuresPage(session, 404, 'That calendar is not one of yours.');
    }
    return redirect(303, `${root}/closures`);
  }

  function shownOncePage(
    session: Session,
    key: string,
    apiKey: SlotlockApiKey,
    rotated: boolean,
  ): Response {
    const org = session.orgs?.find((candidate) => candidate.id === session.org);
    const content = html`<section class="card once">
<h1>${rotated ? 'Key rotated' : 'Key created'}: ${apiKey.name}</h1>
${org ? html`<p>For the organization <strong>${org.login}</strong>.</p>` : html``}
<p class="notice warn" role="alert">Copy this key now. Slotlock keeps only its fingerprint, so it will not be shown again.${rotated ? ' The old key no longer works.' : ''}</p>
<div class="copy"><input id="key" readonly value="${key}" aria-label="API key"><button type="button" data-copy="key">Copy</button></div>
<h2>Add it to an MCP client</h2>
<pre><code id="command">claude mcp add --transport http slotlock ${mcpUrl} \\
  --header "Authorization: Bearer ${key}"</code></pre>
<p>Keep the key in a secret manager. Rotate it if it leaks; revoke it when the agent is retired.</p>
<a class="button primary" href="${root}/keys">Done</a>
</section>`;
    return respond(200, layout('Your new key', content, session, 'keys'));
  }

  /** Act in another of the session's organizations: the same session, sealed again. */
  function switchEnvironment(session: Session, form: URLSearchParams): Response {
    const wanted = form.get('environment');
    if (wanted !== 'live' && wanted !== 'test') {
      return respond(400, layout('Refused', html`<p class="notice">Choose Live or Test.</p>`, session));
    }
    const { env: _, ...rest } = session;
    const sealed = seal('slotlock-dashboard-session-v1', wanted === 'test' ? { ...rest, env: 'test' } : rest);
    const left = Math.max(1, Math.floor((session.exp - now()) / 1000));
    return redirect(303, root, [setCookie(SESSION_COOKIE, sealed, left)]);
  }

  /**
   * Teams on Cloud: the person's GitHub organizations, as read at sign-in, each on or off. An owner
   * turns one on or off; a member asks an owner; one that is on is a workspace to switch to.
   */
  async function teamsPage(session: Session, status = 200, notice?: string): Promise<Response> {
    if (!teams && !teamStore) return nothingHere(session);
    const own = teamStore ? await teamWorkspacesSection(session) : html``;
    const organizations = teams ? await organizationsSection(session) : html``;
    const content = html`${noticeOf(notice, status)}${pageHead('Teams')}${own}${organizations}`;
    return respond(status, layout('Teams', content, session, 'teams'));
  }

  /** The person's team workspaces, the invitations open to them, and creating one. */
  async function teamWorkspacesSection(session: Session): Promise<Html> {
    if (!teamStore) return html``;
    const listed = teamListOf.get(session) ?? [];
    const offered = await teamStore.pendingFor(personOf(session), verifiedEmails(session));
    const token = csrfToken(session);
    const hidden = () =>
      html`<input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}">`;
    const rows = listed.map(
      (ws) =>
        html`<tr><td data-label="Team" class="strong">${ws.name}</td><td data-label="Handle" class="muted">@${ws.handle}</td><td data-label="You are">${SLOTLOCK_WORKSPACE_ROLE_NAMES[ws.role]}</td><td class="actions">${
          ws.tenantRef === teamTenantOf(session)
            ? html`<span class="muted">In use</span>`
            : html`<form class="inline" method="post" action="${root}/organization">${hidden()}<input type="hidden" name="organization" value="${ws.tenantRef}"><button type="submit">Switch to it</button></form>`
        }</td></tr>`,
    );
    const invitations = offered.map(
      (invitation) =>
        html`<tr><td data-label="Team" class="strong">${invitation.workspaceName}</td><td data-label="From">${invitation.inviterDisplay}</td><td data-label="As">${SLOTLOCK_WORKSPACE_ROLE_NAMES[invitation.role]}</td><td class="actions"><form class="inline" method="post" action="${root}/invite/accept">${hidden()}<input type="hidden" name="invitation" value="${invitation.id}"><button class="primary" type="submit">Join ${invitation.workspaceName}</button></form></td></tr>`,
    );
    return html`<section class="team-workspaces" aria-labelledby="team-workspaces"><h2 id="team-workspaces">Team workspaces</h2>${
      invitations.length > 0
        ? html`<div class="table"><table><caption class="visually-hidden">Invitations</caption><thead><tr><th>Invited to</th><th>From</th><th>As</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${invitations}</tbody></table></div>`
        : html``
    }${
      rows.length > 0
        ? html`<div class="table"><table><thead><tr><th>Team</th><th>Handle</th><th>You are</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : html``
    }<form class="create-team" method="post" action="${root}/teams/create">${hidden()}<label for="team-name">Name</label><input id="team-name" name="name" maxlength="80" autocomplete="organization" required><button class="primary" type="submit">Create team</button></form></section>`;
  }

  /** GitHub organizations turned on for Slotlock (organizations: 'enabled'). */
  async function organizationsSection(session: Session): Promise<Html> {
    if (!teams) return html``;
    const orgs = session.orgs ?? [];
    const enabled = orgs.length > 0 ? await teams.enabled(orgs.map((org) => org.id)) : new Set<string>();
    enabledOf.set(session, enabled);
    const token = csrfToken(session);
    const hidden = (org: Organization) =>
      html`<input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="organization" value="${org.id}">`;
    const rows = orgs.map((org) => {
      const on = enabled.has(org.id);
      const owner = org.role === 'admin';
      const actions = on
        ? html`${org.id === session.org ? html`<span class="muted">In use</span>` : html`<form class="inline" method="post" action="${root}/organization">${hidden(org)}<button type="submit">Switch to it</button></form>`}${
            owner
              ? html`<details class="act danger"><summary>Turn off</summary><div class="pop"><p>Its keys stop at once and no member can open it. What it holds stays until an owner turns it on again or erases it.</p>
<form method="post" action="${root}/teams/disable">${hidden(org)}<label for="confirm-${org.id}">Type ${org.login} to confirm</label><input id="confirm-${org.id}" name="confirm" autocomplete="off" required><button class="danger" type="submit">Turn off</button></form></div></details>`
              : html``
          }`
        : owner
          ? html`<form class="inline" method="post" action="${root}/teams/enable">${hidden(org)}<button class="primary" type="submit">Turn on</button></form>`
          : html`<span class="muted">An owner can turn it on</span>`;
      return html`<tr><td data-label="Organization" class="strong">${org.login}</td><td data-label="You are">${owner ? 'Owner' : 'Member'}</td><td data-label="Slotlock"><span class="pill ${on ? 'active' : 'revoked'}">${on ? 'On' : 'Off'}</span></td><td class="actions">${actions}</td></tr>`;
    });
    return html`${teamStore ? html`<h2>GitHub organizations</h2>` : html``}
<p>Work with the people in a GitHub organization: once an owner turns Slotlock on for it, every owner and member shares its resources, keys and history, and picks it from the workspace menu. Your own workspace stays yours.</p>
${
  rows.length === 0
    ? emptyState(ICONS.teams, 'Slotlock sees none of your GitHub organizations. It reads them as you sign in: after joining one, sign out and in again. An organization that restricts OAuth apps needs an owner to approve this one.')
    : html`<div class="table"><table><thead><tr><th>Organization</th><th>You are</th><th>Slotlock</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="fine">Who owns an organization is read from GitHub as you sign in. Leaving one ends your access at your next sign-in.</p>`
}`;
  }

  /** People a team workspace may have, open invitations included: 3 on the Free plan where plans apply. */
  async function memberCapOf(tenantRef: string): Promise<number | null> {
    if (!plans) return null;
    const plan = await plans.plan(tenantRef);
    return plan === null || plan.plan === 'free' || plan.status === 'canceled' ? FREE_TEAM_MEMBERS : null;
  }

  /** The session moved into a workspace (its own when `team` is undefined), Live or Test as it was. */
  function moveTo(session: Session, team: string | undefined, path: string, cookies: string[] = [], keepEmails = true): Response {
    const { org: _org, team: _team, em, ...rest } = session;
    const kept = keepEmails && em !== undefined ? { ...rest, em } : rest;
    const sealed = seal('slotlock-dashboard-session-v1', team === undefined ? kept : { ...kept, team });
    const left = Math.max(1, Math.floor((session.exp - now()) / 1000));
    return redirect(303, `${root}${path}`, [setCookie(SESSION_COOKIE, sealed, left), ...cookies]);
  }

  const refusalPage = (session: Session, refusal: SlotlockTeamRefusal) =>
    settingsPage(session, TEAM_REFUSALS[refusal].status, TEAM_REFUSALS[refusal].text, undefined, 'members');

  async function createTeam(session: Session, form: URLSearchParams): Promise<Response> {
    if (!teamStore) return nothingHere(session);
    const name = (form.get('name') ?? '').trim();
    if (name.length === 0 || name.length > 80 || /\p{Cc}/u.test(name)) {
      return teamsPage(session, 400, TEAM_REFUSALS.invalid_name.text);
    }
    // A name goes into the invitations Slotlock sends: never a web or email address in it.
    if (/:\/\/|www\.|@|\b[a-z0-9-]+\.(?:[a-z]{2,}|xn--[a-z0-9-]+)\b/i.test(name)) {
      return teamsPage(session, 400, "A team's name can't hold a web or email address.");
    }
    const person = personOf(session);
    const cap = plans ? FREE_TEAMS_PER_PERSON : null;
    let made: Awaited<ReturnType<typeof teamStore.create>> = { refusal: 'handle_taken' };
    // The handle follows the name; one taken gets a random end.
    for (let attempt = 0; attempt < 4 && 'refusal' in made && made.refusal === 'handle_taken'; attempt += 1) {
      made = await teamStore.create(person, name, teamHandleFrom(name, attempt), cap);
    }
    if ('refusal' in made) return teamsPage(session, TEAM_REFUSALS[made.refusal].status, TEAM_REFUSALS[made.refusal].text);
    await audit(
      session,
      { action: 'workspace.created', actorRole: 'owner', targetType: 'workspace', targetRef: made.tenantRef },
      made.tenantRef,
    );
    return moveTo(session, made.tenantRef.slice('team:'.length), '/settings/members');
  }

  /** A team's people as the others see them: their GitHub login or Google email, as last signed in. */
  const memberName = (member: { person: string; display: string | null }) =>
    member.display ?? (member.person.startsWith('google:') ? 'A Google account' : 'A GitHub account');

  async function membersSection(session: Session, status: number, notice: string | undefined, shown?: InvitationShown): Promise<Html> {
    const tenantRef = teamTenantOf(session);
    if (!teamStore || tenantRef === undefined) return noticeOf(notice, status);
    const manage = can(session, 'members.manage');
    const me = personOf(session);
    const mine = roleOf(session);
    const [members, invitations, cap] = await Promise.all([
      teamStore.members(tenantRef),
      manage ? teamStore.invitations(tenantRef) : Promise.resolve([]),
      memberCapOf(tenantRef),
    ]);
    const open = invitations.filter((invitation) => invitation.expiresAt.getTime() > now());
    const seats = members.length + open.length;
    const full = cap !== null && seats >= cap;
    const team = currentTeam(session)?.name ?? 'this team';
    const owners = members.filter((member) => member.role === 'owner').length;
    const grantable = SLOTLOCK_WORKSPACE_ROLES.filter((role) => slotlockRoleMayGrant(mine, role));
    const token = csrfToken(session);
    const hidden = () =>
      html`<input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}">`;
    const roleOptions = (selected: SlotlockWorkspaceRole) =>
      grantable.map(
        (role) => html`<option value="${role}"${role === selected ? html` selected` : html``}>${SLOTLOCK_WORKSPACE_ROLE_NAMES[role]}</option>`,
      );
    const invite = !manage
      ? html``
      : full
        ? html`<p class="seats">${String(seats)} of ${String(cap)} people.${plans && can(session, 'usage.read') ? html` <a href="${root}/plan">Upgrade</a>` : html``}</p>`
        : html`<form class="invite" method="post" action="${root}/members/invite">${hidden()}<label for="invite-email">Email</label><input id="invite-email" name="email" type="email" maxlength="254" autocomplete="off" required${shown ? html`` : html` autofocus`}><label class="visually-hidden" for="invite-role">Role</label><select id="invite-role" name="role">${roleOptions('member')}</select><button class="primary" type="submit">Invite</button></form>`;
    const link = shown
      ? html`<div class="set-card"><div class="row"><span class="row-label">Link for ${shown.to}</span><div class="row-value">${copyField('invite-link', shown.link)}</div></div></div><p class="fine">It works once, for that address, until ${formatDate(shown.expiresAt)}. It is not shown again.</p>`
      : html``;
    const pendingRows = invitations.map((invitation) => {
      const expired = invitation.expiresAt.getTime() <= now();
      const to = invitation.email ?? `@${invitation.githubLogin ?? 'GitHub account'}`;
      return html`<tr><td data-label="Invited" class="strong">${to}</td><td data-label="Role">${SLOTLOCK_WORKSPACE_ROLE_NAMES[invitation.role]}</td><td data-label="By">${invitation.inviterDisplay}</td><td data-label="Expires">${expired ? html`<span class="pill revoked">Expired</span>` : formatDate(invitation.expiresAt)}</td><td class="actions">${
        slotlockRoleMayGrant(mine, invitation.role)
          ? html`<form class="inline" method="post" action="${root}/members/resend">${hidden()}<input type="hidden" name="id" value="${invitation.id}"><button type="submit">Send again<span class="visually-hidden"> to ${to}</span></button></form><form class="inline" method="post" action="${root}/members/revoke">${hidden()}<input type="hidden" name="id" value="${invitation.id}"><button class="danger" type="submit">Revoke<span class="visually-hidden"> the invitation to ${to}</span></button></form>`
          : html``
      }</td></tr>`;
    });
    const memberRows = members.map((member, index) => {
      const name = memberName(member);
      const self = member.person === me;
      const changeable = manage && slotlockRoleMayGrant(mine, member.role);
      const role = changeable
        ? html`<form class="inline" method="post" action="${root}/members/role">${hidden()}<input type="hidden" name="person" value="${member.person}"><label class="visually-hidden" for="role-${String(index)}">Role for ${name}</label><select id="role-${String(index)}" name="role">${roleOptions(member.role)}</select><button type="submit">Save<span class="visually-hidden"> the role for ${name}</span></button></form>`
        : html`${SLOTLOCK_WORKSPACE_ROLE_NAMES[member.role]}`;
      let action = html``;
      if (self) {
        action =
          member.role === 'owner' && owners <= 1
            ? html`<span class="muted">You’re the only owner. Make someone else an owner before leaving.</span>`
            : html`<details class="act danger"><summary>Leave</summary><div class="pop"><p>You lose access to ${team} at once. Keys you created keep working until an owner or admin revokes them.</p><form method="post" action="${root}/members/leave">${hidden()}<button class="danger" type="submit">Leave ${team}</button></form></div></details>`;
      } else if (changeable) {
        action = html`<details class="act danger"><summary>Remove<span class="visually-hidden"> ${name}</span></summary><div class="pop"><p>${name} loses access to ${team} at their next request. Resources, bookings and history stay.</p><form method="post" action="${root}/members/remove">${hidden()}<input type="hidden" name="person" value="${member.person}"><fieldset><legend>Keys ${name} created</legend><label><input type="radio" name="keys" value="revoke" checked> Revoke them</label><label><input type="radio" name="keys" value="keep"> Keep them working</label></fieldset><button class="danger" type="submit">Remove ${name}</button></form></div></details>`;
      }
      return html`<tr><td data-label="Member" class="strong">${name}${self ? html` <span class="muted">(you)</span>` : html``}</td><td data-label="Role">${role}</td><td data-label="Joined">${formatDate(member.joinedAt)}</td><td class="actions">${action}</td></tr>`;
    });
    return html`${noticeOf(notice, status)}<h2>Members · ${String(cap === null ? members.length : seats)}${cap === null ? '' : ` of ${String(cap)}`}</h2>${invite}${link}${
      pendingRows.length > 0
        ? html`<h3>Pending</h3><div class="table"><table><thead><tr><th>Invited</th><th>Role</th><th>By</th><th>Expires</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${pendingRows}</tbody></table></div>`
        : html``
    }<div class="table"><table><thead><tr><th>Member</th><th>Role</th><th>Joined</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${memberRows}</tbody></table></div>`;
  }

  /** Who did something, as the audit log names them: you, a member by their display, else their account. */
  function actorName(event: SlotlockAuditEvent, session: Session, names: ReadonlyMap<string, string>): string {
    if (event.actorType === 'api_key') return `API key ${event.actorRef.replace(/^api_key:/, '').slice(0, 8)}`;
    if (event.actorType === 'assistant') return 'The assistant';
    if (event.actorType !== 'person') return 'Slotlock';
    if (event.actorRef === personOf(session)) return 'You';
    return (
      names.get(event.actorRef) ??
      (event.actorRef.startsWith('github:') ? `GitHub user ${event.actorRef.slice(7)}` : event.actorRef.startsWith('google:') ? 'A Google account' : event.actorRef)
    );
  }

  /** A workspace's audit log, newest first, 50 a page: who did what, refused or done, from where. */
  async function auditSection(session: Session, status: number, notice: string | undefined, query: URLSearchParams): Promise<Html> {
    const log = options.resources.audit;
    if (!log) return noticeOf(notice, status);
    const tenantRef = tenantOf(session);
    const wanted = query.get('action') ?? '';
    const action = AUDIT_ACTION_NAMES.has(wanted) ? wanted : undefined;
    const cursor = /^(\d{1,15})\.([0-9a-f-]{36})$/.exec(query.get('before') ?? '');
    const before =
      cursor && UUID_PATTERN.test(cursor[2] as string)
        ? { occurredAt: new Date(Number(cursor[1])), id: (cursor[2] as string).toLowerCase() }
        : undefined;
    const team = teamTenantOf(session);
    const [events, members] = await Promise.all([
      log.list(tenantRef, { limit: AUDIT_PAGE, ...(before ? { before } : {}), ...(action ? { action } : {}) }),
      teamStore && team !== undefined ? teamStore.members(team) : Promise.resolve([]),
    ]);
    const names = new Map(members.map((member) => [member.person, memberName(member)]));
    const options_ = AUDIT_ACTION_GROUPS.map(
      ([group, actions]) =>
        html`<optgroup label="${group}">${actions.map(
          (name) => html`<option value="${name}"${name === action ? html` selected` : html``}>${AUDIT_ACTION_WORDS[name] ?? name}</option>`,
        )}</optgroup>`,
    );
    const filter = html`<form class="audit-filter" method="get" action="${root}/settings/audit"><label for="audit-action">Action</label><select id="audit-action" name="action"><option value="">Everything</option>${options_}</select><button type="submit">Show</button></form>`;
    const rows = events.map((event) => {
      const details: [string, string][] = [
        ...(event.targetRef ? [['Target', `${event.targetType ?? ''} ${event.targetRef}`.trim()] as [string, string]] : []),
        ...(event.reason ? [['Reason', event.reason] as [string, string]] : []),
        ...Object.entries(event.metadata).map(([key, value]) => [key, String(value)] as [string, string]),
        ...(event.ipAddress ? [['Address', event.ipAddress] as [string, string]] : []),
        ...(event.userAgent ? [['Browser', event.userAgent] as [string, string]] : []),
      ];
      return html`<tr><td data-label="When">${formatDate(event.occurredAt)}</td><td data-label="Who" class="strong">${actorName(event, session, names)}${
        event.actorRole ? html` <span class="muted">(${SLOTLOCK_WORKSPACE_ROLE_NAMES[event.actorRole]})</span>` : html``
      }</td><td data-label="What">${AUDIT_ACTION_WORDS[event.action] ?? event.action}${
        event.outcome === 'denied' ? html` <span class="pill revoked">Refused</span>` : html``
      }</td><td class="actions">${
        details.length > 0
          ? html`<details class="act"><summary>Details</summary><div class="pop"><dl class="audit-details">${details.map(
              ([label, value]) => html`<dt>${label}</dt><dd>${value}</dd>`,
            )}</dl></div></details>`
          : html``
      }</td></tr>`;
    });
    const last = events[events.length - 1];
    const older =
      last && events.length === AUDIT_PAGE
        ? `${root}/settings/audit?${new URLSearchParams({ ...(action ? { action } : {}), before: `${String(last.occurredAt.getTime())}.${last.id}` }).toString()}`
        : null;
    // The chain, checked on asking: every event kept since the oldest still links to the one before.
    const verified = query.get('verify') === '1' && log.verify ? await log.verify(tenantRef) : null;
    const chain = verified
      ? verified.brokenAt === null
        ? html`<p class="notice done" role="status">The log is unbroken: ${String(verified.checked)} event${verified.checked === 1 ? '' : 's'} checked.</p>`
        : html`<p class="notice" role="alert">The log was changed outside Slotlock at event ${String(verified.brokenAt)}, after ${String(verified.checked)} that check out.</p>`
      : html``;
    const exportQuery = action ? `&action=${action}` : '';
    const tools = html`<p class="audit-tools">${
      log.verify ? html`<a href="${root}/settings/audit?verify=1${exportQuery}">Check the log</a>` : html``
    } <a href="${root}/settings/audit/export?format=csv${exportQuery}">Export CSV</a> <a href="${root}/settings/audit/export?format=json${exportQuery}">Export JSON</a></p>`;
    return html`${noticeOf(notice, status)}${chain}${filter}${tools}${
      rows.length === 0
        ? html`<p class="empty">${before ? 'Nothing older.' : 'Nothing recorded yet.'}</p>`
        : html`<div class="table"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th><span class="visually-hidden">Details</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
    }<p class="pager">${before ? html`<a href="${root}/settings/audit${action ? `?action=${action}` : ''}">Newest</a>` : html``}${
      older ? html` <a href="${older}">Older</a>` : html``
    }</p>`;
  }

  /**
   * A workspace's audit log as a file, filtered as the page was: up to 10,000 events, newest first,
   * with each event's place in the chain and its hash. On the Team plan where plans apply.
   */
  async function exportAudit(session: Session, query: URLSearchParams): Promise<Response> {
    const log = options.resources.audit;
    if (!log) return nothingHere(session);
    const tenantRef = tenantOf(session);
    if (plans) {
      const plan = await plans.plan(tenantRef.replace(/~test$/, ''));
      if (plan?.plan !== 'team' || plan.status === 'canceled') {
        return settingsPage(session, 403, 'Exports come with the Team plan. Upgrade on Usage.', undefined, 'audit', undefined, query);
      }
    }
    const format = query.get('format') === 'json' ? 'json' : 'csv';
    const wanted = query.get('action') ?? '';
    const action = AUDIT_ACTION_NAMES.has(wanted) ? wanted : undefined;
    const events: SlotlockAuditEvent[] = [];
    let before: { occurredAt: Date; id: string } | undefined;
    while (events.length < AUDIT_EXPORT_MOST) {
      const page = await log.list(tenantRef, { limit: 200, ...(before ? { before } : {}), ...(action ? { action } : {}) });
      events.push(...page);
      const last = page[page.length - 1];
      if (!last || page.length < 200) break;
      before = { occurredAt: last.occurredAt, id: last.id };
    }
    await audit(session, { action: 'audit.exported', metadata: { format, events: events.length, ...(action ? { filter: action } : {}) } });
    const rows = events.slice(0, AUDIT_EXPORT_MOST).map((event) => ({
      occurred_at: event.occurredAt.toISOString(),
      action: event.action,
      outcome: event.outcome,
      actor_type: event.actorType,
      actor_ref: event.actorRef,
      actor_role: event.actorRole ?? '',
      target_type: event.targetType ?? '',
      target_ref: event.targetRef ?? '',
      reason: event.reason ?? '',
      ip_address: event.ipAddress ?? '',
      user_agent: event.userAgent ?? '',
      metadata: JSON.stringify(event.metadata),
      chain_index: event.chainIndex === null ? '' : String(event.chainIndex),
      hash: event.hash ?? '',
    }));
    const day = new Date(now()).toISOString().slice(0, 10);
    const body =
      format === 'json'
        ? JSON.stringify(rows.map((row) => ({ ...row, metadata: JSON.parse(row.metadata) as unknown })), null, 2)
        : [
            Object.keys(rows[0] ?? AUDIT_EXPORT_EMPTY).join(','),
            ...rows.map((row) => Object.values(row).map(csvCell).join(',')),
          ].join('\r\n');
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="slotlock-audit-${day}.${format}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    });
  }

  /** A team's name and handle, and deleting it: what goes with it, the handle typed to confirm. */
  async function teamSection(session: Session, status: number, notice: string | undefined): Promise<Html> {
    const tenantRef = teamTenantOf(session);
    if (!teamStore || tenantRef === undefined) return noticeOf(notice, status);
    const [info, deleting, members, resources, keys, webhooks] = await Promise.all([
      teamStore.info(tenantRef),
      teamStore.deleteAfter(tenantRef),
      teamStore.members(tenantRef),
      options.resources.count ? options.resources.count(tenantRef) : options.resources.list(tenantRef).then((list) => list.length),
      options.keys.list({ tenantRef }),
      options.resources.webhooks ? options.resources.webhooks.list(tenantRef) : Promise.resolve([]),
    ]);
    if (!info) return noticeOf(notice, status);
    const hidden = html`<input type="hidden" name="csrf" value="${csrfToken(session)}"><input type="hidden" name="once" value="${formNonce(session)}">`;
    const live = keys.filter((key) => key.revokedAt === null && (key.expiresAt === null || key.expiresAt.getTime() > now())).length;
    const card = html`<div class="set-card"><div class="row"><span class="row-label">Name</span><div class="row-value">${info.name}</div></div><div class="row"><span class="row-label">Handle</span><div class="row-value">@${info.handle}</div></div></div>`;
    const danger = deleting
      ? html`<h2>Being deleted</h2><p>${info.name} and everything in it go on ${formatDate(deleting)}.</p><form method="post" action="${root}/teams/restore">${hidden}<button class="primary" type="submit">Keep ${info.name}</button></form>`
      : html`<h2>Delete team</h2><p>Its keys stop at once, and seven days later it goes with everything in it: ${String(members.length)} member${members.length === 1 ? '' : 's'}, ${String(resources)} resource${resources === 1 ? '' : 's'} with their bookings and history, ${String(live)} key${live === 1 ? '' : 's'} and ${String(webhooks.length)} webhook${webhooks.length === 1 ? '' : 's'}. Until then any owner can keep it.</p><form class="create-team" method="post" action="${root}/teams/delete">${hidden}<label for="confirm-handle">Type ${info.handle} to confirm</label><input id="confirm-handle" name="confirm" autocomplete="off" required><button class="danger" type="submit">Delete ${info.name}</button></form>`;
    return html`${noticeOf(notice, status)}${card}${danger}`;
  }

  async function deleteTeam(session: Session, form: URLSearchParams): Promise<Response> {
    const tenantRef = teamTenantOf(session);
    if (!teamStore || tenantRef === undefined) return nothingHere(session);
    const refusal = await teamStore.scheduleDeletion(tenantRef, personOf(session), (form.get('confirm') ?? '').trim());
    if (refusal === 'confirm') return settingsPage(session, 400, "Type the team's handle to confirm.", undefined, 'team');
    if (refusal === 'subscription_live') {
      return settingsPage(session, 409, 'Cancel its Team plan on Usage first: deleting the team would not stop the payments.', undefined, 'team');
    }
    if (refusal) return settingsPage(session, TEAM_REFUSALS[refusal].status, TEAM_REFUSALS[refusal].text, undefined, 'team');
    await audit(session, { action: 'workspace.deletion_scheduled', targetType: 'workspace', targetRef: tenantRef }, tenantRef);
    return redirect(303, `${root}/settings/team`);
  }

  async function restoreTeam(session: Session): Promise<Response> {
    const tenantRef = teamTenantOf(session);
    if (!teamStore || tenantRef === undefined) return nothingHere(session);
    const refusal = await teamStore.cancelDeletion(tenantRef, personOf(session));
    if (refusal) return settingsPage(session, TEAM_REFUSALS[refusal].status, TEAM_REFUSALS[refusal].text, undefined, 'team');
    await audit(session, { action: 'workspace.deletion_cancelled', targetType: 'workspace', targetRef: tenantRef }, tenantRef);
    return redirect(303, `${root}/settings/team`);
  }

  /** Send an invitation's link where a sender is set: whether it went. The link is shown either way. */
  async function deliverInvitation(session: Session, to: string, role: SlotlockWorkspaceRole, link: string, expiresAt: Date): Promise<boolean> {
    if (!options.invitations) return false;
    try {
      await options.invitations.send({
        to,
        workspace: currentTeam(session)?.name ?? 'a team',
        inviter: shownAs(session),
        role: SLOTLOCK_WORKSPACE_ROLE_NAMES[role],
        link,
        expiresAt,
      });
      return true;
    } catch (error) {
      report(`Invitation email failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      return false;
    }
  }

  async function inviteMember(session: Session, form: URLSearchParams): Promise<Response> {
    const tenantRef = teamTenantOf(session);
    if (!teamStore || tenantRef === undefined) return nothingHere(session);
    const email = (form.get('email') ?? '').trim().toLowerCase();
    const role = form.get('role') ?? '';
    if (email.length > 254 || !EMAIL_ADDRESS.test(email)) {
      return settingsPage(session, 400, 'Enter an email address.', undefined, 'members');
    }
    if (!isSlotlockWorkspaceRole(role)) return settingsPage(session, 400, 'Choose a role.', undefined, 'members');
    const raw = randomBytes(32).toString('base64url');
    const sent = await teamStore.invite({
      tenantRef,
      inviter: personOf(session),
      to: { email },
      role,
      tokenSha256: tokenDigest(raw),
      days: INVITATION_DAYS,
      dailyLimit: INVITATION_DAILY_LIMIT,
      memberCap: await memberCapOf(tenantRef),
    });
    if ('refusal' in sent) return refusalPage(session, sent.refusal);
    await audit(session, { action: 'member.invited', targetType: 'invitation', targetRef: sent.id, metadata: { role } }, tenantRef);
    const link = `${publicRoot}/invite?t=${raw}`;
    const expiresAt = new Date(now() + INVITATION_DAYS * DAY_MS);
    const delivered = await deliverInvitation(session, email, role, link, expiresAt);
    return settingsPage(
      session,
      200,
      delivered ? `Invitation sent to ${email}.` : `Invitation made for ${email}. Send them the link.`,
      undefined,
      'members',
      { link, to: email, expiresAt },
    );
  }

  async function resendInvitation(session: Session, form: URLSearchParams): Promise<Response> {
    const tenantRef = teamTenantOf(session);
    if (!teamStore || tenantRef === undefined) return nothingHere(session);
    const id = (form.get('id') ?? '').toLowerCase();
    const invitation = (await teamStore.invitations(tenantRef)).find((candidate) => candidate.id === id);
    if (!invitation) return refusalPage(session, 'not_found');
    const raw = randomBytes(32).toString('base64url');
    const refusal = await teamStore.resend(
      tenantRef,
      personOf(session),
      id,
      tokenDigest(raw),
      INVITATION_DAYS,
      INVITATION_DAILY_LIMIT,
      await memberCapOf(tenantRef),
    );
    if (refusal) return refusalPage(session, refusal);
    await audit(session, { action: 'invitation.resent', targetType: 'invitation', targetRef: id }, tenantRef);
    const to = invitation.email ?? `@${invitation.githubLogin ?? 'GitHub account'}`;
    const link = `${publicRoot}/invite?t=${raw}`;
    const expiresAt = new Date(now() + INVITATION_DAYS * DAY_MS);
    const delivered = invitation.email !== null && (await deliverInvitation(session, invitation.email, invitation.role, link, expiresAt));
    return settingsPage(
      session,
      200,
      delivered ? `Invitation sent to ${to} again. The old link no longer works.` : `A new link for ${to}. The old one no longer works.`,
      undefined,
      'members',
      { link, to, expiresAt },
    );
  }

  async function revokeInvitation(session: Session, form: URLSearchParams): Promise<Response> {
    const tenantRef = teamTenantOf(session);
    if (!teamStore || tenantRef === undefined) return nothingHere(session);
    const id = (form.get('id') ?? '').toLowerCase();
    if (!(await teamStore.revoke(tenantRef, personOf(session), id))) return refusalPage(session, 'not_found');
    await audit(session, { action: 'invitation.revoked', targetType: 'invitation', targetRef: id }, tenantRef);
    return settingsPage(session, 200, 'Invitation revoked: its link no longer works.', undefined, 'members');
  }

  async function changeMemberRole(session: Session, form: URLSearchParams): Promise<Response> {
    const tenantRef = teamTenantOf(session);
    if (!teamStore || tenantRef === undefined) return nothingHere(session);
    const person = form.get('person') ?? '';
    const role = form.get('role') ?? '';
    if (!isSlotlockWorkspaceRole(role)) return settingsPage(session, 400, 'Choose a role.', undefined, 'members');
    const members = await teamStore.members(tenantRef);
    const member = members.find((candidate) => candidate.person === person);
    if (!member) return refusalPage(session, 'not_found');
    if (member.role === role) return settingsPage(session, 200, 'Nothing changed.', undefined, 'members');
    const refusal = await teamStore.changeRole(tenantRef, personOf(session), person, role);
    if (refusal) return refusalPage(session, refusal);
    await audit(
      session,
      { action: 'member.role_changed', targetType: 'person', targetRef: person, metadata: { from: member.role, to: role } },
      tenantRef,
    );
    // One's own role changed: the page is read again under the new one.
    if (person === personOf(session)) return redirect(303, `${root}/settings/members`);
    return settingsPage(session, 200, `${memberName(member)} is now ${SLOTLOCK_WORKSPACE_ROLE_NAMES[role]}.`, undefined, 'members');
  }

  async function removeMember(session: Session, form: URLSearchParams): Promise<Response> {
    const tenantRef = teamTenantOf(session);
    if (!teamStore || tenantRef === undefined) return nothingHere(session);
    const me = personOf(session);
    const person = form.get('person') ?? '';
    if (person === me) return settingsPage(session, 400, 'To leave this team, use Leave.', undefined, 'members');
    const member = (await teamStore.members(tenantRef)).find((candidate) => candidate.person === person);
    if (!member) return refusalPage(session, 'not_found');
    const refusal = await teamStore.remove(tenantRef, me, person);
    if (refusal) return refusalPage(session, refusal);
    // Keys they created, Live and Test: revoked unless the form keeps them.
    const keep = form.get('keys') === 'keep';
    let revoked = 0;
    if (!keep) {
      for (const tenant of [tenantRef, `${tenantRef}${SLOTLOCK_TEST_TENANT_SUFFIX}`]) {
        for (const key of await options.keys.list({ tenantRef: tenant })) {
          if (key.createdBy !== person || key.revokedAt !== null) continue;
          if (await options.keys.revoke({ tenantRef: tenant, actor: me, origin: 'dashboard', id: key.id })) revoked += 1;
        }
      }
    }
    await audit(
      session,
      { action: 'member.removed', targetType: 'person', targetRef: person, metadata: { keys: keep ? 'kept' : 'revoked', revoked } },
      tenantRef,
    );
    return settingsPage(
      session,
      200,
      `${memberName(member)} was removed${revoked > 0 ? `, and ${String(revoked)} key${revoked === 1 ? '' : 's'} they created revoked` : ''}.`,
      undefined,
      'members',
    );
  }

  async function leaveTeam(session: Session): Promise<Response> {
    const tenantRef = teamTenantOf(session);
    if (!teamStore || tenantRef === undefined) return nothingHere(session);
    const me = personOf(session);
    const refusal = await teamStore.remove(tenantRef, me, me);
    if (refusal) return refusalPage(session, refusal);
    await audit(session, { action: 'member.left', targetType: 'person', targetRef: me }, tenantRef);
    return moveTo(session, undefined, '');
  }

  /** The invitation link being opened in this browser: its token, or null. */
  function inviteTokenOf(request: Request): string | null {
    const opened = unseal('slotlock-dashboard-invite-v1', readCookies(request).get(INVITE_COOKIE));
    return opened &&
      typeof opened.t === 'string' &&
      INVITE_TOKEN.test(opened.t) &&
      typeof opened.exp === 'number' &&
      opened.exp > now()
      ? opened.t
      : null;
  }

  /** An invitation's own page: what it is for, and joining, in the states it can be in. Never consumes it. */
  async function invitePage(session: Session | null, raw: string | null, status = 200, notice?: string, checked = false): Promise<Response> {
    const preview = raw && teamStore ? await teamStore.preview(tokenDigest(raw)) : null;
    const headers = { 'Referrer-Policy': 'no-referrer' };
    if (!preview) {
      const content = html`${noticeOf(notice, status)}${pageHead('Invitation')}<p>This invitation link can’t be used here. Open the link you were sent again, in this browser.</p>`;
      return respond(status === 200 ? 404 : status, layout('Invitation', content, session), headers);
    }
    const name = preview.workspaceName;
    const role = SLOTLOCK_WORKSPACE_ROLE_NAMES[preview.role];
    const forWhom = preview.email !== null ? maskedEmail(preview.email) : `@${preview.githubLogin ?? 'a GitHub account'}`;
    let body: Html;
    if (preview.state !== 'pending') {
      body = html`<p>${
        preview.state === 'expired'
          ? `This invitation expired. Ask ${preview.inviterDisplay} to send it again.`
          : preview.state === 'revoked'
            ? 'This invitation was withdrawn.'
            : 'This invitation was already used.'
      }</p>`;
    } else if (!session) {
      const then = new URLSearchParams({ then: '/invite' }).toString();
      // An invitation by email asks GitHub for the person's verified addresses on the way in.
      const github = preview.email !== null ? `${then}&email=1` : then;
      body = html`<p>${preview.inviterDisplay} invited ${forWhom} as ${role}.</p><p class="actions"><a class="button primary" href="${root}/sign-in?${github}">${ICONS.github}Continue with GitHub</a>${
        google && preview.email !== null
          ? html` <a class="button" href="${root}/sign-in?with=google&amp;${then}">${ICONS.google}Continue with Google</a>`
          : html``
      }</p>`;
    } else if ((teamListOf.get(session) ?? []).some((ws) => ws.tenantRef === preview.tenantRef)) {
      body = html`<p>You’re already a member of ${name}.</p><form method="post" action="${root}/organization"><input type="hidden" name="csrf" value="${csrfToken(session)}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="organization" value="${preview.tenantRef}"><button class="primary" type="submit">Open ${name}</button></form>`;
    } else {
      const person = personOf(session);
      const bound =
        (preview.githubRef !== null && preview.githubRef === person) ||
        (preview.email !== null && verifiedEmails(session).includes(preview.email));
      if (bound) {
        body = html`<p>${preview.inviterDisplay} invited you as ${role}.</p><form method="post" action="${root}/invite/accept"><input type="hidden" name="csrf" value="${csrfToken(session)}"><input type="hidden" name="once" value="${formNonce(session)}"><button class="primary" type="submit">Join as ${shownAs(session)}</button></form>`;
      } else if (preview.email !== null && session.idp !== 'google') {
        // A GitHub account shows its addresses only when asked: once, for this invitation.
        body = html`<p>${preview.inviterDisplay} invited ${forWhom} as ${role}.${
          checked ? html` None of the addresses GitHub verified for ${shownAs(session)} is it.` : html``
        }</p><p class="actions"><a class="button primary" href="${root}/sign-in?then=%2Finvite&amp;email=1">${ICONS.github}Confirm the address with GitHub</a></p>`;
      } else {
        body = html`<p>This invitation is for ${forWhom}, and you’re signed in as ${shownAs(session)}. Sign out, then open the link again and sign in as that account.</p>`;
      }
    }
    const content = html`${noticeOf(notice, status)}${pageHead(`Join ${name}`)}${body}`;
    return respond(status, layout(`Join ${name}`, content, session), headers);
  }

  async function acceptInvitation(session: Session, form: URLSearchParams, request: Request): Promise<Response> {
    if (!teamStore) return nothingHere(session);
    const person = personOf(session);
    const emails = verifiedEmails(session);
    const id = (form.get('invitation') ?? '').toLowerCase();
    let accepted: Awaited<ReturnType<typeof teamStore.accept>>;
    let role: SlotlockWorkspaceRole;
    let raw: string | null = null;
    if (id !== '') {
      // One offered on Teams: an invitation open to this person, found again here.
      const offered = (await teamStore.pendingFor(person, emails)).find((invitation) => invitation.id === id);
      if (!offered) return teamsPage(session, 404, 'That invitation is no longer open to you.');
      role = offered.role;
      accepted = await teamStore.accept({ id: offered.id, person, emails, memberCap: await memberCapOf(offered.tenantRef) });
    } else {
      raw = inviteTokenOf(request);
      const preview = raw ? await teamStore.preview(tokenDigest(raw)) : null;
      if (!raw || !preview) return invitePage(session, null, 400);
      role = preview.role;
      accepted = await teamStore.accept({ tokenSha256: tokenDigest(raw), person, emails, memberCap: await memberCapOf(preview.tenantRef) });
    }
    if ('refusal' in accepted) {
      const { status, text } = TEAM_REFUSALS[accepted.refusal];
      return id !== '' ? teamsPage(session, status, text) : invitePage(session, raw, status, text);
    }
    await audit(
      session,
      { action: 'member.joined', actorRole: role, targetType: 'person', targetRef: person },
      accepted.tenantRef,
    );
    // Into the team joined; the link is spent, and the addresses kept for it go.
    return moveTo(session, accepted.tenantRef.slice('team:'.length), '', [setCookie(INVITE_COOKIE, '', 0)], false);
  }

  async function changeTeam(session: Session, form: URLSearchParams, on: boolean): Promise<Response> {
    if (!teams) return nothingHere(session);
    const org = session.orgs?.find((candidate) => candidate.id === form.get('organization'));
    if (!org) return teamsPage(session, 400, 'That is not one of your organizations.');
    if (org.role !== 'admin') return teamsPage(session, 403, `Only an owner of ${org.login} can turn Slotlock ${on ? 'on' : 'off'} for it.`);
    // And an Owner of its workspace in Slotlock: a GitHub owner Slotlock gave a lesser role may not.
    if (workspaces && (await workspaces.standing(`github-org:${org.id}`, personOf(session))).role !== 'owner') {
      return teamsPage(session, 403, `Only an owner of ${org.login}'s workspace can turn Slotlock ${on ? 'on' : 'off'} for it.`);
    }
    // Who owns it was read as the person signed in: only a recent sign-in is trusted to say so.
    if (now() - (session.exp - SESSION_TTL_MS) > FRESH_SIGN_IN_MS) {
      return teamsPage(
        session,
        403,
        `To turn Slotlock ${on ? 'on' : 'off'} for ${org.login}, sign out and in again: who owns it is read from GitHub as you sign in.`,
      );
    }
    if (on) {
      await teams.enable({ id: org.id, login: org.login }, personOf(session));
      return teamsPage(session, 200, `Slotlock is on for ${org.login}. Its members pick it from the workspace menu.`);
    }
    if (form.get('confirm') !== org.login) return teamsPage(session, 400, `Type ${org.login} to turn it off.`);
    await teams.disable(org.id, personOf(session));
    return teamsPage(session, 200, `Slotlock is off for ${org.login}: its keys stopped. What it holds stays until it is turned on again or erased.`);
  }

  async function switchOrganization(session: Session, form: URLSearchParams): Promise<Response> {
    const wanted = form.get('organization') ?? '';
    const teamId = /^team:(.+)$/.exec(wanted)?.[1];
    if (teamStore && (teamId !== undefined || (wanted === '' && !teams))) {
      // Their own tenant, or a team workspace they are a member of now.
      if (teamId !== undefined && (!TEAM_ID.test(teamId) || !workspaces || (await workspaces.standing(wanted, personOf(session))).role === null)) {
        return respond(400, layout('Refused', html`<p class="notice">You are not a member of that team.</p>`, session));
      }
      return moveTo(session, teamId, '');
    }
    if (teams) {
      // Their own tenant, or an organization of theirs that is turned on now.
      const org = session.orgs?.find((candidate) => candidate.id === wanted);
      if (wanted !== '' && (!org || !(await teams.enabled([wanted])).has(wanted))) {
        return respond(
          400,
          layout('Refused', html`<p class="notice">You cannot act for that organization. An owner turns it on from Teams.</p>`, session),
        );
      }
      const { org: _, team: _team, ...personal } = session;
      const sealed = seal('slotlock-dashboard-session-v1', wanted === '' ? personal : { ...personal, org: wanted });
      const left = Math.max(1, Math.floor((session.exp - now()) / 1000));
      return redirect(303, root, [setCookie(SESSION_COOKIE, sealed, left)]);
    }
    const org = session.orgs?.find(
      (candidate) => candidate.id === wanted && served?.has(candidate.id),
    );
    if (!served || !org) {
      return respond(
        400,
        layout('Refused', html`<p class="notice">You cannot act for that organization.</p>`, session),
      );
    }
    const sealed = seal('slotlock-dashboard-session-v1', { ...session, org: org.id });
    const left = Math.max(1, Math.floor((session.exp - now()) / 1000));
    return redirect(303, root, [setCookie(SESSION_COOKIE, sealed, left)]);
  }

  async function startSignIn(then?: string, emails = false): Promise<Response> {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const target = new URL(authorizeUrl);
    target.search = new URLSearchParams({
      client_id: options.github.clientId,
      redirect_uri: callbackUrl,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // Reading organization membership needs read:org; a personal tenant needs no scope at all.
      // Accepting an invitation by email asks GitHub for the person's verified addresses, then only.
      ...(readsOrganizations || emails
        ? { scope: [...(readsOrganizations ? ['read:org'] : []), ...(emails ? ['user:email'] : [])].join(' ') }
        : {}),
    }).toString();
    const sealed = seal('slotlock-dashboard-sign-in-v1', {
      state,
      verifier,
      exp: now() + SIGN_IN_TTL_MS,
      ...(then ? { then } : {}),
      ...(emails ? { emails: true } : {}),
    });
    return redirect(302, target.href, [setCookie(SIGN_IN_COOKIE, sealed, SIGN_IN_TTL_MS / 1000)]);
  }

  async function exchangeCode(code: string, verifier: string): Promise<string | null> {
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: options.github.clientId,
        client_secret: options.github.clientSecret,
        code,
        redirect_uri: callbackUrl,
        code_verifier: verifier,
      }).toString(),
      // A redirect is returned, not followed, and is not `ok`, so it is refused below. ('error'
      // would do the same in Node.js, but Cloudflare Workers refuse it as a TypeError.)
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) {
      report(`GitHub token exchange failed: HTTP ${response.status}`);
      return null;
    }
    const body: unknown = await response.json().catch(() => null);
    const token = isRecord(body) ? body.access_token : undefined;
    if (typeof token === 'string' && token.length > 0 && token.length <= 1_000) return token;
    // GitHub answers a refused exchange with 200 and an `error` code; the code alone is safe to log.
    const refusal = isRecord(body) && typeof body.error === 'string' ? body.error : '';
    report(
      `GitHub token exchange failed: ${GITHUB_ERROR_CODE.test(refusal) ? refusal : 'unexpected response'}`,
    );
    return null;
  }

  async function readGitHubUser(token: string): Promise<{ uid: string; login: string } | null> {
    const response = await fetchImpl(userUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) {
      report(`GitHub user lookup failed: HTTP ${response.status}`);
      return null;
    }
    const body: unknown = await response.json().catch(() => null);
    if (
      !isRecord(body) ||
      !Number.isSafeInteger(body.id) ||
      (body.id as number) <= 0 ||
      typeof body.login !== 'string' ||
      !GITHUB_LOGIN.test(body.login)
    ) {
      return null;
    }
    return { uid: String(body.id), login: body.login };
  }

  /** The addresses GitHub verified for the token's person, lower-cased; none when it does not say. */
  async function readGitHubEmails(token: string): Promise<string[]> {
    const response = await fetchImpl(`${userUrl}/emails`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) {
      report(`GitHub email lookup failed: HTTP ${response.status}`);
      return [];
    }
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) return [];
    return body
      .slice(0, 100)
      .filter(
        (entry): entry is { email: string } =>
          isRecord(entry) && entry.verified === true && typeof entry.email === 'string' && entry.email.length <= 254,
      )
      .map((entry) => entry.email.toLowerCase());
  }

  /**
   * The served organizations the token's person is an active member of, by login, or null when
   * GitHub does not answer. Only `state: active` counts; at most MAX_SESSION_ORGANIZATIONS.
   */
  async function readMemberships(token: string): Promise<Organization[] | null> {
    const response = await fetchImpl(membershipsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) {
      report(`GitHub membership lookup failed: HTTP ${response.status}`);
      return null;
    }
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) return null;
    const found = new Map<string, Organization>();
    for (const membership of body) {
      // Owners and members only: a billing manager is not a member, and may invite more of them.
      if (
        !isRecord(membership) ||
        membership.state !== 'active' ||
        (membership.role !== 'admin' && membership.role !== 'member')
      ) {
        continue;
      }
      const organization = membership.organization;
      if (
        !isRecord(organization) ||
        !Number.isSafeInteger(organization.id) ||
        (organization.id as number) <= 0 ||
        typeof organization.login !== 'string' ||
        !GITHUB_LOGIN.test(organization.login)
      ) {
        continue;
      }
      const id = String(organization.id);
      if (teams || served?.has(id)) {
        found.set(id, { id, login: organization.login, role: membership.role === 'admin' ? 'admin' : 'member' });
      }
    }
    return [...found.values()]
      .sort((a, b) => a.login.localeCompare(b.login))
      .slice(0, MAX_SESSION_ORGANIZATIONS);
  }

  /** Google's sign-in (OpenID Connect, code flow with PKCE and a nonce), back to the same callback. */
  async function startGoogleSignIn(provider: NonNullable<typeof google>, then?: string): Promise<Response> {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const target = new URL(provider.authorizeUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth');
    target.search = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'openid email',
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    const sealed = seal('slotlock-dashboard-sign-in-v1', {
      state,
      verifier,
      nonce,
      idp: 'google',
      exp: now() + SIGN_IN_TTL_MS,
      ...(then ? { then } : {}),
    });
    return redirect(302, target.href, [setCookie(SIGN_IN_COOKIE, sealed, SIGN_IN_TTL_MS / 1000)]);
  }

  /** Google's signing keys by key id, kept for as long as its answer says (an hour by default). */
  let googleKeys: { keys: Map<string, CryptoKey>; until: number } | null = null;

  async function readGoogleKeys(provider: NonNullable<typeof google>, refresh: boolean): Promise<Map<string, CryptoKey>> {
    if (googleKeys && !refresh && googleKeys.until > now()) return googleKeys.keys;
    const response = await fetchImpl(provider.jwksUrl ?? 'https://www.googleapis.com/oauth2/v3/certs', {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Google keys answered HTTP ${response.status}`);
    const body: unknown = await response.json();
    const keys = new Map<string, CryptoKey>();
    for (const jwk of isRecord(body) && Array.isArray(body.keys) ? body.keys : []) {
      if (!isRecord(jwk) || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || (jwk.alg !== undefined && jwk.alg !== 'RS256')) continue;
      const key = await globalThis.crypto.subtle
        .importKey('jwk', { kty: 'RSA', n: jwk.n as string, e: jwk.e as string, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
        .catch(() => null);
      if (key) keys.set(jwk.kid, key);
    }
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1]);
    googleKeys = { keys, until: now() + (Number.isFinite(maxAge) && maxAge > 0 ? Math.min(maxAge * 1000, 86_400_000) : GOOGLE_KEYS_DEFAULT_TTL_MS) };
    return keys;
  }

  /** Whether an ID token's signature is Google's: RS256, by a key id Google publishes (read again once when unknown, as Google rotates them). */
  async function googleSigned(provider: NonNullable<typeof google>, header: string, payload: string, signature: string): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    } catch {
      return false;
    }
    if (!isRecord(parsed) || parsed.alg !== 'RS256' || typeof parsed.kid !== 'string') return false;
    let key = (await readGoogleKeys(provider, false)).get(parsed.kid);
    if (!key) key = (await readGoogleKeys(provider, true)).get(parsed.kid);
    if (!key) return false;
    return globalThis.crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      Buffer.from(signature, 'base64url'),
      Buffer.from(`${header}.${payload}`, 'ascii'),
    );
  }

  /**
   * The person Google signed in, from the ID token its token endpoint returned for this code. The
   * token's signature is checked against Google's published keys, and its issuer, audience (and
   * azp), expiry and nonce (OpenID Connect Core 1.0, 3.1.3.7).
   */
  async function askGoogle(
    provider: NonNullable<typeof google>,
    code: string,
    verifier: string,
    nonce: string,
  ): Promise<{ uid: string; login: string; idp: 'google' } | null> {
    try {
      const response = await fetchImpl(provider.tokenUrl ?? 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          redirect_uri: callbackUrl,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      if (!response.ok) {
        report(`Google token exchange failed: HTTP ${response.status}`);
        return null;
      }
      const body: unknown = await response.json().catch(() => null);
      const token = isRecord(body) && typeof body.id_token === 'string' ? body.id_token : null;
      const [header, payload, signature, ...extra] = token?.split('.') ?? [];
      if (!header || !payload || !signature || extra.length > 0 || ![header, payload, signature].every((part) => BASE64URL.test(part))) {
        return null;
      }
      // Signed by Google, with one of the keys it publishes (RS256), whichever way the token came.
      if (!(await googleSigned(provider, header, payload, signature))) {
        report('Google sign-in refused: the ID token is not signed by Google');
        return null;
      }
      const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!isRecord(claims)) return null;
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (
        (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') ||
        !audience.includes(provider.clientId) ||
        (audience.length > 1 && claims.azp !== provider.clientId) ||
        typeof claims.exp !== 'number' ||
        claims.exp * 1000 <= now() ||
        typeof claims.nonce !== 'string' ||
        !safeEqual(claims.nonce, nonce) ||
        typeof claims.sub !== 'string' ||
        !GOOGLE_SUBJECT.test(claims.sub)
      ) {
        report('Google sign-in refused: the ID token did not check out');
        return null;
      }
      // The email names the person on the page only, and only once Google has verified it.
      const email =
        (claims.email_verified === true || claims.email_verified === 'true') && typeof claims.email === 'string' && claims.email.length <= 254 && !/[<>\p{Cc}]/u.test(claims.email)
          ? claims.email
          : 'Google account';
      return { uid: claims.sub, login: email, idp: 'google' };
    } catch (error) {
      report(`Google sign-in failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      return null;
    }
  }

  async function askGitHub(
    code: string,
    verifier: string,
    emails = false,
  ): Promise<{ uid: string; login: string; orgs?: Organization[]; emails?: string[] } | null> {
    try {
      const token = await exchangeCode(code, verifier);
      if (token === null) return null;
      const found = await readGitHubUser(token);
      const user = found && emails ? { ...found, emails: await readGitHubEmails(token) } : found;
      if (!user || !readsOrganizations) return user;
      const orgs = await readMemberships(token);
      return orgs === null ? null : { ...user, orgs };
    } catch (error) {
      report(`GitHub sign-in failed: ${error instanceof Error ? error.name : 'unknown error'}`);
      return null;
    }
  }

  async function finishSignIn(request: Request, url: URL): Promise<Response> {
    const clearSignIn = setCookie(SIGN_IN_COOKIE, '', 0);
    const pending = unseal(
      'slotlock-dashboard-sign-in-v1',
      readCookies(request).get(SIGN_IN_COOKIE),
    );
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (
      url.searchParams.has('error') ||
      !pending ||
      typeof pending.state !== 'string' ||
      typeof pending.verifier !== 'string' ||
      code === null ||
      code.length === 0 ||
      code.length > 512 ||
      state === null ||
      !safeEqual(state, pending.state)
    ) {
      return signedOutPage(400, SIGN_IN_AGAIN, [clearSignIn]);
    }
    const client = options.clientAddress?.(request);
    const fromClient = client === undefined ? 0 : (signInsByClient.get(client) ?? 0);
    if (
      signInsInFlight >= MAX_SIGN_INS_IN_FLIGHT ||
      fromClient >= MAX_SIGN_INS_IN_FLIGHT_PER_CLIENT
    ) {
      return signedOutPage(
        503,
        'Too many people are signing in at once. Sign in again in a moment.',
        [clearSignIn],
      );
    }
    const verifier = pending.verifier;
    signInsInFlight += 1;
    if (client !== undefined) signInsByClient.set(client, fromClient + 1);
    let user: { uid: string; login: string; orgs?: Organization[]; idp?: 'google'; emails?: string[] } | null;
    try {
      // Recorded before GitHub is asked, so a replayed callback is refused on every server unasked.
      if (!(await options.state.use('sign_in', pending.state, pending.exp as number))) {
        return signedOutPage(400, SIGN_IN_AGAIN, [clearSignIn]);
      }
      user =
        pending.idp === 'google'
          ? google && typeof pending.nonce === 'string'
            ? await askGoogle(google, code, verifier, pending.nonce)
            : null
          : await askGitHub(code, verifier, pending.emails === true);
    } finally {
      signInsInFlight -= 1;
      if (client !== undefined) {
        const left = (signInsByClient.get(client) ?? 1) - 1;
        if (left === 0) signInsByClient.delete(client);
        else signInsByClient.set(client, left);
      }
    }
    if (!user) {
      return signedOutPage(
        502,
        `${pending.idp === 'google' ? 'Google' : 'GitHub'} did not complete the sign-in. Try again.`,
        [clearSignIn],
      );
    }
    if (!allowed(user.uid, user.idp)) {
      return signedOutPage(
        403,
        `This Slotlock server does not let ${user.idp === 'google' ? user.login : `@${user.login}`} sign in.`,
        [clearSignIn],
      );
    }
    const orgs = user.orgs ?? [];
    if (served && orgs.length === 0) {
      return signedOutPage(
        403,
        `@${user.login} is not a member of an organization this Slotlock server serves.`,
        [clearSignIn],
      );
    }
    // The person and, with GitHub, the organizations GitHub lists them in, as memberships now; the
    // epoch their sessions must carry.
    const person = user.idp === 'google' ? `google:${user.uid}` : `github:${user.uid}`;
    const epoch = workspaces
      ? await workspaces.signedIn(
          person,
          user.idp === 'google' || user.orgs === undefined
            ? undefined
            : user.orgs.map((org) => ({ id: org.id, role: org.role === 'admin' ? ('admin' as const) : ('member' as const) })),
        )
      : undefined;
    // How the person is shown to the others in their teams: their GitHub login, or Google's verified email.
    if (teamStore) {
      await teamStore.setDisplay(person, user.idp === 'google' ? (user.login.includes('@') ? user.login : null) : `@${user.login}`);
    }
    // Of the addresses GitHub verified, only the invitation being opened's is kept, to accept it.
    let em: string[] | undefined;
    if (teamStore && user.emails) {
      const raw = inviteTokenOf(request);
      const invited = raw ? (await teamStore.preview(tokenDigest(raw)))?.email : null;
      if (invited && user.emails.includes(invited)) em = [invited];
    }
    const sealedOrg = served ? (orgs[0] as Organization).id : undefined;
    const sid = randomBytes(24).toString('base64url');
    const expires = now() + SESSION_TTL_MS;
    // Listed on the person's Account page, to sign out from another device.
    await workspaces?.sessions?.started(person, sid, new Date(expires), requestOrigin(request));
    const session = seal('slotlock-dashboard-session-v1', {
      uid: user.uid,
      login: user.login,
      sid,
      exp: expires,
      ...(user.idp === 'google' ? { idp: 'google' } : {}),
      ...(served ? { orgs, org: sealedOrg } : teams && user.idp !== 'google' ? { orgs } : {}),
      ...(epoch !== undefined ? { ep: epoch } : {}),
      ...(em ? { em } : {}),
    });
    if (options.resources.audit) {
      const signedInTo = sealedOrg !== undefined ? `github-org:${sealedOrg}` : person;
      const from = requestOrigin(request);
      await options.resources.audit
        .record(signedInTo, { action: 'session.signed_in', actorType: 'person', actorRef: person, ...from })
        .catch((error: unknown) => ignoreRejection(options.onError?.(error)));
    }
    const back = typeof pending.then === 'string' && STEP_UP_PAGES.has(pending.then) ? pending.then : '';
    return redirect(303, `${root}${back}${back === '/invite' && pending.emails === true ? '?checked=1' : ''}`, [
      clearSignIn,
      setCookie(SESSION_COOKIE, session, SESSION_TTL_MS / 1000),
    ]);
  }

  /** The form, `'too_large'` past MAX_FORM_BYTES (read no further), or null for another type. */
  async function readForm(
    request: Request,
    maxBytes = MAX_FORM_BYTES,
    multipart = false,
  ): Promise<URLSearchParams | 'too_large' | null> {
    const header = request.headers.get('content-type') ?? '';
    const type = header.split(';')[0]?.trim();
    const isMultipart = multipart && type === 'multipart/form-data';
    if (type !== 'application/x-www-form-urlencoded' && !isMultipart) return null;
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return 'too_large';
    if (!request.body) return new URLSearchParams();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      chunks.push(value);
    }
    if (!isMultipart) return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    // A file field is read as text under its name; nothing else a form sends is kept apart.
    let data: FormData;
    try {
      data = await new Response(Buffer.concat(chunks), { headers: { 'content-type': header } }).formData();
    } catch {
      return null;
    }
    const form = new URLSearchParams();
    for (const [name, value] of data.entries()) {
      if (typeof value === 'string') form.append(name, value);
      else if (value.size > 0) form.append(name, await value.text());
    }
    return form;
  }

  async function createKey(session: Session, form: URLSearchParams): Promise<Response> {
    const scopes = KEY_ACCESS[form.get('access') ?? ''];
    const expiry = form.get('expires') ?? '';
    if (!scopes || !Object.hasOwn(KEY_EXPIRY_DAYS, expiry)) {
      return keysPage(session, 400, 'Choose an access level and an expiry from the lists.');
    }
    const days = KEY_EXPIRY_DAYS[expiry];
    const limited = {
      locations: [...new Set(form.getAll('limit_location'))],
      groups: [...new Set(form.getAll('limit_group'))],
    };
    const resourceScope = limited.locations.length + limited.groups.length > 0 ? limited : undefined;
    const limits = keyLimitsOf(form);
    if (typeof limits === 'string') return keysPage(session, 400, limits);
    if (resourceScope) {
      if (scopes.includes('admin')) {
        return keysPage(session, 400, 'A key limited to locations or groups reads and writes only: choose that access.');
      }
      // Keys limited to part of the tenant come with Developer (RFC 0003 pricing); a server without
      // plans allows them.
      const plan = plans ? await plans.plan(tenantOf(session)) : null;
      if (plan?.plan === 'free') {
        return keysPage(session, 403, 'Keys limited to locations or groups come with the Developer and Team plans. See Usage.');
      }
    }
    try {
      const created = await options.keys.create({
        tenantRef: tenantOf(session),
        name: form.get('name') ?? '',
        scopes,
        createdBy: personOf(session),
        origin: 'dashboard',
        ...(resourceScope ? { resourceScope } : {}),
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
        ...(typeof days === 'number' ? { expiresAt: new Date(now() + days * DAY_MS) } : {}),
      });
      return shownOncePage(session, created.key, created.apiKey, false);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'invalid_api_key_name') {
        return keysPage(session, 400, 'Give the key a name of 1 to 100 characters.');
      }
      if (code === 'invalid_api_key_resource_scope') {
        return keysPage(session, 400, 'Choose up to 20 locations and 20 groups from the lists.');
      }
      if (code === 'api_key_limit_reached') {
        return keysPage(
          session,
          409,
          plans
            ? html`You have as many active keys as your plan allows. Revoke one first, or ${await pastLimit(session)}.`
            : 'You have as many keys as Slotlock allows. Revoke one first.',
        );
      }
      throw error;
    }
  }

  /** A key change in the session's tenant, recorded as the person's, from the dashboard. */
  const asPerson = (session: Session) => ({
    tenantRef: tenantOf(session),
    actor: personOf(session),
    origin: 'dashboard' as const,
  });

  /** A key's limits from its form (RFC 0004 A5): each empty field the server's; else what is wrong. */
  function keyLimitsOf(form: URLSearchParams): SlotlockApiKeyLimits | string {
    const whole = (name: string, most: number): number | undefined | null => {
      const text = (form.get(name) ?? '').trim();
      if (text === '') return undefined;
      const value = /^[0-9]{1,7}$/.test(text) ? Number(text) : Number.NaN;
      return Number.isSafeInteger(value) && value >= 1 && value <= most ? value : null;
    };
    const maxHolds = whole('max_holds', 10_000);
    const maxHeldHours = whole('max_held_hours', 876_000);
    const requestsPerMinute = whole('requests_per_minute', 100_000);
    if (maxHolds === null || maxHeldHours === null || requestsPerMinute === null) {
      return 'Give each limit as a whole number: live holds 1 to 10,000, hours held 1 to 876,000, requests a minute 1 to 100,000. Leave one empty for the server’s.';
    }
    return {
      ...(maxHolds !== undefined ? { maxHolds } : {}),
      ...(maxHeldHours !== undefined ? { maxHeldHours } : {}),
      ...(requestsPerMinute !== undefined ? { requestsPerMinute } : {}),
      ...(form.get('requires_approval') === 'on' ? { requiresApproval: true } : {}),
    };
  }

  async function saveKeyLimits(session: Session, form: URLSearchParams): Promise<Response> {
    const id = form.get('id') ?? '';
    if (!UUID_PATTERN.test(id)) return keysPage(session, 404, 'That key is not one of yours.');
    const limits = keyLimitsOf(form);
    if (typeof limits === 'string') return keysPage(session, 400, limits);
    if (!(await options.keys.setLimits({ tenantRef: tenantOf(session), id, limits }))) {
      return keysPage(session, 404, 'That key is not an active key of yours.');
    }
    return redirect(303, `${root}/keys`);
  }

  async function changeKey(session: Session, form: URLSearchParams, change: 'rotate' | 'revoke') {
    const id = form.get('id') ?? '';
    if (!UUID_PATTERN.test(id)) return keysPage(session, 404, 'That key is not one of yours.');
    if (change === 'rotate') {
      const rotated = await options.keys.rotate({ ...asPerson(session), id });
      if (!rotated) return keysPage(session, 404, 'That key is not an active key of yours.');
      return shownOncePage(session, rotated.key, rotated.apiKey, true);
    }
    const revoked = await options.keys.revoke({ ...asPerson(session), id });
    if (!revoked) return keysPage(session, 404, 'That key is not one of yours.');
    return redirect(303, `${root}/keys`);
  }

  async function addResource(session: Session, form: URLSearchParams): Promise<Response> {
    const reference = (form.get('reference') ?? '').trim();
    const timezone = (form.get('timezone') ?? '').trim();
    if (reference.length === 0 || reference.length > 200) {
      return resourcesPage(session, 400, 'Give the resource a reference of 1 to 200 characters.');
    }
    try {
      await options.resources.add(tenantOf(session), reference, timezone, personOf(session));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'resource_limit_reached') {
        const limit = (error as { limit?: unknown }).limit;
        return resourcesPage(
          session,
          409,
          typeof limit === 'number' && limit < SLOTLOCK_DASHBOARD_MAX_RESOURCES
            ? html`You have ${String(limit)} resources, archived ones included, as many as your plan allows. Delete one, or ${await pastLimit(session)}.`
            : `You have ${SLOTLOCK_DASHBOARD_MAX_RESOURCES} resources, as many as the dashboard allows.`,
        );
      }
      if (code === 'invalid_timezone') {
        return resourcesPage(
          session,
          400,
          `${timezone} is not a time zone Slotlock knows, such as Europe/London.`,
        );
      }
      if (code === 'invalid_external_ref') {
        return resourcesPage(session, 400, 'Give the resource a reference of 1 to 200 characters.');
      }
      throw error;
    }
    return redirect(303, `${root}/resources`);
  }

  async function handlePost(request: Request, route: string): Promise<Response> {
    // A browser sends Origin with every form POST; anything else did not come from these pages.
    if (request.headers.get('origin') !== origin) {
      return respond(
        403,
        layout(
          'Refused',
          html`<p class="notice">That request did not come from this dashboard.</p>`,
          null,
        ),
      );
    }
    const session = await readSession(request);
    if (!session) return redirect(303, root);
    // A holiday calendar may be uploaded, or pasted, up to its own limit.
    const importing = route === '/closures/import';
    const form = await readForm(
      request,
      importing
        ? MAX_IMPORT_FORM_BYTES
        : route === '/assistant' || route === '/assistant/stream'
          ? MAX_ASSISTANT_FORM_BYTES
          : MAX_FORM_BYTES,
      importing,
    );
    if (form === 'too_large') {
      return respond(
        413,
        layout('Refused', html`<p class="notice">That form is too large.</p>`, session),
      );
    }
    if (!form)
      return respond(
        400,
        layout('Refused', html`<p class="notice">That form could not be read.</p>`, session),
      );
    const presented = form.get('csrf') ?? '';
    if (!safeEqual(presented, csrfToken(session))) {
      return respond(
        403,
        layout(
          'Refused',
          html`<p class="notice">That form has expired. Go back and try again.</p>`,
          session,
        ),
      );
    }
    // Nothing is recorded for a route that does not exist.
    if (!POST_ROUTES.has(route)) {
      return respond(
        404,
        layout('Not found', html`<p class="notice">Nothing is here.</p>`, session),
      );
    }
    origins.set(session, requestOrigin(request));
    // A form sent again (a reload of its result, a double click) must not create or rotate twice.
    // Every form but sign-out carries a single-use value, so leaving it out cannot skip this check
    // or the per-person form limit.
    const once = form.get('once');
    if (once === null && route !== '/sign-out') {
      return respond(
        400,
        layout('Refused', html`<p class="notice">That form could not be read.</p>`, session),
      );
    }
    if (once !== null) {
      const checked = checkFormNonce(session, once);
      if (checked === 'other_org') {
        return pageOrNotice(route)(
          session,
          409,
          'That page was for another workspace. Nothing was changed: check the workspace and try again.',
        );
      }
      let first: boolean;
      try {
        first =
          checked === 'ok' &&
          (await options.state.use('form', once, session.exp, session.idp === 'google' ? personOf(session) : session.uid));
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'dashboard_form_limit') throw error;
        return pageOrNotice(route)(
          session,
          429,
          'Too many forms sent from this account in the last 12 hours. Try again later.',
        );
      }
      if (!first) {
        // The first one was taken: a second click, a reload or a resend shows what it did.
        if (route.startsWith('/assistant')) {
          const chat = chatOf(form.get('chat'));
          return redirect(303, chat ? `${chatUrl(chat)}#latest` : `${root}/assistant#latest`);
        }
        return pageOrNotice(route)(
          session,
          409,
          'That form was already sent. Reload the page to start again.',
        );
      }
    }
    // What the person may do, from their role now: before anything changes, and after the form's
    // single-use value and the per-person form limit, so refusals cannot flood the audit log.
    const refused = await authorizePost(session, route, form);
    if (refused) return refused;
    // A tenant new to plans is put on the default plan before it adds what plans limit.
    if (route === '/keys' || route === '/resources' || route === '/webhooks') {
      await plans?.enrol?.(tenantOf(session));
    }
    const response = await dispatchPost(session, route, form, request);
    const action = AUDITED_ROUTES[route];
    if (action && response.status < 400) await audit(session, { action, ...auditDetails(route, form) });
    return response;
  }

  async function dispatchPost(session: Session, route: string, form: URLSearchParams, request: Request): Promise<Response> {
    switch (route) {
      case '/sign-out-everywhere':
        // Every session of the person, on every device and server, this one included: only with
        // the membership store, which holds the epoch every session carries.
        if (!workspaces) return notFound(session);
        await workspaces.signOutEverywhere(personOf(session));
        await workspaces.sessions?.end(personOf(session), null);
        await options.state.endSession(session.sid, session.exp);
        return redirect(303, root, [setCookie(SESSION_COOKIE, '', 0)]);
      case '/sign-out':
        await options.state.endSession(session.sid, session.exp);
        await workspaces?.sessions?.end(personOf(session), workspaces.sessions.idOf(session.sid));
        return redirect(303, root, [setCookie(SESSION_COOKIE, '', 0)]);
      case '/sessions/end':
        return endSession(session, form);
      case '/keys':
        return createKey(session, form);
      case '/keys/rotate':
        return changeKey(session, form, 'rotate');
      case '/keys/revoke':
        return changeKey(session, form, 'revoke');
      case '/keys/limits':
        return saveKeyLimits(session, form);
      case '/resources':
        return addResource(session, form);
      case '/hours':
        return saveHours(session, form);
      case '/closures':
        return saveClosure(session, form);
      case '/closures/delete':
        return deleteClosure(session, form);
      case '/closures/import':
        return importClosures(session, form);
      case '/closures/calendars/delete':
        return deleteHolidayCalendar(session, form);
      case '/contacts/forget':
        return forgetContact(session, form);
      case '/organization':
        return switchOrganization(session, form);
      case '/environment':
        return switchEnvironment(session, form);
      case '/resources/rules':
        return saveRules(session, form);
      case '/resources/pool':
        return savePool(session, form);
      case '/resources/profile':
        return saveProfile(session, form);
      case '/resources/place':
        return savePlace(session, form);
      case '/resources/parent':
        return saveParent(session, form);
      case '/locations':
        return saveLocation(session, form);
      case '/locations/delete':
        return deleteGrouping(session, form, 'location');
      case '/groups':
        return saveGroup(session, form);
      case '/groups/delete':
        return deleteGrouping(session, form, 'group');
      case '/webhooks':
        return addWebhook(session, form);
      case '/webhooks/delete':
        return changeWebhook(session, form, 'remove');
      case '/webhooks/enable':
        return changeWebhook(session, form, 'enable');
      case '/waitlist/leave':
        return leaveWaitlist(session, form);
      case '/approvals/decide':
        return decideApproval(session, form);
      case '/sandbox/seed':
        return sandboxAction(session, form, 'seed');
      case '/sandbox/reset':
        return sandboxAction(session, form, 'reset');
      case '/sandbox/fast-forward':
        return sandboxAction(session, form, 'fast-forward');
      case '/assistant':
        return sendToAssistant(session, form);
      case '/assistant/stream':
        return streamToAssistant(session, form, request);
      case '/assistant/approve':
        return settleAction(session, form, 'approve');
      case '/assistant/dismiss':
        return settleAction(session, form, 'dismiss');
      case '/assistant/reset':
        return resetAssistant(session);
      case '/assistant/rename':
        return renameChat(session, form);
      case '/assistant/delete':
        return deleteChat(session, form);
      case '/settings/assistant':
        return saveAssistantSettings(session, form);
      case '/settings/assistant/models':
        return loadAssistantModels(session, form);
      case '/settings/assistant/test':
        return testAssistant(session);
      case '/settings/assistant/remove':
        return removeAssistantSettings(session);
      case '/plan/upgrade':
        return upgradePlan(session, form);
      case '/plan/manage':
        return manageBilling(session);
      case '/teams/enable':
        return changeTeam(session, form, true);
      case '/teams/disable':
        return changeTeam(session, form, false);
      case '/teams/create':
        return createTeam(session, form);
      case '/teams/delete':
        return deleteTeam(session, form);
      case '/teams/restore':
        return restoreTeam(session);
      case '/invite/accept':
        return acceptInvitation(session, form, request);
      case '/members/invite':
        return inviteMember(session, form);
      case '/members/resend':
        return resendInvitation(session, form);
      case '/members/revoke':
        return revokeInvitation(session, form);
      case '/members/role':
        return changeMemberRole(session, form);
      case '/members/remove':
        return removeMember(session, form);
      case '/members/leave':
        return leaveTeam(session);
      default:
        return respond(
          404,
          layout('Not found', html`<p class="notice">Nothing is here.</p>`, session),
        );
    }
  }

  return {
    handles(request) {
      const { pathname } = new URL(request.url);
      return pathname === root || pathname.startsWith(`${root}/`);
    },

    async fetch(request) {
      const url = new URL(request.url);
      const route = url.pathname.slice(root.length).replace(/\/$/, '') || '/';
      try {
        if (request.method === 'GET') {
          switch (route) {
            case '/': {
              const session = await readSession(request);
              if (!session) return signedOutPage(200);
              return authorizePage(session, '/') ?? (await overviewPage(session));
            }
            case '/keys':
            case '/resources':
            case '/webhooks':
            case '/waitlist':
            case '/approvals':
            case '/assistant':
            case '/assistant/chats':
            case '/plan':
            case '/teams':
            case '/settings/endpoints':
            case '/settings/hours':
            case '/settings/account':
            case '/settings/members':
            case '/settings/audit':
            case '/settings/audit/export':
            case '/settings/team':
            case '/settings': {
              const session = await readSession(request);
              if (!session) return redirect(303, root);
              const denied = authorizePage(session, route);
              if (denied) return denied;
              if (route === '/teams') return await teamsPage(session);
              if (route === '/plan') {
                return await planPage(
                  session,
                  200,
                  url.searchParams.get('checkout') === 'done'
                    ? 'Thank you. Your plan changes here once Stripe confirms the payment, usually within a minute.'
                    : undefined,
                  url.searchParams.get('checkout') === 'done',
                );
              }
              if (route === '/keys') return await keysPage(session);
              if (route === '/resources') {
                return await resourcesPage(session, 200, undefined, url.searchParams.get('hours') === 'own');
              }
              if (route === '/webhooks') return await webhooksPage(session);
              if (route === '/waitlist') return await waitlistPage(session);
              if (route === '/approvals') return await approvalsPage(session);
              if (route === '/assistant') return await assistantPage(session, 200, undefined, url.searchParams.get('c') ?? undefined);
              if (route === '/assistant/chats') return await chatsPage(session);
              if (route === '/settings/endpoints') return await settingsPage(session, 200, undefined, undefined, 'endpoints');
              if (route === '/settings/hours') return await settingsPage(session, 200, undefined, undefined, 'hours');
              if (route === '/settings/account') return await settingsPage(session, 200, undefined, undefined, 'account');
              if (route === '/settings/members') {
                return teamStore && session.team !== undefined
                  ? await settingsPage(session, 200, undefined, undefined, 'members')
                  : nothingHere(session);
              }
              if (route === '/settings/audit/export') return await exportAudit(session, url.searchParams);
              if (route === '/settings/team') {
                return teamStore && session.team !== undefined
                  ? await settingsPage(session, 200, undefined, undefined, 'team')
                  : nothingHere(session);
              }
              if (route === '/settings/audit') {
                return options.resources.audit
                  ? await settingsPage(session, 200, undefined, undefined, 'audit', undefined, url.searchParams)
                  : nothingHere(session);
              }
              // A provider preset fills the assistant's form; nothing is saved until Save.
              const preset = SLOTLOCK_ASSISTANT_PRESETS.find(
                (candidate) => candidate.id === url.searchParams.get('preset'),
              );
              return await settingsPage(
                session,
                200,
                undefined,
                preset ? { provider: preset.provider, baseUrl: preset.baseUrl } : undefined,
              );
            }
            case '/style.css':
              return asset(DASHBOARD_ASSETS.css, 'text/css; charset=utf-8', url, ASSET_VERSIONS.css);
            case '/app.js':
              return asset(DASHBOARD_ASSETS.js, 'text/javascript; charset=utf-8', url, ASSET_VERSIONS.js);
            case '/favicon.svg':
              return asset(SLOTLOCK_DASHBOARD_ICON_SVG, 'image/svg+xml', url, ASSET_VERSIONS.icon);
            case '/sign-in': {
              // After signing in again to confirm it's you, back to the page that asked.
              const then = url.searchParams.get('then') ?? '';
              const back = STEP_UP_PAGES.has(then) ? then : undefined;
              return google && url.searchParams.get('with') === 'google'
                ? await startGoogleSignIn(google, back)
                : await startSignIn(back, Boolean(teamStore) && back === '/invite' && url.searchParams.get('email') === '1');
            }
            case '/invite': {
              if (!teamStore) return nothingHere404();
              // An invitation's link: its token (in the query, which request logs leave out) is kept
              // in this browser for the sign-in that accepts it, and nothing else; opening it twice
              // (a link scanner, a preview) consumes nothing.
              const raw = url.searchParams.get('t');
              if (raw !== null) {
                if (!INVITE_TOKEN.test(raw)) return nothingHere404();
                const opened = seal('slotlock-dashboard-invite-v1', { t: raw, exp: now() + INVITE_LINK_TTL_MS });
                return respond(303, '', { Location: `${root}/invite`, 'Referrer-Policy': 'no-referrer' }, [
                  setCookie(INVITE_COOKIE, opened, INVITE_LINK_TTL_MS / 1000),
                ]);
              }
              const session = await readSession(request);
              return await invitePage(session, inviteTokenOf(request), 200, undefined, url.searchParams.get('checked') === '1');
            }
            case '/callback':
              return await finishSignIn(request, url);
            case '/hours': {
              const session = await readSession(request);
              if (!session) return redirect(303, root);
              return authorizePage(session, route) ?? (await hoursEditor(session, url));
            }
            case '/closures': {
              const session = await readSession(request);
              if (!session) return redirect(303, root);
              return authorizePage(session, route) ?? (await closuresPage(session));
            }
            case '/contacts': {
              const session = await readSession(request);
              const after = url.searchParams.get('after') ?? undefined;
              if (!session) return redirect(303, root);
              return authorizePage(session, route) ?? (await contactsPage(session, 200, undefined, after));
            }
            case '/locations': {
              const session = await readSession(request);
              if (!session) return redirect(303, root);
              return authorizePage(session, route) ?? (await locationsPage(session));
            }
            default: {
              const resourceId = RESOURCE_PAGE.exec(route)?.[1];
              if (resourceId !== undefined) {
                const session = await readSession(request);
                if (!session) return redirect(303, root);
                return authorizePage(session, '/resources/:id') ?? (await resourceDetailPage(session, resourceId.toLowerCase()));
              }
              return respond(
                404,
                layout('Not found', html`<p class="notice">Nothing is here.</p>`, null),
              );
            }
          }
        }
        if (request.method === 'POST') return await handlePost(request, route);
        return respond(
          405,
          layout(
            'Not allowed',
            html`<p class="notice">Use the dashboard's pages and forms.</p>`,
            null,
          ),
          {
            Allow: 'GET, POST',
          },
        );
      } catch (error) {
        // A suspended tenant may look, not change: the store refuses its writes.
        if ((error as { code?: unknown } | null)?.code === 'tenant_suspended') {
          return respond(
            403,
            layout(
              'Suspended',
              html`<p class="notice">This account is suspended: its data can be seen, not changed.</p>`,
              null,
            ),
          );
        }
        try {
          ignoreRejection(options.onError?.(error));
        } catch {
          // A failing reporter must not change the response.
        }
        return respond(
          500,
          layout(
            'Error',
            html`<p class="notice">Something went wrong. Try again in a moment.</p>`,
            null,
          ),
        );
      }
    },
  };
}

// Progressive enhancement only, loaded as a file so the policy needs no inline code: copy buttons
// (announced in the page's live region), confirmations that close with Escape or a click outside
// and put focus on their button, and, on a phone, the current page scrolled into the tab strip.
const DASHBOARD_JS = `const live = document.getElementById('live');
const say = (text) => {
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = text; }, 50);
};
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  for (const open of document.querySelectorAll('details.act[open]')) {
    if (!target || !open.contains(target)) open.removeAttribute('open');
  }
  const button = target ? target.closest('[data-copy]') : null;
  if (!button) return;
  const field = document.getElementById(button.getAttribute('data-copy'));
  if (!field) return;
  const label = button.textContent;
  const done = (text) => {
    button.textContent = text;
    say(text);
    setTimeout(() => { button.textContent = label; }, 2000);
  };
  const selectIt = () => {
    if (typeof field.select === 'function') field.select();
    done('Selected: press Ctrl+C or Cmd+C');
  };
  if (!navigator.clipboard) return selectIt();
  navigator.clipboard.writeText(field.value ?? field.textContent ?? '').then(() => done('Copied'), selectIt);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const open of document.querySelectorAll('details.act[open]')) {
    open.removeAttribute('open');
    const summary = open.querySelector('summary');
    if (summary) summary.focus();
  }
});
document.addEventListener('toggle', (event) => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.classList.contains('act') || !details.open) return;
  const confirm = details.querySelector('.pop button[type=submit]');
  if (confirm) confirm.focus();
}, true);
const current = document.querySelector('.nav a[aria-current="page"]');
if (current && window.matchMedia('(max-width: 760px)').matches) {
  current.scrollIntoView({ block: 'nearest', inline: 'center' });
}
`;

const DASHBOARD_CSS = `:root {
  --font: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --text-xs: 11px; --text-sm: 12.5px; --text-md: 13.5px; --text-lg: 15px; --text-xl: 22px; --text-2xl: 28px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-12: 48px;
  --radius-sm: 6px; --radius: 8px; --radius-lg: 12px; --radius-full: 999px;
  --ease: cubic-bezier(0.2, 0, 0, 1); --fast: 120ms; --slow: 180ms;
  --canvas: #f7f7f8; --surface: #ffffff; --surface-2: #fafafa; --sunken: #f2f2f4; --hover: #f0f0f2;
  --line: #e6e6e9; --line-strong: #d4d4d8; --line-soft: #efeff1;
  --ink: #18181b; --ink-2: #52525b; --ink-3: #6b6b74;
  --accent: #2456e6; --accent-wash: #eef2fe; --ring: rgba(36, 86, 230, 0.28);
  --button: #18181b; --button-ink: #ffffff; --button-hover: #2e2e33;
  --good: #11764c; --good-wash: #e9f6ef; --bad: #c42b1c; --bad-ink: #ffffff; --bad-wash: #fdeeec; --bad-line: #f5c9c3;
  --warn: #8a5300; --warn-wash: #fff5e1; --warn-line: #f3dcae;
  --brand: #ff5b2e;
  --pop-shadow: 0 1px 2px rgba(24, 24, 27, 0.06), 0 12px 32px -8px rgba(24, 24, 27, 0.18);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #0b0b0d; --surface: #111114; --surface-2: #141418; --sunken: #18181c; --hover: #1c1c21;
    --line: #26262c; --line-strong: #34343b; --line-soft: #1d1d22;
    --ink: #ededf0; --ink-2: #b4b4bc; --ink-3: #8e8e98;
    --accent: #7ea2ff; --accent-wash: #18203a; --ring: rgba(126, 162, 255, 0.35);
    --button: #ededf0; --button-ink: #0b0b0d; --button-hover: #ffffff;
    --good: #4fca8f; --good-wash: #0f2419; --bad: #ff7a6b; --bad-ink: #1a0806; --bad-wash: #2c1512; --bad-line: #5a2a24;
    --warn: #f4c25a; --warn-wash: #2a2210; --warn-line: #4d3d17;
    --pop-shadow: 0 0 0 1px #26262c, 0 16px 40px -8px rgba(0, 0, 0, 0.7);
    color-scheme: dark;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: var(--canvas); color: var(--ink); font: 400 14px/1.5 var(--font); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }
a { color: var(--accent); text-decoration: none; text-underline-offset: 2px; }
a:hover { text-decoration: underline; }
code, pre, kbd, input[readonly] { font-family: var(--mono); font-size: 12.5px; }
::selection { background: var(--ring); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.icon .fill { fill: currentColor; stroke: none; }
.mark { width: 20px; height: 18px; flex: none; }
.mark-ink { fill: currentColor; }
.mark-slot { fill: var(--brand); }
.skip { position: absolute; left: var(--space-3); top: -48px; z-index: 10; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--button); color: var(--button-ink); font-weight: 600; }
.skip:focus { top: var(--space-3); text-decoration: none; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* Shell */
.brand { display: inline-flex; align-items: center; gap: 9px; min-width: 0; color: var(--ink); font-weight: 600; font-size: var(--text-lg); letter-spacing: -0.015em; }
.brand:hover { text-decoration: none; }
.brand .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; }
.side { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: var(--space-5); padding: var(--space-4) var(--space-3); background: var(--surface-2); border-right: 1px solid var(--line); min-width: 0; }
.side-top { display: grid; gap: var(--space-4); padding: var(--space-1) var(--space-2) 0; min-width: 0; }
.workspace { display: flex; align-items: center; gap: var(--space-2); margin: 0; padding: 5px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); min-width: 0; }
.workspace-name { font-weight: 600; font-size: var(--text-md); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace select { flex: 1; min-width: 0; height: 26px; border: 0; padding: 0 18px 0 2px; font-weight: 600; font-size: var(--text-md); background-color: transparent; box-shadow: none; text-overflow: ellipsis; }
.workspace select:focus { box-shadow: none; }
.workspace:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }
.environment { display: flex; gap: 2px; margin: calc(-1 * var(--space-2)) 0 0; padding: 2px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.environment button { flex: 1; height: 26px; padding: 0 var(--space-2); border: 0; border-radius: calc(var(--radius) - 2px); background: none; box-shadow: none; color: var(--muted); font-size: var(--text-sm); font-weight: 600; }
.environment button[aria-pressed="true"] { background: var(--surface-2); color: var(--ink); box-shadow: 0 0 0 1px var(--line); }
.environment button[aria-pressed="true"][value="test"] { background: var(--warn-wash); color: var(--warn); box-shadow: 0 0 0 1px var(--warn-line); }
.test-banner { margin: 0 0 var(--space-4); padding: var(--space-2) var(--space-3); border: 1px dashed var(--warn-line); border-radius: var(--radius); background: var(--warn-wash); color: var(--warn); font-size: var(--text-md); }
.test-banner code { background: none; padding: 0; }
.avatar { display: inline-grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: var(--radius-sm); background: var(--ink); color: var(--surface); font-size: 11px; font-weight: 700; }
.nav { display: grid; gap: 1px; }
.nav a { position: relative; display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 10px; border-radius: var(--radius); color: var(--ink-2); font-weight: 500; font-size: var(--text-md); transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease); }
.nav a .icon { color: var(--ink-3); transition: color var(--fast) var(--ease); }
.nav a:hover { background: var(--hover); color: var(--ink); text-decoration: none; }
.nav a:hover .icon { color: var(--ink-2); }
.nav a[aria-current="page"] { background: var(--surface); color: var(--ink); font-weight: 600; box-shadow: inset 0 0 0 1px var(--line); }
.nav a[aria-current="page"] .icon { color: var(--ink); }
.me { margin-top: auto; display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-2) 0; border-top: 1px solid var(--line); color: var(--ink-2); font-size: var(--text-md); min-width: 0; }
.me-avatar { width: 22px; height: 22px; border-radius: var(--radius-full); background: var(--sunken); color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--line); }
.me form { margin: 0 0 0 auto; }
.login { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sign-out .icon { width: 15px; height: 15px; }
.page { width: 100%; max-width: 1600px; margin-inline: auto; padding: var(--space-8) var(--space-8) 72px; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-5); align-content: start; min-width: 0; }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; min-height: 36px; margin-bottom: var(--space-1); }

/* Type */
h1 { font-size: var(--text-xl); line-height: 1.25; margin: 0; letter-spacing: -0.022em; font-weight: 600; overflow-wrap: anywhere; }
h2 { font-size: var(--text-lg); line-height: 1.35; margin: 0 0 var(--space-4); font-weight: 600; letter-spacing: -0.01em; }
h3 { font: 500 var(--text-xs)/1.4 var(--mono); margin: 0; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.06em; }
p { margin: 0 0 10px; color: var(--ink-2); }
.fine { font-size: var(--text-sm); color: var(--ink-3); margin: var(--space-3) 0 0; }
.muted { color: var(--ink-3); }
strong { color: var(--ink); font-weight: 600; }

/* Surfaces */
.panel, .card { border: 1px solid var(--line); border-radius: var(--radius-lg); padding: var(--space-5) var(--space-6); background: var(--surface); min-width: 0; }
.stack { display: grid; gap: var(--space-5); align-content: start; min-width: 0; }
.split { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--space-5); align-items: start; }

/* Stats */
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.stat { position: relative; display: grid; gap: 6px; padding: var(--space-4) var(--space-5) 18px; color: var(--ink); box-shadow: -1px 0 0 var(--line); transition: background-color var(--fast) var(--ease); }
a.stat:hover { background: var(--surface-2); text-decoration: none; }
a.stat::after { content: ""; position: absolute; top: 18px; right: 18px; width: 6px; height: 6px; border-top: 1.5px solid var(--ink-3); border-right: 1.5px solid var(--ink-3); transform: rotate(45deg); opacity: 0; transition: opacity var(--fast) var(--ease); }
a.stat:hover::after, a.stat:focus-visible::after { opacity: 1; }
a.stat:focus-visible { outline-offset: -2px; border-radius: 0; }
.stat-label { font-size: var(--text-sm); line-height: 1.4; color: var(--ink-3); }
.attention-stat .stat-value { color: var(--accent); }
.stat-value { font-size: var(--text-2xl); line-height: 1.1; font-weight: 500; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }

/* Overview: what needs a person, getting started, the side column */
.column { display: grid; gap: var(--space-5); align-content: start; min-width: 0; }
.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); }
.panel-head h2 { margin: 0; }
.panel-head .meta { flex: none; }
.attention-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.attention { display: flex; align-items: center; gap: var(--space-4); padding: 10px var(--space-4); border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); font-size: var(--text-md); color: var(--ink); box-shadow: inset 3px 0 0 var(--ink-3); }
.attention.bad { border-color: var(--bad-line); background: var(--bad-wash); box-shadow: inset 3px 0 0 var(--bad); }
.attention.warn { border-color: var(--warn-line); background: var(--warn-wash); box-shadow: inset 3px 0 0 var(--warn); }
.attention.info { box-shadow: inset 3px 0 0 var(--accent); }
.attention-text { flex: 1; min-width: 0; }
.attention-action { flex: none; font-weight: 600; white-space: nowrap; }
.segments { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 4px; }
.segments span { height: 4px; border-radius: var(--radius-full); background: var(--sunken); }
.segments span.done { background: var(--good); }
.setup-card .segments { margin-bottom: var(--space-3); }
.setup-steps { list-style: none; margin: 0; padding: 0; display: grid; }
.setup-steps li { display: flex; align-items: center; gap: var(--space-3); min-height: 44px; border-top: 1px solid var(--line-soft); color: var(--ink-3); }
.setup-steps li:first-child { border-top: 0; }
.setup-steps li.next { color: var(--ink); font-weight: 500; }
.setup-steps li.done .step-title { text-decoration: line-through; text-decoration-color: var(--line-strong); }
.setup-steps .step-title { flex: 1; min-width: 0; }
.setup-row { display: flex; align-items: center; gap: var(--space-4); padding: 10px var(--space-4); border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); color: var(--ink-2); font-size: var(--text-md); }
.setup-row:hover { background: var(--surface-2); text-decoration: none; }
.setup-row .segments { width: 96px; flex: none; }
.plan-card .panel-head h2 { font-size: var(--text-lg); }
.meters.stacked { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); margin: 0 0 var(--space-4); }
.plan-card > .button { width: 100%; justify-content: center; }
details.command { margin-top: var(--space-4); }
details.command > summary { cursor: pointer; font-size: var(--text-md); color: var(--ink-2); }
details.command[open] > summary { margin-bottom: var(--space-2); }
.copy-block { position: relative; }
.copy-block pre { padding-right: 72px; font-size: var(--text-sm); }
.copy-block button { position: absolute; top: 6px; right: 6px; }
.check { display: inline-grid; place-items: center; width: 20px; height: 20px; flex: none; border-radius: var(--radius-full); border: 1.5px dashed var(--line-strong); color: var(--surface); }
.done .check { background: var(--good); border: 0; }
.check .icon { width: 12px; height: 12px; stroke-width: 3; }

/* Agenda and activity */
.day { margin: var(--space-5) 0 var(--space-1); }
.day:first-of-type { margin-top: 0; }
.slots, .feed { list-style: none; margin: 0; padding: 0; }
.slot { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; gap: var(--space-3); align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line-soft); }
.slot:last-child { border-bottom: 0; }
.when { display: grid; font-weight: 600; font-size: var(--text-md); font-variant-numeric: tabular-nums; }
.until { font-weight: 400; font-size: var(--text-sm); color: var(--ink-3); }
.what { display: grid; min-width: 0; }
.title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.on { color: var(--ink-3); font-weight: 400; }
.meta { font-size: var(--text-sm); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feed { position: relative; }
.event { position: relative; display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: var(--space-3); align-items: start; padding: 7px 0; }
.event .title { font-weight: 400; color: var(--ink-2); white-space: normal; overflow-wrap: anywhere; }
.event .title strong { font-weight: 600; color: var(--ink); }
.event .when { font-size: var(--text-sm); font-weight: 400; color: var(--ink-3); white-space: nowrap; padding-top: 1px; }
.times { font-size: var(--text-sm); color: var(--ink-3); }
.event:not(:last-child)::before { content: ""; position: absolute; left: 5.5px; top: 22px; bottom: -8px; width: 1px; background: var(--line); }
.dot { position: relative; width: 12px; height: 12px; margin-top: 4px; border-radius: var(--radius-full); background: var(--surface); box-shadow: inset 0 0 0 3px var(--ink-3); }
.dot.good { box-shadow: inset 0 0 0 3px var(--good); }
.dot.bad { box-shadow: inset 0 0 0 3px var(--bad); }

/* Pills */
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); font-weight: 600; line-height: 18px; padding: 1px 8px 1px 7px; border-radius: var(--radius-full); background: var(--sunken); color: var(--ink-2); white-space: nowrap; box-shadow: inset 0 0 0 1px var(--line); }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: var(--radius-full); background: currentColor; opacity: 0.9; }
.pill.booking, .pill.active { background: var(--good-wash); color: var(--good); box-shadow: none; }
.pill.event { background: var(--accent-wash); color: var(--accent); box-shadow: none; }
.pill.held { background: var(--warn-wash); color: var(--warn); box-shadow: none; }
.pill.revoked, .pill.expired { background: transparent; color: var(--ink-3); }

/* Definition lists */
.endpoints { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2) var(--space-4); margin: var(--space-4) 0 0; align-items: center; }
.endpoints dt { font: 500 var(--text-xs)/1 var(--mono); color: var(--ink-3); letter-spacing: 0.06em; }
.endpoints dd { margin: 0; display: flex; align-items: center; gap: var(--space-2); min-width: 0; padding: 4px 4px 4px 12px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface-2); }
.endpoints code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--space-2) var(--space-6); margin: 0; }
.facts dt { color: var(--ink-3); }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.page > .facts { padding: var(--space-4) var(--space-6); border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); }

/* Forms */
label { display: grid; gap: 6px; font-size: var(--text-sm); font-weight: 500; color: var(--ink-2); min-width: 0; }
input, select, textarea { font: inherit; font-size: 14px; color: var(--ink); background-color: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--radius); min-width: 0; transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease); }
input, select { height: 36px; padding: 0 var(--space-3); }
input::placeholder, textarea::placeholder { color: var(--ink-3); opacity: 0.8; }
input:hover, select:hover, textarea:hover { border-color: var(--ink-3); }
input:focus, select:focus, textarea:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--ring); }
input[readonly] { background-color: var(--surface-2); }
select { -webkit-appearance: none; appearance: none; padding-right: 32px; cursor: pointer; background-image: linear-gradient(45deg, transparent 50%, var(--ink-3) 50%), linear-gradient(135deg, var(--ink-3) 50%, transparent 50%); background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }
input[type="checkbox"], input[type="radio"] { width: 16px; height: 16px; margin: 0; padding: 0; accent-color: var(--ink); flex: none; }
input[type="time"] { font-variant-numeric: tabular-nums; }
textarea { padding: 10px var(--space-3); resize: vertical; min-height: 72px; line-height: 1.5; }
.create { display: flex; flex-wrap: wrap; align-items: end; gap: var(--space-3); margin: 0; }
.create .grow { flex: 1 1 220px; }
label > input, label > select, label > .unit-input { width: 100%; }
label > textarea { width: 100%; padding: var(--space-2) var(--space-3); resize: vertical; }
label.choice > input { width: 16px; }
.create label:not(.grow) { flex: 0 1 auto; }
form > label { margin-bottom: var(--space-3); }
.create > label { margin-bottom: 0; }
.grid-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4) var(--space-3); margin-bottom: var(--space-4); align-items: end; }
.unit-input { display: flex; align-items: center; gap: var(--space-2); }
.unit-input input { width: 100%; }
.unit-input span { color: var(--ink-3); white-space: nowrap; }
.choice { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 400; color: var(--ink); cursor: pointer; }
form .choice { margin: var(--space-1) 0 var(--space-3); }
.modes { border: 0; padding: 0; margin: 0 0 var(--space-5); display: grid; gap: var(--space-2); }
.modes legend { font-weight: 600; color: var(--ink); padding: 0; margin-bottom: var(--space-2); }
.modes .choice { padding: 10px var(--space-3); border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); margin: 0; }
.modes .choice:has(input:checked) { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
.types { margin: var(--space-1) 0 var(--space-4); }
.types summary { cursor: pointer; color: var(--ink-2); font-size: var(--text-md); width: fit-content; }
.checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--space-2) var(--space-4); margin-top: var(--space-3); padding: var(--space-4); border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface-2); }
.checks .choice { font-size: var(--text-md); margin: 0; }
.choices { border: 0; padding: 0; margin: var(--space-4) 0; min-width: 0; }
.choices legend { font-size: var(--text-sm); font-weight: 500; color: var(--ink-2); padding: 0; }
.choices .checks { margin-top: 6px; }
.fine + .table, .fine + .empty { margin-top: var(--space-4); }
.pop label { margin-bottom: var(--space-3); }
.pop textarea { width: 100%; }
/* A team being deleted */
.deleting-banner { background: var(--bad-soft, var(--surface-2)); }
/* Sessions (Settings, Account) */
h2.sessions-head { margin-top: var(--space-6); }
/* Audit log */
form.audit-filter { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-2) var(--space-3); margin: 0 0 var(--space-4); }
form.audit-filter label { flex-basis: 100%; margin: 0; }
form.audit-filter select { width: auto; }
dl.audit-details { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: 0; font-size: var(--text-sm); }
dl.audit-details dt { color: var(--ink-2); }
dl.audit-details dd { margin: 0; overflow-wrap: anywhere; }
.pager, .audit-tools { display: flex; flex-wrap: wrap; gap: var(--space-4); margin-top: var(--space-4); }
.audit-tools { margin: 0 0 var(--space-4); }
/* Teams: one-line forms that create a team or invite to one */
form.create-team, form.invite { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-2) var(--space-3); margin: var(--space-5) 0; }
form.create-team label, form.invite label { flex-basis: 100%; margin: 0; }
form.create-team input, form.invite input { flex: 1 1 240px; min-width: 0; }
form.invite select { flex: 0 1 auto; width: auto; }
.team-workspaces .table + .table { margin-top: var(--space-4); }
.seats { margin: var(--space-4) 0; color: var(--ink-2); }
.pop fieldset { border: 0; padding: 0; margin: 0 0 var(--space-3); }
.pop legend { font-weight: 500; padding: 0; margin-bottom: var(--space-2); }
.pop fieldset label { display: flex; gap: var(--space-2); align-items: center; margin-bottom: var(--space-1); font-weight: 400; }

/* Buttons */
button, .button { font: inherit; font-size: var(--text-md); font-weight: 500; height: 36px; padding: 0 var(--space-4); border-radius: var(--radius); border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); white-space: nowrap; transition: background-color var(--fast) var(--ease), border-color var(--fast) var(--ease), color var(--fast) var(--ease), transform var(--fast) var(--ease); }
button:hover, .button:hover { background: var(--hover); border-color: var(--ink-3); text-decoration: none; }
button:active, .button:active { transform: translateY(0.5px); }
.primary, a.primary { background: var(--button); border-color: var(--button); color: var(--button-ink); }
.primary:hover, a.primary:hover { background: var(--button-hover); border-color: var(--button-hover); color: var(--button-ink); }
.wide { width: 100%; height: 42px; }
button.danger { background: var(--bad); border-color: var(--bad); color: var(--bad-ink); }
button.danger:hover { background: var(--bad); border-color: var(--bad); filter: brightness(1.08); }
button.quiet { height: 28px; padding: 0 var(--space-2); border: 0; background: none; color: var(--ink-3); font-weight: 500; font-size: var(--text-sm); }
button.quiet:hover { color: var(--ink); background: var(--hover); }
.row-actions, .action-buttons { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-top: var(--space-4); }
form.inline { display: inline; margin: 0; }

/* Tables */
.table { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); }
table { width: 100%; border-collapse: collapse; font-size: var(--text-md); }
th, td { text-align: left; padding: 11px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: middle; }
th:first-child, td:first-child { padding-left: var(--space-4); }
th:last-child, td:last-child { padding-right: var(--space-4); }
th { font: 500 var(--text-xs)/1.4 var(--mono); color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.06em; background: var(--surface-2); border-bottom-color: var(--line); white-space: nowrap; padding-top: 9px; padding-bottom: 9px; }
td { white-space: nowrap; color: var(--ink-2); font-variant-numeric: tabular-nums; }
tbody tr { transition: background-color var(--fast) var(--ease); }
tbody tr:hover { background: var(--surface-2); }
td.strong { color: var(--ink); font-weight: 500; white-space: normal; min-width: 140px; }
tr:last-child td { border-bottom: 0; }
td.wrap { white-space: normal; min-width: 160px; }
.truncate { display: block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.truncate.url { max-width: 340px; }
.truncate.id { max-width: 150px; }
.chip { display: inline-block; padding: 1px 6px; border-radius: var(--radius-sm); background: var(--sunken); color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--line); font-size: 12px; }
.cell { display: grid; justify-items: start; gap: 2px; min-width: 0; }
.cell > * { max-width: 100%; }
td .meta { display: block; margin-top: 2px; }
.meta-link { font-size: var(--text-sm); }
.wrap, td.wrap .meta, .meta.wrap { white-space: normal; overflow-wrap: anywhere; }
.actions { white-space: nowrap; text-align: right; width: 1%; }
.actions button { height: 28px; padding: 0 10px; font-size: var(--text-sm); }
td .meta.wrap { min-width: 200px; max-width: 340px; }
.week input { width: 100%; }
.week th[scope="row"] { font: 500 var(--text-md)/1.4 var(--font); text-transform: none; letter-spacing: 0; color: var(--ink); background: none; }
form > .table { margin-bottom: var(--space-3); }

/* Confirmations */
.act { display: inline-block; position: relative; margin-left: var(--space-1); text-align: left; }
.act summary { display: inline-flex; align-items: center; height: 28px; padding: 0 10px; border-radius: var(--radius-sm); cursor: pointer; color: var(--ink-2); font-weight: 500; font-size: var(--text-sm); list-style: none; transition: background-color var(--fast) var(--ease), color var(--fast) var(--ease); }
.act summary::-webkit-details-marker { display: none; }
.act summary:hover { background: var(--hover); color: var(--ink); }
.act[open] summary { background: var(--hover); color: var(--ink); }
.act.danger summary { color: var(--bad); }
.act.danger summary:hover, .act.danger[open] summary { background: var(--bad-wash); color: var(--bad); }
.pop { position: absolute; right: 0; z-index: 5; width: 280px; margin-top: 6px; padding: var(--space-4); border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--pop-shadow); white-space: normal; animation: pop-in var(--slow) var(--ease); transform-origin: top right; }
.pop p { font-size: var(--text-md); color: var(--ink); margin-bottom: var(--space-3); }
.pop button { width: 100%; }
.row-actions .pop { left: 0; right: auto; transform-origin: top left; }
/* In a table the confirmation opens in place, growing its row. .table scrolls (overflow-x: auto,
   which makes it clip both ways), so a floating .pop past its last row was cut off: Revoke on a
   one-key account opened nothing anyone could click. */
.table .pop { position: static; width: 280px; max-width: 100%; margin: var(--space-2) 0 var(--space-1) auto; box-shadow: none; text-align: left; }
@keyframes pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: none; } }

/* Notices and empty states */
.notice { display: block; border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-3) var(--space-4); background: var(--surface); color: var(--ink); margin: 0; font-size: var(--text-md); }
.notice[role="alert"] { border-color: var(--bad-line); background: var(--bad-wash); color: var(--ink); box-shadow: inset 3px 0 0 var(--bad); }
.meters { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-5) var(--space-6); margin: var(--space-4) 0; }
.meter { display: grid; gap: 6px; min-width: 0; }
.meter-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-2); font-size: var(--text-md); color: var(--ink-2); }
.meter-value { color: var(--ink); font-weight: 500; font-variant-numeric: tabular-nums; }
.meter progress { appearance: none; -webkit-appearance: none; width: 100%; height: 6px; border: 0; border-radius: var(--radius-full); background: var(--sunken); overflow: hidden; }
.meter progress::-webkit-progress-bar { background: var(--sunken); border-radius: var(--radius-full); }
.meter progress::-webkit-progress-value { background: var(--ink-2); border-radius: var(--radius-full); }
.meter progress::-moz-progress-bar { background: var(--ink-2); border-radius: var(--radius-full); }
.meter.warn progress::-webkit-progress-value { background: var(--warn); }
.meter.warn progress::-moz-progress-bar { background: var(--warn); }
.meter.bad progress::-webkit-progress-value { background: var(--bad); }
.meter.bad progress::-moz-progress-bar { background: var(--bad); }
.meter.bad .meter-value { color: var(--bad); }
.plan-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
.plan-head h2 { margin: 0; }
.notice.done { border-color: color-mix(in srgb, var(--good) 35%, var(--line)); background: var(--good-wash); color: var(--ink); box-shadow: inset 3px 0 0 var(--good); }
.notice.warn, .notice.warn[role="alert"] { border-color: var(--warn-line); background: var(--warn-wash); color: var(--warn); box-shadow: inset 3px 0 0 var(--warn); }
.notice p { color: inherit; margin: 0 0 var(--space-2); }
.empty { color: var(--ink-3); margin: 0; }
.empty-state { display: grid; justify-items: center; gap: var(--space-3); padding: var(--space-12) var(--space-6); border: 1px dashed var(--line-strong); border-radius: var(--radius-lg); text-align: center; }
.empty-state .empty { max-width: 380px; color: var(--ink-2); }
.empty-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: var(--radius); background: var(--surface); color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--line), 0 1px 2px rgba(0, 0, 0, 0.04); }
.empty-icon .icon { width: 20px; height: 20px; }

/* Shown once */
.once { max-width: 720px; padding: var(--space-8); display: grid; gap: var(--space-2); }
.once h2 { margin: var(--space-4) 0 0; font-size: var(--text-md); }
.once > .button { justify-self: start; margin-top: var(--space-3); }
.copy { display: flex; gap: var(--space-2); margin: var(--space-2) 0 var(--space-3); }
.copy input { flex: 1; }
pre { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-3) var(--space-4); margin: 0; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink); line-height: 1.6; }
.hours { margin: 0; padding-left: 18px; color: var(--ink-2); }
.back { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-3); font-size: var(--text-md); font-weight: 500; }
.back::before { content: ""; width: 6px; height: 6px; border-left: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); }
.back:hover { color: var(--ink); text-decoration: none; }
.page > p:has(> .back) { margin: 0 0 calc(-1 * var(--space-3)); }
.page > section:not([class]) { display: grid; gap: var(--space-3); }
.page > section:not([class]) > h1 { margin-bottom: var(--space-1); }

/* Signed out */
.bare { min-height: 100vh; }
.bare-bar { padding: var(--space-5) var(--space-6); }
.bare-main { display: grid; place-items: start center; padding: 10vh var(--space-4) var(--space-12); }
.sign-in { width: 100%; max-width: 400px; padding: var(--space-8); border: 1px solid var(--line); border-radius: 16px; background: var(--surface); display: grid; gap: var(--space-3); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03), 0 24px 48px -24px rgba(0, 0, 0, 0.12); }
.sign-in-mark { display: grid; place-items: center; width: 44px; height: 44px; margin-bottom: var(--space-2); border-radius: var(--radius-lg); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line); color: var(--ink); }
.sign-in-mark .mark { width: 24px; height: 22px; }
.sign-in h1 { font-size: 20px; }
.sign-in p { margin: 0; }
.sign-in .button { margin-top: var(--space-3); }
.bare-main > .notice { max-width: 480px; }

/* Assistant */

@media (max-width: 1080px) {
  .split { grid-template-columns: minmax(0, 1fr); }
  .page { padding: var(--space-6) var(--space-8) 64px; }
}
@media (max-width: 760px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .side { position: sticky; z-index: 4; top: 0; height: auto; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 var(--space-2); padding: 10px var(--space-4) 0; border-right: 0; border-bottom: 1px solid var(--line); background: var(--surface-2); }
  .side-top { grid-column: 1; display: flex; align-items: center; gap: var(--space-3); padding: 0; min-width: 0; }
  .side-top .brand .name { display: none; }
  .workspace { flex: 1; min-width: 0; padding: 3px 4px; }
  .workspace .avatar { display: none; }
  .environment { margin: 0; flex: none; }
  .me { grid-column: 2; grid-row: 1; margin: 0; padding: 0; border: 0; }
  .me-avatar, .me .login { display: none; }
  .sign-out { width: 36px; height: 36px; padding: 0; }
  .sign-out-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .nav { grid-column: 1 / -1; display: flex; gap: var(--space-1); overflow-x: auto; margin: var(--space-2) calc(-1 * var(--space-4)) 0; padding: 0 var(--space-4); scrollbar-width: none; scroll-padding: 0 var(--space-4); }
  .nav::-webkit-scrollbar { display: none; }
  .nav a { flex: none; height: 40px; padding: 0 10px; border-radius: 0; box-shadow: none; background: none; }
  .nav a:hover { background: none; }
  .nav a[aria-current="page"] { background: none; box-shadow: inset 0 -2px 0 var(--ink); }
  .page { padding: var(--space-5) var(--space-4) var(--space-12); gap: var(--space-4); }
  h1 { font-size: 20px; }
  .panel, .card { padding: var(--space-4); }
  .once { padding: var(--space-5); }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat { padding: 14px var(--space-4); box-shadow: -1px 0 0 var(--line), 0 -1px 0 var(--line); }
  .stat-value { font-size: 22px; }
  .attention { flex-wrap: wrap; gap: var(--space-1) var(--space-4); }
  .setup-row .segments { width: 56px; }
  .create > * { flex: 1 1 100%; }
  .create button { width: 100%; }
  .endpoints { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }
  .endpoints dd { margin-bottom: var(--space-2); }
  .endpoints code { white-space: normal; overflow-wrap: anywhere; }
  .facts { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .facts dd { margin-bottom: var(--space-2); }
  .table { border-radius: var(--radius-lg); }
  thead { display: none; }
  table, tbody, tr, td { display: block; }
  tr { border-bottom: 1px solid var(--line); padding: 10px 0; }
  tbody tr:hover { background: none; }
  tr:last-child { border-bottom: 0; }
  td { border: 0; padding: 3px var(--space-4); white-space: normal; }
  td[data-label] { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: var(--space-2); align-items: baseline; }
  td[data-label]::before { content: attr(data-label); font: 500 var(--text-xs)/1.6 var(--mono); color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.05em; }
  td.strong, td.wrap { min-width: 0; }
  td .meta.wrap { min-width: 0; max-width: none; }
  .truncate, .truncate.url, .truncate.id { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
  .week th[scope="row"] { display: block; padding: var(--space-2) var(--space-4) 0; }
  .actions { text-align: left; width: auto; padding-top: var(--space-2); }
  .act { margin: 0 var(--space-2) 0 0; }
  .actions form.inline { margin-right: var(--space-2); }
  .act:first-child, form.inline + .act { margin-left: 0; }
  .act summary { border: 1px solid var(--line-strong); height: 32px; }
  .act.danger summary { border-color: var(--bad-line); }
  .pop { left: 0; right: auto; width: min(300px, calc(100vw - 48px)); transform-origin: top left; }
  .table .pop { margin-left: 0; }
  .empty-state { padding: var(--space-8) var(--space-4); }
  .bare-main { padding-top: 6vh; }
  .sign-in { padding: var(--space-6); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; scroll-behavior: auto !important; }
}
@media (forced-colors: active) {
  .pill, .chip, .nav a[aria-current="page"] { border: 1px solid CanvasText; }
}
`;

/** A composite the store refused, in a person's words. */
const COMPOSITE_PROBLEMS: Readonly<Record<string, string>> = Object.freeze({
  parent_not_found: 'That is not one of your resources.',
  composite_too_deep: 'A part has no parts of its own, and a whole is no part: choose a resource that stands alone.',
  composite_parts_limit: 'A whole has at most 50 parts.',
  composite_busy: 'One of them has a booking or hold still to come. A composite changes only while neither does.',
});

/** What the Usage page calls each plan. */
const PLAN_NAMES: Readonly<Record<SlotlockPlan, string>> = Object.freeze({ free: 'Free', developer: 'Developer', team: 'Team' });

const DASHBOARD_ASSETS = Object.freeze({
  css: DASHBOARD_CSS + SLOTLOCK_ASSISTANT_CSS + SLOTLOCK_SETTINGS_CSS,
  // The chat's script renders a reply with the server's own Markdown renderer, embedded.
  js: DASHBOARD_JS + slotlockAssistantScript(renderSlotlockMarkdown.toString()),
});

const ASSET_VERSIONS = Object.freeze({
  css: createHash('sha256').update(DASHBOARD_ASSETS.css).digest('base64url').slice(0, 12),
  js: createHash('sha256').update(DASHBOARD_ASSETS.js).digest('base64url').slice(0, 12),
  icon: createHash('sha256').update(SLOTLOCK_DASHBOARD_ICON_SVG).digest('base64url').slice(0, 12),
});
