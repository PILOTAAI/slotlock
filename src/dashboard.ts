// The dashboard: people sign in with GitHub and manage the API keys and calendar resources of a
// personal tenant, `github:<user id>`. It is server-rendered HTML with no inline script or style,
// so its Content-Security-Policy allows nothing but this server's own stylesheet and script.
//
// Sign-in is GitHub's OAuth web flow with `state` and PKCE (S256) and no scope: the token is used
// once, to read who signed in, and dropped. A session is an HMAC-sealed cookie (`__Host-`,
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
import type { SlotlockApiKey, SlotlockApiKeyScope, SlotlockApiKeyStore } from './api-keys.js';
import { SLOTLOCK_DASHBOARD_FORM_LIMIT } from './ddl.js';
import type { SlotlockSql, SlotlockStore } from './store.js';
import type { SlotlockResource, WeeklyAvailabilityRule } from './types.js';
import {
  WEEKDAYS,
  WEEKDAY_NAMES as DAY_NAMES,
  type Weekday,
  type WeeklyHours,
  rulesToWeeklyHours,
  weeklyHoursToRules,
} from './weekly-hours.js';

/** Resources one dashboard tenant may hold. */
export const SLOTLOCK_DASHBOARD_MAX_RESOURCES = 100;
const SESSION_TTL_MS = 12 * 3_600_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const MAX_FORM_BYTES = 8_192;
/**
 * Sign-ins (record, then GitHub's token and user) one instance runs at once; more are told to retry.
 * This also bounds how fast unauthenticated callbacks can write sign-in records.
 */
const MAX_SIGN_INS_IN_FLIGHT = 8;
/** Entries each in-memory record keeps (createSlotlockMemoryDashboardState); past this the oldest go first. */
const MAX_REMEMBERED = 10_000;
/** A form's single-use value: 18 random bytes, then a MAC binding them to the session. */
const FORM_NONCE = /^([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/;
const POST_ROUTES: ReadonlySet<string> = new Set([
  '/sign-out',
  '/keys',
  '/keys/rotate',
  '/keys/revoke',
  '/resources',
  '/hours',
]);
const SIGN_IN_AGAIN = 'That sign-in did not finish here, or took too long. Sign in again.';
const GITHUB_ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const MAX_COOKIE_CHARACTERS = 4_096;
const GITHUB_TIMEOUT_MS = 10_000;
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
const KEY_ACCESS: Readonly<Record<string, SlotlockApiKeyScope[]>> = Object.freeze({
  read: ['read'],
  read_write: ['read', 'write'],
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
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** A tenant's calendar resources, as the dashboard lists and adds them. */
export interface SlotlockDashboardResources {
  list(tenantRef: string): Promise<SlotlockResource[]>;
  /**
   * Create the resource, or re-zone the tenant's resource with that reference. Refuse a new one
   * (an error with `code: 'resource_limit_reached'`) once the tenant has
   * SLOTLOCK_DASHBOARD_MAX_RESOURCES, however many adds race, on however many servers.
   */
  add(tenantRef: string, externalRef: string, timezone: string): Promise<SlotlockResource>;
  /**
   * Set the bookable hours of one of the tenant's resources (`{ id }`) or of all of them; `null`
   * hands them back to the server's and `[]` closes. Returns how many resources changed: 0 for an
   * id that is not the tenant's.
   */
  setHours(
    tenantRef: string,
    target: { id: string } | 'all',
    rules: WeeklyAvailabilityRule[] | null,
  ): Promise<number>;
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

export interface SlotlockDashboardOptions {
  /** Where people reach the server; the dashboard lives at `<publicUrl>/dashboard`. */
  publicUrl: string;
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
  };
  /** Seals sessions and sign-in state and derives CSRF tokens: 32+ random characters. */
  sessionSecret: string;
  /** GitHub user ids (numbers, as strings) that may sign in, or `'*'` for every GitHub account. */
  allowedUsers: '*' | readonly string[];
  keys: SlotlockApiKeyStore;
  resources: SlotlockDashboardResources;
  /** Shared by every server behind this origin: see SlotlockDashboardState. */
  state: SlotlockDashboardState;
  /** The server's bookable hours: shown, not edited, and used by resources without their own. */
  availability?: readonly WeeklyAvailabilityRule[];
  fetch?: typeof fetch;
  now?: () => number;
  /** Called with whatever a request handler throws; the person sees a generic error page. */
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
export function createSlotlockDashboardResources(store: SlotlockStore): SlotlockDashboardResources {
  return {
    list: (tenantRef) =>
      store.withTenant(tenantRef, (tenant) =>
        tenant.listResources({ tenantRef, limit: SLOTLOCK_DASHBOARD_MAX_RESOURCES + 1 }),
      ),
    add: (tenantRef, externalRef, timezone) =>
      store.withTenant(
        tenantRef,
        (tenant) =>
          tenant.createResource({
            tenantRef,
            externalRef,
            timezone,
            maxTenantResources: SLOTLOCK_DASHBOARD_MAX_RESOURCES,
          }),
        { isolation: 'read committed' },
      ),
    setHours: (tenantRef, target, rules) =>
      store.withTenant(tenantRef, async (tenant) => {
        if (target === 'all') return tenant.setTenantAvailability({ tenantRef, rules });
        const updated = await tenant.setResourceAvailability({ tenantRef, id: target.id, rules });
        return updated ? 1 : 0;
      }),
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
}

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
    if (name === SESSION_COOKIE || name === SIGN_IN_COOKIE) {
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

export function createSlotlockDashboard(options: SlotlockDashboardOptions): SlotlockDashboard {
  const publicUrl = new URL(options.publicUrl);
  const origin = publicUrl.origin;
  const base = publicUrl.pathname.replace(/\/$/, '');
  const root = `${base}/dashboard`;
  const callbackUrl = `${origin}${root}/callback`;
  const mcpUrl = `${origin}${base}/mcp`;
  const a2aUrl = `${origin}${base}/a2a`;
  const authorizeUrl = options.github.authorizeUrl ?? 'https://github.com/login/oauth/authorize';
  const tokenUrl = options.github.tokenUrl ?? 'https://github.com/login/oauth/access_token';
  const userUrl = options.github.userUrl ?? 'https://api.github.com/user';
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  if (Buffer.byteLength(options.sessionSecret, 'utf8') < 32) {
    throw new Error('Slotlock dashboard sessionSecret must be at least 32 bytes');
  }
  const secret = Buffer.from(options.sessionSecret, 'utf8');
  // A list, or exactly '*': any other string would match ids by substring.
  const allowed = (uid: string) =>
    options.allowedUsers === '*' ||
    (Array.isArray(options.allowedUsers) && options.allowedUsers.includes(uid));
  let signInsInFlight = 0;

  function report(message: string): void {
    try {
      options.onError?.(new Error(message));
    } catch {
      // A failing reporter must not change the response.
    }
  }

  const formMac = (session: Session, nonce: string) =>
    createHmac('sha256', secret)
      .update(`slotlock-dashboard-form-v1.${session.sid}.${nonce}`)
      .digest('base64url');
  /** Random, and bound to the session by a MAC: a made-up or another session's value is refused unwritten. */
  const formNonce = (session: Session) => {
    const nonce = randomBytes(18).toString('base64url');
    return `${nonce}.${formMac(session, nonce)}`;
  };
  const isFormNonce = (session: Session, once: string) => {
    const match = FORM_NONCE.exec(once);
    // Compared as text, like the cookie MACs: decoding would drop the last character's spare bits.
    return match !== null && safeEqual(match[2] as string, formMac(session, match[1] as string));
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
      !allowed(payload.uid) ||
      (await options.state.sessionEnded(payload.sid, payload.exp as number))
    ) {
      return null;
    }
    return payload as unknown as Session;
  }

  const csrfToken = (session: Session) =>
    createHmac('sha256', secret)
      .update(`slotlock-dashboard-csrf-v1.${session.sid}`)
      .digest('base64url');
  const tenantOf = (session: Session) => `github:${session.uid}`;

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
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': REFERRER_POLICY,
        'Cross-Origin-Opener-Policy': 'same-origin',
        ...headers,
      },
    });
    for (const value of cookies) response.headers.append('Set-Cookie', value);
    return response;
  }

  const redirect = (status: number, location: string, cookies: string[] = []) =>
    respond(status, '', { Location: location }, cookies);

  function layout(title: string, content: Html, session: Session | null): Html {
    const account = session
      ? html`<div class="account"><span class="login">@${session.login}</span>
          <form method="post" action="${root}/sign-out"><input type="hidden" name="csrf" value="${csrfToken(session)}"><button class="link" type="submit">Sign out</button></form></div>`
      : html``;
    return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="${REFERRER_POLICY}">
<title>${title} · Slotlock</title>
<link rel="stylesheet" href="${root}/style.css?v=${ASSET_VERSIONS.css}">
<script src="${root}/app.js?v=${ASSET_VERSIONS.js}" defer></script>
</head>
<body>
<header class="bar"><a class="brand" href="${root}"><svg class="mark" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path d="M8 46 L26 14 L56 44"></path></svg><span class="name">Slotlock</span> <span class="by">by Pylota</span></a>${account}</header>
<main>${content}</main>
</body>
</html>`;
  }

  function signedOutPage(status: number, notice?: string, cookies: string[] = []): Response {
    const content = html`<section class="hero">
<h1>Your agents' calendar keys</h1>
<p>Sign in with GitHub to create API keys for the Slotlock tools, add the resources your agents book, and connect an MCP or A2A client.</p>
${notice ? html`<p class="notice" role="alert">${notice}</p>` : html``}
<a class="button primary" href="${root}/sign-in">Sign in with GitHub</a>
<p class="fine">Slotlock reads only your public GitHub profile, to know who you are, and keeps nothing from GitHub but your user id and login.</p>
</section>`;
    return respond(status, layout('Sign in', content, null), {}, cookies);
  }

  function keyRows(keys: SlotlockApiKey[], token: string, session: Session): Html[] {
    return keys.map((key) => {
      const expired = key.expiresAt !== null && key.expiresAt.getTime() <= now();
      const status = key.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active';
      const actions =
        status === 'Active'
          ? html`<details class="act"><summary>Rotate</summary><p>A new secret replaces this one at once. The key keeps its name, access and bookings.</p>
<form method="post" action="${root}/keys/rotate"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${key.id}"><button type="submit">Rotate key</button></form></details>
<details class="act danger"><summary>Revoke</summary><p>Requests with this key fail at once. What it booked stays on the calendar.</p>
<form method="post" action="${root}/keys/revoke"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${key.id}"><button class="danger" type="submit">Revoke key</button></form></details>`
          : html``;
      return html`<tr>
<td data-label="Name">${key.name}</td>
<td data-label="Key"><code>${key.prefix}…</code></td>
<td data-label="Access">${key.scopes.includes('write') ? 'Read and write' : 'Read only'}</td>
<td data-label="Created">${formatDate(key.createdAt)}</td>
<td data-label="Last used">${key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}</td>
<td data-label="Expires">${key.expiresAt ? formatDate(key.expiresAt) : 'Never'}</td>
<td data-label="Status"><span class="status ${status.toLowerCase()}">${status}</span></td>
<td class="actions">${actions}</td>
</tr>`;
    });
  }

  async function dashboardPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const tenantRef = tenantOf(session);
    const [keys, resources] = await Promise.all([
      options.keys.list({ tenantRef }),
      options.resources.list(tenantRef),
    ]);
    const token = csrfToken(session);
    const rules = options.availability ?? [];
    const content = html`${notice ? html`<p class="notice" role="alert">${notice}</p>` : html``}
<section class="card">
<h2>Connect an agent</h2>
<p>Agents call Slotlock over MCP or A2A with one of your keys: <code>Authorization: Bearer slk_…</code>.</p>
<dl class="endpoints"><dt>MCP</dt><dd><code>${mcpUrl}</code></dd><dt>A2A</dt><dd><code>${a2aUrl}</code></dd></dl>
</section>
<section>
<div class="head"><div><h2>API keys</h2><p>Each key acts in your calendar only. Give every agent its own, with the least access it needs.</p></div></div>
<form class="create" method="post" action="${root}/keys">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<label>Name<input name="name" required maxlength="100" placeholder="Booking agent"></label>
<label>Access<select name="access"><option value="read_write">Read and write</option><option value="read">Read only</option></select></label>
<label>Expires<select name="expires"><option value="90">In 90 days</option><option value="30">In 30 days</option><option value="365">In a year</option><option value="never">Never</option></select></label>
<button class="primary" type="submit">Create key</button>
</form>
${
  keys.length === 0
    ? html`<p class="empty">No keys yet. Create one to connect an agent.</p>`
    : html`<div class="table"><table><thead><tr><th>Name</th><th>Key</th><th>Access</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
<tbody>${keyRows(keys, token, session)}</tbody></table></div>`
}
</section>
<section>
<div class="head"><div><h2>Resources</h2><p>What your agents book: a car, a room, a person, a machine. Up to ${SLOTLOCK_DASHBOARD_MAX_RESOURCES}.</p></div></div>
<form class="create" method="post" action="${root}/resources">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<label>Reference<input name="reference" required maxlength="200" placeholder="vehicle-42"></label>
<label>Time zone<input name="timezone" required maxlength="64" value="UTC" placeholder="Europe/London"></label>
<button type="submit">Add resource</button>
</form>
${
  resources.length === 0
    ? html`<p class="empty">No resources yet. Agents can only book what is listed here.</p>`
    : html`<div class="table"><table><thead><tr><th>Reference</th><th>Time zone</th><th>Bookable hours</th><th>Resource id</th></tr></thead><tbody>${resources.map(
        (resource) =>
          html`<tr><td data-label="Reference">${resource.externalRef ?? ''}</td><td data-label="Time zone">${resource.timezone}</td><td data-label="Bookable hours">${hoursSummary(resource.availabilityRules)} <a href="${root}/hours?resource=${resource.id}">Set hours</a></td><td data-label="Resource id"><code>${resource.id}</code></td></tr>`,
      )}</tbody></table></div>`
}
</section>
<section>
<h2>Bookable hours</h2>
${
  rules.length === 0
    ? html`<p class="empty">This server offers no bookable hours: agents find a free slot only on resources with hours of their own.</p>`
    : html`<ul class="hours">${rules.map(
        (rule) =>
          html`<li>${daysOf(rule.rrule)}: ${hoursOf(rule.startMinutes, rule.durationMinutes)}</li>`,
      )}</ul>`
}
<p class="fine">The server's hours, for resources without hours of their own, in each resource's own time zone.</p>
${resources.length > 0 ? html`<p><a href="${root}/hours">Set hours for every resource</a></p>` : html``}
</section>`;
    return respond(status, layout('Dashboard', content, session));
  }

  function hoursPage(
    session: Session,
    state: {
      target: SlotlockResource | 'all';
      mode: HoursMode;
      week: WeekForm;
      unshown?: readonly WeeklyAvailabilityRule[];
      status?: number;
      notice?: string;
    },
  ): Response {
    const { target, mode } = state;
    const checked = (value: HoursMode) => (mode === value ? html` checked` : html``);
    const server = options.availability ?? [];
    const title =
      target === 'all'
        ? 'Hours for every resource'
        : `Hours for ${target.externalRef ?? target.id}`;
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
<p><a href="${root}">Back to the dashboard</a></p>
<h1>${title}</h1>
<p>${
      target === 'all'
        ? 'The same hours for every resource, each in its own time zone. Saving replaces their hours.'
        : `When agents may book it, in its time zone: ${target.timezone}.`
    }</p>
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
<input type="hidden" name="resource" value="${target === 'all' ? 'all' : target.id}">
<fieldset class="modes"><legend>Bookable hours</legend>
<label class="choice"><input type="radio" name="mode" value="server"${checked('server')}> The server's hours (${server.length === 0 ? 'none' : hoursSummary(server)})</label>
<label class="choice"><input type="radio" name="mode" value="closed"${checked('closed')}> Closed: agents find no free slot</label>
<label class="choice"><input type="radio" name="mode" value="custom"${checked('custom')}> These hours</label>
</fieldset>
<div class="table"><table class="week"><thead><tr><th>Day</th><th>Opens</th><th>Closes</th><th>Opens</th><th>Closes</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="fine">A closing time at or before the opening time closes the next day; 00:00 to 00:00 is the whole day. Leave a window empty for none.</p>
<button class="primary" type="submit">Save hours</button>
</form>
</section>`;
    return respond(state.status ?? 200, layout('Bookable hours', content, session));
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

  async function hoursEditor(session: Session, url: URL): Promise<Response> {
    const id = url.searchParams.get('resource');
    if (id === null) {
      const server = rulesToWeeklyHours(options.availability ?? []);
      return hoursPage(session, { target: 'all', mode: 'server', week: weekFormOf(server) });
    }
    const resource = await ownResource(session, id);
    if (!resource) return notFound(session);
    const rules = resource.availabilityRules;
    if (rules === undefined) {
      const server = rulesToWeeklyHours(options.availability ?? []);
      return hoursPage(session, { target: resource, mode: 'server', week: weekFormOf(server) });
    }
    if (rules.length === 0) {
      return hoursPage(session, { target: resource, mode: 'closed', week: emptyWeekForm() });
    }
    const week = rulesToWeeklyHours(rules);
    return hoursPage(session, {
      target: resource,
      mode: 'custom',
      week: weekFormOf(week),
      ...(week === null ? { unshown: rules } : {}),
    });
  }

  async function saveHours(session: Session, form: URLSearchParams): Promise<Response> {
    const id = form.get('resource') ?? '';
    const target = id === 'all' ? 'all' : await ownResource(session, id);
    if (!target) return notFound(session);
    const mode = form.get('mode');
    const week = readWeekForm(form);
    if (mode !== 'server' && mode !== 'closed' && mode !== 'custom') {
      return hoursPage(session, {
        target,
        mode: 'custom',
        week,
        status: 400,
        notice: 'Choose which hours to use.',
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
        });
      }
    }
    const changed = await options.resources.setHours(
      tenantOf(session),
      target === 'all' ? 'all' : { id: target.id },
      rules,
    );
    if (changed === 0) {
      return target === 'all'
        ? dashboardPage(session, 409, 'Add a resource first, then set its hours.')
        : notFound(session);
    }
    return redirect(303, root);
  }

  function shownOncePage(
    session: Session,
    key: string,
    apiKey: SlotlockApiKey,
    rotated: boolean,
  ): Response {
    const content = html`<section class="card once">
<h1>${rotated ? 'Key rotated' : 'Key created'}: ${apiKey.name}</h1>
<p class="notice warn" role="alert">Copy this key now. Slotlock keeps only its fingerprint, so it will not be shown again.${rotated ? ' The old key no longer works.' : ''}</p>
<div class="copy"><input id="key" readonly value="${key}" aria-label="API key"><button type="button" data-copy="key">Copy</button></div>
<h2>Add it to an MCP client</h2>
<pre><code id="command">claude mcp add --transport http slotlock ${mcpUrl} \\
  --header "Authorization: Bearer ${key}"</code></pre>
<p>Keep the key in a secret manager. Rotate it if it leaks; revoke it when the agent is retired.</p>
<a class="button primary" href="${root}">Done</a>
</section>`;
    return respond(200, layout('Your new key', content, session));
  }

  async function startSignIn(): Promise<Response> {
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
    }).toString();
    const sealed = seal('slotlock-dashboard-sign-in-v1', {
      state,
      verifier,
      exp: now() + SIGN_IN_TTL_MS,
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
      redirect: 'error',
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
      redirect: 'error',
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

  async function askGitHub(
    code: string,
    verifier: string,
  ): Promise<{ uid: string; login: string } | null> {
    try {
      const token = await exchangeCode(code, verifier);
      return token === null ? null : await readGitHubUser(token);
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
    if (signInsInFlight >= MAX_SIGN_INS_IN_FLIGHT) {
      return signedOutPage(
        503,
        'Too many people are signing in at once. Sign in again in a moment.',
        [clearSignIn],
      );
    }
    const verifier = pending.verifier;
    signInsInFlight += 1;
    let user: { uid: string; login: string } | null;
    try {
      // Recorded before GitHub is asked, so a replayed callback is refused on every server unasked.
      if (!(await options.state.use('sign_in', pending.state, pending.exp as number))) {
        return signedOutPage(400, SIGN_IN_AGAIN, [clearSignIn]);
      }
      user = await askGitHub(code, verifier);
    } finally {
      signInsInFlight -= 1;
    }
    if (!user) {
      return signedOutPage(502, 'GitHub did not complete the sign-in. Try again.', [clearSignIn]);
    }
    if (!allowed(user.uid)) {
      return signedOutPage(403, `This Slotlock server does not let @${user.login} sign in.`, [
        clearSignIn,
      ]);
    }
    const session = seal('slotlock-dashboard-session-v1', {
      uid: user.uid,
      login: user.login,
      sid: randomBytes(24).toString('base64url'),
      exp: now() + SESSION_TTL_MS,
    });
    return redirect(303, root, [
      clearSignIn,
      setCookie(SESSION_COOKIE, session, SESSION_TTL_MS / 1000),
    ]);
  }

  /** The form, `'too_large'` past MAX_FORM_BYTES (read no further), or null for another type. */
  async function readForm(request: Request): Promise<URLSearchParams | 'too_large' | null> {
    const type = request.headers.get('content-type')?.split(';')[0]?.trim();
    if (type !== 'application/x-www-form-urlencoded') return null;
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return 'too_large';
    if (!request.body) return new URLSearchParams();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FORM_BYTES) {
        await reader.cancel().catch(() => undefined);
        return 'too_large';
      }
      chunks.push(value);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  async function createKey(session: Session, form: URLSearchParams): Promise<Response> {
    const scopes = KEY_ACCESS[form.get('access') ?? ''];
    const expiry = form.get('expires') ?? '';
    if (!scopes || !Object.hasOwn(KEY_EXPIRY_DAYS, expiry)) {
      return dashboardPage(session, 400, 'Choose an access level and an expiry from the lists.');
    }
    const days = KEY_EXPIRY_DAYS[expiry];
    try {
      const created = await options.keys.create({
        tenantRef: tenantOf(session),
        name: form.get('name') ?? '',
        scopes,
        createdBy: tenantOf(session),
        ...(typeof days === 'number' ? { expiresAt: new Date(now() + days * DAY_MS) } : {}),
      });
      return shownOncePage(session, created.key, created.apiKey, false);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'invalid_api_key_name') {
        return dashboardPage(session, 400, 'Give the key a name of 1 to 100 characters.');
      }
      if (code === 'api_key_limit_reached') {
        return dashboardPage(
          session,
          409,
          'You have as many keys as Slotlock allows. Revoke one first.',
        );
      }
      throw error;
    }
  }

  async function changeKey(session: Session, form: URLSearchParams, change: 'rotate' | 'revoke') {
    const id = form.get('id') ?? '';
    if (!UUID_PATTERN.test(id)) return dashboardPage(session, 404, 'That key is not one of yours.');
    if (change === 'rotate') {
      const rotated = await options.keys.rotate({ tenantRef: tenantOf(session), id });
      if (!rotated) return dashboardPage(session, 404, 'That key is not an active key of yours.');
      return shownOncePage(session, rotated.key, rotated.apiKey, true);
    }
    const revoked = await options.keys.revoke({ tenantRef: tenantOf(session), id });
    if (!revoked) return dashboardPage(session, 404, 'That key is not one of yours.');
    return redirect(303, root);
  }

  async function addResource(session: Session, form: URLSearchParams): Promise<Response> {
    const reference = (form.get('reference') ?? '').trim();
    const timezone = (form.get('timezone') ?? '').trim();
    if (reference.length === 0 || reference.length > 200) {
      return dashboardPage(session, 400, 'Give the resource a reference of 1 to 200 characters.');
    }
    try {
      await options.resources.add(tenantOf(session), reference, timezone);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'resource_limit_reached') {
        return dashboardPage(
          session,
          409,
          `You have ${SLOTLOCK_DASHBOARD_MAX_RESOURCES} resources, as many as the dashboard allows.`,
        );
      }
      if (code === 'invalid_timezone') {
        return dashboardPage(
          session,
          400,
          `${timezone} is not a time zone Slotlock knows, such as Europe/London.`,
        );
      }
      if (code === 'invalid_external_ref') {
        return dashboardPage(session, 400, 'Give the resource a reference of 1 to 200 characters.');
      }
      throw error;
    }
    return redirect(303, root);
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
    const form = await readForm(request);
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
      let first: boolean;
      try {
        first =
          isFormNonce(session, once) &&
          (await options.state.use('form', once, session.exp, session.uid));
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'dashboard_form_limit') throw error;
        return dashboardPage(
          session,
          429,
          'Too many forms sent from this account in the last 12 hours. Try again later.',
        );
      }
      if (!first) {
        return dashboardPage(
          session,
          409,
          'That form was already sent. Reload the page to start again.',
        );
      }
    }
    switch (route) {
      case '/sign-out':
        await options.state.endSession(session.sid, session.exp);
        return redirect(303, root, [setCookie(SESSION_COOKIE, '', 0)]);
      case '/keys':
        return createKey(session, form);
      case '/keys/rotate':
        return changeKey(session, form, 'rotate');
      case '/keys/revoke':
        return changeKey(session, form, 'revoke');
      case '/resources':
        return addResource(session, form);
      case '/hours':
        return saveHours(session, form);
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
              return session ? await dashboardPage(session) : signedOutPage(200);
            }
            case '/style.css':
              return asset(DASHBOARD_CSS, 'text/css; charset=utf-8', url, ASSET_VERSIONS.css);
            case '/app.js':
              return asset(DASHBOARD_JS, 'text/javascript; charset=utf-8', url, ASSET_VERSIONS.js);
            case '/sign-in':
              return await startSignIn();
            case '/callback':
              return await finishSignIn(request, url);
            case '/hours': {
              const session = await readSession(request);
              return session ? await hoursEditor(session, url) : redirect(303, root);
            }
            default:
              return respond(
                404,
                layout('Not found', html`<p class="notice">Nothing is here.</p>`, null),
              );
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
        try {
          options.onError?.(error);
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

// Copies the value of the element a button names. Loaded as a file, so the policy needs no inline code.
const DASHBOARD_JS = `document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-copy]') : null;
  if (!button) return;
  const field = document.getElementById(button.getAttribute('data-copy'));
  if (!field) return;
  const selectIt = () => {
    if (typeof field.select === 'function') field.select();
    button.textContent = 'Selected: press Ctrl+C or Cmd+C';
  };
  if (!navigator.clipboard) return selectIt();
  navigator.clipboard.writeText(field.value ?? field.textContent ?? '').then(() => {
    button.textContent = 'Copied';
  }, selectIt);
});
`;

const DASHBOARD_CSS = `:root {
  --ink: #0b0d12; --ink-2: #3a3f4b; --ink-3: #6b7180; --line: #e6e8ee; --paper: #ffffff; --wash: #f6f7f9;
  --accent: #2655ff; --accent-ink: #ffffff; --danger: #c62828; --warn: #8a5a00; --warn-wash: #fff6e0;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --ink: #eef0f5; --ink-2: #c3c7d1; --ink-3: #8b91a0; --line: #2a2e38; --paper: #0e1016; --wash: #161922;
    --accent: #6f8cff; --accent-ink: #0b0d12; --danger: #ff6b6b; --warn: #ffcf70; --warn-wash: #2b2410; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
code, pre, input[readonly] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 24px; border-bottom: 1px solid var(--line); }
.brand { display: inline-flex; align-items: center; gap: 8px; color: var(--ink); text-decoration: none; }
.mark { width: 20px; height: 20px; fill: none; stroke: var(--accent); stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; }
.name { font-weight: 650; font-size: 16px; }
.by { color: var(--ink-3); font-size: 12px; }
.account { display: flex; align-items: center; gap: 12px; color: var(--ink-2); }
.account form { margin: 0; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 24px 64px; display: grid; gap: 40px; }
h1 { font-size: 28px; line-height: 1.2; margin: 0 0 12px; letter-spacing: -0.01em; }
h2 { font-size: 18px; margin: 0 0 6px; }
p { margin: 0 0 12px; color: var(--ink-2); }
.fine { font-size: 13px; color: var(--ink-3); }
.hero { max-width: 560px; margin: 48px auto; text-align: center; }
.card { border: 1px solid var(--line); border-radius: 12px; padding: 20px; background: var(--wash); }
.head { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 12px; }
.endpoints { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 12px 0 0; }
.endpoints dt { color: var(--ink-3); }
.endpoints dd { margin: 0; overflow-wrap: anywhere; }
.create { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 0 0 16px; }
label { display: grid; gap: 4px; font-size: 13px; color: var(--ink-2); }
input, select { font: inherit; height: 38px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink); min-width: 0; }
button, .button { font: inherit; font-weight: 600; height: 38px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--paper); color: var(--ink); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; }
.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button.danger { border-color: var(--danger); color: var(--danger); }
button.link { border: 0; background: none; padding: 0; height: auto; color: var(--ink-2); font-weight: 500; text-decoration: underline; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.table { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; color: var(--ink-3); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; background: var(--wash); }
tr:last-child td { border-bottom: 0; }
.status { justify-self: start; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--wash); }
.status.active { color: var(--accent); }
.status.revoked, .status.expired { color: var(--ink-3); }
.actions { white-space: nowrap; }
.act { display: inline-block; margin-right: 8px; }
.act summary { cursor: pointer; color: var(--ink-2); }
.act.danger summary { color: var(--danger); }
.act[open] { display: block; max-width: 280px; white-space: normal; }
.act p { font-size: 13px; margin: 8px 0; }
.notice { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--wash); color: var(--ink); }
.notice.warn { background: var(--warn-wash); color: var(--warn); border-color: transparent; }
.empty { color: var(--ink-3); }
.once { max-width: 720px; }
.copy { display: flex; gap: 8px; margin: 12px 0 20px; }
.copy input { flex: 1; }
pre { background: var(--wash); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.hours { margin: 0 0 8px; padding-left: 20px; color: var(--ink-2); }
.modes { border: 0; padding: 0; margin: 0 0 16px; display: grid; gap: 8px; }
.modes legend { font-weight: 600; color: var(--ink); padding: 0; margin-bottom: 4px; }
.choice { display: flex; align-items: center; gap: 8px; font-size: 15px; color: var(--ink); }
.choice input { height: auto; }
.week input { width: 100%; }
.week th[scope="row"] { text-transform: none; letter-spacing: 0; font-size: 14px; color: var(--ink); background: none; }
form > .table { margin-bottom: 12px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 720px) {
  .bar { padding: 12px 16px; }
  main { padding: 24px 16px 48px; }
  thead { display: none; }
  table, tbody, tr, td { display: block; }
  tr { border-bottom: 1px solid var(--line); padding: 8px 0; }
  td { border: 0; padding: 3px 12px; }
  td[data-label] { display: grid; grid-template-columns: 88px 1fr; gap: 8px; }
  td[data-label]::before { content: attr(data-label); font-size: 12px; color: var(--ink-3); padding-top: 2px; }
}
`;

const ASSET_VERSIONS = Object.freeze({
  css: createHash('sha256').update(DASHBOARD_CSS).digest('base64url').slice(0, 12),
  js: createHash('sha256').update(DASHBOARD_JS).digest('base64url').slice(0, 12),
});
