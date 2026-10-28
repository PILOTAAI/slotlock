// The dashboard: people sign in with GitHub and manage the API keys and calendar resources of a
// tenant: their own, `github:<user id>`, or with `organizations`, a GitHub organization's,
// `github-org:<organization id>`, shared by its owners and members. It is server-rendered HTML with no inline script or style,
// so its Content-Security-Policy allows nothing but this server's own stylesheet and script.
//
// Sign-in is GitHub's OAuth web flow with `state` and PKCE (S256), with no scope (`read:org` with
// organizations): the token is used once, to read who signed in and their memberships, and dropped. A session is an HMAC-sealed cookie (`__Host-`,
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
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentOperation,
  type SlotlockAgentOperationDispatchOptions,
  type SlotlockAgentOperationDispatchResult,
  type SlotlockAgentPrincipal,
  type SlotlockAgentWriteOperation,
  describeSlotlockAgentWrite,
  invokeSlotlockAgentOperation,
  slotlockAgentTools,
} from './agent-server.js';
import {
  SLOTLOCK_ASSISTANT_API_KEY,
  SLOTLOCK_ASSISTANT_MAX_ACTION_BYTES,
  SLOTLOCK_ASSISTANT_MAX_MESSAGE,
  SLOTLOCK_ASSISTANT_MAX_PENDING,
  SLOTLOCK_ASSISTANT_MODEL_NAME,
  SLOTLOCK_ASSISTANT_TOOL_USE,
  type SlotlockAssistantAction,
  type SlotlockAssistantEntry,
  type SlotlockAssistantModel,
  type SlotlockAssistantStore,
  boundSlotlockAssistantEntries,
  createSlotlockAssistantStore,
  openSlotlockAssistantKey,
  pendingSlotlockAssistantActions,
  pruneSlotlockAssistantActions,
  checkSlotlockAssistantHost,
  readSlotlockAssistantBaseUrl,
  slotlockAssistantUrlAllowed,
  readSlotlockAssistantEntries,
  runSlotlockAssistantTurn,
  sealSlotlockAssistantKey,
  slotlockAssistantProviderMessage,
  slotlockAssistantSystemPrompt,
  testSlotlockAssistantModel,
} from './assistant.js';
import { SLOTLOCK_DASHBOARD_NAME_PATTERN, type SlotlockRate } from './config.js';
import { createSlotlockRateLimiter } from './rate-limit.js';
import { createSlotlockGuardedFetch } from './webhooks.js';
import { lookup as dnsLookup } from 'node:dns/promises';
import { SLOTLOCK_DASHBOARD_FORM_LIMIT } from './ddl.js';
import { ignoreRejection } from './hooks.js';
import { SLOTLOCK_BOOKING_RULE_LIMITS, type SlotlockBookingRules } from './booking-rules.js';
import {
  type CreateWebhookEndpointResult,
  SLOTLOCK_CHANGE_TYPES,
  type SlotlockChange,
  type SlotlockWebhookEndpoint,
} from './event-feed.js';
import type { SlotlockSql, SlotlockStore, SlotlockWaitlistEntry } from './store.js';
import type {
  Interval,
  SlotlockAgendaEntry,
  SlotlockResource,
  SlotlockBookingRuleDefaults,
  WeeklyAvailabilityRule,
} from './types.js';
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
/** A message to the assistant: 2,000 characters, each up to 9 bytes as a form encodes it. */
const MAX_ASSISTANT_FORM_BYTES = 24_576;
/**
 * Sign-ins (record, then GitHub's token and user) one instance runs at once; more are told to retry.
 * This also bounds how fast unauthenticated callbacks can write sign-in records.
 */
const MAX_SIGN_INS_IN_FLIGHT = 8;
/** Of those, how many one client address may run at once, so one client cannot take every slot. */
const MAX_SIGN_INS_IN_FLIGHT_PER_CLIENT = 2;
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
  '/resources/rules',
  '/resources/pool',
  '/webhooks',
  '/webhooks/delete',
  '/webhooks/enable',
  '/waitlist/leave',
  '/hours',
  '/organization',
  '/assistant',
  '/assistant/approve',
  '/assistant/dismiss',
  '/assistant/reset',
  '/settings/assistant',
  '/settings/assistant/test',
  '/settings/assistant/remove',
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
  full: ['read', 'write', 'admin'],
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

/**
 * A tenant's calendar resources, as the dashboard lists and adds them. Each write takes, last, the
 * person who made it (`github:<user id>`) as `actor`, to record on the event feed.
 */
export interface SlotlockDashboardResources {
  list(tenantRef: string): Promise<SlotlockResource[]>;
  /**
   * Create the resource, or re-zone the tenant's resource with that reference. Refuse a new one
   * (an error with `code: 'resource_limit_reached'`) once the tenant has
   * SLOTLOCK_DASHBOARD_MAX_RESOURCES, however many adds race, on however many servers.
   */
  add(
    tenantRef: string,
    externalRef: string,
    timezone: string,
    actor?: string,
  ): Promise<SlotlockResource>;
  /**
   * Set the bookable hours of one of the tenant's resources (`{ id }`) or of all of them; `null`
   * hands them back to the server's and `[]` closes. Returns how many resources changed: 0 for an
   * id that is not the tenant's.
   */
  setHours(
    tenantRef: string,
    target: { id: string } | 'all',
    rules: WeeklyAvailabilityRule[] | null,
    actor?: string,
  ): Promise<number>;
  /** What occupies the tenant's resources in `window`, by start: the overview's agenda. */
  agenda?(tenantRef: string, window: Interval, limit: number): Promise<SlotlockAgendaEntry[]>;
  /** The tenant's latest changes, newest first: the overview's activity. */
  recentChanges?(tenantRef: string, limit: number): Promise<SlotlockChange[]>;
  /**
   * Set the booking rules of one of the tenant's resources (null clears them): the resource, or
   * null when it is not the tenant's. Invalid rules throw with `code: 'invalid_booking_rules'`.
   */
  setRules?(
    tenantRef: string,
    id: string,
    rules: SlotlockBookingRules | null,
    actor?: string,
  ): Promise<SlotlockResource | null>;
  /** The tenant's default booking rules and its pools', which a resource's own rules overlay. */
  ruleDefaults?(tenantRef: string): Promise<SlotlockBookingRuleDefaults>;
  /** Put one of the tenant's resources in a pool, or none: as setRules; `code: 'invalid_pool'`. */
  setPool?(
    tenantRef: string,
    id: string,
    pool: string | null,
    actor?: string,
  ): Promise<SlotlockResource | null>;
  /** The tenant's waitlist, oldest first, and leaving it (false when the entry is not the tenant's). */
  waitlist?: {
    list(tenantRef: string, limit: number): Promise<SlotlockWaitlistEntry[]>;
    leave(tenantRef: string, id: string, actor?: string): Promise<boolean>;
  };
  /** The tenant's assistant settings and its members' conversations (assistant.ts). */
  assistant?: SlotlockAssistantStore;
  /** The tenant's webhook endpoints, as the event feed keeps them. */
  webhooks?: {
    list(tenantRef: string): Promise<SlotlockWebhookEndpoint[]>;
    create(
      tenantRef: string,
      url: string,
      eventTypes: readonly string[] | undefined,
      actor?: string,
    ): Promise<CreateWebhookEndpointResult>;
    remove(tenantRef: string, id: string, actor?: string): Promise<boolean>;
    enable(
      tenantRef: string,
      id: string,
      actor?: string,
    ): Promise<SlotlockWebhookEndpoint | null | { code: 'changes_pruned' }>;
  };
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

/**
 * The chat assistant (assistant.ts): each tenant's admins connect a model of their own in Settings,
 * and every member may chat with it. Its reads and approved writes run through the agent operation
 * boundary with `backend`, as the principal `dashboard-assistant:<GitHub login>` of the member's
 * tenant, with `authorize` and `consumeRateLimit` as an agent's are. Needs the resources adapter's
 * `assistant` too.
 */
export interface SlotlockDashboardAssistantOptions {
  /** Seals each tenant's API key (SLOTLOCK_ASSISTANT_SECRET): 32+ random characters. */
  secret: string;
  backend: SlotlockAgentCalendarBackend;
  /**
   * As the agent server's: false refuses an operation. Every offered operation by default. It also
   * checks a write the model proposes, so it must hold nothing: limits that hold a slot go in
   * `admit`.
   */
  authorize?: SlotlockAgentOperationDispatchOptions['authorize'];
  /**
   * Taken when a read runs and when an approved write runs, never for a proposal: the agent
   * request limits' `admit` (serve's series-write slots), which may hold a slot until the request
   * is answered, or throw a SlotlockAgentOperationError to refuse.
   */
  admit?: (args: {
    principal: SlotlockAgentPrincipal;
    operation: SlotlockAgentOperation;
    input: Record<string, unknown>;
  }) => Promise<void>;
  /** As the agent server's; charged for each read and each approved write, never for a proposal. */
  consumeRateLimit?: SlotlockAgentOperationDispatchOptions['consumeRateLimit'];
  /**
   * Allow a model at a local or private network address (SLOTLOCK_ASSISTANT_PRIVATE_URLS): a
   * base URL whose host is, or resolves to, a loopback, private, link-local, shared, unique-local
   * or metadata address. Off by default: such URLs are refused when saved and at each call.
   */
  privateUrls?: boolean;
  /**
   * Reaches the model providers. By default Node.js's http client, which checks every address a
   * host resolves to as the connection is made (createSlotlockGuardedFetch), so a name rebound to
   * a private address is refused too. A replacement must make that check itself, or reach no
   * private network (a Cloudflare Worker's fetch).
   */
  fetch?: typeof fetch;
  /** The addresses a host resolves to, to refuse a private one when saved: dns.lookup by default. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Messages and connection tests one member may send: 10 a minute, 10 at once, by default. */
  rate?: SlotlockRate;
  /** One model call's limit (30 s by default) and one message's (90 s). */
  timeoutMs?: number;
  turnTimeoutMs?: number;
  /** Model calls one message may make (8 by default, at most 20). */
  maxSteps?: number;
  /** How long a conversation is kept after its last message: 2 hours by default. */
  conversationTtlMs?: number;
}

export interface SlotlockDashboardOptions {
  /** Where people reach the server; the dashboard lives at `<publicUrl>/dashboard`. */
  publicUrl: string;
  /** What the deployment is called in the dashboard: 1-60 characters. Defaults to `Slotlock`. */
  name?: string;
  /**
   * Where agents reach the server's MCP and A2A endpoints, which the dashboard shows, when it is
   * served from another origin (on Cloudflare Workers, with the server elsewhere). Defaults to
   * `publicUrl`.
   */
  serviceUrl?: string;
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
    membershipsUrl?: string;
  };
  /** Seals sessions and sign-in state and derives CSRF tokens: 32+ random characters. */
  sessionSecret: string;
  /** GitHub user ids (numbers, as strings) that may sign in, or `'*'` for every GitHub account. */
  allowedUsers: '*' | readonly string[];
  /**
   * GitHub organization ids (numbers, as strings) this dashboard serves. With them, a tenant is an
   * organization (`github-org:<id>`), not a person: sign-in asks for `read:org`, and a person signs
   * in to the served organizations they are an active member of, sharing each one's keys and
   * resources with its other members: owners and members, not billing managers, from the first
   * 100 memberships GitHub lists, up to 20 served organizations. Membership is read at each sign-in; leaving an organization
   * ends access at the next sign-in, at most a session (12 hours) later, and removing an
   * organization from this list signs its sessions out at once. Without it, each person is their
   * own tenant (`github:<id>`).
   */
  organizations?: readonly string[];
  keys: SlotlockApiKeyStore;
  resources: SlotlockDashboardResources;
  /** Shared by every server behind this origin: see SlotlockDashboardState. */
  state: SlotlockDashboardState;
  /** The server's bookable hours: shown, not edited, and used by resources without their own. */
  availability?: readonly WeeklyAvailabilityRule[];
  /** The chat assistant; off unless set. */
  assistant?: SlotlockDashboardAssistantOptions;
  fetch?: typeof fetch;
  now?: () => number;
  /**
   * The address a request came from, as the server counts its clients (the socket's, or a trusted
   * proxy's field such as CF-Connecting-IP), so one client's sign-ins in flight are capped below
   * every client's. Without it, or when it returns undefined, only the cap on every client applies.
   */
  clientAddress?: (request: Request) => string | undefined;
  /**
   * Called with whatever a request handler throws; the person sees a generic error page. Not
   * awaited; what it throws, or its promise rejects with, is ignored.
   */
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
  const by = (actor: string | undefined) => (actor === undefined ? {} : { actor });
  return {
    list: (tenantRef) =>
      store.withTenant(tenantRef, (tenant) =>
        tenant.listResources({ tenantRef, limit: SLOTLOCK_DASHBOARD_MAX_RESOURCES + 1 }),
      ),
    add: (tenantRef, externalRef, timezone, actor) =>
      store.withTenant(
        tenantRef,
        (tenant) =>
          tenant.createResource({
            tenantRef,
            externalRef,
            timezone,
            maxTenantResources: SLOTLOCK_DASHBOARD_MAX_RESOURCES,
          }),
        { isolation: 'read committed', ...by(actor) },
      ),
    setHours: (tenantRef, target, rules, actor) =>
      store.withTenant(
        tenantRef,
        async (tenant) => {
          if (target === 'all') return tenant.setTenantAvailability({ tenantRef, rules });
          const updated = await tenant.setResourceAvailability({ tenantRef, id: target.id, rules });
          return updated ? 1 : 0;
        },
        by(actor),
      ),
    agenda: (tenantRef, window, limit) =>
      store.withTenant(tenantRef, (tenant) => tenant.listAgenda({ tenantRef, window, limit })),
    recentChanges: (tenantRef, limit) =>
      store.withTenant(tenantRef, (tenant) => tenant.listRecentChanges({ tenantRef, limit })),
    setRules: (tenantRef, id, rules, actor) =>
      store.withTenant(
        tenantRef,
        (tenant) => tenant.setResourceBookingRules({ tenantRef, id, rules }),
        by(actor),
      ),
    ruleDefaults: (tenantRef) =>
      store.withTenant(tenantRef, (tenant) => tenant.getBookingRuleDefaults({ tenantRef })),
    setPool: (tenantRef, id, pool, actor) =>
      store.withTenant(tenantRef, (tenant) => tenant.setResourcePool({ tenantRef, id, pool }), by(actor)),
    waitlist: {
      list: (tenantRef, limit) =>
        store.withTenant(tenantRef, (tenant) => tenant.listWaitlist({ tenantRef, limit })),
      async leave(tenantRef, id, actor) {
        const left = await store.withTenant(
          tenantRef,
          (tenant) => tenant.leaveWaitlist({ tenantRef, id }),
          by(actor),
        );
        // An offered entry's hold went with it: offer that time to the next, as the API does.
        if (left) {
          await store
            .withTenant(tenantRef, (tenant) => tenant.offerWaitlist({ tenantRef, limit: 20 }))
            .catch(() => undefined);
        }
        return left;
      },
    },
    webhooks: {
      list: (tenantRef) =>
        store.withTenant(tenantRef, (tenant) => tenant.listWebhookEndpoints({ tenantRef })),
      create: (tenantRef, url, eventTypes, actor) =>
        store.withTenant(
          tenantRef,
          (tenant) =>
            tenant.createWebhookEndpoint({
              tenantRef,
              url,
              ...(eventTypes !== undefined ? { eventTypes } : {}),
            }),
          by(actor),
        ),
      remove: async (tenantRef, id, actor) =>
        (
          await store.withTenant(
            tenantRef,
            (tenant) => tenant.deleteWebhookEndpoint({ tenantRef, id }),
            by(actor),
          )
        ).deleted,
      enable: (tenantRef, id, actor) =>
        store.withTenant(
          tenantRef,
          (tenant) => tenant.enableWebhookEndpoint({ tenantRef, id }),
          by(actor),
        ),
    },
    assistant: createSlotlockAssistantStore(store),
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
 * Records accepted write confirmations (`SlotlockAgentConfirmationOptions.consumeAcceptance`) in
 * Postgres, shared by every server on the database: true the first time a confirmation's nonce is
 * recorded, false while it stays recorded, so an accepted confirmation runs its write once on any
 * server. Kept until the confirmation's own expiry, through the same function and table as the
 * dashboard's records (only a SHA-256 digest of the nonce is stored); pass a client, not a
 * transaction.
 */
export function createSlotlockAcceptanceRecords(
  sql: SlotlockSql,
): (acceptance: { nonce: string; expiresAt: Date }) => Promise<boolean> {
  if (!('begin' in sql)) {
    throw new Error(
      'createSlotlockAcceptanceRecords needs a client, not a transaction: a rollback would undo its records',
    );
  }
  const client = sql as Sql;
  return async ({ nonce, expiresAt }) => {
    const digest = createHash('sha256').update(`slotlock-confirmation.${nonce}`).digest();
    return (await client.begin('isolation level read committed', async (tx) => {
      const [row] = await tx<{ used: boolean }[]>`
        SELECT slotlock.use_dashboard_token('confirmation', ${digest}, ${expiresAt}, NULL::bytea) AS used`;
      return row?.used === true;
    })) as boolean;
  };
}

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
  /** With organizations: the served ones the person belongs to, read at sign-in, and the one in use. */
  orgs?: Organization[];
  org?: string;
}

interface Organization {
  id: string;
  login: string;
  /** The person's role in it, read at sign-in: owners are `admin`. Older sessions have none: members. */
  role?: 'admin' | 'member';
}

/** Served organizations one session lists at most: the session is a cookie of at most 4 KB. */
const MAX_SESSION_ORGANIZATIONS = 20;
const ORGANIZATION_ID = /^[1-9]\d{0,19}$/;

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

/** Days of bookings the overview shows, how many it reads and lists, and its activity's length. */
const AGENDA_DAYS = 7;
const AGENDA_LIMIT = 200;
const AGENDA_SHOWN = 30;
const ACTIVITY_LIMIT = 20;
const WAITLIST_SHOWN = 200;
const RESOURCE_PAGE = /^\/resources\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** How the booking rules form names each rule. */
const RULE_LIMITS = SLOTLOCK_BOOKING_RULE_LIMITS;
const RULE_NAMES = Object.freeze({
  minNoticeMinutes: 'Minimum notice',
  maxAdvanceDays: 'Book up to',
  slotStepMinutes: 'Start step',
  stepOffsetMinutes: 'Step offset',
  bufferBeforeMinutes: 'Buffer before',
  turnaroundMinutes: 'Turnaround',
  checkInMinutes: 'Check-in release',
} as const);
/** The booking rules form's fields, by rule. */
const RULE_FIELDS = Object.freeze({
  minNoticeMinutes: 'min_notice_minutes',
  maxAdvanceDays: 'max_advance_days',
  slotStepMinutes: 'slot_step_minutes',
  stepOffsetMinutes: 'step_offset_minutes',
  bufferBeforeMinutes: 'buffer_before_minutes',
  turnaroundMinutes: 'turnaround_minutes',
  checkInMinutes: 'check_in_minutes',
} as const);

/** How the inherited-rules note names each rule, with its unit. */
const INHERITED_NAMES: Readonly<Record<keyof SlotlockBookingRules, string>> = Object.freeze({
  ...RULE_NAMES,
  maxAdvanceDays: 'Book up to (days ahead)',
  enforceHours: 'Only inside bookable hours',
  requireCertain: 'Only in time its calendar syncs have read today',
});

type InheritedRules = Map<keyof SlotlockBookingRules, { value: number | boolean; from: string }>;

/**
 * The rules a resource takes from defaults, each with where it comes from: a rule its pool's
 * defaults set, else one the tenant's set, where its own rules do not. Without the defaults, the
 * rules that apply less its own, from "defaults".
 */
function inheritedRules(resource: SlotlockResource, defaults: SlotlockBookingRuleDefaults | undefined): InheritedRules {
  const own = resource.bookingRules ?? {};
  const levels: [string, SlotlockBookingRules | null | undefined][] = defaults
    ? [
        ['every resource', defaults.tenant],
        [`pool ${resource.pool ?? ''}`, resource.pool === undefined ? undefined : defaults.pools[resource.pool]],
      ]
    : [['defaults', resource.effectiveBookingRules]];
  const inherited: InheritedRules = new Map();
  for (const [from, rules] of levels) {
    for (const [name, value] of Object.entries(rules ?? {}) as [keyof SlotlockBookingRules, number | boolean][]) {
      if (own[name] === undefined) inherited.set(name, { value, from });
    }
  }
  return inherited;
}

function inheritedNote(inherited: InheritedRules): Html {
  if (inherited.size === 0) return html``;
  const parts = [...inherited].map(([name, { value, from }]) =>
    typeof value === 'boolean'
      ? `${INHERITED_NAMES[name]}${value ? '' : ': off'} (${from})`
      : `${INHERITED_NAMES[name]} ${value.toLocaleString('en')} (${from})`,
  );
  return html`<p class="fine">Inherited: ${parts.join('; ')}.</p>`;
}

const icon = (paths: string) =>
  new Html(
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`,
  );
const ICONS = Object.freeze({
  mark: new Html(
    // The Slotlock mark: a padlock whose body holds one booked slot (the site's logo, without the wordmark).
    '<svg class="mark" viewBox="0 0 85.32 77.12" aria-hidden="true" focusable="false"><path class="mark-ink" d="M13.13 34.46L72.2 34.46C79.45 34.46 85.32 40.33 85.32 47.58L85.32 63.99C85.32 71.24 79.45 77.12 72.2 77.12L13.13 77.12C5.88 77.12 0 71.24 0 63.99L0 47.58C0 40.33 5.88 34.46 13.13 34.46ZM22.97 39.38L22.97 19.69C22.97 8.82 31.79 0 42.66 0C53.54 0 62.35 8.82 62.35 19.69L62.35 39.38L56.61 39.38L56.61 19.69C56.61 11.99 50.36 5.74 42.66 5.74C34.96 5.74 28.71 11.99 28.71 19.69L28.71 39.38Z"></path><path class="mark-slot" d="M19.69 52.51L65.63 52.51C67.45 52.51 68.91 53.98 68.91 55.79C68.91 57.6 67.45 59.07 65.63 59.07L19.69 59.07C17.88 59.07 16.41 57.6 16.41 55.79C16.41 53.98 17.88 52.51 19.69 52.51Z"></path></svg>',
  ),
  overview: icon('<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z"/>'),
  resources: icon('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
  keys: icon('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>'),
  waitlist: icon('<path d="M4 6h16M4 12h10M4 18h6"/><circle cx="18" cy="16" r="3"/>'),
  webhooks: icon('<path d="M9 7a3 3 0 1 1 4 2.8L16 15M6.5 13.5A3 3 0 1 0 9 18h6M15 18a3 3 0 1 0 1.5-5.6"/>'),
  assistant: icon('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'),
  settings: icon(
    '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  ),
  check: icon('<path d="M5 12l5 5L20 7"/>'),
  github: new Html(
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path class="fill" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  ),
});

type Tone = 'good' | 'bad' | 'neutral';
/** How the overview names each change the feed records. */
const CHANGE_LABELS: Readonly<Record<string, { text: string; tone: Tone }>> = Object.freeze({
  'hold.created': { text: 'Hold placed', tone: 'neutral' },
  'hold.updated': { text: 'Hold changed', tone: 'neutral' },
  'hold.confirmed': { text: 'Hold booked', tone: 'good' },
  'hold.released': { text: 'Hold released', tone: 'neutral' },
  'hold.expired': { text: 'Hold expired', tone: 'neutral' },
  'reservation.created': { text: 'Booked', tone: 'good' },
  'reservation.updated': { text: 'Booking moved', tone: 'neutral' },
  'reservation.cancelled': { text: 'Booking cancelled', tone: 'bad' },
  'reservation.checked_in': { text: 'Checked in', tone: 'good' },
  'reservation.no_show': { text: 'No-show released', tone: 'bad' },
  'event.created': { text: 'Event added', tone: 'good' },
  'event.updated': { text: 'Event changed', tone: 'neutral' },
  'event.cancelled': { text: 'Event cancelled', tone: 'bad' },
  'event.timezone_shifted': { text: 'Event moved by a time zone change', tone: 'neutral' },
  'event.timezone_conflict': { text: 'Event clashes after a time zone change', tone: 'bad' },
  'coverage.stale': { text: 'Calendar sync is behind', tone: 'bad' },
  'waitlist.offered': { text: 'Waitlist offer sent', tone: 'good' },
  'waitlist.expired': { text: 'Waitlist offer lapsed', tone: 'neutral' },
  'webhook.disabled': { text: 'Webhook disabled', tone: 'bad' },
});

const zoned = (zone: string, parts: Intl.DateTimeFormatOptions) => {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...parts, timeZone: zone });
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...parts, timeZone: 'UTC' });
  }
};

/** `14:30` in the resource's own time zone. */
function clock(date: Date, zone: string): string {
  return zoned(zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** The day a time falls on in a zone: `Today`, `Tomorrow`, or `Thu 30 Oct`, with a key to group by. */
function dayLabel(date: Date, zone: string, nowMs: number): { key: string; label: string } {
  const key = (at: Date) =>
    zoned(zone, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  const day = key(date);
  if (day === key(new Date(nowMs))) return { key: day, label: 'Today' };
  if (day === key(new Date(nowMs + DAY_MS))) return { key: day, label: 'Tomorrow' };
  return {
    key: day,
    label: zoned(zone, { weekday: 'short', day: 'numeric', month: 'short' }).format(date),
  };
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`. */
function ago(date: Date, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - date.getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1_440)} d ago`;
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
  const service = new URL(options.serviceUrl ?? options.publicUrl);
  const serviceRoot = `${service.origin}${service.pathname.replace(/\/$/, '')}`;
  const mcpUrl = `${serviceRoot}/mcp`;
  const a2aUrl = `${serviceRoot}/a2a`;
  const authorizeUrl = options.github.authorizeUrl ?? 'https://github.com/login/oauth/authorize';
  const tokenUrl = options.github.tokenUrl ?? 'https://github.com/login/oauth/access_token';
  const userUrl = options.github.userUrl ?? 'https://api.github.com/user';
  const membershipsUrl =
    options.github.membershipsUrl ??
    'https://api.github.com/user/memberships/orgs?state=active&per_page=100';
  const served = options.organizations ? new Set(options.organizations) : null;
  if (served && (served.size === 0 || [...served].some((id) => !ORGANIZATION_ID.test(id)))) {
    throw new Error('Slotlock dashboard organizations must be GitHub organization ids');
  }
  const brandName = options.name ?? 'Slotlock';
  if (!SLOTLOCK_DASHBOARD_NAME_PATTERN.test(brandName) || brandName.trim() !== brandName) {
    throw new Error('Slotlock dashboard name must be 1-60 characters, without <, > or control or invisible characters');
  }
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
  /** Sign-ins in flight by client address. */
  const signInsByClient = new Map<string, number>();

  function report(message: string): void {
    try {
      ignoreRejection(options.onError?.(new Error(message)));
    } catch {
      // A failing reporter must not change the response.
    }
  }

  // Bound to the organization too: a page opened before a switch cannot write into the new one.
  const formMac = (session: Session, nonce: string, org = session.org ?? '') =>
    createHmac('sha256', secret)
      .update(`slotlock-dashboard-form-v2.${session.sid}.${org}.${nonce}`)
      .digest('base64url');
  /** Random, and bound to the session by a MAC: a made-up or another session's value is refused unwritten. */
  const formNonce = (session: Session) => {
    const nonce = randomBytes(18).toString('base64url');
    return `${nonce}.${formMac(session, nonce)}`;
  };
  /** `ok`, `other_org` for a form from a page of another of the session's organizations, else `bad`. */
  const checkFormNonce = (session: Session, once: string): 'ok' | 'other_org' | 'bad' => {
    const match = FORM_NONCE.exec(once);
    if (match === null) return 'bad';
    const [, nonce, mac] = match as unknown as [string, string, string];
    // Compared as text, like the cookie MACs: decoding would drop the last character's spare bits.
    if (safeEqual(mac, formMac(session, nonce))) return 'ok';
    const other = session.orgs?.some(
      (org) => org.id !== session.org && safeEqual(mac, formMac(session, nonce, org.id)),
    );
    return other ? 'other_org' : 'bad';
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
      !organizationsHold(payload) ||
      (await options.state.sessionEnded(payload.sid, payload.exp as number))
    ) {
      return null;
    }
    return payload as unknown as Session;
  }

  /**
   * With organizations, the session names one the server still serves, from its own list; without
   * them, it names none. A session from the other mode is signed out.
   */
  function organizationsHold(payload: Record<string, unknown>): boolean {
    if (!served) return payload.org === undefined && payload.orgs === undefined;
    if (typeof payload.org !== 'string' || !served.has(payload.org) || !Array.isArray(payload.orgs)) {
      return false;
    }
    return (payload.orgs as unknown[]).some(
      (org) => isRecord(org) && org.id === payload.org && typeof org.login === 'string',
    );
  }

  const csrfToken = (session: Session) =>
    createHmac('sha256', secret)
      .update(`slotlock-dashboard-csrf-v1.${session.sid}`)
      .digest('base64url');
  const tenantOf = (session: Session) =>
    served ? `github-org:${session.org as string}` : `github:${session.uid}`;
  /** Who did something, for the record: the person, whatever tenant they act in. */
  const personOf = (session: Session) => `github:${session.uid}`;

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

  type Section = 'overview' | 'resources' | 'waitlist' | 'keys' | 'webhooks' | 'assistant' | 'settings';
  // Pages for what the adapter offers, so a custom one without a waitlist shows none. Read per
  // request: on Workers the adapter exists only inside one.
  const nav = (): ReadonlyArray<{ section: Section; label: string; path: string; icon: Html }> => [
    { section: 'overview', label: 'Overview', path: '', icon: ICONS.overview },
    { section: 'resources', label: 'Resources', path: '/resources', icon: ICONS.resources },
    ...(options.resources.waitlist
      ? [{ section: 'waitlist' as const, label: 'Waitlist', path: '/waitlist', icon: ICONS.waitlist }]
      : []),
    { section: 'keys', label: 'API keys', path: '/keys', icon: ICONS.keys },
    ...(options.resources.webhooks
      ? [{ section: 'webhooks' as const, label: 'Webhooks', path: '/webhooks', icon: ICONS.webhooks }]
      : []),
    ...(assistantStore()
      ? [{ section: 'assistant' as const, label: 'Assistant', path: '/assistant', icon: ICONS.assistant }]
      : []),
    { section: 'settings', label: 'Settings', path: '/settings', icon: ICONS.settings },
  ];

  /** The workspace the session acts in: its organization, or the person themselves. */
  function workspace(session: Session): Html {
    const current = session.orgs?.find((org) => org.id === session.org);
    const choices = (session.orgs ?? []).filter((org) => served?.has(org.id));
    const name = current?.login ?? session.login;
    const badge = html`<span class="avatar" aria-hidden="true">${name.slice(0, 1).toUpperCase()}</span>`;
    if (current && choices.length > 1) {
      return html`<form class="workspace" method="post" action="${root}/organization">${badge}<input type="hidden" name="csrf" value="${csrfToken(session)}"><input type="hidden" name="once" value="${formNonce(session)}"><label class="visually-hidden" for="organization">Organization</label><select id="organization" name="organization">${choices.map((org) => html`<option value="${org.id}"${org.id === current.id ? html` selected` : html``}>${org.login}</option>`)}</select><button class="quiet" type="submit">Switch</button></form>`;
    }
    return html`<div class="workspace">${badge}<span class="workspace-name">${current ? name : `@${name}`}</span></div>`;
  }

  function layout(title: string, content: Html, session: Session | null, section?: Section): Html {
    const head = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="${REFERRER_POLICY}">
<title>${title} · ${brandName}</title>
<link rel="stylesheet" href="${root}/style.css?v=${ASSET_VERSIONS.css}">
<script src="${root}/app.js?v=${ASSET_VERSIONS.js}" defer></script>
</head>`;
    const brand = html`<a class="brand" href="${root}">${ICONS.mark}<span class="name">${brandName}</span></a>`;
    if (!session) {
      return html`${head}
<body class="bare">
<header class="bare-bar">${brand}</header>
<main class="bare-main">${content}</main>
</body>
</html>`;
    }
    const links = nav().map(
      (item) =>
        html`<a href="${root}${item.path}"${item.section === section ? html` aria-current="page"` : html``}>${item.icon}<span>${item.label}</span></a>`,
    );
    return html`${head}
<body>
<div class="app">
<aside class="side">
<div class="side-top">${brand}${workspace(session)}</div>
<nav class="nav" aria-label="Dashboard">${links}</nav>
<div class="me"><span class="login">@${session.login}</span><form method="post" action="${root}/sign-out"><input type="hidden" name="csrf" value="${csrfToken(session)}"><button class="quiet" type="submit">Sign out</button></form></div>
</aside>
<main class="page">${content}</main>
</div>
</body>
</html>`;
  }

  const noticeOf = (notice?: string) =>
    notice ? html`<p class="notice" role="alert">${notice}</p>` : html``;

  function signedOutPage(status: number, notice?: string, cookies: string[] = []): Response {
    const content = html`<section class="sign-in">
<h1>Sign in to ${brandName}</h1>
<p>Create keys for your agents, add what they book, and watch what they do.</p>
${noticeOf(notice)}
<a class="button primary wide" href="${root}/sign-in">${ICONS.github}Continue with GitHub</a>
<p class="fine">${
      served
        ? `${brandName} reads your GitHub profile and which organizations you belong to, and keeps only your user id, login and the organizations it serves.`
        : `${brandName} reads only your public GitHub profile, and keeps only your user id and login.`
    }</p>
</section>`;
    return respond(status, layout('Sign in', content, null), {}, cookies);
  }

  function keyRows(keys: SlotlockApiKey[], token: string, session: Session): Html[] {
    return keys.map((key) => {
      const expired = key.expiresAt !== null && key.expiresAt.getTime() <= now();
      const status = key.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active';
      const actions =
        status === 'Active'
          ? html`<details class="act"><summary>Rotate</summary><div class="pop"><p>A new secret replaces this one at once. The key keeps its name, access and bookings.</p>
<form method="post" action="${root}/keys/rotate"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${key.id}"><button type="submit">Rotate key</button></form></div></details>
<details class="act danger"><summary>Revoke</summary><div class="pop"><p>Requests with this key fail at once. What it booked stays on the calendar.</p>
<form method="post" action="${root}/keys/revoke"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${key.id}"><button class="danger" type="submit">Revoke key</button></form></div></details>`
          : html``;
      return html`<tr>
<td data-label="Name" class="strong">${key.name}</td>
<td data-label="Key"><code>${key.prefix}…</code></td>
<td data-label="Access">${key.scopes.includes('admin') ? 'Full' : key.scopes.includes('write') ? 'Read and write' : 'Read only'}</td>
<td data-label="Created">${formatDate(key.createdAt)}</td>
${served ? html`<td data-label="Created by">${key.createdBy === personOf(session) ? 'You' : key.createdBy?.startsWith('github:') ? `GitHub user ${key.createdBy.slice(7)}` : 'Unknown'}</td>` : html``}
<td data-label="Last used">${key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}</td>
<td data-label="Expires">${key.expiresAt ? formatDate(key.expiresAt) : 'Never'}</td>
<td data-label="Status"><span class="pill ${status.toLowerCase()}">${status}</span></td>
<td class="actions">${actions}</td>
</tr>`;
    });
  }

  const pageHead = (title: string, action?: Html) =>
    html`<header class="page-head"><h1>${title}</h1>${action ?? html``}</header>`;

  /** A resource as people name it: its reference, else the start of its id. */
  const resourceName = (resource: SlotlockResource | undefined, id: string) =>
    resource?.externalRef ?? `${id.slice(0, 8)}…`;

  function agendaPanel(
    entries: readonly SlotlockAgendaEntry[],
    byId: ReadonlyMap<string, SlotlockResource>,
    more: boolean,
  ): Html {
    if (entries.length === 0) {
      return html`<p class="empty">Nothing booked in the next ${String(AGENDA_DAYS)} days.</p>`;
    }
    const zones = new Set(entries.map((entry) => byId.get(entry.resourceId)?.timezone ?? 'UTC'));
    const groups = new Map<string, { label: string; rows: Html[] }>();
    for (const entry of entries.slice(0, AGENDA_SHOWN)) {
      const resource = byId.get(entry.resourceId);
      const zone = resource?.timezone ?? 'UTC';
      const day = dayLabel(entry.start, zone, now());
      const group = groups.get(day.key) ?? { label: day.label, rows: [] };
      const name = resourceName(resource, entry.resourceId);
      // An event by its summary; a booking or hold by what it occupies, and a booking's own
      // reference when it is one a person chose (not the id Slotlock gave it).
      const title = entry.kind === 'event' ? (entry.summary ?? name) : name;
      const meta = [
        entry.kind === 'event' ? name : null,
        entry.reference && !UUID_PATTERN.test(entry.reference) ? entry.reference : null,
        zones.size > 1 ? zone : null,
        entry.source && !entry.source.startsWith('calendar-event:') ? entry.source : null,
      ].filter((part): part is string => part !== null);
      const pill =
        entry.kind === 'hold' && entry.expiresAt
          ? html`<span class="pill held">Held until ${clock(entry.expiresAt, zone)}</span>`
          : html`<span class="pill ${entry.kind}">${entry.kind === 'event' ? 'Event' : 'Booked'}</span>`;
      group.rows.push(html`<li class="slot"><span class="when">${clock(entry.start, zone)}<span class="until">${clock(entry.end, zone)}</span></span><span class="what"><span class="title">${title}</span>${meta.length > 0 ? html`<span class="meta">${meta.join(' · ')}</span>` : html``}</span>${pill}</li>`);
      groups.set(day.key, group);
    }
    return html`${[...groups.values()].map(
      (group) => html`<h3 class="day">${group.label}</h3><ul class="slots">${group.rows}</ul>`,
    )}${more ? html`<p class="fine">Showing the first ${String(AGENDA_SHOWN)}.</p>` : html``}`;
  }

  function activityPanel(
    changes: readonly SlotlockChange[],
    byId: ReadonlyMap<string, SlotlockResource>,
    keys: readonly SlotlockApiKey[],
    session: Session,
  ): Html {
    if (changes.length === 0) {
      return html`<p class="empty">No activity yet. What agents book, move and cancel shows here.</p>`;
    }
    const keyNames = new Map(keys.map((key) => [`api_key:${key.id}`, key.name]));
    return html`<ol class="feed">${changes.map((change) => {
      const label = CHANGE_LABELS[change.type] ?? { text: change.type, tone: 'neutral' };
      const who =
        change.actor === null
          ? brandName
          : change.actor === personOf(session)
            ? 'You'
            : (keyNames.get(change.actor) ??
              (change.actor.startsWith('api_key:')
                ? 'A deleted key'
                : /^github:\d+$/.test(change.actor)
                  ? `GitHub user ${change.actor.slice(7)}`
                  : /^dashboard-assistant:github:\d+$/.test(change.actor)
                    ? change.actor === assistantActor(session)
                      ? `Assistant for @${session.login}`
                      : `Assistant for GitHub user ${change.actor.slice(27)}`
                    : change.actor.slice(0, 60)));
      const where = change.resourceId
        ? resourceName(byId.get(change.resourceId), change.resourceId)
        : null;
      return html`<li class="event"><span class="dot ${label.tone}" aria-hidden="true"></span><span class="what"><span class="title">${label.text}${where ? html` <span class="on">on</span> ${where}` : html``}</span><span class="meta">${who} · <time datetime="${change.occurredAt.toISOString()}" title="${formatDate(change.occurredAt)}">${ago(change.occurredAt, now())}</time></span></span></li>`;
    })}</ol>`;
  }

  async function overviewPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const tenantRef = tenantOf(session);
    const start = new Date(now());
    const window = { start, end: new Date(start.getTime() + AGENDA_DAYS * DAY_MS) };
    const [keys, resources, agenda, changes] = await Promise.all([
      options.keys.list({ tenantRef }),
      options.resources.list(tenantRef),
      options.resources.agenda?.(tenantRef, window, AGENDA_LIMIT),
      options.resources.recentChanges?.(tenantRef, ACTIVITY_LIMIT),
    ]);
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    const active = keys.filter(
      (key) => !key.revokedAt && (key.expiresAt === null || key.expiresAt.getTime() > now()),
    );
    const counted = (count: number) =>
      agenda && agenda.length >= AGENDA_LIMIT ? `${count}+` : String(count);
    const booked = agenda?.filter((entry) => entry.kind !== 'hold').length ?? 0;
    const held = agenda?.filter((entry) => entry.kind === 'hold').length ?? 0;
    const stat = (label: string, value: string, href: string) =>
      html`<a class="stat" href="${href}"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></a>`;
    const steps = [
      { done: resources.length > 0, text: 'Add what your agents book', href: `${root}/resources` },
      { done: active.length > 0, text: 'Create a key for an agent', href: `${root}/keys` },
      { done: (changes?.length ?? 0) > 0, text: 'Connect the agent and book', href: `${root}/keys` },
    ];
    const content = html`${noticeOf(notice)}
${pageHead('Overview')}
${
  steps.every((step) => step.done)
    ? html``
    : html`<section class="panel setup"><h2>Get started</h2><ol class="steps">${steps.map(
        (step) =>
          html`<li class="${step.done ? 'done' : ''}"><span class="check" aria-hidden="true">${step.done ? ICONS.check : html``}</span>${step.done ? html`<span>${step.text}</span>` : html`<a href="${step.href}">${step.text}</a>`}${step.done ? html`<span class="visually-hidden">(done)</span>` : html``}</li>`,
      )}</ol></section>`
}
<div class="stats">
${agenda ? stat(`Booked, next ${AGENDA_DAYS} days`, counted(booked), `${root}#upcoming`) : html``}
${agenda ? stat('Live holds', counted(held), `${root}#upcoming`) : html``}
${stat('Resources', String(resources.length), `${root}/resources`)}
${stat('Active keys', String(active.length), `${root}/keys`)}
</div>
<div class="split">
${agenda ? html`<section class="panel" id="upcoming"><h2>Upcoming</h2>${agendaPanel(agenda, byId, agenda.length > AGENDA_SHOWN)}</section>` : html``}
${changes ? html`<section class="panel"><h2>Agent activity</h2>${activityPanel(changes, byId, keys, session)}</section>` : html``}
</div>`;
    return respond(status, layout('Overview', content, session, 'overview'));
  }

  function endpoints(): Html {
    return html`<dl class="endpoints"><dt>MCP</dt><dd><code id="mcp-url">${mcpUrl}</code><button class="quiet" type="button" data-copy="mcp-url">Copy</button></dd><dt>A2A</dt><dd><code id="a2a-url">${a2aUrl}</code><button class="quiet" type="button" data-copy="a2a-url">Copy</button></dd></dl>`;
  }

  async function keysPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const keys = await options.keys.list({ tenantRef: tenantOf(session) });
    const token = csrfToken(session);
    const content = html`${noticeOf(notice)}
${pageHead('API keys')}
<section class="panel">
<h2>Connect an agent</h2>
<p>Agents call ${brandName} over MCP or A2A with a key: <code>Authorization: Bearer slk_…</code></p>
${endpoints()}
</section>
<section class="panel">
<h2>New key</h2>
<form class="create" method="post" action="${root}/keys">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<label>Name<input name="name" required maxlength="100" placeholder="Booking agent"></label>
<label>Access<select name="access"><option value="read_write">Read and write</option><option value="read">Read only</option><option value="full">Full, with the application API</option></select></label>
<label>Expires<select name="expires"><option value="90">In 90 days</option><option value="30">In 30 days</option><option value="365">In a year</option><option value="never">Never</option></select></label>
<button class="primary" type="submit">Create key</button>
</form>
</section>
${
  keys.length === 0
    ? html`<p class="empty">No keys yet. Give every agent its own, with the least access it needs.</p>`
    : served
      ? html`<p class="fine">Each key acts in this organization only, and every member can rotate or revoke it.</p><div class="table"><table><thead><tr><th>Name</th><th>Key</th><th>Access</th><th>Created</th><th>Created by</th><th>Last used</th><th>Expires</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
<tbody>${keyRows(keys, token, session)}</tbody></table></div>`
    : html`<div class="table"><table><thead><tr><th>Name</th><th>Key</th><th>Access</th><th>Created</th><th>Last used</th><th>Expires</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
<tbody>${keyRows(keys, token, session)}</tbody></table></div>`
}`;
    return respond(status, layout('API keys', content, session, 'keys'));
  }

  async function resourcesPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const resources = await options.resources.list(tenantOf(session));
    const token = csrfToken(session);
    const content = html`${noticeOf(notice)}
${pageHead('Resources', resources.length > 0 ? html`<a class="button" href="${root}/hours">Set hours for every resource</a>` : undefined)}
<section class="panel">
<h2>Add a resource</h2>
<form class="create" method="post" action="${root}/resources">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<label>Reference<input name="reference" required maxlength="200" placeholder="vehicle-42"></label>
<label>Time zone<input name="timezone" required maxlength="64" value="UTC" placeholder="Europe/London"></label>
<button class="primary" type="submit">Add resource</button>
</form>
<p class="fine">${String(resources.length)} of ${String(SLOTLOCK_DASHBOARD_MAX_RESOURCES)}. Adding a reference you have changes its time zone.</p>
</section>
${
  resources.length === 0
    ? html`<p class="empty">No resources yet. Agents can only book what is listed here.</p>`
    : html`<div class="table"><table><thead><tr><th>Reference</th><th>Time zone</th><th>Bookable hours</th><th>Resource id</th></tr></thead><tbody>${resources.map(
        (resource) =>
          html`<tr><td data-label="Reference" class="strong"><span class="cell"><a href="${root}/resources/${resource.id}">${resourceName(resource, resource.id)}</a>${resource.pool ? html`<span class="meta">Pool ${resource.pool}</span>` : html``}</span></td><td data-label="Time zone">${resource.timezone}</td><td data-label="Bookable hours">${hoursSummary(resource.availabilityRules)} <a href="${root}/hours?resource=${resource.id}">Set hours</a></td><td data-label="Resource id"><code class="muted">${resource.id}</code></td></tr>`,
      )}</tbody></table></div>`
}`;
    return respond(status, layout('Resources', content, session, 'resources'));
  }

  async function settingsPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const rules = options.availability ?? [];
    const current = session.orgs?.find((org) => org.id === session.org);
    const content = html`${noticeOf(notice)}
${pageHead('Settings')}
${await assistantSettingsPanel(session)}
<section class="panel">
<h2>Endpoints</h2>
${endpoints()}
</section>
<section class="panel">
<h2>Server hours</h2>
${
  rules.length === 0
    ? html`<p class="empty">None: agents find a free slot only on resources with hours of their own.</p>`
    : html`<ul class="hours">${rules.map(
        (rule) =>
          html`<li>${daysOf(rule.rrule)}: ${hoursOf(rule.startMinutes, rule.durationMinutes)}</li>`,
      )}</ul>`
}
<p class="fine">For resources without hours of their own, in each resource's time zone. Set by the server's operator.</p>
</section>
<section class="panel">
<h2>Account</h2>
<dl class="facts"><dt>Signed in as</dt><dd>@${session.login}</dd>${
      current
        ? html`<dt>Organization</dt><dd>${current.login}</dd>${(session.orgs?.length ?? 0) > 1 ? html`<dt>Also a member of</dt><dd>${(session.orgs ?? []).filter((org) => org.id !== current.id).map((org) => org.login).join(', ')}</dd>` : html``}`
        : html`<dt>Workspace</dt><dd>Personal</dd>`
    }<dt>Session ends</dt><dd>${formatDate(new Date(session.exp))}</dd></dl>
${current ? html`<p class="fine">Membership is read from GitHub when you sign in.</p>` : html``}
</section>`;
    return respond(status, layout('Settings', content, session, 'settings'));
  }

  /** The tenant's resource with that id and every resource (for names), or null for anything else. */
  async function resourceDetailPage(
    session: Session,
    id: string,
    status = 200,
    notice?: string,
  ): Promise<Response> {
    const tenantRef = tenantOf(session);
    const resource = await ownResource(session, id);
    if (!resource) return notFound(session);
    const start = new Date(now());
    const window = { start, end: new Date(start.getTime() + AGENDA_DAYS * DAY_MS) };
    const [agenda, changes, keys, defaults] = await Promise.all([
      options.resources.agenda?.(tenantRef, window, AGENDA_LIMIT),
      options.resources.recentChanges?.(tenantRef, 100),
      options.keys.list({ tenantRef }),
      options.resources.ruleDefaults?.(tenantRef),
    ]);
    const byId = new Map([[resource.id, resource]]);
    const mine = agenda?.filter((entry) => entry.resourceId === resource.id);
    const activity = changes?.filter((change) => change.resourceId === resource.id).slice(0, 10);
    const token = csrfToken(session);
    const rules = resource.bookingRules ?? {};
    const inherited = inheritedRules(resource, defaults);
    const field = (name: keyof typeof RULE_FIELDS, label: string, unit: string) => {
      const from = inherited.get(name);
      return html`<label>${label}<span class="unit-input"><input type="number" inputmode="numeric" min="${String(RULE_LIMITS[name][0])}" max="${String(RULE_LIMITS[name][1])}" name="${RULE_FIELDS[name]}" value="${rules[name] === undefined ? '' : String(rules[name])}"${from ? html` placeholder="${String(from.value)}"` : html``}><span>${unit}</span></span></label>`;
    };
    // On or off: a checkbox, or, once a default sets it (or the resource turned it off), a choice
    // of the default, on or off, so a resource can turn an inherited rule off.
    const toggle = (name: 'enforceHours' | 'requireCertain', key: string, label: string) => {
      const from = inherited.get(name);
      if (from === undefined && rules[name] !== false) {
        return html`<label class="choice"><input type="checkbox" name="${key}" value="1"${rules[name] ? html` checked` : html``}> ${label}</label>`;
      }
      const chosen = (value: boolean | undefined) => (rules[name] === value ? html` selected` : html``);
      const fallback = from ? `As its default (${from.value ? 'on' : 'off'}, ${from.from})` : 'Off';
      return html`<label>${label}<select name="${key}"><option value=""${chosen(undefined)}>${fallback}</option><option value="1"${chosen(true)}>On</option><option value="0"${chosen(false)}>Off</option></select></label>`;
    };
    const content = html`${noticeOf(notice)}
<p><a class="back" href="${root}/resources">Resources</a></p>
${pageHead(resourceName(resource, resource.id))}
<dl class="facts"><dt>Time zone</dt><dd>${resource.timezone}</dd><dt>Bookable hours</dt><dd>${hoursSummary(resource.availabilityRules)} <a href="${root}/hours?resource=${resource.id}">Set hours</a></dd><dt>Resource id</dt><dd><code class="muted">${resource.id}</code></dd></dl>
<div class="split">
<div class="stack">
${
  options.resources.setRules
    ? html`<section class="panel">
<h2>Booking rules</h2>
<form method="post" action="${root}/resources/rules">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<input type="hidden" name="id" value="${resource.id}">
<div class="grid-form">
${field('minNoticeMinutes', 'Minimum notice', 'min')}
${field('maxAdvanceDays', 'Book up to', 'days ahead')}
${field('slotStepMinutes', 'Start on a step of', 'min')}
${field('stepOffsetMinutes', 'Steps start past each step by', 'min')}
${field('bufferBeforeMinutes', 'Kept free before each booking', 'min')}
${field('turnaroundMinutes', 'Turnaround after each booking', 'min')}
${field('checkInMinutes', 'Release if not checked in after', 'min')}
</div>
${toggle('enforceHours', 'enforce_hours', 'Only inside bookable hours')}
${toggle('requireCertain', 'require_certain', 'Only in time its calendar syncs have read today')}
${inheritedNote(inherited)}
<p class="fine">Leave a field empty for no rule${inherited.size > 0 ? ' of its own' : ''}.</p>
<button class="primary" type="submit">Save rules</button>
</form>
</section>`
    : html``
}
${
  options.resources.setPool
    ? html`<section class="panel">
<h2>Pool</h2>
<form class="create" method="post" action="${root}/resources/pool">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<input type="hidden" name="id" value="${resource.id}">
<label>Pool name<input name="pool" maxlength="100" value="${resource.pool ?? ''}" placeholder="suv"></label>
<button type="submit">Save pool</button>
</form>
<p class="fine">Agents can book any free member of a pool. Leave it empty for none.</p>
</section>`
    : html``
}
</div>
<div class="stack">
${mine ? html`<section class="panel"><h2>Upcoming</h2>${agendaPanel(mine, byId, mine.length > AGENDA_SHOWN)}</section>` : html``}
${activity ? html`<section class="panel"><h2>Activity</h2>${activityPanel(activity, byId, keys, session)}</section>` : html``}
</div>
</div>`;
    return respond(status, layout(resourceName(resource, resource.id), content, session, 'resources'));
  }

  async function saveRules(session: Session, form: URLSearchParams): Promise<Response> {
    const id = form.get('id') ?? '';
    const resource = await ownResource(session, id);
    if (!resource || !options.resources.setRules) return notFound(session);
    const rules: SlotlockBookingRules = {};
    for (const [name, key] of Object.entries(RULE_FIELDS) as [keyof typeof RULE_FIELDS, string][]) {
      const value = (form.get(key) ?? '').trim();
      if (value === '') continue;
      const [min, max] = RULE_LIMITS[name];
      if (!/^\d{1,7}$/.test(value) || Number(value) < min || Number(value) > max) {
        return resourceDetailPage(
          session,
          id,
          400,
          `${RULE_NAMES[name]} is a whole number from ${min.toLocaleString('en')} to ${max.toLocaleString('en')}. Leave it empty for none.`,
        );
      }
      rules[name] = Number(value);
    }
    // '1' on, '0' off (over a default that is on), anything else not set.
    const choice = (key: string) => {
      const value = form.get(key);
      return value === '1' ? true : value === '0' ? false : undefined;
    };
    const enforceHours = choice('enforce_hours');
    if (enforceHours !== undefined) rules.enforceHours = enforceHours;
    const requireCertain = choice('require_certain');
    if (requireCertain !== undefined) rules.requireCertain = requireCertain;
    try {
      await options.resources.setRules(
        tenantOf(session),
        id,
        Object.keys(rules).length === 0 ? null : rules,
        personOf(session),
      );
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'invalid_booking_rules') throw error;
      return resourceDetailPage(session, id, 400, 'Those rules are not ones Slotlock can keep.');
    }
    return redirect(303, `${root}/resources/${id}`);
  }

  async function savePool(session: Session, form: URLSearchParams): Promise<Response> {
    const id = form.get('id') ?? '';
    const resource = await ownResource(session, id);
    if (!resource || !options.resources.setPool) return notFound(session);
    const pool = (form.get('pool') ?? '').trim();
    try {
      await options.resources.setPool(
        tenantOf(session),
        id,
        pool === '' ? null : pool,
        personOf(session),
      );
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'invalid_pool') throw error;
      return resourceDetailPage(
        session,
        id,
        400,
        'A pool name is 1 to 100 letters, digits, dots, dashes or underscores.',
      );
    }
    return redirect(303, `${root}/resources/${id}`);
  }

  function endpointState(endpoint: SlotlockWebhookEndpoint): { text: string; tone: string } {
    if (endpoint.disabledAt) return { text: 'Disabled', tone: 'revoked' };
    if (endpoint.failingSince) return { text: 'Failing', tone: 'held' };
    return { text: 'Delivering', tone: 'active' };
  }

  async function webhooksPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const hooks = options.resources.webhooks;
    if (!hooks) return notFound(session);
    const endpoints = await hooks.list(tenantOf(session));
    const token = csrfToken(session);
    const failing = endpoints.filter((endpoint) => endpoint.failingSince && !endpoint.disabledAt);
    const disabled = endpoints.filter((endpoint) => endpoint.disabledAt);
    const rows = endpoints.map((endpoint) => {
      const state = endpointState(endpoint);
      const problem = endpoint.disabledAt
        ? `${endpoint.disabledReason ?? 'Disabled'} (${formatDate(endpoint.disabledAt)})`
        : endpoint.failingSince
          ? `Since ${formatDate(endpoint.failingSince)}, ${String(endpoint.attempts)} attempts${endpoint.lastStatus ? `, last HTTP ${endpoint.lastStatus}` : ''}${endpoint.lastError ? `: ${endpoint.lastError.slice(0, 120)}` : ''}`
          : '';
      return html`<tr>
<td data-label="URL" class="strong wrap"><code>${endpoint.url}</code></td>
<td data-label="Events">${endpoint.eventTypes ? endpoint.eventTypes.join(', ') : 'All'}</td>
<td data-label="Status"><span class="cell"><span class="pill ${state.tone}">${state.text}</span>${problem ? html`<span class="meta wrap">${problem}</span>` : html``}</span></td>
<td data-label="Added">${formatDate(endpoint.createdAt)}</td>
<td class="actions">${
        endpoint.disabledAt
          ? html`<form class="inline" method="post" action="${root}/webhooks/enable"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${endpoint.id}"><button type="submit">Enable</button></form>`
          : html``
      }<details class="act danger"><summary>Delete</summary><div class="pop"><p>Nothing more is sent to it. The feed keeps its changes.</p>
<form method="post" action="${root}/webhooks/delete"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${endpoint.id}"><button class="danger" type="submit">Delete webhook</button></form></div></details></td>
</tr>`;
    });
    const content = html`${noticeOf(notice)}
${pageHead('Webhooks')}
<div class="stats">
<div class="stat"><span class="stat-label">Endpoints</span><span class="stat-value">${String(endpoints.length)}</span></div>
<div class="stat"><span class="stat-label">Failing</span><span class="stat-value">${String(failing.length)}</span></div>
<div class="stat"><span class="stat-label">Disabled</span><span class="stat-value">${String(disabled.length)}</span></div>
</div>
<section class="panel">
<h2>Add an endpoint</h2>
<form method="post" action="${root}/webhooks">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<label>URL<input name="url" type="url" required maxlength="2048" placeholder="https://example.com/slotlock"></label>
<details class="types"><summary>Events: all, or choose</summary><div class="checks">${SLOTLOCK_CHANGE_TYPES.map(
      (type) =>
        html`<label class="choice"><input type="checkbox" name="event_type" value="${type}"> <code>${type}</code></label>`,
    )}</div></details>
<button class="primary" type="submit">Add endpoint</button>
</form>
<p class="fine">Signed as Standard Webhooks with a secret shown once. An endpoint failing for a day is disabled.</p>
</section>
${
  endpoints.length === 0
    ? html`<p class="empty">No webhooks. Add one to hear about bookings as they change.</p>`
    : html`<div class="table"><table><thead><tr><th>URL</th><th>Events</th><th>Status</th><th>Added</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
}`;
    return respond(status, layout('Webhooks', content, session, 'webhooks'));
  }

  async function addWebhook(session: Session, form: URLSearchParams): Promise<Response> {
    const hooks = options.resources.webhooks;
    if (!hooks) return notFound(session);
    const types = form.getAll('event_type');
    const created = await hooks.create(
      tenantOf(session),
      (form.get('url') ?? '').trim(),
      types.length === 0 ? undefined : types,
      personOf(session),
    );
    if (!created.ok) {
      const message =
        created.code === 'webhook_limit_reached'
          ? `You have ${String(created.limit)} webhooks, as many as Slotlock allows. Delete one first.`
          : created.code === 'invalid_webhook_url'
            ? 'Give an https URL, with no user name, password or #fragment.'
            : 'Choose events from the list.';
      return webhooksPage(session, created.code === 'webhook_limit_reached' ? 409 : 400, message);
    }
    const content = html`<section class="card once">
<h1>Webhook added</h1>
<p><code>${created.endpoint.url}</code></p>
<p class="notice warn" role="alert">Copy the signing secret now. It will not be shown again.</p>
<div class="copy"><input id="secret" readonly value="${created.secret}" aria-label="Signing secret"><button type="button" data-copy="secret">Copy</button></div>
<p>Verify each delivery's <code>webhook-signature</code> with it, using a Standard Webhooks library.</p>
<a class="button primary" href="${root}/webhooks">Done</a>
</section>`;
    return respond(200, layout('Webhook added', content, session, 'webhooks'));
  }

  async function changeWebhook(
    session: Session,
    form: URLSearchParams,
    change: 'remove' | 'enable',
  ): Promise<Response> {
    const hooks = options.resources.webhooks;
    if (!hooks) return notFound(session);
    const id = form.get('id') ?? '';
    if (change === 'remove') {
      if (!(await hooks.remove(tenantOf(session), id, personOf(session)))) {
        return webhooksPage(session, 404, 'That webhook is not one of yours.');
      }
      return redirect(303, `${root}/webhooks`);
    }
    const enabled = await hooks.enable(tenantOf(session), id, personOf(session));
    if (enabled === null) return webhooksPage(session, 404, 'That webhook is not one of yours.');
    if ('code' in enabled) {
      return webhooksPage(
        session,
        409,
        'It missed changes older than the feed keeps. Delete it, add it again, and read what it missed from the feed.',
      );
    }
    return redirect(303, `${root}/webhooks`);
  }

  async function waitlistPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const waitlist = options.resources.waitlist;
    if (!waitlist) return notFound(session);
    const tenantRef = tenantOf(session);
    const [entries, resources] = await Promise.all([
      waitlist.list(tenantRef, WAITLIST_SHOWN),
      options.resources.list(tenantRef),
    ]);
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    const token = csrfToken(session);
    const rows = entries.map((entry) => {
      const resource = entry.resourceId ? byId.get(entry.resourceId) : undefined;
      const zone = resource?.timezone ?? 'UTC';
      const day = dayLabel(entry.start, zone, now());
      const what = entry.resourceId
        ? resourceName(resource, entry.resourceId)
        : `Pool ${entry.pool ?? ''}`;
      const offered = entry.offeredResourceId
        ? resourceName(byId.get(entry.offeredResourceId), entry.offeredResourceId)
        : null;
      const tone = entry.status === 'offered' ? 'active' : entry.status === 'expired' ? 'revoked' : 'held';
      return html`<tr>
<td data-label="When" class="strong">${day.label} ${clock(entry.start, zone)}–${clock(entry.end, zone)}</td>
<td data-label="For">${what}</td>
<td data-label="Holder"><code>${entry.holderRef}</code></td>
<td data-label="Status"><span class="cell"><span class="pill ${tone}">${entry.status === 'offered' ? 'Offered' : entry.status === 'expired' ? 'Expired' : 'Waiting'}</span>${offered && entry.offeredAt ? html`<span class="meta">${offered}, ${ago(entry.offeredAt, now())}</span>` : html``}</span></td>
<td data-label="Joined">${ago(entry.createdAt, now())}</td>
<td class="actions"><details class="act danger"><summary>Remove</summary><div class="pop"><p>${entry.status === 'offered' ? 'Its offered hold is released and offered to the next.' : 'It stops waiting.'}</p>
<form method="post" action="${root}/waitlist/leave"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="id" value="${entry.id}"><button class="danger" type="submit">Remove entry</button></form></div></details></td>
</tr>`;
    });
    const waiting = entries.filter((entry) => entry.status === 'waiting').length;
    const offered = entries.filter((entry) => entry.status === 'offered').length;
    const content = html`${noticeOf(notice)}
${pageHead('Waitlist')}
<div class="stats">
<div class="stat"><span class="stat-label">Waiting</span><span class="stat-value">${String(waiting)}</span></div>
<div class="stat"><span class="stat-label">Offered</span><span class="stat-value">${String(offered)}</span></div>
</div>
${
  entries.length === 0
    ? html`<p class="empty">Nobody is waiting. Agents add entries when the time they want is taken.</p>`
    : html`<div class="table"><table><thead><tr><th>When</th><th>For</th><th>Holder</th><th>Status</th><th>Joined</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>${entries.length >= WAITLIST_SHOWN ? html`<p class="fine">Showing the first ${String(WAITLIST_SHOWN)}.</p>` : html``}`
}`;
    return respond(status, layout('Waitlist', content, session, 'waitlist'));
  }

  async function leaveWaitlist(session: Session, form: URLSearchParams): Promise<Response> {
    const waitlist = options.resources.waitlist;
    if (!waitlist) return notFound(session);
    if (!(await waitlist.leave(tenantOf(session), form.get('id') ?? '', personOf(session)))) {
      return waitlistPage(session, 404, 'That entry is not on your waitlist.');
    }
    return redirect(303, `${root}/waitlist`);
  }


  // ---- The assistant ----

  const assistantOptions = options.assistant;
  /** The assistant's records, when the assistant is on and the adapter keeps them. Per request (Workers). */
  const assistantStore = (): SlotlockAssistantStore | undefined =>
    assistantOptions ? options.resources.assistant : undefined;
  const privateUrls = assistantOptions?.privateUrls === true;
  const assistantFetch =
    assistantOptions?.fetch ?? createSlotlockGuardedFetch({ allowPrivateNetworks: privateUrls });
  const resolveHost =
    assistantOptions?.resolve ??
    (async (hostname: string) =>
      (await dnsLookup(hostname, { all: true })).map(({ address }) => address));
  const PRIVATE_URL_REFUSAL =
    'That URL is, or resolves to, a local or private network address (loopback, private, link-local, shared, unique-local or cloud metadata), which this server does not reach. For a model on its own machine or network, the server’s operator can allow them with SLOTLOCK_ASSISTANT_PRIVATE_URLS=on.';
  const assistantTimeout = assistantOptions?.timeoutMs ?? 30_000;
  const assistantTurnTimeout = assistantOptions?.turnTimeoutMs ?? 90_000;
  const conversationTtl = assistantOptions?.conversationTtlMs ?? 2 * 3_600_000;
  if (assistantOptions && Buffer.byteLength(assistantOptions.secret, 'utf8') < 32) {
    throw new Error('Slotlock dashboard assistant secret must be at least 32 bytes');
  }
  if (assistantOptions && assistantOptions.secret === options.sessionSecret) {
    throw new Error('Slotlock dashboard assistant secret must differ from the session secret');
  }
  const memberMessages = createSlotlockRateLimiter(
    assistantOptions?.rate ?? { perSecond: 10 / 60, burst: 10 },
    now,
  );
  const toolTitles = new Map(slotlockAgentTools().map((tool) => [tool.name as string, tool.title]));
  /** The writes that take an idempotency key: the dashboard sets it, from the action's id. */
  const keyed = new Set(
    slotlockAgentTools()
      .filter((tool) => 'idempotency_key' in ((tool.inputSchema as { properties?: object }).properties ?? {}))
      .map((tool) => tool.name as string),
  );
  const ACTION_ID = /^[A-Za-z0-9_-]{16}$/;
  /** Reads one member message may make, and the resource-days they may cover together. */
  const MAX_READS_PER_TURN = 16;
  const MAX_READ_COST_PER_TURN = 400;
  /** What a read costs the turn: the resources it names times the days its window spans. */
  const readCostOf = (input: unknown): number => {
    if (!isRecord(input)) return 1;
    const ids = Array.isArray(input.resource_ids) ? input.resource_ids.length : 1;
    const start = typeof input.start === 'string' ? Date.parse(input.start) : Number.NaN;
    const end = typeof input.end === 'string' ? Date.parse(input.end) : Number.NaN;
    const days = Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.ceil((end - start) / DAY_MS) : 1;
    return Math.max(1, ids) * Math.max(1, days);
  };
  /**
   * Who the assistant acts as, for the record and for ownership: the member by GitHub user id,
   * which a rename does not change. Shown as "Assistant for @login".
   */
  const assistantActor = (session: Session) => `dashboard-assistant:github:${session.uid}`;
  const CONFIRMED_WRITES: ReadonlySet<string> = new Set<SlotlockAgentWriteOperation>([
    'slotlock_create_event',
    'slotlock_update_event',
    'slotlock_delete_event',
    'slotlock_book_together',
    'slotlock_book_pool',
  ]);

  /**
   * The sentence a proposed change's card leads with: the agent server's confirmation question
   * (the resource by name, the times in its zone, an event as it stands: its title, resource and
   * time), or for holds the slots by resource. Read as the member's assistant, under `authorize`.
   */
  async function summarize(
    session: Session,
    operation: SlotlockAgentOperation,
    input: Record<string, unknown>,
  ): Promise<string> {
    const assistant = assistantOptions as SlotlockDashboardAssistantOptions;
    let text: string;
    if (CONFIRMED_WRITES.has(operation)) {
      text = await describeSlotlockAgentWrite({
        backend: assistant.backend,
        authorize: assistantAuthorize,
        principal: assistantPrincipal(session),
        operation: operation as SlotlockAgentWriteOperation,
        input,
        signal: AbortSignal.timeout(assistantTimeout),
      }).catch(() => '');
    } else if (operation === 'slotlock_hold_slots' && Array.isArray(input.slots)) {
      const names = new Map(
        (await options.resources.list(tenantOf(session))).map((resource) => [resource.id, resourceName(resource, resource.id)]),
      );
      const slots = (input.slots as Array<Record<string, unknown>>).map(
        (slot) => `${names.get(String(slot.resource_id)) ?? `resource ${String(slot.resource_id)}`} ${String(slot.start)} to ${String(slot.end)}`,
      );
      text = `Hold ${slots.join('; ')} for ${String(input.ttl_seconds ?? '')} seconds, as alternatives.`;
    } else if (operation === 'slotlock_release_slots') {
      text = `Release the hold ${String(input.hold_id)} and every slot held with it.`;
    } else {
      text = '';
    }
    // At most 1,500 UTF-8 bytes, so four waiting changes stay within the conversation's bound.
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }

  /** Owners of the organization in use may change its assistant; a person always may their own. */
  const isAdmin = (session: Session) =>
    !served || session.orgs?.find((org) => org.id === session.org)?.role === 'admin';
  const assistantPrincipal = (session: Session): SlotlockAgentPrincipal => ({
    subject: assistantActor(session),
    tenantRef: tenantOf(session),
    scopes: ['read', 'write'],
  });
  /** The fixed list, then the embedder's check: nothing the model sends adds to it. */
  const assistantAuthorize: SlotlockAgentOperationDispatchOptions['authorize'] = async (args) =>
    SLOTLOCK_ASSISTANT_TOOL_USE[args.operation] !== 'excluded' &&
    (assistantOptions?.authorize ? await assistantOptions.authorize(args) : true);

  /**
   * One agent operation as the member's assistant. A `propose` call is checked as an agent's is
   * (arguments, scopes, authorize) and halted by `confirm` before it runs; it takes no admission
   * slot and no rate token, which the write takes when it runs, approved (`run`).
   */
  function dispatch(
    session: Session,
    operation: SlotlockAgentOperation,
    input: unknown,
    mode: 'run' | 'propose',
    confirm?: SlotlockAgentOperationDispatchOptions['confirm'],
  ): Promise<SlotlockAgentOperationDispatchResult> {
    const assistant = assistantOptions as SlotlockDashboardAssistantOptions;
    const principal = assistantPrincipal(session);
    return invokeSlotlockAgentOperation({
      operation,
      input,
      request: new Request(`${origin}${root}/assistant`, {
        signal: AbortSignal.timeout(assistantTimeout),
      }),
      options: {
        backend: assistant.backend,
        authenticate: async () => principal,
        authorize: async (args) => {
          if (!(await assistantAuthorize(args))) return false;
          if (mode === 'run') await assistant.admit?.(args);
          return true;
        },
        ...(assistant.consumeRateLimit && mode === 'run'
          ? { consumeRateLimit: assistant.consumeRateLimit }
          : {}),
        ...(confirm ? { confirm } : {}),
        onError: (error) => {
          try {
            ignoreRejection(options.onError?.(error));
          } catch {
            // A failing reporter must not change the answer.
          }
        },
      },
    });
  }

  async function assistantModel(
    session: Session,
  ): Promise<{ model: SlotlockAssistantModel } | { problem: string } | null> {
    const store = assistantStore();
    const settings = store ? await store.getSettings(tenantOf(session)) : null;
    if (!settings || !assistantOptions) return null;
    if (
      !slotlockAssistantUrlAllowed(settings.baseUrl, privateUrls) ||
      !(await checkSlotlockAssistantHost(settings.baseUrl, { privateUrls, resolve: resolveHost }))
    ) {
      return { problem: PRIVATE_URL_REFUSAL };
    }
    let apiKey: string | null = null;
    if (settings.sealedKey !== null) {
      apiKey = await openSlotlockAssistantKey(assistantOptions.secret, tenantOf(session), settings.sealedKey);
      if (apiKey === null) {
        return {
          problem:
            'The stored API key cannot be opened: the server’s assistant secret changed. An admin can enter the key again in Settings.',
        };
      }
    }
    return {
      model: { provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey },
    };
  }

  /**
   * A field of a proposed change, as the card shows it: all of it, wrapped, never cut (the
   * proposal is bounded instead). A resource is named, with its id beside the name.
   */
  function fieldValue(name: string, value: unknown, names: ReadonlyMap<string, string>): Html {
    const named = (id: string) => (names.has(id) ? `${names.get(id) as string} (${id})` : id);
    if (typeof value === 'string') {
      return html`<span class="wrap">${name === 'resource_id' ? named(value) : value}</span>`;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return html`<span class="wrap">${(value as string[]).map((item) => (name === 'resource_ids' ? named(item) : item)).join(', ')}</span>`;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      return html`${String(value)}`;
    }
    return html`<pre class="wrap">${JSON.stringify(value, null, 2)}</pre>`;
  }

  function actionCard(
    session: Session,
    action: SlotlockAssistantAction,
    names: ReadonlyMap<string, string>,
  ): Html {
    const token = csrfToken(session);
    const fields = Object.entries(action.input).filter(([name]) => name !== 'idempotency_key');
    const summary = action.summary ? html`<p class="action-summary">${action.summary}</p>` : html``;
    const state = {
      pending: { text: 'Waiting for you', tone: 'held' },
      approved: { text: 'Running', tone: 'held' },
      dismissed: { text: 'Dismissed', tone: 'revoked' },
      done: { text: 'Done', tone: 'active' },
      failed: { text: 'Failed', tone: 'revoked' },
    }[action.status] ?? { text: action.status, tone: 'revoked' };
    const buttons =
      action.status === 'pending'
        ? html`<div class="action-buttons"><form class="inline" method="post" action="${root}/assistant/approve"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="action" value="${action.id}"><button class="primary" type="submit">Approve</button></form><form class="inline" method="post" action="${root}/assistant/dismiss"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><input type="hidden" name="action" value="${action.id}"><button type="submit">Dismiss</button></form></div>`
        : html``;
    return html`<li class="action-card" id="action-${action.id}"><div class="action-head"><span class="title">${toolTitles.get(action.operation) ?? action.operation}</span><span class="pill ${state.tone}">${state.text}</span></div>${summary}<dl class="facts">${fields.map(
      ([name, value]) => html`<dt>${name.replaceAll('_', ' ')}</dt><dd>${fieldValue(name, value, names)}</dd>`,
    )}</dl>${action.status === 'failed' && action.outcome ? html`<p class="fine">Refused: <code>${action.outcome}</code></p>` : html``}${buttons}</li>`;
  }

  function readAction(id: string, value: unknown): SlotlockAssistantAction | null {
    if (!isRecord(value) || typeof value.operation !== 'string') return null;
    return {
      id,
      operation: value.operation as SlotlockAgentOperation,
      input: isRecord(value.input) ? value.input : {},
      ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
      status: (typeof value.status === 'string' ? value.status : 'failed') as SlotlockAssistantAction['status'],
      ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
    };
  }

  async function assistantPage(session: Session, status = 200, notice?: string): Promise<Response> {
    const store = assistantStore();
    if (!store) return notFound(session);
    const tenantRef = tenantOf(session);
    const [settings, conversation] = await Promise.all([
      store.getSettings(tenantRef),
      store.getConversation(tenantRef, personOf(session)),
    ]);
    const entries = readSlotlockAssistantEntries(conversation?.messages);
    const actions = conversation?.actions ?? {};
    const names = new Map<string, string>();
    if (Object.keys(actions).length > 0) {
      for (const resource of await options.resources.list(tenantRef)) {
        names.set(resource.id, resourceName(resource, resource.id));
      }
    }
    const token = csrfToken(session);
    const items: Html[] = [];
    for (const entry of entries) {
      if (entry.role === 'user') items.push(html`<li class="msg mine"><p>${entry.text}</p></li>`);
      else if (entry.role === 'assistant' && entry.text.trim() !== '') {
        items.push(html`<li class="msg bot"><p>${entry.text}</p></li>`);
      } else if (entry.role === 'note') items.push(html`<li class="notice">${entry.text}</li>`);
      else if (entry.role === 'tool') {
        for (const result of entry.results) {
          const action = result.action ? readAction(result.action, actions[result.action]) : null;
          if (action) items.push(actionCard(session, action, names));
          else {
            items.push(
              html`<li class="tool-line">${result.error ? 'Could not run' : 'Read'}: ${toolTitles.get(result.name) ?? result.name}</li>`,
            );
          }
        }
      }
    }
    const composer = html`<form class="composer" method="post" action="${root}/assistant"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><label class="visually-hidden" for="message">Message</label><textarea id="message" name="message" rows="3" maxlength="${String(SLOTLOCK_ASSISTANT_MAX_MESSAGE)}" required placeholder="Find a free van tomorrow morning and book it for Ana"></textarea><button class="primary" type="submit">Send</button></form>`;
    const reset =
      entries.length > 0
        ? html`<form class="inline" method="post" action="${root}/assistant/reset"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><button type="submit">New conversation</button></form>`
        : undefined;
    const content = html`${noticeOf(notice)}
${pageHead('Assistant', reset)}
${
  settings
    ? html`<section class="panel chat">${
        items.length === 0
          ? html`<p class="empty">Ask about bookings and free time. Changes wait for your approval.</p>`
          : html`<ol class="thread">${items}</ol>`
      }<span id="latest"></span>${composer}</section>`
    : html`<p class="empty">${
        isAdmin(session)
          ? html`No model is connected. <a href="${root}/settings#assistant">Connect one in Settings</a>.`
          : 'No model is connected. An admin of this organization can connect one in Settings.'
      }</p>`
}`;
    return respond(status, layout('Assistant', content, session, 'assistant'));
  }

  async function assistantSettingsPanel(session: Session): Promise<Html> {
    const store = assistantStore();
    if (!store) return html``;
    const settings = await store.getSettings(tenantOf(session));
    const sentTo = html`<p class="fine">Members' messages, and the bookings and resources the assistant reads for them, are sent to this provider.</p>`;
    if (!isAdmin(session)) {
      return html`<section class="panel" id="assistant"><h2>Assistant</h2>${
        settings
          ? html`<dl class="facts"><dt>Provider</dt><dd>${settings.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'}</dd><dt>Model</dt><dd>${settings.model}</dd></dl>${sentTo}`
          : html`<p class="empty">No model is connected. An admin can connect one.</p>`
      }</section>`;
    }
    const token = csrfToken(session);
    const selected = (provider: string) => (settings?.provider === provider ? html` selected` : html``);
    return html`<section class="panel" id="assistant">
<h2>Assistant</h2>
<form method="post" action="${root}/settings/assistant">
<input type="hidden" name="csrf" value="${token}">
<input type="hidden" name="once" value="${formNonce(session)}">
<div class="grid-form">
<label>Provider<select name="provider"><option value="anthropic"${selected('anthropic')}>Anthropic Messages API</option><option value="openai"${selected('openai')}>OpenAI-compatible</option></select></label>
<label>Base URL<input name="base_url" required maxlength="2048" value="${settings?.baseUrl ?? ''}" placeholder="https://api.anthropic.com"></label>
<label>Model<input name="model" required maxlength="200" value="${settings?.model ?? ''}" placeholder="your-model"></label>
<label>API key<input name="api_key" type="password" autocomplete="off" maxlength="4096" placeholder="${settings?.keyHint ? 'Leave empty to keep it' : 'Optional for a local model'}"></label>
</div>
<p class="fine">Key: ${settings?.keyHint ? html`set, ending in <code>${settings.keyHint}</code>` : 'none'}. OpenAI-compatible covers OpenAI, OpenRouter, vLLM, Ollama and LM Studio; give the URL that ends in <code>/v1</code>.</p>
${settings?.keyHint ? html`<label class="choice"><input type="checkbox" name="clear_key" value="1"> Remove the key</label>` : html``}
<button class="primary" type="submit">Save</button>
</form>
${sentTo}
${
  settings
    ? html`<div class="row-actions"><form class="inline" method="post" action="${root}/settings/assistant/test"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><button type="submit">Test connection</button></form><details class="act danger"><summary>Disconnect</summary><div class="pop"><p>Members can no longer chat. The key is deleted.</p><form method="post" action="${root}/settings/assistant/remove"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="once" value="${formNonce(session)}"><button class="danger" type="submit">Disconnect</button></form></div></details></div>`
    : html``
}
</section>`;
  }

  const adminOnly = (session: Session) =>
    settingsPage(session, 403, 'Only an owner of this organization can change the assistant.');

  async function saveAssistantSettings(session: Session, form: URLSearchParams): Promise<Response> {
    const store = assistantStore();
    if (!store || !assistantOptions) return notFound(session);
    if (!isAdmin(session)) return adminOnly(session);
    const provider = form.get('provider');
    const checkedUrl = readSlotlockAssistantBaseUrl(form.get('base_url') ?? '', { privateUrls });
    const model = (form.get('model') ?? '').trim();
    const apiKey = (form.get('api_key') ?? '').trim();
    if (provider !== 'anthropic' && provider !== 'openai') {
      return settingsPage(session, 400, 'Choose a provider from the list.');
    }
    if (!checkedUrl.ok) {
      return settingsPage(
        session,
        400,
        checkedUrl.reason === 'private'
          ? PRIVATE_URL_REFUSAL
          : 'Give an https base URL (http only for localhost or 127.0.0.1), with no user name, query or #fragment.',
      );
    }
    const baseUrl = checkedUrl.url;
    if (!(await checkSlotlockAssistantHost(baseUrl, { privateUrls, resolve: resolveHost }))) {
      return settingsPage(session, 400, PRIVATE_URL_REFUSAL);
    }
    if (!SLOTLOCK_ASSISTANT_MODEL_NAME.test(model)) {
      return settingsPage(session, 400, 'Give the model name, 1 to 200 characters without spaces.');
    }
    if (apiKey !== '' && !SLOTLOCK_ASSISTANT_API_KEY.test(apiKey)) {
      return settingsPage(session, 400, 'An API key is up to 4,096 characters without spaces.');
    }
    const tenantRef = tenantOf(session);
    const key =
      apiKey !== ''
        ? { sealed: await sealSlotlockAssistantKey(assistantOptions.secret, tenantRef, apiKey), hint: apiKey.slice(-4) }
        : form.get('clear_key') === '1'
          ? null
          : ('keep' as const);
    // The stored key is only kept for the provider and URL it was entered for: the store decides
    // that in the write itself, so an owner cannot send it elsewhere, however saves race.
    const { saved } = await store.putSettings(tenantRef, { provider, baseUrl, model, key }, personOf(session));
    if (!saved) {
      return settingsPage(
        session,
        400,
        'Enter the API key again: the provider or the base URL changed, and the stored key is only sent where it was entered for. Or remove the key.',
      );
    }
    return redirect(303, `${root}/settings#assistant`);
  }

  async function removeAssistantSettings(session: Session): Promise<Response> {
    const store = assistantStore();
    if (!store) return notFound(session);
    if (!isAdmin(session)) return adminOnly(session);
    await store.deleteSettings(tenantOf(session), personOf(session));
    return redirect(303, `${root}/settings#assistant`);
  }

  const tooManyMessages = (session: Session, page: typeof settingsPage) =>
    page(session, 429, 'You have sent the assistant a lot in the last minute. Wait a moment and try again.');

  async function testAssistant(session: Session): Promise<Response> {
    if (!assistantStore()) return notFound(session);
    if (!isAdmin(session)) return adminOnly(session);
    if (!memberMessages.take(`${tenantOf(session)}\0${session.uid}`)) {
      return tooManyMessages(session, settingsPage);
    }
    const found = await assistantModel(session);
    if (found === null) return settingsPage(session, 409, 'Connect a model first.');
    if ('problem' in found) return settingsPage(session, 409, found.problem);
    try {
      const ok = await testSlotlockAssistantModel({
        model: found.model,
        fetch: assistantFetch,
        timeoutMs: assistantTimeout,
      });
      return settingsPage(
        session,
        ok ? 200 : 502,
        ok
          ? `Connected: ${found.model.model} answered and called a tool correctly.`
          : `${found.model.model} answered, but did not call the tool it was given. Choose a model that supports tool calls.`,
      );
    } catch (error) {
      report(error instanceof Error ? error.message : 'assistant connection test failed');
      return settingsPage(session, 502, slotlockAssistantProviderMessage(error));
    }
  }

  async function sendToAssistant(session: Session, form: URLSearchParams): Promise<Response> {
    const store = assistantStore();
    if (!store || !assistantOptions) return notFound(session);
    const text = (form.get('message') ?? '').trim();
    if (text === '' || text.length > SLOTLOCK_ASSISTANT_MAX_MESSAGE) {
      return assistantPage(
        session,
        400,
        `Write a message of 1 to ${SLOTLOCK_ASSISTANT_MAX_MESSAGE.toLocaleString('en')} characters.`,
      );
    }
    if (!memberMessages.take(`${tenantOf(session)}\0${session.uid}`)) {
      return tooManyMessages(session, assistantPage);
    }
    const found = await assistantModel(session);
    if (found === null) return assistantPage(session, 409, 'No model is connected.');
    if ('problem' in found) return assistantPage(session, 409, found.problem);
    const tenantRef = tenantOf(session);
    const member = personOf(session);
    const stored = await store.getConversation(tenantRef, member);
    const entries = boundSlotlockAssistantEntries([
      ...readSlotlockAssistantEntries(stored?.messages),
      { role: 'user', text },
    ]);
    const proposed: Record<string, Record<string, unknown>> = {};
    const pendingBefore = pendingSlotlockAssistantActions(stored?.actions ?? {});
    let reads = 0;
    let readCost = 0;
    const current = session.orgs?.find((org) => org.id === session.org);
    const turn = await runSlotlockAssistantTurn({
      model: found.model,
      system: slotlockAssistantSystemPrompt({
        brand: brandName,
        workspace: current?.login ?? session.login,
        login: session.login,
        now: new Date(now()),
      }),
      entries,
      fetch: assistantFetch,
      timeoutMs: assistantTimeout,
      turnTimeoutMs: assistantTurnTimeout,
      ...(assistantOptions.maxSteps !== undefined ? { maxSteps: assistantOptions.maxSteps } : {}),
      read: async (operation, input) => {
        // A turn's reads share one budget of resource-days, so 8 steps of wide reads cannot each
        // scan a hundred resources over years.
        reads += 1;
        readCost += readCostOf(input);
        if (reads > MAX_READS_PER_TURN || readCost > MAX_READ_COST_PER_TURN) {
          return { ok: false, code: 'turn_read_budget_exceeded' };
        }
        const outcome = await dispatch(session, operation, input, 'run');
        return outcome.ok
          ? outcome
          : { ok: false, code: outcome.code, ...(outcome.details ? { details: outcome.details } : {}) };
      },
      propose: async (operation, input) => {
        if (pendingBefore + Object.keys(proposed).length >= SLOTLOCK_ASSISTANT_MAX_PENDING) {
          return { ok: false, code: 'too_many_pending_changes' };
        }
        const id = randomBytes(12).toString('base64url');
        const prepared =
          isRecord(input) && keyed.has(operation)
            ? { ...input, idempotency_key: `dashboard-assistant.${id}` }
            : input;
        let checked: Record<string, unknown> | undefined;
        // Every check an agent's call passes (arguments, scopes, authorize, rate limit), then halted
        // here: it runs only when the member approves it.
        const outcome = await dispatch(session, operation, prepared, 'propose', async ({ input: parsed }) => {
          checked = parsed;
          return { status: 409, code: 'approval_required' };
        });
        if (checked === undefined || outcome.ok || outcome.code !== 'approval_required') {
          return { ok: false, code: outcome.ok ? 'internal_error' : outcome.code };
        }
        // The card shows every argument: one too large to show is not proposed.
        if (Buffer.byteLength(JSON.stringify(checked), 'utf8') > SLOTLOCK_ASSISTANT_MAX_ACTION_BYTES) {
          return { ok: false, code: 'change_too_large_to_show' };
        }
        proposed[id] = {
          operation,
          input: checked,
          status: 'pending',
          summary: await summarize(session, operation, checked),
        };
        return { ok: true, actionId: id };
      },
    });
    if (turn.failure !== undefined) {
      report(turn.failure instanceof Error ? turn.failure.message : 'assistant provider failed');
    }
    const messages = boundSlotlockAssistantEntries([...entries, ...turn.added]);
    // Only this turn's proposals are added; the rest are kept as the row holds them now, so one
    // approved (or a conversation reset) while the turn ran is never put back as it stood.
    const kept = pruneSlotlockAssistantActions(messages, { ...(stored?.actions ?? {}), ...proposed });
    await store.putConversation(
      tenantRef,
      member,
      {
        messages,
        added: Object.fromEntries(Object.entries(proposed).filter(([id]) => id in kept)),
        keep: Object.keys(kept),
      },
      conversationTtl,
    );
    return redirect(303, `${root}/assistant#latest`);
  }

  async function settleAction(
    session: Session,
    form: URLSearchParams,
    decision: 'approve' | 'dismiss',
  ): Promise<Response> {
    const store = assistantStore();
    if (!store || !assistantOptions) return notFound(session);
    const id = form.get('action') ?? '';
    const tenantRef = tenantOf(session);
    const member = personOf(session);
    const claimed = ACTION_ID.test(id)
      ? await store.settleAction(
          tenantRef,
          member,
          id,
          'pending',
          decision === 'approve' ? { status: 'approved' } : { status: 'dismissed', input: {} },
        )
      : null;
    const action = claimed ? readAction(id, claimed) : null;
    if (!action) return assistantPage(session, 409, 'That change was already approved or dismissed.');
    const title = toolTitles.get(action.operation) ?? action.operation;
    let event: string;
    if (decision === 'dismiss') {
      event = `The member dismissed the proposed change ${id} (${title}); it did not run.`;
    } else if (SLOTLOCK_ASSISTANT_TOOL_USE[action.operation] !== 'propose') {
      await store.settleAction(tenantRef, member, id, 'approved', { status: 'failed', outcome: 'tool_not_available', input: {} });
      event = `The proposed change ${id} (${title}) could not run: tool_not_available.`;
    } else {
      const outcome = await dispatch(session, action.operation, action.input, 'run');
      // Settled, the card keeps what it said, not the arguments: the actions stay small.
      await store.settleAction(
        tenantRef,
        member,
        id,
        'approved',
        outcome.ok ? { status: 'done', input: {} } : { status: 'failed', outcome: outcome.code, input: {} },
      );
      const result = JSON.stringify(outcome.ok ? outcome.data : { error: { code: outcome.code } });
      event = `The member approved the proposed change ${id} (${title}). ${outcome.ok ? 'It ran' : 'It was refused'}: ${result.length > 4_000 ? `${result.slice(0, 4_000)} …[truncated]` : result}`;
    }
    const stored = await store.getConversation(tenantRef, member);
    if (stored) {
      const entries: SlotlockAssistantEntry[] = [
        ...readSlotlockAssistantEntries(stored.messages),
        { role: 'event', text: event },
      ];
      const messages = boundSlotlockAssistantEntries(entries);
      await store.putConversation(
        tenantRef,
        member,
        { messages, added: {}, keep: Object.keys(pruneSlotlockAssistantActions(messages, stored.actions)) },
        conversationTtl,
      );
    }
    return redirect(303, `${root}/assistant#action-${id}`);
  }

  async function resetAssistant(session: Session): Promise<Response> {
    const store = assistantStore();
    if (!store) return notFound(session);
    await store.deleteConversation(tenantOf(session), personOf(session));
    return redirect(303, `${root}/assistant`);
  }

  /** The page a form was sent from, to show what went wrong with it. */
  function pageFor(route: string) {
    if (route.startsWith('/keys')) return keysPage;
    if (route.startsWith('/webhooks') && options.resources.webhooks) return webhooksPage;
    if (route.startsWith('/waitlist') && options.resources.waitlist) return waitlistPage;
    if (route.startsWith('/resources') || route === '/hours') return resourcesPage;
    if (route.startsWith('/assistant') && assistantStore()) return assistantPage;
    if (route.startsWith('/settings')) return settingsPage;
    return overviewPage;
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
<p><a class="back" href="${root}/resources">Resources</a></p>
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
    return respond(state.status ?? 200, layout('Bookable hours', content, session, 'resources'));
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
      personOf(session),
    );
    if (changed === 0) {
      return target === 'all'
        ? resourcesPage(session, 409, 'Add a resource first, then set its hours.')
        : notFound(session);
    }
    return redirect(303, `${root}/resources`);
  }

  function shownOncePage(
    session: Session,
    key: string,
    apiKey: SlotlockApiKey,
    rotated: boolean,
  ): Response {
    const org = session.orgs?.find((candidate) => candidate.id === session.org);
    const content = html`<section class="card once">
<h1>${rotated ? 'Key rotated' : 'Key created'}: ${apiKey.name}</h1>
${org ? html`<p>For the organization <strong>${org.login}</strong>.</p>` : html``}
<p class="notice warn" role="alert">Copy this key now. Slotlock keeps only its fingerprint, so it will not be shown again.${rotated ? ' The old key no longer works.' : ''}</p>
<div class="copy"><input id="key" readonly value="${key}" aria-label="API key"><button type="button" data-copy="key">Copy</button></div>
<h2>Add it to an MCP client</h2>
<pre><code id="command">claude mcp add --transport http slotlock ${mcpUrl} \\
  --header "Authorization: Bearer ${key}"</code></pre>
<p>Keep the key in a secret manager. Rotate it if it leaks; revoke it when the agent is retired.</p>
<a class="button primary" href="${root}/keys">Done</a>
</section>`;
    return respond(200, layout('Your new key', content, session, 'keys'));
  }

  /** Act in another of the session's organizations: the same session, sealed again. */
  function switchOrganization(session: Session, form: URLSearchParams): Response {
    const wanted = form.get('organization') ?? '';
    const org = session.orgs?.find(
      (candidate) => candidate.id === wanted && served?.has(candidate.id),
    );
    if (!served || !org) {
      return respond(
        400,
        layout('Refused', html`<p class="notice">You cannot act for that organization.</p>`, session),
      );
    }
    const sealed = seal('slotlock-dashboard-session-v1', { ...session, org: org.id });
    const left = Math.max(1, Math.floor((session.exp - now()) / 1000));
    return redirect(303, root, [setCookie(SESSION_COOKIE, sealed, left)]);
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
      // Reading organization membership needs read:org; a personal tenant needs no scope at all.
      ...(served ? { scope: 'read:org' } : {}),
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
      // A redirect is returned, not followed, and is not `ok`, so it is refused below. ('error'
      // would do the same in Node.js, but Cloudflare Workers refuse it as a TypeError.)
      redirect: 'manual',
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
      redirect: 'manual',
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

  /**
   * The served organizations the token's person is an active member of, by login, or null when
   * GitHub does not answer. Only `state: active` counts; at most MAX_SESSION_ORGANIZATIONS.
   */
  async function readMemberships(token: string): Promise<Organization[] | null> {
    const response = await fetchImpl(membershipsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) {
      report(`GitHub membership lookup failed: HTTP ${response.status}`);
      return null;
    }
    const body: unknown = await response.json().catch(() => null);
    if (!Array.isArray(body)) return null;
    const found = new Map<string, Organization>();
    for (const membership of body) {
      // Owners and members only: a billing manager is not a member, and may invite more of them.
      if (
        !isRecord(membership) ||
        membership.state !== 'active' ||
        (membership.role !== 'admin' && membership.role !== 'member')
      ) {
        continue;
      }
      const organization = membership.organization;
      if (
        !isRecord(organization) ||
        !Number.isSafeInteger(organization.id) ||
        (organization.id as number) <= 0 ||
        typeof organization.login !== 'string' ||
        !GITHUB_LOGIN.test(organization.login)
      ) {
        continue;
      }
      const id = String(organization.id);
      if (served?.has(id)) {
        found.set(id, { id, login: organization.login, role: membership.role === 'admin' ? 'admin' : 'member' });
      }
    }
    return [...found.values()]
      .sort((a, b) => a.login.localeCompare(b.login))
      .slice(0, MAX_SESSION_ORGANIZATIONS);
  }

  async function askGitHub(
    code: string,
    verifier: string,
  ): Promise<{ uid: string; login: string; orgs?: Organization[] } | null> {
    try {
      const token = await exchangeCode(code, verifier);
      if (token === null) return null;
      const user = await readGitHubUser(token);
      if (!user || !served) return user;
      const orgs = await readMemberships(token);
      return orgs === null ? null : { ...user, orgs };
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
    const client = options.clientAddress?.(request);
    const fromClient = client === undefined ? 0 : (signInsByClient.get(client) ?? 0);
    if (
      signInsInFlight >= MAX_SIGN_INS_IN_FLIGHT ||
      fromClient >= MAX_SIGN_INS_IN_FLIGHT_PER_CLIENT
    ) {
      return signedOutPage(
        503,
        'Too many people are signing in at once. Sign in again in a moment.',
        [clearSignIn],
      );
    }
    const verifier = pending.verifier;
    signInsInFlight += 1;
    if (client !== undefined) signInsByClient.set(client, fromClient + 1);
    let user: { uid: string; login: string; orgs?: Organization[] } | null;
    try {
      // Recorded before GitHub is asked, so a replayed callback is refused on every server unasked.
      if (!(await options.state.use('sign_in', pending.state, pending.exp as number))) {
        return signedOutPage(400, SIGN_IN_AGAIN, [clearSignIn]);
      }
      user = await askGitHub(code, verifier);
    } finally {
      signInsInFlight -= 1;
      if (client !== undefined) {
        const left = (signInsByClient.get(client) ?? 1) - 1;
        if (left === 0) signInsByClient.delete(client);
        else signInsByClient.set(client, left);
      }
    }
    if (!user) {
      return signedOutPage(502, 'GitHub did not complete the sign-in. Try again.', [clearSignIn]);
    }
    if (!allowed(user.uid)) {
      return signedOutPage(403, `This Slotlock server does not let @${user.login} sign in.`, [
        clearSignIn,
      ]);
    }
    const orgs = user.orgs ?? [];
    if (served && orgs.length === 0) {
      return signedOutPage(
        403,
        `@${user.login} is not a member of an organization this Slotlock server serves.`,
        [clearSignIn],
      );
    }
    const session = seal('slotlock-dashboard-session-v1', {
      uid: user.uid,
      login: user.login,
      sid: randomBytes(24).toString('base64url'),
      exp: now() + SESSION_TTL_MS,
      ...(served ? { orgs, org: (orgs[0] as Organization).id } : {}),
    });
    return redirect(303, root, [
      clearSignIn,
      setCookie(SESSION_COOKIE, session, SESSION_TTL_MS / 1000),
    ]);
  }

  /** The form, `'too_large'` past MAX_FORM_BYTES (read no further), or null for another type. */
  async function readForm(
    request: Request,
    maxBytes = MAX_FORM_BYTES,
  ): Promise<URLSearchParams | 'too_large' | null> {
    const type = request.headers.get('content-type')?.split(';')[0]?.trim();
    if (type !== 'application/x-www-form-urlencoded') return null;
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return 'too_large';
    if (!request.body) return new URLSearchParams();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
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
      return keysPage(session, 400, 'Choose an access level and an expiry from the lists.');
    }
    const days = KEY_EXPIRY_DAYS[expiry];
    try {
      const created = await options.keys.create({
        tenantRef: tenantOf(session),
        name: form.get('name') ?? '',
        scopes,
        createdBy: personOf(session),
        ...(typeof days === 'number' ? { expiresAt: new Date(now() + days * DAY_MS) } : {}),
      });
      return shownOncePage(session, created.key, created.apiKey, false);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'invalid_api_key_name') {
        return keysPage(session, 400, 'Give the key a name of 1 to 100 characters.');
      }
      if (code === 'api_key_limit_reached') {
        return keysPage(
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
    if (!UUID_PATTERN.test(id)) return keysPage(session, 404, 'That key is not one of yours.');
    if (change === 'rotate') {
      const rotated = await options.keys.rotate({ tenantRef: tenantOf(session), id });
      if (!rotated) return keysPage(session, 404, 'That key is not an active key of yours.');
      return shownOncePage(session, rotated.key, rotated.apiKey, true);
    }
    const revoked = await options.keys.revoke({ tenantRef: tenantOf(session), id });
    if (!revoked) return keysPage(session, 404, 'That key is not one of yours.');
    return redirect(303, `${root}/keys`);
  }

  async function addResource(session: Session, form: URLSearchParams): Promise<Response> {
    const reference = (form.get('reference') ?? '').trim();
    const timezone = (form.get('timezone') ?? '').trim();
    if (reference.length === 0 || reference.length > 200) {
      return resourcesPage(session, 400, 'Give the resource a reference of 1 to 200 characters.');
    }
    try {
      await options.resources.add(tenantOf(session), reference, timezone, personOf(session));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'resource_limit_reached') {
        return resourcesPage(
          session,
          409,
          `You have ${SLOTLOCK_DASHBOARD_MAX_RESOURCES} resources, as many as the dashboard allows.`,
        );
      }
      if (code === 'invalid_timezone') {
        return resourcesPage(
          session,
          400,
          `${timezone} is not a time zone Slotlock knows, such as Europe/London.`,
        );
      }
      if (code === 'invalid_external_ref') {
        return resourcesPage(session, 400, 'Give the resource a reference of 1 to 200 characters.');
      }
      throw error;
    }
    return redirect(303, `${root}/resources`);
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
    const form = await readForm(request, route === '/assistant' ? MAX_ASSISTANT_FORM_BYTES : MAX_FORM_BYTES);
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
      const checked = checkFormNonce(session, once);
      if (checked === 'other_org') {
        return pageFor(route)(
          session,
          409,
          'That page was for another organization. Nothing was changed: check the organization and try again.',
        );
      }
      let first: boolean;
      try {
        first =
          checked === 'ok' &&
          (await options.state.use('form', once, session.exp, session.uid));
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'dashboard_form_limit') throw error;
        return pageFor(route)(
          session,
          429,
          'Too many forms sent from this account in the last 12 hours. Try again later.',
        );
      }
      if (!first) {
        return pageFor(route)(
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
      case '/organization':
        return switchOrganization(session, form);
      case '/resources/rules':
        return saveRules(session, form);
      case '/resources/pool':
        return savePool(session, form);
      case '/webhooks':
        return addWebhook(session, form);
      case '/webhooks/delete':
        return changeWebhook(session, form, 'remove');
      case '/webhooks/enable':
        return changeWebhook(session, form, 'enable');
      case '/waitlist/leave':
        return leaveWaitlist(session, form);
      case '/assistant':
        return sendToAssistant(session, form);
      case '/assistant/approve':
        return settleAction(session, form, 'approve');
      case '/assistant/dismiss':
        return settleAction(session, form, 'dismiss');
      case '/assistant/reset':
        return resetAssistant(session);
      case '/settings/assistant':
        return saveAssistantSettings(session, form);
      case '/settings/assistant/test':
        return testAssistant(session);
      case '/settings/assistant/remove':
        return removeAssistantSettings(session);
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
              return session ? await overviewPage(session) : signedOutPage(200);
            }
            case '/keys':
            case '/resources':
            case '/webhooks':
            case '/waitlist':
            case '/assistant':
            case '/settings': {
              const session = await readSession(request);
              if (!session) return redirect(303, root);
              if (route === '/keys') return await keysPage(session);
              if (route === '/resources') return await resourcesPage(session);
              if (route === '/webhooks') return await webhooksPage(session);
              if (route === '/waitlist') return await waitlistPage(session);
              if (route === '/assistant') return await assistantPage(session);
              return await settingsPage(session);
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
            default: {
              const resourceId = RESOURCE_PAGE.exec(route)?.[1];
              if (resourceId !== undefined) {
                const session = await readSession(request);
                return session
                  ? await resourceDetailPage(session, resourceId.toLowerCase())
                  : redirect(303, root);
              }
              return respond(
                404,
                layout('Not found', html`<p class="notice">Nothing is here.</p>`, null),
              );
            }
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
        // A suspended tenant may look, not change: the store refuses its writes.
        if ((error as { code?: unknown } | null)?.code === 'tenant_suspended') {
          return respond(
            403,
            layout(
              'Suspended',
              html`<p class="notice">This account is suspended: its data can be seen, not changed.</p>`,
              null,
            ),
          );
        }
        try {
          ignoreRejection(options.onError?.(error));
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
  --ink: #0f1115; --ink-2: #464b57; --ink-3: #7a808d; --line: #e7e8ec; --line-2: #f0f1f4;
  --paper: #ffffff; --wash: #f7f7f9; --side: #fafafb; --hover: #f1f2f5;
  --accent: #2655ff; --accent-wash: #eef2ff; --accent-ink: #ffffff;
  --good: #12805c; --good-wash: #e8f6f0; --bad: #c4321f; --bad-wash: #fdeeec;
  --warn: #8a5a00; --warn-wash: #fff6e0; --held: #8a5a00; --held-wash: #fff4dc;
  --shadow: 0 1px 2px rgba(15, 17, 21, 0.04), 0 1px 1px rgba(15, 17, 21, 0.03);
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --ink: #eceef3; --ink-2: #b9bdc8; --ink-3: #868c99; --line: #262932; --line-2: #1d2027;
    --paper: #0d0f13; --wash: #14171d; --side: #101217; --hover: #1b1e25;
    --accent: #7b93ff; --accent-wash: #1a2145; --accent-ink: #0d0f13;
    --good: #4cc79a; --good-wash: #0f2a20; --bad: #ff7b6b; --bad-wash: #34150f;
    --warn: #ffcf70; --warn-wash: #2b2410; --held: #ffcf70; --held-wash: #2b2410;
    --shadow: none; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, input[readonly] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.icon .fill { fill: currentColor; stroke: none; }
.mark { width: 20px; height: 18px; flex: none; }
.mark-ink { fill: currentColor; }
.mark-slot { fill: #FF5B2E; }
.brand { display: inline-flex; align-items: center; gap: 8px; color: var(--ink); font-weight: 650; font-size: 15px; letter-spacing: -0.01em; }
.brand:hover { text-decoration: none; }
.app { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; background: linear-gradient(to right, var(--side) 239px, var(--line) 239px, var(--line) 240px, var(--paper) 240px); }
.side { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 16px; padding: 16px 12px; }
.side-top { display: grid; gap: 14px; padding: 0 6px; }
.workspace { display: flex; align-items: center; gap: 8px; margin: 0; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); min-width: 0; }
.workspace-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace select { flex: 1; min-width: 0; height: 28px; border: 0; padding: 0 2px; font-weight: 600; background: transparent; }
.avatar { display: inline-grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: 6px; background: var(--accent-wash); color: var(--accent); font-size: 12px; font-weight: 700; }
.nav { display: grid; gap: 2px; }
.nav a { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 7px; color: var(--ink-2); font-weight: 500; }
.nav a:hover { background: var(--hover); color: var(--ink); text-decoration: none; }
.nav a[aria-current="page"] { background: var(--hover); color: var(--ink); font-weight: 600; }
.nav a[aria-current="page"] .icon { color: var(--accent); }
.me { margin-top: auto; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 10px 0; border-top: 1px solid var(--line); color: var(--ink-3); font-size: 13px; }
.me form { margin: 0; }
.login { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.page { width: 100%; max-width: 1120px; padding: 28px 40px 64px; display: grid; gap: 20px; align-content: start; }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 22px; line-height: 1.25; margin: 0; letter-spacing: -0.015em; font-weight: 650; }
h2 { font-size: 14px; margin: 0 0 12px; font-weight: 600; }
h3 { font-size: 12px; margin: 0; font-weight: 600; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.04em; }
p { margin: 0 0 10px; color: var(--ink-2); }
.fine { font-size: 12.5px; color: var(--ink-3); margin: 8px 0 0; }
.muted { color: var(--ink-3); }
.panel, .card { border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; background: var(--paper); box-shadow: var(--shadow); min-width: 0; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
.stat { display: grid; gap: 4px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); box-shadow: var(--shadow); color: var(--ink); }
.stat:hover { border-color: var(--ink-3); text-decoration: none; }
.stat-label { font-size: 12.5px; color: var(--ink-3); }
.stat-value { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.split { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 20px; align-items: start; }
.setup .steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.steps li { display: flex; align-items: center; gap: 10px; color: var(--ink-2); }
.steps li.done { color: var(--ink-3); text-decoration: line-through; }
.check { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 999px; border: 1.5px solid var(--line); color: var(--accent-ink); }
.done .check { background: var(--good); border-color: var(--good); }
.check .icon { width: 12px; height: 12px; stroke-width: 3; }
.day { margin: 14px 0 6px; }
.day:first-of-type { margin-top: 0; }
.slots, .feed { list-style: none; margin: 0; padding: 0; }
.slot { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--line-2); }
.slot:last-child { border-bottom: 0; }
.when { display: grid; font-weight: 600; font-variant-numeric: tabular-nums; }
.until { font-weight: 400; font-size: 12px; color: var(--ink-3); }
.what { display: grid; min-width: 0; }
.title { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.on { color: var(--ink-3); font-weight: 400; }
.meta { font-size: 12.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event { display: grid; grid-template-columns: 10px minmax(0, 1fr); gap: 12px; align-items: start; padding: 8px 0; }
.dot { width: 8px; height: 8px; margin-top: 6px; border-radius: 999px; background: var(--ink-3); }
.dot.good { background: var(--good); }
.dot.bad { background: var(--bad); }
.pill { display: inline-block; font-size: 11.5px; font-weight: 600; line-height: 18px; padding: 1px 8px; border-radius: 999px; background: var(--wash); color: var(--ink-2); white-space: nowrap; }
.pill.booking, .pill.active { background: var(--good-wash); color: var(--good); }
.pill.event { background: var(--accent-wash); color: var(--accent); }
.pill.held { background: var(--held-wash); color: var(--held); }
.pill.revoked, .pill.expired { color: var(--ink-3); }
.endpoints { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 16px; margin: 12px 0 0; align-items: center; }
.endpoints dt { color: var(--ink-3); font-weight: 600; font-size: 12.5px; }
.endpoints dd { margin: 0; display: flex; align-items: center; gap: 10px; min-width: 0; }
.endpoints code { overflow-wrap: anywhere; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px; margin: 0; }
.facts dt { color: var(--ink-3); }
.facts dd { margin: 0; }
.create { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 0; }
label { display: grid; gap: 5px; font-size: 12.5px; font-weight: 500; color: var(--ink-2); }
input, select { font: inherit; height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink); min-width: 0; }
input:focus, select:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-wash); }
button, .button { font: inherit; font-weight: 600; height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--paper); color: var(--ink); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; box-shadow: var(--shadow); }
button:hover, .button:hover { background: var(--hover); text-decoration: none; }
.primary, .primary:hover { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.primary:hover { filter: brightness(1.06); }
.wide { width: 100%; height: 40px; }
button.danger { border-color: var(--bad); color: var(--bad); }
button.quiet { height: auto; padding: 2px 6px; border: 0; background: none; box-shadow: none; color: var(--ink-3); font-weight: 500; font-size: 12.5px; }
button.quiet:hover { color: var(--ink); background: var(--hover); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.table { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); box-shadow: var(--shadow); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line-2); vertical-align: middle; }
th { font-weight: 600; color: var(--ink-3); font-size: 12px; background: var(--wash); border-bottom-color: var(--line); white-space: nowrap; }
td { white-space: nowrap; }
td.strong { font-weight: 600; white-space: normal; min-width: 120px; }
tr:last-child td { border-bottom: 0; }
.actions { white-space: nowrap; text-align: right; }
.act { display: inline-block; position: relative; margin-left: 8px; text-align: left; }
.act summary { cursor: pointer; color: var(--ink-2); font-weight: 500; list-style: none; }
.act summary::-webkit-details-marker { display: none; }
.act.danger summary { color: var(--bad); }
.pop { position: absolute; right: 0; z-index: 2; width: 260px; margin-top: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); box-shadow: 0 8px 24px rgba(15, 17, 21, 0.12); white-space: normal; }
.pop p { font-size: 12.5px; }
.notice { border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; background: var(--wash); color: var(--ink); margin: 0; }
.notice.warn { background: var(--warn-wash); color: var(--warn); border-color: transparent; }
.empty { color: var(--ink-3); margin: 0; }
.once { max-width: 720px; }
.copy { display: flex; gap: 8px; margin: 12px 0 20px; }
.copy input { flex: 1; }
pre { background: var(--wash); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.hours { margin: 0; padding-left: 18px; color: var(--ink-2); }
.back::before { content: "← "; }
.modes { border: 0; padding: 0; margin: 0 0 16px; display: grid; gap: 8px; }
.modes legend { font-weight: 600; color: var(--ink); padding: 0; margin-bottom: 4px; }
.choice { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--ink); }
.choice input { height: auto; }
.week input { width: 100%; }
.week th[scope="row"] { font-size: 13px; color: var(--ink); background: none; }
form > .table { margin-bottom: 12px; }
.bare { background: var(--wash); }
.bare-bar { padding: 20px 24px; }
.bare-main { display: grid; place-items: start center; padding: 8vh 16px 64px; }
.sign-in { width: 100%; max-width: 400px; padding: 28px; border: 1px solid var(--line); border-radius: 14px; background: var(--paper); box-shadow: var(--shadow); display: grid; gap: 12px; }
.sign-in h1 { font-size: 20px; }
.sign-in p { margin: 0; }
.stack { display: grid; gap: 20px; align-content: start; min-width: 0; }
.grid-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 12px; align-items: end; }
.cell { display: grid; justify-items: start; gap: 2px; }
.unit-input { display: flex; align-items: center; gap: 8px; }
.unit-input input { width: 100%; }
.unit-input span { color: var(--ink-3); white-space: nowrap; }
form .choice { margin: 4px 0 10px; }
.types { margin: 12px 0; }
.types summary { cursor: pointer; color: var(--ink-2); font-size: 13px; }
.checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 16px; margin-top: 10px; }
.checks .choice { font-size: 13px; margin: 0; }
td .meta { display: block; margin-top: 2px; }
td[data-label] > .pill { justify-self: start; }
td.wrap, .wrap { white-space: normal; overflow-wrap: anywhere; }
form.inline { display: inline; margin: 0; }
form > label { margin-bottom: 4px; }
.chat { display: grid; gap: 16px; }
.thread { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.msg { max-width: 78%; padding: 10px 14px; border-radius: 12px; background: var(--wash); border: 1px solid var(--line); }
.msg p { margin: 0; color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.mine { justify-self: end; background: var(--accent-wash); border-color: transparent; }
.msg.bot { justify-self: start; }
.tool-line { font-size: 12.5px; color: var(--ink-3); padding-left: 4px; }
.action-card { justify-self: start; width: min(100%, 520px); padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); box-shadow: var(--shadow); display: grid; gap: 10px; }
.action-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.action-card .facts { font-size: 13px; }
.action-card .facts dd { overflow-wrap: anywhere; }
.action-card pre.wrap { white-space: pre-wrap; margin: 0; padding: 8px; font-size: 12px; }
.action-summary { margin: 0; color: var(--ink); font-weight: 500; overflow-wrap: anywhere; }
.action-buttons, .row-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; margin: 0; }
textarea { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); color: var(--ink); resize: vertical; min-height: 64px; min-width: 0; }
textarea:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-wash); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 1000px) {
  .split { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 760px) {
  .app { grid-template-columns: minmax(0, 1fr); background: var(--paper); }
  .side { position: sticky; z-index: 3; height: auto; background: var(--side); border-bottom: 1px solid var(--line); flex-direction: row; flex-wrap: wrap; align-items: center; gap: 10px 12px; padding: 10px 16px 0; border-right: 0; }
  .side-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0; flex: 1 1 100%; min-width: 0; }
  .workspace { max-width: 60%; }
  .nav { display: flex; gap: 2px; overflow-x: auto; flex: 1 1 auto; margin: 0 -4px; padding-bottom: 8px; scrollbar-width: none; }
  .nav a { flex: none; padding: 6px 10px; }
  .me { margin: 0 0 8px; padding: 0; border: 0; flex: none; }
  .me .login { display: none; }
  .page { padding: 20px 16px 48px; gap: 16px; }
  .panel, .card { padding: 16px; }
  .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat-value { font-size: 20px; }
  thead { display: none; }
  table, tbody, tr, td { display: block; }
  tr { border-bottom: 1px solid var(--line); padding: 8px 0; }
  tr:last-child { border-bottom: 0; }
  td { border: 0; padding: 3px 14px; white-space: normal; }
  td[data-label] { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; }
  td[data-label]::before { content: attr(data-label); font-size: 12px; color: var(--ink-3); }
  .actions { text-align: left; }
  .act { margin: 4px 12px 0 0; }
  .pop { left: 0; right: auto; }
  .msg { max-width: 92%; }
  .composer { grid-template-columns: minmax(0, 1fr); }
}
`;

const ASSET_VERSIONS = Object.freeze({
  css: createHash('sha256').update(DASHBOARD_CSS).digest('base64url').slice(0, 12),
  js: createHash('sha256').update(DASHBOARD_JS).digest('base64url').slice(0, 12),
});
