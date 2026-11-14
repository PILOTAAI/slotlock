// The dashboard (src/dashboard.ts) as a Cloudflare Worker: GitHub sign-in, and the API keys and
// resources of each person's tenant, served from its own origin (SLOTLOCK_PUBLIC_URL) while the
// server agents use runs elsewhere (SLOTLOCK_SERVICE_URL). It reaches Postgres through Hyperdrive
// with caching off: a sign-in, a sent form and a sign-out are recorded and read back at once.
//
// A Worker may not use a database client from another request, so each request opens its own
// (Hyperdrive keeps the connections). The dashboard is built once per isolate, like one
// `slotlock serve` process, and reaches the request's client through AsyncLocalStorage, so its
// limit on sign-ins in flight holds across the requests that isolate serves. Workers run many
// isolates, so three rate limiting bindings bound the requests of all of them together.
import { AsyncLocalStorage } from 'node:async_hooks';
import postgres from 'postgres';
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentOperation,
  type SlotlockAgentPrincipal,
  type SlotlockAgentUsage,
  slotlockAgentOperationScope,
} from '../../src/agent-server.js';
import { createSlotlockStoreAgentBackend } from '../../src/agent-store-backend.js';
import { type SlotlockApiKeyStore, createSlotlockApiKeyStore } from '../../src/api-keys.js';
import {
  SlotlockConfigError,
  type SlotlockEnv,
  readAvailability,
  readDashboardConfig,
  readLimits,
  readServerUrl,
} from '../../src/config.js';
import {
  type SlotlockDashboard,
  type SlotlockDashboardResources,
  type SlotlockDashboardState,
  createSlotlockDashboard,
  createSlotlockDashboardResources,
  createSlotlockDashboardState,
} from '../../src/dashboard.js';
import {
  createSlotlockStripe,
  handleSlotlockStripeWebhook,
  type SlotlockStripe,
} from '../../src/billing.js';
import { enrolSlotlockTenantPlan, readSlotlockPlanDefault,
  readSlotlockTenantPlan, readSlotlockTenantQuotas } from '../../src/plans.js';
import {
  type SlotlockQuotas,
  createSlotlockQuotas,
  noteSlotlockQuotaThreshold,
  readSlotlockQuotaUse,
  slotlockQuotaRefusal,
} from '../../src/quotas.js';
import {
  type SlotlockUsageMeter,
  createSlotlockUsageMeter,
  recordSlotlockUsage,
} from '../../src/usage.js';
import {
  createSlotlockRateLimiter,
  slotlockClientKey,
  slotlockClientNetwork,
} from '../../src/rate-limit.js';
import { createSlotlockStore } from '../../src/store.js';
import { createSlotlockDashboardTeams } from '../../src/teams.js';
import { createSlotlockInvitationEmailSender } from '../../src/invitation-email.js';
import { slotlockDomainResolvers } from '../../src/domains.js';
import { createSlotlockSecretBox } from '../../src/oidc.js';
import type { SlotlockWorkspaceDomains } from '../../src/workspace-domains.js';
import type { SlotlockWorkspaceSso } from '../../src/workspace-sso.js';
import type { SlotlockWorkspaceScim } from '../../src/workspace-scim.js';
import {
  type SlotlockDashboardSessions,
  type SlotlockDashboardWorkspaces,
  type SlotlockWorkspaceTeams,
  createSlotlockDashboardWorkspaces,
} from '../../src/workspaces.js';
import { SLOTLOCK_DEFAULT_OVERAGE_STOP_PERCENT } from '../../src/overage.js';

/**
 * A Workers rate limiting binding (developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit,
 * read 2026-10-18). Its counts are per Cloudflare location and eventually consistent: it bounds a
 * flood, it is not an exact quota.
 */
export interface SlotlockRateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** What wrangler.jsonc and `wrangler secret put` give the Worker. */
export interface SlotlockDashboardWorkerEnv {
  HYPERDRIVE: { connectionString: string };
  /** Every dashboard request, counted per client (see clientOf). */
  SLOTLOCK_CLIENT_RATE_LIMIT?: SlotlockRateLimit;
  /** GitHub sign-ins and their callbacks, counted per client network (slotlockClientNetwork). */
  SLOTLOCK_SIGN_IN_RATE_LIMIT?: SlotlockRateLimit;
  /**
   * GitHub sign-ins and their callbacks, counted for every client together: a ceiling well above one
   * client's limit, so a few clients cannot use it up for everyone. Without it, a configuration
   * from before it existed, SLOTLOCK_SIGN_IN_RATE_LIMIT counts every client together instead, as it
   * did then, and the Worker logs a warning.
   */
  SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT?: SlotlockRateLimit;
  /**
   * SCIM calls from teams' identity providers, counted per client instead of in
   * SLOTLOCK_CLIENT_RATE_LIMIT: a provider calls from addresses its other customers share, so in the
   * dashboard's budget one team's sync would use up another's. Without it, with SCIM on, SCIM is
   * counted in SLOTLOCK_CLIENT_RATE_LIMIT, as it was, and the Worker logs a warning.
   */
  SLOTLOCK_SCIM_RATE_LIMIT?: SlotlockRateLimit;
  [name: string]: unknown;
}

/** The part of a Worker's ExecutionContext the dashboard uses. */
export interface SlotlockDashboardWorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface SlotlockDashboardWorkerOptions {
  /** Reaches GitHub; a test passes a fake. */
  fetch?: typeof fetch;
}

interface RequestScope {
  sql: ReturnType<typeof postgres>;
  keys: SlotlockApiKeyStore;
  /** The assistant's agent backend, on the request's own client. */
  agent: SlotlockAgentCalendarBackend;
  /** Agent operations this request has run, for the per-request cap. */
  agentCalls: { count: number };
  /** The assistant's operations this request ran, recorded as it ends (SLOTLOCK_USAGE=on). */
  usage: SlotlockUsageMeter | null;
  /** The tenant's monthly quotas, read for this request (SLOTLOCK_QUOTAS=on). */
  quotas: SlotlockQuotas | null;
  resources: SlotlockDashboardResources;
  state: SlotlockDashboardState;
  /** Who belongs to which workspace, as what, read for each request (workspaces.ts). */
  workspaces: SlotlockDashboardWorkspaces;
}

/** Agent operations (the assistant's reads and approved writes) one dashboard request may run. */
export const SLOTLOCK_WORKER_AGENT_CALLS_PER_REQUEST = 24;

/**
 * The assistant's agent limits on a Worker, which has no `slotlock serve` in front: at most
 * SLOTLOCK_WORKER_AGENT_CALLS_PER_REQUEST operations a request, and the tenant read and write
 * budgets of SLOTLOCK_LIMITS (`tenant_read`, `tenant_write`) as token buckets in this isolate.
 * Workers run many isolates, so a tenant's budget is per isolate; the client rate limit binding
 * bounds the requests themselves.
 */
export function createSlotlockWorkerAgentLimiter(vars: SlotlockEnv) {
  const { rates } = readLimits(vars);
  const reads = rates.tenant_read ? createSlotlockRateLimiter(rates.tenant_read) : null;
  const writes = rates.tenant_write ? createSlotlockRateLimiter(rates.tenant_write) : null;
  return (
    calls: { count: number },
    args: { principal: SlotlockAgentPrincipal; operation: SlotlockAgentOperation },
  ): boolean => {
    calls.count += 1;
    if (calls.count > SLOTLOCK_WORKER_AGENT_CALLS_PER_REQUEST) return false;
    const bucket = slotlockAgentOperationScope(args.operation) === 'write' ? writes : reads;
    return bucket ? bucket.take(args.principal.tenantRef) : true;
  };
}

/** SLOTLOCK_USAGE: on to record the assistant's operations in each tenant's usage, as serve does. */
function readWorkerUsage(vars: SlotlockEnv): boolean {
  const value = vars.SLOTLOCK_USAGE?.trim() || 'off';
  if (value !== 'on' && value !== 'off') throw new SlotlockConfigError('SLOTLOCK_USAGE must be on or off');
  return value === 'on';
}

/** SLOTLOCK_QUOTAS: on to hold the assistant's operations to each tenant's quotas, as serve does. */
function readWorkerQuotas(vars: SlotlockEnv, usage: boolean): boolean {
  const value = vars.SLOTLOCK_QUOTAS?.trim() || 'off';
  if (value !== 'on' && value !== 'off') throw new SlotlockConfigError('SLOTLOCK_QUOTAS must be on or off');
  if (value === 'on' && !usage) {
    throw new SlotlockConfigError(
      'SLOTLOCK_QUOTAS=on needs SLOTLOCK_USAGE=on: a quota is held against the usage it counts',
    );
  }
  return value === 'on';
}

/** Where Talk to the founder goes without SLOTLOCK_PLAN_CONTACT: the founder's Pylota address (MAINTAINERS.md). */
export const SLOTLOCK_DEFAULT_PLAN_CONTACT = 'mailto:clever.eziogor@pylota.io';

/**
 * Hosted plans and Stripe billing, on when STRIPE_SECRET_KEY and both price ids are set:
 * SLOTLOCK_STRIPE_PRICE_MONTHLY and SLOTLOCK_STRIPE_PRICE_YEARLY (the Developer plan's), and
 * STRIPE_WEBHOOK_SECRET for the webhook at `<base>/stripe/webhook`. The plan a tenant without one of
 * its own is on is the database's (`slotlock plan default`), so both servers apply the same one; a
 * new tenant is put on it before it adds a key, resource or webhook endpoint.
 */
/** SLOTLOCK_OVERAGE on the Worker, as on serve: off, on (300), or a stop percent of 111-1000. */
function readWorkerOverage(vars: SlotlockEnv): number | undefined {
  const value = vars.SLOTLOCK_OVERAGE?.trim() || 'off';
  if (value === 'off') return undefined;
  const percent = value === 'on' ? SLOTLOCK_DEFAULT_OVERAGE_STOP_PERCENT : Number(value);
  if (!Number.isSafeInteger(percent) || percent < 111 || percent > 1_000) {
    throw new SlotlockConfigError('SLOTLOCK_OVERAGE must be off, on, or a percent of 111-1000');
  }
  return percent;
}

function readBilling(vars: SlotlockEnv) {
  const secretKey = vars.STRIPE_SECRET_KEY?.trim();
  const month = vars.SLOTLOCK_STRIPE_PRICE_MONTHLY?.trim();
  const year = vars.SLOTLOCK_STRIPE_PRICE_YEARLY?.trim();
  if (!secretKey || !month || !year) return null;
  // Without the webhook's secret, a payment never reaches the dashboard: the buyer would be charged
  // and stay on Free. Billing is all or nothing.
  const webhookSecret = vars.STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) {
    throw new SlotlockConfigError(
      'Stripe billing needs STRIPE_WEBHOOK_SECRET, the signing secret of the webhook endpoint at <SLOTLOCK_PUBLIC_URL>/stripe/webhook',
    );
  }
  // Each plan's customer portal configuration (bpc_…), from scripts/configure-stripe.mjs.
  const portalConfigurations: Partial<Record<'developer' | 'team', string>> = {};
  for (const [plan, name] of [
    ['developer', 'SLOTLOCK_STRIPE_PORTAL_DEVELOPER'],
    ['team', 'SLOTLOCK_STRIPE_PORTAL_TEAM'],
  ] as const) {
    const value = vars[name]?.trim();
    if (!value) continue;
    if (!/^bpc_[A-Za-z0-9]{1,250}$/.test(value)) throw new SlotlockConfigError(`${name} must be a portal configuration id (bpc_…)`);
    portalConfigurations[plan] = value;
  }
  // The Worker no longer reads it: a deployment that still sets it would believe it does.
  if (vars.SLOTLOCK_FREE_PLAN_FROM?.trim()) {
    throw new SlotlockConfigError(
      'SLOTLOCK_FREE_PLAN_FROM is replaced by the database default plan: remove it and run slotlock plan default free --from <date> as the schema owner',
    );
  }
  const apiVersion = vars.STRIPE_API_VERSION?.trim();
  // The Team plan (Teams on Cloud): an organization's checkout, once the owner has made its prices.
  const teamMonth = vars.SLOTLOCK_STRIPE_PRICE_TEAM_MONTHLY?.trim();
  const teamYear = vars.SLOTLOCK_STRIPE_PRICE_TEAM_YEARLY?.trim();
  const teamShownMonth = vars.SLOTLOCK_PLAN_PRICE_TEAM_MONTHLY?.trim();
  const teamShownYear = vars.SLOTLOCK_PLAN_PRICE_TEAM_YEARLY?.trim();
  if (Boolean(teamMonth) !== Boolean(teamYear)) {
    throw new SlotlockConfigError(
      'the Team plan needs SLOTLOCK_STRIPE_PRICE_TEAM_MONTHLY and SLOTLOCK_STRIPE_PRICE_TEAM_YEARLY together',
    );
  }
  const teamPrices = teamMonth && teamYear ? { month: teamMonth, year: teamYear } : undefined;
  // Metered overage (overage.ts): off unless SLOTLOCK_OVERAGE is on and its metered price is set.
  const overage = readWorkerOverage(vars);
  const overagePrice = vars.SLOTLOCK_STRIPE_PRICE_OVERAGE?.trim();
  if (overage !== undefined && !overagePrice) {
    throw new SlotlockConfigError('SLOTLOCK_OVERAGE needs SLOTLOCK_STRIPE_PRICE_OVERAGE, the metered price overage is billed at');
  }
  return {
    stripe: createSlotlockStripe({
      secretKey,
      prices: { month, year },
      ...(teamPrices ? { teamPrices } : {}),
      ...(Object.keys(portalConfigurations).length ? { portalConfigurations } : {}),
      ...(overage !== undefined && overagePrice ? { overagePrice } : {}),
      ...(apiVersion ? { apiVersion } : {}),
    }),
    // As the Terms and the hosted page name them, unless the deployment shows its own.
    ...(teamPrices ? { teamPrices: { month: teamShownMonth || '£15', year: teamShownYear || '£150' } } : {}),
    ...(overage !== undefined
      ? { overage: { price: vars.SLOTLOCK_PLAN_PRICE_OVERAGE?.trim() || 'the metered price', stopPercent: overage } }
      : {}),
    webhookSecret,
    contact: vars.SLOTLOCK_PLAN_CONTACT?.trim() || SLOTLOCK_DEFAULT_PLAN_CONTACT,
    prices: {
      month: vars.SLOTLOCK_PLAN_PRICE_MONTHLY?.trim() || '£5',
      year: vars.SLOTLOCK_PLAN_PRICE_YEARLY?.trim() || '£50',
    },
  };
}

/** Connections one request may hold: a Worker may have six open at once. */
const MAX_CONNECTIONS = 5;

/** An object whose every method is that of the current request's own. */
function perRequest<T extends object>(current: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const target = current();
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The membership store through the request's client, its team workspaces, sessions and domains too:
 * the dashboard reads `teams`, `sessions` and `domains` once, as it is built, outside any request.
 */
function perRequestWorkspaces(current: () => SlotlockDashboardWorkspaces): SlotlockDashboardWorkspaces {
  const teams = perRequest(() => current().teams as SlotlockWorkspaceTeams);
  const sessions = perRequest(() => current().sessions as SlotlockDashboardSessions);
  const domains = perRequest(() => current().domains as SlotlockWorkspaceDomains);
  const sso = perRequest(() => current().sso as SlotlockWorkspaceSso);
  const scim = perRequest(() => current().scim as SlotlockWorkspaceScim);
  return new Proxy({} as SlotlockDashboardWorkspaces, {
    get(_target, property) {
      if (property === 'teams') return teams;
      if (property === 'sessions') return sessions;
      if (property === 'domains') return domains;
      if (property === 'sso') return sso;
      if (property === 'scim') return scim;
      const target = current();
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * The client a request is counted as: CF-Connecting-IP, which Cloudflare sets itself, keyed as
 * `slotlock serve` keys an address, so an IPv6 client is its whole /64 and rotating the rest of its
 * address buys it no new budget. Undefined without a valid address.
 */
function clientOf(request: Request): string | undefined {
  return slotlockClientKey(request.headers.get('cf-connecting-ip') ?? '') ?? undefined;
}

function isRateLimit(value: unknown): value is SlotlockRateLimit {
  return typeof (value as SlotlockRateLimit | undefined)?.limit === 'function';
}

function tooManyRequests(): Response {
  return new Response('Too many requests. Try again in a minute.', {
    status: 429,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' },
  });
}

/** The Worker's variables and secrets, the text ones only, as the configuration readers take them. */
function variables(env: SlotlockDashboardWorkerEnv): SlotlockEnv {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export function createSlotlockDashboardWorker(options: SlotlockDashboardWorkerOptions = {}) {
  const scope = new AsyncLocalStorage<RequestScope>();
  const current = () => {
    const found = scope.getStore();
    if (!found) throw new Error('The Slotlock dashboard was used outside a request');
    return found;
  };
  let built:
    | {
        dashboard: SlotlockDashboard;
        root: string;
        availability: ReturnType<typeof readAvailability>;
        signInPaths: Set<string>;
        /** `<dashboard path>/scim/v2/` with SCIM on, counted in limits.scim; null with it off. */
        scimPrefix: string | null;
        stripeWebhook: { path: string; secret: string; stripe: SlotlockStripe } | null;
        /** SLOTLOCK_USAGE=on: the assistant's operations are recorded (usage.ts). */
        usage: boolean;
        /** SLOTLOCK_QUOTAS=on: the assistant's operations are held to the tenant's quotas. */
        quotas: boolean;
        overageStopPercent: number | undefined;
        limits: {
          client: SlotlockRateLimit;
          signIn: SlotlockRateLimit;
          signInCeiling: SlotlockRateLimit | null;
          scim: SlotlockRateLimit | null;
        };
      }
    | undefined;

  function build(env: SlotlockDashboardWorkerEnv) {
    // A sign-in costs a database write and a request to GitHub under the app's client secret, and
    // anyone may start one, while the limit on sign-ins in flight is one isolate's and Workers run
    // many: without these bindings nothing bounds them all together, so the Worker does not serve.
    const client = env.SLOTLOCK_CLIENT_RATE_LIMIT;
    const signIn = env.SLOTLOCK_SIGN_IN_RATE_LIMIT;
    const ceiling = env.SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT;
    if (!isRateLimit(client) || !isRateLimit(signIn)) {
      throw new SlotlockConfigError(
        'the SLOTLOCK_CLIENT_RATE_LIMIT and SLOTLOCK_SIGN_IN_RATE_LIMIT rate limiting bindings are required',
      );
    }
    const signInCeiling = isRateLimit(ceiling) ? ceiling : null;
    if (!signInCeiling) {
      console.warn(
        JSON.stringify({
          message:
            'slotlock dashboard sign-ins share one budget for every client: add the SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT rate limiting binding to limit them per client',
        }),
      );
    }
    const vars = variables(env);
    const publicUrl = readServerUrl(vars, 'SLOTLOCK_PUBLIC_URL');
    const serviceUrl = readServerUrl(vars, 'SLOTLOCK_SERVICE_URL');
    const config = readDashboardConfig(vars);
    if (config?.verifiedDomains?.resolver === 'system') {
      throw new SlotlockConfigError('SLOTLOCK_DNS_RESOLVER=system needs a server: a Worker looks domains up over DNS-over-HTTPS (doh)');
    }
    if (config === undefined) {
      throw new SlotlockConfigError(
        'SLOTLOCK_GITHUB_CLIENT_ID, SLOTLOCK_GITHUB_CLIENT_SECRET, SLOTLOCK_SESSION_SECRET and SLOTLOCK_DASHBOARD_USERS are required',
      );
    }
    const scim = isRateLimit(env.SLOTLOCK_SCIM_RATE_LIMIT) ? env.SLOTLOCK_SCIM_RATE_LIMIT : null;
    if (config.teamScim && !scim) {
      console.warn(
        JSON.stringify({
          message:
            "slotlock dashboard SCIM calls share each client's dashboard budget: add the SLOTLOCK_SCIM_RATE_LIMIT rate limiting binding to count them apart",
        }),
      );
    }
    if (typeof env.HYPERDRIVE?.connectionString !== 'string') {
      throw new SlotlockConfigError('the HYPERDRIVE binding is required');
    }
    const agentLimiter = createSlotlockWorkerAgentLimiter(vars);
    const billing = readBilling(vars);
    const planContact = billing?.contact ?? (vars.SLOTLOCK_PLAN_CONTACT?.trim() || undefined);
    const metering = readWorkerUsage(vars);
    const quotaMode = readWorkerQuotas(vars, metering);
    // Read once, with the rest of the configuration: a bad value stops the build, not a request.
    const overageStopPercent = readWorkerOverage(vars);
    const dashboard = createSlotlockDashboard({
      publicUrl,
      serviceUrl,
      github: { clientId: config.githubClientId, clientSecret: config.githubClientSecret },
      sessionSecret: config.sessionSecret,
      allowedUsers: config.allowedUsers,
      ...(config.google ? { google: config.google } : {}),
      ...(config.organizations ? { organizations: config.organizations } : {}),
      // Teams on Cloud: the organizations turned on, through the request's client.
      ...(config.organizations === 'enabled'
        ? {
            teams: {
              enabled: (ids: readonly string[]) => createSlotlockDashboardTeams(current().sql).enabled(ids),
              enable: (org: { id: string; login: string }, by: string) =>
                createSlotlockDashboardTeams(current().sql).enable(org, by),
              disable: (id: string, by: string) => createSlotlockDashboardTeams(current().sql).disable(id, by),
            },
          }
        : {}),
      ...(config.name ? { name: config.name } : {}),
      ...(config.termsUrl ? { termsUrl: config.termsUrl } : {}),
      ...(config.teamWorkspaces ? { teamWorkspaces: true } : {}),
      // Verified domains: an Owner's "Verify now" asks DNS over HTTPS, the one way a Worker reaches
      // DNS; the daily check runs in the server's maintenance.
      ...(config.verifiedDomains
        ? { domains: { resolvers: slotlockDomainResolvers('doh', { fetch: (input, init) => fetch(input, init) }) } }
        : {}),
      // Teams' single sign-on: a Worker reaches no private network, so its own fetch.
      ...(config.teamSso
        ? { sso: { secretBox: createSlotlockSecretBox(config.teamSso.secret), fetch: (input, init) => fetch(input, init) } }
        : {}),
      ...(config.teamScim ? { scim: true } : {}),
      ...(config.invitationEmail
        ? {
            invitations: createSlotlockInvitationEmailSender(config.invitationEmail, {
              fetch: (input, init) => fetch(input, init),
              ...(config.name ? { brandName: config.name } : {}),
            }),
          }
        : {}),
      ...(config.privacyUrl ? { privacyUrl: config.privacyUrl } : {}),
      availability: readAvailability(vars),
      // With SLOTLOCK_ASSISTANT_SECRET, the chat assistant; its tool calls reach Postgres through
      // the request's client like every other page, and are bounded by the client rate limit.
      ...(config.assistantSecret !== undefined
        ? {
            assistant: {
              secret: config.assistantSecret,
              ...(config.assistantPreviousSecrets
                ? { previousSecrets: config.assistantPreviousSecrets }
                : {}),
              backend: perRequest(() => current().agent),
              // A Worker's fetch reaches no private network (nor this isolate's loopback), so the
              // literal URL check is the one that applies; names are not resolved here.
              fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
              resolve: async () => [],
              consumeRateLimit: async (args: {
                principal: SlotlockAgentPrincipal;
                operation: SlotlockAgentOperation;
              }) => agentLimiter(current().agentCalls, args),
              ...(metering
                ? {
                    onUsage: (usage: SlotlockAgentUsage) => current().usage?.count(usage),
                    onMessage: (tenantRef: string) =>
                      current().usage?.add({ tenantRef, metric: 'assistant_messages', origin: 'dashboard-assistant' }),
                  }
                : {}),
              // A read, or an approved write, over the tenant's monthly quota is refused.
              ...(quotaMode
                ? {
                    admit: async (args: {
                      principal: SlotlockAgentPrincipal;
                      operation: SlotlockAgentOperation;
                    }) => {
                      const verdict = await current().quotas?.check({
                        tenantRef: args.principal.tenantRef,
                        operation: args.operation,
                      });
                      if (verdict && !verdict.ok) throw slotlockQuotaRefusal(verdict.exceeded);
                    },
                  }
                : {}),
              ...(config.assistantPrivateUrls ? { privateUrls: true } : {}),
            },
          }
        : {}),
      ...(metering ? { usage: true } : {}),
      ...(quotaMode ? { quotas: true } : {}),
      // Plans whether or not Stripe sells them: the Usage page, and a new tenant enrolled on the
      // default plan before its first key, resource or webhook. Asking for another plan goes to
      // billing's contact, or SLOTLOCK_PLAN_CONTACT when nothing sells plans here.
      plans: {
        plan: (tenantRef: string) => readSlotlockTenantPlan(current().sql, tenantRef),
        async enrol(tenantRef: string) {
          await enrolSlotlockTenantPlan(current().sql, tenantRef);
        },
        planDefault: () => readSlotlockPlanDefault(current().sql),
        ...(planContact ? { contact: planContact } : {}),
      },
      ...(billing
        ? {
            billing: {
              plan: (tenantRef: string) => readSlotlockTenantPlan(current().sql, tenantRef),
              async enrol(tenantRef: string) {
                await enrolSlotlockTenantPlan(current().sql, tenantRef);
              },
              checkout: (input) => billing.stripe.checkout(input),
              portal: (input) => billing.stripe.portal(input),
              prices: billing.prices,
              ...(billing.teamPrices ? { teamPrices: billing.teamPrices } : {}),
              // Stripe's own amounts, read with the dashboard's key (Read on Prices); the configured
              // labels above only when Stripe does not answer.
              async shownPrices() {
                const shown = await (billing.stripe.shownPrices?.() ?? Promise.reject(new Error('no shown prices')));
                return { prices: shown.developer, ...(shown.team ? { teamPrices: shown.team } : {}) };
              },
              ...(billing.overage ? { overage: billing.overage } : {}),
              contact: billing.contact,
              formOrigins: ['https://checkout.stripe.com', 'https://billing.stripe.com'],
            },
          }
        : {}),
      // Cloudflare sets CF-Connecting-IP itself, so one client's sign-ins in flight are capped.
      clientAddress: clientOf,
      keys: perRequest(() => current().keys),
      resources: perRequest(() => current().resources),
      state: perRequest(() => current().state),
      // Roles from the database on every request, and "Sign out everywhere" (workspaces.ts).
      workspaces: perRequestWorkspaces(() => current().workspaces),
      onError: (error) =>
        console.error(
          JSON.stringify({
            message: 'slotlock dashboard request failed',
            error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
          }),
        ),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const root = `${publicUrl}/dashboard`;
    const base = new URL(root).pathname;
    return {
      dashboard,
      root,
      availability: readAvailability(vars),
      signInPaths: new Set([`${base}/sign-in`, `${base}/callback`]),
      scimPrefix: config.teamScim ? `${base}/scim/v2/` : null,
      stripeWebhook:
        billing?.webhookSecret
          ? {
              path: `${new URL(publicUrl).pathname.replace(/\/$/, '')}/stripe/webhook`,
              secret: billing.webhookSecret,
              stripe: billing.stripe,
            }
          : null,
      usage: metering,
      quotas: quotaMode,
      overageStopPercent,
      limits: { client, signIn, signInCeiling, scim },
    };
  }

  return {
    async fetch(
      request: Request,
      env: SlotlockDashboardWorkerEnv,
      ctx: SlotlockDashboardWorkerContext,
    ): Promise<Response> {
      try {
        built ??= build(env);
      } catch (error) {
        if (!(error instanceof SlotlockConfigError)) throw error;
        // The message names the variable, never its value.
        console.error(
          JSON.stringify({ message: 'slotlock dashboard misconfigured', error: error.message }),
        );
        return new Response('The dashboard is not configured.', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      const { dashboard, root, signInPaths, scimPrefix, limits, availability, stripeWebhook, usage, quotas, overageStopPercent } = built;
      const path = new URL(request.url).pathname;
      if (path === '/') return Response.redirect(root, 302);
      // Stripe's deliveries: the client connects only once the signature has been checked.
      if (stripeWebhook && path === stripeWebhook.path) {
        const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, onnotice: () => {} });
        try {
          return await handleSlotlockStripeWebhook(request, {
            secret: stripeWebhook.secret,
            stripe: stripeWebhook.stripe,
            sql,
            onError: (error) =>
              console.error(
                JSON.stringify({
                  message: 'slotlock stripe webhook failed',
                  error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
                }),
              ),
            // Stripe ids only: the owner finds the tenant in Stripe and refunds the second purchase.
            onDuplicate: (subscriptions) =>
              console.error(
                JSON.stringify({ message: 'slotlock billing duplicate subscription', subscriptions }),
              ),
          });
        } finally {
          ctx.waitUntil(sql.end({ timeout: 5 }));
        }
      }
      // Browsers and crawlers ask the origin's root for its icon; the dashboard serves it.
      if (path === '/favicon.ico' || path === '/favicon.svg') {
        return Response.redirect(`${root}/favicon.svg`, 301);
      }
      if (!dashboard.handles(request)) {
        return new Response('Not found', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      // Before any database client or GitHub request.
      const address = clientOf(request) ?? 'unknown';
      // A team's provider calls SCIM from addresses its other customers share: counted apart from
      // the dashboard's budget, so neither people browsing nor another team's sync use it up.
      const counted =
        limits.scim && scimPrefix !== null && path.startsWith(scimPrefix)
          ? await limits.scim.limit({ key: `scim:${address}` })
          : await limits.client.limit({ key: `client:${address}` });
      if (!counted.success) return tooManyRequests();
      // The dashboard routes a path with one trailing slash as the path without it, so a sign-in is
      // recognised as it recognises one: `/dashboard/sign-in/` is a sign-in too.
      const route = path.replace(/\/$/, '');
      if (signInPaths.has(route)) {
        // Per network, not per /64: a site rotating through the /64s of its /48 is one client
        // here, so it cannot use up the ceiling every other client shares.
        const network = slotlockClientNetwork(address);
        const allowed = limits.signInCeiling
          ? (await limits.signIn.limit({ key: `sign-in:${network}` })).success &&
            (await limits.signInCeiling.limit({ key: 'sign-in' })).success
          : (await limits.signIn.limit({ key: 'sign-in' })).success;
        if (!allowed) return tooManyRequests();
      }
      const sql = postgres(env.HYPERDRIVE.connectionString, {
        max: MAX_CONNECTIONS,
        onnotice: () => {},
      });
      let requestScope: RequestScope | undefined;
      // A streamed answer (the assistant's reply) is still working when the response is returned:
      // its connection and usage are closed once the stream ends, not when fetch returns.
      let streaming: Promise<unknown> | null = null;
      try {
        const store = createSlotlockStore(sql);
        // Recorded once, when the response is sent: a Worker keeps nothing between requests.
        const meter = usage
          ? createSlotlockUsageMeter({
              intervalMs: 0,
              record: (flushId, rows) => recordSlotlockUsage(sql, flushId, rows),
              onError: (error) =>
                console.error(
                  JSON.stringify({
                    message: 'slotlock usage record failed',
                    error: error instanceof Error ? error.message : 'unknown',
                  }),
                ),
            })
          : null;
        const agentBackend = createSlotlockStoreAgentBackend(store, {
          availabilityRules: async () => availability.map((rule) => ({ ...rule })),
        });
        requestScope = {
          sql,
          keys: createSlotlockApiKeyStore(sql),
          agentCalls: { count: 0 },
          usage: meter,
          // Read once a request, with this request's own counts on top.
          quotas:
            quotas && meter
              ? createSlotlockQuotas({
                  plan: (tenantRef) =>
                    readSlotlockTenantQuotas(sql, tenantRef, overageStopPercent !== undefined ? { overageStopPercent } : {}),
                  used: (tenantRef, fromDay) => readSlotlockQuotaUse(sql, tenantRef, fromDay),
                  local: (tenantRef, metric, fromDay) => meter.local(tenantRef, metric, fromDay),
                  notice: (notice) => noteSlotlockQuotaThreshold(sql, notice),
                  onError: (error) =>
                    console.error(
                      JSON.stringify({
                        message: 'slotlock quota check failed',
                        error: error instanceof Error ? error.message : 'unknown',
                      }),
                    ),
                })
              : null,
          agent: agentBackend,
          // Approvals (RFC 0004 A4) are granted through the same backend the assistant books with.
          // Holiday calendars by address (RFC 0004 B1): the Worker's fetch, which reaches only the
          // public internet; fetchHolidayCalendar takes https only, no redirects, 1 MB, 10 seconds.
          resources: createSlotlockDashboardResources(store, { agentBackend, holidayFetch: (input, init) => fetch(input, init) }),
          state: createSlotlockDashboardState(sql),
          workspaces: createSlotlockDashboardWorkspaces(sql),
        };
        const relayed = slotlockRelayStream(await scope.run(requestScope, () => dashboard.fetch(request)));
        streaming = relayed.done;
        return relayed.response;
      } finally {
        const counted = requestScope?.usage;
        ctx.waitUntil(
          (streaming ?? Promise.resolve())
            .then(() => (counted ? counted.close() : undefined))
            .finally(() => sql.end({ timeout: 5 })),
        );
      }
    },
  };
}

/**
 * A streamed answer (`application/x-ndjson`, the assistant's reply) is still being written when the
 * dashboard returns it. Relayed, `done` settles once its last byte has gone (or the client left), so
 * the request's connection and usage are closed then and not before. Anything else passes as is.
 */
export function slotlockRelayStream(response: Response): { response: Response; done: Promise<void> | null } {
  if (!response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
    return { response, done: null };
  }
  const relay = new TransformStream<Uint8Array, Uint8Array>();
  const done = response.body.pipeTo(relay.writable).catch(() => undefined);
  return { response: new Response(relay.readable, { status: response.status, headers: response.headers }), done };
}

export default createSlotlockDashboardWorker();
