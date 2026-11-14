// Self-hosting: the commands behind the `slotlock` executable (cli.ts holds only the process wiring).
// Configuration comes from environment variables alone, so a container, process manager or CI job
// supplies it the same way and nothing is read from a file or a request. A missing or weak secret
// stops a command before it connects anywhere, and no secret is written to a log line or an error.
// The one exception is the API key `key create` prints: that output is the key's only copy.
import {
  type SlotlockWebhookScheduler,
  createSlotlockGuardedFetch,
  createSlotlockWebhookSender,
  deliverSlotlockWebhooks,
  startSlotlockWebhookDelivery,
} from './webhooks.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { userInfo } from 'node:os';
import { SLOTLOCK_STAFF_ENROLLMENT_DAYS, SLOTLOCK_STAFF_ROLES } from './staff-ddl.js';
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
  createSlotlockStoreChangeSource,
} from './agent-store-backend.js';
import {
  SLOTLOCK_API_KEY_DEFAULT_SCOPES,
  SLOTLOCK_API_KEY_MAX_LIFETIME_DAYS,
  SLOTLOCK_API_KEY_SCOPES,
  type SlotlockApiKey,
  type SlotlockApiKeyLimits,
  type SlotlockApiKeyScope,
  createSlotlockApiKeyAuthenticator,
  createSlotlockApiKeyStore,
  SLOTLOCK_TEST_TENANT_SUFFIX,
  slotlockBearerCredential,
  slotlockLiveTenant,
} from './api-keys.js';
import {
  SLOTLOCK_SANDBOX_MAX_RACERS,
  SLOTLOCK_SANDBOX_SCENARIOS,
  type SlotlockSandboxScenario,
  fastForwardSlotlockSandbox,
  raceSlotlockSandbox,
  resetSlotlockSandbox,
  seedSlotlockSandbox,
} from './sandbox.js';
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
  readDashboardTeamWorkspaces,
  readDashboardUsers,
  readVerifiedDomains,
  readLimits,
  readSecret,
  readServerUrl,
  readTrustedProxyHeader,
  readTrustedProxySecret,
  slotlockKeySubscriptions,
} from './config.js';
import { type SlotlockBookingRules, parseBookingRules } from './booking-rules.js';
import {
  SLOTLOCK_APPLICATION_SCOPE,
  slotlockApplicationOperation,
  slotlockApplicationScope,
} from './application-api.js';
import {
  SLOTLOCK_ACCOUNT_FIELD,
  createSlotlockPartnerKey,
  createSlotlockPartnerKeyAuthenticator,
  createSlotlockPartnerStore,
  listSlotlockPartners,
  putSlotlockPartner,
  revokeSlotlockPartnerKey,
  setSlotlockPartnerBilling,
  setSlotlockPartnerStatus,
  slotlockPartnerContractJson,
} from './partners.js';
import { closeSlotlockPartnerMonth, slotlockClientLabel, slotlockPreviousMonth } from './partner-billing.js';
import { createSlotlockDashboardTeams, createSlotlockOrganizationCheck } from './teams.js';
import { createSlotlockDashboardWorkspaces, createSlotlockWorkspaceCheck } from './workspaces.js';
import { createSlotlockWorkspaceDomains, runSlotlockDomainChecks } from './workspace-domains.js';
import { slotlockDomainResolvers } from './domains.js';
import { createSlotlockSecretBox } from './oidc.js';
import { createSlotlockInvitationEmailSender } from './invitation-email.js';
import { SLOTLOCK_DEFAULT_OVERAGE_STOP_PERCENT, reportSlotlockOverage, slotlockMonthOf } from './overage.js';
import {
  type SlotlockOtlpConfig,
  createSlotlockOtlpExporter,
  createSlotlockOtlpMetricsExporter,
  readSlotlockOtlpConfig,
} from './otel.js';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { dirname, join as joinPath } from 'node:path';
import type { SlotlockAvailabilityException } from './hours.js';
import type { SlotlockOverrideResources } from './availability-store.js';
import { readSlotlockHolidayCalendar } from './holiday-import.js';
import {
  SLOTLOCK_DASHBOARD_FUNCTIONS,
  SLOTLOCK_QUOTA_FUNCTIONS,
  SLOTLOCK_TENANT_TABLES,
  SLOTLOCK_USAGE_FUNCTIONS,
} from './ddl.js';
import {
  type SlotlockMaintenanceResult,
  type SlotlockMaintenanceScheduler,
  createSlotlockMaintenanceRecord,
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
import {
  type SlotlockPlan,
  readSlotlockPlanDefault,
  readSlotlockTenantPlan,
  readSlotlockTenantQuotas,
  setSlotlockPlanDefault,
} from './plans.js';
import { type SlotlockResourceScope, isSlotlockResourceScope } from './resource-profile.js';
import { createSlotlockQuotas, noteSlotlockQuotaThreshold, readSlotlockQuotaUse } from './quotas.js';
import { createSlotlockRequestLimits } from './rate-limit.js';
import { createSlotlockUsageMeter, recordSlotlockUsage } from './usage.js';
import {
  type SlotlockSql,
  type SlotlockSubject,
  type SlotlockStore,
  type SlotlockTenantLimits,
  assertSlotlockSchemaCurrent,
  createSlotlockStore,
  slotlockAuditEventRecord,
} from './store.js';
import type { SlotlockResource, WeeklyAvailabilityRule } from './types.js';
import { parseAvailabilityRules } from './weekly-hours.js';

export { SlotlockConfigError, type SlotlockEnv, type SlotlockServeDashboardConfig };

/**
 * Every variable the commands read. `slotlock --help`, `.env.example`, `server.json` and the docs
 * (site/docs-src/self-host.md) document these. Not STRIPE_SECRET_KEY, which only the owner's
 * `partner close` reads, to bill partners.
 */
export const SLOTLOCK_ENVIRONMENT_VARIABLES = Object.freeze([
  'DATABASE_URL',
  'SLOTLOCK_MIGRATE_DATABASE_URL',
  'SLOTLOCK_ADMIN_DATABASE_URL',
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
  'SLOTLOCK_USAGE',
  'SLOTLOCK_QUOTAS',
  'SLOTLOCK_OVERAGE',
  'SLOTLOCK_LIMITS',
  'SLOTLOCK_TRUSTED_PROXY_HEADER',
  'SLOTLOCK_TRUSTED_PROXY_SECRET',
  'SLOTLOCK_KNOWN_CLIENTS',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_SERVICE_NAME',
  'SLOTLOCK_GITHUB_CLIENT_ID',
  'SLOTLOCK_GITHUB_CLIENT_SECRET',
  'SLOTLOCK_GOOGLE_CLIENT_ID',
  'SLOTLOCK_GOOGLE_CLIENT_SECRET',
  'SLOTLOCK_SESSION_SECRET',
  'SLOTLOCK_ASSISTANT_SECRET',
  'SLOTLOCK_ASSISTANT_PREVIOUS_SECRETS',
  'SLOTLOCK_ASSISTANT_PRIVATE_URLS',
  'SLOTLOCK_DASHBOARD_USERS',
  'SLOTLOCK_DASHBOARD_ORGS',
  'SLOTLOCK_DASHBOARD_TEAM_WORKSPACES',
  'SLOTLOCK_DASHBOARD_NAME',
  'SLOTLOCK_DASHBOARD_TERMS_URL',
  'SLOTLOCK_DASHBOARD_PRIVACY_URL',
  'SLOTLOCK_INVITATION_EMAIL',
  'SLOTLOCK_INVITATION_EMAIL_KEY',
  'SLOTLOCK_INVITATION_EMAIL_FROM',
  'SLOTLOCK_VERIFIED_DOMAINS',
  'SLOTLOCK_DNS_RESOLVER',
  'SLOTLOCK_TEAM_SSO',
  'SLOTLOCK_SSO_SECRET',
  'SLOTLOCK_TEAM_SCIM',
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
/** How often `serve` maintains each tenant with data (docs, Operations: at least daily). */
const SERVE_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
/** Passes `slotlock maintain` runs at most, each as big as `serve`'s, until nothing is left. */
const MAINTAIN_MAX_PASSES = 100;
/**
 * The writes SLOTLOCK_CONFIRM_WRITES may name, and all of them for `all`: every tool that books,
 * moves or cancels, the named booking tools included. The agent server also guards the tool that
 * performs the same write as a listed one.
 */
const WRITE_OPERATIONS: readonly SlotlockAgentWriteOperation[] = [
  'slotlock_create_event',
  'slotlock_book_together',
  'slotlock_book_pool',
  'slotlock_update_event',
  'slotlock_delete_event',
  'slotlock_confirm_slot',
  'slotlock_reschedule',
  'slotlock_cancel',
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
  'slotlock_find_available_ranges',
  'slotlock_hold_slots',
  'slotlock_hold_together',
  'slotlock_release_slots',
  'slotlock_book_together',
  'slotlock_book_pool',
  'slotlock_get_pool_availability',
  'slotlock_create_event',
  'slotlock_get_event',
  'slotlock_list_events',
  'slotlock_update_event',
  'slotlock_delete_event',
  'slotlock_confirm_slot',
  'slotlock_reschedule',
  'slotlock_cancel',
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
  /**
   * The admin console's role (RFC 0006), when this deployment runs one: `migrate` grants it the admin
   * functions and nothing else (`grantAdminRole`). Never the serving role or the schema owner.
   */
  adminDatabaseUrl?: string;
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
   * keys may act for, whether it serves the dashboard or another server (a Worker) does; or
   * `'enabled'`, those an owner turned on from the dashboard (teams.ts), checked in the database.
   */
  organizations?: string[] | 'enabled';
  /**
   * GitHub user ids (SLOTLOCK_DASHBOARD_USERS), or `'*'`, whose `github:<id>` tenants this server's
   * keys may act for, whether it serves the dashboard or another server (a Worker) does.
   */
  allowedUsers?: '*' | string[];
  /**
   * Team workspaces (SLOTLOCK_DASHBOARD_TEAM_WORKSPACES=on), whether this server serves the dashboard
   * or a Worker does: their `team:<id>` keys act only while the workspace exists (workspace_active).
   */
  teamWorkspaces?: boolean;
  /**
   * Verified domains (SLOTLOCK_VERIFIED_DOMAINS=on), whether this server serves the dashboard or a
   * Worker does: their daily check runs in this server's maintenance.
   */
  verifiedDomains?: { resolver: 'doh' | 'system' };
  /**
   * Serve the REST API under /v1, with the application API for admin keys, and its OpenAPI document
   * (SLOTLOCK_REST_API: on unless off).
   */
  restApi: boolean;
  /** Webhook delivery (SLOTLOCK_WEBHOOKS: on unless off; private also reaches private networks). */
  webhooks: 'on' | 'off' | 'private';
  /** Tenant request budgets shared with every server through PostgreSQL (SLOTLOCK_SHARED_LIMITS=on). */
  sharedLimits: boolean;
  /**
   * Usage metering (SLOTLOCK_USAGE=on; off by default): each tenant's operations, bookings and
   * holds counted by day, key and surface in slotlock.usage_daily (usage.ts).
   */
  usage: boolean;
  /**
   * Monthly quotas (SLOTLOCK_QUOTAS=on, which needs SLOTLOCK_USAGE=on; off by default): a tenant on
   * a plan is refused `quota_exceeded` past its plan's operations or bookings this month (quotas.ts).
   */
  quotas: boolean;
  /**
   * Metered overage (SLOTLOCK_OVERAGE: off, or the percent of its quota a paying Developer tenant
   * is refused at, 111-1000; needs SLOTLOCK_QUOTAS=on). Off by default: overage.ts.
   */
  overageStopPercent?: number;
  /** Request limits (SLOTLOCK_LIMITS over SLOTLOCK_DEFAULT_LIMITS): the server's only rate limit. */
  limits: SlotlockLimits;
  /** The lower-case request field a trusted proxy sets to the client address; else the socket's. */
  trustedProxyHeader?: string;
  /**
   * Integrators metrics count by name from the `Slotlock-Client` field (SLOTLOCK_KNOWN_CLIENTS,
   * RFC 0003 P5); any other is `other`. Empty: every named client is `other`.
   */
  knownClients?: readonly string[];
  /** OpenTelemetry trace export (OTEL_EXPORTER_OTLP_ENDPOINT and the other OTEL_* variables). */
  otlp?: SlotlockOtlpConfig;
  /** The value that must accompany trustedProxyHeader in x-slotlock-proxy-proof; else the socket's. */
  trustedProxySecret?: string;
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
  const adminDatabaseUrl = readDatabaseUrl(env, 'SLOTLOCK_ADMIN_DATABASE_URL');
  if (adminDatabaseUrl !== undefined) config.adminDatabaseUrl = adminDatabaseUrl;
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

/** SLOTLOCK_USAGE: on to meter each tenant's use (usage.ts); off, the default, records nothing. */
function readUsageMetering(env: SlotlockEnv): boolean {
  const value = optional(env, 'SLOTLOCK_USAGE') ?? 'off';
  if (value !== 'on' && value !== 'off') {
    throw new SlotlockConfigError('SLOTLOCK_USAGE must be on or off');
  }
  return value === 'on';
}

/** SLOTLOCK_QUOTAS: on to hold each tenant on a plan to its monthly quotas; it counts with usage. */
function readQuotas(env: SlotlockEnv, usage: boolean): boolean {
  const value = optional(env, 'SLOTLOCK_QUOTAS') ?? 'off';
  if (value !== 'on' && value !== 'off') {
    throw new SlotlockConfigError('SLOTLOCK_QUOTAS must be on or off');
  }
  if (value === 'on' && !usage) {
    throw new SlotlockConfigError(
      'SLOTLOCK_QUOTAS=on needs SLOTLOCK_USAGE=on: a quota is held against the usage it counts',
    );
  }
  return value === 'on';
}

/**
 * SLOTLOCK_KNOWN_CLIENTS: the integrators metrics name (comma-separated, lower-case names like
 * stackapi or n8n), at most 50, so a scrape stays bounded and names only those the deployment chose.
 */
function readKnownClients(env: SlotlockEnv): string[] {
  const value = optional(env, 'SLOTLOCK_KNOWN_CLIENTS');
  if (value === undefined) return [];
  const names = value.split(',').map((name) => name.trim());
  if (names.length > 50 || names.some((name) => !/^[a-z][a-z0-9_.-]{0,39}$/.test(name) || name === 'other' || name === 'none')) {
    throw new SlotlockConfigError(
      'SLOTLOCK_KNOWN_CLIENTS must be up to 50 comma-separated lower-case names (letters, digits, _ . -), not other or none',
    );
  }
  return [...new Set(names)];
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
    usage: readUsageMetering(env),
    quotas: false,
    limits: readLimits(env),
  };
  config.quotas = readQuotas(env, config.usage);
  const overage = optional(env, 'SLOTLOCK_OVERAGE') ?? 'off';
  if (overage !== 'off') {
    const percent = overage === 'on' ? SLOTLOCK_DEFAULT_OVERAGE_STOP_PERCENT : Number(overage);
    if (!Number.isSafeInteger(percent) || percent < 111 || percent > 1_000) {
      throw new SlotlockConfigError('SLOTLOCK_OVERAGE must be off, on, or the percent of its quota a paying Developer tenant is refused at (111-1000)');
    }
    if (!config.quotas) throw new SlotlockConfigError('SLOTLOCK_OVERAGE needs SLOTLOCK_QUOTAS=on: overage is what is used past a quota');
    config.overageStopPercent = percent;
  }
  const trustedProxyHeader = readTrustedProxyHeader(env);
  if (trustedProxyHeader !== undefined) config.trustedProxyHeader = trustedProxyHeader;
  const trustedProxySecret = readTrustedProxySecret(env, trustedProxyHeader);
  if (trustedProxySecret !== undefined) config.trustedProxySecret = trustedProxySecret;
  const knownClients = readKnownClients(env);
  if (knownClients.length > 0) config.knownClients = knownClients;
  let otlp: SlotlockOtlpConfig | undefined;
  try {
    otlp = readSlotlockOtlpConfig(env);
  } catch (error) {
    throw new SlotlockConfigError((error as Error).message);
  }
  if (otlp !== undefined) config.otlp = otlp;
  if (authToken !== undefined) config.authToken = authToken;
  const metricsToken = readSecret(env, 'SLOTLOCK_METRICS_TOKEN');
  if (metricsToken !== undefined) {
    const others = [
      authToken,
      confirmationSecret,
      env.SLOTLOCK_SESSION_SECRET?.trim(),
      env.SLOTLOCK_GITHUB_CLIENT_SECRET?.trim(),
      env.SLOTLOCK_ASSISTANT_SECRET?.trim(),
      ...(env.SLOTLOCK_ASSISTANT_PREVIOUS_SECRETS?.split(',').map((part) => part.trim()) ?? []),
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
  if (readDashboardTeamWorkspaces(env)) config.teamWorkspaces = true;
  const verifiedDomains = readVerifiedDomains(env);
  if (verifiedDomains !== undefined) config.verifiedDomains = verifiedDomains;
  const allowedUsers = dashboard?.allowedUsers ?? readDashboardUsers(env);
  if (allowedUsers !== undefined) config.allowedUsers = allowedUsers;
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
    'SLOTLOCK_TRUSTED_PROXY_SECRET',
  ]) {
    const value = env[name]?.trim();
    if (value) secrets.push(value);
  }
  // A list: each secret in it, as well as the whole.
  const previous = env.SLOTLOCK_ASSISTANT_PREVIOUS_SECRETS?.trim();
  if (previous) {
    secrets.push(previous);
    for (const part of previous.split(',')) if (part.trim()) secrets.push(part.trim());
  }
  for (const name of ['DATABASE_URL', 'SLOTLOCK_MIGRATE_DATABASE_URL', 'SLOTLOCK_ADMIN_DATABASE_URL']) {
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
    try {
      await store.applySchema();
      await store.applyTenantRls();
    } catch (error) {
      throw await migrateRefusal(owner, config, error);
    }
    log.info('schema_applied');
    if (config.migrateDatabaseUrl === undefined) return;
    const application = connect(config.databaseUrl, 1);
    let role: string;
    try {
      role = await currentRole(application);
    } finally {
      await application.end({ timeout: 5 });
    }
    const ownerRole = await currentRole(owner);
    if (role !== ownerRole) {
      await store.grantApplicationRole(role);
      log.info('application_role_granted', { role });
    }
    if (config.adminDatabaseUrl === undefined) return;
    const console = connect(config.adminDatabaseUrl, 1);
    let adminRole: string;
    try {
      adminRole = await currentRole(console);
    } finally {
      await console.end({ timeout: 5 });
    }
    // The console's role reaches every account through the admin functions; the serving role and
    // the owner must never hold them, nor it theirs.
    if (adminRole === role || adminRole === ownerRole) {
      throw Object.assign(
        new Error(
          `SLOTLOCK_ADMIN_DATABASE_URL connects as ${adminRole}, which is the ${adminRole === role ? 'serving role (DATABASE_URL)' : 'schema owner'}: give the admin console a role of its own (CREATE ROLE slotlock_admin_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS)`,
        ),
        { code: 'admin_role_not_separate' as const },
      );
    }
    // Nor a member of the other, either way round: a console role in the serving role would read
    // tenants' tables, a serving role in the console role could SET ROLE to it.
    const [entangled] = await owner<{ console_in: boolean; serving_in: boolean; owner_in: boolean }[]>`
      SELECT pg_catalog.pg_has_role(${adminRole}, ${role}, 'MEMBER') AS console_in,
             pg_catalog.pg_has_role(${role}, ${adminRole}, 'MEMBER') AS serving_in,
             pg_catalog.pg_has_role(${adminRole}, ${ownerRole}, 'MEMBER') AS owner_in`;
    if (entangled?.console_in || entangled?.serving_in || entangled?.owner_in) {
      throw Object.assign(
        new Error(
          `SLOTLOCK_ADMIN_DATABASE_URL connects as ${adminRole}, which ${entangled.serving_in ? `the serving role ${role} is a member of` : entangled.console_in ? `is a member of the serving role ${role}` : `is a member of the schema owner ${ownerRole}`}: revoke that membership, so neither role can use the other's rights`,
        ),
        { code: 'admin_role_not_separate' as const },
      );
    }
    await store.grantAdminRole(adminRole);
    log.info('admin_role_granted', { role: adminRole });
  } finally {
    await owner.end({ timeout: 5 });
  }
}

/**
 * Migrate run as the serving role, with no SLOTLOCK_MIGRATE_DATABASE_URL, is refused: as
 * `unsafe_slotlock_schema`, with one reason per object the role does not own, when a role that is
 * not a superuser owns the schema, and with a permission error (42501) when a superuser does. Lead
 * with the fix, and keep the code, the reasons and the database's message after it.
 */
async function migrateRefusal(
  sql: SlotlockSql,
  config: SlotlockDatabaseConfig,
  error: unknown,
): Promise<unknown> {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    config.migrateDatabaseUrl !== undefined ||
    !(error instanceof Error) ||
    (code !== 'unsafe_slotlock_schema' && code !== '42501')
  ) {
    return error;
  }
  let found: { role: string; owner: string } | undefined;
  try {
    [found] = await sql<{ role: string; owner: string }[]>`
      SELECT current_user AS role, pg_catalog.pg_get_userbyid(ns.nspowner) AS owner
        FROM pg_catalog.pg_namespace ns
       WHERE ns.nspname = 'slotlock'`;
  } catch {
    return error;
  }
  if (!found || found.role === found.owner) return error;
  return Object.assign(
    new Error(
      `set SLOTLOCK_MIGRATE_DATABASE_URL to the schema owner's URL: migrate connected as ${found.role} (DATABASE_URL), but ${found.owner} owns the slotlock schema, and only its owner can migrate it. DATABASE_URL stays the serving role's.\n${error.message}`,
      { cause: error },
    ),
    {
      code,
      ...('reasons' in error ? { reasons: error.reasons } : {}),
    },
  );
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
 * Whether the dashboard's allowlists let a tenant act, wherever the dashboard runs: a
 * `github-org:<id>` tenant only while SLOTLOCK_DASHBOARD_ORGS lists that organization; a `team:<id>`
 * tenant only with SLOTLOCK_DASHBOARD_TEAM_WORKSPACES=on (and, as serve's authenticate asks, while
 * it exists); a `github:<id>` tenant only while SLOTLOCK_DASHBOARD_USERS is `*` or lists that id;
 * every tenant when SLOTLOCK_DASHBOARD_USERS is not set, and every other tenant.
 */
export function slotlockServeAllowsTenant(
  config: Pick<SlotlockServeConfig, 'organizations' | 'allowedUsers' | 'teamWorkspaces'>,
  tenantRef: string,
): boolean {
  // A test environment (RFC 0003 G9) is let through exactly as its live tenant.
  const live = slotlockLiveTenant(tenantRef);
  if (live.startsWith('team:')) return config.teamWorkspaces === true;
  // A person a team's identity provider made has no workspace of their own, so no keys of one.
  if (live.startsWith('sso:')) return false;
  const orgId = /^github-org:(\d+)$/.exec(live)?.[1];
  // With `enabled`, the database decides, as serve's authenticate asks (createSlotlockOrganizationCheck).
  if (orgId !== undefined) return config.organizations === 'enabled' || config.organizations?.includes(orgId) === true;
  const users = config.allowedUsers;
  if (users === undefined || users === '*') return true;
  // A Google person (google:<subject>) only while the list names them so.
  if (live.startsWith('google:')) return users.includes(live);
  const githubId = /^github:(\d+)$/.exec(live)?.[1];
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

/** Every tenant a paged SECURITY DEFINER list (1,000 names a page, after the last) returns. */
async function pageTenants(
  page: (after: string | null) => Promise<readonly { tenant: string }[]>,
): Promise<string[]> {
  const tenants: string[] = [];
  for (;;) {
    const rows = await page(tenants.at(-1) ?? null);
    tenants.push(...rows.map(({ tenant }) => tenant));
    if (rows.length < 1_000) return tenants;
  }
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
    // Serving as the schema owner is allowed (one role can migrate and serve), but the owner can
    // lift forced row-level security, drop the exclusion constraints and read any table that does
    // not force it: say so once, at startup, rather than refuse.
    const [owning] = await sql<{ owns: boolean }[]>`
      SELECT pg_catalog.pg_has_role(current_user, ns.nspowner, 'MEMBER') AS owns
        FROM pg_catalog.pg_namespace ns
       WHERE ns.nspname = 'slotlock'`;
    if (owning?.owns) {
      log.warn('serving_as_schema_owner', {
        role: serving?.role,
        message:
          "DATABASE_URL connects as the role that owns the slotlock schema. Row-level security does not confine its owner on tables that do not force it, and the owner can lift it: serve as a role that owns nothing (CREATE ROLE slotlock_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS) and set SLOTLOCK_MIGRATE_DATABASE_URL to the schema owner's URL so migrate grants it what it needs",
      });
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
    if (config.usage) {
      for (const signature of [...SLOTLOCK_USAGE_FUNCTIONS, ...(config.quotas ? SLOTLOCK_QUOTA_FUNCTIONS : [])]) {
        const [granted] = await sql<{ ready: boolean }[]>`
          SELECT CASE WHEN to_regprocedure(${signature}) IS NULL THEN false
                      ELSE has_function_privilege(to_regprocedure(${signature}), 'EXECUTE') END AS ready`;
        if (!granted?.ready) {
          throw Object.assign(
            new Error(
              `${(SLOTLOCK_USAGE_FUNCTIONS as readonly string[]).includes(signature) ? 'SLOTLOCK_USAGE' : 'SLOTLOCK_QUOTAS'} needs ${signature}, which this database role cannot run: run \`slotlock migrate\` (or \`slotlock serve --migrate\`) with this release`,
            ),
            { code: 'schema_outdated' },
          );
        }
      }
    }
    // Each tenant's operations, recorded every 15 seconds and when the server stops (usage.ts).
    const usage = config.usage
      ? createSlotlockUsageMeter({
          record: (flushId, rows) => recordSlotlockUsage(sql, flushId, rows),
          onError: (error) =>
            log.error('usage_record_failed', {
              error: error instanceof Error ? error.message : 'unknown',
            }),
        })
      : undefined;
    // Each tenant on a plan held to its monthly quotas, counted with the meter (quotas.ts).
    const quotas =
      config.quotas && usage
        ? createSlotlockQuotas({
            plan: (tenantRef) =>
              readSlotlockTenantQuotas(
                sql,
                tenantRef,
                config.overageStopPercent !== undefined ? { overageStopPercent: config.overageStopPercent } : {},
              ),
            used: (tenantRef, fromDay) => readSlotlockQuotaUse(sql, tenantRef, fromDay),
            local: (tenantRef, metric, fromDay) => usage.local(tenantRef, metric, fromDay),
            notice: (notice) => noteSlotlockQuotaThreshold(sql, notice),
            onError: (error) =>
              log.error('quota_failed', { error: error instanceof Error ? error.message : 'unknown' }),
          })
        : undefined;
    const { caps } = config.limits;
    const store = createSlotlockServeStore(sql, caps, config.availability, config.retentionDays);
    const retention = config.retentionDays !== undefined ? { retentionDays: config.retentionDays } : {};
    const publicUrl = new URL(config.publicUrl);
    // Partner keys (`slk_partner_…`, RFC 0003 P1): the partner API, for the partner's accounts only.
    const authenticatePartner = createSlotlockPartnerKeyAuthenticator(sql);
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
    // Counted for the scrape (SLOTLOCK_METRICS_TOKEN), an OpenTelemetry collector, or both.
    const metrics =
      config.metricsToken === undefined && config.otlp?.metricsUrl === undefined
        ? undefined
        : createSlotlockMetrics({
            version: slotlockPackageVersion(),
            ...(process.versions.tz ? { tzdata: process.versions.tz } : {}),
          });
    const knownClients: ReadonlySet<string> = new Set(config.knownClients ?? []);
    // The same counters to an OpenTelemetry collector each minute, when one is configured.
    const metricsExport =
      metrics && config.otlp?.metricsUrl
        ? createSlotlockOtlpMetricsExporter({ ...config.otlp, metricsUrl: config.otlp.metricsUrl }, metrics, {
            onError: (reason) => log.warn('metrics_export_failed', { reason }),
          })
        : undefined;
    // A span per call to an OpenTelemetry collector, when one is configured.
    const tracer = config.otlp?.tracesUrl
      ? createSlotlockOtlpExporter(config.otlp, {
          onError: (reason) => log.warn('trace_export_failed', { reason }),
        })
      : undefined;
    // Teams on Cloud: an organization's keys work while an owner has it turned on.
    const organizationEnabled =
      config.organizations === 'enabled' ? createSlotlockOrganizationCheck(sql) : null;
    // Team workspaces: a team's keys work while it exists.
    const teamActive = config.teamWorkspaces ? createSlotlockWorkspaceCheck(sql) : null;
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
      ...(config.trustedProxySecret !== undefined
        ? { trustedProxySecret: config.trustedProxySecret }
        : {}),
      basePath,
      ...(quotas ? { quotas } : {}),
      signInPaths: config.dashboard ? ['/dashboard/sign-in', '/dashboard/callback'] : [],
      // The token is compared in constant time first; only then is a key looked up. A person the
      // dashboard no longer allows loses their keys with their session.
      authenticate: async (request) => {
        const principal =
          (await authenticateToken?.(request)) ??
          (await authenticatePartner(request)) ??
          (await authenticateKey(request));
        if (!principal || !slotlockServeAllowsTenant(config, principal.tenantRef)) return null;
        const orgId = organizationEnabled ? /^github-org:(\d+)$/.exec(slotlockLiveTenant(principal.tenantRef))?.[1] : undefined;
        if (orgId !== undefined && !(await organizationEnabled?.(orgId))) return null;
        if (slotlockLiveTenant(principal.tenantRef).startsWith('team:') && !(await teamActive?.(principal.tenantRef))) return null;
        // Slotlock-Account is a partner key's alone (RFC 0003 P3): with any other credential, or one
        // that could not act for that account, the request is refused rather than run elsewhere.
        if (request.headers.has(SLOTLOCK_ACCOUNT_FIELD) && principal.onBehalfOf === undefined) return null;
        // A partner key's own tenant holds nothing to maintain; its accounts' keys are as any key.
        if (principal.partnerId === undefined) maintenance?.touch(principal.tenantRef);
        metrics?.client(slotlockClientLabel(request.headers.get('slotlock-client'), knownClients));
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
      ...(usage ? { onUsage: usage.count } : {}),
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
        await limits.quota({ principal, operation });
        await limits.admit({ principal, operation, input });
        return true;
      },
      subscriptions: {
        // Live updates poll each tenant's change feed (one reader per tenant).
        changes: createSlotlockStoreChangeSource(store, sql),
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
      ...(tracer ? { onCallTrace: (event, trace) => tracer.record(event, trace.parentSpanId) } : {}),
      // Outcomes and counts only: the server never reports arguments or identities.
      onEvent: (event) => {
        metrics?.event(event);
        // A traced call's span is made from onCallTrace, as a child of the caller's.
        if (!('traceId' in event && event.traceId !== undefined)) tracer?.record(event);
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
                // A granted approval's booking is made as an agent's would be (RFC 0004 A4).
                agentBackend,
                // Holiday calendars by URL (RFC 0004 B1), never from a private address.
                holidayFetch: createSlotlockGuardedFetch(),
                partners: createSlotlockPartnerStore(sql, {
                  keys: createSlotlockApiKeyStore(sql),
                  eraseTenant: (tenantRef) => store.eraseTenant({ tenantRef }),
                }),
              }),
              authorize: async ({ principal, operation, input }) => {
                // admin, or a partner key's partner scope for the partner API: never either for the other.
                const needed = slotlockApplicationScope(slotlockApplicationOperation(operation));
                if (principal.scopes?.includes(needed) !== true) return false;
                await limits.quota({ principal, operation });
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
            ...(config.dashboard.google ? { google: config.dashboard.google } : {}),
            ...(config.dashboard.name ? { name: config.dashboard.name } : {}),
            ...(config.dashboard.termsUrl ? { termsUrl: config.dashboard.termsUrl } : {}),
            ...(config.dashboard.privacyUrl ? { privacyUrl: config.dashboard.privacyUrl } : {}),
            ...(config.dashboard.organizations
              ? { organizations: config.dashboard.organizations }
              : {}),
            ...(config.dashboard.organizations === 'enabled' ? { teams: createSlotlockDashboardTeams(sql) } : {}),
            ...(config.dashboard.teamWorkspaces ? { teamWorkspaces: true } : {}),
            ...(config.dashboard.verifiedDomains
              ? { domains: { resolvers: slotlockDomainResolvers(config.dashboard.verifiedDomains.resolver) } }
              : {}),
            // Teams' single sign-on: their Owners' URLs fetched never from a private address.
            ...(config.dashboard.teamSso
              ? { sso: { secretBox: createSlotlockSecretBox(config.dashboard.teamSso.secret), fetch: createSlotlockGuardedFetch() } }
              : {}),
            ...(config.dashboard.teamScim ? { scim: true } : {}),
            ...(config.dashboard.invitationEmail
              ? {
                  invitations: createSlotlockInvitationEmailSender(config.dashboard.invitationEmail, {
                    ...(config.dashboard.name ? { brandName: config.dashboard.name } : {}),
                  }),
                }
              : {}),
            keys: createSlotlockApiKeyStore(sql),
            // Holiday calendars by address (RFC 0004 B1), never from a private address.
            resources: createSlotlockDashboardResources(store, { agentBackend, holidayFetch: createSlotlockGuardedFetch() }),
            state: createSlotlockDashboardState(sql),
            // Roles from the database on every request, and "Sign out everywhere" (workspaces.ts).
            workspaces: createSlotlockDashboardWorkspaces(sql),
            availability: config.availability,
            ...(config.usage ? { usage: true } : {}),
            ...(config.quotas ? { quotas: true } : {}),
            ...(config.dashboard.assistantSecret !== undefined
              ? {
                  // The assistant's reads and approved writes are agent calls: the same backend,
                  // operations, rate limits and series-write slots as an API key's.
                  assistant: {
                    secret: config.dashboard.assistantSecret,
                    ...(usage
                      ? {
                          onUsage: usage.count,
                          onMessage: (tenantRef: string) =>
                            usage.add({ tenantRef, metric: 'assistant_messages', origin: 'dashboard-assistant' }),
                        }
                      : {}),
                    ...(config.dashboard.assistantPreviousSecrets
                      ? { previousSecrets: config.dashboard.assistantPreviousSecrets }
                      : {}),
                    ...(config.dashboard.assistantPrivateUrls ? { privateUrls: true } : {}),
                    backend: agentBackend,
                    consumeRateLimit: limits.consumeRateLimit,
                    // Checks only: a proposal holds nothing. The series-write slot and the write
                    // token are taken when an approved change runs (admit, consumeRateLimit).
                    authorize: async ({ principal, operation }) =>
                      authorizeSlotlockServeOperation({ principal, operation }),
                    // A read, or an approved write, over the tenant's monthly quota is refused.
                    admit: async (args) => {
                      await limits.quota(args);
                      await limits.admit(args);
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
      // Every tenant with data, from the database: one whose keys have not called since this server
      // started is maintained too. Names only; each pass runs in its tenant's own context.
      discover: () =>
        pageTenants((after) => sql<{ tenant: string }[]>`
          SELECT slotlock.maintenance_tenants(${after}::text) AS tenant`),
      intervalMs: SERVE_MAINTENANCE_INTERVAL_MS,
      ...(config.usage ? { usage: true } : {}),
      // Holiday calendar subscriptions (RFC 0004 B1), never from a private address.
      holidayFetch: createSlotlockGuardedFetch(),
      // Team workspaces' verified domains, looked up again each day; each change in the team's audit log.
      ...(config.verifiedDomains
        ? {
            domainChecks: (() => {
              const domains = createSlotlockWorkspaceDomains(sql);
              const resolvers = slotlockDomainResolvers(config.verifiedDomains.resolver);
              const audit = createSlotlockStore(sql, retention);
              return () =>
                runSlotlockDomainChecks({
                  domains,
                  resolvers,
                  record: (tenantRef, event) =>
                    audit.withTenant(tenantRef, (tenant) => tenant.recordAuditEvent({ tenantRef, event })).then(() => undefined),
                });
            })(),
          }
        : {}),
      // Counts only, never the tenant.
      onPass: (result) => {
        metrics?.maintenance(result);
        log.info('maintenance', { ...result });
      },
      onError: (error) => log.error('maintenance_failed', describeError(error)),
      // For the admin console (RFC 0006, M11): each tenant whose pass failed, until one runs, and an
      // hour's passes counted. Never a tenant's data.
      record: createSlotlockMaintenanceRecord(sql),
    });
    if (config.webhooks !== 'off') {
      const deliveryStore = createSlotlockStore(sql, retention);
      const send = createSlotlockWebhookSender({ allowPrivateNetworks: config.webhooks === 'private' });
      webhooks = startSlotlockWebhookDelivery({
        // The tenants with a webhook, from the database: a restarted server finds them all.
        tenants: () =>
          pageTenants((after) => sql<{ tenant: string }[]>`
            SELECT slotlock.webhook_tenants(${after}::text) AS tenant`),
        deliver: (tenantRef) =>
          deliverSlotlockWebhooks({
            tenantRef,
            send,
            feed: {
              claimWebhookDeliveries: (params) =>
                deliveryStore.withTenant(tenantRef, (tenant) => tenant.claimWebhookDeliveries(params)),
              settleWebhookDelivery: (params) =>
                deliveryStore.withTenant(tenantRef, (tenant) => tenant.settleWebhookDelivery(params), {
                  origin: 'maintenance',
                }),
            },
          }),
        // Counts only, never the tenant or a URL; the tenant's own count goes to its usage.
        onPass: (tenantRef, result) => {
          metrics?.webhooks(result);
          log.info('webhooks', { ...result });
          usage?.add({ tenantRef, metric: 'webhook_deliveries', origin: 'webhooks', count: result.delivered });
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
      usage: config.usage,
      quotas: config.quotas,
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
      client_address_proof: config.trustedProxySecret !== undefined,
    });
    return {
      address,
      async close() {
        const result = await listener.close();
        limits.close();
        // What the last requests counted is recorded before the pool closes.
        await usage?.close();
        await tracer?.shutdown();
        await metricsExport?.shutdown();
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
/**
 * `slotlock sandbox …` (RFC 0004 A6), in the tenant SLOTLOCK_TENANT names, which must be a test
 * environment (`<tenant>~test`): seed a scenario, reset, fast-forward, or race agents for one slot.
 */
async function runSandboxCommand(
  subcommand: 'sandbox seed' | 'sandbox reset' | 'sandbox fast-forward' | 'sandbox race',
  operands: readonly string[],
  values: { agents?: string; start?: string },
  io: SlotlockCliIo,
): Promise<number> {
  const config = readSlotlockDatabaseConfig(io.env);
  if (!config.tenantRef.endsWith(SLOTLOCK_TEST_TENANT_SUFFIX)) {
    io.stderr.write(`slotlock: the sandbox works only in a test environment: SLOTLOCK_TENANT=${config.tenantRef}${SLOTLOCK_TEST_TENANT_SUFFIX}\n`);
    return 2;
  }
  const line = (value: unknown) => io.stdout.write(`${JSON.stringify(value)}\n`);
  const sql = connect(config.databaseUrl, subcommand === 'sandbox race' ? 20 : 1);
  const store = createSlotlockStore(sql);
  try {
    if (subcommand === 'sandbox seed') {
      const scenario = operands[1] as SlotlockSandboxScenario;
      if (!(SLOTLOCK_SANDBOX_SCENARIOS as readonly string[]).includes(scenario)) {
        io.stderr.write(`slotlock: the scenarios are ${SLOTLOCK_SANDBOX_SCENARIOS.join(', ')}\n`);
        return 2;
      }
      line(await seedSlotlockSandbox(store, config.tenantRef, scenario));
      return 0;
    }
    if (subcommand === 'sandbox reset') {
      line({ removed: await resetSlotlockSandbox(store, config.tenantRef) });
      return 0;
    }
    if (subcommand === 'sandbox fast-forward') {
      const minutes = /^[1-9][0-9]{0,5}$/.test(operands[1] ?? '') ? Number(operands[1]) : Number.NaN;
      if (!(minutes >= 1 && minutes <= 525_600)) {
        io.stderr.write('slotlock: fast-forward takes whole minutes, 1 to 525,600\n');
        return 2;
      }
      const forward = await fastForwardSlotlockSandbox(store, config.tenantRef, minutes);
      line({ minutes, holds: forward.holds, approvals: forward.approvals, pruned: forward.maintenance.pruned, approvals_expired: forward.maintenance.approvalsExpired });
      return 0;
    }
    // A race: on the resource named, from --start (an hour from tomorrow's 10:00 UTC by default).
    const agents = values.agents === undefined ? 100 : /^[0-9]{1,3}$/.test(values.agents) ? Number(values.agents) : Number.NaN;
    if (!(agents >= 2 && agents <= SLOTLOCK_SANDBOX_MAX_RACERS)) {
      io.stderr.write(`slotlock: --agents must be 2 to ${SLOTLOCK_SANDBOX_MAX_RACERS}\n`);
      return 2;
    }
    const tomorrow = new Date(Date.now() + 86_400_000);
    const start = values.start !== undefined
      ? new Date(values.start)
      : new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 10));
    if (!Number.isFinite(start.getTime())) {
      io.stderr.write('slotlock: --start must be a date and time, like 2027-03-02T10:00:00Z\n');
      return 2;
    }
    const resource = (
      await store.withTenant(config.tenantRef, (tenant) => tenant.listResources({ tenantRef: config.tenantRef, limit: 1000 }))
    ).find((candidate) => candidate.externalRef === operands[1] || candidate.id === operands[1]);
    if (!resource) {
      io.stderr.write('slotlock: no resource with that reference in the test environment\n');
      return 1;
    }
    const raced = await raceSlotlockSandbox({
      backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [...readAvailability(io.env)] }),
      tenantRef: config.tenantRef,
      resourceId: resource.id,
      start,
      end: new Date(start.getTime() + 3_600_000),
      agents,
    });
    line({
      agents: raced.agents,
      booked: raced.booked,
      refused: raced.refused,
      with_alternatives: raced.withAlternatives,
      server_errors: raced.serverErrors,
      p50_ms: raced.p50Ms,
      p99_ms: raced.p99Ms,
      max_ms: raced.maxMs,
    });
    return raced.booked === 1 && raced.serverErrors === 0 ? 0 : 1;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'sandbox_not_empty') {
      io.stderr.write('slotlock: the test environment has resources already; run slotlock sandbox reset first\n');
      return 1;
    }
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

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
    inherited: resource.inheritedAvailability ?? null,
  })}\n`;
}

/**
 * Why `out` cannot take an export, or null once it can: made now with mode 0700, or already an empty
 * directory (as lstat sees it, so not a link) of this user's that no one else may write. Whoever
 * else can write in it could read the export, or turn a table's file into a link elsewhere.
 */
async function exportDirectoryProblem(out: string): Promise<string | null> {
  await mkdir(dirname(out), { recursive: true });
  try {
    await mkdir(out, { mode: 0o700 });
    return null;
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
  }
  const found = await lstat(out);
  if (found.isSymbolicLink()) return 'is a link';
  if (!found.isDirectory()) return 'is not a directory';
  if (found.uid !== process.getuid?.()) return 'belongs to another user';
  if ((found.mode & 0o022) !== 0) return 'can be written by other users';
  if ((await readdir(out)).length > 0) return 'is not empty';
  return null;
}

/** A table's file, made by the export itself: never an entry that was there, nor through a link. */
const EXPORT_FILE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_APPEND;

/**
 * `tenant export [--out <dir>]` (RFC 0004 D3): everything the tenant keeps, read in one snapshot and
 * stored nowhere: JSON lines on stdout, or one owner-only NDJSON file a table in a new directory, or
 * an empty one only this user can write (exportDirectoryProblem). Prints what it wrote, and records
 * it in the audit log. An entry that appears in the directory under a table's name stops it.
 */
async function runTenantExport(
  config: SlotlockDatabaseConfig,
  io: { stdout: OutputStream; stderr: OutputStream },
  out: string | undefined,
): Promise<number> {
  if (out !== undefined) {
    const problem = await exportDirectoryProblem(out);
    if (problem) {
      io.stderr.write(`slotlock: ${out} ${problem}: export into a new directory, or an empty one only you can write\n`);
      return 1;
    }
  }
  // Each table's file, made at its first part and kept open for the rest.
  const files = new Map<string, FileHandle>();
  const sql = connect(config.databaseUrl, 1);
  try {
    const store = createSlotlockStore(sql);
    const tenantRef = config.tenantRef;
    const totals = await store.withTenant(tenantRef, async (tenant) => {
      const read = await tenant.streamTenantExport({
        tenantRef,
        onPart: async ({ table, lines }) => {
          if (out !== undefined) {
            let file = files.get(table);
            if (!file) {
              file = await open(joinPath(out, `${table}.ndjson`), EXPORT_FILE_FLAGS, 0o600);
              files.set(table, file);
            }
            await file.appendFile(`${lines.join('\n')}\n`);
          } else {
            io.stdout.write(lines.map((line) => `{"table":${JSON.stringify(table)},"row":${line}}\n`).join(''));
          }
        },
      });
      await tenant.recordAuditEvent({
        tenantRef,
        event: { action: 'export.created', actorType: 'system', actorRef: 'cli', targetType: 'export', metadata: { rows: read.rows } },
      });
      return read;
    });
    if (out !== undefined) io.stdout.write(`${JSON.stringify({ directory: out, ...totals })}\n`);
    return 0;
  } catch (error) {
    const { code, path } = error as { code?: unknown; path?: unknown };
    if (out !== undefined && (code === 'EEXIST' || code === 'ELOOP') && typeof path === 'string') {
      io.stderr.write(`slotlock: ${path} appeared while the export ran, so it stopped: export again into a new directory\n`);
      return 1;
    }
    throw error;
  } finally {
    for (const file of files.values()) await file.close().catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}

/**
 * `audit verify|export` (RFC 0004 D2): the tenant's workspace audit log. verify exits 1 when the
 * chain is broken; export prints every event kept, newest first, as JSON lines.
 */
async function runAudit(
  config: SlotlockDatabaseConfig,
  io: { stdout: OutputStream; stderr: OutputStream },
  subcommand: string,
): Promise<number> {
  const sql = connect(config.databaseUrl, 1);
  try {
    const store = createSlotlockStore(sql);
    const tenantRef = config.tenantRef;
    if (subcommand === 'audit verify') {
      const verified = await store.withTenant(tenantRef, (tenant) => tenant.verifyAuditChain({ tenantRef }));
      io.stdout.write(`${JSON.stringify({ checked: verified.checked, broken_at: verified.brokenAt })}\n`);
      if (verified.brokenAt === null) return 0;
      io.stderr.write(`slotlock: the audit log's chain breaks at event ${verified.brokenAt}: it was changed outside Slotlock\n`);
      return 1;
    }
    let before: string | undefined;
    for (;;) {
      const page = await store.withTenant(tenantRef, (tenant) =>
        tenant.listAuditEvents({ tenantRef, limit: 200, ...(before ? { beforeId: before } : {}) }),
      );
      for (const event of page) io.stdout.write(`${JSON.stringify(slotlockAuditEventRecord(event))}\n`);
      const last = page.at(-1);
      if (page.length < 200 || !last) return 0;
      before = last.id;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * `subject export|erase` (RFC 0004 D3): what the tenant keeps about one person, and taking them out
 * of it. The erasure is recorded in the audit log without the person.
 */
async function runSubject(
  config: SlotlockDatabaseConfig,
  io: { stdout: OutputStream; stderr: OutputStream },
  subcommand: string,
  subject: SlotlockSubject,
): Promise<number> {
  const sql = connect(config.databaseUrl, 1);
  try {
    const store = createSlotlockStore(sql);
    const tenantRef = config.tenantRef;
    try {
      if (subcommand === 'subject export') {
        const exported = await store.withTenant(tenantRef, (tenant) =>
          tenant.exportSubject({ tenantRef, subject, limit: 10_000 }),
        );
        for (const [table, rows] of Object.entries(exported.records)) {
          for (const row of rows) io.stdout.write(`${JSON.stringify({ table, row })}\n`);
        }
        if (exported.truncated) io.stderr.write('slotlock: a table had more than 10,000 rows; the first 10,000 are listed\n');
        return 0;
      }
      const { erased } = await store.withTenant(
        tenantRef,
        async (tenant) => {
          const result = await tenant.eraseSubject({ tenantRef, subject });
          await tenant.recordAuditEvent({
            tenantRef,
            event: {
              action: 'subject.erased',
              actorType: 'system',
              actorRef: 'cli',
              targetType: 'subject',
              metadata: {
                by: Object.keys(subject)[0],
                ...Object.fromEntries(Object.entries(result.erased).filter(([, rows]) => rows > 0)),
              },
            },
          });
          return result;
        },
        { isolation: 'read committed' },
      );
      io.stdout.write(`${JSON.stringify({ erased })}\n`);
      return 0;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'invalid_subject') {
        io.stderr.write('slotlock: give an email address, or a holder, contact or booking reference of 1-500 bytes\n');
        return 2;
      }
      throw error;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * `closures list|add|delete|import` (RFC 0004 B1): the tenant's closures and special days. Exit 0, 1
 * when a name, id or file is not found or refused, as JSON lines on stdout.
 */
async function runClosures(
  config: SlotlockDatabaseConfig,
  io: { stdout: OutputStream; stderr: OutputStream },
  subcommand: string,
  operands: readonly string[],
  given: { resource?: string; location?: string; label?: string; open?: string },
): Promise<number> {
  const sql = connect(config.databaseUrl, 1);
  const fail = (message: string) => {
    io.stderr.write(`slotlock: ${message}\n`);
    return 1;
  };
  try {
    const store = createSlotlockStore(sql);
    const tenantRef = config.tenantRef;
    const line = (exception: SlotlockAvailabilityException) =>
      io.stdout.write(
        `${JSON.stringify({
          id: exception.id,
          location: exception.location ?? null,
          resource_id: exception.resourceId ?? null,
          starts_on: exception.startsOn,
          ends_on: exception.endsOn,
          outcome: exception.outcome,
          hours: exception.hours ?? null,
          label: exception.label,
          source: exception.source,
        })}\n`,
      );
    let scope: { location?: string; resourceId?: string } = {};
    if (given.location !== undefined) scope = { location: given.location };
    if (given.resource !== undefined) {
      const resources = await tenantResources(store, tenantRef);
      const named =
        resources.find((resource) => resource.id === given.resource) ??
        resources.find((resource) => resource.externalRef === given.resource);
      if (!named) return fail('no resource with that reference or id in this tenant');
      scope = { resourceId: named.id };
    }
    try {
      if (subcommand === 'closures list') {
        const exceptions = await store.withTenant(tenantRef, (tenant) =>
          tenant.listAvailabilityExceptions({
            tenantRef,
            from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
            limit: 1_000,
          }),
        );
        for (const exception of exceptions) line(exception);
        return 0;
      }
      if (subcommand === 'closures delete') {
        const deleted = await store.withTenant(tenantRef, (tenant) =>
          tenant.deleteAvailabilityException({ tenantRef, id: operands[0] as string }),
        );
        if (!deleted) return fail('no closure with that id in this tenant');
        io.stdout.write(`${JSON.stringify({ deleted: true })}\n`);
        return 0;
      }
      if (subcommand === 'closures add') {
        let hours: { startMinutes: number; durationMinutes: number }[] | undefined;
        if (given.open !== undefined) {
          const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(given.open);
          if (!match) return fail('--open takes HH:MM-HH:MM, like 10:00-14:00');
          const [opens, closes] = [Number(match[1]) * 60 + Number(match[2]), Number(match[3]) * 60 + Number(match[4])];
          hours = [{ startMinutes: opens, durationMinutes: closes > opens ? closes - opens : closes + 1_440 - opens }];
        }
        const exception = await store.withTenant(tenantRef, (tenant) =>
          tenant.createAvailabilityException({
            tenantRef,
            ...scope,
            startsOn: operands[0] as string,
            ...(operands[1] !== undefined ? { endsOn: operands[1] } : {}),
            outcome: hours ? 'open' : 'closed',
            ...(hours ? { hours } : {}),
            label: given.label ?? '',
          }),
        );
        line(exception);
        return 0;
      }
      // closures import <file> [--label <calendar name>]
      let text: string;
      try {
        text = await readFile(operands[0] as string, 'utf8');
      } catch {
        return fail('that file cannot be read');
      }
      const read = await readSlotlockHolidayCalendar({
        icalendar: text,
        ...(given.label !== undefined ? { name: given.label } : {}),
      });
      const result = await store.withTenant(tenantRef, (tenant) =>
        tenant.importHolidayCalendar({ tenantRef, ...scope, name: read.name, holidays: read.holidays, span: read.span }),
      );
      io.stdout.write(
        `${JSON.stringify({ imported: result.imported, removed: result.removed, skipped: read.skipped, calendar: result.calendar.name })}\n`,
      );
      return 0;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (
        code === 'invalid_availability_exception' ||
        code === 'invalid_holiday_calendar' ||
        code === 'location_not_found' ||
        code === 'resource_not_found' ||
        code === 'availability_exceptions_limit_reached' ||
        code === 'holiday_calendars_limit_reached'
      ) {
        return fail((error as Error).message);
      }
      throw error;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
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
  target: { resource: string } | { location: string } | 'all' | 'show',
  rules?: WeeklyAvailabilityRule[] | null,
  override: SlotlockOverrideResources = 'none',
): Promise<boolean> {
  const sql = connect(config.databaseUrl, 1);
  try {
    const store = createSlotlockStore(sql);
    const tenantRef = config.tenantRef;
    if (target === 'all') {
      // The tenant's hours, which every resource without its own inherits (RFC 0004 B2).
      const result = await store.withTenant(tenantRef, (tenant) =>
        tenant.storeTenantAvailability({ tenantRef, rules: rules ?? null, overrideResources: override }),
      );
      out.write(`${JSON.stringify({ inheriting: result.inheriting, own_hours: result.ownHours })}\n`);
      return true;
    }
    if (typeof target === 'object' && 'location' in target) {
      const result = await store.withTenant(tenantRef, (tenant) =>
        tenant.setLocationAvailability({ tenantRef, location: target.location, rules: rules ?? null }),
      );
      if (!result) return false;
      out.write(`${JSON.stringify({ location: target.location, inheriting: result.inheriting, own_hours: result.ownHours })}\n`);
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
    if (!('resource' in target)) return false;
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
 * `billing daily`: everything billing needs once a day, idempotent, for a cron job. Last month is
 * closed for each active partner only once it has been over for BILLING_GRACE_MS, as late counts
 * (bookings roll up hourly) settle first; overage goes for last month and this one; and each
 * partner's reconciliation mismatches of the last week are listed. Exit 1 when anything waits or
 * differs, so the cron job's failure is the incident.
 */
async function runBillingDaily(
  owner: postgres.Sql,
  io: { stdout: OutputStream; stderr: OutputStream },
  options: { now: number; stripeSecretKey: string | undefined; overage: boolean },
): Promise<number> {
  const lines: unknown[] = [];
  const line = (value: unknown) => {
    lines.push(value);
    io.stdout.write(`${JSON.stringify(value)}\n`);
  };
  let attention = false;
  const month = slotlockPreviousMonth(options.now);
  const today = new Date(options.now);
  const monthBegan = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1);
  if (options.now - monthBegan < BILLING_GRACE_MS) {
    line({ job: 'partner_close', month, waiting_until: new Date(monthBegan + BILLING_GRACE_MS).toISOString() });
  } else {
    for (const partner of await listSlotlockPartners(owner)) {
      if (partner.status !== 'active') continue;
      const closed = await closeSlotlockPartnerMonth(owner, {
        partnerId: partner.id,
        month,
        now: options.now,
        ...(options.stripeSecretKey ? { stripe: { secretKey: options.stripeSecretKey } } : {}),
      });
      line({ job: 'partner_close', partner: partner.id, month, webhook: closed.webhook, invoiced: closed.invoiced, pending: closed.pending });
      if (closed.webhook === 'failed' || closed.pending > 0) attention = true;
    }
  }
  if (options.overage) {
    if (!options.stripeSecretKey) {
      line({ job: 'overage', skipped: 'no STRIPE_SECRET_KEY' });
      attention = true;
    } else {
      for (const reported of [month, slotlockMonthOf(options.now)]) {
        const report = await reportSlotlockOverage(owner, {
          month: reported,
          now: options.now,
          stripe: { secretKey: options.stripeSecretKey, eventName: 'slotlock_operations' },
        });
        line({ job: 'overage', month: reported, sent: report.sent, failed: report.failed });
        if (report.failed > 0) attention = true;
      }
    }
  }
  const mismatches = await owner<{ partner_id: string; day: string; mismatched: number; worst: number }[]>`
    SELECT partner_id, day::text, mismatched, worst_percent::float AS worst
      FROM slotlock.partner_reconciliations
     WHERE mismatched > 0 AND day >= current_date - 7
     ORDER BY day, partner_id`;
  for (const mismatch of mismatches) {
    line({ job: 'reconciliation', partner: mismatch.partner_id, day: mismatch.day, mismatched: mismatch.mismatched, worst_percent: mismatch.worst });
    attention = true;
  }
  line({ job: 'done', month, attention });
  // For the admin console's Home and Billing pages (RFC 0006, M4).
  await recordMaintenanceRun(owner, 'billing_daily', options.now, attention, { lines: lines.slice(-50) });
  if (attention) io.stderr.write('slotlock: billing needs attention: see the lines above; run billing daily again once it is resolved\n');
  return attention ? 1 : 0;
}

/**
 * A billing job's run (`billing daily`, `overage report`) in the database, by `cli:<user>`, for the
 * admin console. Skipped on a schema from before it, so the job still runs against one.
 */
async function recordMaintenanceRun(
  owner: postgres.Sql,
  job: 'billing_daily' | 'overage_report',
  startedMs: number,
  attention: boolean,
  summary: Record<string, unknown>,
): Promise<void> {
  const [found] = await owner<{ present: boolean }[]>`
    SELECT to_regprocedure('slotlock.record_maintenance_run(text, text, timestamptz, boolean, jsonb)') IS NOT NULL AS present`;
  if (!found?.present) return;
  await owner`SELECT slotlock.record_maintenance_run(${job}, ${cliActor()}, ${new Date(Math.min(startedMs, Date.now()))},
    ${attention}, ${owner.json(summary as never)})`;
}

/** How long after a month ends billing daily waits to close it: late counts settle first. */
const BILLING_GRACE_MS = 6 * 3_600_000;

/**
 * `resource parent <ref> <parent-ref | none>` (RFC 0003 G8): make a resource a part of a composite,
 * or no part. The refusal's code when the database refuses it, false for no such resource.
 */
async function setResourceParent(
  config: SlotlockDatabaseConfig,
  out: OutputStream,
  name: string,
  parentName: string,
): Promise<boolean | string> {
  const sql = connect(config.databaseUrl, 1);
  try {
    const store = createSlotlockStore(sql);
    const tenantRef = config.tenantRef;
    const resources = await tenantResources(store, tenantRef, true);
    const find = (wanted: string) =>
      resources.find((resource) => resource.id === wanted) ?? resources.find((resource) => resource.externalRef === wanted);
    const named = find(name);
    if (!named) return false;
    const parent = parentName === 'none' ? null : find(parentName);
    if (parent === undefined) return 'parent_not_found';
    try {
      const changed = await store.withTenant(tenantRef, (tenant) =>
        tenant.setResourceParent({ tenantRef, id: named.id, parentId: parent?.id ?? null }),
      );
      if (!changed) return false;
      out.write(
        `${JSON.stringify({ id: changed.id, external_ref: changed.externalRef, parent_id: changed.parentId ?? null, part_index: changed.partIndex ?? null })}\n`,
      );
      return true;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && (code.startsWith('composite_') || code === 'parent_not_found')) return code;
      throw error;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * `partner …` (RFC 0003 part 4), as the schema owner (SLOTLOCK_MIGRATE_DATABASE_URL when set): make
 * a partner with its contract, list them, suspend one (every account with it) or make it active,
 * make or revoke its keys (shown once), and set its Stripe customer and its webhook (whose secret
 * is made here and shown once).
 */
async function runPartnerCommand(
  config: SlotlockDatabaseConfig,
  io: { stdout: OutputStream; stderr: OutputStream },
  action: string,
  operands: readonly string[],
  contractGiven: string | undefined,
  close: { month: string | undefined; stripeSecretKey: string | undefined } = { month: undefined, stripeSecretKey: undefined },
): Promise<number> {
  const owner = connect(config.migrateDatabaseUrl ?? config.databaseUrl, 1);
  const [id = '', second = ''] = operands;
  const line = (value: unknown) => io.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    switch (action) {
      case 'create': {
        const text = contractGiven?.startsWith('@')
          ? await readFile(contractGiven.slice(1), 'utf8')
          : (contractGiven ?? '');
        let contract: unknown;
        try {
          contract = JSON.parse(text);
        } catch {
          throw Object.assign(new Error('Slotlock partner contract: --contract is not JSON'), { code: 'invalid_partner_contract' });
        }
        const partner = await putSlotlockPartner(owner, { id, name: second, contract });
        line({ id: partner.id, name: partner.name, status: partner.status, contract: slotlockPartnerContractJson(partner.contract) });
        return 0;
      }
      case 'list':
        for (const partner of await listSlotlockPartners(owner)) {
          line({
            id: partner.id,
            name: partner.name,
            status: partner.status,
            stripe_customer: partner.stripeCustomer,
            webhook_url: partner.webhookUrl,
            plans: Object.keys(partner.contract.plans),
          });
        }
        return 0;
      case 'suspend':
      case 'unsuspend': {
        const changed = await setSlotlockPartnerStatus(owner, id, action === 'suspend' ? 'suspended' : 'active');
        if (!changed) {
          io.stderr.write('slotlock: no partner with that id\n');
          return 1;
        }
        line({ id, status: action === 'suspend' ? 'suspended' : 'active' });
        return 0;
      }
      case 'key': {
        const created = await createSlotlockPartnerKey(owner, id, second);
        line({ partner: id, id: created.id, prefix: created.prefix, key: created.key });
        io.stderr.write('slotlock: the partner key is shown once and only its SHA-256 is stored; send it to the partner securely\n');
        return 0;
      }
      case 'revoke-key': {
        if (!(await revokeSlotlockPartnerKey(owner, id, second))) {
          io.stderr.write('slotlock: no key with that id for that partner\n');
          return 1;
        }
        line({ partner: id, id: second, revoked: true });
        return 0;
      }
      case 'customer': {
        if (!(await setSlotlockPartnerBilling(owner, id, { stripeCustomer: second }))) {
          io.stderr.write('slotlock: no partner with that id\n');
          return 1;
        }
        line({ id, stripe_customer: second });
        return 0;
      }
      case 'webhook': {
        const secret = `whsec_${randomBytes(32).toString('base64')}`;
        if (!(await setSlotlockPartnerBilling(owner, id, { webhookUrl: second, webhookSecret: secret }))) {
          io.stderr.write('slotlock: no partner with that id\n');
          return 1;
        }
        line({ id, webhook_url: second, webhook_secret: secret });
        io.stderr.write('slotlock: the webhook secret is shown once; the partner verifies usage.period_closed with it\n');
        return 0;
      }
      case 'close': {
        const closed = await closeSlotlockPartnerMonth(owner, {
          partnerId: id,
          month: close.month ?? slotlockPreviousMonth(Date.now()),
          ...(close.stripeSecretKey ? { stripe: { secretKey: close.stripeSecretKey } } : {}),
        });
        line({
          partner: closed.partner,
          month: closed.month,
          accounts: closed.accounts.length,
          lines: closed.lines.map((entry) => ({
            line: entry.line,
            quantity: entry.quantity,
            amount: entry.amount,
            currency: entry.currency,
            stripe_item: entry.stripeItem,
          })),
          checksum: closed.checksum,
          closed_now: closed.closedNow,
          webhook: closed.webhook,
          ...(closed.webhookStatus !== undefined ? { webhook_status: closed.webhookStatus } : {}),
          invoiced: closed.invoiced,
          pending: closed.pending,
        });
        if (closed.webhook === 'failed') {
          io.stderr.write('slotlock: the partner\'s endpoint did not take usage.period_closed; run partner close again for the same month\n');
        }
        if (closed.pending > 0) {
          io.stderr.write(
            close.stripeSecretKey
              ? 'slotlock: some lines did not reach Stripe; run partner close again for the same month\n'
              : 'slotlock: lines recorded, not invoiced: set STRIPE_SECRET_KEY (and partner customer) and run it again\n',
          );
        }
        return closed.pending > 0 || closed.webhook === 'failed' ? 1 : 0;
      }
      default:
        return 2;
    }
  } finally {
    await owner.end({ timeout: 5 });
  }
}

/** Who ran a staff command, for the staff log: `cli:` and the operating system user. */
function cliActor(): string {
  let name = 'operator';
  try {
    name = userInfo().username;
  } catch {
    // No user database (a scratch container): the generic name.
  }
  const cleaned = name.toLowerCase().replace(/[^a-z0-9_.-]/g, '_').replace(/^[^a-z_]/, '_').slice(0, 64);
  return `cli:${cleaned || 'operator'}`;
}

/** `123` or `github:123`, as the staff tables name members; null for anything else. */
function readStaffRef(value: string | undefined): string | null {
  const id = /^(?:github:)?([1-9][0-9]{0,19})$/.exec(value?.trim() ?? '')?.[1];
  return id === undefined ? null : `github:${id}`;
}

/**
 * `staff list|add|role|reset|remove`: the admin console's staff (RFC 0006). Only the schema owner
 * may run the functions behind them (SLOTLOCK_OPERATOR_FUNCTIONS), so they connect as
 * SLOTLOCK_MIGRATE_DATABASE_URL when it is set. Each change lands in the staff log as `cli:<user>`.
 * `add` and `reset` print a one-time code, of which only the SHA-256 is stored.
 */
async function runStaffCommand(
  config: SlotlockDatabaseConfig,
  out: OutputStream,
  action: 'list' | 'add' | 'role' | 'reset' | 'remove' | 'console-key' | 'verify-log',
  staffRef: string | null,
  role: string | undefined,
): Promise<number> {
  const sql = connect(config.migrateDatabaseUrl ?? config.databaseUrl, 1);
  const actor = cliActor();
  const line = (value: Record<string, unknown>) => out.write(`${JSON.stringify(value)}\n`);
  const code = () => {
    const value = randomBytes(24).toString('base64url');
    return {
      value,
      hash: createHash('sha256').update(value).digest(),
      expires: new Date(Date.now() + SLOTLOCK_STAFF_ENROLLMENT_DAYS * 86_400_000),
    };
  };
  try {
    if (action === 'list') {
      const rows = await sql<{ staff_ref: string; role: string; status: string; added_at: Date; last_seen_at: Date | null; passkeys: number }[]>`
        SELECT member.staff_ref, member.role, member.status, member.added_at, member.last_seen_at,
               (SELECT count(*)::integer FROM slotlock.staff_passkeys key WHERE key.staff_ref = member.staff_ref) AS passkeys
          FROM slotlock.staff_members member
         ORDER BY member.status, member.added_at`;
      for (const row of rows) line({ ...row });
      return 0;
    }
    if (action === 'verify-log') {
      // Every event, oldest kept first: its head is what to compare with a head recorded earlier.
      const [chain] = await sql<{ checked: string; broken_at: string | null; head_index: string | null; head_hash: Buffer | null }[]>`
        SELECT * FROM slotlock.staff_audit_chain_check(NULL)`;
      line({
        checked: Number(chain?.checked ?? 0),
        broken_at: chain?.broken_at === null || chain?.broken_at === undefined ? null : Number(chain.broken_at),
        head_index: chain?.head_index === null || chain?.head_index === undefined ? null : Number(chain.head_index),
        head_hash: chain?.head_hash ? Buffer.from(chain.head_hash).toString('hex') : null,
      });
      return chain?.broken_at === null || chain?.broken_at === undefined ? 0 : 1;
    }
    if (action === 'console-key') {
      // The console proves with this key that a staff session is its own: only its SHA-256 is
      // stored, where the console's database role cannot read it. Replacing it ends every session.
      const key = randomBytes(32).toString('base64url');
      await sql`SELECT slotlock.staff_console_key(${createHash('sha256').update(key).digest()}, ${actor})`;
      line({ console_key: key, set_as: 'SLOTLOCK_ADMIN_CONSOLE_KEY' });
      return 0;
    }
    if (action === 'add' || action === 'reset') {
      const issued = code();
      if (action === 'add') {
        await sql`SELECT slotlock.staff_add(${staffRef}, ${role ?? null}, ${actor}, ${issued.hash}, ${issued.expires})`;
      } else {
        await sql`SELECT slotlock.staff_reset(${staffRef}, ${actor}, ${issued.hash}, ${issued.expires})`;
      }
      line({ staff: staffRef, ...(role !== undefined ? { role } : {}), enrollment_code: issued.value, expires_at: issued.expires.toISOString() });
      return 0;
    }
    if (action === 'role') {
      await sql`SELECT slotlock.staff_set_role(${staffRef}, ${role ?? null}, ${actor})`;
      line({ staff: staffRef, role });
      return 0;
    }
    await sql`SELECT slotlock.staff_remove(${staffRef}, ${actor})`;
    line({ staff: staffRef, removed: true });
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * `tenant status|suspend|unsuspend|erase` for SLOTLOCK_TENANT. Suspending and lifting a suspension
 * are the deployment role's alone, so they connect as SLOTLOCK_MIGRATE_DATABASE_URL when it is set;
 * the serving role reads a suspension and may erase.
 */
/**
 * A deployment-role command in the staff log (RFC 0006), by `cli:<user>`: suspensions, their end
 * and erasure, and the default plan. Skipped on a schema from before the staff log, so the command
 * still works against it.
 */
async function recordOperatorAction(
  sql: postgres.Sql | postgres.TransactionSql,
  happened: string,
  account: string | null,
  why: string | undefined,
): Promise<boolean> {
  const [found] = await sql<{ present: boolean }[]>`
    SELECT to_regprocedure('slotlock.staff_operator_record(text, text, text, text)') IS NOT NULL AS present`;
  if (!found?.present) return false;
  await sql`SELECT slotlock.staff_operator_record(${cliActor()}, ${happened}, ${account}, ${why ?? null})`;
  return true;
}

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
    } else if (action === 'suspend' || action === 'unsuspend') {
      // The change and its record in the staff log (RFC 0006) commit together.
      const changed = await sql.begin(async (tx) => {
        const inTransaction = createSlotlockStore(tx as unknown as postgres.Sql);
        const done =
          action === 'suspend'
            ? (await inTransaction.suspendTenant({ tenantRef, ...(reason !== undefined ? { reason } : {}) })).suspended
            : (await inTransaction.unsuspendTenant({ tenantRef })).unsuspended;
        if (done) await recordOperatorAction(tx, `account.${action}ed`, tenantRef, reason);
        return done;
      });
      line = { tenant: tenantRef, suspended: action === 'suspend', changed };
    } else {
      const erased = await store.eraseTenant({ tenantRef });
      // Erasure runs as the serving role, which cannot write the staff log; with the deployment
      // role's URL it is recorded after, on its own connection.
      if (config.migrateDatabaseUrl) {
        const owner = connect(config.migrateDatabaseUrl, 1);
        try {
          await recordOperatorAction(owner, 'account.erased', tenantRef, `${erased.total} rows`);
        } finally {
          await owner.end({ timeout: 5 });
        }
      }
      line = { tenant: tenantRef, total: erased.total, rows: erased.rows };
    }
    out.write(`${JSON.stringify(line)}\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * `plan status` prints the default plan and SLOTLOCK_TENANT's own; `plan default` sets or removes
 * the default, as the deployment role (SLOTLOCK_MIGRATE_DATABASE_URL when set), and then prints both.
 */
async function runPlanCommand(
  config: SlotlockDatabaseConfig,
  out: OutputStream,
  planDefault: { plan: SlotlockPlan; appliesFrom: Date } | null,
  set: boolean,
): Promise<void> {
  if (set) {
    const owner = connect(config.migrateDatabaseUrl ?? config.databaseUrl, 1);
    try {
      await setSlotlockPlanDefault(owner, planDefault);
      await recordOperatorAction(
        owner,
        planDefault ? 'plan.default_set' : 'plan.default_removed',
        null,
        planDefault ? `${planDefault.plan} from ${planDefault.appliesFrom.toISOString().slice(0, 10)}` : undefined,
      );
    } finally {
      await owner.end({ timeout: 5 });
    }
  }
  const sql = connect(config.databaseUrl, 1);
  try {
    const fallback = await readSlotlockPlanDefault(sql);
    const own = await readSlotlockTenantPlan(sql, config.tenantRef);
    out.write(
      `${JSON.stringify({
        default: fallback
          ? {
              plan: fallback.plan,
              applies_from: fallback.appliesFrom.toISOString(),
              resources: fallback.limits.resources,
              api_keys: fallback.limits.apiKeys,
              webhook_endpoints: fallback.limits.webhookEndpoints,
            }
          : null,
        tenant: config.tenantRef,
        plan: own
          ? {
              plan: own.plan,
              status: own.status,
              resources: own.limits.resources,
              api_keys: own.limits.apiKeys,
              webhook_endpoints: own.limits.webhookEndpoints,
              paid: own.stripeSubscription !== null,
              current_period_end: own.currentPeriodEnd?.toISOString() ?? null,
            }
          : null,
      })}\n`,
    );
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
    ...(apiKey.resourceScope ? { resource_scope: apiKey.resourceScope } : {}),
    ...(apiKey.limits ? { limits: apiKeyLimitsJson(apiKey.limits) } : {}),
    ...(key !== undefined ? { key } : {}),
  })}\n`;
}

/** A key's limits as the CLI prints them: snake_case, as the API names them. */
function apiKeyLimitsJson(limits: SlotlockApiKeyLimits) {
  return {
    ...(limits.maxHolds !== undefined ? { max_holds: limits.maxHolds } : {}),
    ...(limits.maxHeldHours !== undefined ? { max_held_hours: limits.maxHeldHours } : {}),
    ...(limits.requestsPerMinute !== undefined ? { requests_per_minute: limits.requestsPerMinute } : {}),
    ...(limits.requiresApproval ? { requires_approval: true } : {}),
  };
}

/** `--max-holds`, `--max-held-hours`, `--requests-per-minute`, `--requires-approval` (RFC 0004 A5). */
function parseKeyLimits(values: {
  'max-holds'?: string;
  'max-held-hours'?: string;
  'requests-per-minute'?: string;
  'requires-approval'?: boolean;
}): SlotlockApiKeyLimits {
  const whole = (option: string, value: string | undefined, most: number) => {
    if (value === undefined) return undefined;
    const parsed = /^[0-9]{1,7}$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > most) {
      throw new Error(`--${option} must be a whole number from 1 to ${most.toLocaleString('en-US')}`);
    }
    return parsed;
  };
  const maxHolds = whole('max-holds', values['max-holds'], 10_000);
  const maxHeldHours = whole('max-held-hours', values['max-held-hours'], 876_000);
  const requestsPerMinute = whole('requests-per-minute', values['requests-per-minute'], 100_000);
  return {
    ...(maxHolds !== undefined ? { maxHolds } : {}),
    ...(maxHeldHours !== undefined ? { maxHeldHours } : {}),
    ...(requestsPerMinute !== undefined ? { requestsPerMinute } : {}),
    ...(values['requires-approval'] === true ? { requiresApproval: true } : {}),
  };
}

/** `--locations` and `--groups`: references, comma-separated; neither for a key of the whole tenant. */
function parseKeyResourceScope(
  locations: string | undefined,
  groups: string | undefined,
): SlotlockResourceScope | undefined {
  if (locations === undefined && groups === undefined) return undefined;
  const list = (value: string | undefined) =>
    (value ?? '')
      .split(',')
      .map((ref) => ref.trim())
      .filter((ref) => ref !== '');
  const scope = { locations: list(locations), groups: list(groups) };
  if (!isSlotlockResourceScope(scope)) {
    throw new Error('--locations and --groups take up to 20 location or group references each, at least one in all');
  }
  return scope;
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
        approvalsExpired: 0,
        bookingsCompleted: 0,
        remindersDue: 0,
        holidayCalendarsImported: 0,
        capped: true,
        passes: 0,
      };
      // Holiday calendar subscriptions by URL (RFC 0004 B1), never from a private address.
      const holidayFetch = createSlotlockGuardedFetch();
      while (sum.capped && sum.passes < MAINTAIN_MAX_PASSES) {
        const pass = await maintainSlotlockTenant(store, config.tenantRef, { holidayFetch });
        sum.passes += 1;
        sum.extended += pass.extended;
        sum.conflicts += pass.conflicts;
        sum.refused += pass.refused;
        sum.pruned += pass.pruned;
        sum.zoneShifts += pass.zoneShifts;
        sum.staleSources += pass.staleSources;
        sum.noShows += pass.noShows;
        sum.waitlistOffers += pass.waitlistOffers;
        sum.approvalsExpired += pass.approvalsExpired;
        sum.bookingsCompleted += pass.bookingsCompleted;
        sum.remindersDue += pass.remindersDue;
        sum.holidayCalendarsImported += pass.holidayCalendarsImported;
        // A capped pass that got nowhere met only series it cannot extend. While its roll stopped
        // before the series it had put back, the next pass meets new ones (and perhaps a healthy
        // one); once it reached them, another pass would meet them again.
        sum.capped = pass.capped;
        if (pass.capped && pass.extended + pass.pruned === 0 && !pass.rollPending) break;
      }
      // Every tenant's expired assistant conversations, a tenant only the dashboard serves
      // included. Counted nowhere: the counts above are this tenant's.
      await store.sweepAssistantConversations();
      // And finished team invitations, with the addresses they were sent to, and ended sessions.
      await store.sweepDashboardRecords();
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
                           role when SLOTLOCK_MIGRATE_DATABASE_URL names another role, and the
                           admin console's role when SLOTLOCK_ADMIN_DATABASE_URL is set
  serve [--migrate]        Serve MCP, A2A and REST over HTTP (--migrate runs migrate first);
                           maintains every tenant with data every hour
  maintain                 Run maintenance for the tenant now: extend recurring events to the
                           rolling horizon and prune past the retention window (for cron)
  resource add <ref> [--timezone <IANA zone>]
                           Create a calendar resource (a car, room, person or machine)
  resource list            Print the tenant's resources, one JSON object per line
  resource archive <ref>   Take a resource out of use: no new bookings, holds or events, and
                           no longer listed; what is on it stays
  resource restore <ref>   Put an archived resource back in use
  resource parent <ref> (<parent-ref> | none)
                           Make a resource a part of a composite (a room of a hall): booking
                           the whole then takes every part, and a part's booking keeps the
                           whole from being booked; none makes it no part
  resource delete <ref>    Delete a resource and its history; refused while a booking, hold
                           or event on it has not ended
  hours show [--resource <ref>]
                           Print each resource's bookable hours: its own (null when none) and
                           what it inherits from its location or the tenant
  hours set <json> (--resource <ref> | --location <ref> | --all [--override | --matching])
                           Give one resource, one location or the tenant weekly hours; a
                           resource without its own inherits its location's, then the
                           tenant's, then the server's; --override also clears resources'
                           own hours, --matching only those the same as the tenant's were
                           or as these (copies 0.8.0 made); [] closes
  hours clear (--resource <ref> | --location <ref> | --all)
                           Clear those hours, so they inherit from further up
  closures list            Print the tenant's closures and special days from yesterday on
  closures add <first-day> [<last-day>] --label <text> [--open HH:MM-HH:MM]
               [--resource <ref> | --location <ref>]
                           Close whole days (YYYY-MM-DD), or with --open give them those hours
                           instead, everywhere or for one location or resource
  closures delete <id>     Remove a closure
  closures import <file> [--resource <ref> | --location <ref>] [--label <calendar name>]
                           Close the days an iCalendar file of holidays names (each all-day
                           event, for the next two years); importing the calendar again (by its
                           name: --label, else its own) updates them and removes those it dropped
  rules set <json> --resource <ref>
                           Set what a booking on the resource must satisfy, like
                           {"minNoticeMinutes":120,"slotStepMinutes":30,"turnaroundMinutes":30,"enforceHours":true}
  rules clear --resource <ref>
                           Remove the resource's booking rules
  key create <name> [--scope read,write,admin] [--expires-in-days <n>]
             [--locations <ref,...>] [--groups <ref,...>]
                           Create an API key for the tenant (default scope read,write, no
                           expiry; admin adds the application API) and print it once; only its
                           SHA-256 is stored. With --locations or --groups, the key reaches
                           only the resources there (each location with those in it), read and
                           write only
             [--max-holds <n>] [--max-held-hours <n>] [--requests-per-minute <n>]
             [--requires-approval]
                           ... and hold the key below the server's limits: its live holds, the
                           hours they hold, its requests a minute, and every booking it makes
                           waiting for a person (the dashboard's Approvals)
  key limits <id> [--max-holds <n>] [--max-held-hours <n>] [--requests-per-minute <n>]
             [--requires-approval]
                           Replace an active key's limits; none at all gives it the server's
  key list                 Print the tenant's API keys, one JSON object per line
  key rotate <id>          Give an active key a new secret and print it once; the old one stops
                           working at once, and the key keeps its id and what it booked
  key revoke <id>          Revoke one of the tenant's API keys at once
  sandbox seed <car-rental|clinic|desks>
                           Fill an empty test environment (SLOTLOCK_TENANT=<tenant>~test) with a
                           scenario: locations, groups, resources, hours, rules and bookings
  sandbox reset            Empty the test environment; its keys, webhooks and plan stay
  sandbox fast-forward <minutes>
                           Make what would lapse in the test environment within that time lapse
                           now (holds, offers, approvals), then run maintenance
  sandbox race <resource-ref> [--agents <n>] [--start <date-time>]
                           Race agents (default 100) for one hour on a test resource and print who
                           booked, who was refused and why, and how long the answers took
  partner create <id> <name> --contract <json | @file>
                           Create a partner reselling Slotlock, or change its name and contract:
                           its plans (limits and quotas), its accounts' key scopes and its prices
                           (as the schema owner, SLOTLOCK_MIGRATE_DATABASE_URL)
  partner list             Print the partners, one JSON object per line
  partner suspend <id>     Suspend a partner: every account with it, and its keys stop
  partner unsuspend <id>   Make a suspended partner active again
  partner key <id> <name>  Create a partner key (slk_partner_…) and print it once
  partner revoke-key <id> <key-id>
                           Revoke one of a partner's keys at once
  partner customer <id> <cus_…>
                           The Stripe customer its monthly invoice goes to
  partner webhook <id> <https-url>
                           Where usage.period_closed goes; prints its signing secret once
  billing daily            Once a day (cron), as the schema owner: close last month for every
                           active partner once it has been over for 6 hours, report overage
                           when SLOTLOCK_OVERAGE is on (with STRIPE_SECRET_KEY), and list the
                           partners' reconciliation mismatches of the last 7 days; exits 1 when
                           anything waits or differs. Safe to run again
  overage report [--month <YYYY-MM>] [--event <name>]
                           With SLOTLOCK_OVERAGE: send Stripe each paying Developer tenant's
                           operations above its quota this month (or --month) not yet sent, as
                           Billing Meter events (--event, default slotlock_operations), once
                           (as the schema owner, with STRIPE_SECRET_KEY)
  partner close <id> [--month <YYYY-MM>]
                           Close an ended month (default: last month): price its accounts' use
                           with the contract, record the lines once, send usage.period_closed,
                           and with STRIPE_SECRET_KEY add the lines to the partner's next Stripe
                           invoice; safe to run again
  tenant status            Print whether the tenant is suspended
  tenant suspend [--reason <text>]
                           Suspend the tenant: it writes nothing, and its API keys are refused
                           and get no new secret; its dashboard still reads. One its partner
                           suspended becomes yours, which the partner cannot lift (as
                           SLOTLOCK_MIGRATE_DATABASE_URL's role when set: only the schema owner
                           suspends)
  tenant unsuspend         Lift the tenant's suspension (as the schema owner, likewise)
  tenant export [--out <dir>]
                           Print everything the tenant keeps, read at one moment, one JSON line a
                           row ({"table": ..., "row": ...}); with --out, one owner-only
                           <table>.ndjson file a table in that directory (new, or empty and
                           writable only by you). Secrets stay out
  tenant erase --confirm <tenant>
                           Delete everything the tenant has, its API keys included, for good;
                           --confirm repeats SLOTLOCK_TENANT; refused while its hosted plan is
                           paid for (cancel the subscription first)
  staff list               Print the admin console's staff (RFC 0006), as the schema owner
                           (SLOTLOCK_MIGRATE_DATABASE_URL when set), like every staff command
  staff add <github-id> <role>
                           Add a member (owner, support, billing, editor or viewer) and print
                           a one-time code for their first passkey, valid for 2 days
  staff role <github-id> <role>
                           Change a member's role
  staff reset <github-id>  Remove a member's passkeys and print a new one-time code
  staff remove <github-id> Remove a member and their passkeys (never the last owner)
  staff verify-log         Check the staff log's whole chain and print its head, to compare with
                           one recorded earlier (exit 1 when an entry does not hold)
  staff console-key        Set the admin console's key and print it once, for the console's
                           SLOTLOCK_ADMIN_CONSOLE_KEY; replacing it ends every staff session
  audit verify             Check the tenant's audit log chain: prints how many events held and
                           the first that does not (exit 1 when one does not)
  audit export             Print the tenant's audit log, newest first, one JSON object per line
  subject export (--email <address> | --holder <ref> | --contact <ref> | --reference <ref>)
                           Print what the tenant keeps about one person, one JSON line per row:
                           {"table": ..., "row": ...}, up to 10,000 rows a table
  subject erase (--email <address> | --holder <ref> | --contact <ref> | --reference <ref>)
                           Take one person out of the tenant's data: their contacts, attendee
                           and waitlist entries go; their references become an erased name;
                           bookings stay as time taken. Prints what it changed, by table
  plan status              Print the deployment's default plan and the tenant's own (hosted)
  plan default (free | developer | none) [--from <date>]
                           Put every tenant without a plan of its own on this one from --from
                           (an ISO date or time; default now), or none for no default; a new
                           tenant gets it at once (as the schema owner, like tenant suspend)
  healthcheck              Exit 0 when the local server reports ready

Options:
  -h, --help               Show this help
  -v, --version            Print the version

Environment:
  DATABASE_URL                   postgres:// URL of the role Slotlock serves as (required); serve
                                 refuses a superuser or a role with BYPASSRLS
  SLOTLOCK_MIGRATE_DATABASE_URL  postgres:// URL of the schema owner, for migrate (optional)
  SLOTLOCK_ADMIN_DATABASE_URL    postgres:// URL of the admin console's own role, which migrate
                                 grants the admin functions only (optional; Slotlock Cloud)
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
  SLOTLOCK_USAGE                 on: count each tenant's operations, bookings and holds by day, API
                                 key and surface (slotlock.usage_daily, kept 400 days); off
                                 (default): record nothing
  SLOTLOCK_QUOTAS                on (needs SLOTLOCK_USAGE=on): refuse a tenant on a plan past its
                                 operations or bookings this month (quota_exceeded, 429); off
                                 (default): no quota
  SLOTLOCK_OVERAGE               off (default), or on (300) or a percent (111-1000): a paying
                                 Developer tenant is refused only past that share of its
                                 operations, and the rest above its quota is billed (overage
                                 report); needs SLOTLOCK_QUOTAS=on
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
  SLOTLOCK_TRUSTED_PROXY_SECRET  A secret the proxy adds to every request in x-slotlock-proxy-proof,
                                 32+ random characters: without it there, the field above is
                                 ignored and the connection's address counts
  SLOTLOCK_KNOWN_CLIENTS         Comma-separated integrator names /metrics counts requests by, from
                                 their Slotlock-Client field (any other: other; none sent: none)
  OTEL_EXPORTER_OTLP_ENDPOINT    An OpenTelemetry collector (OTLP over HTTP, JSON): a span per
                                 call is sent to <endpoint>/v1/traces (off without it)
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT The full traces URL instead of <endpoint>/v1/traces
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT The full metrics URL instead of <endpoint>/v1/metrics (sent each minute)
  OTEL_EXPORTER_OTLP_HEADERS     name=value pairs sent with each export, such as an API key
  OTEL_SERVICE_NAME              service.name of the spans (default slotlock)
  SLOTLOCK_GITHUB_CLIENT_ID      Serve the dashboard at $SLOTLOCK_PUBLIC_URL/dashboard: the Client ID
                                 of a GitHub OAuth app with callback .../dashboard/callback
  SLOTLOCK_GITHUB_CLIENT_SECRET  That app's client secret (dashboard)
  SLOTLOCK_SESSION_SECRET        Signs dashboard sessions, 32+ random characters (dashboard)
  SLOTLOCK_ASSISTANT_SECRET      Turns on the dashboard assistant and seals each organization's
                                 model API key with it, 32+ random characters (dashboard; off
                                 without it)
  SLOTLOCK_ASSISTANT_PREVIOUS_SECRETS Up to three earlier SLOTLOCK_ASSISTANT_SECRET values,
                                 comma-separated, newest first: keys sealed under one still open
                                 and are sealed again under the current secret when next used
  SLOTLOCK_ASSISTANT_PRIVATE_URLS off (default): refuse an assistant model URL whose host is, or
                                 resolves to, a loopback, private, link-local, CGNAT, unique-local
                                 or metadata address; on: allow them, for a self-hosted model
                                 (Ollama, vLLM) on this machine or network
  SLOTLOCK_GOOGLE_CLIENT_ID      Sign-in with Google too: the client id of a Google OAuth client with
                                 redirect URI .../dashboard/callback (not with organization ids)
  SLOTLOCK_GOOGLE_CLIENT_SECRET  Its client secret
  SLOTLOCK_DASHBOARD_USERS       * or comma-separated GitHub user ids (and google:<subject>) that may sign in and whose keys work
  SLOTLOCK_DASHBOARD_ORGS        comma-separated GitHub organization ids: each is one shared tenant;
                                 or enabled: each person's own tenant, plus the organizations an
                                 owner turns on from the dashboard's Teams page
  SLOTLOCK_DASHBOARD_TEAM_WORKSPACES on: anyone signed in creates team workspaces and invites
                                 people to them by email, each with a role (default off; not
                                 with organization ids)
  SLOTLOCK_DASHBOARD_NAME        What the dashboard calls this deployment (default Slotlock)
  SLOTLOCK_DASHBOARD_TERMS_URL   https URL of the terms people accept by signing in, linked on the
                                 sign-in page (none named without it)
  SLOTLOCK_DASHBOARD_PRIVACY_URL https URL of the privacy notice the sign-in page links
  SLOTLOCK_INVITATION_EMAIL      resend or postmark: send team invitations by email (with team
                                 workspaces; without it, the person inviting sends the link)
  SLOTLOCK_INVITATION_EMAIL_KEY  Resend's API key, or Postmark's server token
  SLOTLOCK_INVITATION_EMAIL_FROM The sender the provider verified: team@example.com or Name <...>
  SLOTLOCK_VERIFIED_DOMAINS      on or off (default): team Owners verify their domain with a DNS
                                 record, and people at it may ask to join (with team workspaces)
  SLOTLOCK_DNS_RESOLVER          doh (default: Cloudflare, checked by Google) or system: how a
                                 verified domain's record is looked up each day
  SLOTLOCK_TEAM_SSO              on or off (default): each team signs in through its own identity
                                 provider over OpenID Connect (with verified domains)
  SLOTLOCK_SSO_SECRET            32+ characters: seals each team's client secret (with team SSO)
  SLOTLOCK_TEAM_SCIM             on or off (default): each team's identity provider provisions its
                                 people over SCIM 2.0 at /dashboard/scim/v2 (with verified domains)
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
    command === 'closures' ||
    command === 'rules' ||
    command === 'tenant' ||
    command === 'plan' ||
    command === 'partner' ||
    command === 'overage' ||
    command === 'billing' ||
    command === 'sandbox' ||
    command === 'audit' ||
    command === 'subject' ||
    command === 'staff'
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
    'resource parent': 3,
    'resource restore': 2,
    'resource delete': 2,
    'tenant status': 1,
    'tenant export': 1,
    'tenant suspend': 1,
    'tenant unsuspend': 1,
    'tenant erase': 1,
    'staff list': 1,
    'staff add': 3,
    'staff role': 3,
    'staff reset': 2,
    'staff remove': 2,
    'staff console-key': 1,
    'staff verify-log': 1,
    'plan status': 1,
    'plan default': 2,
    'key create': 2,
    'key list': 1,
    'key rotate': 2,
    'key revoke': 2,
    'key limits': 2,
    'sandbox seed': 2,
    'sandbox reset': 1,
    'sandbox fast-forward': 2,
    'sandbox race': 2,
    'hours show': 1,
    'hours set': 2,
    'hours clear': 1,
    'closures list': 1,
    'closures add': 2,
    'closures delete': 2,
    'closures import': 2,
    'rules set': 2,
    'rules clear': 1,
    'partner create': 3,
    'partner list': 1,
    'partner suspend': 2,
    'partner unsuspend': 2,
    'partner key': 3,
    'partner revoke-key': 3,
    'partner customer': 3,
    'partner webhook': 3,
    'partner close': 2,
    'overage report': 1,
    'billing daily': 1,
    'audit verify': 1,
    'audit export': 1,
    'subject export': 1,
    'subject erase': 1,
  };
  // closures add takes a last day or not.
  const expected =
    subcommand === 'closures add' && operands.length === 3 ? 3 : expectedOperands[subcommand];
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
  if (values.month !== undefined && subcommand !== 'partner close' && subcommand !== 'overage report') {
    return usage('--month applies only to partner close and overage report');
  }
  if (values.event !== undefined && subcommand !== 'overage report') {
    return usage('--event applies only to overage report');
  }
  if (values.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(values.month)) {
    return usage('--month must be a month, like 2026-10');
  }
  if (values.contract !== undefined && subcommand !== 'partner create') {
    return usage('--contract applies only to partner create');
  }
  if (subcommand === 'partner create' && values.contract === undefined) {
    return usage('partner create needs --contract <json>, or --contract @<file>');
  }
  if (values.reason !== undefined && subcommand !== 'tenant suspend') {
    return usage('--reason applies only to tenant suspend');
  }
  if (values.confirm !== undefined && subcommand !== 'tenant erase') {
    return usage('--confirm applies only to tenant erase');
  }
  if (values.from !== undefined && subcommand !== 'plan default') {
    return usage('--from applies only to plan default');
  }
  let planDefault: { plan: SlotlockPlan; appliesFrom: Date } | null = null;
  if (subcommand === 'plan default') {
    const named = operands[1];
    if (named !== 'free' && named !== 'developer' && named !== 'none') {
      return usage('plan default takes free, developer or none');
    }
    if (named === 'none' && values.from !== undefined) return usage('--from applies only to a plan');
    const appliesFrom = values.from === undefined ? new Date() : new Date(values.from);
    if (Number.isNaN(appliesFrom.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(values.from ?? '2000-01-01')) {
      return usage('--from must be an ISO date or time, like 2026-12-09 or 2026-12-09T00:00:00Z');
    }
    if (named !== 'none') planDefault = { plan: named, appliesFrom };
  }
  const subjectOptions = (['email', 'holder', 'contact', 'reference'] as const).filter(
    (option) => values[option] !== undefined,
  );
  if (subjectOptions.length > 0 && !subcommand.startsWith('subject ')) {
    return usage('--email, --holder, --contact and --reference apply only to subject export and subject erase');
  }
  if (subcommand.startsWith('subject ') && subjectOptions.length !== 1) {
    return usage(`${subcommand} needs exactly one of --email, --holder, --contact or --reference`);
  }
  if (values.out !== undefined && subcommand !== 'tenant export') return usage('--out applies only to tenant export');
  if (subcommand === 'tenant erase' && values.confirm === undefined) {
    return usage('tenant erase needs --confirm <tenant>, the tenant it erases (SLOTLOCK_TENANT)');
  }
  if (values.all && subcommand !== 'hours set' && subcommand !== 'hours clear') {
    return usage('--all applies only to hours set and hours clear');
  }
  if (values.override && subcommand !== 'hours set') return usage('--override applies only to hours set --all');
  if (values.matching && subcommand !== 'hours set') return usage('--matching applies only to hours set --all');
  if (values.override && values.matching) return usage('--override and --matching: give one');
  if (
    values.resource !== undefined &&
    !subcommand.startsWith('hours ') &&
    !subcommand.startsWith('rules ') &&
    !subcommand.startsWith('closures ')
  ) {
    return usage('--resource applies only to hours, closures and rules commands');
  }
  if (values.location !== undefined && !subcommand.startsWith('hours ') && !subcommand.startsWith('closures ')) {
    return usage('--location applies only to hours and closures commands');
  }
  if (values.label !== undefined && subcommand !== 'closures add' && subcommand !== 'closures import') {
    return usage('--label applies only to closures add and closures import');
  }
  if (values.open !== undefined && subcommand !== 'closures add') {
    return usage('--open applies only to closures add');
  }
  if (subcommand.startsWith('closures ') && values.resource !== undefined && values.location !== undefined) {
    return usage(`${subcommand} takes --resource or --location, not both`);
  }
  if (subcommand === 'closures add' && (operands.length < 2 || operands.length > 3 || values.label === undefined)) {
    return usage('closures add needs <first-day> [<last-day>] --label <text>');
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
    [values.resource !== undefined, values.location !== undefined, values.all === true].filter(Boolean).length !== 1
  ) {
    return usage(`${subcommand} needs --resource <ref>, --location <ref> or --all, one of them`);
  }
  if (values.override && values.all !== true) return usage('--override applies only to hours set --all');
  if (values.matching && values.all !== true) return usage('--matching applies only to hours set --all');
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
  let keyResourceScope: SlotlockResourceScope | undefined;
  let keyLimits: SlotlockApiKeyLimits = {};
  if (subcommand === 'key create') {
    try {
      keyScopes = parseKeyScopes(values.scope);
      keyLifetimeDays = parseKeyLifetime(values['expires-in-days']);
      keyResourceScope = parseKeyResourceScope(values.locations, values.groups);
    } catch (error) {
      return usage((error as Error).message);
    }
  } else if (values.locations !== undefined || values.groups !== undefined) {
    return usage('--locations and --groups are for key create');
  }
  if ((values.agents !== undefined || values.start !== undefined) && subcommand !== 'sandbox race') {
    return usage('--agents and --start apply only to sandbox race');
  }
  const limitOptions = ['max-holds', 'max-held-hours', 'requests-per-minute', 'requires-approval'] as const;
  if (subcommand === 'key create' || subcommand === 'key limits') {
    try {
      keyLimits = parseKeyLimits(values);
    } catch (error) {
      return usage((error as Error).message);
    }
  } else if (limitOptions.some((option) => values[option] !== undefined)) {
    return usage('--max-holds, --max-held-hours, --requests-per-minute and --requires-approval are for key create and key limits');
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
      case 'sandbox seed':
      case 'sandbox reset':
      case 'sandbox fast-forward':
      case 'sandbox race':
        return await runSandboxCommand(subcommand, operands, values, io);
      case 'resource add': {
        const config = readSlotlockDatabaseConfig(io.env);
        const resource = await addResource(config, operands[1] as string, values.timezone ?? 'UTC');
        io.stdout.write(resourceLine(resource));
        return 0;
      }
      case 'resource list':
        await listResources(readSlotlockDatabaseConfig(io.env), io.stdout);
        return 0;
      case 'billing daily': {
        const database = readSlotlockDatabaseConfig(io.env);
        const owner = connect(database.migrateDatabaseUrl ?? database.databaseUrl, 1);
        try {
          return await runBillingDaily(owner, io, {
            now: Date.now(),
            stripeSecretKey: io.env.STRIPE_SECRET_KEY?.trim() || undefined,
            overage: (io.env.SLOTLOCK_OVERAGE?.trim() || 'off') !== 'off',
          });
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === '42501') {
            io.stderr.write('slotlock: only the schema owner runs billing; set SLOTLOCK_MIGRATE_DATABASE_URL to its URL\n');
            return 1;
          }
          throw error;
        } finally {
          await owner.end({ timeout: 5 });
        }
      }
      case 'overage report': {
        const secretKey = io.env.STRIPE_SECRET_KEY?.trim();
        if (!secretKey) {
          io.stderr.write('slotlock: overage report needs STRIPE_SECRET_KEY, with write access to meter events\n');
          return 1;
        }
        const database = readSlotlockDatabaseConfig(io.env);
        const owner = connect(database.migrateDatabaseUrl ?? database.databaseUrl, 1);
        const started = Date.now();
        try {
          const report = await reportSlotlockOverage(owner, {
            month: values.month ?? slotlockMonthOf(Date.now()),
            stripe: { secretKey, eventName: values.event ?? 'slotlock_operations' },
          });
          const summary = { month: report.month, tenants: report.tenants.length, sent: report.sent, failed: report.failed };
          io.stdout.write(`${JSON.stringify(summary)}\n`);
          await recordMaintenanceRun(owner, 'overage_report', started, report.failed > 0, summary);
          if (report.failed > 0) {
            io.stderr.write('slotlock: Stripe did not take some events; run overage report again\n');
            return 1;
          }
          return 0;
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === 'invalid_meter_event' || code === 'invalid_month') {
            io.stderr.write(`slotlock: ${(error as Error).message}\n`);
            return 2;
          }
          if (code === '42501') {
            io.stderr.write('slotlock: only the schema owner reports overage; set SLOTLOCK_MIGRATE_DATABASE_URL to its URL\n');
            return 1;
          }
          throw error;
        } finally {
          await owner.end({ timeout: 5 });
        }
      }
      case 'resource parent': {
        const changed = await setResourceParent(
          readSlotlockDatabaseConfig(io.env),
          io.stdout,
          operands[1] as string,
          operands[2] as string,
        );
        if (changed === true) return 0;
        io.stderr.write(
          `slotlock: ${
            changed === false
              ? 'no resource with that reference or id in this tenant'
              : changed === 'parent_not_found'
                ? 'no parent resource with that reference or id in this tenant'
                : changed === 'composite_busy'
                  ? 'one side has a booking or live hold still to come; a composite changes only while neither does'
                  : changed === 'composite_too_deep'
                    ? 'composites are one level deep: a part has no parts, and a parent is no part'
                    : 'a composite has at most 50 parts'
          }\n`,
        );
        return 1;
      }
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
      case 'staff list':
      case 'staff add':
      case 'staff role':
      case 'staff reset':
      case 'staff remove':
      case 'staff console-key':
      case 'staff verify-log': {
        const action = subcommand.slice('staff '.length) as 'list' | 'add' | 'role' | 'reset' | 'remove' | 'console-key' | 'verify-log';
        const staffRef = action === 'list' || action === 'console-key' || action === 'verify-log' ? null : readStaffRef(operands[1]);
        if (action !== 'list' && action !== 'console-key' && action !== 'verify-log' && staffRef === null) {
          return usage('<github-id> must be a GitHub account id (a number, or github:<number>)');
        }
        const role = action === 'add' || action === 'role' ? operands[2] : undefined;
        if (role !== undefined && !(SLOTLOCK_STAFF_ROLES as readonly string[]).includes(role)) {
          return usage(`<role> must be one of ${SLOTLOCK_STAFF_ROLES.join(', ')}`);
        }
        let status: number;
        try {
          status = await runStaffCommand(readSlotlockDatabaseConfig(io.env), io.stdout, action, staffRef, role);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === '42501' || code === '42883') {
            io.stderr.write(
              'slotlock: only the schema owner manages staff; set SLOTLOCK_MIGRATE_DATABASE_URL to its URL\n',
            );
            return 1;
          }
          if (code === 'P0002') {
            io.stderr.write('slotlock: no active staff member with that GitHub id\n');
            return 1;
          }
          if (code === '23514') {
            io.stderr.write('slotlock: the last owner cannot be removed; add another owner first\n');
            return 1;
          }
          throw error;
        }
        return status;
      }
      case 'tenant export':
        return runTenantExport(readSlotlockDatabaseConfig(io.env), io, values.out);
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
          if (code === 'billing_active') {
            io.stderr.write(
              'slotlock: the tenant has a live subscription; cancel it in Stripe first (its webhook moves the tenant to Free), then erase\n',
            );
            return 1;
          }
          throw error;
        }
        return 0;
      }
      case 'partner create':
      case 'partner list':
      case 'partner suspend':
      case 'partner unsuspend':
      case 'partner key':
      case 'partner revoke-key':
      case 'partner customer':
      case 'partner webhook':
      case 'partner close': {
        try {
          return await runPartnerCommand(
            readSlotlockDatabaseConfig(io.env),
            io,
            subcommand.slice('partner '.length),
            operands.slice(1),
            values.contract,
            { month: values.month, stripeSecretKey: io.env.STRIPE_SECRET_KEY?.trim() || undefined },
          );
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          if (code === 'partner_not_found') {
            io.stderr.write('slotlock: no partner with that id\n');
            return 1;
          }
          if (code === 'invalid_partner_contract' || code === 'invalid_partner' || code === 'month_not_ended' || code === 'invalid_month') {
            io.stderr.write(`slotlock: ${(error as Error).message}\n`);
            return 2;
          }
          if (code === '42501') {
            io.stderr.write('slotlock: only the schema owner runs partner commands; set SLOTLOCK_MIGRATE_DATABASE_URL to its URL\n');
            return 1;
          }
          throw error;
        }
      }
      case 'plan status':
      case 'plan default': {
        try {
          await runPlanCommand(readSlotlockDatabaseConfig(io.env), io.stdout, planDefault, subcommand === 'plan default');
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === 'plan_default_not_permitted') {
            io.stderr.write(
              'slotlock: only the schema owner sets the default plan; set SLOTLOCK_MIGRATE_DATABASE_URL to its URL\n',
            );
            return 1;
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
            : values.location !== undefined
              ? { location: values.location }
              : values.resource !== undefined
                ? { resource: values.resource }
                : 'show';
        const found = await runHours(
          readSlotlockDatabaseConfig(io.env),
          io.stdout,
          target,
          subcommand === 'hours show' ? undefined : hours,
          values.override === true ? 'all' : values.matching === true ? 'matching' : 'none',
        );
        if (!found) {
          io.stderr.write(
            values.location !== undefined
              ? 'slotlock: no location with that reference in this tenant\n'
              : 'slotlock: no resource with that reference or id in this tenant\n',
          );
          return 1;
        }
        return 0;
      }
      case 'audit verify':
      case 'audit export':
        return runAudit(readSlotlockDatabaseConfig(io.env), io, subcommand);
      case 'subject export':
      case 'subject erase': {
        const option = subjectOptions[0] as 'email' | 'holder' | 'contact' | 'reference';
        return runSubject(readSlotlockDatabaseConfig(io.env), io, subcommand, {
          [option]: values[option] as string,
        } as SlotlockSubject);
      }
      case 'closures list':
      case 'closures add':
      case 'closures delete':
      case 'closures import':
        return runClosures(readSlotlockDatabaseConfig(io.env), io, subcommand, operands.slice(1), {
          ...(values.resource !== undefined ? { resource: values.resource } : {}),
          ...(values.location !== undefined ? { location: values.location } : {}),
          ...(values.label !== undefined ? { label: values.label } : {}),
          ...(values.open !== undefined ? { open: values.open } : {}),
        });
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
            ...(keyResourceScope ? { resourceScope: keyResourceScope } : {}),
            ...(Object.keys(keyLimits).length > 0 ? { limits: keyLimits } : {}),
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
          keys.rotate({ tenantRef: config.tenantRef, id: operands[1] as string, actor: CLI_KEY_CREATOR }),
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
      case 'key limits': {
        const config = readSlotlockDatabaseConfig(io.env);
        const id = operands[1] as string;
        const set = await withApiKeys(config, (keys) =>
          keys.setLimits({ tenantRef: config.tenantRef, id, limits: keyLimits }),
        );
        if (!set) {
          io.stderr.write('slotlock: no active API key with that id in this tenant\n');
          return 1;
        }
        io.stdout.write(`${JSON.stringify({ id, limits: apiKeyLimitsJson(keyLimits) })}\n`);
        return 0;
      }
      case 'key revoke': {
        const config = readSlotlockDatabaseConfig(io.env);
        const revoked = await withApiKeys(config, (keys) =>
          keys.revoke({ tenantRef: config.tenantRef, id: operands[1] as string, actor: CLI_KEY_CREATOR }),
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
      locations: { type: 'string' },
      groups: { type: 'string' },
      'max-holds': { type: 'string' },
      'max-held-hours': { type: 'string' },
      'requests-per-minute': { type: 'string' },
      'requires-approval': { type: 'boolean' },
      agents: { type: 'string' },
      start: { type: 'string' },
      contract: { type: 'string' },
      month: { type: 'string' },
      event: { type: 'string' },
      resource: { type: 'string' },
      location: { type: 'string' },
      all: { type: 'boolean' },
      override: { type: 'boolean' },
      matching: { type: 'boolean' },
      label: { type: 'string' },
      open: { type: 'string' },
      reason: { type: 'string' },
      confirm: { type: 'string' },
      out: { type: 'string' },
      email: { type: 'string' },
      holder: { type: 'string' },
      contact: { type: 'string' },
      reference: { type: 'string' },
      from: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}
