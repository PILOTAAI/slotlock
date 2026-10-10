// Self-hosting: the commands behind the `slotlock` executable (cli.ts holds only the process wiring).
// Configuration comes from environment variables alone, so a container, process manager or CI job
// supplies it the same way and nothing is read from a file or a request. A missing or weak secret
// stops a command before it connects anywhere, and no secret is written to a log line or an error.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import {
  type SlotlockAgentOperation,
  type SlotlockAgentPrincipal,
  type SlotlockAgentWriteOperation,
  createSlotlockAgentServer,
} from './agent-server.js';
import { createSlotlockStoreAgentBackend } from './agent-store-backend.js';
import {
  type SlotlockNodeServerAddress,
  type SlotlockNodeServerCloseResult,
  createSlotlockNodeServer,
} from './node-server.js';
import { expandRules } from './rules.js';
import { type SlotlockSql, createSlotlockStore } from './store.js';
import type { SlotlockResource, WeeklyAvailabilityRule } from './types.js';

export type SlotlockEnv = Readonly<Record<string, string | undefined>>;

/** Every variable the commands read. The README, `.env.example` and `server.json` document these. */
export const SLOTLOCK_ENVIRONMENT_VARIABLES = Object.freeze([
  'DATABASE_URL',
  'SLOTLOCK_MIGRATE_DATABASE_URL',
  'SLOTLOCK_AUTH_TOKEN',
  'SLOTLOCK_CONFIRMATION_SECRET',
  'SLOTLOCK_CONFIRM_WRITES',
  'SLOTLOCK_PUBLIC_URL',
  'SLOTLOCK_TENANT',
  'SLOTLOCK_AVAILABILITY',
  'HOST',
  'PORT',
] as const);

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;
const DEFAULT_TENANT = 'default';
/** The principal every valid token resolves to: a self-hosted server has one operator and tenant. */
const SELF_HOST_SUBJECT = 'self-host';
const MIN_SECRET_CHARACTERS = 32;
/** Rejects repeated or patterned values (`aaaa…`, `abcabc…`); random hex has about 16. */
const MIN_DISTINCT_SECRET_CHARACTERS = 10;
const PLACEHOLDER_SECRET = /change.?me|replace.?me|example|placeholder/i;
const SECRET_HINT = 'generate one with `openssl rand -hex 32`';
const WRITE_OPERATIONS: readonly SlotlockAgentWriteOperation[] = [
  'slotlock_create_event',
  'slotlock_update_event',
  'slotlock_delete_event',
];
/**
 * What `serve` lets the token holder call. An allow-list, so an operation a later release adds stays
 * refused until it is listed here and reviewed.
 */
const SERVED_OPERATIONS: ReadonlySet<SlotlockAgentOperation> = new Set([
  'slotlock_list_resources',
  'slotlock_get_free_busy',
  'slotlock_find_next_available',
  'slotlock_create_event',
  'slotlock_get_event',
  'slotlock_list_events',
  'slotlock_update_event',
  'slotlock_delete_event',
]);
const AVAILABILITY_RULE_KEYS = new Set(['rrule', 'startMinutes', 'durationMinutes']);
const MAX_AVAILABILITY_RULES = 50;
const HEALTH_QUERY_TIMEOUT_MS = 2_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;
const POOL_SIZE = 10;
const RESOURCE_PAGE_SIZE = 1_000;

/** A configuration a command refuses to run with. The message names the variable, never its value. */
export class SlotlockConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotlockConfigError';
  }
}

export interface SlotlockDatabaseConfig {
  /** The role `serve` and `resource` connect as. */
  databaseUrl: string;
  /**
   * The role `migrate` connects as, which owns the schema. When it differs from `databaseUrl`'s
   * role, `migrate` grants that role exactly the runtime access it needs (`grantApplicationRole`).
   */
  migrateDatabaseUrl?: string;
  tenantRef: string;
}

export interface SlotlockServeConfig extends SlotlockDatabaseConfig {
  host: string;
  port: number;
  /** Where clients reach the server; Slotlock publishes its endpoints under this URL. */
  publicUrl: string;
  authToken: string;
  /** Writes that wait for a person's confirmation (MCP 2026-07-28) and are refused elsewhere. */
  confirmWrites: readonly SlotlockAgentWriteOperation[];
  /** Set exactly when `confirmWrites` is not empty. */
  confirmationSecret?: string;
  /** Bookable hours, applied to every resource in its own timezone. Empty: never bookable. */
  availability: readonly WeeklyAvailabilityRule[];
}

/** An unset variable and an empty one (`FOO=` in an env file) both mean "not configured". */
function optional(env: SlotlockEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function readSecret(env: SlotlockEnv, name: string): string | undefined {
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

function readDatabaseUrl(env: SlotlockEnv, name: string): string | undefined {
  const value = optional(env, name);
  if (value === undefined) return undefined;
  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch {
    // Reported below without the value, which holds a password.
  }
  if (parsed?.protocol !== 'postgres:' && parsed?.protocol !== 'postgresql:') {
    throw new SlotlockConfigError(
      `${name} must be a postgres:// or postgresql:// connection URL (percent-encode special characters in the password)`,
    );
  }
  return value;
}

function readPort(env: SlotlockEnv): number {
  const value = optional(env, 'PORT');
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65_535) {
    throw new SlotlockConfigError('PORT must be an integer from 0 to 65535');
  }
  return Number(value);
}

function readHost(env: SlotlockEnv): string {
  const value = optional(env, 'HOST') ?? DEFAULT_HOST;
  if (value.length > 253 || /\s/.test(value)) {
    throw new SlotlockConfigError('HOST must be a hostname or IP address');
  }
  return value;
}

function readPublicUrl(env: SlotlockEnv, port: number): string {
  const value = optional(env, 'SLOTLOCK_PUBLIC_URL') ?? `http://localhost:${port}`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SlotlockConfigError('SLOTLOCK_PUBLIC_URL must be an absolute URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new SlotlockConfigError(
      'SLOTLOCK_PUBLIC_URL must use https://, or http:// on localhost, 127.0.0.1 or [::1]; terminate TLS at a reverse proxy for anything else',
    );
  }
  if (parsed.username || parsed.password || value.includes('?') || value.includes('#')) {
    throw new SlotlockConfigError(
      'SLOTLOCK_PUBLIC_URL must be an origin with an optional path, without credentials, query or fragment',
    );
  }
  return parsed.href.replace(/\/$/, '');
}

function readTenant(env: SlotlockEnv): string {
  const value = optional(env, 'SLOTLOCK_TENANT') ?? DEFAULT_TENANT;
  const control = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (control || Buffer.byteLength(value, 'utf8') > 200) {
    throw new SlotlockConfigError('SLOTLOCK_TENANT must be 1-200 bytes without control characters');
  }
  return value;
}

function readConfirmWrites(env: SlotlockEnv): SlotlockAgentWriteOperation[] {
  const value = optional(env, 'SLOTLOCK_CONFIRM_WRITES') ?? 'all';
  if (value === 'all') return [...WRITE_OPERATIONS];
  if (value === 'none') return [];
  const operations: SlotlockAgentWriteOperation[] = [];
  for (const name of value.split(',').map((part) => part.trim())) {
    const operation = WRITE_OPERATIONS.find((candidate) => candidate === name);
    if (!operation) {
      throw new SlotlockConfigError(
        `SLOTLOCK_CONFIRM_WRITES must be all, none, or a comma-separated list of ${WRITE_OPERATIONS.join(', ')}`,
      );
    }
    if (!operations.includes(operation)) operations.push(operation);
  }
  return operations;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `SLOTLOCK_AVAILABILITY`: a JSON array of weekly rules. Each must produce a window in a two-week
 * sample, so a rule `expandRules` cannot evaluate (not weekly, COUNT, INTERVAL>1, no BYDAY) is a
 * startup error instead of silently making every resource unbookable.
 */
function readAvailability(env: SlotlockEnv): WeeklyAvailabilityRule[] {
  const value = optional(env, 'SLOTLOCK_AVAILABILITY');
  if (value === undefined) return [];
  const invalid = (detail: string) =>
    new SlotlockConfigError(
      `SLOTLOCK_AVAILABILITY must be a JSON array of at most ${MAX_AVAILABILITY_RULES} weekly rules like {"rrule":"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR","startMinutes":540,"durationMinutes":480}: ${detail}`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid('it is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_AVAILABILITY_RULES) {
    throw invalid('it is not an array of rules');
  }
  const sample = { start: new Date('2026-01-05T00:00:00Z'), end: new Date('2026-01-19T00:00:00Z') };
  return parsed.map((candidate: unknown, index) => {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).some((key) => !AVAILABILITY_RULE_KEYS.has(key)) ||
      typeof candidate.rrule !== 'string' ||
      candidate.rrule.length === 0 ||
      candidate.rrule.length > 500 ||
      !Number.isInteger(candidate.startMinutes) ||
      (candidate.startMinutes as number) < 0 ||
      (candidate.startMinutes as number) > 1_439 ||
      !Number.isInteger(candidate.durationMinutes) ||
      (candidate.durationMinutes as number) < 1 ||
      (candidate.durationMinutes as number) > 10_080
    ) {
      throw invalid(
        `rule ${index} needs rrule (string), startMinutes (0-1439) and durationMinutes (1-10080)`,
      );
    }
    const rule: WeeklyAvailabilityRule = {
      rrule: candidate.rrule,
      startMinutes: candidate.startMinutes as number,
      durationMinutes: candidate.durationMinutes as number,
    };
    if (expandRules([rule], sample).length === 0) {
      throw invalid(`rule ${index} is not a weekly rule with BYDAY that Slotlock can evaluate`);
    }
    return rule;
  });
}

export function readSlotlockDatabaseConfig(env: SlotlockEnv): SlotlockDatabaseConfig {
  const databaseUrl = readDatabaseUrl(env, 'DATABASE_URL');
  if (databaseUrl === undefined) {
    throw new SlotlockConfigError(
      'DATABASE_URL is required: the postgres:// URL of the role Slotlock serves as',
    );
  }
  const config: SlotlockDatabaseConfig = { databaseUrl, tenantRef: readTenant(env) };
  const migrateDatabaseUrl = readDatabaseUrl(env, 'SLOTLOCK_MIGRATE_DATABASE_URL');
  if (migrateDatabaseUrl !== undefined) config.migrateDatabaseUrl = migrateDatabaseUrl;
  return config;
}

export function readSlotlockServeConfig(env: SlotlockEnv): SlotlockServeConfig {
  const database = readSlotlockDatabaseConfig(env);
  const authToken = readSecret(env, 'SLOTLOCK_AUTH_TOKEN');
  if (authToken === undefined) {
    throw new SlotlockConfigError(
      `SLOTLOCK_AUTH_TOKEN is required: the bearer token MCP and A2A clients send; ${SECRET_HINT}`,
    );
  }
  const confirmWrites = readConfirmWrites(env);
  const confirmationSecret = readSecret(env, 'SLOTLOCK_CONFIRMATION_SECRET');
  if (confirmWrites.length > 0 && confirmationSecret === undefined) {
    throw new SlotlockConfigError(
      `SLOTLOCK_CONFIRMATION_SECRET is required while SLOTLOCK_CONFIRM_WRITES guards writes (the default): it signs each pending confirmation; ${SECRET_HINT}, or set SLOTLOCK_CONFIRM_WRITES=none to let agents write without asking a person`,
    );
  }
  if (confirmationSecret !== undefined && confirmationSecret === authToken) {
    throw new SlotlockConfigError(
      'SLOTLOCK_CONFIRMATION_SECRET must differ from SLOTLOCK_AUTH_TOKEN',
    );
  }
  const port = readPort(env);
  const config: SlotlockServeConfig = {
    ...database,
    host: readHost(env),
    port,
    publicUrl: readPublicUrl(env, port),
    authToken,
    confirmWrites,
    availability: readAvailability(env),
  };
  if (confirmWrites.length > 0 && confirmationSecret !== undefined) {
    config.confirmationSecret = confirmationSecret;
  }
  return config;
}

/**
 * The URL `slotlock healthcheck` probes: the local listener (a wildcard bind is probed on loopback)
 * plus the public URL's path, which is where the server answers.
 */
export function slotlockHealthcheckUrl(env: SlotlockEnv): string {
  const port = readPort(env);
  if (port === 0)
    throw new SlotlockConfigError('PORT must name the listening port to check health');
  const host = readHost(env);
  const target = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const basePath = new URL(readPublicUrl(env, port)).pathname.replace(/\/$/, '');
  return `http://${target.includes(':') ? `[${target}]` : target}:${port}${basePath}/healthz`;
}

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Single-tenant bearer authentication: a request carrying exactly `token` is `principal`, anything
 * else is anonymous (401). Digests are compared in constant time, so timing reveals nothing about
 * the token, not even its length.
 */
export function createSlotlockTokenAuthenticator(
  token: string,
  principal: SlotlockAgentPrincipal,
): (request: Request) => Promise<SlotlockAgentPrincipal | null> {
  const expected = sha256(token);
  return async (request) => {
    const presented = /^Bearer +(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
    if (presented === undefined) return null;
    return timingSafeEqual(sha256(presented), expected) ? { ...principal } : null;
  };
}

interface OutputStream {
  write(chunk: string): unknown;
}

export interface SlotlockCliIo {
  env: SlotlockEnv;
  stdout: OutputStream;
  stderr: OutputStream;
  /** Aborting it stops `serve` gracefully; cli.ts aborts it on SIGINT and SIGTERM. */
  signal: AbortSignal;
}

export interface SlotlockLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** Every configured secret, and each database password alone, so no log line can carry one. */
function secretsIn(env: SlotlockEnv): string[] {
  const secrets: string[] = [];
  for (const name of ['SLOTLOCK_AUTH_TOKEN', 'SLOTLOCK_CONFIRMATION_SECRET']) {
    const value = env[name]?.trim();
    if (value) secrets.push(value);
  }
  for (const name of ['DATABASE_URL', 'SLOTLOCK_MIGRATE_DATABASE_URL']) {
    const value = env[name]?.trim();
    if (!value) continue;
    secrets.push(value);
    try {
      const password = new URL(value).password;
      if (password) secrets.push(password, decodeURIComponent(password));
    } catch {
      // An unparseable URL is refused before anything is logged.
    }
  }
  // Longest first, so a URL is replaced whole rather than around its password.
  return [...new Set(secrets)].sort((a, b) => b.length - a.length);
}

/** One JSON object per line: info on stdout, errors on stderr, secrets replaced by `[redacted]`. */
function createLogger(io: SlotlockCliIo): SlotlockLogger {
  const secrets = secretsIn(io.env);
  const write = (stream: OutputStream, level: string, event: string, fields = {}) => {
    let line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
    for (const secret of secrets) line = line.split(secret).join('[redacted]');
    stream.write(`${line}\n`);
  };
  return {
    info: (event, fields) => write(io.stdout, 'info', event, fields),
    error: (event, fields) => write(io.stderr, 'error', event, fields),
  };
}

/** What a failure log line says: the message plus a code and reasons when the error carries them. */
function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: 'unknown_error' };
  const detail: Record<string, unknown> = { error: error.message };
  const { code, reasons } = error as { code?: unknown; reasons?: unknown };
  if (typeof code === 'string') detail.code = code;
  if (Array.isArray(reasons)) {
    detail.reasons = reasons.filter((reason) => typeof reason === 'string').slice(0, 20);
  }
  return detail;
}

function connect(url: string, max: number): postgres.Sql {
  return postgres(url, { max, onnotice: () => {}, connect_timeout: 10 });
}

async function currentRole(sql: SlotlockSql): Promise<string> {
  const [row] = await sql<{ role: string }[]>`SELECT current_user AS role`;
  if (!row) throw new Error('current_user returned no row');
  return row.role;
}

/**
 * Apply the schema and forced row-level security as the owning role (idempotent and serialized
 * across instances), then grant the serving role its runtime access when that is another role.
 */
export async function migrateSlotlock(config: SlotlockDatabaseConfig, log: SlotlockLogger): Promise<void> {
  const owner = connect(config.migrateDatabaseUrl ?? config.databaseUrl, 1);
  try {
    const store = createSlotlockStore(owner);
    await store.applySchema();
    await store.applyTenantRls();
    log.info('schema_applied');
    if (config.migrateDatabaseUrl === undefined) return;
    const application = connect(config.databaseUrl, 1);
    let role: string;
    try {
      role = await currentRole(application);
    } finally {
      await application.end({ timeout: 5 });
    }
    if (role !== (await currentRole(owner))) {
      await store.grantApplicationRole(role);
      log.info('application_role_granted', { role });
    }
  } finally {
    await owner.end({ timeout: 5 });
  }
}

async function databaseReachable(sql: SlotlockSql): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sql`SELECT 1`.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), HEALTH_QUERY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface SlotlockRunningServer {
  address: SlotlockNodeServerAddress;
  /** End open subscriptions, drain in-flight requests, then close the database pool. */
  close(): Promise<SlotlockNodeServerCloseResult>;
}

/** Serve MCP and A2A over HTTP from the Postgres store, as one token-authenticated tenant. */
export async function startSlotlockServer(
  config: SlotlockServeConfig,
  log: SlotlockLogger,
): Promise<SlotlockRunningServer> {
  const sql = connect(config.databaseUrl, POOL_SIZE);
  try {
    const [schema] = await sql<{ present: boolean }[]>`
      SELECT to_regclass('slotlock.resources') IS NOT NULL AS present`;
    if (!schema?.present) {
      throw Object.assign(
        new Error(
          'The slotlock schema is missing: run `slotlock migrate` or `slotlock serve --migrate`',
        ),
        { code: 'schema_missing' },
      );
    }
    const store = createSlotlockStore(sql);
    const publicUrl = new URL(config.publicUrl);
    const agentServer = createSlotlockAgentServer({
      publicBaseUrl: config.publicUrl,
      // readPublicUrl admits plain HTTP only on a loopback host, which is all this permits anyway.
      allowInsecureLocalhost: publicUrl.protocol === 'http:',
      backend: createSlotlockStoreAgentBackend(store, {
        availabilityRules: async () => config.availability.map((rule) => ({ ...rule })),
      }),
      authenticate: createSlotlockTokenAuthenticator(config.authToken, {
        subject: SELF_HOST_SUBJECT,
        tenantRef: config.tenantRef,
      }),
      authorize: async ({ operation }) => SERVED_OPERATIONS.has(operation),
      health: async () =>
        (await databaseReachable(sql))
          ? { ready: true, checks: ['database'] }
          : { ready: false, checks: ['database_unreachable'] },
      // Outcomes and counts only: the server never reports arguments or identities.
      onEvent: ({ type, ...fields }) => log.info(type, fields),
      ...(config.confirmationSecret !== undefined
        ? {
            confirmation: {
              operations: config.confirmWrites,
              secrets: [config.confirmationSecret],
            },
          }
        : {}),
    });
    const listener = createSlotlockNodeServer(agentServer, {
      requestOrigin: publicUrl.origin,
      onError: (error, phase) => log.error('http_error', { phase, ...describeError(error) }),
    });
    const address = await listener.listen({ host: config.host, port: config.port });
    log.info('listening', {
      address: address.origin,
      mcp: `${config.publicUrl}/mcp`,
      a2a: `${config.publicUrl}/a2a`,
      tenant: config.tenantRef,
      confirm_writes: config.confirmWrites,
      availability_rules: config.availability.length,
    });
    return {
      address,
      async close() {
        const result = await listener.close();
        await sql.end({ timeout: 5 });
        return result;
      },
    };
  } catch (error) {
    await sql.end({ timeout: 5 });
    throw error;
  }
}

function resourceLine(resource: SlotlockResource): string {
  return `${JSON.stringify({
    id: resource.id,
    external_ref: resource.externalRef,
    timezone: resource.timezone,
  })}\n`;
}

/** `resource add`: create (or, for an existing reference, re-zone) one resource in the tenant. */
async function addResource(
  config: SlotlockDatabaseConfig,
  externalRef: string,
  timezone: string,
): Promise<SlotlockResource> {
  const sql = connect(config.databaseUrl, 1);
  try {
    return await createSlotlockStore(sql).withTenant(config.tenantRef, (tenant) =>
      tenant.createResource({ tenantRef: config.tenantRef, externalRef, timezone }),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function listResources(config: SlotlockDatabaseConfig, out: OutputStream): Promise<void> {
  const sql = connect(config.databaseUrl, 1);
  try {
    const store = createSlotlockStore(sql);
    let after: string | undefined;
    for (;;) {
      const page = await store.withTenant(config.tenantRef, (tenant) =>
        tenant.listResources({
          tenantRef: config.tenantRef,
          limit: RESOURCE_PAGE_SIZE,
          ...(after !== undefined ? { after } : {}),
        }),
      );
      for (const resource of page) out.write(resourceLine(resource));
      after = page.at(-1)?.id;
      if (page.length < RESOURCE_PAGE_SIZE || after === undefined) return;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function healthcheck(env: SlotlockEnv): Promise<boolean> {
  try {
    const response = await fetch(slotlockHealthcheckUrl(env), {
      signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MS),
    });
    return response.status === 200;
  } catch (error) {
    if (error instanceof SlotlockConfigError) throw error;
    return false;
  }
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

/** The package version, from dist/package.json when installed and the root manifest in a checkout. */
function packageVersion(): string {
  for (const candidate of ['./package.json', '../package.json']) {
    try {
      const manifest = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === 'slotlock' && typeof manifest.version === 'string') {
        return manifest.version;
      }
    } catch {
      // Not this layout; try the next.
    }
  }
  return 'unknown';
}

export const SLOTLOCK_CLI_HELP = `Usage: slotlock <command> [options]

Commands:
  migrate                  Apply the schema and row-level security, then grant the serving
                           role when SLOTLOCK_MIGRATE_DATABASE_URL names another role
  serve [--migrate]        Serve MCP and A2A over HTTP (--migrate runs migrate first)
  resource add <ref> [--timezone <IANA zone>]
                           Create a calendar resource (a car, room, person or machine)
  resource list            Print the tenant's resources, one JSON object per line
  healthcheck              Exit 0 when the local server reports ready

Options:
  -h, --help               Show this help
  -v, --version            Print the version

Environment:
  DATABASE_URL                   postgres:// URL of the role Slotlock serves as (required)
  SLOTLOCK_MIGRATE_DATABASE_URL  postgres:// URL of the schema owner, for migrate (optional)
  SLOTLOCK_AUTH_TOKEN            Bearer token clients send, 32+ random characters (serve)
  SLOTLOCK_CONFIRMATION_SECRET   Signs pending write confirmations, 32+ random characters (serve)
  SLOTLOCK_CONFIRM_WRITES        all (default), none, or a comma-separated list of write tools
  SLOTLOCK_PUBLIC_URL            URL clients use (default http://localhost:$PORT)
  SLOTLOCK_TENANT                Tenant every request acts in (default "default")
  SLOTLOCK_AVAILABILITY          JSON array of weekly bookable-hours rules (default: none)
  HOST                           Listen address (default 127.0.0.1)
  PORT                           Listen port (default 8080)

Generate each secret with: openssl rand -hex 32
`;

/**
 * Run one `slotlock` command and resolve to its exit code: 0 success, 1 failure, 2 a usage or
 * configuration error (nothing was started). `serve` resolves once `io.signal` aborts and it has
 * shut down.
 */
export async function runSlotlockCli(argv: readonly string[], io: SlotlockCliIo): Promise<number> {
  const usage = (message: string): number => {
    io.stderr.write(`slotlock: ${message}\nRun "slotlock --help" for usage.\n`);
    return 2;
  };
  let parsed: ReturnType<typeof parseCliArguments>;
  try {
    parsed = parseCliArguments(argv);
  } catch (error) {
    return usage(error instanceof Error ? error.message : 'invalid arguments');
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  const [command, ...operands] = positionals;
  if (values.help || command === 'help') {
    io.stdout.write(SLOTLOCK_CLI_HELP);
    return 0;
  }
  if (command === undefined) {
    io.stderr.write(SLOTLOCK_CLI_HELP);
    return 2;
  }
  const subcommand = command === 'resource' ? `resource ${operands[0] ?? ''}`.trim() : command;
  const expectedOperands: Record<string, number> = {
    migrate: 0,
    serve: 0,
    healthcheck: 0,
    'resource add': 2,
    'resource list': 1,
  };
  const expected = expectedOperands[subcommand];
  if (expected === undefined) return usage(`unknown command "${subcommand}"`);
  if (operands.length !== expected) return usage(`wrong number of arguments for "${subcommand}"`);
  if (values.migrate && subcommand !== 'serve') return usage('--migrate applies only to serve');
  if (values.timezone !== undefined && subcommand !== 'resource add') {
    return usage('--timezone applies only to resource add');
  }

  const log = createLogger(io);
  try {
    switch (subcommand) {
      case 'migrate':
        await migrateSlotlock(readSlotlockDatabaseConfig(io.env), log);
        return 0;
      case 'serve': {
        const config = readSlotlockServeConfig(io.env);
        if (values.migrate) await migrateSlotlock(config, log);
        if (io.signal.aborted) return 0;
        const server = await startSlotlockServer(config, log);
        await untilAborted(io.signal);
        log.info('stopping');
        const { forced } = await server.close();
        log.info('stopped', { forced });
        return 0;
      }
      case 'resource add': {
        const config = readSlotlockDatabaseConfig(io.env);
        const resource = await addResource(config, operands[1] as string, values.timezone ?? 'UTC');
        io.stdout.write(resourceLine(resource));
        return 0;
      }
      case 'resource list':
        await listResources(readSlotlockDatabaseConfig(io.env), io.stdout);
        return 0;
      default:
        return (await healthcheck(io.env)) ? 0 : 1;
    }
  } catch (error) {
    if (error instanceof SlotlockConfigError) {
      io.stderr.write(`slotlock: ${error.message}\n`);
      return 2;
    }
    log.error(`${subcommand.replace(' ', '_')}_failed`, describeError(error));
    return 1;
  }
}

function parseCliArguments(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      migrate: { type: 'boolean' },
      timezone: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}
