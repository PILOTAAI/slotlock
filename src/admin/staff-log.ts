// The staff log as people read it (RFC 0006, 4.4): each action in words, from one map, with its code
// kept for whoever needs it; who did it by their login, or "Command line" for a deployment-role
// command; and the filters the Staff log page takes from its query. The log itself, and its hash
// chain, are the database's (staff-ddl.ts): nothing here changes what is recorded.
import { SLOTLOCK_STAFF_REF_PATTERN, SLOTLOCK_STAFF_VIEW_ACTION_PATTERN } from '../staff-ddl.js';

/** Every action the staff log records, in words. A code missing here is shown in words made from it. */
export const SLOTLOCK_STAFF_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  // Signing in and staff
  'staff.signed_in': 'Signed in',
  'staff.sign_in_refused': 'Sign-in refused: not staff',
  'staff.signed_out': 'Signed out',
  'staff.passkey_added': 'Added a passkey',
  'staff.passkey_verified': 'Signed in with a passkey',
  'staff.passkey_refused': 'Passkey refused',
  'staff.passkeys_reset': 'Reset a member’s passkeys',
  'staff.added': 'Added a staff member',
  'staff.readded': 'Added a staff member again',
  'staff.role_changed': 'Changed a staff member’s role',
  'staff.removed': 'Removed a staff member',
  'staff.console_key_set': 'Set the console’s key',
  'staff.list_viewed': 'Opened Staff',
  // Pages and searches
  'home.viewed': 'Opened Home',
  'page.viewed': 'Opened a page',
  'page.refused': 'Opened a page their role does not allow',
  'search.github_lookup': 'Asked GitHub which account a login is',
  'accounts.searched': 'Searched accounts',
  'usage.viewed': 'Opened Usage',
  'usage.accounts_listed': 'Listed the accounts using most',
  'system.viewed': 'Opened System',
  'partners.viewed': 'Opened partners',
  // An account
  'account.viewed': 'Opened an account',
  'account.not_found': 'Looked for an account that does not exist',
  'account.keys_viewed': 'Opened an account’s API keys',
  'account.usage_viewed': 'Opened an account’s use',
  'account.audit_viewed': 'Opened an account’s audit log',
  'account.sessions_viewed': 'Opened an account’s dashboard sessions',
  'account.notes_viewed': 'Opened an account’s notes',
  'account.overrides_viewed': 'Opened an account’s plan overrides',
  'account.note_added': 'Added a note to an account',
  'account.key_revoked': 'Revoked an API key',
  'account.sessions_ended': 'Signed an account out',
  'account.suspended': 'Suspended an account',
  'account.unsuspended': 'Lifted a suspension',
  'account.erased': 'Erased an account',
  // Cases
  'cases.listed': 'Listed cases',
  'case.viewed': 'Opened a case',
  'case.not_found': 'Looked for a case that does not exist',
  'case.opened': 'Opened a case about an account',
  'case.updated': 'Updated a case',
  'case.closed': 'Closed a case',
  'case.reopened': 'Reopened a case',
  // Billing and plans
  'billing.viewed': 'Opened Billing',
  'billing.alerts_listed': 'Listed billing alerts',
  'billing.alert_resolved': 'Resolved a billing alert',
  'overrides.listed': 'Listed plan overrides',
  'override.given': 'Gave a plan override',
  'override.requested': 'Asked for a plan override',
  'override.approved': 'Approved a plan override',
  'override.approval_refused': 'Approval of a plan override refused',
  'override.ended': 'Ended a plan override',
  'override.withdrawn': 'Withdrew a plan override',
  'plan.default_set': 'Set the default plan',
  'plan.default_removed': 'Removed the default plan',
  'export.created': 'Started an export',
  // Privacy
  'privacy.listed': 'Listed privacy requests',
  'privacy.viewed': 'Opened a privacy request',
  'privacy.opened': 'Logged a privacy request',
  'privacy.verified': 'Verified who sent a privacy request',
  'privacy.verification_failed': 'Could not verify who sent a privacy request',
  'privacy.export_started': 'Started a privacy export',
  'privacy.export_refused': 'Privacy export refused',
  'privacy.erasure_asked': 'Asked for an erasure',
  'privacy.erasure_approved': 'Approved an erasure',
  'privacy.erasure_approval_refused': 'Approval of an erasure refused',
  'privacy.erasure_refused': 'Erasure refused',
  'privacy.erased': 'Erased an account for a privacy request',
  'privacy.closed': 'Closed a privacy request',
  'privacy.receipts_checked': 'Checked erasure receipts',
  // Content
  'content.saved': 'Saved a post',
  'content.submitted': 'Submitted a post for review',
  'content.image_added': 'Added an image to a post',
  'content.image_removed': 'Removed an image from a post',
  'content.renamed': 'Renamed a post',
  'content.discarded': 'Discarded a draft',
  'content.published': 'Published a post',
  'content.scheduled': 'Scheduled a post',
  'content.unscheduled': 'Unscheduled a post',
  'content.updated': 'Updated a published post',
  // Communications and system
  'announcement.list_viewed': 'Opened Communications',
  'announcement.created': 'Made an announcement',
  'announcement.ended': 'Ended an announcement',
  'flag.list_viewed': 'Opened feature flags',
  'flag.set': 'Turned a feature on or off',
  'flag.cleared': 'Removed a feature setting',
  'status.opened': 'Opened an incident on the status page',
  'status.updated': 'Posted an incident update',
  'status.closed': 'Closed an incident',
});

const VIEW = new RegExp(SLOTLOCK_STAFF_VIEW_ACTION_PATTERN);
const ACTION = /^[a-z][a-z_]{0,31}(\.[a-z][a-z_]{0,31}){1,2}$/;
const STAFF_REF = new RegExp(SLOTLOCK_STAFF_REF_PATTERN);
const CLI_REF = /^cli:[a-z_][a-z0-9_.-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether an action only read something (a page or list opened, a search): hidden unless asked. */
export function slotlockStaffActionIsView(code: string): boolean {
  return VIEW.test(code);
}

/** An action in words: from the map, else made from its code ("billing.alert_resolved": "Billing: alert resolved"). */
export function slotlockStaffActionLabel(code: string): string {
  const known = Object.hasOwn(SLOTLOCK_STAFF_ACTION_LABELS, code) ? SLOTLOCK_STAFF_ACTION_LABELS[code] : undefined;
  if (known) return known;
  const [area = '', ...rest] = code.split('.');
  const words = rest.join(' ').replaceAll('_', ' ');
  return `${area.charAt(0).toUpperCase()}${area.slice(1).replaceAll('_', ' ')}${words ? `: ${words}` : ''}`;
}

/** Who did it: a member's login (else their reference), or "Command line" for `cli:<user>`. */
export function slotlockStaffActor(ref: string, login: string | null | undefined): { name: string; command: boolean } {
  if (ref.startsWith('cli:')) return { name: 'Command line', command: true };
  return { name: login || ref, command: false };
}

/** What the Staff log page is narrowed to, from its query; anything that is not one is left out. */
export interface SlotlockStaffLogFilters {
  /** A member's reference, or 'cli' for every deployment-role command. */
  who: string | null;
  action: string | null;
  account: string | null;
  /** UTC days, YYYY-MM-DD, both included. */
  from: string | null;
  to: string | null;
  views: boolean;
}

const validDay = (value: string | null) => {
  if (!value || !DAY.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value ? null : value;
};

export function slotlockStaffLogFilters(query: URLSearchParams): SlotlockStaffLogFilters {
  const who = query.get('who') ?? '';
  const action = query.get('action') ?? '';
  const account = (query.get('account') ?? '').trim();
  return {
    who: who === 'cli' || STAFF_REF.test(who) || CLI_REF.test(who) ? who : null,
    action: ACTION.test(action) ? action : null,
    account: account && account.length <= 500 && !/\p{Cc}/u.test(account) ? account : null,
    from: validDay(query.get('from')),
    to: validDay(query.get('to')),
    views: query.get('views') === '1',
  };
}

/** The filters as the database takes them: [since, until) in time. */
export function slotlockStaffLogRange(filters: SlotlockStaffLogFilters): { since: Date | null; until: Date | null } {
  return {
    since: filters.from ? new Date(`${filters.from}T00:00:00Z`) : null,
    until: filters.to ? new Date(Date.parse(`${filters.to}T00:00:00Z`) + 86_400_000) : null,
  };
}

/** The filters as a query, for links that keep them (the next page, the views switch). */
export function slotlockStaffLogQuery(filters: SlotlockStaffLogFilters, extra: Record<string, string> = {}): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.who) query.set('who', filters.who);
  if (filters.action) query.set('action', filters.action);
  if (filters.account) query.set('account', filters.account);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  if (filters.views) query.set('views', '1');
  for (const [name, value] of Object.entries(extra)) query.set(name, value);
  return query;
}
