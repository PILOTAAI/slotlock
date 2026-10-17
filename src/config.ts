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
  return {
    githubClientId,
    githubClientSecret,
    sessionSecret,
    allowedUsers: users === '*' ? '*' : [...new Set(users.split(','))],
  };
}
