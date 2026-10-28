// Self-hosting: the commands behind the `slotlock` executable (cli.ts holds only the process wiring).
// Configuration comes from environment variables alone, so a container, process manager or CI job
// supplies it the same way and nothing is read from a file or a request. A missing or weak secret
// stops a command before it connects anywhere, and no secret is written to a log line or an error.
// The one exception is the API key `key create` prints: that output is the key's only copy.
import {
  type SlotlockWebhookScheduler,
  createSlotlockWebhookSender,
  deliverSlotlockWebhooks,
  startSlotlockWebhookDelivery,
} from './webhooks.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import {
  type SlotlockAgentOperation,
  type SlotlockAgentPrincipal,
  type SlotlockAgentWriteOperation,
  createSlotlockAgentServer,
  slotlockAgentOperationScope,
} from './agent-server.js';
import {
  createSlotlockStoreAgentBackend,
  createSlotlockStoreApplicationBackend,
} from './agent-store-backend.js';
import {
  SLOTLOCK_API_KEY_DEFAULT_SCOPES,
  SLOTLOCK_API_KEY_MAX_LIFETIME_DAYS,
  SLOTLOCK_API_KEY_SCOPES,
  type SlotlockApiKey,
  type SlotlockApiKeyScope,
  createSlotlockApiKeyAuthenticator,
  createSlotlockApiKeyStore,
  slotlockBearerCredential,
} from './api-keys.js';
import {
  createSlotlockDashboard,
  createSlotlockDashboardResources,
  createSlotlockAcceptanceRecords,
  createSlotlockDashboardState,
} from './dashboard.js';
import {
  SECRET_HINT,
  SlotlockConfigError,
  type SlotlockEnv,
  type SlotlockLimits,
  type SlotlockRate,
  type SlotlockServeDashboardConfig,
  formatSlotlockRate,
  optional,
  readAvailability,
  readDashboardConfig,
  readDashboardOrganizations,
  readLimits,
  readSecret,
  readServerUrl,
  readTrustedProxyHeader,
  slotlockKeySubscriptions,
} from './config.js';
import { type SlotlockBookingRules, parseBookingRules } from './booking-rules.js';
import { SLOTLOCK_APPLICATION_SCOPE } from './application-api.js';
import { SLOTLOCK_DASHBOARD_FUNCTIONS, SLOTLOCK_TENANT_TABLES } from './ddl.js';
import {
  type SlotlockMaintenanceResult,
  type SlotlockMaintenanceScheduler,
  maintainSlotlockTenant,
  startSlotlockMaintenance,
  withSlotlockMaintenanceLock,
} from './maintenance.js';
import {
  type SlotlockNodeServerAddress,
  type SlotlockNodeServerCloseResult,
  type SlotlockNodeServerFetchTarget,
  createSlotlockNodeServer,
} from './node-server.js';
import { type SlotlockMetrics, createSlotlockMetrics } from './metrics.js';
import { slotlockPackageVersion } from './package-version.js';
import { createSlotlockRequestLimits } from './rate-limit.js';
import {
  type SlotlockSql,
  type SlotlockStore,
  type SlotlockTenantLimits,
  assertSlotlockSchemaCurrent,
  createSlotlockStore,
} from './store.js';
import type { SlotlockResource, WeeklyAvailabilityRule } from './types.js';
import { parseAvailabilityRules } from './weekly-hours.js';

export { SlotlockConfigError, type SlotlockEnv, type SlotlockServeDashboardConfig };

/** Every variable the commands read. The README, `.env.example` and `server.json` document these. */
export const SLOTLOCK_ENVIRONMENT_VARIABLES = Object.freeze([
  'DATABASE_URL',
  'SLOTLOCK_MIGRATE_DATABASE_URL',
  'SLOTLOCK_AUTH_TOKEN',
  'SLOTLOCK_CONFIRMATION_SECRET',
  'SLOTLOCK_CONFIRM_WRITES',
  'SLOTLOCK_METRICS_TOKEN',
  'SLOTLOCK_PUBLIC_URL',
  'SLOTLOCK_TENANT',
  'SLOTLOCK_AVAILABILITY',
  'SLOTLOCK_REST_API',
  'SLOTLOCK_RETENTION_DAYS',
  'SLOTLOCK_WEBHOOKS',
  'SLOTLOCK_SHARED_LIMITS',
  'SLOTLOCK_LIMITS',
  'SLOTLOCK_TRUSTED_PROXY_HEADER',
  'SLOTLOCK_GITHUB_CLIENT_ID',
  'SLOTLOCK_GITHUB_CLIENT_SECRET',
  'SLOTLOCK_SESSION_SECRET',
  'SLOTLOCK_ASSISTANT_SECRET',
  'SLOTLOCK_ASSISTANT_PRIVATE_URLS',
  'SLOTLOCK_DASHBOARD_USERS',
  'SLOTLOCK_DASHBOARD_ORGS',
  'SLOTLOCK_DASHBOARD_NAME',
  'HOST',
  'PORT',
] as const);

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;
const DEFAULT_TENANT = 'default';
/** The principal the server token resolves to: it acts in SLOTLOCK_TENANT with read and write. */
const SELF_HOST_SUBJECT = 'self-host';
/** Who `key create` records as a key's creator. */
const CLI_KEY_CREATOR = 'cli';
const DAY_MS = 86_400_000;
/**
 * The most resources `serve` lets one tenant create through the application API. A dashboard open to
 * every GitHub user gives each a tenant, so the cap keeps one from filling the database.
 */
const SERVE_MAX_TENANT_RESOURCES = 10_000;
/** How often `serve` maintains each tenant it serves (README, Operations: at least daily). */
const SERVE_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
/** Passes `slotlock maintain` runs at most, each as big as `serve`'s, until nothing is left. */
const MAINTAIN_MAX_PASSES = 100;
const WRITE_OPERATIONS: readonly SlotlockAgentWriteOperation[] = [
  'slotlock_create_event',
  'slotlock_book_together',
  'slotlock_book_pool',
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
  'slotlock_find_available_slots',
  'slotlock_hold_slots',
  'slotlock_release_slots',
  'slotlock_book_together',
  'slotlock_book_pool',
  'slotlock_get_pool_availability',
  'slotlock_create_event',
  'slotlock_get_event',
  'slotlock_list_events',
  'slotlock_update_event',
  'slotlock_delete_event',
]);
const HEALTH_QUERY_TIMEOUT_MS = 2_000;
/** How long one database check answers /healthz, so a flood of health checks is not one of queries. */
const HEALTH_RESULT_MS = 1_000;
const HEALTHCHECK_TIMEOUT_MS = 5_000;
/** One pool for every tenant; SLOTLOCK_LIMITS `tenant_transactions` (config.ts) goes up to it. */
const POOL_SIZE = 10;
/** How long a request's transaction waits for any one lock before it answers 503 `server_busy`. */
const SERVE_LOCK_TIMEOUT_MS = 5_000;
const RESOURCE_PAGE_SIZE = 1_000;

export interface SlotlockDatabaseConfig {
  /** The role `serve` and `resource` connect as. */
  databaseUrl: string;
  /**
   * The role `migrate` connects as, which owns the schema. When it differs from `databaseUrl`'s
   * role, `migrate` grants that role exactly the runtime access it needs (`grantApplicationRole`).
   */
  migrateDatabaseUrl?: string;
  tenantRef: string;
  /**
   * How long history is kept, in days (SLOTLOCK_RETENTION_DAYS); 30 without it. Every command that
   * prunes or reads the feed takes it, so `maintain` from cron prunes as `serve` reads.
   */
  retentionDays?: number;
}

export interface SlotlockServeConfig extends SlotlockDatabaseConfig {
  host: string;
  port: number;
  /** Where clients reach the server; Slotlock publishes its endpoints under this URL. */
  publicUrl: string;
  /**
   * A bearer token for SLOTLOCK_TENANT with read and write, never admin. Optional: API keys
   * (`slotlock key create`) authenticate whether or not it is set, each as its own tenant and scopes.
   */
  authToken?: string;
  /** The bearer token `/metrics` answers (SLOTLOCK_METRICS_TOKEN); no metrics without it. */
  metricsToken?: string;
  /**
   * Writes that wait for a person's confirmation (MCP 2026-07-28) and are refused elsewhere. None
   * unless SLOTLOCK_CONFIRM_WRITES opts in: every authenticated write takes effect at once.
   */
  confirmWrites: readonly SlotlockAgentWriteOperation[];
  /** Set exactly when `confirmWrites` is not empty. */
  confirmationSecret?: string;
  /** Bookable hours, applied to every resource in its own timezone. Empty: never bookable. */
  availability: readonly WeeklyAvailabilityRule[];
  /** Set exactly when SLOTLOCK_GITHUB_CLIENT_ID is. */
  dashboard?: SlotlockServeDashboardConfig;
  /**
   * GitHub organization ids (SLOTLOCK_DASHBOARD_ORGS) whose `github-org:<id>` tenants this server's
   * keys may act for, whether it serves the dashboard or another server (a Worker) does.
   */
  organizations?: string[];
  /**
   * Serve the REST API under /v1, with the application API for admin keys, and its OpenAPI document
   * (SLOTLOCK_REST_API: on unless off).
   */
  restApi: boolean;
  /** Webhook delivery (SLOTLOCK_WEBHOOKS: on unless off; private also reaches private networks). */
  webhooks: 'on' | 'off' | 'private';
  /** Tenant request budgets shared with every server through PostgreSQL (SLOTLOCK_SHARED_LIMITS=on). */
  sharedLimits: boolean;
  /** Request limits (SLOTLOCK_LIMITS over SLOTLOCK_DEFAULT_LIMITS): the server's only rate limit. */
  limits: SlotlockLimits;
  /** The lower-case request field a trusted proxy sets to the client address; else the socket's. */
  trustedProxyHeader?: string;
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
  const value = optional(env, 'SLOTLOCK_CONFIRM_WRITES') ?? 'none';
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

export function readSlotlockDatabaseConfig(env: SlotlockEnv): SlotlockDatabaseConfig {
  const databaseUrl = readDatabaseUrl(env, 'DATABASE_URL');
  if (databaseUrl === undefined) {
    throw new SlotlockConfigError(
      'DATABASE_URL is required: the postgres:// URL of the role Slotlock serves as',
    );
  }
  const config: SlotlockDatabaseConfig = { databaseUrl, tenantRef: readTenant(env) };
  const retentionDays = readRetentionDays(env);
  if (retentionDays !== undefined) config.retentionDays = retentionDays;
  const migrateDatabaseUrl = readDatabaseUrl(env, 'SLOTLOCK_MIGRATE_DATABASE_URL');
  if (migrateDatabaseUrl !== undefined) config.migrateDatabaseUrl = migrateDatabaseUrl;
  return config;
}

function readWebhooks(env: SlotlockEnv): 'on' | 'off' | 'private' {
  const value = optional(env, 'SLOTLOCK_WEBHOOKS') ?? 'on';
  if (value !== 'on' && value !== 'off' && value !== 'private') {
    throw new SlotlockConfigError('SLOTLOCK_WEBHOOKS must be on, off or private');
  }
  return value;
}

/** SLOTLOCK_RETENTION_DAYS: how long history is kept, in days (createSlotlockStore's `retentionDays`). */
function readRetentionDays(env: SlotlockEnv): number | undefined {
  const value = optional(env, 'SLOTLOCK_RETENTION_DAYS');
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > 3_650) {
    throw new SlotlockConfigError('SLOTLOCK_RETENTION_DAYS must be a whole number of days from 1 to 3650');
  }
  return Number(value);
}

function readSharedLimits(env: SlotlockEnv): boolean {
  const value = optional(env, 'SLOTLOCK_SHARED_LIMITS') ?? 'off';
  if (value !== 'on' && value !== 'off') {
    throw new SlotlockConfigError('SLOTLOCK_SHARED_LIMITS must be on or off');
  }
  return value === 'on';
}

function readRestApi(env: SlotlockEnv): boolean {
  const value = optional(env, 'SLOTLOCK_REST_API') ?? 'on';
  if (value !== 'on' && value !== 'off') {
    throw new SlotlockConfigError('SLOTLOCK_REST_API must be on or off');
  }
  return value === 'on';
}

export function readSlotlockServeConfig(env: SlotlockEnv): SlotlockServeConfig {
  const database = readSlotlockDatabaseConfig(env);
  const authToken = readSecret(env, 'SLOTLOCK_AUTH_TOKEN');
  const confirmWrites = readConfirmWrites(env);
  const confirmationSecret = readSecret(env, 'SLOTLOCK_CONFIRMATION_SECRET');
  if (confirmWrites.length > 0 && confirmationSecret === undefined) {
    throw new SlotlockConfigError(
      `SLOTLOCK_CONFIRMATION_SECRET is required while SLOTLOCK_CONFIRM_WRITES guards writes: it signs each pending confirmation; ${SECRET_HINT}, or set SLOTLOCK_CONFIRM_WRITES=none (the default) to let agents write without asking a person`,
    );
  }
  if (
    confirmationSecret !== undefined &&
    authToken !== undefined &&
    confirmationSecret === authToken
  ) {
    throw new SlotlockConfigError(
      'SLOTLOCK_CONFIRMATION_SECRET must differ from SLOTLOCK_AUTH_TOKEN',
    );
  }
  const port = readPort(env);
  const config: SlotlockServeConfig = {
    ...database,
    host: readHost(env),
    port,
    publicUrl: readServerUrl(env, 'SLOTLOCK_PUBLIC_URL', `http://localhost:${port}`),
    confirmWrites,
    availability: readAvailability(env),
    restApi: readRestApi(env),
    webhooks: readWebhooks(env),
    sharedLimits: readSharedLimits(env),
    limits: readLimits(env),
  };
  const trustedProxyHeader = readTrustedProxyHeader(env);
  if (trustedProxyHeader !== undefined) config.trustedProxyHeader = trustedProxyHeader;
  if (authToken !== undefined) config.authToken = authToken;
  const metricsToken = readSecret(env, 'SLOTLOCK_METRICS_TOKEN');
  if (metricsToken !== undefined) {
    const others = [
      authToken,
      confirmationSecret,
      env.SLOTLOCK_SESSION_SECRET?.trim(),
      env.SLOTLOCK_GITHUB_CLIENT_SECRET?.trim(),
      env.SLOTLOCK_ASSISTANT_SECRET?.trim(),
    ];
    if (others.includes(metricsToken)) {
      throw new SlotlockConfigError('SLOTLOCK_METRICS_TOKEN must differ from every other secret');
    }
    config.metricsToken = metricsToken;
  }
  const dashboard = readDashboardConfig(env);
  if (dashboard !== undefined) config.dashboard = dashboard;
  const organizations = readDashboardOrganizations(env);
  if (organizations !== undefined) config.organizations = organizations;
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
  const publicUrl = readServerUrl(env, 'SLOTLOCK_PUBLIC_URL', `http://localhost:${port}`);
  const basePath = new URL(publicUrl).pathname.replace(/\/$/, '');
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
    const presented = slotlockBearerCredential(request);
    if (presented === undefined) return null;
    return timingSafeEqual(sha256(presented), expected) ? { ...principal } : null;
  };
}

/**
 * What `serve` lets a principal call: a served operation its scopes cover. The server token's
 * principal carries read and write, never admin; a principal without scopes is refused everything
 * here, though the agent server alone would leave it to this function.
 */
export function authorizeSlotlockServeOperation(args: {
  principal: SlotlockAgentPrincipal;
  operation: SlotlockAgentOperation;
}): boolean {
  return (
    SERVED_OPERATIONS.has(args.operation) &&
    args.principal.scopes?.includes(slotlockAgentOperationScope(args.operation)) === true
  );
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
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** Every configured secret, and each database password alone, so no log line can carry one. */
function secretsIn(env: SlotlockEnv): string[] {
  const secrets: string[] = [];
  for (const name of [
    'SLOTLOCK_AUTH_TOKEN',
    'SLOTLOCK_CONFIRMATION_SECRET',
    'SLOTLOCK_GITHUB_CLIENT_SECRET',
    'SLOTLOCK_SESSION_SECRET',
    'SLOTLOCK_ASSISTANT_SECRET',
    'SLOTLOCK_METRICS_TOKEN',
  ]) {
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

/**
 * One JSON object per line: info on stdout, warnings and errors on stderr, secrets replaced by
 * `[redacted]`.
 */
function createLogger(io: SlotlockCliIo): SlotlockLogger {
  const secrets = secretsIn(io.env);
  const write = (stream: OutputStream, level: string, event: string, fields = {}) => {
    let line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
    for (const secret of secrets) line = line.split(secret).join('[redacted]');
    stream.write(`${line}\n`);
  };
  return {
    info: (event, fields) => write(io.stdout, 'info', event, fields),
    warn: (event, fields) => write(io.stderr, 'warn', event, fields),
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

/** An agent server event's fields under the log's snake_case keys (`durationMs` → `duration_ms`). */
function snakeCaseKeys(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      value,
    ]),
  );
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
export async function migrateSlotlock(
  config: SlotlockDatabaseConfig,
  log: SlotlockLogger,
): Promise<void> {
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

/**
 * `GET <path>` answers the metrics to `Authorization: Bearer <token>`, before the request limits:
 * a scrape is in memory and names no tenant. Anything else goes on to `target`.
 */
function serveMetrics(
  target: SlotlockNodeServerFetchTarget,
  metrics: SlotlockMetrics,
  path: string,
  token: string,
): SlotlockNodeServerFetchTarget {
  const expected = createHash('sha256').update(token).digest();
  return {
    fetch(request, connection) {
      if (new URL(request.url).pathname !== path) return target.fetch(request, connection);
      // The scheme is case-insensitive (RFC 9110); the token is compared as digests, in constant time.
      const presented = /^bearer +(\S+) *$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
      const given = createHash('sha256').update(presented).digest();
      if (!timingSafeEqual(given, expected)) {
        metrics.refusedScrape();
        return Promise.resolve(
          new Response('Unauthorized\n', {
            status: 401,
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'WWW-Authenticate': 'Bearer' },
          }),
        );
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return Promise.resolve(new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } }));
      }
      return Promise.resolve(
        new Response(request.method === 'HEAD' ? null : metrics.render(), {
          headers: {
            'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }),
      );
    },
    ...(target.shutdown ? { shutdown: () => target.shutdown?.() } : {}),
  };
}

/**
 * Whether the dashboard's allowlists let a tenant act: a `github-org:<id>` tenant only while
 * SLOTLOCK_DASHBOARD_ORGS lists that organization, wherever the dashboard runs; otherwise every
 * tenant when there is no dashboard or it allows everyone, and a `github:<id>` tenant only while
 * that id is listed.
 */
function dashboardAllows(config: SlotlockServeConfig, tenantRef: string): boolean {
  const orgId = /^github-org:(\d+)$/.exec(tenantRef)?.[1];
  if (orgId !== undefined) return config.organizations?.includes(orgId) === true;
  const users = config.dashboard?.allowedUsers;
  if (users === undefined || users === '*') return true;
  const githubId = /^github:(\d+)$/.exec(tenantRef)?.[1];
  return githubId === undefined || users.includes(githubId);
}

function serveTenantLimits(caps: SlotlockLimits['caps']): SlotlockTenantLimits {
  return {
    resources: SERVE_MAX_TENANT_RESOURCES,
    holds: caps.tenant_holds,
    reservations: caps.tenant_reservations,
    events: caps.tenant_events,
    coverage: caps.tenant_coverage,
  };
}

/**
 * The store `serve` answers requests from. Every surface writes through it, so its tenant limits
 * bound what any key can add, and its transaction limits what one tenant holds of the shared pool.
 */
export function createSlotlockServeStore(
  sql: SlotlockSql,
  caps: SlotlockLimits['caps'],
  availability: readonly WeeklyAvailabilityRule[] = [],
  retentionDays?: number,
): SlotlockStore {
  return createSlotlockStore(sql, {
    ...(retentionDays !== undefined ? { retentionDays } : {}),
    defaultAvailabilityRules: availability,
    tenantLimits: serveTenantLimits(caps),
    maxTenantTransactions: caps.tenant_transactions,
    maxHoldsPerHolder: caps.holder_holds,
    maxHeldHoursPerHolder: caps.holder_held_hours,
    tenantLockTimeoutMs: SERVE_LOCK_TIMEOUT_MS,
  });
}

/**
 * The store maintenance writes through, `serve`'s and `maintain`'s: the same tenant and per-holder
 * limits as requests, so a waitlist offer is a hold like any other.
 */
export function createSlotlockMaintenanceStore(
  sql: SlotlockSql,
  caps: SlotlockLimits['caps'],
  options: { retentionDays?: number } = {},
): SlotlockStore {
  return createSlotlockStore(sql, {
    ...options,
    tenantLimits: serveTenantLimits(caps),
    maxHoldsPerHolder: caps.holder_holds,
    maxHeldHoursPerHolder: caps.holder_held_hours,
  });
}

/** Serve MCP and A2A over HTTP from the Postgres store, as one token-authenticated tenant. */
export async function startSlotlockServer(
  config: SlotlockServeConfig,
  log: SlotlockLogger,
): Promise<SlotlockRunningServer> {
  const sql = connect(config.databaseUrl, POOL_SIZE);
  try {
    // Forced row-level security is what confines each key to its own tenant, and a superuser or a
    // BYPASSRLS role skips it on every query: refuse to serve as one rather than serve unconfined.
    const [serving] = await sql<{ role: string; superuser: boolean; bypassrls: boolean }[]>`
      SELECT rolname AS role, rolsuper AS superuser, rolbypassrls AS bypassrls
        FROM pg_catalog.pg_roles
       WHERE rolname = current_user`;
    if (serving?.superuser || serving?.bypassrls) {
      throw Object.assign(
        new Error(
          `DATABASE_URL connects as ${serving.role}, ${serving.superuser ? 'a superuser' : 'a BYPASSRLS role'}, which row-level security does not confine: every API key could read and book every tenant's calendars. Serve as a role with NOSUPERUSER NOBYPASSRLS (CREATE ROLE slotlock_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS), and run migrate with SLOTLOCK_MIGRATE_DATABASE_URL set to the schema owner's URL so it grants that role what it needs`,
        ),
        { code: 'unsafe_serving_role' },
      );
    }
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
    // Migrated by another release: an older schema needs this release's migrate first, and a newer
    // one has tables and rules this release's code does not know.
    await assertSlotlockSchemaCurrent(sql);
    // A deployment run statement by statement lifts forced row-level security for its data steps
    // and, stopped part way, leaves it lifted until the next one puts it back. The owning role then
    // reads every tenant's rows: refuse to serve until then.
    const lifted = await sql<{ name: string }[]>`
      SELECT rel.relname AS name
        FROM pg_catalog.pg_class rel
        JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
       WHERE ns.nspname = 'slotlock'
         AND rel.relname IN ${sql(SLOTLOCK_TENANT_TABLES)}
         AND rel.relrowsecurity AND NOT rel.relforcerowsecurity
       ORDER BY rel.relname`;
    if (lifted.length > 0) {
      throw Object.assign(
        new Error(
          `Row-level security is enabled but not forced on ${lifted.map(({ name }) => `slotlock.${name}`).join(', ')}: a deployment stopped part way. Run \`slotlock migrate\` (or \`slotlock serve --migrate\`) to put it back`,
        ),
        { code: 'row_security_lifted' },
      );
    }
    if (config.dashboard) {
      for (const signature of SLOTLOCK_DASHBOARD_FUNCTIONS) {
        const [granted] = await sql<{ ready: boolean }[]>`
          SELECT CASE WHEN to_regprocedure(${signature}) IS NULL THEN false
                      ELSE has_function_privilege(to_regprocedure(${signature}), 'EXECUTE') END AS ready`;
        if (!granted?.ready) {
          throw Object.assign(
            new Error(
              `The dashboard needs ${signature}, which this database role cannot run: run \`slotlock migrate\` (or \`slotlock serve --migrate\`) with this release`,
            ),
            { code: 'schema_outdated' },
          );
        }
      }
    }
    if (config.confirmationSecret !== undefined) {
      // Accepted confirmations are recorded once each (0.3.1); an older schema cannot hold them.
      const [recordable] = await sql<{ ready: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint
           WHERE conname = 'slotlock_dashboard_tokens_kind_valid'
             AND conrelid = to_regclass('slotlock.dashboard_tokens')
             AND pg_catalog.pg_get_constraintdef(oid) LIKE '%confirmation%'
        ) AND has_function_privilege(to_regprocedure(${SLOTLOCK_DASHBOARD_FUNCTIONS[0] as string}), 'EXECUTE') AS ready`;
      if (!recordable?.ready) {
        throw Object.assign(
          new Error(
            'SLOTLOCK_CONFIRM_WRITES records each accepted confirmation, which this schema cannot: run `slotlock migrate` (or `slotlock serve --migrate`) with this release',
          ),
          { code: 'schema_outdated' },
        );
      }
    }
    const { caps } = config.limits;
    const store = createSlotlockServeStore(sql, caps, config.availability, config.retentionDays);
    const retention = config.retentionDays !== undefined ? { retentionDays: config.retentionDays } : {};
    const publicUrl = new URL(config.publicUrl);
    const authenticateKey = createSlotlockApiKeyAuthenticator(createSlotlockApiKeyStore(sql), {
      maxConcurrentLookups: caps.key_lookups,
      maxWaitingLookups: caps.key_lookup_queue,
    });
    const authenticateToken =
      config.authToken === undefined
        ? undefined
        : // Read and write, never admin: this is the token the docs put in agents' configuration,
          // and the application API's writes ask no person. An admin key is made for the purpose.
          createSlotlockTokenAuthenticator(config.authToken, {
            subject: SELF_HOST_SUBJECT,
            tenantRef: config.tenantRef,
            scopes: SLOTLOCK_API_KEY_DEFAULT_SCOPES,
          });
    // Set once the listener is up; the authenticator tells it which tenants this server serves.
    let maintenance: SlotlockMaintenanceScheduler | undefined;
    let webhooks: SlotlockWebhookScheduler | undefined;
    const basePath = publicUrl.pathname.replace(/\/$/, '');
    const metrics =
      config.metricsToken === undefined
        ? undefined
        : createSlotlockMetrics({
            version: slotlockPackageVersion(),
            ...(process.versions.tz ? { tzdata: process.versions.tz } : {}),
          });
    const limits = createSlotlockRequestLimits({
      limits: config.limits,
      ...(config.sharedLimits
        ? {
            shared: {
              // Keyed by a digest: the table keeps no tenant name.
              take: async (bucket: string, rate: SlotlockRate) => {
                const digest = createHash('sha256').update(bucket).digest('hex');
                const [row] = await sql<{ taken: boolean }[]>`
                  SELECT slotlock.take_rate_token(${digest}, ${rate.perSecond}, ${rate.burst}) AS taken`;
                return row?.taken === true;
              },
            },
          }
        : {}),
      ...(config.trustedProxyHeader !== undefined
        ? { trustedProxyHeader: config.trustedProxyHeader }
        : {}),
      basePath,
      signInPaths: config.dashboard ? ['/dashboard/sign-in', '/dashboard/callback'] : [],
      // The token is compared in constant time first; only then is a key looked up. A person the
      // dashboard no longer allows loses their keys with their session.
      authenticate: async (request) => {
        const principal = (await authenticateToken?.(request)) ?? (await authenticateKey(request));
        if (!principal || !dashboardAllows(config, principal.tenantRef)) return null;
        maintenance?.touch(principal.tenantRef);
        return principal;
      },
      // Counts and pseudonyms only: never an address, a credential or a tenant.
      onRefusals: (counts) => {
        metrics?.refusals(counts);
        log.info('refusals', { ...counts });
      },
      // Behind a proxy without the setting, every client shares the proxy's address budget.
      onIgnoredClientField: (field) =>
        log.warn('client_address_field_ignored', { field, setting: 'SLOTLOCK_TRUSTED_PROXY_HEADER' }),
    });
    let health: { at: number; ready: Promise<boolean> } | undefined;
    const agentBackend = createSlotlockStoreAgentBackend(store, {
      availabilityRules: async () => config.availability.map((rule) => ({ ...rule })),
    });
    const agentServer = createSlotlockAgentServer({
      publicBaseUrl: config.publicUrl,
      // readPublicUrl admits plain HTTP only on a loopback host, which is all this permits anyway.
      allowInsecureLocalhost: publicUrl.protocol === 'http:',
      backend: agentBackend,
      authenticate: limits.authenticate,
      consumeRateLimit: limits.consumeRateLimit,
      // A write that may expand a recurring series also waits for one of a few slots, so one
      // tenant's expansions cannot hold the event loop from every other tenant's requests.
      authorize: async ({ principal, operation, input }) => {
        if (!authorizeSlotlockServeOperation({ principal, operation })) return false;
        await limits.admit({ principal, operation, input });
        return true;
      },
      subscriptions: {
        maxTotal: caps.subscriptions,
        maxPerTenant: caps.tenant_subscriptions,
        maxPerPrincipal: slotlockKeySubscriptions(caps),
      },
      health: async () => {
        if (!health || performance.now() - health.at > HEALTH_RESULT_MS) {
          health = { at: performance.now(), ready: databaseReachable(sql) };
        }
        return (await health.ready)
          ? { ready: true, checks: ['database'] }
          : { ready: false, checks: ['database_unreachable'] };
      },
      // Outcomes and counts only: the server never reports arguments or identities.
      onEvent: (event) => {
        metrics?.event(event);
        const { type, ...fields } = event;
        log.info(type, snakeCaseKeys(fields));
      },
      // What an agent sees only as internal_error: the operation and the error's message and code,
      // never the arguments or the request, with every configured secret redacted.
      onError: (error, { operation }) =>
        log.error('agent_error', { operation, ...describeError(error) }),
      ...(config.restApi
        ? {
            rest: true,
            // Resources, hours, holds, reservations, coverage and maintenance: admin keys only.
            application: {
              backend: createSlotlockStoreApplicationBackend(store, {
                maxTenantResources: SERVE_MAX_TENANT_RESOURCES,
              }),
              authorize: async ({ principal, operation, input }) => {
                if (principal.scopes?.includes(SLOTLOCK_APPLICATION_SCOPE) !== true) return false;
                await limits.admit({ principal, operation, input });
                return true;
              },
            },
          }
        : {}),
      ...(config.confirmationSecret !== undefined
        ? {
            confirmation: {
              operations: config.confirmWrites,
              secrets: [config.confirmationSecret],
              consumeAcceptance: createSlotlockAcceptanceRecords(sql),
            },
          }
        : {}),
    });
    const dashboard =
      config.dashboard === undefined
        ? undefined
        : createSlotlockDashboard({
            publicUrl: config.publicUrl,
            github: {
              clientId: config.dashboard.githubClientId,
              clientSecret: config.dashboard.githubClientSecret,
            },
            sessionSecret: config.dashboard.sessionSecret,
            allowedUsers: config.dashboard.allowedUsers,
            ...(config.dashboard.name ? { name: config.dashboard.name } : {}),
            ...(config.dashboard.organizations
              ? { organizations: config.dashboard.organizations }
              : {}),
            keys: createSlotlockApiKeyStore(sql),
            resources: createSlotlockDashboardResources(store),
            state: createSlotlockDashboardState(sql),
            availability: config.availability,
            ...(config.dashboard.assistantSecret !== undefined
              ? {
                  // The assistant's reads and approved writes are agent calls: the same backend,
                  // operations, rate limits and series-write slots as an API key's.
                  assistant: {
                    secret: config.dashboard.assistantSecret,
                    ...(config.dashboard.assistantPrivateUrls ? { privateUrls: true } : {}),
                    backend: agentBackend,
                    consumeRateLimit: limits.consumeRateLimit,
                    authorize: async ({ principal, operation, input }) => {
                      if (!authorizeSlotlockServeOperation({ principal, operation })) return false;
                      await limits.admit({ principal, operation, input });
                      return true;
                    },
                  },
                }
              : {}),
            clientAddress: (request) => limits.clientAddress(request),
            onError: (error) => log.error('dashboard_error', describeError(error)),
          });
    const target = limits.serve(
      dashboard
        ? {
            fetch: (request: Request) =>
              dashboard.handles(request) ? dashboard.fetch(request) : agentServer.fetch(request),
            shutdown: () => agentServer.shutdown(),
          }
        : agentServer,
    );
    const served =
      metrics && config.metricsToken !== undefined
        ? serveMetrics(target, metrics, `${basePath}/metrics`, config.metricsToken)
        : target;
    const listener = createSlotlockNodeServer(served, {
      requestOrigin: publicUrl.origin,
      onError: (error, phase) => log.error('http_error', { phase, ...describeError(error) }),
    });
    const address = await listener.listen({ host: config.host, port: config.port });
    maintenance = startSlotlockMaintenance({
      // One tenant at a time, and its long passes may wait on a request's locks for longer.
      store: createSlotlockMaintenanceStore(sql, caps, retention),
      sql,
      tenants: [config.tenantRef],
      intervalMs: SERVE_MAINTENANCE_INTERVAL_MS,
      // Counts only, never the tenant.
      onPass: (result) => {
        metrics?.maintenance(result);
        log.info('maintenance', { ...result });
      },
      onError: (error) => log.error('maintenance_failed', describeError(error)),
    });
    if (config.webhooks !== 'off') {
      const deliveryStore = createSlotlockStore(sql, retention);
      const send = createSlotlockWebhookSender({ allowPrivateNetworks: config.webhooks === 'private' });
      webhooks = startSlotlockWebhookDelivery({
        // The tenants with a webhook, from the database: a restarted server finds them all.
        tenants: async () => {
          const tenants: string[] = [];
          for (;;) {
            const page = await sql<{ tenant: string }[]>`
              SELECT slotlock.webhook_tenants(${tenants.at(-1) ?? null}::text) AS tenant`;
            tenants.push(...page.map(({ tenant }) => tenant));
            if (page.length < 1_000) return tenants;
          }
        },
        deliver: (tenantRef) =>
          deliverSlotlockWebhooks({
            tenantRef,
            send,
            feed: {
              claimWebhookDeliveries: (params) =>
                deliveryStore.withTenant(tenantRef, (tenant) => tenant.claimWebhookDeliveries(params)),
              settleWebhookDelivery: (params) =>
                deliveryStore.withTenant(tenantRef, (tenant) => tenant.settleWebhookDelivery(params)),
            },
          }),
        // Counts only, never the tenant or a URL.
        onPass: (_tenant, result) => {
          metrics?.webhooks(result);
          log.info('webhooks', { ...result });
        },
        onError: (error) => log.error('webhooks_failed', describeError(error)),
      });
    }
    log.info('listening', {
      address: address.origin,
      mcp: `${config.publicUrl}/mcp`,
      a2a: `${config.publicUrl}/a2a`,
      tenant: config.tenantRef,
      auth: config.authToken === undefined ? ['api_keys'] : ['token', 'api_keys'],
      dashboard: dashboard ? `${config.publicUrl}/dashboard` : null,
      confirm_writes: config.confirmWrites,
      availability_rules: config.availability.length,
      rest: config.restApi ? `${config.publicUrl}/openapi.json` : null,
      webhooks: config.webhooks,
      shared_limits: config.sharedLimits,
      tzdata: process.versions.tz ?? null,
      maintenance_interval_minutes: SERVE_MAINTENANCE_INTERVAL_MS / 60_000,
      limits: {
        ...Object.fromEntries(
          Object.entries(config.limits.rates).map(([name, rate]) => [name, formatSlotlockRate(rate)]),
        ),
        ...caps,
        // What a key may hold, which is below key_subscriptions when the tenant's cap is lower.
        key_subscriptions: slotlockKeySubscriptions(caps),
      },
      client_address: config.trustedProxyHeader ?? 'socket',
    });
    return {
      address,
      async close() {
        const result = await listener.close();
        limits.close();
        await maintenance?.close();
        await webhooks?.close();
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

/** One resource's hours as the `hours` commands print them: `null` means the server's. */
function hoursLine(resource: SlotlockResource): string {
  return `${JSON.stringify({
    id: resource.id,
    external_ref: resource.externalRef,
    timezone: resource.timezone,
    hours: resource.availabilityRules ?? null,
  })}\n`;
}

/** Every resource of the tenant in use (with `includeArchived`, every one), a page at a time. */
async function tenantResources(
  store: ReturnType<typeof createSlotlockStore>,
  tenantRef: string,
  includeArchived = false,
): Promise<SlotlockResource[]> {
  const all: SlotlockResource[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await store.withTenant(tenantRef, (tenant) =>
      tenant.listResources({
        tenantRef,
        limit: RESOURCE_PAGE_SIZE,
        ...(after !== undefined ? { after } : {}),
        ...(includeArchived ? { includeArchived } : {}),
      }),
    );
    all.push(...page);
    after = page.at(-1)?.id;
    if (page.length < RESOURCE_PAGE_SIZE || after === undefined) return all;
  }
}

/**
 * `hours show|set|clear`: print, set or clear (`rules` null) the hours of the tenant's resource
 * named by reference or id, or of every resource. Returns false when no resource has that name.
 */
async function runHours(
  config: SlotlockDatabaseConfig,
  out: OutputStream,
  target: { resource: string } | 'all' | 'show',
  rules?: WeeklyAvailabilityRule[] | null,
): Promise<boolean> {
  const sql = connect(config.databaseUrl, 1);
  try {
    const store = createSlotlockStore(sql);
    const tenantRef = config.tenantRef;
    if (target === 'all') {
      const updated = await store.withTenant(tenantRef, (tenant) =>
        tenant.setTenantAvailability({ tenantRef, rules: rules ?? null }),
      );
      out.write(`${JSON.stringify({ updated })}\n`);
      return true;
    }
    const resources = await tenantResources(store, tenantRef);
    if (target === 'show') {
      for (const resource of resources) out.write(hoursLine(resource));
      return true;
    }
    // An id first: another resource's reference may spell it.
    const named =
      resources.find((resource) => resource.id === target.resource) ??
      resources.find((resource) => resource.externalRef === target.resource);
    if (!named) return false;
    if (rules === undefined) {
      out.write(hoursLine(named));
      return true;
    }
    const updated = await store.withTenant(tenantRef, (tenant) =>
      tenant.setResourceAvailability({ tenantRef, id: named.id, rules }),
    );
    if (!updated) return false;
    out.write(hoursLine(updated));
    return true;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * `rules set|clear`: set or clear (`null`) the booking rules of the tenant's resource named by id,
 * else by reference, and print it. Returns false when no resource has that name.
 */
async function runRules(
  config: SlotlockDatabaseConfig,
  out: OutputStream,
  name: string,
  rules: SlotlockBookingRules | null,
): Promise<boolean> {
  const sql = connect(config.databaseUrl, 1);
  try {
    const store = createSlotlockStore(sql);
    const tenantRef = config.tenantRef;
    const resources = await tenantResources(store, tenantRef);
    const named =
      resources.find((resource) => resource.id === name) ??
      resources.find((resource) => resource.externalRef === name);
    if (!named) return false;
    const updated = await store.withTenant(tenantRef, (tenant) =>
      tenant.setResourceBookingRules({ tenantRef, id: named.id, rules }),
    );
    if (!updated) return false;
    out.write(
      `${JSON.stringify({
        id: updated.id,
        external_ref: updated.externalRef,
        booking_rules: updated.bookingRules ?? null,
      })}\n`,
    );
    return true;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** A resource as `resource archive` and `resource restore` print it. */
function resourceStateLine(resource: SlotlockResource): string {
  return `${JSON.stringify({
    id: resource.id,
    external_ref: resource.externalRef,
    timezone: resource.timezone,
    visibility: resource.visibility ?? 'shared',
    archived_at: resource.archivedAt?.toISOString() ?? null,
  })}\n`;
}

/**
 * `resource archive|restore|delete`: the tenant's resource named by id, else by reference, archived
 * ones included. Returns false when no resource has that name, and `in_use` when a delete is
 * refused because something on the resource has not ended.
 */
async function changeResource(
  config: SlotlockDatabaseConfig,
  out: OutputStream,
  name: string,
  action: 'archive' | 'restore' | 'delete',
): Promise<boolean | 'in_use'> {
  const sql = connect(config.databaseUrl, 1);
  try {
    const store = createSlotlockStore(sql);
    const tenantRef = config.tenantRef;
    const resources = await tenantResources(store, tenantRef, true);
    // An id first: another resource's reference may spell it.
    const named =
      resources.find((resource) => resource.id === name) ??
      resources.find((resource) => resource.externalRef === name);
    if (!named) return false;
    const id = named.id;
    if (action === 'delete') {
      const result = await store.withTenant(tenantRef, (tenant) => tenant.deleteResource({ tenantRef, id }));
      if (!result.ok) return 'in_use';
      if (!result.deleted) return false;
      out.write(`${JSON.stringify({ id, external_ref: named.externalRef, deleted: true })}\n`);
      return true;
    }
    const changed = await store.withTenant(tenantRef, (tenant) =>
      action === 'archive'
        ? tenant.archiveResource({ tenantRef, id })
        : tenant.restoreResource({ tenantRef, id }),
    );
    if (!changed) return false;
    out.write(resourceStateLine(changed));
    return true;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * `tenant status|suspend|unsuspend|erase` for SLOTLOCK_TENANT. Suspending and lifting a suspension
 * are the deployment role's alone, so they connect as SLOTLOCK_MIGRATE_DATABASE_URL when it is set;
 * the serving role reads a suspension and may erase.
 */
async function runTenantCommand(
  config: SlotlockDatabaseConfig,
  out: OutputStream,
  action: 'status' | 'suspend' | 'unsuspend' | 'erase',
  reason?: string,
): Promise<void> {
  const owner = action === 'suspend' || action === 'unsuspend';
  const sql = connect(owner ? (config.migrateDatabaseUrl ?? config.databaseUrl) : config.databaseUrl, 1);
  try {
    const store = createSlotlockStore(sql);
    const tenantRef = config.tenantRef;
    let line: Record<string, unknown>;
    if (action === 'status') {
      line = { tenant: tenantRef, suspended: await store.isTenantSuspended({ tenantRef }) };
    } else if (action === 'suspend') {
      const { suspended } = await store.suspendTenant({
        tenantRef,
        ...(reason !== undefined ? { reason } : {}),
      });
      line = { tenant: tenantRef, suspended: true, changed: suspended };
    } else if (action === 'unsuspend') {
      const { unsuspended } = await store.unsuspendTenant({ tenantRef });
      line = { tenant: tenantRef, suspended: false, changed: unsuspended };
    } else {
      const erased = await store.eraseTenant({ tenantRef });
      line = { tenant: tenantRef, total: erased.total, rows: erased.rows };
    }
    out.write(`${JSON.stringify(line)}\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** One key as `key create`, `key list` and `key revoke` print it: never the digest. */
function apiKeyLine(apiKey: SlotlockApiKey, key?: string): string {
  return `${JSON.stringify({
    id: apiKey.id,
    name: apiKey.name,
    prefix: apiKey.prefix,
    scopes: apiKey.scopes,
    created_by: apiKey.createdBy,
    created_at: apiKey.createdAt.toISOString(),
    expires_at: apiKey.expiresAt?.toISOString() ?? null,
    last_used_at: apiKey.lastUsedAt?.toISOString() ?? null,
    revoked_at: apiKey.revokedAt?.toISOString() ?? null,
    ...(key !== undefined ? { key } : {}),
  })}\n`;
}

/** `--scope`: read, write and admin, comma-separated; read,write unless given. */
function parseKeyScopes(value: string | undefined): SlotlockApiKeyScope[] {
  if (value === undefined) return [...SLOTLOCK_API_KEY_DEFAULT_SCOPES];
  const names = value.split(',').map((name) => name.trim());
  const scopes = SLOTLOCK_API_KEY_SCOPES.filter((scope) => names.includes(scope));
  if (names.length === 0 || names.some((name) => !scopes.includes(name as SlotlockApiKeyScope))) {
    throw new Error('--scope must be a comma-separated list of read, write and admin');
  }
  return scopes;
}

/**
 * `maintain`: maintenance passes for the tenant until nothing is left, under the tenant's lock, so
 * it never repeats what a server is doing. Null when another server holds the lock.
 */
async function maintainTenant(
  config: SlotlockDatabaseConfig,
  caps: SlotlockLimits['caps'],
): Promise<(Omit<SlotlockMaintenanceResult, 'rollPending'> & { passes: number }) | null> {
  const sql = connect(config.databaseUrl, 2);
  try {
    const store = createSlotlockMaintenanceStore(
      sql,
      caps,
      config.retentionDays !== undefined ? { retentionDays: config.retentionDays } : {},
    );
    const total = await withSlotlockMaintenanceLock(sql, config.tenantRef, async () => {
      const sum = {
        extended: 0,
        conflicts: 0,
        refused: 0,
        pruned: 0,
        zoneShifts: 0,
        staleSources: 0,
        noShows: 0,
        waitlistOffers: 0,
        capped: true,
        passes: 0,
      };
      while (sum.capped && sum.passes < MAINTAIN_MAX_PASSES) {
        const pass = await maintainSlotlockTenant(store, config.tenantRef);
        sum.passes += 1;
        sum.extended += pass.extended;
        sum.conflicts += pass.conflicts;
        sum.refused += pass.refused;
        sum.pruned += pass.pruned;
        sum.zoneShifts += pass.zoneShifts;
        sum.staleSources += pass.staleSources;
        sum.noShows += pass.noShows;
        sum.waitlistOffers += pass.waitlistOffers;
        // A capped pass that got nowhere met only series it cannot extend. While its roll stopped
        // before the series it had put back, the next pass meets new ones (and perhaps a healthy
        // one); once it reached them, another pass would meet them again.
        sum.capped = pass.capped;
        if (pass.capped && pass.extended + pass.pruned === 0 && !pass.rollPending) break;
      }
      return sum;
    });
    return total ?? null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** `--expires-in-days`: a whole number of days up to the longest a key may live. */
function parseKeyLifetime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const days = /^\d{1,4}$/.test(value) ? Number(value) : Number.NaN;
  if (!(days >= 1 && days <= SLOTLOCK_API_KEY_MAX_LIFETIME_DAYS)) {
    throw new Error(
      `--expires-in-days must be a whole number from 1 to ${SLOTLOCK_API_KEY_MAX_LIFETIME_DAYS}`,
    );
  }
  return days;
}

async function withApiKeys<T>(
  config: SlotlockDatabaseConfig,
  operation: (keys: ReturnType<typeof createSlotlockApiKeyStore>) => Promise<T>,
): Promise<T> {
  const sql = connect(config.databaseUrl, 1);
  try {
    return await operation(createSlotlockApiKeyStore(sql));
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

export const SLOTLOCK_CLI_HELP = `Usage: slotlock <command> [options]

Commands:
  migrate                  Apply the schema and row-level security, then grant the serving
                           role when SLOTLOCK_MIGRATE_DATABASE_URL names another role
  serve [--migrate]        Serve MCP, A2A and REST over HTTP (--migrate runs migrate first);
                           maintains each tenant it serves every hour
  maintain                 Run maintenance for the tenant now: extend recurring events to the
                           rolling horizon and prune past the retention window (for cron)
  resource add <ref> [--timezone <IANA zone>]
                           Create a calendar resource (a car, room, person or machine)
  resource list            Print the tenant's resources, one JSON object per line
  resource archive <ref>   Take a resource out of use: no new bookings, holds or events, and
                           no longer listed; what is on it stays
  resource restore <ref>   Put an archived resource back in use
  resource delete <ref>    Delete a resource and its history; refused while a booking, hold
                           or event on it has not ended
  hours show [--resource <ref>]
                           Print each resource's bookable hours (null: the server's)
  hours set <json> (--resource <ref> | --all)
                           Give one resource, or every one, weekly hours of its own; [] closes
  hours clear (--resource <ref> | --all)
                           Hand one resource, or every one, back to the server's hours
  rules set <json> --resource <ref>
                           Set what a booking on the resource must satisfy, like
                           {"minNoticeMinutes":120,"slotStepMinutes":30,"turnaroundMinutes":30,"enforceHours":true}
  rules clear --resource <ref>
                           Remove the resource's booking rules
  key create <name> [--scope read,write,admin] [--expires-in-days <n>]
                           Create an API key for the tenant (default scope read,write, no
                           expiry; admin adds the application API) and print it once; only its
                           SHA-256 is stored
  key list                 Print the tenant's API keys, one JSON object per line
  key rotate <id>          Give an active key a new secret and print it once; the old one stops
                           working at once, and the key keeps its id and what it booked
  key revoke <id>          Revoke one of the tenant's API keys at once
  tenant status            Print whether the tenant is suspended
  tenant suspend [--reason <text>]
                           Suspend the tenant: it may read, and writes nothing; its keys get
                           no new secret (as SLOTLOCK_MIGRATE_DATABASE_URL's role when set:
                           only the schema owner suspends)
  tenant unsuspend         Lift the tenant's suspension (as the schema owner, likewise)
  tenant erase --confirm <tenant>
                           Delete everything the tenant has, its API keys included, for good;
                           --confirm repeats SLOTLOCK_TENANT
  healthcheck              Exit 0 when the local server reports ready

Options:
  -h, --help               Show this help
  -v, --version            Print the version

Environment:
  DATABASE_URL                   postgres:// URL of the role Slotlock serves as (required); serve
                                 refuses a superuser or a role with BYPASSRLS
  SLOTLOCK_MIGRATE_DATABASE_URL  postgres:// URL of the schema owner, for migrate (optional)
  SLOTLOCK_AUTH_TOKEN            Optional bearer token for SLOTLOCK_TENANT with read and write
                                 access (never admin), 32+ random characters (serve); API keys
                                 work with or without it
  SLOTLOCK_CONFIRMATION_SECRET   Signs pending write confirmations, 32+ random characters (serve;
                                 required when SLOTLOCK_CONFIRM_WRITES is not none)
  SLOTLOCK_METRICS_TOKEN         Serves Prometheus metrics at /metrics to this bearer token, 32+
                                 random characters (serve; off without it)
  SLOTLOCK_CONFIRM_WRITES        none (default), all, or a comma-separated list of write tools
                                 that wait for a person (MCP 2026-07-28 form elicitation; refused
                                 with confirmation_required on REST, A2A and older MCP)
  SLOTLOCK_PUBLIC_URL            URL clients use (default http://localhost:$PORT)
  SLOTLOCK_TENANT                Tenant of the token, resource and key commands (default "default")
  SLOTLOCK_AVAILABILITY          JSON array of weekly bookable-hours rules (default: none)
  SLOTLOCK_REST_API              on (default): also serve the tools as a REST API under /v1, and
                                 the application API for admin keys, described at /openapi.json;
                                 off: MCP and A2A only
  SLOTLOCK_RETENTION_DAYS        Days of history kept: the change feed, ended waitlist entries,
                                 and retired answers (never under 30) (1-3650, default 30;
                                 serve and maintain)
  SLOTLOCK_SHARED_LIMITS         on: tenant request budgets are shared by every server through the
                                 database, so N servers allow a tenant its rate once; off (default):
                                 each server keeps its own
  SLOTLOCK_WEBHOOKS              on (default): deliver each tenant's changes to its webhooks,
                                 never to a private network address; private: those too, for
                                 testing; off: keep the change feed, send nothing
  SLOTLOCK_LIMITS                Request limits, comma-separated name=value over the defaults:
                                 rates as <count>/<s|m|h>[:<burst>] or off for address (50/s:100,
                                 every request per client, before any key lookup), key_read,
                                 tenant_read (20/s:40), key_write, tenant_write (5/s:20),
                                 global_read (500/s:1000), global_write (50/s:100), app_read
                                 (20/s:40) and app_write (5/s:20) per tenant for the
                                 application API, sign_in (20/m:20); counts for
                                 tenant_series_writes and series_writes
                                 (1: writes that may expand a recurring series at once),
                                 maintenance_runs (1: application API maintenance runs at once),
                                 subscriptions (256), tenant_subscriptions (16),
                                 key_subscriptions (4, and fewer than tenant_subscriptions),
                                 key_lookups (2), key_lookup_queue (256),
                                 tenant_transactions (2: one tenant's database transactions at
                                 once, of the pool's 10); what one tenant may store:
                                 tenant_holds (10000), tenant_reservations, tenant_events and
                                 tenant_coverage (100000), holder_holds (20) and
                                 holder_held_hours (2160), which maintain keeps too
  SLOTLOCK_TRUSTED_PROXY_HEADER  The request field a proxy in front sets to the client address,
                                 such as CF-Connecting-IP (default: the connection's address);
                                 set it only when every request comes through that proxy
  SLOTLOCK_GITHUB_CLIENT_ID      Serve the dashboard at $SLOTLOCK_PUBLIC_URL/dashboard: the Client ID
                                 of a GitHub OAuth app with callback .../dashboard/callback
  SLOTLOCK_GITHUB_CLIENT_SECRET  That app's client secret (dashboard)
  SLOTLOCK_SESSION_SECRET        Signs dashboard sessions, 32+ random characters (dashboard)
  SLOTLOCK_ASSISTANT_SECRET      Turns on the dashboard assistant and seals each organization's
                                 model API key with it, 32+ random characters (dashboard; off
                                 without it)
  SLOTLOCK_ASSISTANT_PRIVATE_URLS off (default): refuse an assistant model URL whose host is, or
                                 resolves to, a loopback, private, link-local, CGNAT, unique-local
                                 or metadata address; on: allow them, for a self-hosted model
                                 (Ollama, vLLM) on this machine or network
  SLOTLOCK_DASHBOARD_USERS       * or comma-separated GitHub user ids that may sign in (dashboard)
  SLOTLOCK_DASHBOARD_ORGS        comma-separated GitHub organization ids: each is one shared tenant
  SLOTLOCK_DASHBOARD_NAME        What the dashboard calls this deployment (default Slotlock)
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
    io.stdout.write(`${slotlockPackageVersion()}\n`);
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
  const subcommand =
    command === 'resource' ||
    command === 'key' ||
    command === 'hours' ||
    command === 'rules' ||
    command === 'tenant'
      ? `${command} ${operands[0] ?? ''}`.trim()
      : command;
  const expectedOperands: Record<string, number> = {
    migrate: 0,
    serve: 0,
    maintain: 0,
    healthcheck: 0,
    'resource add': 2,
    'resource list': 1,
    'resource archive': 2,
    'resource restore': 2,
    'resource delete': 2,
    'tenant status': 1,
    'tenant suspend': 1,
    'tenant unsuspend': 1,
    'tenant erase': 1,
    'key create': 2,
    'key list': 1,
    'key rotate': 2,
    'key revoke': 2,
    'hours show': 1,
    'hours set': 2,
    'hours clear': 1,
    'rules set': 2,
    'rules clear': 1,
  };
  const expected = expectedOperands[subcommand];
  if (expected === undefined) return usage(`unknown command "${subcommand}"`);
  if (operands.length !== expected) return usage(`wrong number of arguments for "${subcommand}"`);
  if (values.migrate && subcommand !== 'serve') return usage('--migrate applies only to serve');
  if (values.timezone !== undefined && subcommand !== 'resource add') {
    return usage('--timezone applies only to resource add');
  }
  for (const option of ['scope', 'expires-in-days'] as const) {
    if (values[option] !== undefined && subcommand !== 'key create') {
      return usage(`--${option} applies only to key create`);
    }
  }
  if (values.reason !== undefined && subcommand !== 'tenant suspend') {
    return usage('--reason applies only to tenant suspend');
  }
  if (values.confirm !== undefined && subcommand !== 'tenant erase') {
    return usage('--confirm applies only to tenant erase');
  }
  if (subcommand === 'tenant erase' && values.confirm === undefined) {
    return usage('tenant erase needs --confirm <tenant>, the tenant it erases (SLOTLOCK_TENANT)');
  }
  if (values.all && subcommand !== 'hours set' && subcommand !== 'hours clear') {
    return usage('--all applies only to hours set and hours clear');
  }
  if (
    values.resource !== undefined &&
    !subcommand.startsWith('hours ') &&
    !subcommand.startsWith('rules ')
  ) {
    return usage('--resource applies only to hours and rules commands');
  }
  if (subcommand.startsWith('rules ') && values.resource === undefined) {
    return usage(`${subcommand} needs --resource <ref>`);
  }
  let bookingRules: SlotlockBookingRules | null = null;
  if (subcommand === 'rules set') {
    try {
      bookingRules = parseBookingRules(JSON.parse(operands[1] as string));
    } catch (error) {
      return usage(
        error instanceof SyntaxError
          ? 'rules must be a JSON object like {"minNoticeMinutes":120,"slotStepMinutes":30}'
          : (error as Error).message,
      );
    }
  }
  if (
    (subcommand === 'hours set' || subcommand === 'hours clear') &&
    (values.resource === undefined) === (values.all !== true)
  ) {
    return usage(`${subcommand} needs --resource <ref> or --all, one of them`);
  }
  let hours: WeeklyAvailabilityRule[] | null = null;
  if (subcommand === 'hours set') {
    let candidate: unknown;
    try {
      candidate = JSON.parse(operands[1] as string);
    } catch {
      return usage(
        'hours must be a JSON array of weekly rules like [{"rrule":"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR","startMinutes":540,"durationMinutes":480}]',
      );
    }
    try {
      hours = parseAvailabilityRules(candidate);
    } catch (error) {
      return usage((error as Error).message);
    }
  }
  let keyScopes: SlotlockApiKeyScope[] = [];
  let keyLifetimeDays: number | undefined;
  if (subcommand === 'key create') {
    try {
      keyScopes = parseKeyScopes(values.scope);
      keyLifetimeDays = parseKeyLifetime(values['expires-in-days']);
    } catch (error) {
      return usage((error as Error).message);
    }
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
      case 'maintain': {
        const result = await maintainTenant(readSlotlockDatabaseConfig(io.env), readLimits(io.env).caps);
        if (!result) {
          io.stderr.write('slotlock: another server is maintaining this tenant now; nothing to do\n');
          return 0;
        }
        io.stdout.write(`${JSON.stringify(result)}\n`);
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
      case 'resource archive':
      case 'resource restore':
      case 'resource delete': {
        const changed = await changeResource(
          readSlotlockDatabaseConfig(io.env),
          io.stdout,
          operands[1] as string,
          subcommand.slice('resource '.length) as 'archive' | 'restore' | 'delete',
        );
        if (changed === 'in_use') {
          io.stderr.write(
            'slotlock: a booking, hold or calendar event on that resource has not ended; cancel or move it first, or archive the resource\n',
          );
          return 1;
        }
        if (!changed) {
          io.stderr.write('slotlock: no resource with that reference or id in this tenant\n');
          return 1;
        }
        return 0;
      }
      case 'tenant status':
      case 'tenant suspend':
      case 'tenant unsuspend':
      case 'tenant erase': {
        const config = readSlotlockDatabaseConfig(io.env);
        // The tenant named twice, so erasing the one SLOTLOCK_TENANT happens to name is deliberate.
        if (subcommand === 'tenant erase' && values.confirm !== config.tenantRef) {
          return usage('--confirm must repeat SLOTLOCK_TENANT, the tenant tenant erase deletes');
        }
        try {
          await runTenantCommand(
            config,
            io.stdout,
            subcommand.slice('tenant '.length) as 'status' | 'suspend' | 'unsuspend' | 'erase',
            values.reason,
          );
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === 'tenant_suspension_not_permitted') {
            io.stderr.write(
              'slotlock: only the schema owner suspends a tenant or lifts a suspension; set SLOTLOCK_MIGRATE_DATABASE_URL to its URL\n',
            );
            return 1;
          }
          if (code === 'invalid_suspension_reason') {
            return usage('--reason must be 1-500 characters without control characters');
          }
          throw error;
        }
        return 0;
      }
      case 'hours show':
      case 'hours set':
      case 'hours clear': {
        const target =
          values.all === true
            ? 'all'
            : values.resource !== undefined
              ? { resource: values.resource }
              : 'show';
        const found = await runHours(
          readSlotlockDatabaseConfig(io.env),
          io.stdout,
          target,
          subcommand === 'hours show' ? undefined : hours,
        );
        if (!found) {
          io.stderr.write('slotlock: no resource with that reference or id in this tenant\n');
          return 1;
        }
        return 0;
      }
      case 'rules set':
      case 'rules clear': {
        const found = await runRules(
          readSlotlockDatabaseConfig(io.env),
          io.stdout,
          values.resource as string,
          bookingRules,
        );
        if (!found) {
          io.stderr.write('slotlock: no resource with that reference or id in this tenant\n');
          return 1;
        }
        return 0;
      }
      case 'key create': {
        const config = readSlotlockDatabaseConfig(io.env);
        const created = await withApiKeys(config, (keys) =>
          keys.create({
            tenantRef: config.tenantRef,
            name: operands[1] as string,
            scopes: keyScopes,
            createdBy: CLI_KEY_CREATOR,
            ...(keyLifetimeDays !== undefined
              ? { expiresAt: new Date(Date.now() + keyLifetimeDays * DAY_MS) }
              : {}),
          }),
        );
        io.stdout.write(apiKeyLine(created.apiKey, created.key));
        io.stderr.write(
          'slotlock: the key is shown once and only its SHA-256 is stored; keep it in a secret manager\n',
        );
        return 0;
      }
      case 'key list': {
        const config = readSlotlockDatabaseConfig(io.env);
        const listed = await withApiKeys(config, (keys) =>
          keys.list({ tenantRef: config.tenantRef }),
        );
        for (const apiKey of listed) io.stdout.write(apiKeyLine(apiKey));
        return 0;
      }
      case 'key rotate': {
        const config = readSlotlockDatabaseConfig(io.env);
        const rotated = await withApiKeys(config, (keys) =>
          keys.rotate({ tenantRef: config.tenantRef, id: operands[1] as string }),
        );
        if (!rotated) {
          io.stderr.write('slotlock: no active API key with that id in this tenant\n');
          return 1;
        }
        io.stdout.write(apiKeyLine(rotated.apiKey, rotated.key));
        io.stderr.write(
          'slotlock: the new key is shown once and the old one no longer works; keep it in a secret manager\n',
        );
        return 0;
      }
      case 'key revoke': {
        const config = readSlotlockDatabaseConfig(io.env);
        const revoked = await withApiKeys(config, (keys) =>
          keys.revoke({ tenantRef: config.tenantRef, id: operands[1] as string }),
        );
        if (!revoked) {
          io.stderr.write('slotlock: no API key with that id in this tenant\n');
          return 1;
        }
        io.stdout.write(apiKeyLine(revoked));
        return 0;
      }
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
      scope: { type: 'string' },
      'expires-in-days': { type: 'string' },
      resource: { type: 'string' },
      all: { type: 'boolean' },
      reason: { type: 'string' },
      confirm: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}
