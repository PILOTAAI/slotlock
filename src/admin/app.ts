// The admin console (docs/rfc/0006-admin-console.md, Phase 1): who runs Slotlock Cloud finds any
// account and sees its plan, use, keys and audit log, and the Owner sees the staff and their log.
//
// Three locks, each enough to stop someone the one before let through (RFC 0006, 4.2):
//   1. Cloudflare Access in front of the hostname; the console checks its JWT on every request.
//   2. GitHub sign-in (state and PKCE, no scope), mapped to an active staff member by the database.
//   3. A passkey (WebAuthn, user verification required) before any page with data.
// The session is an HMAC-sealed __Host- cookie: 8 hours at most, 30 minutes idle. Every POST checks
// the Origin header and a token bound to the session. Every read goes through an admin function,
// which checks the staff role again in the database and records the call in the staff log; the
// console's role can read no table (staff-ddl.ts).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { SLOTLOCK_PLAN_LIMITS, SLOTLOCK_PLAN_QUOTAS, type SlotlockPlan } from '../plans.js';
import {
  SLOTLOCK_CASE_ACTIONS,
  SLOTLOCK_OVERRIDE_SOLO_DAYS,
  SLOTLOCK_PRIVACY_CONCERNS,
  SLOTLOCK_PRIVACY_EXPORT_DAYS,
  SLOTLOCK_PRIVACY_KINDS,
  SLOTLOCK_STAFF_RECORD_YEARS,
  SLOTLOCK_STAFF_NOTE_MAX,
  SLOTLOCK_STAFF_ROLES,
  SLOTLOCK_ANNOUNCEMENT_AUDIENCES,
  SLOTLOCK_ANNOUNCEMENT_KINDS,
  SLOTLOCK_FEATURE_FLAGS,
  SLOTLOCK_STAFF_PLANS,
  type SlotlockContentStep,
  type SlotlockStaffCapability,
  type SlotlockStaffRole,
  slotlockStaffMay,
} from '../staff-ddl.js';
import type { SlotlockAccessIdentity } from './access.js';
import { SLOTLOCK_ADMIN_EDITOR_JS, type SlotlockCmsRequest, createSlotlockAdminCms } from './cms.js';
import { type SlotlockCmsGitHub, createSlotlockCmsGitHub } from './github-app.js';
import { type SlotlockAdminInsightsOptions, createSlotlockAdminInsights } from './insights.js';
import {
  type SlotlockAnnouncementRow,
  type SlotlockFlagsData,
  type SlotlockHostHealth,
  type SlotlockProviderRead,
  type SlotlockSystemData,
  slotlockCommunicationsPage,
  slotlockSitePage,
  slotlockSystemPage,
} from './system.js';
import {
  base64urlDecode,
  base64urlEncode,
  createSlotlockPasskeyChallenge,
  verifySlotlockPasskeyAssertion,
  verifySlotlockPasskeyRegistration,
} from './webauthn.js';
import {
  type SlotlockStripeCustomer,
  type SlotlockStripeRevenue,
  createSlotlockAdminStripe,
  slotlockMoney,
} from './stripe.js';
import {
  Html,
  SLOTLOCK_ADMIN_CSS,
  SLOTLOCK_ADMIN_JS,
  SLOTLOCK_ADMIN_PASSKEY_JS,
  bars,
  count,
  day,
  html,
  layout,
  pageHead,
  pill,
  plainPage,
  stats,
  table,
  when,
} from './ui.js';

export interface SlotlockAdminOptions {
  /** The database client for this request, connected as the console's role (slotlock_admin_app). */
  sql: () => Sql;
  /** The console's own origin, https://admin.slotlock.pylota.io: OAuth callback, cookies, passkeys. */
  publicUrl: string;
  /** 32+ random characters; seals sessions and the sign-in in progress. */
  sessionSecret: string;
  /**
   * The console's key (`slotlock staff console-key`): the database opens a staff session only for
   * a caller that shows it, so the console's database credential alone acts as no one.
   */
  consoleKey: string;
  github: { clientId: string; clientSecret: string };
  /**
   * Cloudflare Access (createSlotlockAccessVerifier). Null only with `insecureWithoutAccess`, for a
   * test or a console on localhost; the Worker always passes one.
   */
  access: { verify(request: Request): Promise<SlotlockAccessIdentity | null> } | null;
  insecureWithoutAccess?: boolean;
  /** Reads GitHub's public profiles (logins by id and back); a token raises GitHub's rate limit. */
  githubToken?: string;
  /**
   * A restricted Stripe key that reads subscriptions and invoices (RFC 0006, 4.6): revenue on the
   * Billing page and a customer's subscriptions on the account page. Without it those parts say so.
   */
  stripeKey?: string;
  /**
   * The CMS (RFC 0006, 4.5): the release app, installed on the site's repository only, with a key
   * of the console's own. Without it the Content pages say what to set.
   */
  cms?: {
    /** The App's Client ID, or its numeric App ID. */
    appId: string;
    /** The App's private key, PEM (PKCS#1 as GitHub gives it, or PKCS#8). */
    privateKey: string;
    /** Its installation on the repository; found through GitHub when not given. */
    installationId?: string;
    /** owner/name, e.g. PILOTAAI/slotlock. */
    repository: string;
    /** The live site, for the editor's link check and facts. Default https://slotlock.pylota.io. */
    siteUrl?: string;
    /** The preview Worker's workers.dev host: each CMS pull request is at https://pr-<n>-<host>/. */
    previewHost?: string;
  };
  /**
   * The site's search and visits (RFC 0006, M9): Search Console, Bing Webmaster Tools and Cloudflare
   * Web Analytics, each read-only and optional. Without one, its part of the Site page says what to set.
   */
  insights?: Omit<SlotlockAdminInsightsOptions, 'fetch' | 'now'>;
  /**
   * The hosts the System page asks (M11): the API's /healthz and the dashboard. Default hosted
   * Slotlock's, as the status probe checks them (docs/hosted/status.md).
   */
  hosts?: { api?: string; dashboard?: string };
  fetch?: typeof fetch;
  now?: () => number;
}

export interface SlotlockAdmin {
  fetch(request: Request): Promise<Response>;
}

const SESSION_COOKIE = '__Host-slotlock-admin';
const OAUTH_COOKIE = '__Host-slotlock-admin-oauth';
const PASSKEY_COOKIE = '__Host-slotlock-admin-passkey';
/** What an action just did, for the page it went back to: a notice shows only with it. */
const NOTICE_COOKIE = '__Host-slotlock-admin-notice';
const SESSION_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
/** A passkey sign-in this recent lets a member register another passkey. */
const FRESH_MS = 15 * 60 * 1000;
const PAGE = 50;
const GITHUB_CACHE_MS = 60 * 60 * 1000;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** A person's account, whose dashboard sessions staff can see and end. */
const PERSON_REF = /^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255}|sso:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A staff session's token, as slotlock.admin_sign_in makes it. */
const SESSION_TOKEN = /^stf_[0-9a-f]{64}$/;
/** A page the passkey step may send the browser back to: this console's own path, never another site. */
const LOCAL_PATH = /^\/(?![/\\])[^\s]*$/;

interface Notice {
  kind: 'done' | 'warn';
  text: string;
}

/** What an action did, by the code it returns with (?done= or ?error=). */
const NOTICES: Readonly<Record<string, Notice>> = Object.freeze({
  suspended: { kind: 'done', text: 'Suspended. From its next request it changes nothing and its keys are refused.' },
  already_suspended: { kind: 'warn', text: 'It was suspended already. Nothing changed.' },
  unsuspended: { kind: 'done', text: 'Suspension lifted. It can write again, and its keys work.' },
  not_suspended: { kind: 'warn', text: 'It was not suspended. Nothing changed.' },
  key_revoked: { kind: 'done', text: 'Key revoked. Its next request is refused.' },
  key_unchanged: { kind: 'warn', text: "That key was revoked already, or is not this account's." },
  announced: { kind: 'done', text: 'Announced. It shows above every page of the dashboard while it runs.' },
  announcement_ended: { kind: 'done', text: 'Ended. It has left every dashboard.' },
  announcement_unchanged: { kind: 'warn', text: 'That announcement had ended or run out already.' },
  announcement_invalid: { kind: 'warn', text: 'Nothing was announced: check the account, plan, message, link and times (it must end in the future, within 90 days of its start).' },
  flag_set: { kind: 'done', text: 'Flag set. The dashboard follows it from its next page.' },
  flag_cleared: { kind: 'done', text: 'Flag removed. The plan, or the deployment, decides again.' },
  flag_unchanged: { kind: 'warn', text: 'That flag was removed already.' },
  flag_invalid: { kind: 'warn', text: 'Nothing changed: choose a plan or give one live account (not both), and a reason.' },
  incident_opened: { kind: 'done', text: 'Incident opened on the status page.' },
  incident_updated: { kind: 'done', text: 'Update posted on the status page.' },
  incident_closed: { kind: 'done', text: 'Update posted and the incident closed.' },
  incident_unchanged: { kind: 'warn', text: 'That is not an open incident on the status page. Nothing was posted.' },
  incident_invalid: { kind: 'warn', text: 'Nothing was posted: an incident needs a title of up to 120 characters and a text of up to 2,000.' },
  status_unavailable: { kind: 'warn', text: 'The status page needs the Slotlock CMS GitHub App with Issues (read and write).' },
  sessions_ended: { kind: 'done', text: 'Signed out.' },
  session_gone: { kind: 'warn', text: 'That session had ended already.' },
  note_added: { kind: 'done', text: 'Note added.' },
  case_opened: { kind: 'done', text: 'Case opened.' },
  case_updated: { kind: 'done', text: 'Case saved.' },
  invalid: { kind: 'warn', text: 'Check the form: a reason is 1 to 200 characters on one line, and every required field is filled.' },
  override_given: { kind: 'done', text: 'Override in force. The account is held to it from its next request.' },
  override_requested: { kind: 'done', text: 'Override asked for. It takes effect when another Owner approves it.' },
  override_needs_owner: { kind: 'warn', text: 'An override longer than 90 days needs an Owner to ask, and another Owner to approve.' },
  override_approved: { kind: 'done', text: 'Override approved. It is in force.' },
  override_own: { kind: 'warn', text: 'You asked for this override, so another Owner has to approve it.' },
  override_not_pending: { kind: 'warn', text: 'That override is not waiting for approval any more.' },
  override_ended: { kind: 'done', text: 'Override ended. The account is back on its own plan.' },
  override_unchanged: { kind: 'warn', text: 'That override had ended already.' },
  alert_resolved: { kind: 'done', text: 'Alert resolved.' },
  alert_unchanged: { kind: 'warn', text: 'That alert was resolved already.' },
  privacy_opened: { kind: 'done', text: 'Request logged. Reply with the word below, and ask the account holder to make an API key with it as its name.' },
  privacy_verified: { kind: 'done', text: 'Verified: the account holder made a key named with the word after the request arrived.' },
  privacy_not_verified: { kind: 'warn', text: 'No key named with the word yet, made by the account holder since the request arrived. Check again when they reply.' },
  privacy_needs_verifying: { kind: 'warn', text: 'Verify the request first: it has to be shown to come from the account holder.' },
  privacy_export_started: { kind: 'done', text: `Export started. The next maintenance pass builds it, within the hour, and it waits on the account's Privacy page for ${SLOTLOCK_PRIVACY_EXPORT_DAYS} days.` },
  privacy_export_busy: { kind: 'warn', text: 'An export of this account is being built already. Start this one once it is ready.' },
  privacy_export_limit: { kind: 'warn', text: 'The account keeps five exports already. Its holder deletes one, or one expires first.' },
  privacy_erasure_asked: { kind: 'done', text: 'Erasure asked for. Another Owner approves it next.' },
  privacy_erasure_approved: { kind: 'done', text: 'Erasure approved. It can be carried out once the Stripe subscription is not live.' },
  privacy_erasure_own: { kind: 'warn', text: 'You asked for this erasure, so another Owner approves it.' },
  privacy_not_approved: { kind: 'warn', text: "An erasure needs a second Owner's approval first." },
  privacy_subscription_live: { kind: 'warn', text: "The account's Stripe subscription is still live. Cancel it in Stripe first; its webhook records that within a minute." },
  privacy_erased: { kind: 'done', text: 'Erased. The receipt below is all that stays of the account here.' },
  privacy_closed: { kind: 'done', text: 'Request closed.' },
  privacy_unchanged: { kind: 'warn', text: 'That request is closed already, or that step is not one it has.' },
  privacy_invalid: { kind: 'warn', text: 'Check the form: the account must exist, the date be today or earlier, and the reference and outcome one line each with no email address.' },
});

const PRIVACY_KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  access: 'A copy of their data',
  export: 'Their data to take elsewhere',
  correction: 'A correction',
  erasure: 'Erasure',
  other: 'Something else',
});
const PRIVACY_STATUS_WORDS: Readonly<Record<string, string>> = Object.freeze({
  open: 'Open',
  done: 'Done',
  refused: 'Refused',
  withdrawn: 'Withdrawn',
  passed_on: 'Passed on',
});

const PLANS: readonly SlotlockPlan[] = ['free', 'developer', 'team'];
const DAY_MS = 86_400_000;

/** What was done about a case, in words. */
const CASE_ACTION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  none: 'Nothing yet',
  warned: 'Warned',
  keys_revoked: 'Keys revoked',
  suspended: 'Suspended',
  other: 'Other',
});

interface OverrideRow {
  id: string;
  plan: string | null;
  max_resources: number;
  max_api_keys: number;
  max_webhook_endpoints: number;
  quota_operations: string | null;
  quota_bookings: string | null;
  quota_stop_percent: number | null;
  starts_at: Date;
  ends_at: Date;
  reason: string;
  created_by: string;
  approved_by: string | null;
  ended_by: string | null;
  ended_at: Date | null;
  state: string;
}

interface CaseRow {
  id: string;
  account_ref: string | null;
  source: string;
  summary: string;
  policy_section: string | null;
  action_taken: string;
  status: string;
  opened_by: string;
  opened_at: Date;
  updated_at: Date;
}

interface Session {
  /** staff_ref: github:<id> */
  s: string;
  /**
   * The database's session token (slotlock.admin_sign_in): every admin function takes it, and the
   * database, not this cookie, says who it is and whether it still holds.
   */
  t: string;
  /** GitHub login, shown in the console only (never stored in the database). */
  l: string;
  r: SlotlockStaffRole;
  /** 'github' after GitHub, 'full' after a passkey. */
  st: 'github' | 'full';
  iat: number;
  seen: number;
  /** When the last passkey sign-in happened. */
  pv?: number;
  exp: number;
}

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'",
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Robots-Tag': 'noindex, nofollow',
};

export function createSlotlockAdmin(options: SlotlockAdminOptions): SlotlockAdmin {
  const origin = new URL(options.publicUrl).origin;
  const rpId = new URL(options.publicUrl).hostname;
  if (options.sessionSecret.length < 32) throw new Error('SLOTLOCK_ADMIN_SESSION_SECRET must be 32+ characters');
  if (typeof options.consoleKey !== 'string' || options.consoleKey.length < 32 || options.consoleKey.length > 200) {
    throw new Error('SLOTLOCK_ADMIN_CONSOLE_KEY must be the key `slotlock staff console-key` printed');
  }
  if (options.consoleKey === options.sessionSecret) {
    throw new Error('SLOTLOCK_ADMIN_CONSOLE_KEY must not be the session secret');
  }
  if (options.access === null && !options.insecureWithoutAccess) {
    throw new Error('the admin console needs Cloudflare Access (SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN and SLOTLOCK_ADMIN_ACCESS_AUD)');
  }
  const now = options.now ?? (() => Date.now());
  const fetcher = options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const githubCache = new Map<string, { value: { id: string; login: string; type: string } | null; until: number }>();
  /** The release app: the CMS, the status page's incidents and the deploy history. */
  const github: SlotlockCmsGitHub | null = options.cms
    ? createSlotlockCmsGitHub({
        appId: options.cms.appId,
        privateKey: options.cms.privateKey,
        ...(options.cms.installationId ? { installationId: options.cms.installationId } : {}),
        repository: options.cms.repository,
        fetch: fetcher,
        now,
      })
    : null;
  const cms = createSlotlockAdminCms({
    github,
    siteUrl: options.cms?.siteUrl ?? 'https://slotlock.pylota.io',
    ...(options.cms?.previewHost ? { previewHost: options.cms.previewHost } : {}),
    fetch: fetcher,
    now,
  });

  // ---------- Sealed cookies ----------
  const mac = (context: string, body: string) =>
    createHmac('sha256', options.sessionSecret).update(`${context}.${body}`).digest('base64url');
  function seal(context: string, payload: object): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${mac(context, body)}`;
  }
  function unseal<T extends { exp: number }>(context: string, value: string | undefined): T | null {
    if (!value || value.length > 4096) return null;
    const [body, given, ...rest] = value.split('.');
    if (!body || !given || rest.length > 0 || !BASE64URL.test(body) || !BASE64URL.test(given)) return null;
    const expected = Buffer.from(mac(context, body));
    const provided = Buffer.from(given);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
      return typeof payload.exp === 'number' && payload.exp > now() ? payload : null;
    } catch {
      return null;
    }
  }
  const cookie = (name: string, value: string, maxAgeSeconds: number) =>
    `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  const clear = (name: string) => `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
  function cookies(request: Request): Map<string, string> {
    const out = new Map<string, string>();
    for (const part of (request.headers.get('cookie') ?? '').split(';')) {
      const index = part.indexOf('=');
      if (index > 0) out.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
    }
    return out;
  }
  const csrfOf = (session: Session) => mac('csrf', `${session.s}.${session.iat}`);

  function readSession(request: Request): Session | null {
    const session = unseal<Session>('session', cookies(request).get(SESSION_COOKIE));
    if (!session || !(SLOTLOCK_STAFF_ROLES as readonly string[]).includes(session.r)) return null;
    if (typeof session.t !== 'string' || !SESSION_TOKEN.test(session.t)) return null;
    if (now() - session.seen > IDLE_MS) return null;
    return session;
  }
  const noticeCookie = (to: string, code: string) =>
    cookie(NOTICE_COOKIE, seal('notice', { c: code, p: new URL(to, origin).pathname, exp: now() + 60_000 }), 60);
  const sessionCookie = (session: Session) =>
    cookie(SESSION_COOKIE, seal('session', { ...session, seen: now() }), Math.ceil((session.exp - now()) / 1000));

  // ---------- Responses ----------
  function respond(body: string | Html, status = 200, headers: Record<string, string> = {}, type = 'text/html; charset=utf-8'): Response {
    return new Response(typeof body === 'string' ? body : body.value, {
      status,
      headers: { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...headers },
    });
  }
  const redirect = (location: string, setCookies: string[] = []) => {
    const response = new Response(null, { status: 303, headers: { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'no-store' } });
    for (const value of setCookies) response.headers.append('Set-Cookie', value);
    return response;
  };
  const json = (value: unknown, status = 200, setCookies: string[] = []) => {
    const response = respond(JSON.stringify(value), status, {}, 'application/json; charset=utf-8');
    for (const value of setCookies) response.headers.append('Set-Cookie', value);
    return response;
  };
  const refused = (title: string, text: string, status = 403) =>
    respond(plainPage(title, html`<h1>${title}</h1><p>${text}</p>`), status);

  // ---------- Database ----------
  async function record(staff: string, action: string, account: string | null = null, target: string | null = null, metadata: object = {}) {
    const sql = options.sql();
    await sql`SELECT slotlock.admin_record(${staff}, ${action}, ${account}, ${target}, ${null}, ${sql.json(metadata as never)})`;
  }

  // ---------- GitHub ----------
  async function githubProfile(path: string): Promise<{ id: string; login: string; type: string } | null> {
    const cached = githubCache.get(path);
    if (cached && cached.until > now()) return cached.value;
    let value: { id: string; login: string; type: string } | null = null;
    try {
      const response = await fetcher(`https://api.github.com${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'slotlock-admin',
          ...(options.githubToken ? { Authorization: `Bearer ${options.githubToken}` } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      // Only "no such account" is kept for the hour; a slow, limited or failing GitHub is asked
      // again in a minute.
      if (!response.ok && response.status !== 404) {
        githubCache.set(path, { value: null, until: now() + 60_000 });
        return null;
      }
      if (response.ok) {
        const body = (await response.json()) as { id?: unknown; login?: unknown; type?: unknown };
        if (typeof body.id === 'number' && typeof body.login === 'string') {
          value = { id: String(body.id), login: body.login, type: typeof body.type === 'string' ? body.type : 'User' };
        }
      }
    } catch {
      // No answer in time: asked again in a minute, never kept as "no such account".
      githubCache.set(path, { value: null, until: now() + 60_000 });
      return null;
    }
    if (githubCache.size > 2000) githubCache.clear();
    githubCache.set(path, { value, until: now() + GITHUB_CACHE_MS });
    return value;
  }
  const loginOf = async (ref: string) => {
    const id = /^(?:github|github-org):([1-9][0-9]{0,19})$/.exec(ref)?.[1];
    return id ? ((await githubProfile(`/user/${id}`))?.login ?? null) : null;
  };

  // ---------- Pages ----------
  const navFor = (session: Session) => [
    { href: '/', label: 'Home' },
    ...(slotlockStaffMay(session.r, 'accounts.read') ? [{ href: '/accounts', label: 'Accounts' }] : []),
    ...(slotlockStaffMay(session.r, 'billing.read') ? [{ href: '/billing', label: 'Billing' }] : []),
    ...(slotlockStaffMay(session.r, 'accounts.read') ? [{ href: '/usage', label: 'Usage' }] : []),
    ...(slotlockStaffMay(session.r, 'safety.act') ? [{ href: '/cases', label: 'Cases' }] : []),
    ...(slotlockStaffMay(session.r, 'privacy.act') ? [{ href: '/privacy', label: 'Privacy' }] : []),
    ...(slotlockStaffMay(session.r, 'content.write') ? [{ href: '/content', label: 'Content' }] : []),
    ...(slotlockStaffMay(session.r, 'site.read') ? [{ href: '/site', label: 'Site and search' }] : []),
    ...(slotlockStaffMay(session.r, 'system.read') ? [{ href: '/communications', label: 'Communications' }] : []),
    ...(slotlockStaffMay(session.r, 'system.read') ? [{ href: '/system', label: 'System' }] : []),
    ...(slotlockStaffMay(session.r, 'staff.read') ? [{ href: '/staff', label: 'Staff' }] : []),
    ...(slotlockStaffMay(session.r, 'staff.log') ? [{ href: '/staff/log', label: 'Staff log' }] : []),
  ];
  const shellOf = (session: Session, title: string, path: string, query?: string, notice?: Notice) => ({
    title,
    path,
    nav: navFor(session),
    staff: { login: session.l, role: session.r },
    csrf: csrfOf(session),
    ...(query !== undefined ? { query } : {}),
    ...(notice ? { notice } : {}),
  });
  const page = (session: Session, title: string, path: string, body: Html, query?: string, notice?: Notice) =>
    respond(layout(shellOf(session, title, path, query, notice), body), 200, { 'Set-Cookie': sessionCookie(session) });
  /** What an action did, from the page it went back to: a fixed text per outcome, never the query's words. */
  const noticeOf = (url: URL): Notice | undefined => {
    const code = url.searchParams.get('done') ?? url.searchParams.get('error');
    return code && Object.hasOwn(NOTICES, code) ? NOTICES[code] : undefined;
  };
  /** GitHub logins for staff references (github:<id>); a cli:<user> stays as it is. */
  const staffNames = async (refs: readonly string[]) => {
    // Each member looked up once, however many rows name them.
    const unique = [...new Set(refs)];
    const names = new Map(await Promise.all(unique.map(async (ref) => [ref, ref.startsWith('github:') ? ((await loginOf(ref)) ?? ref) : ref] as const)));
    return refs.map((ref) => names.get(ref) ?? ref);
  };

  const kindPill = (kind: string) => pill(kind, kind === 'test' ? 'warn' : 'muted');
  const planPill = (plan: string | null) =>
    pill(plan ?? 'free', plan === 'team' ? 'good' : plan === 'developer' ? 'info' : 'muted');
  const statusPill = (suspended: boolean, planStatus: string | null) =>
    suspended ? pill('Suspended', 'bad') : planStatus === 'past_due' ? pill('Past due', 'warn') : pill('Active', 'good');
  const accountHref = (ref: string) => `/accounts/${encodeURIComponent(ref)}`;

  /**
   * Maintenance on Home (RFC 0006, M11): accounts whose pass failed and has not run since, and a
   * server that stopped recording its hours. Only staff who open the System page get the link.
   */
  function maintenanceAttention(session: Session, failing: number, last: { finished_at: string; attention: boolean } | null | undefined): Html[] {
    const linked = slotlockStaffMay(session.r, 'system.read');
    const items: Html[] = [];
    if (failing > 0) {
      const text = `Maintenance is failing for ${count(failing)} ${failing === 1 ? 'account' : 'accounts'}`;
      items.push(html`<li>${linked ? html`<a href="/system#maintenance">${text}</a>` : text} <span class="sub">Their recurring events stop extending and expired holds stay until it runs.</span></li>`);
    }
    if (linked && last && now() - new Date(last.finished_at).getTime() > 3 * 3_600_000) {
      items.push(html`<li><a href="/system#maintenance">No server has recorded maintenance since ${when(last.finished_at)}</a> <span class="sub">Check that <code>slotlock serve</code> is running.</span></li>`);
    }
    return items;
  }

  /** Whether billing daily ran in the last day, and cleanly. */
  function billingDailyAttention(last: { finished_at: string; attention: boolean } | null | undefined): Html[] {
    if (!last) return [html`<li><a href="/billing#runs">Billing daily has never run</a> <span class="sub">Schedule <code>slotlock billing daily</code>.</span></li>`];
    if (now() - new Date(last.finished_at).getTime() > 26 * 3_600_000) {
      return [html`<li><a href="/billing#runs">Billing daily has not run since ${when(last.finished_at)}</a> <span class="sub">Partner months close and overage is reported only when it runs.</span></li>`];
    }
    return last.attention ? [html`<li><a href="/billing#runs">The last billing daily needs attention</a> <span class="sub">See what it printed.</span></li>`] : [];
  }

  async function home(session: Session): Promise<Response> {
    const sql = options.sql();
    const [row] = await sql<{ home: Record<string, number | { day: string; count: number }[]> }[]>`
      SELECT slotlock.admin_home(${session.t}) AS home`;
    const n = (key: string) => Number(row?.home[key] ?? 0);
    const change = (current: number, previous: number) =>
      previous === 0 ? null : `${current >= previous ? '+' : ''}${Math.round(((current - previous) / previous) * 100)}% on last month`;
    const signups = (row?.home.signups as { day: string; count: number }[] | undefined) ?? [];
    const attention = [
      ...(n('suspended') > 0 ? [html`<li><a href="/accounts?status=suspended">${count(n('suspended'))} suspended ${n('suspended') === 1 ? 'account' : 'accounts'}</a> <span class="sub">Check each has a case and a reason.</span></li>`] : []),
      ...(n('past_due') > 0 ? [html`<li>${count(n('past_due'))} ${n('past_due') === 1 ? 'payment' : 'payments'} past due <span class="sub">Stripe retries; the plan ends if it fails.</span></li>`] : []),
      ...(n('billing_alerts_open') > 0 && slotlockStaffMay(session.r, 'billing.read')
        ? [html`<li><a href="/billing#alerts">${count(n('billing_alerts_open'))} billing ${n('billing_alerts_open') === 1 ? 'alert' : 'alerts'}</a> <span class="sub">Failed payments and duplicate subscriptions, from Stripe.</span></li>`]
        : []),
      ...(n('overrides_pending') > 0 && slotlockStaffMay(session.r, 'plans.approve')
        ? [html`<li><a href="/billing#overrides">${count(n('overrides_pending'))} ${n('overrides_pending') === 1 ? 'override waits' : 'overrides wait'} for a second Owner</a></li>`]
        : []),
      ...(slotlockStaffMay(session.r, 'billing.read') ? billingDailyAttention(row?.home.billing_daily as unknown as { finished_at: string; attention: boolean } | null) : []),
      ...(n('privacy_due_soon') > 0 && slotlockStaffMay(session.r, 'privacy.act')
        ? [html`<li><a href="/privacy">${count(n('privacy_due_soon'))} privacy ${n('privacy_due_soon') === 1 ? 'request is' : 'requests are'} due within a week or overdue</a> <span class="sub">The law gives a month from when each arrived.</span></li>`]
        : []),
      ...(n('cases_open') > 0 && slotlockStaffMay(session.r, 'safety.act')
        ? [html`<li><a href="/cases">${count(n('cases_open'))} open ${n('cases_open') === 1 ? 'case' : 'cases'}</a> <span class="sub">Each needs an action and an outcome.</span></li>`]
        : []),
      ...maintenanceAttention(session, n('maintenance_failing'), row?.home.maintenance_last as unknown as { finished_at: string; attention: boolean } | null),
    ];
    const read = slotlockStaffMay(session.r, 'accounts.read');
    const body = html`
      ${pageHead('Slotlock Cloud', 'Home', 'What needs a person, and how the service is doing this month.')}
      <h2>Needs attention</h2>
      ${attention.length ? html`<ul class="panel attention">${attention}</ul>` : html`<p class="empty">Nothing needs a person right now.</p>`}
      <h2>This month</h2>
      ${stats([
        { label: 'Accounts', value: count(n('accounts')), note: `${count(n('people'))} people, ${count(n('teams'))} teams, ${count(n('organizations'))} organizations`, ...(read ? { href: '/accounts' } : {}) },
        { label: 'Paying', value: count(n('paying')), note: 'Developer and Team, active' },
        { label: 'Active in 7 days', value: count(n('active_7_days')), note: 'Accounts with any use' },
        { label: 'Operations', value: count(n('operations_month')), note: change(n('operations_month'), n('operations_last_month')) },
        { label: 'Bookings', value: count(n('bookings_month')), note: change(n('bookings_month'), n('bookings_last_month')) },
        { label: 'Suspended', value: count(n('suspended')), ...(read ? { href: '/accounts?status=suspended' } : {}) },
        { label: 'Staff', value: count(n('staff')), ...(slotlockStaffMay(session.r, 'staff.read') ? { href: '/staff' } : {}) },
        { label: 'Announcements', value: count(n('announcements_live')), note: 'Showing on dashboards now', ...(slotlockStaffMay(session.r, 'system.read') ? { href: '/communications' } : {}) },
      ])}
      <h2>Sign-ups</h2>
      ${bars('New accounts', signups.map((point) => ({ day: String(point.day), count: Number(point.count) })))}
    `;
    return page(session, 'Home', '/', body);
  }

  async function accounts(session: Session, url: URL): Promise<Response> {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    const plan = ['free', 'developer', 'team'].includes(url.searchParams.get('plan') ?? '') ? url.searchParams.get('plan') : null;
    const status = ['active', 'suspended'].includes(url.searchParams.get('status') ?? '') ? url.searchParams.get('status') : null;
    const after = url.searchParams.get('after')?.slice(0, 500) || null;
    // The login a search found, only when GitHub says that id is that login: a link cannot label an
    // account with a login of its choosing.
    const asked = url.searchParams.get('for');
    const githubFor = asked && /^[1-9][0-9]{0,19}$/.test(q) && (await loginOf(`github:${q}`))?.toLowerCase() === asked.toLowerCase() ? asked : null;
    const sql = options.sql();
    const rows = await sql<{
      account_ref: string; kind: string; name: string | null; created_at: Date | null; last_active: Date | null;
      plan: string; plan_status: string | null; suspended: boolean; operations_month: string; bookings_month: string;
    }[]>`SELECT * FROM slotlock.admin_accounts(${session.t}, ${q || null}, ${plan}, ${status}, ${after}, ${PAGE})`;
    const named = await Promise.all(
      rows.map(async (row) => row.name ?? (row.kind === 'person' && row.account_ref.startsWith('github:') && rows.length <= 10 ? await loginOf(row.account_ref) : null)),
    );
    const option = (value: string, label: string, current: string | null) =>
      html`<option value="${value}" ${current === value ? html`selected` : ''}>${label}</option>`;
    const last = rows.at(-1)?.account_ref;
    const next = new URLSearchParams({ ...(q ? { q } : {}), ...(plan ? { plan } : {}), ...(status ? { status } : {}), ...(last ? { after: last } : {}) });
    const body = html`
      ${pageHead('Slotlock Cloud', 'Accounts', githubFor ? html`GitHub account <strong>${githubFor}</strong> is id <code>${q}</code>.` : 'Every person, team, organization and partner account. Test environments are hidden unless you search for one.')}
      <form class="filters" method="get" action="/accounts">
        <label class="sr-only" for="accounts-q">Search</label>
        <input id="accounts-q" name="q" value="${q}" placeholder="Reference, id, slk_ prefix, cus_ customer, name">
        <label class="sr-only" for="accounts-plan">Plan</label>
        <select id="accounts-plan" name="plan">${option('', 'Any plan', plan ?? '')}${option('free', 'Free', plan)}${option('developer', 'Developer', plan)}${option('team', 'Team', plan)}</select>
        <label class="sr-only" for="accounts-status">Status</label>
        <select id="accounts-status" name="status">${option('', 'Any status', status ?? '')}${option('active', 'Active', status)}${option('suspended', 'Suspended', status)}</select>
        <button class="btn" type="submit">Filter</button>
      </form>
      ${table(
        'Accounts',
        ['Account', 'Plan', 'Status', 'This month', 'Last active', 'Created'],
        rows.map((row, index) => [
          html`<a href="${accountHref(row.account_ref)}">${named[index] ?? row.account_ref}</a><span class="sub mono">${named[index] ? row.account_ref : ''} ${kindPill(row.kind)}</span>`,
          planPill(row.plan),
          statusPill(row.suspended, row.plan_status),
          html`${count(row.operations_month)} operations<span class="sub">${count(row.bookings_month)} bookings</span>`,
          html`${day(row.last_active)}`,
          html`${day(row.created_at)}`,
        ]),
        q ? 'No account matches that search.' : 'No accounts yet.',
      )}
      ${rows.length === PAGE ? html`<p class="pager"><a class="btn" href="/accounts?${next.toString()}">Next page</a></p>` : ''}
    `;
    return page(session, 'Accounts', '/accounts', body, q);
  }

  async function account(session: Session, ref: string, url: URL): Promise<Response> {
    const sql = options.sql();
    const [row] = await sql<{ account: Record<string, unknown> | null }[]>`SELECT slotlock.admin_account(${session.t}, ${ref}) AS account`;
    const data = row?.account;
    if (!data) {
      return respond(layout(shellOf(session, 'Not found', '/accounts'), html`${pageHead('Accounts', 'No such account', html`No account has the reference <code>${ref}</code>.`)}`), 404, { 'Set-Cookie': sessionCookie(session) });
    }
    const person = PERSON_REF.test(ref);
    const act = slotlockStaffMay(session.r, 'accounts.act');
    const safety = slotlockStaffMay(session.r, 'safety.act');
    const [keys, usage, audit, login, sessions, notes, cases, overrides] = await Promise.all([
      sql<{ id: string; name: string; prefix: string; scopes: string[]; created_at: Date; expires_at: Date | null; last_used_at: Date | null; revoked_at: Date | null }[]>`
        SELECT * FROM slotlock.admin_account_keys(${session.t}, ${ref})`,
      sql<{ day: Date; metric: string; count: string }[]>`SELECT * FROM slotlock.admin_account_usage(${session.t}, ${ref}, 30)`,
      sql<{ occurred_at: Date; action: string; actor_type: string; actor_ref: string; target_type: string | null; target_ref: string | null; outcome: string; reason: string | null }[]>`
        SELECT * FROM slotlock.admin_account_audit(${session.t}, ${ref}, 50)`,
      loginOf(ref),
      person
        ? sql<{ handle: string; started_at: Date; last_seen_at: Date; expires_at: Date }[]>`
            SELECT * FROM slotlock.admin_account_sessions(${session.t}, ${ref})`
        : Promise.resolve([]),
      sql<{ id: string; staff_ref: string; body: string; created_at: Date }[]>`SELECT * FROM slotlock.admin_account_notes(${session.t}, ${ref})`,
      safety
        ? sql<CaseRow[]>`SELECT * FROM slotlock.admin_cases(${session.t}, ${null}, ${ref}, ${null}, ${20})`
        : Promise.resolve([] as CaseRow[]),
      sql<OverrideRow[]>`SELECT * FROM slotlock.admin_account_overrides(${session.t}, ${ref})`,
    ]);
    const plan = await planSection(session, ref, data, overrides);
    const authors = await staffNames(notes.map((note) => note.staff_ref));
    // What it is held to now, an override included; else its plan row's.
    const held = (data.effective ?? null) as { max_resources: number; max_api_keys: number; max_webhook_endpoints: number } | null;
    const limits = held
      ? { resources: held.max_resources, api_keys: held.max_api_keys, webhook_endpoints: held.max_webhook_endpoints }
      : ((data.limits ?? null) as Record<string, number> | null);
    const monthUse = (data.usage_month ?? {}) as Record<string, number>;
    const meter = (label: string, value: number, max: number | undefined) =>
      html`<div class="meter"><span><span>${label}</span><span>${count(value)}${max ? ` of ${count(max)}` : ''}</span></span>${max ? html`<progress max="${max}" value="${Math.min(value, max)}">${value}</progress>` : ''}</div>`;
    const series = (metric: string) =>
      usage.filter((point) => point.metric === metric).map((point) => ({ day: day(point.day), count: Number(point.count) }));
    const title = String(data.name ?? login ?? ref);
    const stripe = typeof data.stripe_customer === 'string' ? data.stripe_customer : null;
    const base = accountHref(ref);
    const csrf = html`<input type="hidden" name="csrf" value="${csrfOf(session)}">`;
    const reasonField = (id: string, hint: string) =>
      html`<label for="${id}">Reason <span class="hint">${hint}</span></label><input id="${id}" name="reason" required maxlength="200" autocomplete="off">`;
    const suspended = Boolean(data.suspended);
    const openCases = cases.filter((item) => item.status === 'open');
    const now_ = now();
    const activeKey = (key: { revoked_at: Date | null; expires_at: Date | null }) =>
      !key.revoked_at && !(key.expires_at && new Date(key.expires_at).getTime() < now_);
    const body = html`
      ${pageHead(`Account · ${String(data.kind)}`, title, html`<code>${ref}</code> <button class="link" type="button" data-copy="${ref}" hidden>Copy</button> ${planPill(String(data.plan))} ${statusPill(suspended, (data.plan_status as string | null) ?? null)}`,
        html`${stripe ? html`<a class="btn" href="https://dashboard.stripe.com/customers/${encodeURIComponent(stripe)}" rel="noreferrer">Open in Stripe</a>` : ''}${slotlockStaffMay(session.r, 'system.act') && data.kind !== 'test' ? html`<a class="btn" href="/communications?${new URLSearchParams({ account: ref }).toString()}">Send a notice</a>` : ''}${safety ? html`<a class="btn ${suspended ? '' : 'danger'}" href="#danger">${suspended ? 'Lift suspension' : 'Suspend'}</a>` : ''}`)}
      <div class="grid-2">
        <div>
          ${suspended
            ? html`<div class="notice warn"><p><strong>Suspended ${when(data.suspended_at as string)}</strong>${data.suspended_by ? html` by <span class="mono">${String(data.suspended_by)}</span>` : ''}. It can read, writes nothing, and its keys are refused.</p>
                ${data.suspension_reason ? html`<p>Reason: ${String(data.suspension_reason)}</p>` : ''}
                ${data.suspension_message ? html`<p>The customer sees: “${String(data.suspension_message)}”</p>` : html`<p class="fine">No message for the customer.</p>`}</div>`
            : ''}
          <h2>Use this month</h2>
          ${stats([
            { label: 'Operations', value: count(monthUse.operations ?? 0) },
            { label: 'Bookings', value: count(monthUse.bookings ?? 0) },
            { label: 'Holds', value: count(monthUse.holds ?? 0) },
            { label: 'Webhook deliveries', value: count(monthUse.webhook_deliveries ?? 0) },
          ])}
          <h2>Last 30 days</h2>
          ${bars('Operations', series('operations'))}
          ${plan}
          <h2 id="keys">API keys</h2>
          ${table('API keys', ['Name', 'Prefix', 'Access', 'Last used', 'State'], keys.map((key) => [
            html`${key.name}<span class="sub">Created ${day(key.created_at)}</span>`,
            html`<code>${key.prefix}</code>`,
            html`${key.scopes.join(', ')}`,
            html`${when(key.last_used_at)}`,
            key.revoked_at ? pill('Revoked', 'muted') : activeKey(key) ? pill('Active', 'good') : pill('Expired', 'muted'),
          ]), 'No API keys.')}
          ${act && keys.some(activeKey)
            ? html`<details class="act wide"><summary>Revoke a key</summary><form class="pop form" method="post" action="${base}/keys/revoke">${csrf}
                <label for="revoke-key">Key</label><select id="revoke-key" name="key" required>${keys.filter(activeKey).map((key) => html`<option value="${key.id}">${key.prefix} · ${key.name}</option>`)}</select>
                <p>Its next request is refused. The customer sees this in their audit log, with the reason.</p>
                ${reasonField('revoke-reason', 'the customer sees it')}<button class="btn danger" type="submit">Revoke the key</button></form></details>`
            : ''}
          ${person
            ? html`<h2 id="sessions">Dashboard sessions</h2>
              ${table('Dashboard sessions', ['Session', 'Started', 'Last seen', 'Ends'], sessions.map((item) => [
                html`<code>${item.handle.slice(0, 8)}</code>`,
                html`${when(item.started_at)}`,
                html`${when(item.last_seen_at)}`,
                html`${when(item.expires_at)}`,
              ]), 'No dashboard sessions going.')}
              ${act
                ? html`<details class="act wide"><summary>End sessions</summary><form class="pop form" method="post" action="${base}/sessions/end">${csrf}
                    <label for="end-session">Which</label><select id="end-session" name="session">${sessions.map((item) => html`<option value="${item.handle}">${item.handle.slice(0, 8)} · last seen ${when(item.last_seen_at)}</option>`)}<option value="all">Every session, on every device</option></select>
                    <p>Choosing every session also ends any this list misses, as Sign out everywhere does.</p>
                    ${reasonField('end-reason', 'the customer sees it')}<button class="btn danger" type="submit">Sign out</button></form></details>`
                : ''}`
            : ''}
          <h2>Audit log</h2>
          ${table('Audit log', ['When', 'Action', 'By', 'Outcome'], audit.map((event) => [
            html`${when(event.occurred_at)}`,
            html`<code>${event.action}</code>${event.target_ref ? html`<span class="sub mono">${event.target_type ?? ''} ${event.target_ref}</span>` : ''}${event.reason ? html`<span class="sub">${event.reason}</span>` : ''}`,
            html`<span class="mono">${event.actor_type}</span><span class="sub mono">${event.actor_ref}</span>`,
            event.outcome === 'success' ? pill('Done', 'good') : pill(event.outcome, 'bad'),
          ]), 'Nothing in the audit log yet.')}
          ${safety
            ? html`<section id="danger" class="danger-zone" aria-labelledby="danger-title">
                <h2 id="danger-title">Danger zone</h2>
                ${suspended
                  ? html`<form class="form" method="post" action="${base}/unsuspend">${csrf}<p>Lifting the suspension lets it write again and its keys work from the next request.</p>${reasonField('unsuspend-reason', 'the customer sees it in their audit log')}<button class="btn" type="submit">Lift the suspension</button></form>`
                  : html`<form class="form" method="post" action="${base}/suspend">${csrf}<p>From the next request it changes nothing, and its keys are refused. It can still sign in and read.</p>
                      ${reasonField('suspend-reason', 'the customer sees it in their audit log')}
                      <label for="suspend-message">Message for the customer <span class="hint">optional; on every page of their dashboard</span></label><textarea id="suspend-message" name="message" rows="2" maxlength="500"></textarea>
                      ${openCases.length
                        ? html`<label for="suspend-case">Case</label><select id="suspend-case" name="case"><option value="">None</option>${openCases.map((item) => html`<option value="${item.id}">#${item.id} ${item.summary}</option>`)}</select>`
                        : ''}
                      <button class="btn danger" type="submit">Suspend this account</button></form>`}
              </section>`
            : ''}
        </div>
        <aside class="panel rail" aria-label="Details">
          ${meter('Resources', Number(data.resources ?? 0), limits?.resources)}
          ${meter('Active API keys', Number(data.api_keys_active ?? 0), limits?.api_keys)}
          ${meter('Webhook endpoints', Number(data.webhook_endpoints ?? 0), limits?.webhook_endpoints)}
          <dl>
            <div><dt>Created</dt><dd>${when(data.created_at as string)}</dd></div>
            <div><dt>Last active</dt><dd>${day(data.last_active as string)}</dd></div>
            <div><dt>Members</dt><dd>${count(Number(data.members ?? 0))}</dd></div>
            ${stripe ? html`<div><dt>Stripe customer</dt><dd><code>${stripe}</code></dd></div>` : ''}
            ${data.current_period_end ? html`<div><dt>Paid until</dt><dd>${day(data.current_period_end as string)}</dd></div>` : ''}
            ${data.partner ? html`<div><dt>Partner</dt><dd><code>${String(data.partner)}</code></dd></div>` : ''}
          </dl>
          ${safety
            ? html`<h3>Cases</h3>
              ${cases.length
                ? html`<ul class="list">${cases.map((item) => html`<li><a href="/cases/${item.id}">#${item.id} ${item.summary}</a> ${item.status === 'open' ? pill('Open', 'warn') : pill('Closed', 'muted')}</li>`)}</ul>`
                : html`<p class="fine">No cases.</p>`}
              <details class="act"><summary>Open a case</summary>${caseForm(session, ref)}</details>`
            : ''}
          ${slotlockStaffMay(session.r, 'privacy.act')
            ? html`<h3>Privacy</h3><p><a href="/privacy?${new URLSearchParams({ account: ref }).toString()}">Log a privacy request for this account</a></p>`
            : ''}
          <h3>Notes</h3>
          ${notes.length
            ? html`<ul class="list notes">${notes.map((note, index) => html`<li><p class="pre">${note.body}</p><span class="sub">${authors[index] ?? note.staff_ref} · ${when(note.created_at)}</span></li>`)}</ul>`
            : html`<p class="fine">No notes.</p>`}
          ${act
            ? html`<form class="form" method="post" action="${base}/notes">${csrf}<label for="note">Add a note <span class="hint">staff only; the customer never sees it</span></label><textarea id="note" name="note" rows="3" maxlength="${SLOTLOCK_STAFF_NOTE_MAX}" required></textarea><button class="btn" type="submit">Add note</button></form>`
            : ''}
          <p class="fine">Booking titles, descriptions and attendees are never shown here (RFC 0006, E3).</p>
        </aside>
      </div>`;
    return page(session, title, '/accounts', body, undefined, noticeOf(url));
  }

  /** The form that opens a case: about this account, or (with no account) one to name later. */
  function caseForm(session: Session, ref: string | null): Html {
    return html`<form class="pop form" method="post" action="/cases"><input type="hidden" name="csrf" value="${csrfOf(session)}">
      ${ref ? html`<input type="hidden" name="account" value="${ref}">` : html`<label for="case-account">Account <span class="hint">optional</span></label><input id="case-account" name="account" maxlength="500" autocomplete="off" spellcheck="false">`}
      <label for="case-summary">Summary</label><input id="case-summary" name="summary" required maxlength="200" autocomplete="off">
      <label for="case-source">Came from</label><select id="case-source" name="source"><option value="report">A report (abuse@)</option><option value="staff">Something staff saw</option></select>
      <label for="case-section">Acceptable Use Policy section <span class="hint">optional</span></label><input id="case-section" name="section" maxlength="100" autocomplete="off">
      <label for="case-evidence">Evidence <span class="hint">optional; links, request ids, what was seen</span></label><textarea id="case-evidence" name="evidence" rows="4" maxlength="4000"></textarea>
      <button class="btn" type="submit">Open the case</button></form>`;
  }

  async function casesPage(session: Session, url: URL): Promise<Response> {
    const wanted = url.searchParams.get('status') ?? 'open';
    const status = wanted === 'closed' || wanted === 'all' ? wanted : 'open';
    const after = /^[1-9][0-9]{0,17}$/.test(url.searchParams.get('after') ?? '') ? (url.searchParams.get('after') as string) : null;
    const rows = await options.sql()<CaseRow[]>`
      SELECT * FROM slotlock.admin_cases(${session.t}, ${status === 'all' ? null : status}, ${null}, ${after}, ${PAGE})`;
    const tab = (value: string, label: string) =>
      html`<a class="tab" href="/cases?status=${value}" ${status === value ? new Html('aria-current="page"') : ''}>${label}</a>`;
    const last = rows.at(-1)?.id;
    const body = html`
      ${pageHead('Trust and safety', 'Cases', 'Abuse reports and what staff saw: the policy section, the evidence, what was done and how it ended.')}
      <nav class="tabs" aria-label="Cases">${tab('open', 'Open')}${tab('closed', 'Closed')}${tab('all', 'All')}</nav>
      <details class="act wide"><summary>Open a case</summary>${caseForm(session, null)}</details>
      ${table('Cases', ['Case', 'Account', 'Came from', 'Done', 'Status', 'Opened'], rows.map((item) => [
        html`<a href="/cases/${item.id}">#${item.id} ${item.summary}</a>${item.policy_section ? html`<span class="sub">${item.policy_section}</span>` : ''}`,
        item.account_ref ? html`<a class="mono" href="${accountHref(item.account_ref)}">${item.account_ref}</a>` : html`–`,
        html`${item.source === 'report' ? 'A report' : 'Staff'}`,
        html`${CASE_ACTION_WORDS[item.action_taken] ?? item.action_taken}`,
        item.status === 'open' ? pill('Open', 'warn') : pill('Closed', 'muted'),
        html`${day(item.opened_at)}`,
      ]), status === 'open' ? 'No open cases.' : 'No cases.')}
      ${rows.length === PAGE && last ? html`<p class="pager"><a class="btn" href="/cases?${new URLSearchParams({ status, after: last }).toString()}">Older</a></p>` : ''}`;
    return page(session, 'Cases', '/cases', body, undefined, noticeOf(url));
  }

  async function casePage(session: Session, id: string, url: URL): Promise<Response> {
    const [row] = await options.sql()<{ found: Record<string, unknown> | null }[]>`SELECT slotlock.admin_case(${session.t}, ${id}::bigint) AS found`;
    const found = row?.found;
    if (!found) {
      return respond(layout(shellOf(session, 'Not found', '/cases'), pageHead('Cases', 'No such case', `There is no case #${id}.`)), 404, { 'Set-Cookie': sessionCookie(session) });
    }
    const history = (found.history ?? []) as { occurred_at: string; staff_ref: string; action: string; reason: string | null }[];
    const names = await staffNames([String(found.opened_by), ...history.map((event) => event.staff_ref)]);
    const open = found.status === 'open';
    const account_ = typeof found.account_ref === 'string' ? found.account_ref : null;
    const option = (value: string, label: string, current: unknown) =>
      html`<option value="${value}" ${current === value ? html`selected` : ''}>${label}</option>`;
    const body = html`
      ${pageHead(`Case #${id}`, String(found.summary), html`${open ? pill('Open', 'warn') : pill('Closed', 'muted')} ${found.policy_section ? html`<span class="sub-inline">${String(found.policy_section)}</span>` : ''}`)}
      <div class="grid-2">
        <div>
          <h2>Evidence</h2>
          ${found.evidence ? html`<p class="pre panel">${String(found.evidence)}</p>` : html`<p class="empty">No evidence recorded.</p>`}
          <h2>Outcome</h2>
          ${found.outcome ? html`<p class="pre panel">${String(found.outcome)}</p>` : html`<p class="fine">Not decided yet.</p>`}
          <h2>Update</h2>
          <form class="form" method="post" action="/cases/${id}"><input type="hidden" name="csrf" value="${csrfOf(session)}">
            <label for="case-status">Status</label><select id="case-status" name="status">${option('open', 'Open', found.status)}${option('closed', 'Closed', found.status)}</select>
            <label for="case-action">What was done</label><select id="case-action" name="action">${SLOTLOCK_CASE_ACTIONS.map((value) => option(value, CASE_ACTION_WORDS[value] ?? value, found.action_taken))}</select>
            <label for="case-outcome">Outcome <span class="hint">replaces the one above</span></label><textarea id="case-outcome" name="outcome" rows="3" maxlength="1000"></textarea>
            <button class="btn" type="submit">Save</button>
          </form>
          <h2>History</h2>
          ${table('History', ['When', 'Who', 'What'], history.map((event, index) => [
            html`${when(event.occurred_at)}`,
            html`${names[index + 1] ?? event.staff_ref}`,
            html`<code>${event.action}</code>${event.reason ? html`<span class="sub">${event.reason}</span>` : ''}`,
          ]), 'Nothing yet.')}
        </div>
        <aside class="panel rail" aria-label="Details">
          <dl>
            <div><dt>Account</dt><dd>${account_ ? html`<a class="mono" href="${accountHref(account_)}">${account_}</a>` : 'Not named'}</dd></div>
            <div><dt>Came from</dt><dd>${found.source === 'report' ? 'A report' : 'Staff'}</dd></div>
            <div><dt>Done</dt><dd>${CASE_ACTION_WORDS[String(found.action_taken)] ?? String(found.action_taken)}</dd></div>
            <div><dt>Opened</dt><dd>${when(found.opened_at as string)}<span class="sub">${names[0] ?? String(found.opened_by)}</span></dd></div>
            ${found.closed_at ? html`<div><dt>Closed</dt><dd>${when(found.closed_at as string)}</dd></div>` : ''}
          </dl>
          ${account_ ? html`<p><a class="btn" href="${accountHref(account_)}#danger">Suspend or lift on the account</a></p>` : ''}
        </aside>
      </div>`;
    return page(session, `Case #${id}`, '/cases', body, undefined, noticeOf(url));
  }

  // ---------- Privacy (RFC 0006, M7) ----------
  interface PrivacyRow {
    id: string;
    account_ref: string | null;
    kind: string;
    concerns: string;
    received_on: Date;
    due_on: Date;
    status: string;
    verified: boolean;
    exporting: boolean;
    erasure_asked: boolean;
    erasure_approved: boolean;
    opened_by: string;
    opened_at: Date;
    closed_at: Date | null;
  }
  const isoDay = (value: Date | string) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
  /** How long is left: overdue, due within a week, or the date. */
  function duePill(dueOn: Date | string, status: string): Html {
    const due = Date.parse(`${isoDay(dueOn)}T23:59:59Z`);
    if (status !== 'open') return html`${day(isoDay(dueOn))}`;
    const days = Math.floor((due - now()) / DAY_MS);
    if (days < 0) return html`${pill('Overdue', 'bad')}<span class="sub">${day(isoDay(dueOn))}</span>`;
    if (days <= 7) return html`${pill(days === 0 ? 'Due today' : `Due in ${days} ${days === 1 ? 'day' : 'days'}`, 'warn')}<span class="sub">${day(isoDay(dueOn))}</span>`;
    return html`${day(isoDay(dueOn))}`;
  }
  const privacyStatusPill = (status: string) =>
    status === 'open' ? pill('Open', 'warn') : pill(PRIVACY_STATUS_WORDS[status] ?? status, status === 'done' || status === 'passed_on' ? 'good' : 'muted');

  function privacyForm(session: Session, account: string | null): Html {
    const kinds = SLOTLOCK_PRIVACY_KINDS.map((value) => html`<option value="${value}">${PRIVACY_KIND_WORDS[value] ?? value}</option>`);
    return html`<form class="pop form" method="post" action="/privacy"><input type="hidden" name="csrf" value="${csrfOf(session)}">
      <label for="privacy-account">Account <span class="hint">github:…, team:…, as on its page</span></label>
      <input id="privacy-account" name="account" required maxlength="500" autocomplete="off" spellcheck="false" value="${account ?? ''}">
      <label for="privacy-kind">They ask for</label><select id="privacy-kind" name="kind">${kinds}</select>
      <label for="privacy-concerns">It is about</label><select id="privacy-concerns" name="concerns">${SLOTLOCK_PRIVACY_CONCERNS.map((value) =>
        html`<option value="${value}">${value === 'account' ? 'The account holder (we answer it)' : 'One of the account’s customers (we pass it on)'}</option>`)}</select>
      <label for="privacy-received">Arrived on</label><input id="privacy-received" name="received" type="date" required value="${isoDay(new Date(now()))}">
      <label for="privacy-reference">Where it is <span class="hint">the privacy mailbox thread's subject or id; never an email address</span></label>
      <input id="privacy-reference" name="reference" required maxlength="200" autocomplete="off">
      <button class="btn" type="submit">Log the request</button></form>`;
  }

  async function privacyPage(session: Session, url: URL): Promise<Response> {
    const all = url.searchParams.get('status') === 'all';
    const before = /^[1-9][0-9]{0,17}$/.test(url.searchParams.get('before') ?? '') ? (url.searchParams.get('before') as string) : null;
    const rows = await options.sql()<PrivacyRow[]>`
      SELECT * FROM slotlock.admin_privacy_requests(${session.t}, ${!all}, ${all ? before : null}, ${PAGE})`;
    const prefill = url.searchParams.get('account')?.slice(0, 500) || null;
    const tab = (value: string, label: string) =>
      html`<a class="tab" href="/privacy${value === 'open' ? '' : '?status=all'}" ${(value === 'all') === all ? new Html('aria-current="page"') : ''}>${label}</a>`;
    const progress = (row: PrivacyRow) => {
      if (row.concerns === 'customer') return html`<span class="sub-inline">${row.status === 'open' ? 'To pass on to the account holder' : 'For the account holder'}</span>`;
      const steps = [row.verified ? 'Verified' : 'Not verified'];
      if (row.exporting) steps.push('Export started');
      if (row.erasure_asked) steps.push(row.erasure_approved ? 'Erasure approved' : 'Erasure asked');
      return html`<span class="sub-inline">${steps.join(' · ')}</span>`;
    };
    const last = rows.at(-1)?.id;
    const body = html`
      ${pageHead('Privacy', 'Requests', 'Requests to see, take away, correct or erase data, each answered within a month of arriving. One about an account holder is answered here; one about an account’s own customer goes to the account holder, its controller.')}
      <nav class="tabs" aria-label="Requests">${tab('open', 'Open')}${tab('all', 'All')}</nav>
      <details class="act wide" ${prefill ? new Html('open') : ''}><summary>Log a request</summary>${privacyForm(session, prefill)}</details>
      ${table('Privacy requests', ['Request', 'Account', 'Arrived', 'Due', 'Status', 'Progress'], rows.map((row) => [
        html`<a href="/privacy/${row.id}">#${row.id} ${PRIVACY_KIND_WORDS[row.kind] ?? row.kind}</a><span class="sub">${row.concerns === 'account' ? 'The account holder' : 'An account’s customer'}</span>`,
        row.account_ref ? html`<a class="mono" href="${accountHref(row.account_ref)}">${row.account_ref}</a>` : html`<span class="sub-inline">Erased</span>`,
        html`${day(isoDay(row.received_on))}`,
        duePill(row.due_on, row.status),
        privacyStatusPill(row.status),
        progress(row),
      ]), all ? 'No requests yet.' : 'No open requests.')}
      ${all && rows.length === PAGE && last ? html`<p class="pager"><a class="btn" href="/privacy?${new URLSearchParams({ status: 'all', before: last }).toString()}">Older</a></p>` : ''}
      <h2>Was an account erased?</h2>
      <form class="filters" method="get" action="/privacy/receipts" role="search">
        <label class="sr-only" for="receipt-account">Account</label>
        <input id="receipt-account" name="account" required maxlength="500" placeholder="github:…, team:…" autocomplete="off" spellcheck="false">
        <button class="btn" type="submit">Look for a receipt</button>
      </form>`;
    return page(session, 'Privacy', '/privacy', body, undefined, noticeOf(url));
  }

  async function privacyReceipts(session: Session, url: URL): Promise<Response> {
    const account = (url.searchParams.get('account') ?? '').trim().slice(0, 500);
    if (!account) return redirect('/privacy');
    const rows = await options.sql()<{ request_id: string; erased_at: Date; rows_erased: string; asked_by: string; approved_by: string; erased_by: string }[]>`
      SELECT * FROM slotlock.admin_privacy_receipts(${session.t}, ${account})`;
    const names = await staffNames(rows.flatMap((row) => [row.asked_by, row.approved_by, row.erased_by]));
    const body = html`
      ${pageHead('Privacy', 'Erasure receipts', html`For <span class="mono">${account}</span>. A receipt names the account only by a digest, which this lookup matches.`)}
      ${table('Receipts', ['Request', 'Erased', 'Rows', 'Asked, approved and erased by'], rows.map((row, index) => [
        html`<a href="/privacy/${row.request_id}">#${row.request_id}</a>`,
        html`${when(row.erased_at)}`,
        html`${count(row.rows_erased)}`,
        html`${names[index * 3] ?? row.asked_by}, ${names[index * 3 + 1] ?? row.approved_by}, ${names[index * 3 + 2] ?? row.erased_by}`,
      ]), 'No receipt: this console has not erased that account.')}
      <p><a class="btn" href="/privacy">All requests</a></p>`;
    return page(session, 'Erasure receipts', '/privacy', body);
  }

  async function privacyRequestPage(session: Session, id: string, url: URL): Promise<Response> {
    const [row] = await options.sql()<{ found: Record<string, unknown> | null }[]>`SELECT slotlock.admin_privacy_request(${session.t}, ${id}::bigint) AS found`;
    const found = row?.found;
    if (!found) {
      return respond(layout(shellOf(session, 'Not found', '/privacy'), pageHead('Privacy', 'No such request', `There is no request #${id}.`)), 404, { 'Set-Cookie': sessionCookie(session) });
    }
    const text = (key: string) => (typeof found[key] === 'string' ? (found[key] as string) : null);
    const account_ = text('account_ref');
    const open = found.status === 'open';
    const kind = String(found.kind);
    const aboutAccount = found.concerns === 'account';
    const plan = found.plan as { plan?: string; status?: string; stripe_customer?: string | null; live?: boolean } | null;
    const proof = found.proof as { prefix: string; created_by: string | null; created_at: string } | null;
    const made = found.export as { id: string; status: string; finished_at: string | null; expires_at: string; rows: string | number; tables: Record<string, number>; error: string | null } | null;
    const receipt = found.receipt as { rows: number; asked_by: string; approved_by: string; erased_by: string; erased_at: string; digest: string } | null;
    const people = [text('opened_by'), text('verified_by'), text('erasure_asked_by'), text('erasure_approved_by'), text('closed_by'),
      receipt?.erased_by ?? null].map((ref) => ref ?? '');
    const names = await staffNames(people);
    const nameOf = (index: number) => names[index] || people[index] || '';
    const mayErase = slotlockStaffMay(session.r, 'privacy.erase');
    const csrf = html`<input type="hidden" name="csrf" value="${csrfOf(session)}">`;
    const step = (number: number, title: string, done: boolean, content: Html) =>
      html`<li class="step${done ? ' done' : ''}"><span class="step-mark" aria-hidden="true">${done ? '✓' : String(number)}</span><div><h3>${title}<span class="sr-only">${done ? ': done' : ''}</span></h3>${content}</div></li>`;

    const verifyStep = step(1, 'Show it comes from the account holder', Boolean(found.verified_at), found.verified_at
      ? html`<p>Verified ${when(String(found.verified_at))} by ${nameOf(1)}, with the key <code>${text('verified_key') ?? ''}</code>.</p>`
      : html`<p>Reply with this word and ask them to make an API key with it as its name, signed in to the dashboard as the account (for a team or an organization, as one of its Owners):</p>
        <p class="word"><code>${String(found.verification_word)}</code> <button class="link" type="button" data-copy="${String(found.verification_word)}" hidden>Copy</button></p>
        ${proof ? html`<p class="fine">A key with that name is there: <code>${proof.prefix}</code>, made ${when(proof.created_at)}${proof.created_by ? html` by <span class="mono">${proof.created_by}</span>` : ''}.</p>` : ''}
        ${open ? html`<form method="post" action="/privacy/${id}/verify">${csrf}<button class="btn" type="submit">Check for the key</button></form>` : ''}`);

    let steps: Html;
    if (!aboutAccount) {
      steps = html`<ol class="steps">${step(1, 'Pass it on to the account holder', !open, html`<p>The account holder is the controller of their customers' data, and answers with the Privacy page of their dashboard or the subject API. Tell the person so, and tell the account holder, then close it as passed on.</p>`)}</ol>`;
    } else if (kind === 'erasure') {
      const live = Boolean(plan?.live);
      const asked = Boolean(found.erasure_asked_at);
      const approved = Boolean(found.erasure_approved_at);
      const stripeLink = plan?.stripe_customer ? html` <a href="https://dashboard.stripe.com/customers/${encodeURIComponent(plan.stripe_customer)}" rel="noreferrer">Open the customer in Stripe</a>.` : '';
      steps = html`<ol class="steps">
        ${verifyStep}
        ${step(2, 'Cancel the Stripe subscription', Boolean(receipt) || !live, receipt ? html`<p>Done before the erasure.</p>` : live
          ? html`<p>${pill('Live', 'bad')} ${
              // Unpaid (or its first payment incomplete): on Free, but paying it would renew it.
              plan?.status === 'canceled'
                ? 'The account owes for a subscription that renews if it is paid'
                : `The account pays for ${plan?.plan ?? 'a plan'} (${plan?.status ?? 'active'})`
            }. Cancel it in Stripe; the webhook records it within a minute.${stripeLink}</p>`
          : html`<p>No live subscription${plan?.status ? html` (${plan.status})` : ''}.</p>`)}
        ${step(3, 'A second Owner approves', approved, approved
          ? html`<p>Asked by ${nameOf(2)} ${when(String(found.erasure_asked_at))}; approved by ${nameOf(3)} ${when(String(found.erasure_approved_at))}.</p>`
          : asked
            ? html`<p>Asked by ${nameOf(2)} ${when(String(found.erasure_asked_at))}. Another Owner approves it.</p>${open && mayErase && !live && text('erasure_asked_by') !== session.s
              ? html`<form method="post" action="/privacy/${id}/erasure/approve">${csrf}<button class="btn" type="submit">Approve the erasure</button></form>` : ''}`
            : html`<p>${live ? 'Once the subscription is cancelled, an' : 'An'} Owner asks for it, and another approves it.</p>${open && mayErase && !live && found.verified_at
              ? html`<form method="post" action="/privacy/${id}/erasure/ask">${csrf}<button class="btn" type="submit">Ask for the erasure</button></form>` : ''}`)}
        ${step(4, 'Erase the account', Boolean(receipt), receipt ? html`<p>Erased ${when(receipt.erased_at)} by ${nameOf(5)}: ${count(receipt.rows)} rows, and its test environment, notes and cached Stripe data; abuse cases kept, no longer linked to it.</p>`
          : open && mayErase && approved && !live && found.verified_at
            ? html`<form class="form danger-zone" method="post" action="/privacy/${id}/erase">${csrf}
                <p>Everything the account keeps goes, at once and for good: resources, bookings, events, contacts, keys, webhooks, history, exports, its plan and usage, its members and sessions. A suspension stays, and the staff log keeps what staff did.</p>
                <label class="choice"><input type="checkbox" name="confirm" value="yes" required> I understand this cannot be undone</label>
                <button class="btn danger" type="submit">Erase the account</button></form>`
            : html`<p class="fine">Once the steps above are done${mayErase ? '' : ', by an Owner'}.</p>`)}
        ${step(5, 'Keep the receipt', Boolean(receipt), receipt
          ? html`<dl class="receipt"><div><dt>Request</dt><dd>#${id}</dd></div><div><dt>Account</dt><dd class="mono">digest ${receipt.digest.slice(0, 16)}…</dd></div><div><dt>Asked, approved, erased</dt><dd>${nameOf(2)}, ${nameOf(3)}, ${nameOf(5)}</dd></div><div><dt>When</dt><dd>${when(receipt.erased_at)}</dd></div></dl>`
          : html`<p class="fine">Made with the erasure: the request, the account's digest, the time and who approved. No personal data; it is kept ${String(SLOTLOCK_STAFF_RECORD_YEARS)} years.</p>`)}
      </ol>`;
    } else if (kind === 'access' || kind === 'export') {
      const tables = made ? Object.entries(made.tables ?? {}).sort(([a], [b]) => a.localeCompare(b)) : [];
      steps = html`<ol class="steps">
        ${verifyStep}
        ${step(2, 'Make the export', made?.status === 'ready', made
          ? made.status === 'ready'
            ? html`<p>${pill('Ready', 'good')} ${count(made.rows)} rows from ${count(tables.length)} tables, on the account's Privacy page until ${when(made.expires_at)}.</p>
              <details class="act wide"><summary>Rows by table</summary><ul class="list tables">${tables.map(([name, rows]) => html`<li><code>${name}</code> <span class="sub-inline">${count(rows)}</span></li>`)}</ul></details>`
            : made.status === 'pending'
              ? html`<p>${pill('Being built', 'info')} The next maintenance pass builds it, within the hour.</p>`
              : html`<p>${pill('Failed', 'bad')} ${made.error === 'export_too_large' ? 'It is over 512 MB: the operator runs slotlock tenant export and sends it.' : 'Start it again.'}</p>`
          : found.export_kept === false
            ? html`<p>The export made for it has been deleted (its time passed, or the holder deleted it).</p>`
            : open && found.verified_at
              ? html`<p>A copy of every table the account keeps, read at one moment, without secrets. Its holder downloads it from their dashboard; staff never see its rows.</p><form method="post" action="/privacy/${id}/export">${csrf}<button class="btn" type="submit">Start the export</button></form>`
              : html`<p class="fine">Once it is verified.</p>`)}
        ${step(3, 'Tell them where it is', !open, html`<p>Reply that it is on their dashboard's Privacy page for ${SLOTLOCK_PRIVACY_EXPORT_DAYS} days, then close the request.</p>`)}
      </ol>`;
    } else {
      steps = html`<ol class="steps">${verifyStep}${step(2, kind === 'correction' ? 'Make the correction' : 'Answer it', !open, html`<p>${kind === 'correction' ? 'Most of an account the holder corrects in the dashboard; say how, or correct what they cannot.' : 'Answer it from the privacy mailbox.'} Then close it with what was done.</p>`)}</ol>`;
    }

    const outcomes = (['done', 'refused', 'withdrawn', 'passed_on'] as const).filter((value) =>
      value === 'passed_on' ? !aboutAccount : !(value === 'done' && aboutAccount && kind === 'erasure'));
    const body = html`
      ${pageHead(`Privacy request #${id}`, PRIVACY_KIND_WORDS[kind] ?? kind, html`${privacyStatusPill(String(found.status))} ${duePill(String(found.due_on), String(found.status))}`,
        html`<a class="btn" href="/privacy">All requests</a>`)}
      <div class="grid-2">
        <div>
          <h2>Steps</h2>
          ${steps}
          ${open ? html`<h2>Close it</h2>
            <form class="form" method="post" action="/privacy/${id}/close">${csrf}
              <label for="privacy-status">As</label><select id="privacy-status" name="status">${outcomes.map((value) => html`<option value="${value}">${PRIVACY_STATUS_WORDS[value] ?? value}</option>`)}</select>
              <label for="privacy-outcome">What was done <span class="hint">one line, no email address</span></label><input id="privacy-outcome" name="outcome" required maxlength="200" autocomplete="off">
              <button class="btn" type="submit">Close the request</button>
            </form>` : found.outcome ? html`<h2>Outcome</h2><p class="panel">${String(found.outcome)}</p>` : ''}
        </div>
        <aside class="panel rail" aria-label="Details">
          <dl>
            <div><dt>Account</dt><dd>${account_ ? html`<a class="mono" href="${accountHref(account_)}">${account_}</a>` : 'Erased'}</dd></div>
            <div><dt>About</dt><dd>${aboutAccount ? 'The account holder' : 'One of the account’s customers'}</dd></div>
            <div><dt>Arrived</dt><dd>${day(String(found.received_on))}</dd></div>
            <div><dt>Due</dt><dd>${day(String(found.due_on))}</dd></div>
            <div><dt>Where it is</dt><dd>${String(found.reference)}</dd></div>
            <div><dt>Logged</dt><dd>${when(String(found.opened_at))}<span class="sub">${nameOf(0)}</span></dd></div>
            ${found.closed_at ? html`<div><dt>Closed</dt><dd>${when(String(found.closed_at))}<span class="sub">${nameOf(4)}</span></dd></div>` : ''}
          </dl>
        </aside>
      </div>`;
    return page(session, `Privacy request #${id}`, '/privacy', body, undefined, noticeOf(url));
  }

  async function staff(session: Session): Promise<Response> {
    const rows = await options.sql()<{ staff_ref: string; role: string; status: string; added_by: string; added_at: Date; last_seen_at: Date | null; passkeys: number; enrolling: boolean }[]>`
      SELECT * FROM slotlock.admin_staff(${session.t})`;
    const logins = await Promise.all(rows.map((row) => loginOf(row.staff_ref)));
    const body = html`
      ${pageHead('Slotlock Cloud', 'Staff', html`Who can use this console. Add, change and remove staff with <code>slotlock staff</code> as the schema owner.`)}
      ${table('Staff', ['Member', 'Role', 'Status', 'Passkeys', 'Last seen', 'Added'], rows.map((row, index) => [
        html`${logins[index] ?? row.staff_ref}<span class="sub mono">${row.staff_ref}</span>`,
        pill(row.role, row.role === 'owner' ? 'info' : 'muted'),
        row.status === 'active' ? pill('Active', 'good') : pill('Removed', 'muted'),
        html`${count(row.passkeys)}${row.enrolling ? html`<span class="sub">Code issued</span>` : ''}`,
        html`${when(row.last_seen_at)}`,
        html`${day(row.added_at)}<span class="sub mono">${row.added_by}</span>`,
      ]), 'No staff.')}`;
    return page(session, 'Staff', '/staff', body);
  }

  async function staffLog(session: Session, url: URL): Promise<Response> {
    const before = /^[1-9][0-9]{0,18}$/.test(url.searchParams.get('before') ?? '') ? BigInt(url.searchParams.get('before') as string) : null;
    const rows = await options.sql()<{ chain_index: string; occurred_at: Date; staff_ref: string; action: string; account_ref: string | null; target: string | null; reason: string | null }[]>`
      SELECT * FROM slotlock.admin_staff_log(${session.t}, ${before === null ? null : before.toString()}, ${PAGE})`;
    const last = rows.at(-1)?.chain_index;
    const [chainRow] = await options.sql()<{ chain: { checked: number; broken_at: number | null; head_index: number | null; head_hash: string | null } }[]>`
      SELECT slotlock.admin_staff_log_chain(${session.t}) AS chain`;
    const chain = chainRow?.chain;
    const body = html`
      ${pageHead('Slotlock Cloud', 'Staff log', 'Every sign-in, every view of an account and every staff action, newest first. It only grows, and each entry is chained to the one before by SHA-256.')}
      ${chain?.broken_at
        ? html`<p class="notice warn" role="status"><strong>The chain breaks at #${String(chain.broken_at)}.</strong> An entry was changed or removed outside the console. Compare with the last head you recorded, and run <code>slotlock staff verify-log</code>.</p>`
        : chain?.head_index
          ? html`<p class="fine">The newest ${count(chain.checked)} entries check out. Head: #${String(chain.head_index)} <code class="mono">${chain.head_hash ?? ''}</code>. Record it somewhere the database's owner cannot change: a later rewrite of the log would not match it.</p>`
          : ''}
      ${table('Staff log', ['#', 'When', 'Who', 'Action', 'Account'], rows.map((row) => [
        html`<span class="mono">${row.chain_index}</span>`,
        html`${when(row.occurred_at)}`,
        html`<span class="mono">${row.staff_ref}</span>`,
        html`<code>${row.action}</code>${row.target ? html`<span class="sub mono">${row.target}</span>` : ''}${row.reason ? html`<span class="sub">${row.reason}</span>` : ''}`,
        row.account_ref ? html`<a class="mono" href="${accountHref(row.account_ref)}">${row.account_ref}</a>` : html`–`,
      ]), 'The log is empty.')}
      ${rows.length === PAGE && last ? html`<p class="pager"><a class="btn" href="/staff/log?before=${last}">Older</a></p>` : ''}`;
    return page(session, 'Staff log', '/staff/log', body);
  }

  async function search(session: Session, url: URL): Promise<Response> {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    if (!q) return redirect('/accounts');
    // A GitHub login: the database keeps only ids, so ask GitHub which id the login is.
    if (GITHUB_LOGIN.test(q) && !/^[0-9]+$/.test(q) && !/^(slk|cus)_/.test(q)) {
      const profile = await githubProfile(`/users/${encodeURIComponent(q)}`);
      if (profile) {
        await record(session.t, 'search.github_lookup', null, q.slice(0, 200));
        return redirect(`/accounts?${new URLSearchParams({ q: profile.id, for: profile.login }).toString()}`);
      }
    }
    return redirect(`/accounts?${new URLSearchParams({ q }).toString()}`);
  }

  // ---------- Sign-in ----------
  function signInPage(): Response {
    return respond(plainPage('Sign in', html`<h1>Slotlock admin</h1>
      <p>For the people who run Slotlock Cloud. Sign in with GitHub, then with your passkey.</p>
      <form method="get" action="/sign-in/github"><button class="btn primary" type="submit">Continue with GitHub</button></form>
      <p class="fine">Every sign-in and every page you open is recorded in the staff log.</p>`));
  }

  function startGithub(): Response {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.search = new URLSearchParams({
      client_id: options.github.clientId,
      redirect_uri: `${origin}/callback`,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      allow_signup: 'false',
    }).toString();
    return redirect(authorize.href, [cookie(OAUTH_COOKIE, seal('oauth', { state, verifier, exp: now() + 10 * 60 * 1000 }), 600)]);
  }

  async function callback(request: Request, url: URL): Promise<Response> {
    const pending = unseal<{ state: string; verifier: string; exp: number }>('oauth', cookies(request).get(OAUTH_COOKIE));
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') ?? '';
    if (!pending || !code || state.length !== pending.state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) {
      return refused('Sign-in expired', 'Start again from the sign-in page.', 400);
    }
    let user: { id: number; login: string } | null = null;
    try {
      const token = await fetcher('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'slotlock-admin' },
        body: JSON.stringify({
          client_id: options.github.clientId,
          client_secret: options.github.clientSecret,
          code,
          redirect_uri: `${origin}/callback`,
          code_verifier: pending.verifier,
        }),
      });
      const tokenBody = (await token.json()) as { access_token?: unknown };
      if (typeof tokenBody.access_token === 'string') {
        // The token is used once, to read who signed in, and dropped.
        const profile = await fetcher('https://api.github.com/user', {
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${tokenBody.access_token}`, 'User-Agent': 'slotlock-admin' },
        });
        const body = (await profile.json()) as { id?: unknown; login?: unknown };
        if (typeof body.id === 'number' && typeof body.login === 'string') user = { id: body.id, login: body.login };
      }
    } catch {
      user = null;
    }
    if (!user) return refused('Sign-in failed', 'GitHub did not confirm who you are. Try again.', 502);
    const staffRef = `github:${user.id}`;
    // With the console's key, which the console's database credential alone does not hold: the
    // database opens the session and keeps it, so it can end it wherever the cookie went.
    const [row] = await options.sql()<{ opened: { role?: unknown; session?: unknown } | null }[]>`
      SELECT slotlock.admin_sign_in(${staffRef}, ${options.consoleKey}) AS opened`;
    const role = row?.opened?.role;
    const token = row?.opened?.session;
    if (typeof role !== 'string' || !(SLOTLOCK_STAFF_ROLES as readonly string[]).includes(role) || typeof token !== 'string' || !SESSION_TOKEN.test(token)) {
      return refused('Not staff', `GitHub account ${user.login} is not on the Slotlock staff. The attempt was recorded.`);
    }
    // Half signed in: enough to reach the passkey step, for 15 minutes. The passkey starts the 8 hours.
    const session: Session = { s: staffRef, t: token, l: user.login, r: role as SlotlockStaffRole, st: 'github', iat: now(), seen: now(), exp: now() + FRESH_MS };
    return redirect('/passkey', [clear(OAUTH_COOKIE), sessionCookie(session)]);
  }

  async function passkeyPage(session: Session, url: URL): Promise<Response> {
    const keys = await options.sql()<{ credential_id: Buffer }[]>`SELECT credential_id FROM slotlock.admin_passkeys(${session.t})`;
    const asked = url.searchParams.get('next') ?? '/';
    const next = LOCAL_PATH.test(asked) ? asked : '/';
    const fresh = url.searchParams.get('fresh') === '1';
    const adding = url.searchParams.get('add') === '1' && keys.length > 0;
    const enrolling = keys.length === 0 || adding;
    const body = enrolling
      ? html`<h1>${adding ? 'Add a passkey' : 'Create your passkey'}</h1>
        <p>${adding ? 'Name it for the device it lives on.' : html`Enter the one-time code from <code>slotlock staff add</code>, then let your device create a passkey.`}</p>
        <form id="passkey" data-purpose="create" data-next="${next}">
          ${adding ? '' : html`<label for="code">One-time code</label><input id="code" name="code" required autocomplete="one-time-code" spellcheck="false">`}
          <label for="name">Name</label><input id="name" name="name" value="Passkey" maxlength="60" required>
          <button class="btn primary" type="submit">Create passkey</button>
          <p id="passkey-status" class="fine" role="status"></p>
          <p id="passkey-unsupported" class="fine" hidden>This browser cannot use passkeys.</p>
        </form>`
      : html`<h1>Confirm it's you</h1>
        <p>${fresh ? html`Changing an account needs your passkey in the last 15 minutes. Use it, then send the form again.` : html`Signed in with GitHub as <strong>${session.l}</strong>. Use your passkey to open the console.`}</p>
        <form id="passkey" data-purpose="get" data-next="${next}">
          <button class="btn primary" type="submit">Use passkey</button>
          <p id="passkey-status" class="fine" role="status"></p>
          <p id="passkey-unsupported" class="fine" hidden>This browser cannot use passkeys.</p>
        </form>`;
    return respond(plainPage('Passkey', body, '/passkey.js'), 200, { 'Set-Cookie': sessionCookie(session) });
  }

  async function passkeyOptions(session: Session, body: Record<string, unknown>): Promise<Response> {
    const purpose = body.purpose === 'create' ? 'create' : 'get';
    const keys = await options.sql()<{ credential_id: Buffer }[]>`SELECT credential_id FROM slotlock.admin_passkeys(${session.t})`;
    if (purpose === 'get' && keys.length === 0) return json({ error: 'No passkey yet: create one first.' }, 409);
    if (purpose === 'create' && keys.length > 0 && !(session.st === 'full' && session.pv && now() - session.pv < FRESH_MS)) {
      return json({ error: 'Sign in with your passkey in the last 15 minutes to add another.' }, 403);
    }
    const challenge = createSlotlockPasskeyChallenge();
    const ids = keys.map((key) => ({ type: 'public-key', id: base64urlEncode(new Uint8Array(key.credential_id)) }));
    const publicKey =
      purpose === 'create'
        ? {
            challenge,
            rp: { id: rpId, name: 'Slotlock admin' },
            user: { id: createHash('sha256').update(session.s).digest('base64url'), name: session.l, displayName: session.l },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
            attestation: 'none',
            timeout: 120_000,
            excludeCredentials: ids,
          }
        : { challenge, rpId, allowCredentials: ids, userVerification: 'required', timeout: 120_000 };
    // Kept on the session in the database too: used once, and by this session only.
    await options.sql()`SELECT slotlock.admin_passkey_challenge(${session.t}, ${purpose}, ${challengeHash(challenge)})`;
    return json(publicKey, 200, [cookie(PASSKEY_COOKIE, seal('passkey', { c: challenge, p: purpose, s: session.s, exp: now() + 5 * 60 * 1000 }), 300)]);
  }

  const challengeHash = (challenge: string) => createHash('sha256').update(challenge).digest();

  function pendingChallenge(request: Request, session: Session, purpose: 'create' | 'get'): string | null {
    const pending = unseal<{ c: string; p: string; s: string; exp: number }>('passkey', cookies(request).get(PASSKEY_COOKIE));
    return pending && pending.p === purpose && pending.s === session.s ? pending.c : null;
  }

  async function passkeyRegister(request: Request, session: Session, body: Record<string, unknown>): Promise<Response> {
    const challenge = pendingChallenge(request, session, 'create');
    if (!challenge) return json({ error: 'The request expired. Try again.' }, 400);
    const sql = options.sql();
    const keys = await sql<{ credential_id: Buffer }[]>`SELECT credential_id FROM slotlock.admin_passkeys(${session.t})`;
    const adding = keys.length > 0;
    if (adding && !(session.st === 'full' && session.pv && now() - session.pv < FRESH_MS)) {
      return json({ error: 'Sign in with your passkey in the last 15 minutes to add another.' }, 403);
    }
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!adding && !code) return json({ error: 'Enter the one-time code.' }, 400);
    const name = typeof body.name === 'string' && /^[^\p{Cc}]{1,60}$/u.test(body.name.trim()) ? body.name.trim() : 'Passkey';
    let verified;
    try {
      verified = await verifySlotlockPasskeyRegistration({
        attestationObject: String(body.attestationObject ?? ''),
        clientDataJSON: String(body.clientDataJSON ?? ''),
        expectedChallenge: challenge,
        expectedOrigin: origin,
        rpId,
      });
    } catch (error) {
      await record(session.t, 'staff.passkey_refused', null, null, { step: 'register', code: (error as { code?: string }).code ?? 'invalid' });
      return json({ error: 'The passkey could not be checked. Try again.' }, 400);
    }
    // The id the browser reported is the one the authenticator attested.
    if (typeof body.id === 'string' && body.id !== base64urlEncode(verified.credentialId)) {
      return json({ error: 'The passkey could not be checked. Try again.' }, 400);
    }
    const [row] = await sql<{ ok: boolean }[]>`
      SELECT slotlock.admin_passkey_enroll(${session.t}, ${adding ? null : createHash('sha256').update(code).digest()},
        ${Buffer.from(verified.credentialId)}, ${Buffer.from(verified.publicKey)}, ${verified.algorithm}, ${verified.signCount}, ${name},
        ${challengeHash(challenge)}) AS ok`;
    if (!row?.ok) return json({ error: adding ? 'That passkey was refused.' : 'That code is wrong or spent. Ask an owner for a new one.' }, 403);
    const upgraded: Session = { ...session, st: 'full', pv: now(), exp: session.st === 'full' ? session.exp : now() + SESSION_MS };
    return json({ ok: true }, 200, [clear(PASSKEY_COOKIE), sessionCookie(upgraded)]);
  }

  async function passkeyVerify(request: Request, session: Session, body: Record<string, unknown>): Promise<Response> {
    const challenge = pendingChallenge(request, session, 'get');
    if (!challenge) return json({ error: 'The request expired. Try again.' }, 400);
    const sql = options.sql();
    const keys = await sql<{ credential_id: Buffer; public_key: Buffer; algorithm: number }[]>`
      SELECT credential_id, public_key, algorithm FROM slotlock.admin_passkeys(${session.t})`;
    const id = typeof body.id === 'string' ? body.id : '';
    const key = keys.find((candidate) => base64urlEncode(new Uint8Array(candidate.credential_id)) === id);
    if (!key || (key.algorithm !== -7 && key.algorithm !== -257)) {
      await record(session.t, 'staff.passkey_refused', null, null, { step: 'verify', code: 'unknown_passkey' });
      return json({ error: 'That passkey is not registered for you.' }, 403);
    }
    let signCount: number;
    try {
      ({ signCount } = await verifySlotlockPasskeyAssertion({
        authenticatorData: String(body.authenticatorData ?? ''),
        clientDataJSON: String(body.clientDataJSON ?? ''),
        signature: String(body.signature ?? ''),
        expectedChallenge: challenge,
        expectedOrigin: origin,
        rpId,
        publicKey: new Uint8Array(key.public_key),
        algorithm: key.algorithm,
      }));
    } catch (error) {
      await record(session.t, 'staff.passkey_refused', null, null, { step: 'verify', code: (error as { code?: string }).code ?? 'invalid' });
      return json({ error: 'The passkey could not be checked. Try again.' }, 403);
    }
    const [row] = await sql<{ ok: boolean }[]>`
      SELECT slotlock.admin_passkey_used(${session.t}, ${Buffer.from(base64urlDecode(id))}, ${signCount}, ${challengeHash(challenge)}) AS ok`;
    if (!row?.ok) return json({ error: 'That passkey was refused.' }, 403);
    const upgraded: Session = { ...session, st: 'full', pv: now(), exp: session.st === 'full' ? session.exp : now() + SESSION_MS };
    return json({ ok: true }, 200, [clear(PASSKEY_COOKIE), sessionCookie(upgraded)]);
  }

  // ---------- Billing and usage (Phase 3) ----------
  const stripe = options.stripeKey
    ? createSlotlockAdminStripe({ key: options.stripeKey, ...(options.fetch ? { fetch: options.fetch } : {}), now })
    : null;

  /** A provider read, from the hour's cache or fresh (then kept); null when the provider failed. */
  async function cached<T>(session: Session, key: string, read: () => Promise<T>): Promise<T | null> {
    const sql = options.sql();
    const [row] = await sql<{ value: T | null }[]>`SELECT slotlock.admin_cache_read(${session.t}, ${key}) AS value`;
    if (row?.value) return row.value;
    try {
      const value = await read();
      // An object, sent as one: postgres.js encodes JSON parameters itself (a string would be stored as a JSON string).
      await sql`SELECT slotlock.admin_cache_write(${session.t}, ${key}, ${sql.json(value as never)})`;
      return value;
    } catch (error) {
      console.error('slotlock-admin provider read failed', (error as { code?: unknown } | null)?.code ?? 'unknown');
      return null;
    }
  }

  const stripeLink = (ref: string) =>
    ref.startsWith('in_')
      ? `https://dashboard.stripe.com/invoices/${encodeURIComponent(ref)}`
      : `https://dashboard.stripe.com/subscriptions/${encodeURIComponent(ref)}`;
  const OVERRIDE_STATE: Record<string, Html> = {
    in_force: pill('In force', 'good'),
    pending: pill('Waiting for approval', 'warn'),
    ended: pill('Ended', 'muted'),
    expired: pill('Past its end', 'muted'),
  };
  const limitsText = (row: { max_resources: number; max_api_keys: number; max_webhook_endpoints: number }) =>
    `${count(row.max_resources)} resources, ${count(row.max_api_keys)} keys, ${count(row.max_webhook_endpoints)} webhooks`;
  const dateInput = (days: number) => new Date(now() + days * DAY_MS).toISOString().slice(0, 10);

  async function billingPage(session: Session, url: URL): Promise<Response> {
    const sql = options.sql();
    const showAll = url.searchParams.get('alerts') === 'all';
    const [[summaryRow], alerts, overrides, partners] = await Promise.all([
      sql<{ billing: Record<string, unknown> }[]>`SELECT slotlock.admin_billing(${session.t}) AS billing`,
      sql<{ id: string; kind: string; account_ref: string; stripe_ref: string; detail: Record<string, unknown>; created_at: Date; resolved_at: Date | null; resolved_by: string | null }[]>`
        SELECT * FROM slotlock.admin_billing_alerts(${session.t}, ${!showAll}, ${null}, ${50})`,
      sql<{ id: string; account_ref: string; plan: string | null; starts_at: Date; ends_at: Date; reason: string; created_by: string; approved_by: string | null; state: string }[]>`
        SELECT * FROM slotlock.admin_overrides(${session.t})`,
      sql<{ id: string; name: string; status: string; accounts: string; last_month: Date | null; closed_at: Date | null; webhook_status: number | null; invoiced: string | null; currency: string | null; unsent: string; mismatched_days: string }[]>`
        SELECT * FROM slotlock.admin_partners(${session.t})`,
    ]);
    const billing = summaryRow?.billing ?? {};
    const paying = (billing.paying ?? {}) as Record<string, number>;
    const runs = (billing.runs ?? {}) as Record<string, { started_at: string; finished_at: string; attention: boolean; actor: string; summary: { lines?: unknown[] } & Record<string, unknown> }>;
    const revenue = stripe ? await cached<SlotlockStripeRevenue>(session, 'revenue:summary', () => stripe.revenue()) : null;
    const askers = await staffNames(overrides.map((item) => item.created_by));
    const may = (capability: SlotlockStaffCapability) => slotlockStaffMay(session.r, capability);
    const csrf = html`<input type="hidden" name="csrf" value="${csrfOf(session)}"><input type="hidden" name="back" value="/billing">`;
    const openAlerts = alerts.filter((alert) => !alert.resolved_at);
    const pending = overrides.filter((item) => item.state === 'pending');
    const approvable = pending.filter((item) => item.created_by !== session.s);
    const mrr = revenue ? Object.entries(revenue.mrr).map(([currency, minor]) => slotlockMoney(minor, currency)).join(' + ') || slotlockMoney(0, 'eur') : null;
    const body = html`
      ${pageHead('Slotlock Cloud', 'Billing', 'Revenue, what Stripe told us needs a person, plan overrides, the billing jobs and partners.')}
      ${stats([
        { label: 'Monthly recurring revenue', value: mrr ?? '–', note: revenue ? `${count(revenue.live)} live subscriptions` : stripe ? 'Stripe could not be read' : 'Stripe not connected' },
        { label: 'Paying', value: count(Object.values(paying).reduce((sum, value) => sum + Number(value), 0)), note: `${count(paying.developer ?? 0)} Developer, ${count(paying.team ?? 0)} Team` },
        { label: 'Past due', value: count(Number(billing.past_due ?? 0)), note: 'Stripe is retrying' },
        { label: 'New this month', value: revenue ? count(revenue.newThisMonth) : '–', note: 'Subscriptions, from Stripe' },
        { label: 'Cancelled this month', value: revenue ? count(revenue.cancelledThisMonth) : count(Number(billing.canceled_month ?? 0)), note: revenue ? 'Subscriptions, from Stripe' : 'Plans ended' },
        { label: 'Open alerts', value: count(Number(billing.alerts_open ?? 0)) },
      ])}
      <p class="fine">${revenue ? html`Read from Stripe ${when(new Date(revenue.readAt))}, and kept for an hour.${revenue.truncated ? ' Only the first 1,000 subscriptions were read.' : ''}` : stripe ? 'Stripe could not be read just now; the numbers from Stripe are missing.' : html`Revenue needs a restricted Stripe key that reads subscriptions and invoices (<code>SLOTLOCK_ADMIN_STRIPE_KEY</code>).`}</p>

      <h2 id="alerts">Needs a person</h2>
      <p class="fine">Payments that failed and second subscriptions, as the Stripe webhook saw them. A failed payment clears itself when the subscription is paid again. ${showAll ? html`<a href="/billing#alerts">Open ones only</a>` : html`<a href="/billing?alerts=all#alerts">Show resolved too</a>`}</p>
      ${table('Billing alerts', ['Alert', 'Account', 'In Stripe', 'When', 'State'], alerts.map((alert) => [
        html`${alert.kind === 'payment_failed' ? 'Payment failed' : 'Second subscription'}${alert.kind === 'payment_failed' && typeof alert.detail.amount_due === 'number' ? html`<span class="sub">${slotlockMoney(alert.detail.amount_due, typeof alert.detail.currency === 'string' ? alert.detail.currency : null)}, attempt ${String(alert.detail.attempt_count ?? '?')}</span>` : alert.detail.first ? html`<span class="sub mono">besides ${String(alert.detail.first)}: refund one</span>` : ''}`,
        may('accounts.read') ? html`<a class="mono" href="${accountHref(alert.account_ref)}">${alert.account_ref}</a>` : html`<span class="mono">${alert.account_ref}</span>`,
        html`<a class="mono" href="${stripeLink(alert.stripe_ref)}" rel="noreferrer">${alert.stripe_ref}</a>`,
        html`${when(alert.created_at)}`,
        alert.resolved_at ? html`${pill('Resolved', 'muted')}<span class="sub mono">${alert.resolved_by ?? ''}</span>` : pill('Open', 'warn'),
      ]), showAll ? 'No billing alerts yet.' : 'Nothing needs a person.')}
      ${may('billing.act') && openAlerts.length
        ? html`<details class="act wide"><summary>Resolve an alert</summary><form class="pop form" method="post" action="/billing/alerts/resolve">${csrf}
            <label for="alert-id">Alert</label><select id="alert-id" name="alert">${openAlerts.map((alert) => html`<option value="${alert.id}">${alert.kind === 'payment_failed' ? 'Payment failed' : 'Second subscription'} · ${alert.account_ref} · ${alert.stripe_ref}</option>`)}</select>
            <label for="alert-reason">What was done <span class="hint">for the staff log</span></label><input id="alert-reason" name="reason" required maxlength="200" autocomplete="off">
            <button class="btn" type="submit">Resolve</button></form></details>`
        : ''}

      <h2 id="overrides">Plan overrides</h2>
      <p class="fine">In force, or waiting for a second Owner. Give one on the account's page; up to ${SLOTLOCK_OVERRIDE_SOLO_DAYS} days it is in force at once.</p>
      ${table('Plan overrides', ['Account', 'Plan', 'Ends', 'Reason', 'Asked by', 'State'], overrides.map((item, index) => [
        may('accounts.read') ? html`<a class="mono" href="${accountHref(item.account_ref)}">${item.account_ref}</a>` : html`<span class="mono">${item.account_ref}</span>`,
        html`${item.plan ?? 'its own'}`,
        html`${day(item.ends_at)}`,
        html`${item.reason}`,
        html`${askers[index] ?? item.created_by}`,
        OVERRIDE_STATE[item.state] ?? pill(item.state, 'muted'),
      ]), 'No overrides in force.')}
      ${may('plans.approve') && approvable.length
        ? html`<details class="act wide"><summary>Approve an override</summary><form class="pop form" method="post" action="/overrides/approve">${csrf}
            <label for="approve-id">Override</label><select id="approve-id" name="override">${approvable.map((item) => html`<option value="${item.id}">${item.account_ref} · ${item.plan ?? 'its own plan'} until ${day(item.ends_at)} · ${item.reason}</option>`)}</select>
            <p>Four eyes: the Owner who asked cannot approve it.</p><button class="btn" type="submit">Approve</button></form></details>`
        : ''}
      ${may('billing.act') && overrides.length
        ? html`<details class="act wide"><summary>End or withdraw an override</summary><form class="pop form" method="post" action="/overrides/end">${csrf}
            <label for="end-override">Override</label><select id="end-override" name="override">${overrides.map((item) => html`<option value="${item.id}">${item.account_ref} · ${item.plan ?? 'its own plan'} until ${day(item.ends_at)}</option>`)}</select>
            <label for="end-override-reason">Reason <span class="hint">the customer sees it, for one in force</span></label><input id="end-override-reason" name="reason" required maxlength="200" autocomplete="off">
            <button class="btn danger" type="submit">End it</button></form></details>`
        : ''}

      <h2 id="runs">Billing jobs</h2>
      <p class="fine">Run <code>slotlock billing daily</code> once a day, as the schema owner: it closes partner months, reports overage and checks partner counts.</p>
      ${table('Billing jobs', ['Job', 'Last run', 'By', 'State'], (['billing_daily', 'overage_report'] as const).map((job) => {
        const last = runs[job];
        return [
          html`<code>${job === 'billing_daily' ? 'billing daily' : 'overage report'}</code>${last ? html`<details class="act"><summary>What it printed</summary><pre class="pop pre mono">${JSON.stringify(last.summary.lines ?? last.summary, null, 1)}</pre></details>` : ''}`,
          html`${last ? when(new Date(last.finished_at)) : 'Never'}`,
          html`<span class="mono">${last?.actor ?? '–'}</span>`,
          !last ? pill('Not run', 'muted') : last.attention ? pill('Needs attention', 'bad') : pill('Clean', 'good'),
        ];
      }), '')}

      <h2>Partners</h2>
      ${table('Partners', ['Partner', 'Accounts', 'Last month closed', 'Invoiced', 'Webhook', 'Needs a look'], partners.map((partner) => [
        html`${partner.name}<span class="sub mono">${partner.id} ${partner.status === 'active' ? '' : pill(partner.status, 'warn')}</span>`,
        html`${count(partner.accounts)}`,
        html`${partner.last_month ? new Date(partner.last_month).toISOString().slice(0, 7) : 'None yet'}${partner.closed_at ? html`<span class="sub">${when(partner.closed_at)}</span>` : ''}`,
        html`${partner.invoiced !== null ? slotlockMoney(Number(partner.invoiced), partner.currency) : '–'}`,
        partner.webhook_status === null ? html`–` : partner.webhook_status < 300 ? pill(String(partner.webhook_status), 'good') : pill(String(partner.webhook_status), 'bad'),
        Number(partner.unsent) > 0 || Number(partner.mismatched_days) > 0
          ? html`${Number(partner.unsent) > 0 ? html`${count(partner.unsent)} invoice lines not sent ` : ''}${Number(partner.mismatched_days) > 0 ? html`<span class="sub">${count(partner.mismatched_days)} days of counts that disagree</span>` : ''}`
          : html`–`,
      ]), 'No partners.')}`;
    return page(session, 'Billing', '/billing', body, undefined, noticeOf(url));
  }

  async function usagePage(session: Session): Promise<Response> {
    const sql = options.sql();
    const [usage, leaders] = await Promise.all([
      sql<{ day: Date; metric: string; origin: string; count: string }[]>`SELECT * FROM slotlock.admin_usage(${session.t}, ${30})`,
      sql<{ account_ref: string; plan: string | null; operations: string; bookings: string; quota_operations: string | null; quota_bookings: string | null; quota_stop_percent: number | null }[]>`
        SELECT * FROM slotlock.admin_usage_accounts(${session.t})`,
    ]);
    const monthStart = new Date(now()).toISOString().slice(0, 7);
    const byDay = new Map<string, number>();
    const bySurface = new Map<string, { operations: number; bookings: number }>();
    for (const row of usage) {
      const key = day(row.day);
      if (row.metric === 'operations') byDay.set(key, (byDay.get(key) ?? 0) + Number(row.count));
      if (key.slice(0, 7) !== monthStart) continue;
      const surface = bySurface.get(row.origin) ?? { operations: 0, bookings: 0 };
      if (row.metric === 'operations') surface.operations += Number(row.count);
      if (row.metric === 'bookings') surface.bookings += Number(row.count);
      bySurface.set(row.origin, surface);
    }
    const share = (used: number, quota: number | null) => (quota ? Math.round((used / quota) * 100) : null);
    const rows = leaders.map((row) => {
      const plan = row.plan && Object.hasOwn(SLOTLOCK_PLAN_QUOTAS, row.plan) ? SLOTLOCK_PLAN_QUOTAS[row.plan as SlotlockPlan] : null;
      const operations = share(Number(row.operations), row.quota_operations !== null ? Number(row.quota_operations) : (plan?.operations ?? null));
      const bookings = share(Number(row.bookings), row.quota_bookings !== null ? Number(row.quota_bookings) : (plan?.bookings ?? null));
      return { row, worst: Math.max(operations ?? 0, bookings ?? 0), operations, bookings };
    });
    const tone = (percent: number | null) => (percent === null ? pill('No quota', 'muted') : percent >= 100 ? pill(`${percent}%`, 'bad') : percent >= 80 ? pill(`${percent}%`, 'warn') : html`${percent}%`);
    const body = html`
      ${pageHead('Slotlock Cloud', 'Usage', 'Operations and bookings across the platform, by surface, and the accounts using most of their monthly quotas. Test environments left out.')}
      <h2>Operations, last 30 days</h2>
      ${bars('Operations', [...byDay].map(([key, total]) => ({ day: key, count: total })))}
      <h2>This month, by surface</h2>
      ${table('By surface', ['Surface', 'Operations', 'Bookings'], [...bySurface].sort((a, b) => b[1].operations - a[1].operations).map(([origin, totals]) => [
        html`<code>${origin}</code>`, html`${count(totals.operations)}`, html`${count(totals.bookings)}`,
      ]), 'No use this month yet.')}
      <h2>Accounts using most</h2>
      ${table('Accounts using most', ['Account', 'Plan', 'Operations', 'Of quota', 'Bookings', 'Of quota'], rows.sort((a, b) => b.worst - a.worst).map(({ row, operations, bookings }) => [
        html`<a class="mono" href="${accountHref(row.account_ref)}">${row.account_ref}</a>`,
        planPill(row.plan),
        html`${count(row.operations)}`, tone(operations),
        html`${count(row.bookings)}`, tone(bookings),
      ]), 'No use this month yet.')}`;
    return page(session, 'Usage', '/usage', body);
  }

  /** The account page's plan section: what it is held to, its overrides, and Stripe's view. */
  async function planSection(session: Session, ref: string, data: Record<string, unknown>, overrides: OverrideRow[]): Promise<Html> {
    const effective = (data.effective ?? null) as { plan: string; status: string; max_resources: number; max_api_keys: number; max_webhook_endpoints: number } | null;
    const quotas = (data.effective_quotas ?? null) as { operations: number | null; bookings: number | null; stop_percent: number | null } | null;
    const planQuotas = effective && Object.hasOwn(SLOTLOCK_PLAN_QUOTAS, effective.plan) ? SLOTLOCK_PLAN_QUOTAS[effective.plan as SlotlockPlan] : null;
    const may = (capability: SlotlockStaffCapability) => slotlockStaffMay(session.r, capability);
    const base = accountHref(ref);
    const csrf = html`<input type="hidden" name="csrf" value="${csrfOf(session)}"><input type="hidden" name="back" value="${base}">`;
    const inForce = overrides.find((item) => item.state === 'in_force');
    const live = overrides.filter((item) => item.state === 'in_force' || item.state === 'pending');
    const approvable = overrides.filter((item) => item.state === 'pending' && item.created_by !== session.s);
    const names = await staffNames(overrides.map((item) => item.created_by));
    const stripeCustomer = typeof data.stripe_customer === 'string' ? data.stripe_customer : null;
    const customer = stripe && stripeCustomer && may('accounts.read')
      ? await cached<SlotlockStripeCustomer>(session, `account:stripe:${stripeCustomer}`, () => stripe.customer(stripeCustomer))
      : null;
    const quotaText = quotas?.operations
      ? `${count(quotas.operations)} operations and ${count(quotas.bookings ?? 0)} bookings a month, stopped at ${quotas.stop_percent ?? 100}%`
      : planQuotas
        ? `${count(planQuotas.operations)} operations and ${count(planQuotas.bookings)} bookings a month (the plan's)`
        : 'No monthly quotas';
    return html`
      <h2 id="plan">Plan</h2>
      ${effective
        ? html`<p>${planPill(effective.plan)} ${effective.status === 'past_due' ? pill('Past due', 'warn') : ''} ${limitsText(effective)}. ${quotaText}.</p>`
        : html`<p class="fine">No plan: no plan limits apply.</p>`}
      ${inForce ? html`<p class="notice done">An override is in force until ${day(inForce.ends_at)}: ${inForce.plan ? `the ${inForce.plan} plan` : 'its own plan'}, ${limitsText(inForce)}. ${inForce.reason}</p>` : ''}
      ${overrides.length
        ? table('Overrides', ['Override', 'Limits', 'Ends', 'Reason', 'Asked by', 'State'], overrides.map((item, index) => [
            html`${item.plan ? `Plan: ${item.plan}` : 'Limits'}${item.quota_operations ? html`<span class="sub">${count(item.quota_operations)} operations, ${count(item.quota_bookings ?? 0)} bookings a month</span>` : ''}`,
            html`${limitsText(item)}`,
            html`${day(item.ends_at)}`,
            html`${item.reason}`,
            html`${names[index] ?? item.created_by}`,
            OVERRIDE_STATE[item.state] ?? pill(item.state, 'muted'),
          ]), '')
        : ''}
      ${may('billing.act')
        ? html`<details class="act wide"><summary>Put on a plan until a date</summary><form class="pop form" method="post" action="${base}/overrides">${csrf}<input type="hidden" name="kind" value="plan">
            <label for="override-plan">Plan</label><select id="override-plan" name="plan">${PLANS.map((plan) => html`<option value="${plan}" ${plan === 'developer' ? html`selected` : ''}>${plan} (${limitsText({ max_resources: SLOTLOCK_PLAN_LIMITS[plan].resources, max_api_keys: SLOTLOCK_PLAN_LIMITS[plan].apiKeys, max_webhook_endpoints: SLOTLOCK_PLAN_LIMITS[plan].webhookEndpoints })})</option>`)}</select>
            <label for="override-plan-ends">Until <span class="hint">00:00 UTC that day; over ${SLOTLOCK_OVERRIDE_SOLO_DAYS} days needs a second Owner</span></label><input id="override-plan-ends" name="ends" type="date" required value="${dateInput(30)}" min="${dateInput(1)}" max="${dateInput(400)}">
            <label for="override-plan-reason">Reason <span class="hint">the customer sees it in their audit log</span></label><input id="override-plan-reason" name="reason" required maxlength="200" autocomplete="off">
            <p>It takes precedence over what Stripe gives, until it ends.</p><button class="btn" type="submit">Put on this plan</button></form></details>
          <details class="act wide"><summary>Raise limits until a date</summary><form class="pop form" method="post" action="${base}/overrides">${csrf}<input type="hidden" name="kind" value="limits">
            <label for="override-resources">Resources</label><input id="override-resources" name="resources" type="number" min="1" max="100000" required value="${effective?.max_resources ?? SLOTLOCK_PLAN_LIMITS.free.resources}">
            <label for="override-keys">Active API keys</label><input id="override-keys" name="keys" type="number" min="1" max="100" required value="${effective?.max_api_keys ?? SLOTLOCK_PLAN_LIMITS.free.apiKeys}">
            <label for="override-webhooks">Webhook endpoints</label><input id="override-webhooks" name="webhooks" type="number" min="1" max="1000" required value="${effective?.max_webhook_endpoints ?? SLOTLOCK_PLAN_LIMITS.free.webhookEndpoints}">
            <label for="override-operations">Operations a month <span class="hint">optional; with bookings, replaces the plan's quotas</span></label><input id="override-operations" name="operations" type="number" min="1" placeholder="${planQuotas ? String(planQuotas.operations) : ''}">
            <label for="override-bookings">Bookings a month <span class="hint">optional</span></label><input id="override-bookings" name="bookings" type="number" min="1" placeholder="${planQuotas ? String(planQuotas.bookings) : ''}">
            <input type="hidden" name="stop" value="${planQuotas?.stopPercent ?? 100}">
            <label for="override-limits-ends">Until <span class="hint">00:00 UTC that day</span></label><input id="override-limits-ends" name="ends" type="date" required value="${dateInput(30)}" min="${dateInput(1)}" max="${dateInput(400)}">
            <label for="override-limits-reason">Reason <span class="hint">the customer sees it in their audit log</span></label><input id="override-limits-reason" name="reason" required maxlength="200" autocomplete="off">
            <button class="btn" type="submit">Raise the limits</button></form></details>`
        : ''}
      ${may('plans.approve') && approvable.length
        ? html`<details class="act wide"><summary>Approve an override</summary><form class="pop form" method="post" action="/overrides/approve">${csrf}
            <label for="account-approve">Override</label><select id="account-approve" name="override">${approvable.map((item) => html`<option value="${item.id}">${item.plan ?? 'Limits'} until ${day(item.ends_at)} · ${item.reason}</option>`)}</select>
            <p>Four eyes: the Owner who asked cannot approve it.</p><button class="btn" type="submit">Approve</button></form></details>`
        : ''}
      ${may('billing.act') && live.length
        ? html`<details class="act wide"><summary>End or withdraw an override</summary><form class="pop form" method="post" action="/overrides/end">${csrf}
            <label for="account-end-override">Override</label><select id="account-end-override" name="override">${live.map((item) => html`<option value="${item.id}">${item.plan ?? 'Limits'} until ${day(item.ends_at)}</option>`)}</select>
            <label for="account-end-reason">Reason <span class="hint">the customer sees it</span></label><input id="account-end-reason" name="reason" required maxlength="200" autocomplete="off">
            <button class="btn danger" type="submit">End it</button></form></details>`
        : ''}
      ${stripeCustomer
        ? html`<h3 class="subhead">In Stripe</h3>${customer
            ? html`${table('Subscriptions', ['Subscription', 'Status', 'A month', 'Renews'], customer.subscriptions.map((item) => [
                html`<a class="mono" href="${stripeLink(item.id)}" rel="noreferrer">${item.id}</a>`,
                item.status === 'active' ? pill('Active', 'good') : item.status === 'past_due' ? pill('Past due', 'warn') : pill(item.status, 'muted'),
                html`${slotlockMoney(item.monthly, item.currency)}`,
                html`${item.currentPeriodEnd ? day(new Date(item.currentPeriodEnd * 1000)) : '–'}${item.cancelAtPeriodEnd ? html`<span class="sub">Cancels then</span>` : ''}`,
              ]), 'No subscriptions.')}
              ${table('Invoices', ['Invoice', 'Status', 'Due', 'Paid', 'Date'], customer.invoices.map((item) => [
                html`<a class="mono" href="${stripeLink(item.id)}" rel="noreferrer">${item.number ?? item.id}</a>`,
                item.status === 'paid' ? pill('Paid', 'good') : item.status === 'open' ? pill('Open', 'warn') : pill(item.status ?? 'draft', 'muted'),
                html`${slotlockMoney(item.amountDue, item.currency)}`,
                html`${slotlockMoney(item.amountPaid, item.currency)}`,
                html`${day(new Date(item.created * 1000))}`,
              ]), 'No invoices.')}
              <p class="fine">Read from Stripe ${when(new Date(customer.readAt))}, kept for an hour. Refunds and disputes stay in Stripe.</p>`
            : html`<p class="fine">${stripe ? 'Stripe could not be read just now.' : 'Stripe is not connected to the console.'} <a href="https://dashboard.stripe.com/customers/${encodeURIComponent(stripeCustomer)}" rel="noreferrer">Open the customer in Stripe</a>.</p>`}`
        : ''}`;
  }

  // ---------- Site, communications and system (Phase 6) ----------
  const insights = createSlotlockAdminInsights({ ...(options.insights ?? {}), fetch: fetcher, now });
  const siteUrl = (options.cms?.siteUrl ?? 'https://slotlock.pylota.io').replace(/\/$/, '');
  const hostUrls = {
    api: options.hosts?.api ?? 'https://slotlock-api.pylota.io/healthz',
    dashboard: options.hosts?.dashboard ?? 'https://app.slotlock.pylota.io/dashboard',
  };
  /** The workflows whose runs on main the System page lists as deploys. */
  const DEPLOY_WORKFLOWS = [
    { workflow: 'site.yml', label: 'Site' },
    { workflow: 'dashboard.yml', label: 'Dashboard and console Workers' },
    { workflow: 'image.yml', label: 'Server image' },
    { workflow: 'release.yml', label: 'Releases' },
  ] as const;

  /** A provider's part of a page: off without it, failed when it could not be read, else its hour's read. */
  async function providerRead<T>(session: Session, key: string, read: (() => Promise<T>) | null): Promise<SlotlockProviderRead<T>> {
    if (!read) return { state: 'off' };
    const value = await cached(session, key, read);
    return value === null ? { state: 'failed' } : { state: 'ok', value };
  }
  /** Staff references and their GitHub logins, for a page that names who did what. */
  const namesOf = async (refs: readonly string[]) => {
    const unique = [...new Set(refs)];
    const names = await staffNames(unique);
    return new Map(unique.map((ref, index) => [ref, names[index] ?? ref]));
  };

  async function sitePage(session: Session): Promise<Response> {
    const [google, bing, visits, deploys] = await Promise.all([
      providerRead(session, 'site:google', insights.google),
      providerRead(session, 'site:bing', insights.bing),
      providerRead(session, 'site:visits', insights.visits),
      providerRead(session, 'site:deploys', github ? () => github.workflowRuns('site.yml', 5) : null),
    ]);
    await record(session.t, 'page.viewed', null, '/site');
    return page(session, 'Site and search', '/site', slotlockSitePage({ siteUrl, google, bing, visits, deploys }));
  }

  async function communicationsPage(session: Session, url: URL): Promise<Response> {
    const sql = options.sql();
    const endedToo = url.searchParams.get('ended') === '1';
    const account = (url.searchParams.get('account') ?? '').trim().slice(0, 500) || null;
    const rows = await sql<SlotlockAnnouncementRow[]>`SELECT * FROM slotlock.admin_announcements(${session.t}, ${endedToo})`;
    let incidents: SlotlockProviderRead<{ open: Awaited<ReturnType<SlotlockCmsGitHub['statusIssues']>>; closed: Awaited<ReturnType<SlotlockCmsGitHub['statusIssues']>> }> = { state: 'off' };
    if (github) {
      try {
        const [open, closed] = await Promise.all([github.statusIssues('open'), github.statusIssues('closed')]);
        incidents = { state: 'ok', value: { open, closed } };
      } catch (error) {
        console.error('slotlock-admin status page read failed', (error as { status?: unknown } | null)?.status ?? 'unknown');
        incidents = { state: 'failed' };
      }
    }
    const body = slotlockCommunicationsPage({
      csrf: csrfOf(session),
      mayAct: slotlockStaffMay(session.r, 'system.act'),
      announcements: rows,
      endedToo,
      account,
      incidents,
      names: await namesOf(rows.map((row) => row.created_by)),
      now: now(),
    }, accountHref);
    return page(session, 'Communications', '/communications', body, undefined, noticeOf(url));
  }

  /** Each host as it answers now: the API's readiness and version, the dashboard's sign-in page. */
  async function hostHealth(): Promise<SlotlockHostHealth[]> {
    const ask = async (name: string, target: string, api: boolean): Promise<SlotlockHostHealth> => {
      const started = now();
      try {
        const response = await fetcher(target, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { Accept: api ? 'application/json' : 'text/html' } });
        let version: string | null = null;
        let up = response.status === 200;
        let answer = `HTTP ${response.status}`;
        if (api) {
          const body = (await response.json().catch(() => ({}))) as { status?: unknown; version?: unknown };
          version = typeof body.version === 'string' ? body.version.slice(0, 40) : null;
          up = response.status === 200 && body.status === 'ready';
          if (!up && response.status === 200) answer = 'not ready';
        } else {
          await response.body?.cancel();
        }
        return { name, url: target, up, answer: up ? 'ok' : answer, version, ms: now() - started };
      } catch {
        return { name, url: target, up: false, answer: 'no answer in five seconds', version: null, ms: now() - started };
      }
    };
    return Promise.all([
      ask('API', hostUrls.api, true),
      ask('Dashboard', hostUrls.dashboard, false),
      ask('Site', `${siteUrl}/`, false),
    ]);
  }

  async function systemPage(session: Session, url: URL): Promise<Response> {
    const sql = options.sql();
    const [[systemRow], [flagsRow], hosts, deploys] = await Promise.all([
      sql<{ system: SlotlockSystemData }[]>`SELECT slotlock.admin_system(${session.t}) AS system`,
      sql<{ flags: SlotlockFlagsData }[]>`SELECT slotlock.admin_flags(${session.t}) AS flags`,
      hostHealth(),
      providerRead(session, 'system:deploys', github
        ? async () => Promise.all(DEPLOY_WORKFLOWS.map(async (entry) => ({ ...entry, runs: await github.workflowRuns(entry.workflow, 3) })))
        : null),
    ]);
    const flags = flagsRow?.flags ?? { flags: [], history: [] };
    const connected = (value: unknown) => (value ? 'connected' : 'not set');
    const body = slotlockSystemPage({
      csrf: csrfOf(session),
      mayAct: slotlockStaffMay(session.r, 'system.act'),
      system: systemRow?.system as SlotlockSystemData,
      flags,
      hosts,
      deploys,
      configuration: [
        { name: 'Console', value: origin },
        { name: 'Site', value: siteUrl },
        { name: 'API health', value: hostUrls.api },
        { name: 'Dashboard', value: hostUrls.dashboard },
        { name: 'Cloudflare Access', value: options.access ? 'checked on every request' : 'off (local only)' },
        { name: 'Stripe (read-only key)', value: connected(options.stripeKey) },
        { name: 'GitHub App (CMS, status, deploys)', value: options.cms ? `connected to ${options.cms.repository}` : 'not set' },
        { name: 'Preview deploys', value: options.cms?.previewHost ?? 'not set' },
        { name: 'Search Console', value: options.insights?.google ? `connected to ${options.insights.google.property}` : 'not set' },
        { name: 'Bing Webmaster Tools', value: options.insights?.bing ? `connected to ${options.insights.bing.site}` : 'not set' },
        { name: 'Cloudflare Web Analytics', value: connected(options.insights?.cloudflare) },
      ],
      names: await namesOf([...flags.flags.map((flag) => flag.set_by), ...flags.history.map((event) => event.staff_ref)]),
      now: now(),
    }, accountHref);
    return page(session, 'System', '/system', body, undefined, noticeOf(url));
  }

  /** A datetime-local value from a form, read as UTC; null when empty, undefined when not one. */
  const minuteOf = (value: string): Date | null | undefined => {
    if (value === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
    const at = new Date(`${value}:00Z`);
    return Number.isNaN(at.getTime()) ? undefined : at;
  };

  // ---------- Actions ----------
  interface Action {
    capability: SlotlockStaffCapability;
    /** The page the browser goes back to, which shows what happened; or the one the form names. */
    back: string | ((form: URLSearchParams) => string);
    run(form: URLSearchParams): Promise<{ code: keyof typeof NOTICES; ok: boolean; to?: string }>;
  }

  const field = (form: URLSearchParams, name: string) => (form.get(name) ?? '').trim();
  /** Text that may span lines, with Windows line ends made plain. */
  const lines = (form: URLSearchParams, name: string) => field(form, name).replace(/\r\n?/g, '\n');
  const optional = (value: string) => (value === '' ? null : value);

  /** Each form's route: what it needs, where it goes back to, and the admin function it calls. */
  function actionOf(path: string, session: Session): Action | null {
    const sql = options.sql();
    const onAccount = /^\/accounts\/([^/]+)\/(suspend|unsuspend|keys\/revoke|sessions\/end|notes|overrides)$/.exec(path);
    if (onAccount) {
      let ref: string;
      try {
        ref = decodeURIComponent(onAccount[1] ?? '');
      } catch {
        return null;
      }
      const back = accountHref(ref);
      switch (onAccount[2]) {
        case 'suspend':
          return {
            capability: 'safety.act',
            back,
            async run(form) {
              const linked = /^[1-9][0-9]{0,17}$/.test(field(form, 'case')) ? field(form, 'case') : null;
              const [row] = await sql<{ ok: boolean }[]>`
                SELECT slotlock.admin_suspend(${session.t}, ${ref}, ${field(form, 'reason')}, ${optional(field(form, 'message'))}, ${linked}::bigint) AS ok`;
              return row?.ok ? { code: 'suspended', ok: true } : { code: 'already_suspended', ok: false };
            },
          };
        case 'unsuspend':
          return {
            capability: 'safety.act',
            back,
            async run(form) {
              const [row] = await sql<{ ok: boolean }[]>`
                SELECT slotlock.admin_unsuspend(${session.t}, ${ref}, ${field(form, 'reason')}) AS ok`;
              return row?.ok ? { code: 'unsuspended', ok: true } : { code: 'not_suspended', ok: false };
            },
          };
        case 'keys/revoke':
          return {
            capability: 'accounts.act',
            back,
            async run(form) {
              const key = field(form, 'key');
              if (!UUID.test(key)) return { code: 'invalid', ok: false };
              const [row] = await sql<{ ok: boolean }[]>`
                SELECT slotlock.admin_revoke_key(${session.t}, ${ref}, ${key}::uuid, ${field(form, 'reason')}) AS ok`;
              return row?.ok ? { code: 'key_revoked', ok: true } : { code: 'key_unchanged', ok: false };
            },
          };
        case 'sessions/end':
          return {
            capability: 'accounts.act',
            back,
            async run(form) {
              const handle = field(form, 'session');
              if (handle !== 'all' && !/^[0-9a-f]{16}$/.test(handle)) return { code: 'invalid', ok: false };
              const [row] = await sql<{ ended: number }[]>`
                SELECT slotlock.admin_end_sessions(${session.t}, ${ref}, ${handle === 'all' ? null : handle}, ${field(form, 'reason')}) AS ended`;
              return handle !== 'all' && Number(row?.ended ?? 0) === 0
                ? { code: 'session_gone', ok: false }
                : { code: 'sessions_ended', ok: true };
            },
          };
        case 'overrides':
          return {
            capability: 'billing.act',
            back,
            async run(form) {
              const ends = /^\d{4}-\d{2}-\d{2}$/.test(field(form, 'ends')) ? Date.parse(`${field(form, 'ends')}T00:00:00Z`) : Number.NaN;
              if (!Number.isFinite(ends)) return { code: 'invalid', ok: false };
              if (ends - now() > SLOTLOCK_OVERRIDE_SOLO_DAYS * DAY_MS && !slotlockStaffMay(session.r, 'plans.approve')) {
                return { code: 'override_needs_owner', ok: false };
              }
              const whole = (name: string) => (/^[1-9][0-9]{0,12}$/.test(field(form, name)) ? Number(field(form, name)) : null);
              let plan: SlotlockPlan | null = null;
              let limits: [number | null, number | null, number | null];
              let quotas: [number | null, number | null, number | null] = [null, null, null];
              if (field(form, 'kind') === 'plan') {
                if (!(PLANS as readonly string[]).includes(field(form, 'plan'))) return { code: 'invalid', ok: false };
                plan = field(form, 'plan') as SlotlockPlan;
                const given = SLOTLOCK_PLAN_LIMITS[plan];
                limits = [given.resources, given.apiKeys, given.webhookEndpoints];
              } else {
                limits = [whole('resources'), whole('keys'), whole('webhooks')];
                const operations = whole('operations');
                const bookings = whole('bookings');
                if ((operations === null) !== (bookings === null)) return { code: 'invalid', ok: false };
                // Where the account's plan stops (the form carries it), so a raised quota stops there too.
                const stop = whole('stop');
                if (operations !== null) {
                  if (stop === null || stop < 100 || stop > 1000) return { code: 'invalid', ok: false };
                  quotas = [operations, bookings, stop];
                }
              }
              if (limits.some((value) => value === null)) return { code: 'invalid', ok: false };
              await sql`
                SELECT slotlock.admin_override_create(${session.t}, ${ref}, ${plan}, ${limits[0]}, ${limits[1]}, ${limits[2]},
                  ${quotas[0]}, ${quotas[1]}, ${quotas[2]}, ${new Date(ends)}, ${field(form, 'reason')})`;
              return ends - now() > SLOTLOCK_OVERRIDE_SOLO_DAYS * DAY_MS
                ? { code: 'override_requested', ok: true }
                : { code: 'override_given', ok: true };
            },
          };
        default:
          return {
            capability: 'accounts.act',
            back,
            async run(form) {
              await sql`SELECT slotlock.admin_add_note(${session.t}, ${ref}, ${lines(form, 'note')})`;
              return { code: 'note_added', ok: true };
            },
          };
      }
    }
    // Forms on the Billing page and on an account's: they go back to the page they came from.
    const backOf = (form: URLSearchParams) => {
      const asked = field(form, 'back');
      return LOCAL_PATH.test(asked) && (asked === '/billing' || asked.startsWith('/accounts/')) ? asked : '/billing';
    };
    const idOf = (form: URLSearchParams, name: string) => (/^[1-9][0-9]{0,17}$/.test(field(form, name)) ? field(form, name) : null);
    if (path === '/overrides/approve') {
      return {
        capability: 'plans.approve',
        back: backOf,
        async run(form) {
          const id = idOf(form, 'override');
          if (!id) return { code: 'invalid', ok: false };
          const [row] = await sql<{ result: string }[]>`SELECT slotlock.admin_override_approve(${session.t}, ${id}::bigint) AS result`;
          if (row?.result === 'approved') return { code: 'override_approved', ok: true };
          return { code: row?.result === 'own' ? 'override_own' : 'override_not_pending', ok: false };
        },
      };
    }
    if (path === '/overrides/end') {
      return {
        capability: 'billing.act',
        back: backOf,
        async run(form) {
          const id = idOf(form, 'override');
          if (!id) return { code: 'invalid', ok: false };
          const [row] = await sql<{ ok: boolean }[]>`SELECT slotlock.admin_override_end(${session.t}, ${id}::bigint, ${field(form, 'reason')}) AS ok`;
          return row?.ok ? { code: 'override_ended', ok: true } : { code: 'override_unchanged', ok: false };
        },
      };
    }
    if (path === '/billing/alerts/resolve') {
      return {
        capability: 'billing.act',
        back: backOf,
        async run(form) {
          const id = idOf(form, 'alert');
          if (!id) return { code: 'invalid', ok: false };
          const [row] = await sql<{ ok: boolean }[]>`SELECT slotlock.admin_billing_alert_resolve(${session.t}, ${id}::bigint, ${field(form, 'reason')}) AS ok`;
          return row?.ok ? { code: 'alert_resolved', ok: true } : { code: 'alert_unchanged', ok: false };
        },
      };
    }
    if (path === '/cases') {
      return {
        capability: 'safety.act',
        back: '/cases',
        async run(form) {
          const [row] = await sql<{ id: string }[]>`
            SELECT slotlock.admin_case_open(${session.t}, ${optional(field(form, 'account'))}, ${field(form, 'source')},
              ${field(form, 'summary')}, ${optional(field(form, 'section'))}, ${optional(lines(form, 'evidence'))}) AS id`;
          return { code: 'case_opened', ok: true, to: `/cases/${String(row?.id)}` };
        },
      };
    }
    if (path === '/privacy') {
      return {
        capability: 'privacy.act',
        back: '/privacy',
        async run(form) {
          const received = field(form, 'received');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(received)) return { code: 'privacy_invalid', ok: false };
          try {
            const [row] = await sql<{ id: string }[]>`
              SELECT slotlock.admin_privacy_open(${session.t}, ${field(form, 'account')}, ${field(form, 'kind')},
                ${field(form, 'concerns')}, ${received}::date, ${field(form, 'reference')}) AS id`;
            return { code: 'privacy_opened', ok: true, to: `/privacy/${String(row?.id)}` };
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code === '22023') return { code: 'privacy_invalid', ok: false };
            throw error;
          }
        },
      };
    }
    // Phase 6: announcements, the status page and feature flags (system.act, the Owner).
    if (path === '/communications') {
      return {
        capability: 'system.act',
        back: '/communications',
        async run(form) {
          const audience = field(form, 'audience');
          const kind = field(form, 'kind');
          const starts = minuteOf(field(form, 'starts'));
          const ends = minuteOf(field(form, 'ends'));
          if (!(SLOTLOCK_ANNOUNCEMENT_AUDIENCES as readonly string[]).includes(audience)
            || !(SLOTLOCK_ANNOUNCEMENT_KINDS as readonly string[]).includes(kind) || starts === undefined || !ends) {
            return { code: 'announcement_invalid', ok: false };
          }
          const plan = audience === 'plan' ? field(form, 'plan') : null;
          const account = audience === 'account' ? field(form, 'account') : null;
          try {
            await sql`SELECT slotlock.admin_announce(${session.t}, ${audience}, ${plan}, ${account}, ${kind},
              ${field(form, 'message')}, ${optional(field(form, 'link'))}, ${starts}, ${ends})`;
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code === '22023') return { code: 'announcement_invalid', ok: false };
            throw error;
          }
          return { code: 'announced', ok: true };
        },
      };
    }
    if (path === '/communications/end') {
      return {
        capability: 'system.act',
        back: '/communications',
        async run(form) {
          const id = idOf(form, 'announcement');
          if (!id) return { code: 'invalid', ok: false };
          const [row] = await sql<{ ok: boolean }[]>`SELECT slotlock.admin_announcement_end(${session.t}, ${id}::bigint) AS ok`;
          return row?.ok ? { code: 'announcement_ended', ok: true } : { code: 'announcement_unchanged', ok: false };
        },
      };
    }
    if (path === '/communications/status' || path === '/communications/status/update') {
      const opening = path === '/communications/status';
      return {
        capability: 'system.act',
        back: '/communications',
        async run(form) {
          if (!github) return { code: 'status_unavailable', ok: false };
          const text = lines(form, 'body');
          if (text.length < 1 || text.length > 2000) return { code: 'incident_invalid', ok: false };
          if (opening) {
            const title = field(form, 'title');
            if (title.length < 1 || title.length > 120 || /\p{Cc}/u.test(title)) return { code: 'incident_invalid', ok: false };
            // Recorded before GitHub is asked, as the CMS's steps are.
            await sql`SELECT slotlock.admin_status_record(${session.t}, 'status.opened', ${null}, ${sql.json({ title })})`;
            await github.openStatusIssue({ title, body: text });
            return { code: 'incident_opened', ok: true };
          }
          const issue = Number(field(form, 'issue'));
          if (!Number.isSafeInteger(issue) || issue < 1 || issue > 2_147_483_647) return { code: 'invalid', ok: false };
          const close = form.get('close') === '1';
          await sql`SELECT slotlock.admin_status_record(${session.t}, ${close ? 'status.closed' : 'status.updated'}, ${issue}::integer, ${sql.json({ length: text.length })})`;
          const posted = await github.updateStatusIssue({ number: issue, body: text, close });
          if (!posted) return { code: 'incident_unchanged', ok: false };
          return { code: close ? 'incident_closed' : 'incident_updated', ok: true };
        },
      };
    }
    if (path === '/system/flags') {
      return {
        capability: 'system.act',
        back: '/system',
        async run(form) {
          const flag = field(form, 'flag');
          const plan = optional(field(form, 'plan'));
          const account = plan ? null : optional(field(form, 'account'));
          if (!(SLOTLOCK_FEATURE_FLAGS as readonly string[]).includes(flag) || (plan && !(SLOTLOCK_STAFF_PLANS as readonly string[]).includes(plan))
            || (!plan && !account) || !['0', '1'].includes(field(form, 'enabled'))) {
            return { code: 'flag_invalid', ok: false };
          }
          try {
            await sql`SELECT slotlock.admin_flag_set(${session.t}, ${flag}, ${plan}, ${account}, ${field(form, 'enabled') === '1'}, ${field(form, 'reason')})`;
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code === '22023') return { code: 'flag_invalid', ok: false };
            throw error;
          }
          return { code: 'flag_set', ok: true };
        },
      };
    }
    if (path === '/system/flags/clear') {
      return {
        capability: 'system.act',
        back: '/system',
        async run(form) {
          const id = idOf(form, 'flag');
          if (!id) return { code: 'invalid', ok: false };
          const [row] = await sql<{ ok: boolean }[]>`SELECT slotlock.admin_flag_clear(${session.t}, ${id}::bigint, ${field(form, 'reason')}) AS ok`;
          return row?.ok ? { code: 'flag_cleared', ok: true } : { code: 'flag_unchanged', ok: false };
        },
      };
    }
    const onPrivacy = /^\/privacy\/([1-9][0-9]{0,17})\/(verify|export|erasure\/ask|erasure\/approve|erase|close)$/.exec(path);
    if (onPrivacy) {
      const id = onPrivacy[1] as string;
      const back = `/privacy/${id}`;
      const step = onPrivacy[2] as string;
      const outcomeOf: Record<string, { code: keyof typeof NOTICES; ok: boolean }> = {
        verified: { code: 'privacy_verified', ok: true },
        not_found: { code: 'privacy_not_verified', ok: false },
        started: { code: 'privacy_export_started', ok: true },
        in_progress: { code: 'privacy_export_busy', ok: false },
        limit: { code: 'privacy_export_limit', ok: false },
        not_verified: { code: 'privacy_needs_verifying', ok: false },
        asked: { code: 'privacy_erasure_asked', ok: true },
        approved: { code: 'privacy_erasure_approved', ok: true },
        own: { code: 'privacy_erasure_own', ok: false },
        not_approved: { code: 'privacy_not_approved', ok: false },
        subscription_live: { code: 'privacy_subscription_live', ok: false },
        erased: { code: 'privacy_erased', ok: true },
      };
      const queries = {
        verify: () => sql<{ result: string }[]>`SELECT slotlock.admin_privacy_verify(${session.t}, ${id}::bigint) AS result`,
        export: () => sql<{ result: string }[]>`SELECT slotlock.admin_privacy_export(${session.t}, ${id}::bigint) AS result`,
        erasure_ask: () => sql<{ result: string }[]>`SELECT slotlock.admin_privacy_erasure_ask(${session.t}, ${id}::bigint) AS result`,
        erasure_approve: () => sql<{ result: string }[]>`SELECT slotlock.admin_privacy_erasure_approve(${session.t}, ${id}::bigint) AS result`,
        erase: () => sql<{ result: string }[]>`SELECT slotlock.admin_privacy_erase(${session.t}, ${id}::bigint) AS result`,
      };
      const call = (fn: keyof typeof queries) => async () => {
        const [row] = await queries[fn]();
        return outcomeOf[String(row?.result)] ?? { code: 'privacy_unchanged' as const, ok: false };
      };
      switch (step) {
        case 'verify':
          return { capability: 'privacy.act', back, run: call('verify') };
        case 'export':
          return { capability: 'privacy.act', back, run: call('export') };
        case 'erasure/ask':
          return { capability: 'privacy.erase', back, run: call('erasure_ask') };
        case 'erasure/approve':
          return { capability: 'privacy.erase', back, run: call('erasure_approve') };
        case 'erase':
          return {
            capability: 'privacy.erase',
            back,
            async run(form) {
              if (field(form, 'confirm') !== 'yes') return { code: 'invalid', ok: false };
              return call('erase')();
            },
          };
        default:
          return {
            capability: 'privacy.act',
            back,
            async run(form) {
              try {
                const [row] = await sql<{ ok: boolean }[]>`
                  SELECT slotlock.admin_privacy_close(${session.t}, ${id}::bigint, ${field(form, 'status')}, ${field(form, 'outcome')}) AS ok`;
                return row?.ok ? { code: 'privacy_closed', ok: true } : { code: 'privacy_unchanged', ok: false };
              } catch (error) {
                if ((error as { code?: unknown } | null)?.code === '22023') return { code: 'privacy_invalid', ok: false };
                throw error;
              }
            },
          };
      }
    }
    const onCase = /^\/cases\/([1-9][0-9]{0,17})$/.exec(path);
    if (onCase) {
      const id = onCase[1] as string;
      return {
        capability: 'safety.act',
        back: `/cases/${id}`,
        async run(form) {
          const status = field(form, 'status');
          const done = field(form, 'action');
          if (!['open', 'closed'].includes(status) || !(SLOTLOCK_CASE_ACTIONS as readonly string[]).includes(done)) {
            return { code: 'invalid', ok: false };
          }
          const [row] = await sql<{ ok: boolean }[]>`
            SELECT slotlock.admin_case_update(${session.t}, ${id}::bigint, ${status}, ${done}, ${optional(lines(form, 'outcome'))}) AS ok`;
          return row?.ok ? { code: 'case_updated', ok: true } : { code: 'invalid', ok: false };
        },
      };
    }
    return null;
  }

  /**
   * A form sent from a console page. The Origin was checked before this; here: a form body of a
   * sane size, the session's token, the role, and a passkey in the last 15 minutes (RFC 0006, 4.2).
   * Answered with a redirect to the page it came from, which says what happened (post, redirect,
   * get), so a reload never sends it twice.
   */
  async function act(request: Request, session: Session, path: string): Promise<Response> {
    const action = actionOf(path, session);
    if (!action) return respond('Not found', 404, {}, 'text/plain; charset=utf-8');
    if (!(request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) {
      return refused('Refused', 'That request was not one of this console’s forms.', 400);
    }
    const text = await request.text();
    if (text.length > 16 * 1024) return refused('Too large', 'That form was too large.', 413);
    const form = new URLSearchParams(text);
    const token = Buffer.from(form.get('csrf') ?? '');
    const expected = Buffer.from(csrfOf(session));
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
      return refused('Refused', 'That form expired. Reload the page and send it again.');
    }
    if (!slotlockStaffMay(session.r, action.capability)) {
      await record(session.t, 'page.refused', null, path.slice(0, 200));
      return respond(layout(shellOf(session, 'Not allowed', path), pageHead('Slotlock admin', 'Not allowed', `Your role (${session.r}) does not do this.`)), 403, { 'Set-Cookie': sessionCookie(session) });
    }
    const back = typeof action.back === 'string' ? action.back : action.back(form);
    if (!session.pv || now() - session.pv > FRESH_MS) {
      return redirect(`/passkey?${new URLSearchParams({ next: back, fresh: '1' }).toString()}`);
    }
    let outcome: { code: keyof typeof NOTICES; ok: boolean; to?: string };
    try {
      outcome = await action.run(form);
    } catch (error) {
      // A field the database refused (22023): say which kind of thing to fix, change nothing.
      if ((error as { code?: unknown } | null)?.code !== '22023') throw error;
      outcome = { code: 'invalid', ok: false };
    }
    const to = outcome.to ?? back;
    return redirect(`${to}?${new URLSearchParams({ [outcome.ok ? 'done' : 'error']: outcome.code }).toString()}`, [sessionCookie(session), noticeCookie(to, outcome.code)]);
  }

  // ---------- The CMS ----------
  /** What the CMS gets for one request: who, their token, and the shell's pages. */
  function cmsRequest(session: Session): SlotlockCmsRequest {
    const expected = Buffer.from(csrfOf(session));
    return {
      staff: session.s,
      login: session.l,
      role: session.r,
      fresh: Boolean(session.pv && now() - session.pv <= FRESH_MS),
      csrf: csrfOf(session),
      csrfOk(token) {
        const given = Buffer.from(token);
        return given.length === expected.length && timingSafeEqual(given, expected);
      },
      page: (title, path, body, notice, status = 200) =>
        respond(layout({ ...shellOf(session, title, path, undefined, notice), script: '/editor.js' }, body), status, { 'Set-Cookie': sessionCookie(session) }),
      redirect: (location) => {
        // The CMS's notices hold the same way: only on the page the action sent the browser to.
        const target = new URL(location, origin);
        const code = target.searchParams.get('done') ?? target.searchParams.get('error');
        return redirect(location, [sessionCookie(session), ...(code ? [noticeCookie(target.pathname, code)] : [])]);
      },
      json: (value, status = 200) => json(value, status, [sessionCookie(session)]),
      async record(step: SlotlockContentStep, slug: string, extra: Record<string, string | number> = {}) {
        const sql = options.sql();
        await sql`SELECT slotlock.admin_content_record(${session.t}, ${step}, ${slug}, ${sql.json(extra)})`;
      },
    };
  }

  // ---------- Routing ----------
  const needs: Record<string, SlotlockStaffCapability> = {
    '/': 'home',
    '/accounts': 'accounts.read',
    '/search': 'accounts.read',
    '/staff': 'staff.read',
    '/staff/log': 'staff.log',
    '/cases': 'safety.act',
    '/privacy': 'privacy.act',
    '/privacy/receipts': 'privacy.act',
    '/billing': 'billing.read',
    '/usage': 'accounts.read',
    '/site': 'site.read',
    '/communications': 'system.read',
    '/system': 'system.read',
  };

  /**
   * The console's own database role, checked once per isolate before it serves anything that reads
   * the database (RFC 0006, 4.4): not a superuser, not BYPASSRLS, and no right on a slotlock table,
   * view or sequence, itself or through a role it belongs to. A reason when it fails, else null.
   */
  let roleChecked: Promise<string | null> | null = null;
  function roleProblem(): Promise<string | null> {
    roleChecked ??= (async () => {
      const [row] = await options.sql()<{ privileged: boolean; tables: boolean }[]>`
        SELECT member.rolsuper OR member.rolbypassrls AS privileged,
               EXISTS (
                 SELECT 1 FROM pg_catalog.pg_class rel
                   JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
                  WHERE ns.nspname = 'slotlock'
                    AND ((rel.relkind IN ('r', 'p', 'v', 'm', 'f')
                          AND pg_catalog.has_table_privilege(rel.oid, 'SELECT, INSERT, UPDATE, DELETE'))
                         OR (rel.relkind = 'S' AND pg_catalog.has_sequence_privilege(rel.oid, 'USAGE, SELECT, UPDATE')))
               ) AS tables
          FROM pg_catalog.pg_roles member WHERE member.rolname = current_user`;
      if (!row) return 'its role could not be read';
      if (row.privileged) return 'its role is a superuser or bypasses row security';
      if (row.tables) return 'its role holds rights on slotlock tables';
      return null;
    })();
    // A database that could not be asked is asked again next time; an answer is kept.
    roleChecked.catch(() => {
      roleChecked = null;
    });
    return roleChecked;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    // A notice says what an action just did, so it shows only on the page that action sent this
    // browser to: a link from elsewhere that names one shows none.
    const shown = url.searchParams.get('done') ?? url.searchParams.get('error');
    if (shown !== null) {
      const flash = unseal<{ c: string; p: string; exp: number }>('notice', cookies(request).get(NOTICE_COOKIE));
      if (!flash || flash.c !== shown || flash.p !== path) {
        url.searchParams.delete('done');
        url.searchParams.delete('error');
      }
    }
    if (request.method === 'GET') {
      if (path === '/admin.css') return respond(SLOTLOCK_ADMIN_CSS, 200, { 'Cache-Control': 'public, max-age=300' }, 'text/css; charset=utf-8');
      if (path === '/admin.js') return respond(SLOTLOCK_ADMIN_JS, 200, { 'Cache-Control': 'public, max-age=300' }, 'text/javascript; charset=utf-8');
      if (path === '/passkey.js') return respond(SLOTLOCK_ADMIN_PASSKEY_JS, 200, { 'Cache-Control': 'public, max-age=300' }, 'text/javascript; charset=utf-8');
      if (path === '/editor.js') return respond(SLOTLOCK_ADMIN_EDITOR_JS, 200, { 'Cache-Control': 'public, max-age=300' }, 'text/javascript; charset=utf-8');
      if (path === '/healthz') return respond('ok', 200, {}, 'text/plain; charset=utf-8');
    }

    // Lock 1: Cloudflare Access, on every request that is not a static file.
    if (options.access) {
      const identity = await options.access.verify(request);
      if (!identity) return refused('Access required', 'This console is only reachable through Cloudflare Access.');
    }

    const unsafe = await roleProblem();
    if (unsafe) {
      console.error('slotlock-admin refuses to serve:', unsafe);
      return refused('Not available', 'The console is not configured safely, and serves nothing until it is.', 503);
    }

    if (request.method === 'POST') {
      // Every POST from our own pages, and from nowhere else.
      if (request.headers.get('origin') !== origin) return refused('Refused', 'That request did not come from this console.');
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      return respond('Method not allowed', 405, { Allow: 'GET, POST' }, 'text/plain; charset=utf-8');
    }

    if (request.method === 'GET' && path === '/sign-in') return signInPage();
    if (request.method === 'GET' && path === '/sign-in/github') {
      // A link from elsewhere cannot trade a full session for a half one: a signed-in member goes home.
      if (readSession(request)?.st === 'full') return redirect('/');
      return startGithub();
    }
    if (request.method === 'GET' && path === '/callback') return callback(request, url);

    // Lock 2: a GitHub sign-in that the database mapped to staff.
    const session = readSession(request);
    if (!session) {
      if (request.method === 'GET') return redirect('/sign-in', [clear(SESSION_COOKIE)]);
      return json({ error: 'Sign in again.' }, 401, [clear(SESSION_COOKIE)]);
    }

    if (request.method === 'POST' && path === '/sign-out') {
      const form = await request.formData();
      if (form.get('csrf') !== csrfOf(session)) return refused('Refused', 'That form expired. Try again.');
      // Ended in the database: the cookie, wherever it went, opens nothing from now on.
      await options.sql()`SELECT slotlock.admin_sign_out(${session.t})`;
      return redirect('/sign-in', [clear(SESSION_COOKIE)]);
    }

    if (path.startsWith('/passkey')) {
      if (request.method === 'GET' && path === '/passkey') return passkeyPage(session, url);
      if (request.method === 'POST') {
        // JSON from our own script: the custom header and type force a CORS preflight elsewhere.
        if (request.headers.get('x-slotlock-admin') !== '1' || !(request.headers.get('content-type') ?? '').startsWith('application/json')) {
          return json({ error: 'Refused.' }, 400);
        }
        let body: Record<string, unknown>;
        try {
          const text = await request.text();
          if (text.length > 64 * 1024) return json({ error: 'Too large.' }, 413);
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return json({ error: 'Not JSON.' }, 400);
        }
        if (path === '/passkey/options') return passkeyOptions(session, body);
        if (path === '/passkey/register') return passkeyRegister(request, session, body);
        if (path === '/passkey/verify') return passkeyVerify(request, session, body);
      }
      return respond('Not found', 404, {}, 'text/plain; charset=utf-8');
    }

    // Lock 3: a passkey, before any page with data.
    if (session.st !== 'full') return redirect(`/passkey?${new URLSearchParams({ next: path }).toString()}`);
    // And the database's word on the session, on every request: one ended by signing out, by the
    // member's reset or removal, or by a new console key is refused (42501, so sign in again), and
    // a role changed since sign-in applies at once.
    const [current] = await options.sql()<{ role: string | null }[]>`SELECT slotlock.admin_session(${session.t}) AS role`;
    if (current?.role && (SLOTLOCK_STAFF_ROLES as readonly string[]).includes(current.role)) session.r = current.role as SlotlockStaffRole;
    if (cms.owns(path)) {
      if (!slotlockStaffMay(session.r, 'content.write')) {
        await record(session.t, 'page.refused', null, path.slice(0, 200));
        return respond(layout(shellOf(session, 'Not allowed', path), pageHead('Slotlock admin', 'Not allowed', `Your role (${session.r}) does not open this page.`)), 403, { 'Set-Cookie': sessionCookie(session) });
      }
      return cms.handle(request, url, cmsRequest(session));
    }
    if (request.method === 'POST') return act(request, session, path);

    const accountMatch = /^\/accounts\/([^/]+)$/.exec(path);
    const caseMatch = /^\/cases\/([1-9][0-9]{0,17})$/.exec(path);
    const privacyMatch = /^\/privacy\/([1-9][0-9]{0,17})$/.exec(path);
    const capability = accountMatch ? 'accounts.read' : caseMatch ? 'safety.act' : privacyMatch ? 'privacy.act' : needs[path];
    if (!capability) {
      return respond(layout(shellOf(session, 'Not found', path), pageHead('Slotlock admin', 'Not found', 'There is no page at this address.')), 404, { 'Set-Cookie': sessionCookie(session) });
    }
    if (!slotlockStaffMay(session.r, capability)) {
      await record(session.t, 'page.refused', null, path.slice(0, 200));
      return respond(layout(shellOf(session, 'Not allowed', path), pageHead('Slotlock admin', 'Not allowed', `Your role (${session.r}) does not open this page.`)), 403, { 'Set-Cookie': sessionCookie(session) });
    }
    if (accountMatch) {
      let ref: string;
      try {
        ref = decodeURIComponent(accountMatch[1] ?? '');
      } catch {
        return refused('Not found', 'That account reference is not valid.', 404);
      }
      return account(session, ref, url);
    }
    if (caseMatch) return casePage(session, caseMatch[1] as string, url);
    if (privacyMatch) return privacyRequestPage(session, privacyMatch[1] as string, url);
    if (path === '/privacy/receipts') return privacyReceipts(session, url);
    if (path === '/privacy') return privacyPage(session, url);
    if (path === '/cases') return casesPage(session, url);
    if (path === '/billing') return billingPage(session, url);
    if (path === '/usage') return usagePage(session);
    if (path === '/site') return sitePage(session);
    if (path === '/communications') return communicationsPage(session, url);
    if (path === '/system') return systemPage(session, url);
    if (path === '/') return home(session);
    if (path === '/accounts') return accounts(session, url);
    if (path === '/search') return search(session, url);
    if (path === '/staff') return staff(session);
    return staffLog(session, url);
  }

  return {
    async fetch(request) {
      try {
        return await handle(request);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        // The database refused the role: it changed or was removed since sign-in. Sign in again.
        if (code === '42501') {
          return redirect('/sign-in', [clear(SESSION_COOKIE)]);
        }
        if (code === '22023') return refused('Not valid', 'That search or reference is not valid.', 400);
        console.error('slotlock-admin', error);
        return refused('Something went wrong', 'The console could not finish that request. It was not changed.', 500);
      }
    },
  };
}
