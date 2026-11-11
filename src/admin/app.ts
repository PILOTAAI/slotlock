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
  type Html,
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
    ...(slotlockStaffMay(session.r, 'staff.read') ? [{ href: '/staff', label: 'Staff' }] : []),
    ...(slotlockStaffMay(session.r, 'staff.log') ? [{ href: '/staff/log', label: 'Staff log' }] : []),
  ];
  const shellOf = (session: Session, title: string, path: string, query?: string) => ({
    title,
    path,
    nav: navFor(session),
    staff: { login: session.l, role: session.r },
    csrf: csrfOf(session),
    ...(query !== undefined ? { query } : {}),
  });
  const page = (session: Session, title: string, path: string, body: Html, query?: string) =>
    respond(layout(shellOf(session, title, path, query), body), 200, { 'Set-Cookie': sessionCookie(session) });

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

  async function account(session: Session, ref: string): Promise<Response> {
    const sql = options.sql();
    const [row] = await sql<{ account: Record<string, unknown> | null }[]>`SELECT slotlock.admin_account(${session.s}, ${ref}) AS account`;
    const data = row?.account;
    if (!data) {
      return respond(layout(shellOf(session, 'Not found', '/accounts'), html`${pageHead('Accounts', 'No such account', html`No account has the reference <code>${ref}</code>.`)}`), 404, { 'Set-Cookie': sessionCookie(session) });
    }
    const [keys, usage, audit, login] = await Promise.all([
      sql<{ name: string; prefix: string; scopes: string[]; created_at: Date; expires_at: Date | null; last_used_at: Date | null; revoked_at: Date | null }[]>`
        SELECT * FROM slotlock.admin_account_keys(${session.s}, ${ref})`,
      sql<{ day: Date; metric: string; count: string }[]>`SELECT * FROM slotlock.admin_account_usage(${session.s}, ${ref}, 30)`,
      sql<{ occurred_at: Date; action: string; actor_type: string; actor_ref: string; target_type: string | null; target_ref: string | null; outcome: string; reason: string | null }[]>`
        SELECT * FROM slotlock.admin_account_audit(${session.s}, ${ref}, 50)`,
      loginOf(ref),
    ]);
    const limits = (data.limits ?? null) as Record<string, number> | null;
    const monthUse = (data.usage_month ?? {}) as Record<string, number>;
    const meter = (label: string, value: number, max: number | undefined) =>
      html`<div class="meter"><span><span>${label}</span><span>${count(value)}${max ? ` of ${count(max)}` : ''}</span></span>${max ? html`<progress max="${max}" value="${Math.min(value, max)}">${value}</progress>` : ''}</div>`;
    const series = (metric: string) =>
      usage.filter((point) => point.metric === metric).map((point) => ({ day: day(point.day), count: Number(point.count) }));
    const title = String(data.name ?? login ?? ref);
    const stripe = typeof data.stripe_customer === 'string' ? data.stripe_customer : null;
    const body = html`
      ${pageHead(`Account · ${String(data.kind)}`, title, html`<code>${ref}</code> <button class="link" type="button" data-copy="${ref}" hidden>Copy</button> ${planPill(String(data.plan))} ${statusPill(Boolean(data.suspended), (data.plan_status as string | null) ?? null)}`,
        stripe ? html`<a class="btn" href="https://dashboard.stripe.com/customers/${encodeURIComponent(stripe)}" rel="noreferrer">Open in Stripe</a>` : undefined)}
      <div class="grid-2">
        <div>
          ${data.suspended ? html`<p class="notice warn">Suspended ${when(data.suspended_at as string)}${data.suspension_reason ? html`: ${String(data.suspension_reason)}` : ''}. It can read, and writes nothing.</p>` : ''}
          <h2>Use this month</h2>
          ${stats([
            { label: 'Operations', value: count(monthUse.operations ?? 0) },
            { label: 'Bookings', value: count(monthUse.bookings ?? 0) },
            { label: 'Holds', value: count(monthUse.holds ?? 0) },
            { label: 'Webhook deliveries', value: count(monthUse.webhook_deliveries ?? 0) },
          ])}
          <h2>Last 30 days</h2>
          ${bars('Operations', series('operations'))}
          <h2>API keys</h2>
          ${table('API keys', ['Name', 'Prefix', 'Access', 'Last used', 'State'], keys.map((key) => [
            html`${key.name}<span class="sub">Created ${day(key.created_at)}</span>`,
            html`<code>${key.prefix}</code>`,
            html`${key.scopes.join(', ')}`,
            html`${when(key.last_used_at)}`,
            key.revoked_at ? pill('Revoked', 'muted') : key.expires_at && new Date(key.expires_at).getTime() < now() ? pill('Expired', 'muted') : pill('Active', 'good'),
          ]), 'No API keys.')}
          <h2>Audit log</h2>
          ${table('Audit log', ['When', 'Action', 'By', 'Outcome'], audit.map((event) => [
            html`${when(event.occurred_at)}`,
            html`<code>${event.action}</code>${event.target_ref ? html`<span class="sub mono">${event.target_type ?? ''} ${event.target_ref}</span>` : ''}`,
            html`<span class="mono">${event.actor_type}</span><span class="sub mono">${event.actor_ref}</span>`,
            event.outcome === 'success' ? pill('Done', 'good') : pill(event.outcome, 'bad'),
          ]), 'Nothing in the audit log yet.')}
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
          <p class="fine">Booking titles, descriptions and attendees are never shown here (RFC 0006, E3).</p>
        </aside>
      </div>`;
    return page(session, title, '/accounts', body);
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
    const next = (url.searchParams.get('next') ?? '/').startsWith('/') ? (url.searchParams.get('next') ?? '/') : '/';
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
        <p>Signed in with GitHub as <strong>${session.l}</strong>. Use your passkey to open the console.</p>
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

  // ---------- Routing ----------
  const needs: Record<string, SlotlockStaffCapability> = {
    '/': 'home',
    '/accounts': 'accounts.read',
    '/search': 'accounts.read',
    '/staff': 'staff.read',
    '/staff/log': 'staff.log',
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
    if (request.method !== 'GET') return respond('Not found', 404, {}, 'text/plain; charset=utf-8');

    const accountMatch = /^\/accounts\/([^/]+)$/.exec(path);
    const capability = accountMatch ? 'accounts.read' : needs[path];
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
      return account(session, ref);
    }
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
