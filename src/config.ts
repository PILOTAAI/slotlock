// What Slotlock reads from environment variables, wherever it runs: the `slotlock` commands
// (self-host.ts) and the dashboard on Cloudflare Workers (workers/dashboard). Nothing here needs a
// Node.js-only module. A message names the variable, never its value.
import type { WeeklyAvailabilityRule } from './types.js';
import { SLOTLOCK_MAX_AVAILABILITY_RULES, availabilityRuleProblem } from './weekly-hours.js';

export type SlotlockEnv = Readonly<Record<string, string | undefined>>;

/** A configuration a command refuses to run with. The message names the variable, never its value. */
export class SlotlockConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotlockConfigError';
  }
}

const MIN_SECRET_CHARACTERS = 32;
/** Rejects repeated or patterned values (`aaaa…`, `abcabc…`); random hex has about 16. */
const MIN_DISTINCT_SECRET_CHARACTERS = 10;
const PLACEHOLDER_SECRET = /change.?me|replace.?me|example|placeholder/i;
export const SECRET_HINT = 'generate one with `openssl rand -hex 32`';

/** An unset variable and an empty one (`FOO=` in an env file) both mean "not configured". */
export function optional(env: SlotlockEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function readSecret(env: SlotlockEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value.trim() === '') return undefined;
  // Not trimmed: a stray newline from `$(cat file)` would make the server and its clients disagree.
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new SlotlockConfigError(
      `${name} must be printable ASCII without spaces or line breaks; ${SECRET_HINT}`,
    );
  }
  if (
    value.length < MIN_SECRET_CHARACTERS ||
    new Set(value).size < MIN_DISTINCT_SECRET_CHARACTERS ||
    PLACEHOLDER_SECRET.test(value)
  ) {
    throw new SlotlockConfigError(
      `${name} is too weak: use at least ${MIN_SECRET_CHARACTERS} random characters; ${SECRET_HINT}`,
    );
  }
  return value;
}

/**
 * A URL people or agents reach Slotlock at (SLOTLOCK_PUBLIC_URL, SLOTLOCK_SERVICE_URL): https, or
 * http on a loopback host, with an optional path and nothing else. `fallback` stands in when the
 * variable is unset; without one, it is required.
 */
export function readServerUrl(env: SlotlockEnv, name: string, fallback?: string): string {
  const value = optional(env, name) ?? fallback;
  if (value === undefined) throw new SlotlockConfigError(`${name} is required`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SlotlockConfigError(`${name} must be an absolute URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new SlotlockConfigError(
      `${name} must use https://, or http:// on localhost, 127.0.0.1 or [::1]; terminate TLS at a reverse proxy for anything else`,
    );
  }
  if (parsed.username || parsed.password || value.includes('?') || value.includes('#')) {
    throw new SlotlockConfigError(
      `${name} must be an origin with an optional path, without credentials, query or fragment`,
    );
  }
  return parsed.href.replace(/\/$/, '');
}

/**
 * `SLOTLOCK_AVAILABILITY`: a JSON array of weekly rules. Each must produce a window in a two-week
 * sample, so a rule `expandRules` cannot evaluate (anything but FREQ=WEEKLY, BYDAY, INTERVAL=1 and
 * an absolute UNTIL) is a startup error instead of silently making every resource unbookable.
 */
export function readAvailability(env: SlotlockEnv): WeeklyAvailabilityRule[] {
  const value = optional(env, 'SLOTLOCK_AVAILABILITY');
  if (value === undefined) return [];
  const invalid = (detail: string) =>
    new SlotlockConfigError(
      `SLOTLOCK_AVAILABILITY must be a JSON array of at most ${SLOTLOCK_MAX_AVAILABILITY_RULES} weekly rules like {"rrule":"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR","startMinutes":540,"durationMinutes":480}: ${detail}`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid('it is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length > SLOTLOCK_MAX_AVAILABILITY_RULES) {
    throw invalid('it is not an array of rules');
  }
  return parsed.map((candidate: unknown, index) => {
    const problem = availabilityRuleProblem(candidate);
    if (problem === 'shape') {
      throw invalid(
        `rule ${index} needs rrule (string), startMinutes (0-1439) and durationMinutes (1-10080)`,
      );
    }
    if (problem === 'unsupported') {
      throw invalid(`rule ${index} is not a weekly rule with BYDAY that Slotlock can evaluate`);
    }
    const rule = candidate as WeeklyAvailabilityRule;
    return {
      rrule: rule.rrule,
      startMinutes: rule.startMinutes,
      durationMinutes: rule.durationMinutes,
    };
  });
}

/** The GitHub sign-in dashboard (dashboard.ts), served at `<publicUrl>/dashboard` when configured. */
export interface SlotlockServeDashboardConfig {
  githubClientId: string;
  githubClientSecret: string;
  sessionSecret: string;
  /** GitHub user ids that may sign in, or `'*'` for every GitHub account. */
  allowedUsers: '*' | string[];
  /** GitHub organization ids whose members share a tenant each (SLOTLOCK_DASHBOARD_ORGS). */
  organizations?: string[];
}

const DASHBOARD_VARIABLES = [
  'SLOTLOCK_GITHUB_CLIENT_ID',
  'SLOTLOCK_GITHUB_CLIENT_SECRET',
  'SLOTLOCK_SESSION_SECRET',
  'SLOTLOCK_DASHBOARD_USERS',
] as const;

/**
 * The dashboard's settings, or undefined when none is set. Setting any of them means serving the
 * dashboard, so the rest are then required: a half-configured sign-in is a startup error.
 */
export function readDashboardConfig(env: SlotlockEnv): SlotlockServeDashboardConfig | undefined {
  if (DASHBOARD_VARIABLES.every((name) => optional(env, name) === undefined)) return undefined;
  const githubClientId = optional(env, 'SLOTLOCK_GITHUB_CLIENT_ID');
  if (githubClientId === undefined || !/^[A-Za-z0-9._-]{1,100}$/.test(githubClientId)) {
    throw new SlotlockConfigError(
      'SLOTLOCK_GITHUB_CLIENT_ID is required to serve the dashboard: the Client ID of a GitHub OAuth app whose callback URL is <SLOTLOCK_PUBLIC_URL>/dashboard/callback',
    );
  }
  const githubClientSecret = readSecret(env, 'SLOTLOCK_GITHUB_CLIENT_SECRET');
  if (githubClientSecret === undefined) {
    throw new SlotlockConfigError(
      'SLOTLOCK_GITHUB_CLIENT_SECRET is required to serve the dashboard: a client secret of that GitHub OAuth app',
    );
  }
  const sessionSecret = readSecret(env, 'SLOTLOCK_SESSION_SECRET');
  if (sessionSecret === undefined) {
    throw new SlotlockConfigError(
      `SLOTLOCK_SESSION_SECRET is required to serve the dashboard: it signs sign-in sessions; ${SECRET_HINT}`,
    );
  }
  const others = [
    env.SLOTLOCK_GITHUB_CLIENT_SECRET,
    env.SLOTLOCK_AUTH_TOKEN,
    env.SLOTLOCK_CONFIRMATION_SECRET,
  ];
  if (others.includes(sessionSecret)) {
    throw new SlotlockConfigError('SLOTLOCK_SESSION_SECRET must differ from every other secret');
  }
  const users = optional(env, 'SLOTLOCK_DASHBOARD_USERS')?.replaceAll(' ', '');
  if (users === undefined || (users !== '*' && !/^[1-9]\d{0,19}(,[1-9]\d{0,19})*$/.test(users))) {
    throw new SlotlockConfigError(
      'SLOTLOCK_DASHBOARD_USERS is required to serve the dashboard: * for every GitHub account, or a comma-separated list of GitHub user ids (gh api users/<login> --jq .id)',
    );
  }
  const orgs = readDashboardOrganizations(env);
  return {
    githubClientId,
    githubClientSecret,
    sessionSecret,
    allowedUsers: users === '*' ? '*' : [...new Set(users.split(','))],
    ...(orgs !== undefined ? { organizations: orgs } : {}),
  };
}

/**
 * The GitHub organization ids of SLOTLOCK_DASHBOARD_ORGS, or undefined when unset. Read on its own as
 * well: a server whose dashboard runs elsewhere (on Cloudflare Workers) still takes those
 * organizations' keys, and only theirs.
 */
export function readDashboardOrganizations(env: SlotlockEnv): string[] | undefined {
  const orgs = optional(env, 'SLOTLOCK_DASHBOARD_ORGS')?.replaceAll(' ', '');
  if (orgs === undefined) return undefined;
  if (!/^[1-9]\d{0,19}(,[1-9]\d{0,19})*$/.test(orgs)) {
    throw new SlotlockConfigError(
      'SLOTLOCK_DASHBOARD_ORGS must be a comma-separated list of GitHub organization ids (gh api orgs/<login> --jq .id)',
    );
  }
  return [...new Set(orgs.split(','))];
}

/** A token bucket: `perSecond` tokens come back each second, and it holds at most `burst`. */
export interface SlotlockRate {
  perSecond: number;
  burst: number;
}

/** The token buckets `slotlock serve` keeps (SLOTLOCK_LIMITS), each counted per its own key. */
export const SLOTLOCK_RATE_NAMES = Object.freeze([
  'address',
  'key_read',
  'key_write',
  'tenant_read',
  'tenant_write',
  'global_read',
  'global_write',
  'app_read',
  'app_write',
  'sign_in',
] as const);
export type SlotlockRateName = (typeof SLOTLOCK_RATE_NAMES)[number];

/** The counts `slotlock serve` caps (SLOTLOCK_LIMITS), with the range each may be set to. */
const CAP_RANGES = Object.freeze({
  tenant_series_writes: [1, 100],
  series_writes: [1, 100],
  maintenance_runs: [1, 100],
  subscriptions: [1, 10_000],
  tenant_subscriptions: [1, 10_000],
  key_subscriptions: [1, 64],
  key_lookups: [1, 8],
  key_lookup_queue: [0, 10_000],
  // serve's pool has 10 connections: more than that bounds nothing.
  tenant_transactions: [1, 10],
  tenant_holds: [1, 10_000_000],
  tenant_reservations: [1, 10_000_000],
  tenant_events: [1, 10_000_000],
  tenant_coverage: [1, 10_000_000],
} as const);
export type SlotlockCapName = keyof typeof CAP_RANGES;
export const SLOTLOCK_CAP_NAMES = Object.freeze(Object.keys(CAP_RANGES) as SlotlockCapName[]);

export interface SlotlockLimits {
  /** Each rate, or null where SLOTLOCK_LIMITS turns it off. */
  rates: Readonly<Record<SlotlockRateName, SlotlockRate | null>>;
  caps: Readonly<Record<SlotlockCapName, number>>;
}

/**
 * What `slotlock serve` allows unless SLOTLOCK_LIMITS says otherwise, sized for one public server on
 * one CPU (the 2026-10-24 readiness audit measured the database at about 900 writes a second):
 * - `address`: every request from one client address, before any credential is looked up.
 * - `key_*`, `tenant_*`, `global_*`: an authenticated request takes a read token from its key, its
 *   tenant and the server; a write (a REST method other than GET or HEAD, or a write tool) takes a
 *   write token from each as well.
 * - `app_*`: a request to the application API (application-api.ts) from an admin key takes its
 *   read and write tokens from its tenant's application buckets instead of the key and tenant ones,
 *   so the application and the tenant's agents cannot use up each other's budget; one from any
 *   other key takes them from that key's own. `global_*` counts it as well.
 * - `sign_in`: dashboard sign-ins and their callbacks from one client network: an IPv4 address,
 *   or an IPv6 client's /48 (slotlockClientNetwork in rate-limit.ts), as the dashboard Worker
 *   counts them.
 * - `tenant_series_writes` and `series_writes`: writes that may expand a recurring series (a
 *   recurring create, any update) running at once in a tenant and in each server process.
 * - `maintenance_runs`: the application API's maintenance runs at once in each server process, one
 *   a tenant, in slots of their own. A freed slot of either kind rests for as long as the event
 *   loop was busy while its write held it, up to a second, then goes to the tenant with the fewest
 *   writes in flight and, among those, the least use lately. That keeps a tenant sending one write
 *   at a time from waiting behind tenants with more, not behind many tenants with one each
 *   (rate-limit.ts).
 * - `subscriptions`: MCP live-update streams the server holds open. When it is full, a tenant
 *   holding fewer than the tenant holding most, less one, ends that tenant's oldest stream.
 * - `tenant_subscriptions`: of those, how many one tenant may hold.
 * - `key_subscriptions`: of those, how many one key (or the server token) may hold, and always
 *   fewer than its tenant's, so one key cannot lock the tenant's other keys out
 *   (slotlockKeySubscriptions).
 * - `key_lookups` and `key_lookup_queue`: API key lookups running at once and waiting.
 * - `tenant_transactions`: store transactions one tenant runs at once on the server's pool of 10
 *   connections; the rest wait their turn in the process, so a tenant's writes waiting on its own
 *   locks leave the other connections to other tenants and key lookups. A server with one tenant
 *   can set 10.
 * - `tenant_holds`, `tenant_reservations`, `tenant_events` and `tenant_coverage`: what one tenant
 *   may store, counted as the store's tenant limits count it (SlotlockTenantLimits), whichever key,
 *   agent or application writes it. Every write surface of the server shares them, so no admin
 *   key can grow the shared database without end; a write past one answers 409 with its
 *   `*_limit_reached` code.
 */
export const SLOTLOCK_DEFAULT_LIMITS: SlotlockLimits = Object.freeze({
  rates: Object.freeze({
    address: { perSecond: 50, burst: 100 },
    key_read: { perSecond: 20, burst: 40 },
    key_write: { perSecond: 5, burst: 20 },
    tenant_read: { perSecond: 20, burst: 40 },
    tenant_write: { perSecond: 5, burst: 20 },
    global_read: { perSecond: 500, burst: 1_000 },
    global_write: { perSecond: 50, burst: 100 },
    app_read: { perSecond: 20, burst: 40 },
    app_write: { perSecond: 5, burst: 20 },
    sign_in: { perSecond: 20 / 60, burst: 20 },
  }),
  caps: Object.freeze({
    tenant_series_writes: 1,
    series_writes: 1,
    maintenance_runs: 1,
    subscriptions: 256,
    tenant_subscriptions: 16,
    key_subscriptions: 4,
    key_lookups: 2,
    key_lookup_queue: 256,
    tenant_transactions: 2,
    // Sized for the server's 10,000 resources a tenant: a live hold for every one, ten bookings and
    // ten events a resource, and coverage from ten calendars a resource.
    tenant_holds: 10_000,
    tenant_reservations: 100_000,
    tenant_events: 100_000,
    tenant_coverage: 100_000,
  }),
});

/**
 * The live-update streams one key may hold open: `key_subscriptions`, but at least one fewer than
 * its tenant may (unless the tenant may hold only one), so a key at its own limit leaves its
 * tenant's other keys a stream however the two caps are set.
 */
export function slotlockKeySubscriptions(caps: Readonly<Record<SlotlockCapName, number>>): number {
  return Math.max(1, Math.min(caps.key_subscriptions, caps.tenant_subscriptions - 1));
}

const RATE_PERIOD_SECONDS: Readonly<Record<string, number>> = { s: 1, m: 60, h: 3_600 };
const MAX_RATE_COUNT = 1_000_000;

/** A rate as SLOTLOCK_LIMITS and the `listening` log line write it: `<count>/<s|m|h>:<burst>`. */
export function formatSlotlockRate(rate: SlotlockRate | null): string {
  if (rate === null) return 'off';
  // The smallest unit in which the count is whole: 50/s rather than 180000/h.
  for (const [unit, seconds] of Object.entries(RATE_PERIOD_SECONDS)) {
    const count = rate.perSecond * seconds;
    if (Number.isInteger(Math.round(count * 1e9) / 1e9) && count >= 1) {
      return `${Math.round(count)}/${unit}:${rate.burst}`;
    }
  }
  return `${rate.perSecond}/s:${rate.burst}`;
}

/**
 * SLOTLOCK_LIMITS: comma-separated `name=value` overrides of SLOTLOCK_DEFAULT_LIMITS. A rate is
 * `<count>/<s|m|h>`, optionally `:<burst>` (default: the count), or `off`; a cap is a whole number.
 * For example `tenant_write=2/s:10,global_write=30/s,address=off`.
 */
export function readLimits(env: SlotlockEnv): SlotlockLimits {
  const rates: Record<SlotlockRateName, SlotlockRate | null> = { ...SLOTLOCK_DEFAULT_LIMITS.rates };
  const caps: Record<SlotlockCapName, number> = { ...SLOTLOCK_DEFAULT_LIMITS.caps };
  const value = optional(env, 'SLOTLOCK_LIMITS');
  if (value === undefined) return { rates, caps };
  const invalid = (detail: string) =>
    new SlotlockConfigError(
      `SLOTLOCK_LIMITS must be comma-separated name=value settings, rates as <count>/<s|m|h>[:<burst>] or off (${SLOTLOCK_RATE_NAMES.join(', ')}) and caps as whole numbers (${SLOTLOCK_CAP_NAMES.join(', ')}): ${detail}`,
    );
  const seen = new Set<string>();
  for (const entry of value.split(',').map((part) => part.trim())) {
    const match = /^([a-z_]+)=(\S+)$/.exec(entry);
    if (!match) throw invalid(`"${entry.slice(0, 40)}" is not name=value`);
    const [, name, setting] = match as unknown as [string, string, string];
    if (seen.has(name)) throw invalid(`${name} is set twice`);
    seen.add(name);
    if ((SLOTLOCK_RATE_NAMES as readonly string[]).includes(name)) {
      if (setting === 'off') {
        rates[name as SlotlockRateName] = null;
        continue;
      }
      const rate = /^(\d{1,7})\/([smh])(?::(\d{1,7}))?$/.exec(setting);
      const count = Number(rate?.[1]);
      const burst = rate?.[3] === undefined ? count : Number(rate[3]);
      if (!rate || count < 1 || count > MAX_RATE_COUNT || burst < 1 || burst > MAX_RATE_COUNT) {
        throw invalid(`${name} must be <count>/<s|m|h>[:<burst>] with each 1-${MAX_RATE_COUNT}, or off`);
      }
      rates[name as SlotlockRateName] = {
        perSecond: count / (RATE_PERIOD_SECONDS[rate[2] as string] as number),
        burst,
      };
    } else if (Object.hasOwn(CAP_RANGES, name)) {
      const [minimum, maximum] = CAP_RANGES[name as SlotlockCapName];
      const cap = /^\d{1,8}$/.test(setting) ? Number(setting) : Number.NaN;
      if (!(cap >= minimum && cap <= maximum)) {
        throw invalid(`${name} must be a whole number from ${minimum} to ${maximum}`);
      }
      caps[name as SlotlockCapName] = cap;
    } else {
      throw invalid(`${name.slice(0, 40)} is not a limit`);
    }
  }
  return { rates, caps };
}

/** Fields a proxy cannot be trusted to set, because the client sends them to every server. */
const UNTRUSTABLE_FIELDS = new Set(['authorization', 'cookie', 'host', 'origin', 'content-type']);

/**
 * SLOTLOCK_TRUSTED_PROXY_HEADER: the request field holding the client's address, set (and
 * overwritten) by a proxy every request passes through, such as `CF-Connecting-IP` behind
 * Cloudflare. Unset, the client address is the connection's. A client can send any field, so set it
 * only when nothing reaches the server except through that proxy.
 */
export function readTrustedProxyHeader(env: SlotlockEnv): string | undefined {
  const value = optional(env, 'SLOTLOCK_TRUSTED_PROXY_HEADER');
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(value) || UNTRUSTABLE_FIELDS.has(value.toLowerCase())) {
    throw new SlotlockConfigError(
      'SLOTLOCK_TRUSTED_PROXY_HEADER must be the name of a request field your proxy sets to the client address, such as CF-Connecting-IP',
    );
  }
  return value.toLowerCase();
}
