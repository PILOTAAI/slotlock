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
import {
  SLOTLOCK_CASE_ACTIONS,
  SLOTLOCK_STAFF_NOTE_MAX,
  SLOTLOCK_STAFF_ROLES,
  type SlotlockStaffCapability,
  type SlotlockStaffRole,
  slotlockStaffMay,
} from '../staff-ddl.js';
import type { SlotlockAccessIdentity } from './access.js';
import {
  base64urlDecode,
  base64urlEncode,
  createSlotlockPasskeyChallenge,
  verifySlotlockPasskeyAssertion,
  verifySlotlockPasskeyRegistration,
} from './webauthn.js';
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
  github: { clientId: string; clientSecret: string };
  /**
   * Cloudflare Access (createSlotlockAccessVerifier). Null only with `insecureWithoutAccess`, for a
   * test or a console on localhost; the Worker always passes one.
   */
  access: { verify(request: Request): Promise<SlotlockAccessIdentity | null> } | null;
  insecureWithoutAccess?: boolean;
  /** Reads GitHub's public profiles (logins by id and back); a token raises GitHub's rate limit. */
  githubToken?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface SlotlockAdmin {
  fetch(request: Request): Promise<Response>;
}

const SESSION_COOKIE = '__Host-slotlock-admin';
const OAUTH_COOKIE = '__Host-slotlock-admin-oauth';
const PASSKEY_COOKIE = '__Host-slotlock-admin-passkey';
const SESSION_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
/** A passkey sign-in this recent lets a member register another passkey. */
const FRESH_MS = 15 * 60 * 1000;
const PAGE = 50;
const GITHUB_CACHE_MS = 60 * 60 * 1000;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** A person's account, whose dashboard sessions staff can see and end. */
const PERSON_REF = /^(github:[1-9][0-9]{0,19}|google:[A-Za-z0-9._-]{1,255})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
  sessions_ended: { kind: 'done', text: 'Signed out.' },
  session_gone: { kind: 'warn', text: 'That session had ended already.' },
  note_added: { kind: 'done', text: 'Note added.' },
  case_opened: { kind: 'done', text: 'Case opened.' },
  case_updated: { kind: 'done', text: 'Case saved.' },
  invalid: { kind: 'warn', text: 'Check the form: a reason is 1 to 200 characters on one line, and every required field is filled.' },
});

/** What was done about a case, in words. */
const CASE_ACTION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  none: 'Nothing yet',
  warned: 'Warned',
  keys_revoked: 'Keys revoked',
  suspended: 'Suspended',
  other: 'Other',
});

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
  if (options.access === null && !options.insecureWithoutAccess) {
    throw new Error('the admin console needs Cloudflare Access (SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN and SLOTLOCK_ADMIN_ACCESS_AUD)');
  }
  const now = options.now ?? (() => Date.now());
  const fetcher = options.fetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const githubCache = new Map<string, { value: { id: string; login: string; type: string } | null; until: number }>();

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
    if (now() - session.seen > IDLE_MS) return null;
    return session;
  }
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
      });
      if (response.ok) {
        const body = (await response.json()) as { id?: unknown; login?: unknown; type?: unknown };
        if (typeof body.id === 'number' && typeof body.login === 'string') {
          value = { id: String(body.id), login: body.login, type: typeof body.type === 'string' ? body.type : 'User' };
        }
      }
    } catch {
      value = null;
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
    ...(slotlockStaffMay(session.r, 'safety.act') ? [{ href: '/cases', label: 'Cases' }] : []),
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
  const staffNames = (refs: readonly string[]) =>
    Promise.all(refs.map(async (ref) => (ref.startsWith('github:') ? ((await loginOf(ref)) ?? ref) : ref)));

  const kindPill = (kind: string) => pill(kind, kind === 'test' ? 'warn' : 'muted');
  const planPill = (plan: string | null) =>
    pill(plan ?? 'free', plan === 'team' ? 'good' : plan === 'developer' ? 'info' : 'muted');
  const statusPill = (suspended: boolean, planStatus: string | null) =>
    suspended ? pill('Suspended', 'bad') : planStatus === 'past_due' ? pill('Past due', 'warn') : pill('Active', 'good');
  const accountHref = (ref: string) => `/accounts/${encodeURIComponent(ref)}`;

  async function home(session: Session): Promise<Response> {
    const sql = options.sql();
    const [row] = await sql<{ home: Record<string, number | { day: string; count: number }[]> }[]>`
      SELECT slotlock.admin_home(${session.s}) AS home`;
    const n = (key: string) => Number(row?.home[key] ?? 0);
    const change = (current: number, previous: number) =>
      previous === 0 ? null : `${current >= previous ? '+' : ''}${Math.round(((current - previous) / previous) * 100)}% on last month`;
    const signups = (row?.home.signups as { day: string; count: number }[] | undefined) ?? [];
    const attention = [
      ...(n('suspended') > 0 ? [html`<li><a href="/accounts?status=suspended">${count(n('suspended'))} suspended ${n('suspended') === 1 ? 'account' : 'accounts'}</a> <span class="sub">Check each has a case and a reason.</span></li>`] : []),
      ...(n('past_due') > 0 ? [html`<li>${count(n('past_due'))} ${n('past_due') === 1 ? 'payment' : 'payments'} past due <span class="sub">Stripe retries; the plan ends if it fails.</span></li>`] : []),
      ...(n('cases_open') > 0 && slotlockStaffMay(session.r, 'safety.act')
        ? [html`<li><a href="/cases">${count(n('cases_open'))} open ${n('cases_open') === 1 ? 'case' : 'cases'}</a> <span class="sub">Each needs an action and an outcome.</span></li>`]
        : []),
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
    const githubFor = url.searchParams.get('for');
    const sql = options.sql();
    const rows = await sql<{
      account_ref: string; kind: string; name: string | null; created_at: Date | null; last_active: Date | null;
      plan: string; plan_status: string | null; suspended: boolean; operations_month: string; bookings_month: string;
    }[]>`SELECT * FROM slotlock.admin_accounts(${session.s}, ${q || null}, ${plan}, ${status}, ${after}, ${PAGE})`;
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
    const [row] = await sql<{ account: Record<string, unknown> | null }[]>`SELECT slotlock.admin_account(${session.s}, ${ref}) AS account`;
    const data = row?.account;
    if (!data) {
      return respond(layout(shellOf(session, 'Not found', '/accounts'), html`${pageHead('Accounts', 'No such account', html`No account has the reference <code>${ref}</code>.`)}`), 404, { 'Set-Cookie': sessionCookie(session) });
    }
    const person = PERSON_REF.test(ref);
    const act = slotlockStaffMay(session.r, 'accounts.act');
    const safety = slotlockStaffMay(session.r, 'safety.act');
    const [keys, usage, audit, login, sessions, notes, cases] = await Promise.all([
      sql<{ id: string; name: string; prefix: string; scopes: string[]; created_at: Date; expires_at: Date | null; last_used_at: Date | null; revoked_at: Date | null }[]>`
        SELECT * FROM slotlock.admin_account_keys(${session.s}, ${ref})`,
      sql<{ day: Date; metric: string; count: string }[]>`SELECT * FROM slotlock.admin_account_usage(${session.s}, ${ref}, 30)`,
      sql<{ occurred_at: Date; action: string; actor_type: string; actor_ref: string; target_type: string | null; target_ref: string | null; outcome: string; reason: string | null }[]>`
        SELECT * FROM slotlock.admin_account_audit(${session.s}, ${ref}, 50)`,
      loginOf(ref),
      person
        ? sql<{ handle: string; started_at: Date; last_seen_at: Date; expires_at: Date }[]>`
            SELECT * FROM slotlock.admin_account_sessions(${session.s}, ${ref})`
        : Promise.resolve([]),
      sql<{ id: string; staff_ref: string; body: string; created_at: Date }[]>`SELECT * FROM slotlock.admin_account_notes(${session.s}, ${ref})`,
      safety
        ? sql<CaseRow[]>`SELECT * FROM slotlock.admin_cases(${session.s}, ${null}, ${ref}, ${null}, ${20})`
        : Promise.resolve([] as CaseRow[]),
    ]);
    const authors = await staffNames(notes.map((note) => note.staff_ref));
    const limits = (data.limits ?? null) as Record<string, number> | null;
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
        html`${stripe ? html`<a class="btn" href="https://dashboard.stripe.com/customers/${encodeURIComponent(stripe)}" rel="noreferrer">Open in Stripe</a>` : ''}${safety ? html`<a class="btn ${suspended ? '' : 'danger'}" href="#danger">${suspended ? 'Lift suspension' : 'Suspend'}</a>` : ''}`)}
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
      SELECT * FROM slotlock.admin_cases(${session.s}, ${status === 'all' ? null : status}, ${null}, ${after}, ${PAGE})`;
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
    const [row] = await options.sql()<{ found: Record<string, unknown> | null }[]>`SELECT slotlock.admin_case(${session.s}, ${id}::bigint) AS found`;
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

  async function staff(session: Session): Promise<Response> {
    const rows = await options.sql()<{ staff_ref: string; role: string; status: string; added_by: string; added_at: Date; last_seen_at: Date | null; passkeys: number; enrolling: boolean }[]>`
      SELECT * FROM slotlock.admin_staff(${session.s})`;
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
      SELECT * FROM slotlock.admin_staff_log(${session.s}, ${before === null ? null : before.toString()}, ${PAGE})`;
    const last = rows.at(-1)?.chain_index;
    const body = html`
      ${pageHead('Slotlock Cloud', 'Staff log', 'Every sign-in, every view of an account and every staff action, newest first. It only grows, and each entry is chained to the one before by SHA-256.')}
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
        await record(session.s, 'search.github_lookup', null, q.slice(0, 200));
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
    const [row] = await options.sql()<{ role: string | null }[]>`SELECT slotlock.admin_sign_in(${staffRef}) AS role`;
    const role = row?.role;
    if (!role || !(SLOTLOCK_STAFF_ROLES as readonly string[]).includes(role)) {
      return refused('Not staff', `GitHub account ${user.login} is not on the Slotlock staff. The attempt was recorded.`);
    }
    // Half signed in: enough to reach the passkey step, for 15 minutes. The passkey starts the 8 hours.
    const session: Session = { s: staffRef, l: user.login, r: role as SlotlockStaffRole, st: 'github', iat: now(), seen: now(), exp: now() + FRESH_MS };
    return redirect('/passkey', [clear(OAUTH_COOKIE), sessionCookie(session)]);
  }

  async function passkeyPage(session: Session, url: URL): Promise<Response> {
    const keys = await options.sql()<{ credential_id: Buffer }[]>`SELECT credential_id FROM slotlock.admin_passkeys(${session.s})`;
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
    const keys = await options.sql()<{ credential_id: Buffer }[]>`SELECT credential_id FROM slotlock.admin_passkeys(${session.s})`;
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
    return json(publicKey, 200, [cookie(PASSKEY_COOKIE, seal('passkey', { c: challenge, p: purpose, s: session.s, exp: now() + 5 * 60 * 1000 }), 300)]);
  }

  function pendingChallenge(request: Request, session: Session, purpose: 'create' | 'get'): string | null {
    const pending = unseal<{ c: string; p: string; s: string; exp: number }>('passkey', cookies(request).get(PASSKEY_COOKIE));
    return pending && pending.p === purpose && pending.s === session.s ? pending.c : null;
  }

  async function passkeyRegister(request: Request, session: Session, body: Record<string, unknown>): Promise<Response> {
    const challenge = pendingChallenge(request, session, 'create');
    if (!challenge) return json({ error: 'The request expired. Try again.' }, 400);
    const sql = options.sql();
    const keys = await sql<{ credential_id: Buffer }[]>`SELECT credential_id FROM slotlock.admin_passkeys(${session.s})`;
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
      await record(session.s, 'staff.passkey_refused', null, null, { step: 'register', code: (error as { code?: string }).code ?? 'invalid' });
      return json({ error: 'The passkey could not be checked. Try again.' }, 400);
    }
    // The id the browser reported is the one the authenticator attested.
    if (typeof body.id === 'string' && body.id !== base64urlEncode(verified.credentialId)) {
      return json({ error: 'The passkey could not be checked. Try again.' }, 400);
    }
    const [row] = await sql<{ ok: boolean }[]>`
      SELECT slotlock.admin_passkey_enroll(${session.s}, ${adding ? null : createHash('sha256').update(code).digest()},
        ${Buffer.from(verified.credentialId)}, ${Buffer.from(verified.publicKey)}, ${verified.algorithm}, ${verified.signCount}, ${name}) AS ok`;
    if (!row?.ok) return json({ error: adding ? 'That passkey was refused.' : 'That code is wrong or spent. Ask an owner for a new one.' }, 403);
    const upgraded: Session = { ...session, st: 'full', pv: now(), exp: session.st === 'full' ? session.exp : now() + SESSION_MS };
    return json({ ok: true }, 200, [clear(PASSKEY_COOKIE), sessionCookie(upgraded)]);
  }

  async function passkeyVerify(request: Request, session: Session, body: Record<string, unknown>): Promise<Response> {
    const challenge = pendingChallenge(request, session, 'get');
    if (!challenge) return json({ error: 'The request expired. Try again.' }, 400);
    const sql = options.sql();
    const keys = await sql<{ credential_id: Buffer; public_key: Buffer; algorithm: number }[]>`
      SELECT credential_id, public_key, algorithm FROM slotlock.admin_passkeys(${session.s})`;
    const id = typeof body.id === 'string' ? body.id : '';
    const key = keys.find((candidate) => base64urlEncode(new Uint8Array(candidate.credential_id)) === id);
    if (!key || (key.algorithm !== -7 && key.algorithm !== -257)) {
      await record(session.s, 'staff.passkey_refused', null, null, { step: 'verify', code: 'unknown_passkey' });
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
      await record(session.s, 'staff.passkey_refused', null, null, { step: 'verify', code: (error as { code?: string }).code ?? 'invalid' });
      return json({ error: 'The passkey could not be checked. Try again.' }, 403);
    }
    const [row] = await sql<{ ok: boolean }[]>`
      SELECT slotlock.admin_passkey_used(${session.s}, ${Buffer.from(base64urlDecode(id))}, ${signCount}) AS ok`;
    if (!row?.ok) return json({ error: 'That passkey was refused.' }, 403);
    const upgraded: Session = { ...session, st: 'full', pv: now(), exp: session.st === 'full' ? session.exp : now() + SESSION_MS };
    return json({ ok: true }, 200, [clear(PASSKEY_COOKIE), sessionCookie(upgraded)]);
  }

  // ---------- Actions ----------
  interface Action {
    capability: SlotlockStaffCapability;
    /** The page the browser goes back to, which shows what happened. */
    back: string;
    run(form: URLSearchParams): Promise<{ code: keyof typeof NOTICES; ok: boolean; to?: string }>;
  }

  const field = (form: URLSearchParams, name: string) => (form.get(name) ?? '').trim();
  /** Text that may span lines, with Windows line ends made plain. */
  const lines = (form: URLSearchParams, name: string) => field(form, name).replace(/\r\n?/g, '\n');
  const optional = (value: string) => (value === '' ? null : value);

  /** Each form's route: what it needs, where it goes back to, and the admin function it calls. */
  function actionOf(path: string, session: Session): Action | null {
    const sql = options.sql();
    const onAccount = /^\/accounts\/([^/]+)\/(suspend|unsuspend|keys\/revoke|sessions\/end|notes)$/.exec(path);
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
                SELECT slotlock.admin_suspend(${session.s}, ${ref}, ${field(form, 'reason')}, ${optional(field(form, 'message'))}, ${linked}::bigint) AS ok`;
              return row?.ok ? { code: 'suspended', ok: true } : { code: 'already_suspended', ok: false };
            },
          };
        case 'unsuspend':
          return {
            capability: 'safety.act',
            back,
            async run(form) {
              const [row] = await sql<{ ok: boolean }[]>`
                SELECT slotlock.admin_unsuspend(${session.s}, ${ref}, ${field(form, 'reason')}) AS ok`;
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
                SELECT slotlock.admin_revoke_key(${session.s}, ${ref}, ${key}::uuid, ${field(form, 'reason')}) AS ok`;
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
                SELECT slotlock.admin_end_sessions(${session.s}, ${ref}, ${handle === 'all' ? null : handle}, ${field(form, 'reason')}) AS ended`;
              return handle !== 'all' && Number(row?.ended ?? 0) === 0
                ? { code: 'session_gone', ok: false }
                : { code: 'sessions_ended', ok: true };
            },
          };
        default:
          return {
            capability: 'accounts.act',
            back,
            async run(form) {
              await sql`SELECT slotlock.admin_add_note(${session.s}, ${ref}, ${lines(form, 'note')})`;
              return { code: 'note_added', ok: true };
            },
          };
      }
    }
    if (path === '/cases') {
      return {
        capability: 'safety.act',
        back: '/cases',
        async run(form) {
          const [row] = await sql<{ id: string }[]>`
            SELECT slotlock.admin_case_open(${session.s}, ${optional(field(form, 'account'))}, ${field(form, 'source')},
              ${field(form, 'summary')}, ${optional(field(form, 'section'))}, ${optional(lines(form, 'evidence'))}) AS id`;
          return { code: 'case_opened', ok: true, to: `/cases/${String(row?.id)}` };
        },
      };
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
            SELECT slotlock.admin_case_update(${session.s}, ${id}::bigint, ${status}, ${done}, ${optional(lines(form, 'outcome'))}) AS ok`;
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
      await record(session.s, 'page.refused', null, path.slice(0, 200));
      return respond(layout(shellOf(session, 'Not allowed', path), pageHead('Slotlock admin', 'Not allowed', `Your role (${session.r}) does not do this.`)), 403, { 'Set-Cookie': sessionCookie(session) });
    }
    if (!session.pv || now() - session.pv > FRESH_MS) {
      return redirect(`/passkey?${new URLSearchParams({ next: action.back, fresh: '1' }).toString()}`);
    }
    let outcome: { code: keyof typeof NOTICES; ok: boolean; to?: string };
    try {
      outcome = await action.run(form);
    } catch (error) {
      // A field the database refused (22023): say which kind of thing to fix, change nothing.
      if ((error as { code?: unknown } | null)?.code !== '22023') throw error;
      outcome = { code: 'invalid', ok: false };
    }
    const to = outcome.to ?? action.back;
    return redirect(`${to}?${new URLSearchParams({ [outcome.ok ? 'done' : 'error']: outcome.code }).toString()}`, [sessionCookie(session)]);
  }

  // ---------- Routing ----------
  const needs: Record<string, SlotlockStaffCapability> = {
    '/': 'home',
    '/accounts': 'accounts.read',
    '/search': 'accounts.read',
    '/staff': 'staff.read',
    '/staff/log': 'staff.log',
    '/cases': 'safety.act',
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'GET') {
      if (path === '/admin.css') return respond(SLOTLOCK_ADMIN_CSS, 200, { 'Cache-Control': 'public, max-age=300' }, 'text/css; charset=utf-8');
      if (path === '/admin.js') return respond(SLOTLOCK_ADMIN_JS, 200, { 'Cache-Control': 'public, max-age=300' }, 'text/javascript; charset=utf-8');
      if (path === '/passkey.js') return respond(SLOTLOCK_ADMIN_PASSKEY_JS, 200, { 'Cache-Control': 'public, max-age=300' }, 'text/javascript; charset=utf-8');
      if (path === '/healthz') return respond('ok', 200, {}, 'text/plain; charset=utf-8');
    }

    // Lock 1: Cloudflare Access, on every request that is not a static file.
    if (options.access) {
      const identity = await options.access.verify(request);
      if (!identity) return refused('Access required', 'This console is only reachable through Cloudflare Access.');
    }

    if (request.method === 'POST') {
      // Every POST from our own pages, and from nowhere else.
      if (request.headers.get('origin') !== origin) return refused('Refused', 'That request did not come from this console.');
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      return respond('Method not allowed', 405, { Allow: 'GET, POST' }, 'text/plain; charset=utf-8');
    }

    if (request.method === 'GET' && path === '/sign-in') return signInPage();
    if (request.method === 'GET' && path === '/sign-in/github') return startGithub();
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
      await record(session.s, 'staff.signed_out');
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
    if (request.method === 'POST') return act(request, session, path);

    const accountMatch = /^\/accounts\/([^/]+)$/.exec(path);
    const caseMatch = /^\/cases\/([1-9][0-9]{0,17})$/.exec(path);
    const capability = accountMatch ? 'accounts.read' : caseMatch ? 'safety.act' : needs[path];
    if (!capability) {
      return respond(layout(shellOf(session, 'Not found', path), pageHead('Slotlock admin', 'Not found', 'There is no page at this address.')), 404, { 'Set-Cookie': sessionCookie(session) });
    }
    if (!slotlockStaffMay(session.r, capability)) {
      await record(session.s, 'page.refused', null, path.slice(0, 200));
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
    if (path === '/cases') return casesPage(session, url);
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
