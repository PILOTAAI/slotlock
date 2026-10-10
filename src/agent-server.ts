import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  SLOTLOCK_MCP_APPS_EXTENSION,
  SLOTLOCK_MCP_APP_HTML,
  SLOTLOCK_MCP_APP_MIME_TYPE,
  SLOTLOCK_MCP_APP_RESOURCE,
  SLOTLOCK_MCP_APP_RESOURCE_URI,
  clientSupportsSlotlockMcpApp,
} from './mcp-app.js';
import {
  type SlotlockTraceContext,
  MCP_META_PROTOCOL_VERSION,
  MCP_META_SERVER_INFO,
  MCP_META_SUBSCRIPTION_ID,
  MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
  canonicalJson,
  checkModernMcpRequest,
  isRecord,
  openMcpEventStream,
  openRequestState,
  principalTag,
  sealRequestState,
  sha256Hex,
  stateSecrets,
  traceContextFrom,
} from './mcp-modern.js';
import { SLOTLOCK_CALENDAR_HORIZON_DAYS, SLOTLOCK_MAX_EVENT_DURATION_DAYS } from './store.js';
import { zonedWallTime } from './timezone.js';

export type { SlotlockTraceContext } from './mcp-modern.js';

export {
  clientSupportsSlotlockMcpApp,
  SLOTLOCK_MCP_APP_HTML,
  SLOTLOCK_MCP_APP_MIME_TYPE,
  SLOTLOCK_MCP_APP_RESOURCE,
  SLOTLOCK_MCP_APP_RESOURCE_URI,
  SLOTLOCK_MCP_APPS_EXTENSION,
} from './mcp-app.js';

export const SLOTLOCK_AGENT_SERVER_VERSION = '1.0.0';
/**
 * The newest MCP revision Slotlock implements: stateless, with the protocol version, client
 * capabilities and client identity carried in every request's `_meta` (no `initialize`, no sessions).
 */
export const SLOTLOCK_MCP_PROTOCOL_VERSION = '2026-07-28';
/** The newest revision with an `initialize` handshake; `initialize` falls back to it. */
export const SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION = '2025-11-25';
/**
 * Every MCP revision Slotlock implements, newest first. A request carrying 2026-07-28 `_meta` is served
 * statelessly; `initialize` selects a 2025 revision for the client that sent it (the dual-era rule,
 * 2026-07-28 basic/versioning). 2025-06-18 differs from 2025-11-25 in nothing this server uses, so a
 * client pinned to it gets its own version back.
 */
export const SLOTLOCK_MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  SLOTLOCK_MCP_PROTOCOL_VERSION,
  SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
  '2025-06-18',
] as const);
const MODERN_MCP_VERSIONS: readonly string[] = [SLOTLOCK_MCP_PROTOCOL_VERSION];
const LEGACY_MCP_VERSIONS: readonly string[] = [SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION, '2025-06-18'];
/**
 * JSON-RPC code of an HTTP 429 answered to a 2026-07-28 request. That revision reserves
 * -32020..-32099 for codes it defines, so this is outside the JSON-RPC server range altogether; a
 * 2025 client keeps the -32029 it has always received.
 */
export const SLOTLOCK_MCP_RATE_LIMITED_ERROR_CODE = -31029;
export const SLOTLOCK_A2A_PROTOCOL_VERSION = '1.0';
/** A2A 1.0 `ListTasksRequest.page_size`: 1-100, and 50 when the client sets none. */
export const SLOTLOCK_A2A_TASK_PAGE_SIZE = Object.freeze({ min: 1, max: 100, default: 50 } as const);
/** The A2A 1.0 `TaskState` names, as a `ListTasks` status filter spells them in JSON. */
export const SLOTLOCK_A2A_TASK_STATES = Object.freeze([
  'TASK_STATE_UNSPECIFIED',
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
] as const);

const DATE_TIME = z.string().datetime({ offset: true });
const RESOURCE_ID = z.string().trim().min(1).max(200);
const EVENT_ID = z.string().trim().min(1).max(500);
const IDEMPOTENCY_KEY = z.string().trim().min(1).max(200);
const REVISION = z.number().int().positive();
// Output bounds mirror the trusted store's byte ceilings. A value admitted by a UTF-8 byte
// ceiling can never exceed that many UTF-16 code units, so every valid stored/provider event is
// serializable without truncating recurrence semantics or calendar identities.
const TRUSTED_SUMMARY_OUTPUT_MAX = 4_096;
const TRUSTED_TEXT_OUTPUT_MAX = 16_384;
const TRUSTED_PERSON_NAME_OUTPUT_MAX = 1_024;
const TRUSTED_RECURRENCE_EXCEPTION_OUTPUT_MAX = 1_000;
const TRUSTED_REMINDER_MINUTES_OUTPUT_MAX = 366 * 24 * 60;
const MAX_AGENT_WINDOW_MS = SLOTLOCK_CALENDAR_HORIZON_DAYS * 24 * 60 * 60 * 1_000;
/** The longest slot `slotlock_find_next_available` can look for: the whole search window. */
const MAX_SLOT_MINUTES = SLOTLOCK_CALENDAR_HORIZON_DAYS * 24 * 60;
const MAX_EVENT_DURATION_MS = SLOTLOCK_MAX_EVENT_DURATION_DAYS * 24 * 60 * 60 * 1_000;
/** Ordered and no longer than the store's one-off event ceiling (a lease, a long rental). */
const boundedEventSpan = (startsAt: string, endsAt: string): boolean => {
  const span = Date.parse(endsAt) - Date.parse(startsAt);
  return span > 0 && span <= MAX_EVENT_DURATION_MS;
};
const boundedAgentWindow = (value: { start: string; end: string }): boolean => {
  const start = Date.parse(value.start);
  const end = Date.parse(value.end);
  return end > start && end - start <= MAX_AGENT_WINDOW_MS;
};
const INTERVAL = z
  .object({ start: DATE_TIME, end: DATE_TIME })
  .strict()
  .refine((value) => Date.parse(value.end) > Date.parse(value.start));
const COVERAGE = z
  .object({
    start: DATE_TIME,
    end: DATE_TIME,
    certainty: z.enum(['certain', 'uncertain']),
    reason: z.string().max(100).nullable(),
  })
  .strict();
const ORGANIZER = z
  .object({
    address: z.string().email().max(320),
    name: z.string().trim().max(TRUSTED_PERSON_NAME_OUTPUT_MAX).nullable(),
  })
  .strict();
const ATTENDEE = z
  .object({
    address: z.string().email().max(320),
    name: z.string().trim().max(TRUSTED_PERSON_NAME_OUTPUT_MAX).nullable(),
    role: z.enum(['chair', 'required', 'optional', 'non_participant']),
    participation_status: z.enum([
      'needs_action',
      'accepted',
      'declined',
      'tentative',
      'delegated',
    ]),
    rsvp: z.boolean(),
  })
  .strict();
const REMINDER = z
  .object({
    minutes_before: z.number().int().min(0).max(TRUSTED_REMINDER_MINUTES_OUTPUT_MAX),
    channel: z.enum(['display', 'email']),
  })
  .strict();
const RECURRENCE_EXCEPTION = z
  .object({
    recurrence_id: DATE_TIME,
    cancelled: z.boolean(),
    starts_at: DATE_TIME.nullable(),
    ends_at: DATE_TIME.nullable(),
  })
  .strict();
const ORGANIZER_INPUT = z
  .object({
    address: z.string().email().max(320),
    name: z.string().trim().max(200).optional(),
  })
  .strict();
const ATTENDEE_INPUT = z
  .object({
    address: z.string().email().max(320),
    name: z.string().trim().max(200).optional(),
    role: z.enum(['chair', 'required', 'optional', 'non_participant']),
    participation_status: z.enum([
      'needs_action',
      'accepted',
      'declined',
      'tentative',
      'delegated',
    ]),
    rsvp: z.boolean().default(false),
  })
  .strict();
const REMINDER_INPUT = z
  .object({
    minutes_before: z.number().int().min(0).max(525_600),
    channel: z.enum(['display', 'email']),
  })
  .strict();
const RECURRENCE_EXCEPTION_INPUT = z
  .object({
    recurrence_id: DATE_TIME,
    cancelled: z.boolean().default(false),
    starts_at: DATE_TIME.optional(),
    ends_at: DATE_TIME.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.cancelled ||
      (value.starts_at !== undefined &&
        value.ends_at !== undefined &&
        Date.parse(value.ends_at) > Date.parse(value.starts_at)),
  );
const MCP_INITIALIZE_PARAMS = z
  .object({
    protocolVersion: z.string().trim().min(1).max(50),
    capabilities: z.record(z.string(), z.unknown()),
    clientInfo: z
      .object({
        name: z.string().trim().min(1).max(200),
        version: z.string().trim().min(1).max(100),
      })
      .passthrough(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const EVENT = z
  .object({
    id: EVENT_ID,
    resource_id: RESOURCE_ID,
    starts_at: DATE_TIME,
    ends_at: DATE_TIME,
    timezone: z.string().min(1).max(100),
    title: z.string().max(TRUSTED_SUMMARY_OUTPUT_MAX).nullable(),
    description: z.string().max(TRUSTED_TEXT_OUTPUT_MAX).nullable(),
    location: z.string().max(TRUSTED_TEXT_OUTPUT_MAX).nullable(),
    organizer: ORGANIZER.nullable(),
    attendees: z.array(ATTENDEE).max(100),
    reminders: z.array(REMINDER).max(20),
    status: z.enum(['tentative', 'confirmed', 'cancelled']),
    transparency: z.enum(['opaque', 'transparent']),
    sequence: z.number().int().nonnegative(),
    revision: REVISION,
    recurrence_rule: z.string().max(TRUSTED_SUMMARY_OUTPUT_MAX).nullable(),
    recurrence_exceptions: z
      .array(RECURRENCE_EXCEPTION)
      .max(TRUSTED_RECURRENCE_EXCEPTION_OUTPUT_MAX),
    recurrence_id: DATE_TIME.nullable(),
  })
  .strict();

type JsonSchema = Readonly<Record<string, unknown>>;
type ObjectSchema = z.ZodType<Record<string, unknown>>;

/**
 * Operation (MCP tool / A2A skill) names. They use only `[a-z_]`, so they are valid tool names for the
 * Claude Messages API (`^[a-zA-Z0-9_-]{1,128}$`), OpenAI function calling and every MCP host.
 */
export type SlotlockAgentOperation =
  | 'slotlock_list_resources'
  | 'slotlock_get_free_busy'
  | 'slotlock_find_next_available'
  | 'slotlock_create_event'
  | 'slotlock_get_event'
  | 'slotlock_list_events'
  | 'slotlock_update_event'
  | 'slotlock_delete_event';

/**
 * Names earlier builds published, which every entry point still accepts and dispatches as the same
 * operation; nothing advertises them. The dotted names came first, before tool names had to be
 * portable; the `calendar_` names are the ones agents of Pylota's Kairos endpoint call today, kept so
 * they keep working when Pylota serves these tools.
 */
export const SLOTLOCK_AGENT_OPERATION_LEGACY_NAMES: Readonly<Record<string, SlotlockAgentOperation>> =
  Object.freeze({
    'calendar.list_resources': 'slotlock_list_resources',
    'calendar.get_free_busy': 'slotlock_get_free_busy',
    'calendar.find_next_available': 'slotlock_find_next_available',
    'calendar.create_event': 'slotlock_create_event',
    'calendar.get_event': 'slotlock_get_event',
    'calendar.list_events': 'slotlock_list_events',
    'calendar.update_event': 'slotlock_update_event',
    'calendar.delete_event': 'slotlock_delete_event',
    calendar_list_resources: 'slotlock_list_resources',
    calendar_get_free_busy: 'slotlock_get_free_busy',
    calendar_find_next_available: 'slotlock_find_next_available',
    calendar_create_event: 'slotlock_create_event',
    calendar_get_event: 'slotlock_get_event',
    calendar_list_events: 'slotlock_list_events',
    calendar_update_event: 'slotlock_update_event',
    calendar_delete_event: 'slotlock_delete_event',
  });

/** What a principal's `scopes` must include to call an operation. */
export type SlotlockAgentScope = 'read' | 'write';

/**
 * The scope each operation needs. A record over every operation, so one a later release adds does
 * not compile until it is given a scope here.
 */
const OPERATION_SCOPES: Readonly<Record<SlotlockAgentOperation, SlotlockAgentScope>> = Object.freeze({
  slotlock_list_resources: 'read',
  slotlock_get_free_busy: 'read',
  slotlock_find_next_available: 'read',
  slotlock_create_event: 'write',
  slotlock_get_event: 'read',
  slotlock_list_events: 'read',
  slotlock_update_event: 'write',
  slotlock_delete_event: 'write',
});

/** `write` for the operations that change a calendar, `read` for every other one. */
export function slotlockAgentOperationScope(operation: SlotlockAgentOperation): SlotlockAgentScope {
  return OPERATION_SCOPES[operation];
}

export interface SlotlockAgentPrincipal {
  /** Opaque stable identity. It is never included in a protocol result. */
  subject: string;
  /** Authoritative tenant identity; request arguments cannot override it. */
  tenantRef: string;
  /**
   * What the credential may do (an API key carries `read`, `write` or both; api-keys.ts). When set,
   * the server refuses with `forbidden`, before `authorize` runs, every operation whose scope
   * (`slotlockAgentOperationScope`) it lacks; an empty list or anything but a list refuses all.
   * Unset, `authorize` alone decides.
   */
  scopes?: readonly string[];
}

/** Whether a principal's scopes, if it carries any, cover an operation. */
function principalScopesCover(principal: SlotlockAgentPrincipal, operation: SlotlockAgentOperation) {
  const scopes: unknown = principal.scopes;
  return (
    scopes === undefined ||
    (Array.isArray(scopes) && scopes.includes(slotlockAgentOperationScope(operation)))
  );
}

export interface SlotlockAgentInvocationContext {
  principal: SlotlockAgentPrincipal;
  operation: SlotlockAgentOperation;
  signal: AbortSignal;
  /**
   * W3C trace context the caller sent (MCP `_meta` or HTTP headers), already validated. Start the
   * backend's spans as its children to follow one agent action across services.
   */
  trace?: SlotlockTraceContext;
}

/** A bounded domain failure a backend may deliberately expose through a protocol tool result. */
export class SlotlockAgentOperationError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'SlotlockAgentOperationError';
    this.code = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'operation_failed';
    this.status = [400, 403, 404, 409, 429, 503].includes(status) ? status : 500;
  }
}

export interface SlotlockAgentCalendarBackend {
  listResources(
    context: SlotlockAgentInvocationContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  getFreeBusy(
    context: SlotlockAgentInvocationContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  findNextAvailable(
    context: SlotlockAgentInvocationContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  createEvent(
    context: SlotlockAgentInvocationContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  getEvent(
    context: SlotlockAgentInvocationContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  listEvents(
    context: SlotlockAgentInvocationContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  updateEvent(
    context: SlotlockAgentInvocationContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  deleteEvent(
    context: SlotlockAgentInvocationContext,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /**
   * Optional. The name a person knows a resource by (its own reference, such as `vehicle-42`), for
   * the question a confirmation asks; `null` when the caller cannot see it. Without it, or when it
   * fails, the question names the resource by id.
   */
  describeResource?(
    context: SlotlockAgentInvocationContext,
    resourceId: string,
  ): Promise<string | null>;
}

/**
 * OAuth 2.0 discovery for the MCP endpoint (MCP 2025-11-25 authorization, RFC 9728). Slotlock only
 * publishes where tokens come from; `authenticate` still verifies every token, including that its
 * audience is this server's `/mcp` URL.
 */
export interface SlotlockAgentServerOAuthOptions {
  /** Issuer URLs of the authorization servers that mint tokens for this endpoint. At least one. */
  authorizationServers: readonly string[];
  /** Scopes the endpoint understands, published as `scopes_supported`. */
  scopesSupported?: readonly string[];
  /** Scopes named in the `WWW-Authenticate` header of a 401 (RFC 6750 §3). Omit to name none. */
  requiredScopes?: readonly string[];
  /** Human-readable `resource_name`. */
  resourceName?: string;
  /** HTTPS page describing the endpoint, published as `resource_documentation`. */
  resourceDocumentation?: string;
}

/** The operations that change a calendar; the only ones a confirmation can guard. */
export type SlotlockAgentWriteOperation = Extract<
  SlotlockAgentOperation,
  'slotlock_create_event' | 'slotlock_update_event' | 'slotlock_delete_event'
>;

/**
 * Human confirmation before a write (MCP 2026-07-28 multi round-trip requests + form elicitation).
 * A listed write first answers `input_required` with a yes/no form describing the change; it runs
 * only when the client retries with the person's explicit acceptance and the sealed state it was
 * given. Where no confirmation is possible — the 2025 MCP revisions and A2A — a listed write fails
 * with `confirmation_required`, never silently runs.
 */
export interface SlotlockAgentConfirmationOptions {
  operations: readonly SlotlockAgentWriteOperation[];
  /**
   * HMAC-SHA256 keys, at least 32 bytes each, that seal the pending confirmation the client carries
   * between the two rounds. The first signs; every listed key verifies, so a new key is rolled in by
   * listing it first and the old one retired after `ttlSeconds`.
   */
  secrets: readonly (string | Uint8Array)[];
  /** How long a confirmation prompt stays answerable, in seconds: 30-3,600, default 600. */
  ttlSeconds?: number;
}

/**
 * Live calendar updates over MCP 2026-07-28 `subscriptions/listen`. A client subscribes to calendar
 * resource URIs (`slotlockCalendarResourceUri`) and receives `notifications/resources/updated` on the
 * response stream when a resource's free/busy changes. The server finds changes by re-reading each
 * open subscription's resources through the backend every `pollIntervalMs`, re-running `authenticate`
 * and `authorize` each time, so a revoked credential or permission ends the stream.
 */
export interface SlotlockAgentSubscriptionOptions {
  /** How often an open subscription re-reads its resources, in ms: 1,000-300,000, default 10,000. */
  pollIntervalMs?: number;
  /** When the server ends a subscription gracefully, in ms: 60,000-86,400,000, default 900,000. */
  maxDurationMs?: number;
  /** How often a quiet stream carries an SSE keep-alive comment, in ms: 1,000-60,000, default 15,000. */
  keepAliveMs?: number;
  /** Open subscriptions one principal may hold: 1-64, default 4. */
  maxPerPrincipal?: number;
  /** Open subscriptions across the server: 1-10,000, default 256. */
  maxTotal?: number;
}

/** What the agent server reports to `onEvent`: outcomes only, never arguments or identities. */
export type SlotlockAgentServerEvent =
  | {
      type: 'confirmation';
      operation: SlotlockAgentOperation;
      outcome:
        | 'requested'
        | 'accepted'
        | 'declined'
        | 'cancelled'
        | 'expired'
        | 'refused'
        | 'unavailable';
    }
  | {
      type: 'subscription';
      outcome: 'opened' | 'closed';
      /** Why a subscription closed. */
      reason?: 'client' | 'duration' | 'shutdown' | 'revoked' | 'failed' | 'empty';
      /** How many calendar resources it watched. */
      resources: number;
    };

export interface SlotlockAgentServerOptions {
  publicBaseUrl: string;
  backend: SlotlockAgentCalendarBackend;
  authenticate(request: Request): Promise<SlotlockAgentPrincipal | null>;
  authorize(args: {
    principal: SlotlockAgentPrincipal;
    operation: SlotlockAgentOperation;
    input: Record<string, unknown>;
  }): Promise<boolean>;
  health(): Promise<{ ready: boolean; checks: readonly string[] }>;
  allowedOrigins?: readonly string[];
  consumeRateLimit?: (args: {
    principal: SlotlockAgentPrincipal;
    operation: SlotlockAgentOperation | 'protocol';
  }) => Promise<boolean>;
  allowInsecureLocalhost?: boolean;
  maxRequestBytes?: number;
  /** Publish OAuth protected-resource metadata so OAuth-capable MCP hosts can obtain a token. */
  oauth?: SlotlockAgentServerOAuthOptions;
  /** Require a person's confirmation before the listed writes run. Off unless set. */
  confirmation?: SlotlockAgentConfirmationOptions;
  /**
   * How many days ahead a calendar resource looks (MCP 2026-07-28 `resources/read`): 1-367, default
   * 30. Raise it when bookings are made months ahead. A subscription watches this many days plus its
   * `maxDurationMs`, and that must fit 367 days.
   */
  resourceWindowDays?: number;
  /**
   * Live calendar updates (`subscriptions/listen`, MCP 2026-07-28). On with the defaults unless
   * `false`, which also stops `server/discover` advertising `resources.subscribe`.
   */
  subscriptions?: SlotlockAgentSubscriptionOptions | false;
  /**
   * Observe confirmations and subscriptions (counts and outcomes, no arguments or identities) for
   * metrics or audit. It runs synchronously and whatever it throws is ignored.
   */
  onEvent?: (event: SlotlockAgentServerEvent) => void;
}

export interface SlotlockAgentOperationDispatchOptions {
  backend: SlotlockAgentCalendarBackend;
  authenticate(request: Request): Promise<SlotlockAgentPrincipal | null>;
  authorize(args: {
    principal: SlotlockAgentPrincipal;
    operation: SlotlockAgentOperation;
    input: Record<string, unknown>;
  }): Promise<boolean>;
  consumeRateLimit?: (args: {
    principal: SlotlockAgentPrincipal;
    operation: SlotlockAgentOperation;
  }) => Promise<boolean>;
  /**
   * A gate between authorization and the rate limiter: `null` lets the operation run; anything else
   * is the failure the dispatch returns instead. The agent server uses it for human confirmation.
   */
  confirm?: (args: {
    principal: SlotlockAgentPrincipal;
    operation: SlotlockAgentOperation;
    input: Record<string, unknown>;
  }) => Promise<{ status: number; code: string } | null>;
}

export type SlotlockAgentOperationDispatchResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; code: string };

interface OperationDefinition {
  name: SlotlockAgentOperation;
  title: string;
  description: string;
  input: ObjectSchema;
  output: ObjectSchema;
  risk: {
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
  };
  invoke: keyof SlotlockAgentCalendarBackend;
  /** Valid arguments, published as the A2A skill's invocation example (a test parses each one). */
  example: Record<string, unknown>;
}

const EXAMPLE_RESOURCE_ID = '0f8b6c1e-2d4a-4c7e-9b1a-3e5f7a9c2d4b';
const EXAMPLE_EVENT_ID = 'agent:5e8ff9bf55ba3508199d22e984129be6b5b6a8a7e3e5f1f0d2b9ba0c4a6f7e21';
const EXAMPLE_WINDOW = { start: '2027-03-01T00:00:00Z', end: '2027-03-08T00:00:00Z' };

const EVENT_CREATE_INPUT = z
  .object({
    resource_id: RESOURCE_ID,
    starts_at: DATE_TIME,
    ends_at: DATE_TIME,
    timezone: z.string().min(1).max(100),
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(10_000).optional(),
    location: z.string().max(1_000).optional(),
    organizer: ORGANIZER_INPUT.optional(),
    transparency: z.enum(['opaque', 'transparent']).default('opaque'),
    status: z.enum(['tentative', 'confirmed']).default('confirmed'),
    recurrence_rule: z.string().trim().min(1).max(2_000).optional(),
    attendees: z.array(ATTENDEE_INPUT).max(100).optional(),
    reminders: z.array(REMINDER_INPUT).max(20).optional(),
    idempotency_key: IDEMPOTENCY_KEY,
    recurrence_exceptions: z.array(RECURRENCE_EXCEPTION_INPUT).max(500).optional(),
  })
  .strict()
  .refine((value) => boundedEventSpan(value.starts_at, value.ends_at));

const OPERATION_DEFINITIONS = [
  {
    name: 'slotlock_list_resources',
    title: 'List calendar resources',
    description: 'List resources visible to the authenticated tenant principal.',
    input: z
      .object({
        cursor: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict(),
    output: z
      .object({
        resources: z
          .array(
            z
              .object({
                id: RESOURCE_ID,
                external_ref: z.string().max(500).nullable(),
                timezone: z.string().min(1).max(100),
              })
              .strict(),
          )
          .max(100),
        next_cursor: z.string().max(500).nullable(),
      })
      .strict(),
    risk: { readOnly: true, destructive: false, idempotent: true },
    invoke: 'listResources',
    example: { limit: 10 },
  },
  {
    name: 'slotlock_get_free_busy',
    title: 'Get free-busy',
    description: 'Return privacy-minimized busy intervals and explicit coverage certainty.',
    input: z
      .object({
        resource_ids: z.array(RESOURCE_ID).min(1).max(100),
        start: DATE_TIME,
        end: DATE_TIME,
      })
      .strict()
      .refine(boundedAgentWindow),
    output: z
      .object({
        resources: z
          .array(
            z
              .object({
                resource_id: RESOURCE_ID,
                busy: z.array(INTERVAL).max(10_000),
                coverage: COVERAGE,
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
    risk: { readOnly: true, destructive: false, idempotent: true },
    invoke: 'getFreeBusy',
    example: { resource_ids: [EXAMPLE_RESOURCE_ID], ...EXAMPLE_WINDOW },
  },
  {
    name: 'slotlock_find_next_available',
    title: 'Find next available interval',
    description:
      'Find the earliest certain interval that satisfies the requested duration (up to the 367-day search window, so a multi-month rental slot can be found).',
    input: z
      .object({
        resource_ids: z.array(RESOURCE_ID).min(1).max(100),
        start: DATE_TIME,
        end: DATE_TIME,
        duration_minutes: z.number().int().min(1).max(MAX_SLOT_MINUTES),
      })
      .strict()
      .refine(boundedAgentWindow),
    output: z
      .object({
        resource_id: RESOURCE_ID.nullable(),
        start: DATE_TIME.nullable(),
        end: DATE_TIME.nullable(),
        coverage: COVERAGE,
      })
      .strict(),
    risk: { readOnly: true, destructive: false, idempotent: true },
    invoke: 'findNextAvailable',
    example: { resource_ids: [EXAMPLE_RESOURCE_ID], ...EXAMPLE_WINDOW, duration_minutes: 120 },
  },
  {
    name: 'slotlock_create_event',
    title: 'Create resource event',
    description:
      'Create an event of up to 3,660 days (a booking, lease or long rental); opaque occurrences use the database overlap arbiter.',
    input: EVENT_CREATE_INPUT,
    output: z.object({ event: EVENT, replayed: z.boolean() }).strict(),
    risk: { readOnly: false, destructive: false, idempotent: true },
    invoke: 'createEvent',
    example: {
      resource_id: EXAMPLE_RESOURCE_ID,
      starts_at: '2027-03-02T09:00:00Z',
      ends_at: '2027-03-02T10:00:00Z',
      timezone: 'Europe/London',
      title: 'Vehicle handover',
      idempotency_key: 'create-handover-2027-03-02',
    },
  },
  {
    name: 'slotlock_get_event',
    title: 'Get resource event',
    description: 'Read one tenant-scoped event by stable identifier.',
    input: z.object({ event_id: EVENT_ID }).strict(),
    output: z.object({ event: EVENT }).strict(),
    risk: { readOnly: true, destructive: false, idempotent: true },
    invoke: 'getEvent',
    example: { event_id: EXAMPLE_EVENT_ID },
  },
  {
    name: 'slotlock_list_events',
    title: 'List resource events',
    description: 'List bounded events intersecting a time window.',
    input: z
      .object({
        resource_ids: z.array(RESOURCE_ID).min(1).max(100),
        start: DATE_TIME,
        end: DATE_TIME,
        cursor: z.string().max(500).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict()
      .refine(boundedAgentWindow),
    output: z
      .object({ events: z.array(EVENT).max(100), next_cursor: z.string().max(500).nullable() })
      .strict(),
    risk: { readOnly: true, destructive: false, idempotent: true },
    invoke: 'listEvents',
    example: { resource_ids: [EXAMPLE_RESOURCE_ID], ...EXAMPLE_WINDOW, limit: 50 },
  },
  {
    name: 'slotlock_update_event',
    title: 'Update resource event',
    description: 'Apply an expected-revision event patch and rematerialize occupancy atomically.',
    input: z
      .object({
        event_id: EVENT_ID,
        expected_revision: REVISION,
        resource_id: RESOURCE_ID.optional(),
        starts_at: DATE_TIME.optional(),
        ends_at: DATE_TIME.optional(),
        timezone: z.string().min(1).max(100).optional(),
        title: z.string().trim().min(1).max(500).nullable().optional(),
        description: z.string().max(10_000).nullable().optional(),
        location: z.string().max(1_000).nullable().optional(),
        organizer: ORGANIZER_INPUT.nullable().optional(),
        attendees: z.array(ATTENDEE_INPUT).max(100).optional(),
        reminders: z.array(REMINDER_INPUT).max(20).optional(),
        transparency: z.enum(['opaque', 'transparent']).optional(),
        status: z.enum(['tentative', 'confirmed']).optional(),
        recurrence_rule: z.string().trim().min(1).max(2_000).nullable().optional(),
        recurrence_exceptions: z.array(RECURRENCE_EXCEPTION_INPUT).max(500).optional(),
        idempotency_key: IDEMPOTENCY_KEY,
      })
      .strict()
      .refine(
        (value) =>
          value.starts_at !== undefined ||
          value.ends_at !== undefined ||
          value.resource_id !== undefined ||
          value.timezone !== undefined ||
          value.title !== undefined ||
          value.description !== undefined ||
          value.location !== undefined ||
          value.organizer !== undefined ||
          value.attendees !== undefined ||
          value.reminders !== undefined ||
          value.transparency !== undefined ||
          value.status !== undefined ||
          value.recurrence_rule !== undefined ||
          value.recurrence_exceptions !== undefined,
      )
      .refine(
        (value) =>
          value.starts_at === undefined ||
          value.ends_at === undefined ||
          boundedEventSpan(value.starts_at, value.ends_at),
      ),
    output: z.object({ event: EVENT, replayed: z.boolean() }).strict(),
    risk: { readOnly: false, destructive: false, idempotent: true },
    invoke: 'updateEvent',
    example: {
      event_id: EXAMPLE_EVENT_ID,
      expected_revision: 1,
      starts_at: '2027-03-02T10:00:00Z',
      ends_at: '2027-03-02T11:00:00Z',
      idempotency_key: 'move-handover-2027-03-02',
    },
  },
  {
    name: 'slotlock_delete_event',
    title: 'Delete resource event',
    description: 'Tombstone an event at an expected revision so stale sync cannot resurrect it.',
    input: z
      .object({
        event_id: EVENT_ID,
        expected_revision: REVISION,
        idempotency_key: IDEMPOTENCY_KEY,
      })
      .strict(),
    output: z
      .object({
        event_id: EVENT_ID,
        revision: REVISION,
        deleted: z.literal(true),
        replayed: z.boolean(),
      })
      .strict(),
    risk: { readOnly: false, destructive: true, idempotent: true },
    invoke: 'deleteEvent',
    example: {
      event_id: EXAMPLE_EVENT_ID,
      expected_revision: 2,
      idempotency_key: 'cancel-handover-2027-03-02',
    },
  },
] as const satisfies readonly OperationDefinition[];

const FORMATS_WITHOUT_PATTERN = new Set(['date-time', 'email']);

function toJsonSchema(schema: ObjectSchema, io: 'input' | 'output'): JsonSchema {
  // Zod's own converter: zod-to-json-schema reads only Zod 3 schemas (for a Zod 4 one it returns {})
  // and its repository is archived. A type JSON Schema cannot express throws rather than vanishing.
  const value = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'throw',
    override: ({ jsonSchema }) => {
      // Zod 4.6 writes its validation regex beside `format` for dates and emails (288 and 102
      // characters, on 60 fields): the format already says it, and every agent reads the list.
      if (FORMATS_WITHOUT_PATTERN.has(String(jsonSchema.format))) delete jsonSchema.pattern;
    },
  }) as Record<string, unknown>;
  delete value.$schema;
  return value;
}

const OPERATIONS = new Map<SlotlockAgentOperation, OperationDefinition>(
  OPERATION_DEFINITIONS.map((operation) => [operation.name, operation]),
);

const LEGACY_OPERATION_NAMES = new Map<string, SlotlockAgentOperation>(
  Object.entries(SLOTLOCK_AGENT_OPERATION_LEGACY_NAMES),
);

/** Runtime type guard for the current operation names (legacy dotted names are not included). */
export function isSlotlockAgentOperation(name: unknown): name is SlotlockAgentOperation {
  return typeof name === 'string' && OPERATIONS.has(name as SlotlockAgentOperation);
}

/**
 * The operation a client-supplied tool or skill name addresses: a current name, or a legacy dotted
 * name mapped to its current one. Anything else is `null`. Every dispatch path resolves through this,
 * so a client written against either name keeps working.
 */
export function resolveSlotlockAgentOperation(name: unknown): SlotlockAgentOperation | null {
  if (isSlotlockAgentOperation(name)) return name;
  return typeof name === 'string' ? (LEGACY_OPERATION_NAMES.get(name) ?? null) : null;
}

/** One `tools/call` result; the shape every MCP binding of a Slotlock operation returns. */
export type SlotlockMcpToolResult =
  | {
      content: [{ type: 'text'; text: string }];
      structuredContent: Record<string, unknown>;
    }
  | { content: [{ type: 'text'; text: string }]; isError: true };

/**
 * Encode one operation outcome as an MCP `tools/call` result. A failure is a tool execution error
 * (`isError`) whose text is `{"error":{"code":…}}` and which carries NO `structuredContent`: a tool's
 * `outputSchema` describes its success, MCP requires structured results to conform to it, and the
 * official SDK validates `structuredContent` whenever present — an error object there turns a failure
 * the model should read ("slot taken") into a protocol exception.
 */
export function slotlockMcpToolResult(
  outcome:
    | { ok: true; data: Record<string, unknown> }
    | {
        ok: false;
        code: string;
        details?: Readonly<Record<string, string | number | boolean | null>>;
      },
): SlotlockMcpToolResult {
  if (outcome.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.data) }],
      structuredContent: outcome.data,
    };
  }
  const error: Record<string, unknown> = { code: outcome.code };
  for (const [key, value] of Object.entries(outcome.details ?? {})) {
    if (key !== 'code') error[key] = value;
  }
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
}

export function slotlockAgentTools() {
  return OPERATION_DEFINITIONS.map((operation) => ({
    name: operation.name,
    title: operation.title,
    description: operation.description,
    inputSchema: toJsonSchema(operation.input, 'input'),
    outputSchema: toJsonSchema(operation.output, 'output'),
    annotations: {
      title: operation.title,
      readOnlyHint: operation.risk.readOnly,
      destructiveHint: operation.risk.destructive,
      idempotentHint: operation.risk.idempotent,
      openWorldHint: false,
    },
    ...(operation.risk.readOnly
      ? {
          _meta: {
            ui: {
              resourceUri: SLOTLOCK_MCP_APP_RESOURCE_URI,
              visibility: ['model', 'app'] as const,
            },
          },
        }
      : {}),
  }));
}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function empty(status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) throw new Error('request_too_large');
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error('request_too_large');
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('invalid_json');
  }
}

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function isCanonicalBoundedIdentifier(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    new TextEncoder().encode(value).byteLength <= maxBytes &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

function isCanonicalPrincipalIdentity(value: unknown): value is string {
  return isCanonicalBoundedIdentifier(value, 500);
}

/** HTTPS, or plain HTTP on a loopback host when the embedder opted into local development. */
function isAcceptedTransport(url: URL, allowInsecureLocalhost: boolean | undefined): boolean {
  return (
    url.protocol === 'https:' ||
    (allowInsecureLocalhost === true &&
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'))
  );
}

const OAUTH_METADATA_PATH = '/.well-known/oauth-protected-resource';
// RFC 6749 §3.3 scope-token: printable ASCII except space, `"` and `\`, so it can sit in a quoted header.
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/;

interface OAuthDiscovery {
  /** Path-aware (RFC 9728 §3.1) and origin-root metadata locations, both answered. */
  metadataPaths: ReadonlySet<string>;
  metadata: Readonly<Record<string, unknown>>;
  /** `WWW-Authenticate` for a 401 from the MCP endpoint. */
  challenge: string;
}

function validateOAuth(
  oauth: SlotlockAgentServerOAuthOptions,
  mcpEndpoint: URL,
  allowInsecureLocalhost: boolean | undefined,
): OAuthDiscovery {
  const invalid = (what: string) => new Error(`Slotlock agent server oauth.${what} is invalid`);
  const authorizationServers = [...oauth.authorizationServers].map((value) => {
    let issuer: URL;
    try {
      issuer = new URL(value);
    } catch {
      throw invalid('authorizationServers');
    }
    // An issuer identifier is compared as an exact string (RFC 8414 §3.3), so it is published as
    // configured. It must already be canonical: parsing may only add the slash of a bare origin.
    // It has no query or fragment (§2), not even an empty one, which the parser keeps in `href`.
    if (
      !isAcceptedTransport(issuer, allowInsecureLocalhost) ||
      issuer.username ||
      issuer.password ||
      value.includes('?') ||
      value.includes('#') ||
      (issuer.href !== value && issuer.href !== `${value}/`)
    ) {
      throw invalid('authorizationServers');
    }
    return value;
  });
  if (authorizationServers.length === 0 || authorizationServers.length > 20) {
    throw invalid('authorizationServers');
  }
  for (const [name, scopes] of [
    ['scopesSupported', oauth.scopesSupported ?? []],
    ['requiredScopes', oauth.requiredScopes ?? []],
  ] as const) {
    if (scopes.length > 100 || !scopes.every((scope) => SCOPE_TOKEN.test(scope))) {
      throw invalid(name);
    }
  }
  if (oauth.resourceName !== undefined && !isCanonicalBoundedIdentifier(oauth.resourceName, 200)) {
    throw invalid('resourceName');
  }
  let documentation: string | undefined;
  if (oauth.resourceDocumentation !== undefined) {
    try {
      const page = new URL(oauth.resourceDocumentation);
      if (page.protocol !== 'https:') throw invalid('resourceDocumentation');
      documentation = page.href;
    } catch {
      throw invalid('resourceDocumentation');
    }
  }

  const pathAware = `${OAUTH_METADATA_PATH}${mcpEndpoint.pathname}`;
  const requiredScopes = oauth.requiredScopes ?? [];
  return {
    metadataPaths: new Set([pathAware, OAUTH_METADATA_PATH]),
    metadata: Object.freeze({
      resource: mcpEndpoint.href,
      authorization_servers: authorizationServers,
      ...(oauth.scopesSupported ? { scopes_supported: [...oauth.scopesSupported] } : {}),
      bearer_methods_supported: ['header'],
      ...(oauth.resourceName ? { resource_name: oauth.resourceName } : {}),
      ...(documentation ? { resource_documentation: documentation } : {}),
    }),
    challenge: [
      'Bearer realm="slotlock"',
      `resource_metadata="${mcpEndpoint.origin}${pathAware}"`,
      ...(requiredScopes.length > 0 ? [`scope="${requiredScopes.join(' ')}"`] : []),
    ].join(', '),
  };
}

function validateOptions(options: SlotlockAgentServerOptions): {
  publicBaseUrl: string;
  basePath: string;
  allowedOrigins: Set<string>;
  maxRequestBytes: number;
  oauth: OAuthDiscovery | null;
} {
  const parsed = new URL(options.publicBaseUrl);
  if (!isAcceptedTransport(parsed, options.allowInsecureLocalhost)) {
    throw new Error(
      'Slotlock agent server publicBaseUrl must use HTTPS (set allowInsecureLocalhost: true to serve http://localhost during development)',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Slotlock agent server publicBaseUrl must be an origin plus optional path');
  }
  const allowedOrigins = new Set<string>();
  for (const value of options.allowedOrigins ?? [parsed.origin]) {
    const origin = normalizeOrigin(value);
    if (!origin) throw new Error('Slotlock agent server allowedOrigins contains an invalid origin');
    if (!isAcceptedTransport(new URL(origin), options.allowInsecureLocalhost)) {
      throw new Error('Slotlock agent server allowedOrigins must use HTTPS');
    }
    allowedOrigins.add(origin);
  }
  const publicBaseUrl = parsed.href.replace(/\/$/, '');
  return {
    publicBaseUrl,
    basePath: parsed.pathname.replace(/\/$/, ''),
    allowedOrigins,
    maxRequestBytes: Math.max(1_024, Math.min(options.maxRequestBytes ?? 262_144, 1_048_576)),
    oauth: options.oauth
      ? validateOAuth(
          options.oauth,
          new URL(`${publicBaseUrl}/mcp`),
          options.allowInsecureLocalhost,
        )
      : null,
  };
}

/**
 * Canonical transport-neutral operation boundary. Every host shares the package's schemas,
 * principal validation, authorization, per-operation limiter and bounded backend error mapping.
 */
export async function invokeSlotlockAgentOperation(args: {
  operation: unknown;
  input: unknown;
  request: Request;
  options: SlotlockAgentOperationDispatchOptions;
  /** Validated W3C trace context to hand the backend (see `SlotlockAgentInvocationContext.trace`). */
  trace?: SlotlockTraceContext;
}): Promise<SlotlockAgentOperationDispatchResult> {
  try {
    const principal = await args.options.authenticate(args.request);
    if (
      !principal ||
      !isCanonicalPrincipalIdentity(principal.subject) ||
      !isCanonicalPrincipalIdentity(principal.tenantRef)
    ) {
      return { ok: false, status: 401, code: 'authentication_required' };
    }
    const resolved = resolveSlotlockAgentOperation(args.operation);
    const operation = resolved ? OPERATIONS.get(resolved) : undefined;
    if (!operation) return { ok: false, status: 404, code: 'operation_not_found' };
    if (!principalScopesCover(principal, operation.name)) {
      return { ok: false, status: 403, code: 'forbidden' };
    }
    const input =
      args.input && typeof args.input === 'object' && !Array.isArray(args.input)
        ? (args.input as Record<string, unknown>)
        : {};
    const parsed = operation.input.safeParse(input);
    if (!parsed.success) return { ok: false, status: 400, code: 'invalid_arguments' };
    if (
      !(await args.options.authorize({
        principal,
        operation: operation.name,
        input: parsed.data,
      }))
    ) {
      return { ok: false, status: 403, code: 'forbidden' };
    }
    if (args.options.confirm) {
      const halt = await args.options.confirm({
        principal,
        operation: operation.name,
        input: parsed.data,
      });
      if (halt) return { ok: false, status: halt.status, code: halt.code };
    }
    if (
      args.options.consumeRateLimit &&
      !(await args.options.consumeRateLimit({ principal, operation: operation.name }))
    ) {
      return { ok: false, status: 429, code: 'rate_limited' };
    }
    const method = args.options.backend[operation.invoke] as (
      context: SlotlockAgentInvocationContext,
      input: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const context: SlotlockAgentInvocationContext = {
      principal,
      operation: operation.name,
      signal: args.request.signal,
    };
    if (args.trace) context.trace = args.trace;
    const data = await method.call(args.options.backend, context, parsed.data);
    if (!operation.output.safeParse(data).success) {
      return { ok: false, status: 500, code: 'invalid_backend_result' };
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof SlotlockAgentOperationError) {
      return { ok: false, status: error.status, code: error.code };
    }
    return { ok: false, status: 500, code: 'internal_error' };
  }
}

/** Failures that are server faults, not operation outcomes an agent could act on. */
const INTERNAL_FAILURES = new Set(['internal_error', 'invalid_backend_result']);

/**
 * A2A 1.0 methods (a2a.proto `A2AService`) this synchronous, stateless binding does not implement.
 * A2A §3.3.4 fixes the error for the capability-gated ones: push-notification configuration answers
 * `PushNotificationNotSupportedError`; streaming, task subscription and the extended card answer
 * `UnsupportedOperationError`. GetTask, CancelTask and ListTasks are core operations every agent
 * answers; since every reply here is a message, no task id exists: `TaskNotFoundError` for the
 * first two (§3.1) and an empty page for the list.
 */
const A2A_PUSH_NOTIFICATION_METHODS = new Set([
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
]);
const A2A_UNSUPPORTED_METHODS = new Set([
  'SendStreamingMessage',
  'SubscribeToTask',
  'GetExtendedAgentCard',
]);
/** The A2A 1.0 request fields of each task method (a2a.proto). */
const A2A_TASK_METHOD_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['GetTask', new Set(['tenant', 'id', 'historyLength'])],
  ['CancelTask', new Set(['tenant', 'id', 'metadata'])],
  [
    'ListTasks',
    new Set([
      'tenant',
      'contextId',
      'status',
      'pageSize',
      'pageToken',
      'historyLength',
      'statusTimestampAfter',
      'includeArtifacts',
    ]),
  ],
]);
const A2A_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/**
 * Read an A2A `google.protobuf.Timestamp` in its JSON form, as `ListTasks.statusTimestampAfter`
 * carries it: RFC 3339 in UTC (`Z`) with at most nine fractional digits, naming an instant that
 * exists (no 30 February, no 24:00:00, no leap second, no year 0). Anything else is null.
 */
export function parseSlotlockA2ATimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const matched = A2A_TIMESTAMP.exec(value);
  if (!matched) return null;
  // Date.parse rolls an impossible date or 24:00:00 over to the next day, so compare every field.
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  const [, year, month, day, hour, minute, second] = matched;
  if (
    Number(year) < 1 ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second)
  ) {
    return null;
  }
  return parsed;
}

/** A request's `tenant`: absent, or '' (the proto3 default of a field without presence), is the caller's. */
function isCallerTenant(tenant: unknown, tenantRef: string): boolean {
  return tenant === undefined || tenant === '' || tenant === tenantRef;
}

/**
 * Whether a task method's params are well formed for this caller. As for SendMessage, a field the
 * method does not define or a tenant other than the caller's is refused, and each value must have
 * its proto type, so a malformed request fails here as it would on an agent that keeps tasks. A
 * field without presence at its proto3 default ('', TASK_STATE_UNSPECIFIED) is unset. A page token
 * must come from an earlier response (`nextPageToken`), and this binding never issues one.
 */
function isValidA2ATaskRequest(method: string, params: unknown, tenantRef: string): boolean {
  const fields = A2A_TASK_METHOD_FIELDS.get(method);
  const request = params ?? {};
  if (!fields || typeof request !== 'object' || Array.isArray(request)) return false;
  const {
    tenant,
    id,
    historyLength,
    metadata,
    contextId,
    status,
    pageSize,
    pageToken,
    statusTimestampAfter,
    includeArtifacts,
  } = request as Record<string, unknown>;
  const isCount = (value: unknown, min: number, max: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
  return (
    Object.keys(request).every((key) => fields.has(key)) &&
    isCallerTenant(tenant, tenantRef) &&
    (method === 'ListTasks' || (typeof id === 'string' && id.length > 0)) &&
    (historyLength === undefined || isCount(historyLength, 0, Number.MAX_SAFE_INTEGER)) &&
    (metadata === undefined ||
      (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata))) &&
    (contextId === undefined || typeof contextId === 'string') &&
    (status === undefined || (SLOTLOCK_A2A_TASK_STATES as readonly unknown[]).includes(status)) &&
    (pageSize === undefined ||
      isCount(pageSize, SLOTLOCK_A2A_TASK_PAGE_SIZE.min, SLOTLOCK_A2A_TASK_PAGE_SIZE.max)) &&
    (pageToken === undefined || pageToken === '') &&
    (statusTimestampAfter === undefined ||
      parseSlotlockA2ATimestamp(statusTimestampAfter) !== null) &&
    (includeArtifacts === undefined || typeof includeArtifacts === 'boolean')
  );
}

function isLegacyMcpVersion(version: string): boolean {
  return LEGACY_MCP_VERSIONS.includes(version);
}

/**
 * Which MCP era serves a request (2026-07-28 basic/versioning, dual-era server): `initialize` always
 * selects the 2025 lifecycle; a request whose `_meta` or `MCP-Protocol-Version` names anything but a
 * 2025 revision is a 2026-07-28 request — validated there, so a missing field, a disagreeing header
 * or an unknown revision gets that revision's precise error. Everything else keeps the 2025 path.
 */
function mcpEra(rpc: { method: string; params?: unknown }, headerVersion: string | null) {
  if (rpc.method === 'initialize') return 'legacy' as const;
  const meta = isRecord(rpc.params) && isRecord(rpc.params._meta) ? rpc.params._meta : undefined;
  const bodyVersion = meta?.[MCP_META_PROTOCOL_VERSION];
  if (bodyVersion === undefined) {
    return headerVersion !== null && MODERN_MCP_VERSIONS.includes(headerVersion)
      ? ('modern' as const)
      : ('legacy' as const);
  }
  return typeof bodyVersion === 'string' &&
    isLegacyMcpVersion(bodyVersion) &&
    (headerVersion === null || isLegacyMcpVersion(headerVersion))
    ? ('legacy' as const)
    : ('modern' as const);
}

const SERVER_INFO = Object.freeze({
  name: 'slotlock',
  version: SLOTLOCK_AGENT_SERVER_VERSION,
});
/** Static, tenant-free results (discovery, tool and template lists, the UI) — an hour, any cache. */
const PUBLIC_CACHE = Object.freeze({ ttlMs: 3_600_000, cacheScope: 'public' as const });
/** A tenant's resource list: a minute, and only for the same credentials. */
const PRIVATE_LIST_CACHE = Object.freeze({ ttlMs: 60_000, cacheScope: 'private' as const });
/** Free/busy is stale as soon as it is read; a subscription is how a client learns of changes. */
const PRIVATE_UNCACHED = Object.freeze({ ttlMs: 0, cacheScope: 'private' as const });

/**
 * RFC 6570 template of a calendar resource's MCP URI. Reading one returns the resource's free/busy
 * for the days ahead (`resourceWindowDays`); subscribing to it delivers
 * `notifications/resources/updated` when that changes.
 */
export const SLOTLOCK_MCP_RESOURCE_URI_TEMPLATE = 'slotlock://resources/{resource_id}';
const CALENDAR_RESOURCE_URI_PREFIX = 'slotlock://resources/';
const DAY_MS = 24 * 60 * 60 * 1_000;
const PERCENT_ENCODED = /^(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+$/;

function validateResourceWindowDays(value: number | undefined): number {
  const days = value ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > SLOTLOCK_CALENDAR_HORIZON_DAYS) {
    throw new Error('Slotlock agent server resourceWindowDays is invalid');
  }
  return days;
}

/** The `resources/templates/list` entry for calendar resources that look `days` ahead. */
function calendarResourceTemplate(days: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    uriTemplate: SLOTLOCK_MCP_RESOURCE_URI_TEMPLATE,
    name: 'resource-calendar',
    title: 'Resource calendar',
    description: `Busy intervals and coverage certainty of one bookable resource for the next ${days} days. Subscribe to be told when they change.`,
    mimeType: 'application/json',
  });
}

/** Percent-encode all but RFC 3986 unreserved characters, as RFC 6570 simple expansion does. */
function encodeUnreserved(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The MCP resource URI of one calendar resource: `SLOTLOCK_MCP_RESOURCE_URI_TEMPLATE`, expanded. */
export function slotlockCalendarResourceUri(resourceId: string): string {
  return `${CALENDAR_RESOURCE_URI_PREFIX}${encodeUnreserved(resourceId)}`;
}

/**
 * The resource id a calendar resource URI names; `null` for any other URI. Only the canonical spelling
 * is accepted, so a resource has one URI: subscriptions, acknowledgments and client caches compare
 * URIs as strings.
 */
function parseCalendarResourceUri(uri: string): string | null {
  if (!uri.startsWith(CALENDAR_RESOURCE_URI_PREFIX)) return null;
  const encoded = uri.slice(CALENDAR_RESOURCE_URI_PREFIX.length);
  if (!PERCENT_ENCODED.test(encoded)) return null;
  let resourceId: string;
  try {
    resourceId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const parsed = RESOURCE_ID.safeParse(resourceId);
  return parsed.success && parsed.data === resourceId && encodeUnreserved(resourceId) === encoded
    ? resourceId
    : null;
}

/**
 * The window a calendar resource's content covers: `days` from the start of the current minute, so
 * reads within one minute describe the same window.
 */
function calendarResourceWindow(now: number, days: number): { start: string; end: string } {
  const start = now - (now % 60_000);
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + days * DAY_MS).toISOString(),
  };
}

/** One tenant resource as an MCP `Resource` whose content looks `days` ahead. */
function calendarResource(
  resource: { id: string; external_ref: string | null; timezone: string },
  days: number,
): Record<string, unknown> {
  return {
    uri: slotlockCalendarResourceUri(resource.id),
    name: resource.id,
    title: resource.external_ref ?? resource.id,
    description: `Free/busy of this resource for the next ${days} days (${resource.timezone}).`,
    mimeType: 'application/json',
  };
}

/** Each resource's free/busy entry, digested: equal content, equal digest. */
function freeBusyDigests(data: Record<string, unknown>): Map<string, string> {
  const digests = new Map<string, string>();
  for (const entry of data.resources as Record<string, unknown>[]) {
    digests.set(String(entry.resource_id), sha256Hex(canonicalJson(entry)));
  }
  return digests;
}

/** Dispatch failures that mean "this principal cannot see that resource". */
const INVISIBLE_STATUSES: ReadonlySet<number> = new Set([400, 403, 404]);
/** Resource URIs one subscription may watch. */
const MAX_RESOURCE_SUBSCRIPTIONS = 20;
/** Consecutive failed re-reads after which a subscription is abandoned. */
const MAX_POLL_FAILURES = 3;

interface SubscriptionPolicy {
  pollIntervalMs: number;
  maxDurationMs: number;
  keepAliveMs: number;
  maxPerPrincipal: number;
  maxTotal: number;
}

function validateSubscriptions(
  value: SlotlockAgentSubscriptionOptions | false | undefined,
): SubscriptionPolicy | null {
  if (value === false) return null;
  const bounded = (
    name: keyof SlotlockAgentSubscriptionOptions,
    min: number,
    max: number,
    fallback: number,
  ) => {
    const setting = value?.[name] ?? fallback;
    if (!Number.isInteger(setting) || setting < min || setting > max) {
      throw new Error(`Slotlock agent server subscriptions.${name} is invalid`);
    }
    return setting;
  };
  return {
    pollIntervalMs: bounded('pollIntervalMs', 1_000, 300_000, 10_000),
    maxDurationMs: bounded('maxDurationMs', 60_000, 86_400_000, 900_000),
    keepAliveMs: bounded('keepAliveMs', 1_000, 60_000, 15_000),
    maxPerPrincipal: bounded('maxPerPrincipal', 1, 64, 4),
    maxTotal: bounded('maxTotal', 1, 10_000, 256),
  };
}

/**
 * The resource ids a `subscriptions/listen` filter asks to watch. Only `resourceSubscriptions` can be
 * honored (Slotlock's tool and resource lists do not change at run time); a URI that names no calendar
 * resource is simply not honored. A malformed filter is refused.
 */
function parseSubscriptionFilter(
  value: unknown,
):
  | { ok: true; resourceIds: string[] }
  | { ok: false; message: string; data?: Record<string, unknown> } {
  if (!isRecord(value)) return { ok: false, message: 'Invalid params: notifications' };
  for (const flag of ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') {
      return { ok: false, message: `Invalid params: notifications.${flag}` };
    }
  }
  const requested = value.resourceSubscriptions;
  if (requested === undefined) return { ok: true, resourceIds: [] };
  if (!Array.isArray(requested) || !requested.every((uri) => typeof uri === 'string')) {
    return { ok: false, message: 'Invalid params: notifications.resourceSubscriptions' };
  }
  const uris = [...new Set(requested as string[])];
  if (uris.length > MAX_RESOURCE_SUBSCRIPTIONS) {
    return {
      ok: false,
      message: 'Too many resource subscriptions',
      data: { max: MAX_RESOURCE_SUBSCRIPTIONS },
    };
  }
  const resourceIds: string[] = [];
  for (const uri of uris) {
    const resourceId = parseCalendarResourceUri(uri);
    if (resourceId !== null) resourceIds.push(resourceId);
  }
  return { ok: true, resourceIds };
}

/** A timer that does not by itself keep a Node process alive (a no-op on other runtimes). */
function unref<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** Natural-language guidance `server/discover` gives the model on how to use these tools well. */
const SLOTLOCK_MCP_INSTRUCTIONS = [
  'Slotlock is a tenant-isolated resource calendar (vehicles, rooms, equipment).',
  'Check availability before booking: slotlock_get_free_busy returns busy intervals and slotlock_find_next_available the earliest free slot of a given length; an answer is certain only when coverage.certainty is "certain".',
  'slotlock_create_event needs an idempotency_key: retry with the same key and arguments, never a new key for the same booking. slotlock_update_event and slotlock_delete_event need the event revision you last read as expected_revision.',
  'Times are RFC 3339 with an offset; intervals are half-open [start, end).',
  'A failed call returns {"error":{"code":"…"}}; read the code before retrying (overlap means the slot is taken).',
].join(' ');

const WRITE_OPERATIONS: ReadonlySet<SlotlockAgentOperation> = new Set([
  'slotlock_create_event',
  'slotlock_update_event',
  'slotlock_delete_event',
]);
/** The key of the one input request a confirmation prompt carries. */
const CONFIRMATION_INPUT_KEY = 'slotlock_confirm';
/** A single tick box: flat primitives only, as form elicitation requires. */
const CONFIRMATION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    confirm: {
      type: 'boolean',
      title: 'Confirm this change',
      description: 'The agent changes the calendar only if this is ticked.',
      default: false,
    },
  },
  required: ['confirm'],
});

interface ConfirmationPolicy {
  operations: ReadonlySet<SlotlockAgentOperation>;
  keys: Buffer[];
  ttlMs: number;
}

function validateConfirmation(
  value: SlotlockAgentConfirmationOptions | undefined,
): ConfirmationPolicy | null {
  if (value === undefined) return null;
  const invalid = (what: string) =>
    new Error(`Slotlock agent server confirmation.${what} is invalid`);
  if (
    !Array.isArray(value.operations) ||
    value.operations.length === 0 ||
    value.operations.some((operation) => !WRITE_OPERATIONS.has(operation))
  ) {
    throw invalid('operations');
  }
  const keys = stateSecrets(value.secrets);
  const ttlSeconds = value.ttlSeconds ?? 600;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3_600) {
    throw invalid('ttlSeconds');
  }
  return { operations: new Set(value.operations), keys, ttlMs: ttlSeconds * 1_000 };
}

/** An empty `elicitation` object declares form mode (2026-07-28 client/elicitation §Capabilities). */
function clientSupportsFormElicitation(capabilities: Record<string, unknown>): boolean {
  const elicitation = capabilities.elicitation;
  return (
    isRecord(elicitation) && (Object.keys(elicitation).length === 0 || isRecord(elicitation.form))
  );
}

/**
 * Agent-supplied text as the person will read it: one line, no control, format (bidirectional
 * override) or separator characters, and bounded.
 */
function promptText(value: unknown, max = 120): string {
  const text = String(value ?? '')
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .trim();
  const characters = Array.from(text);
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : text;
}

/** A local wall-clock rendering, independent of the server's locale data. */
function promptWall(instant: unknown, timezone: string): { date: string; time: string } {
  return zonedWallTime(new Date(String(instant)), timezone);
}

function promptRange(startsAt: unknown, endsAt: unknown, timezone: unknown): string {
  let zone = typeof timezone === 'string' ? timezone : 'UTC';
  let start: { date: string; time: string };
  let end: { date: string; time: string };
  try {
    start = promptWall(startsAt, zone);
    end = promptWall(endsAt, zone);
  } catch {
    zone = 'UTC';
    start = promptWall(startsAt, zone);
    end = promptWall(endsAt, zone);
  }
  const until = end.date === start.date ? `–${end.time}` : ` – ${end.date} ${end.time}`;
  return `${start.date} ${start.time}${until} (${promptText(zone, 64)})`;
}

function promptInstant(instant: unknown, timezone: unknown): string {
  let zone = typeof timezone === 'string' ? timezone : 'UTC';
  let wall: { date: string; time: string };
  try {
    wall = promptWall(instant, zone);
  } catch {
    zone = 'UTC';
    wall = promptWall(instant, zone);
  }
  return `${wall.date} ${wall.time} (${promptText(zone, 64)})`;
}

/**
 * Text the agent chose (a title), shown inside double quotes: its own double quotes become single
 * ones, so it cannot close the quotes and pass itself off as part of the sentence.
 */
function promptQuoted(value: unknown, max = 120): string {
  return `"${promptText(value, max).replaceAll('"', "'")}"`;
}

/** An event as the question shows it: what it is, where and when it is now. */
interface ConfirmationEvent {
  title: string | null;
  resourceId: string;
  range: string;
}

/** What the question may read for the calling principal; every lookup falls back to an id. */
interface ConfirmationLookup {
  resource(id: unknown): Promise<string>;
  event(id: unknown): Promise<ConfirmationEvent | null>;
}

function confirmationLookup(
  backend: SlotlockAgentCalendarBackend,
  context: SlotlockAgentInvocationContext,
): ConfirmationLookup {
  return {
    async resource(id) {
      const fallback = `resource ${promptText(id, 200)}`;
      if (typeof id !== 'string' || !backend.describeResource) return fallback;
      try {
        const label = await backend.describeResource(context, id);
        return typeof label === 'string' && promptText(label, 200).length > 0
          ? promptText(label, 200)
          : fallback;
      } catch {
        return fallback;
      }
    },
    async event(id) {
      if (typeof id !== 'string') return null;
      try {
        const found = await backend.getEvent(context, { event_id: id });
        const event = isRecord(found) && isRecord(found.event) ? found.event : null;
        if (
          !event ||
          typeof event.resource_id !== 'string' ||
          typeof event.starts_at !== 'string' ||
          typeof event.ends_at !== 'string'
        ) {
          return null;
        }
        return {
          title: typeof event.title === 'string' && event.title.length > 0 ? event.title : null,
          resourceId: event.resource_id,
          range: promptRange(event.starts_at, event.ends_at, event.timezone),
        };
      } catch {
        return null;
      }
    },
  };
}

/**
 * The sentence a person confirms: what changes, where and when. The facts the server establishes
 * (the resource, the times, the event as it stands) come first; text the agent chose comes after
 * them, quoted, so a title cannot pass itself off as the time or the resource.
 */
async function confirmationMessage(
  operation: SlotlockAgentOperation,
  input: Record<string, unknown>,
  lookup: ConfirmationLookup,
): Promise<string> {
  let message: string;
  if (operation === 'slotlock_create_event') {
    const where = await lookup.resource(input.resource_id);
    const title = typeof input.title === 'string' && input.title.length > 0 ? input.title : null;
    message = `Book ${where} for ${promptRange(input.starts_at, input.ends_at, input.timezone)}${title ? `: ${promptQuoted(title)}` : ''}.`;
    if (typeof input.recurrence_rule === 'string') {
      message += ` Repeats: ${promptText(input.recurrence_rule, 200)}.`;
    }
    if (input.status === 'tentative') message += ' Tentative.';
  } else {
    const event = await lookup.event(input.event_id);
    const target = event
      ? `${event.title ? promptQuoted(event.title) : 'the booking'} on ${await lookup.resource(event.resourceId)}, ${event.range}`
      : `event ${promptText(input.event_id, 500)}`;
    if (operation === 'slotlock_delete_event') {
      message = `Delete ${target}.`;
    } else {
      const changes: string[] = [];
      if (typeof input.starts_at === 'string' && typeof input.ends_at === 'string') {
        changes.push(`time to ${promptRange(input.starts_at, input.ends_at, input.timezone)}`);
      } else if (typeof input.starts_at === 'string') {
        changes.push(`start to ${promptInstant(input.starts_at, input.timezone)}`);
      } else if (typeof input.ends_at === 'string') {
        changes.push(`end to ${promptInstant(input.ends_at, input.timezone)}`);
      } else if (typeof input.timezone === 'string') {
        changes.push(`timezone to ${promptText(input.timezone, 64)}`);
      }
      if (typeof input.resource_id === 'string') {
        changes.push(`resource to ${await lookup.resource(input.resource_id)}`);
      }
      for (const field of ['status', 'transparency'] as const) {
        if (input[field] !== undefined) changes.push(`${field} to ${promptText(input[field], 20)}`);
      }
      if (input.recurrence_rule !== undefined) {
        changes.push(
          input.recurrence_rule === null
            ? 'no longer repeats'
            : `repeats: ${promptText(input.recurrence_rule, 200)}`,
        );
      }
      const details = [
        'description',
        'location',
        'organizer',
        'attendees',
        'reminders',
        'recurrence_exceptions',
      ].filter((field) => input[field] !== undefined);
      if (details.length > 0) changes.push(`also ${details.join(', ')}`);
      // The agent's own text goes last.
      if (input.title !== undefined) {
        changes.push(input.title === null ? 'title removed' : `title to ${promptQuoted(input.title)}`);
      }
      message = `Change ${target}: ${changes.join('; ')}.`;
    }
  }
  return promptText(message, 1_000);
}

type ConfirmationDecision =
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'prompt'
  | 'expired'
  | 'invalid';

/**
 * Read the client's retry of a guarded call. State this server did not seal, sealed for another
 * principal, another operation or other arguments is `invalid`; lapsed state, or an answer that is
 * missing, is asked again; only an explicit `accept` with the box ticked runs the write.
 */
function decideConfirmation(args: {
  policy: ConfirmationPolicy;
  params: Record<string, unknown>;
  principal: SlotlockAgentPrincipal;
  operation: SlotlockAgentOperation;
  argsDigest: string;
}): ConfirmationDecision {
  if (args.params.requestState === undefined) return 'prompt';
  const opened = openRequestState(args.policy.keys, args.params.requestState);
  if (!opened) return 'invalid';
  const state = opened.payload;
  if (
    state.op !== args.operation ||
    state.args !== args.argsDigest ||
    state.principal !== principalTag(opened.key, args.principal) ||
    typeof state.exp !== 'number'
  ) {
    return 'invalid';
  }
  if (state.exp <= Date.now()) return 'expired';
  const responses = args.params.inputResponses;
  if (responses === undefined) return 'prompt';
  if (!isRecord(responses)) return 'invalid';
  const response = responses[CONFIRMATION_INPUT_KEY];
  if (response === undefined) return 'prompt';
  if (!isRecord(response) || (response.content !== undefined && !isRecord(response.content))) {
    return 'invalid';
  }
  if (response.action === 'cancel') return 'cancelled';
  if (response.action === 'decline') return 'declined';
  if (response.action !== 'accept') return 'invalid';
  return isRecord(response.content) && response.content.confirm === true ? 'accepted' : 'declined';
}

/** What a guarded call answers instead of running, per decision. */
const CONFIRMATION_HALT: Readonly<
  Record<Exclude<ConfirmationDecision, 'accepted'>, { status: number; code: string }>
> = {
  prompt: { status: 428, code: 'confirmation_required' },
  expired: { status: 428, code: 'confirmation_required' },
  declined: { status: 409, code: 'confirmation_declined' },
  cancelled: { status: 409, code: 'confirmation_cancelled' },
  invalid: { status: 400, code: 'confirmation_invalid' },
};
const CONFIRMATION_OUTCOME = {
  accepted: 'accepted',
  declined: 'declined',
  cancelled: 'cancelled',
  prompt: 'requested',
  expired: 'expired',
  invalid: 'refused',
} as const satisfies Record<ConfirmationDecision, string>;

/**
 * An A2A JSON-RPC error. A2A §9.5 carries errors in the JSON-RPC envelope (every JSON-RPC example is
 * `HTTP/1.1 200 OK`), with `error.data` holding `@type` objects — here a `google.rpc.ErrorInfo`.
 */
function a2aError(
  id: string | number | null,
  code: number,
  message: string,
  info: { reason: string; domain: string; metadata?: Record<string, string> },
): Response {
  return json(200, {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', ...info }],
    },
  });
}

/** Map a request path onto the server's base path; `null` when it lies outside it. */
function routePath(pathname: string, basePath: string): string | null {
  if (basePath === '') return pathname;
  if (pathname === basePath) return '/';
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
}

/** The A2A 1.0 agent card, in the JSON form of a2a.proto's `AgentCard`. */
function agentCard(publicBaseUrl: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name: 'Slotlock Agent Calendar',
    description: `Tenant-isolated resource events, recurrence, free-busy, and scheduling. Invoke a skill with one application/json data part {"skill": "<skill id>", "arguments": {…}}; argument and result JSON Schemas are published at ${publicBaseUrl}/manifest.json.`,
    supportedInterfaces: [
      {
        url: `${publicBaseUrl}/a2a`,
        protocolBinding: 'JSONRPC',
        protocolVersion: SLOTLOCK_A2A_PROTOCOL_VERSION,
      },
    ],
    version: SLOTLOCK_AGENT_SERVER_VERSION,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: OPERATION_DEFINITIONS.map((operation) => ({
      id: operation.name,
      name: operation.title,
      description: operation.description,
      tags: ['calendar', 'scheduling', 'resources'],
      examples: [JSON.stringify({ skill: operation.name, arguments: operation.example })],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
    })),
  });
}

export function createSlotlockAgentServer(options: SlotlockAgentServerOptions): {
  fetch(request: Request): Promise<Response>;
  manifest: Readonly<Record<string, unknown>>;
  /**
   * End every open subscription gracefully (its `subscriptions/listen` result, then the stream
   * closes) and refuse new ones with 503. Call it before closing the HTTP listener;
   * `createSlotlockNodeServer` does so when it closes.
   */
  shutdown(): Promise<void>;
} {
  const config = validateOptions(options);
  const manifest = Object.freeze({
    name: 'Slotlock Agent Calendar',
    version: SLOTLOCK_AGENT_SERVER_VERSION,
    protocols: {
      mcp: {
        version: SLOTLOCK_MCP_PROTOCOL_VERSION,
        supportedVersions: [...SLOTLOCK_MCP_SUPPORTED_PROTOCOL_VERSIONS],
        endpoint: `${config.publicBaseUrl}/mcp`,
      },
      a2a: { version: SLOTLOCK_A2A_PROTOCOL_VERSION, endpoint: `${config.publicBaseUrl}/a2a` },
      mcpApps: {
        extension: SLOTLOCK_MCP_APPS_EXTENSION,
        mimeType: SLOTLOCK_MCP_APP_MIME_TYPE,
        resource: SLOTLOCK_MCP_APP_RESOURCE_URI,
      },
    },
    capabilities: slotlockAgentTools(),
  });
  const card = agentCard(config.publicBaseUrl);
  const confirmation = validateConfirmation(options.confirmation);
  const emit = (event: SlotlockAgentServerEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observability must never change what a protocol client receives.
    }
  };
  const dispatchOptions = (
    principal: SlotlockAgentPrincipal,
  ): SlotlockAgentOperationDispatchOptions => ({
    backend: options.backend,
    // The transport authenticates once before protocol parsing/rate-limiting; the canonical
    // dispatcher still owns principal validation for every operation invocation.
    authenticate: async () => principal,
    authorize: options.authorize,
    ...(options.consumeRateLimit ? { consumeRateLimit: options.consumeRateLimit } : {}),
  });
  /**
   * The 2025 revisions and A2A cannot carry a confirmation round, so a guarded write there fails
   * closed with `confirmation_required`.
   */
  const withoutConfirmationRound = (
    principal: SlotlockAgentPrincipal,
    operation: SlotlockAgentOperation,
  ): SlotlockAgentOperationDispatchOptions => {
    const dispatch = dispatchOptions(principal);
    if (confirmation?.operations.has(operation)) {
      dispatch.confirm = async () => {
        emit({ type: 'confirmation', operation, outcome: 'unavailable' });
        return CONFIRMATION_HALT.prompt;
      };
    }
    return dispatch;
  };

  const resourceWindowDays = validateResourceWindowDays(options.resourceWindowDays);
  const resourceTemplate = calendarResourceTemplate(resourceWindowDays);
  const subscriptionPolicy = validateSubscriptions(options.subscriptions);
  if (
    subscriptionPolicy &&
    resourceWindowDays * DAY_MS + subscriptionPolicy.maxDurationMs > MAX_AGENT_WINDOW_MS
  ) {
    // A subscription watches the resource window plus its own lifetime, within the read horizon.
    throw new Error(
      `Slotlock agent server resourceWindowDays plus subscriptions.maxDurationMs must fit ${SLOTLOCK_CALENDAR_HORIZON_DAYS} days`,
    );
  }
  /** Open subscriptions (and slots reserved by ones still opening), for the caps and shutdown. */
  const openSubscriptions = new Set<{
    principalKey: string;
    end(reason: 'shutdown'): void;
  }>();
  let shuttingDown = false;

  const discoverResult = Object.freeze({
    supportedVersions: [...SLOTLOCK_MCP_SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: {
      tools: {},
      resources: subscriptionPolicy ? { subscribe: true } : {},
      extensions: { [SLOTLOCK_MCP_APPS_EXTENSION]: { mimeTypes: [SLOTLOCK_MCP_APP_MIME_TYPE] } },
    },
    instructions: SLOTLOCK_MCP_INSTRUCTIONS,
    ...PUBLIC_CACHE,
  });

  /** A complete 2026-07-28 result: `resultType`, and the server's identity in `_meta`. */
  const modernResult = (id: string | number, result: Record<string, unknown>): Response =>
    json(
      200,
      rpcResult(id, {
        resultType: 'complete',
        ...result,
        _meta: {
          ...(isRecord(result._meta) ? result._meta : {}),
          [MCP_META_SERVER_INFO]: SERVER_INFO,
        },
      }),
    );
  const modernError = (
    status: number,
    id: string | number | null,
    code: number,
    message: string,
    data?: Record<string, unknown>,
  ): Response =>
    json(status, { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  /**
   * `tools/call` on 2026-07-28. A write listed in `confirmation` runs only on a retry carrying the
   * person's acceptance: the first call answers `input_required` (MRTR) with a form elicitation and
   * a sealed `requestState` bound to this principal, operation and exact arguments. Authorization
   * and argument validation run first, so nobody is asked to confirm a call that could not run.
   */
  async function modernToolCall(call: {
    request: Request;
    id: string | number;
    params: Record<string, unknown>;
    capabilities: Record<string, unknown>;
    principal: SlotlockAgentPrincipal;
    trace: SlotlockTraceContext | undefined;
  }): Promise<Response> {
    const { id, params, principal } = call;
    const operation = resolveSlotlockAgentOperation(params.name);
    if (!operation) return modernError(200, id, -32602, 'Unknown tool');
    const dispatch = dispatchOptions(principal);
    const gate: {
      decision?: ConfirmationDecision;
      input?: Record<string, unknown>;
      argsDigest?: string;
    } = {};
    if (confirmation?.operations.has(operation)) {
      if (!clientSupportsFormElicitation(call.capabilities)) {
        return modernError(
          400,
          id,
          MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
          'Missing required client capability',
          { requiredCapabilities: { elicitation: { form: {} } } },
        );
      }
      dispatch.confirm = async ({ input }) => {
        gate.input = input;
        gate.argsDigest = sha256Hex(canonicalJson(input));
        gate.decision = decideConfirmation({
          policy: confirmation,
          params,
          principal,
          operation,
          argsDigest: gate.argsDigest,
        });
        return gate.decision === 'accepted' ? null : CONFIRMATION_HALT[gate.decision];
      };
    }
    const outcome = await invokeSlotlockAgentOperation({
      operation,
      input: isRecord(params.arguments) ? params.arguments : {},
      request: call.request,
      options: dispatch,
      ...(call.trace ? { trace: call.trace } : {}),
    });
    if (gate.decision) {
      emit({ type: 'confirmation', operation, outcome: CONFIRMATION_OUTCOME[gate.decision] });
    }
    if (
      confirmation &&
      (gate.decision === 'prompt' || gate.decision === 'expired') &&
      gate.input &&
      gate.argsDigest
    ) {
      const key = confirmation.keys[0] as Buffer;
      return json(
        200,
        rpcResult(id, {
          resultType: 'input_required',
          inputRequests: {
            [CONFIRMATION_INPUT_KEY]: {
              method: 'elicitation/create',
              params: {
                mode: 'form',
                message: await confirmationMessage(
                  operation,
                  gate.input,
                  confirmationLookup(options.backend, {
                    principal,
                    operation,
                    signal: call.request.signal,
                    ...(call.trace ? { trace: call.trace } : {}),
                  }),
                ),
                requestedSchema: CONFIRMATION_SCHEMA,
              },
            },
          },
          requestState: sealRequestState(key, {
            op: operation,
            principal: principalTag(key, principal),
            args: gate.argsDigest,
            exp: Date.now() + confirmation.ttlMs,
            nonce: randomBytes(12).toString('base64url'),
          }),
          _meta: { [MCP_META_SERVER_INFO]: SERVER_INFO },
        }),
      );
    }
    if (gate.decision === 'invalid') {
      return modernError(400, id, -32602, 'Invalid confirmation state or response');
    }
    if (!outcome.ok && INTERNAL_FAILURES.has(outcome.code)) {
      return modernError(500, id, -32603, 'Internal error');
    }
    return modernResult(
      id,
      slotlockMcpToolResult(outcome.ok ? outcome : { ok: false, code: outcome.code }),
    );
  }

  /** A backend failure behind a resources/* or subscriptions/* request, as its JSON-RPC error. */
  const modernFailure = (
    id: string | number,
    outcome: { status: number; code: string },
  ): Response => {
    if (outcome.status === 429) {
      return modernError(429, id, SLOTLOCK_MCP_RATE_LIMITED_ERROR_CODE, 'Rate limit exceeded');
    }
    if (outcome.status === 503) return modernError(503, id, -32603, 'Service unavailable');
    return modernError(500, id, -32603, 'Internal error');
  };

  interface ModernCall {
    request: Request;
    id: string | number;
    params: Record<string, unknown>;
    principal: SlotlockAgentPrincipal;
    trace: SlotlockTraceContext | undefined;
  }

  const readFreeBusy = (
    call: Pick<ModernCall, 'request' | 'trace'>,
    dispatch: SlotlockAgentOperationDispatchOptions,
    resourceIds: string[],
    window: { start: string; end: string },
  ) =>
    invokeSlotlockAgentOperation({
      operation: 'slotlock_get_free_busy',
      input: { resource_ids: resourceIds, start: window.start, end: window.end },
      request: call.request,
      options: dispatch,
      ...(call.trace ? { trace: call.trace } : {}),
    });

  /**
   * `resources/list`: the calendar view, then the tenant's resources as calendar resources, paginated
   * with the backend's cursor. A principal that may not list resources sees only the view.
   */
  async function modernResourceList(call: ModernCall): Promise<Response> {
    const { id, params } = call;
    const cursor = params.cursor;
    if (cursor !== undefined && typeof cursor !== 'string') {
      return modernError(200, id, -32602, 'Invalid cursor');
    }
    const resources: Record<string, unknown>[] =
      cursor === undefined ? [{ ...SLOTLOCK_MCP_APP_RESOURCE }] : [];
    const outcome = await invokeSlotlockAgentOperation({
      operation: 'slotlock_list_resources',
      input: cursor === undefined ? {} : { cursor },
      request: call.request,
      options: dispatchOptions(call.principal),
      ...(call.trace ? { trace: call.trace } : {}),
    });
    if (!outcome.ok) {
      if (outcome.status === 403) return modernResult(id, { resources, ...PRIVATE_LIST_CACHE });
      if (outcome.status === 400) return modernError(200, id, -32602, 'Invalid cursor');
      return modernFailure(id, outcome);
    }
    const page = outcome.data as {
      resources: { id: string; external_ref: string | null; timezone: string }[];
      next_cursor: string | null;
    };
    for (const resource of page.resources)
      resources.push(calendarResource(resource, resourceWindowDays));
    return modernResult(id, {
      resources,
      ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}),
      ...PRIVATE_LIST_CACHE,
    });
  }

  /**
   * `resources/read`: the calendar view, or one calendar resource's free/busy for the days ahead.
   * A resource the principal cannot see is indistinguishable from one that does not exist.
   */
  async function modernResourceRead(call: ModernCall): Promise<Response> {
    const { id } = call;
    // checkModernMcpRequest has already required `uri` to be a string mirrored in Mcp-Name.
    const uri = call.params.uri as string;
    if (uri === SLOTLOCK_MCP_APP_RESOURCE_URI) {
      return modernResult(id, {
        contents: [
          {
            uri,
            mimeType: SLOTLOCK_MCP_APP_RESOURCE.mimeType,
            _meta: SLOTLOCK_MCP_APP_RESOURCE._meta,
            text: SLOTLOCK_MCP_APP_HTML,
          },
        ],
        ...PUBLIC_CACHE,
      });
    }
    const notFound = () => modernError(200, id, -32602, 'Resource not found', { uri });
    const resourceId = parseCalendarResourceUri(uri);
    if (resourceId === null) return notFound();
    const window = calendarResourceWindow(Date.now(), resourceWindowDays);
    const outcome = await readFreeBusy(call, dispatchOptions(call.principal), [resourceId], window);
    if (!outcome.ok) {
      return INVISIBLE_STATUSES.has(outcome.status) ? notFound() : modernFailure(id, outcome);
    }
    const entry = (outcome.data.resources as Record<string, unknown>[]).find(
      (resource) => resource.resource_id === resourceId,
    );
    if (!entry) return notFound();
    return modernResult(id, {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            resource_id: resourceId,
            window,
            busy: entry.busy,
            coverage: entry.coverage,
          }),
        },
      ],
      ...PRIVATE_UNCACHED,
    });
  }

  /**
   * Which of `resourceIds` the principal may read now, each with a digest of its free/busy over
   * `window`. One read for all of them; only when that is refused, one read each, so a single
   * invisible resource does not hide the rest. Any other failure fails the whole check.
   */
  async function watchableCalendars(
    call: ModernCall,
    resourceIds: string[],
    window: { start: string; end: string },
  ): Promise<
    { ok: true; digests: Map<string, string> } | { ok: false; status: number; code: string }
  > {
    const digests = new Map<string, string>();
    if (resourceIds.length === 0) return { ok: true, digests };
    const dispatch = dispatchOptions(call.principal);
    const batch = await readFreeBusy(call, dispatch, resourceIds, window);
    if (batch.ok) return { ok: true, digests: freeBusyDigests(batch.data) };
    if (!INVISIBLE_STATUSES.has(batch.status)) return batch;
    if (resourceIds.length === 1) return { ok: true, digests };
    for (const resourceId of resourceIds) {
      const single = await readFreeBusy(call, dispatch, [resourceId], window);
      if (single.ok) {
        const digest = freeBusyDigests(single.data).get(resourceId);
        if (digest !== undefined) digests.set(resourceId, digest);
      } else if (!INVISIBLE_STATUSES.has(single.status)) {
        return single;
      }
    }
    return { ok: true, digests };
  }

  /**
   * `subscriptions/listen` (2026-07-28 basic/patterns/subscriptions). The response is an SSE stream
   * that opens with `notifications/subscriptions/acknowledged` naming the calendar resources this
   * principal may watch, then carries `notifications/resources/updated` for each change until the
   * client closes it or the server ends it gracefully (its duration, shutdown, lost access) with the
   * request's result. Nothing is honored but resource subscriptions; a subscription honoring nothing
   * ends right after its acknowledgment.
   */
  async function modernListen(call: ModernCall): Promise<Response> {
    const { id, principal } = call;
    if (!subscriptionPolicy) return modernError(404, id, -32601, 'Method not found');
    const filter = parseSubscriptionFilter(call.params.notifications);
    if (!filter.ok) return modernError(200, id, -32602, filter.message, filter.data);
    if (shuttingDown) return modernError(503, id, -32603, 'Server is shutting down');
    const principalKey = `${principal.tenantRef}\0${principal.subject}`;
    let held = 0;
    for (const open of openSubscriptions) if (open.principalKey === principalKey) held += 1;
    if (
      openSubscriptions.size >= subscriptionPolicy.maxTotal ||
      held >= subscriptionPolicy.maxPerPrincipal
    ) {
      return modernError(429, id, SLOTLOCK_MCP_RATE_LIMITED_ERROR_CODE, 'Too many subscriptions');
    }
    // The slot is held while access is checked, so concurrent opens cannot overshoot the caps.
    const slot = { principalKey, end: (_reason: 'shutdown') => {} };
    openSubscriptions.add(slot);
    let streaming = false;
    try {
      // A read's window rolls forward with the clock; a subscription watches one fixed window that
      // holds every window a read can return while it is open (from now to its last possible read's
      // end), so a booking entering the rolling end is announced, and the clock alone changes nothing.
      const window = calendarResourceWindow(Date.now(), resourceWindowDays);
      window.end = new Date(
        Date.parse(window.end) + subscriptionPolicy.maxDurationMs,
      ).toISOString();
      const watchable = await watchableCalendars(call, filter.resourceIds, window);
      if (!watchable.ok) return modernFailure(id, watchable);
      if (shuttingDown) return modernError(503, id, -32603, 'Server is shutting down');
      streaming = true;
      return streamSubscription(call, subscriptionPolicy, slot, window, {
        resourceIds: filter.resourceIds.filter((resourceId) => watchable.digests.has(resourceId)),
        digests: watchable.digests,
      });
    } finally {
      if (!streaming) openSubscriptions.delete(slot);
    }
  }

  function streamSubscription(
    call: ModernCall,
    policy: SubscriptionPolicy,
    slot: { principalKey: string; end(reason: 'shutdown'): void },
    window: { start: string; end: string },
    watched: { resourceIds: string[]; digests: Map<string, string> },
  ): Response {
    const { id, principal, request } = call;
    const subscriptionMeta = { [MCP_META_SUBSCRIPTION_ID]: id };
    const stop = new AbortController();
    let ended = false;
    const timers: {
      keepAlive?: ReturnType<typeof setInterval>;
      lifetime?: ReturnType<typeof setTimeout>;
      nextPoll?: ReturnType<typeof setTimeout>;
    } = {};
    const stream = openMcpEventStream(() => end('client'));
    const onAbort = () => end('client');

    function end(
      reason: 'client' | 'duration' | 'shutdown' | 'revoked' | 'failed' | 'empty',
    ): void {
      if (ended) return;
      ended = true;
      clearInterval(timers.keepAlive);
      clearTimeout(timers.lifetime);
      clearTimeout(timers.nextPoll);
      stop.abort();
      request.signal.removeEventListener('abort', onAbort);
      openSubscriptions.delete(slot);
      // A server-side end the client should not retry is graceful: the listen request's result.
      // A failure closes the stream without one, which a client may treat as a reason to reconnect.
      if (reason !== 'client' && reason !== 'failed') {
        stream.send({
          jsonrpc: '2.0',
          id,
          result: {
            resultType: 'complete',
            _meta: { ...subscriptionMeta, [MCP_META_SERVER_INFO]: SERVER_INFO },
          },
        });
      }
      stream.close();
      emit({
        type: 'subscription',
        outcome: 'closed',
        reason,
        resources: watched.resourceIds.length,
      });
    }
    slot.end = end;

    stream.send({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        _meta: subscriptionMeta,
        notifications:
          watched.resourceIds.length > 0
            ? { resourceSubscriptions: watched.resourceIds.map(slotlockCalendarResourceUri) }
            : {},
      },
    });
    emit({ type: 'subscription', outcome: 'opened', resources: watched.resourceIds.length });
    if (watched.resourceIds.length === 0) {
      end('empty');
      return stream.response;
    }
    if (request.signal.aborted) {
      end('client');
      return stream.response;
    }
    request.signal.addEventListener('abort', onAbort, { once: true });

    // Every re-read authenticates the listen request's credentials again and must find the same
    // principal, and is authorized like any read; neither the rate limiter nor a confirmation applies
    // to reads the server makes on its own schedule.
    const pollRequest = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      signal: AbortSignal.any([request.signal, stop.signal]),
    });
    const pollDispatch: SlotlockAgentOperationDispatchOptions = {
      backend: options.backend,
      authenticate: async (current) => {
        const again = await options.authenticate(current);
        return again?.subject === principal.subject && again.tenantRef === principal.tenantRef
          ? again
          : null;
      },
      authorize: options.authorize,
    };
    let failures = 0;
    const poll = async (): Promise<void> => {
      try {
        const outcome = await readFreeBusy(
          { request: pollRequest, trace: call.trace },
          pollDispatch,
          watched.resourceIds,
          window,
        );
        if (ended) return;
        if (!outcome.ok) {
          if (outcome.status === 401 || INVISIBLE_STATUSES.has(outcome.status)) {
            end('revoked');
            return;
          }
          failures += 1;
          if (failures >= MAX_POLL_FAILURES) {
            end('failed');
            return;
          }
        } else {
          failures = 0;
          const digests = freeBusyDigests(outcome.data);
          for (const resourceId of watched.resourceIds) {
            const digest = digests.get(resourceId) ?? '';
            if (digest === watched.digests.get(resourceId)) continue;
            watched.digests.set(resourceId, digest);
            stream.send({
              jsonrpc: '2.0',
              method: 'notifications/resources/updated',
              params: { _meta: subscriptionMeta, uri: slotlockCalendarResourceUri(resourceId) },
            });
          }
          if (stream.lagging()) {
            end('failed');
            return;
          }
        }
        timers.nextPoll = unref(setTimeout(poll, policy.pollIntervalMs));
      } catch {
        end('failed');
      }
    };
    timers.keepAlive = unref(
      setInterval(() => {
        if (!stream.keepAlive() || stream.lagging()) end('failed');
      }, policy.keepAliveMs),
    );
    timers.lifetime = unref(setTimeout(() => end('duration'), policy.maxDurationMs));
    timers.nextPoll = unref(setTimeout(poll, policy.pollIntervalMs));
    return stream.response;
  }

  /** One MCP 2026-07-28 request: stateless, validated against its own `_meta` and headers. */
  async function modernMcp(
    request: Request,
    rpc: { id?: unknown; method: string; params?: unknown },
    principal: SlotlockAgentPrincipal,
  ): Promise<Response> {
    // The revision defines no client notification over HTTP; one is accepted and nothing runs.
    if (rpc.id === undefined) return empty(202);
    if (typeof rpc.id !== 'string' && typeof rpc.id !== 'number') {
      return modernError(400, null, -32600, 'Invalid Request');
    }
    const id = rpc.id;
    const check = checkModernMcpRequest({
      headers: request.headers,
      method: rpc.method,
      params: rpc.params,
      modernVersions: MODERN_MCP_VERSIONS,
      supportedVersions: SLOTLOCK_MCP_SUPPORTED_PROTOCOL_VERSIONS,
    });
    if (!check.ok) return modernError(check.status, id, check.code, check.message, check.data);
    const params = rpc.params as Record<string, unknown>;
    const trace = traceContextFrom(check.envelope.meta, request.headers);
    switch (rpc.method) {
      case 'server/discover':
        return modernResult(id, discoverResult);
      case 'tools/list':
        return modernResult(id, { tools: slotlockAgentTools(), ...PUBLIC_CACHE });
      case 'tools/call':
        return modernToolCall({
          request,
          id,
          params,
          capabilities: check.envelope.capabilities,
          principal,
          trace,
        });
      case 'resources/list':
        return modernResourceList({ request, id, params, principal, trace });
      case 'resources/templates/list':
        return modernResult(id, {
          resourceTemplates: [resourceTemplate],
          ...PUBLIC_CACHE,
        });
      case 'resources/read':
        return modernResourceRead({ request, id, params, principal, trace });
      case 'subscriptions/listen':
        return modernListen({ request, id, params, principal, trace });
      default:
        // 2026-07-28 streamable-http: an unimplemented method is 404 with -32601.
        return modernError(404, id, -32601, 'Method not found');
    }
  }

  return {
    manifest,
    async shutdown(): Promise<void> {
      shuttingDown = true;
      for (const subscription of [...openSubscriptions]) subscription.end('shutdown');
    },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      // Discovery documents whose location the protocols fix at the origin root: the A2A card
      // (A2A §8.2) and the RFC 9728 protected-resource metadata (path-aware and root forms).
      if (request.method === 'GET') {
        if (config.oauth?.metadataPaths.has(url.pathname)) return json(200, config.oauth.metadata);
        if (url.pathname === '/.well-known/agent-card.json') return json(200, card);
      }
      const path = routePath(url.pathname, config.basePath);
      if (path === null) return json(404, { error: { code: 'not_found' } });

      // MCP requires Origin validation on every HTTP connection, including the optional GET
      // stream and session DELETE methods. This server is deliberately stateless and JSON-only,
      // so those optional methods advertise their absence with the specified 405 response.
      if (path === '/mcp') {
        const origin = request.headers.get('origin');
        if (origin) {
          const normalized = normalizeOrigin(origin);
          if (!normalized || !config.allowedOrigins.has(normalized)) {
            return json(403, rpcError(null, -32600, 'Origin not allowed'));
          }
        }
        if (request.method === 'GET' || request.method === 'DELETE') {
          return empty(405, { Allow: 'POST' });
        }
      }

      if (request.method === 'GET' && path === '/healthz') {
        try {
          const health = await options.health();
          return json(health.ready ? 200 : 503, {
            status: health.ready ? 'ready' : 'not_ready',
            version: SLOTLOCK_AGENT_SERVER_VERSION,
            checks: [...health.checks]
              .slice(0, 100)
              .map((check) => (/^[a-z][a-z0-9_-]{0,63}$/.test(check) ? check : 'invalid')),
          });
        } catch {
          return json(503, {
            status: 'not_ready',
            version: SLOTLOCK_AGENT_SERVER_VERSION,
            checks: [],
          });
        }
      }
      if (request.method === 'GET' && path === '/manifest.json') return json(200, manifest);
      if (request.method === 'GET' && path === '/.well-known/agent-card.json') {
        return json(200, card);
      }
      if (request.method !== 'POST' || (path !== '/mcp' && path !== '/a2a')) {
        return json(404, { error: { code: 'not_found' } });
      }
      const contentType = request.headers.get('content-type')?.split(';')[0]?.trim();
      if (contentType !== 'application/json') {
        return json(415, { error: { code: 'unsupported_media_type' } });
      }
      const origin = request.headers.get('origin');
      if (origin) {
        const normalized = normalizeOrigin(origin);
        if (!normalized || !config.allowedOrigins.has(normalized)) {
          return json(403, rpcError(null, -32600, 'Origin not allowed'));
        }
      }
      const principal = await options.authenticate(request);
      if (
        !principal ||
        !isCanonicalPrincipalIdentity(principal.subject) ||
        !isCanonicalPrincipalIdentity(principal.tenantRef)
      ) {
        return json(401, rpcError(null, -32000, 'Authentication required'), {
          'WWW-Authenticate':
            path === '/mcp' && config.oauth ? config.oauth.challenge : 'Bearer realm="slotlock"',
        });
      }
      if (
        options.consumeRateLimit &&
        !(await options.consumeRateLimit({ principal, operation: 'protocol' }))
      ) {
        // Answered before the body is read, so the era comes from the version header alone.
        const modernClient =
          path === '/mcp' &&
          MODERN_MCP_VERSIONS.includes(request.headers.get('mcp-protocol-version') ?? '');
        return json(
          429,
          rpcError(
            null,
            modernClient ? SLOTLOCK_MCP_RATE_LIMITED_ERROR_CODE : -32029,
            'Rate limit exceeded',
          ),
        );
      }

      // MCP answers malformed JSON-RPC with HTTP 400; A2A keeps every JSON-RPC error in a 200.
      const envelopeStatus = path === '/a2a' ? 200 : 400;
      let body: unknown;
      try {
        body = await readJson(request, config.maxRequestBytes);
      } catch (error) {
        const tooLarge = error instanceof Error && error.message === 'request_too_large';
        return json(
          tooLarge ? 413 : envelopeStatus,
          rpcError(null, -32700, tooLarge ? 'Request too large' : 'Parse error'),
        );
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json(envelopeStatus, rpcError(null, -32600, 'Invalid Request'));
      }
      const rpc = body as {
        jsonrpc?: unknown;
        id?: unknown;
        method?: unknown;
        params?: Record<string, unknown>;
      };
      const id =
        typeof rpc.id === 'string' || typeof rpc.id === 'number' || rpc.id === null ? rpc.id : null;
      if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
        return json(envelopeStatus, rpcError(id, -32600, 'Invalid Request'));
      }

      if (path === '/mcp') {
        const requestedVersion = request.headers.get('mcp-protocol-version');
        if (mcpEra({ method: rpc.method, params: rpc.params }, requestedVersion) === 'modern') {
          try {
            return await modernMcp(request, { ...rpc, method: rpc.method }, principal);
          } catch {
            return json(500, rpcError(id, -32603, 'Internal error'));
          }
        }
        // The 2025 revisions, unchanged: every request names a supported revision in the header,
        // except `initialize`, which negotiates it.
        const supportedVersion = requestedVersion ? isLegacyMcpVersion(requestedVersion) : false;
        if (
          (requestedVersion && !supportedVersion) ||
          (rpc.method !== 'initialize' && !supportedVersion)
        ) {
          return json(400, rpcError(id, -32600, 'Unsupported MCP protocol version'));
        }
        if (rpc.method === 'notifications/initialized') {
          if (rpc.id !== undefined) {
            return json(400, rpcError(id, -32600, 'Invalid Request'));
          }
          return empty(202);
        }
        if (rpc.method === 'notifications/cancelled') {
          if (rpc.id !== undefined) {
            return json(400, rpcError(id, -32600, 'Invalid Request'));
          }
          return empty(202);
        }
        if (typeof rpc.id !== 'string' && typeof rpc.id !== 'number') {
          return json(400, rpcError(null, -32600, 'Invalid Request'));
        }
        if (rpc.method === 'initialize') {
          const initialize = MCP_INITIALIZE_PARAMS.safeParse(rpc.params);
          if (!initialize.success) {
            return json(400, rpcError(id, -32602, 'Invalid initialize parameters'));
          }
          // Lifecycle: answer the client's own version when it is a 2025 revision Slotlock implements,
          // else the newest of those (a 2026-07-28 client never sends `initialize`).
          const negotiated = isLegacyMcpVersion(initialize.data.protocolVersion)
            ? initialize.data.protocolVersion
            : SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION;
          return json(
            200,
            rpcResult(id, {
              protocolVersion: negotiated,
              capabilities: {
                tools: {},
                resources: {},
                ...(clientSupportsSlotlockMcpApp(initialize.data.capabilities)
                  ? {
                      extensions: {
                        [SLOTLOCK_MCP_APPS_EXTENSION]: { mimeTypes: [SLOTLOCK_MCP_APP_MIME_TYPE] },
                      },
                    }
                  : {}),
              },
              serverInfo: { name: 'slotlock', version: SLOTLOCK_AGENT_SERVER_VERSION },
            }),
            { 'MCP-Protocol-Version': negotiated },
          );
        }
        if (rpc.method === 'ping') return json(200, rpcResult(id, {}));
        if (rpc.method === 'tools/list')
          return json(200, rpcResult(id, { tools: slotlockAgentTools() }));
        if (rpc.method === 'resources/list') {
          return json(200, rpcResult(id, { resources: [SLOTLOCK_MCP_APP_RESOURCE] }));
        }
        if (rpc.method === 'resources/read') {
          const uri = rpc.params?.uri;
          if (uri !== SLOTLOCK_MCP_APP_RESOURCE_URI) {
            return json(200, rpcError(id, -32002, 'Resource not found'));
          }
          return json(
            200,
            rpcResult(id, {
              contents: [
                {
                  uri: SLOTLOCK_MCP_APP_RESOURCE.uri,
                  mimeType: SLOTLOCK_MCP_APP_RESOURCE.mimeType,
                  _meta: SLOTLOCK_MCP_APP_RESOURCE._meta,
                  text: SLOTLOCK_MCP_APP_HTML,
                },
              ],
            }),
          );
        }
        if (rpc.method !== 'tools/call') return json(200, rpcError(id, -32601, 'Method not found'));
        const operation = resolveSlotlockAgentOperation(rpc.params?.name);
        if (!operation) return json(200, rpcError(id, -32602, 'Unknown tool'));
        const input =
          rpc.params?.arguments &&
          typeof rpc.params.arguments === 'object' &&
          !Array.isArray(rpc.params.arguments)
            ? (rpc.params.arguments as Record<string, unknown>)
            : {};
        try {
          const trace = traceContextFrom(
            isRecord(rpc.params?._meta) ? rpc.params._meta : undefined,
            request.headers,
          );
          const outcome = await invokeSlotlockAgentOperation({
            operation,
            input,
            request,
            options: withoutConfirmationRound(principal, operation),
            ...(trace ? { trace } : {}),
          });
          if (!outcome.ok && INTERNAL_FAILURES.has(outcome.code)) {
            return json(500, rpcError(id, -32603, 'Internal error'));
          }
          return json(
            200,
            rpcResult(
              id,
              slotlockMcpToolResult(outcome.ok ? outcome : { ok: false, code: outcome.code }),
            ),
          );
        } catch {
          return json(500, rpcError(id, -32603, 'Internal error'));
        }
      }

      if (typeof rpc.id !== 'string' && typeof rpc.id !== 'number') {
        return json(200, rpcError(null, -32600, 'Invalid Request'));
      }
      if (request.headers.get('a2a-version') !== SLOTLOCK_A2A_PROTOCOL_VERSION) {
        return a2aError(id, -32009, 'A2A version not supported', {
          reason: 'VERSION_NOT_SUPPORTED',
          domain: 'a2a-protocol.org',
          metadata: { supportedVersions: SLOTLOCK_A2A_PROTOCOL_VERSION },
        });
      }
      if (A2A_PUSH_NOTIFICATION_METHODS.has(rpc.method)) {
        return a2aError(id, -32003, 'Push notifications are not supported', {
          reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED',
          domain: 'a2a-protocol.org',
        });
      }
      if (A2A_UNSUPPORTED_METHODS.has(rpc.method)) {
        return a2aError(id, -32004, 'Unsupported operation', {
          reason: 'UNSUPPORTED_OPERATION',
          domain: 'a2a-protocol.org',
          metadata: { supportedMethods: 'SendMessage' },
        });
      }
      if (A2A_TASK_METHOD_FIELDS.has(rpc.method)) {
        if (!isValidA2ATaskRequest(rpc.method, rpc.params, principal.tenantRef)) {
          return a2aError(id, -32602, 'Invalid params', {
            reason: 'INVALID_PARAMS',
            domain: 'slotlock',
          });
        }
        if (rpc.method !== 'ListTasks') {
          return a2aError(id, -32001, 'Task not found', {
            reason: 'TASK_NOT_FOUND',
            domain: 'a2a-protocol.org',
          });
        }
        const pageSize = rpc.params?.pageSize ?? SLOTLOCK_A2A_TASK_PAGE_SIZE.default;
        return json(200, rpcResult(id, { tasks: [], nextPageToken: '', pageSize, totalSize: 0 }));
      }
      if (rpc.method !== 'SendMessage') {
        return json(200, rpcError(id, -32601, 'Method not found'));
      }
      const a2aParamKeys = Object.keys(rpc.params ?? {});
      if (
        a2aParamKeys.some(
          (key) => !['message', 'configuration', 'metadata', 'tenant'].includes(key),
        ) ||
        !isCallerTenant(rpc.params?.tenant, principal.tenantRef)
      ) {
        return a2aError(id, -32602, 'Invalid message parameters', {
          reason: 'INVALID_MESSAGE_PARAMETERS',
          domain: 'slotlock',
        });
      }
      const message = rpc.params?.message as
        | {
            messageId?: unknown;
            contextId?: unknown;
            taskId?: unknown;
            role?: unknown;
            parts?: unknown;
          }
        | undefined;
      const parts = Array.isArray(message?.parts) ? message.parts : [];
      const part = parts.length === 1 ? (parts[0] as { data?: unknown }) : null;
      const data = part?.data as { skill?: unknown; arguments?: unknown } | undefined;
      const operation = resolveSlotlockAgentOperation(data?.skill);
      const input =
        data?.arguments && typeof data.arguments === 'object' && !Array.isArray(data.arguments)
          ? (data.arguments as Record<string, unknown>)
          : {};
      if (
        !operation ||
        message?.role !== 'ROLE_USER' ||
        !isCanonicalBoundedIdentifier(message.messageId, 200) ||
        message.taskId !== undefined ||
        (message.contextId !== undefined && !isCanonicalBoundedIdentifier(message.contextId, 200))
      ) {
        return a2aError(id, -32602, 'Invalid message', {
          reason: 'INVALID_MESSAGE',
          domain: 'slotlock',
          metadata: {
            expected: 'one application/json data part {"skill": "<skill id>", "arguments": {…}}',
          },
        });
      }
      try {
        const trace = traceContextFrom(undefined, request.headers);
        const outcome = await invokeSlotlockAgentOperation({
          operation,
          input,
          request,
          options: withoutConfirmationRound(principal, operation),
          ...(trace ? { trace } : {}),
        });
        if (!outcome.ok && INTERNAL_FAILURES.has(outcome.code)) {
          return json(200, rpcError(id, -32603, 'Internal error'));
        }
        const replyId = createHash('sha256')
          .update(`${principal.subject}\0${message.messageId}\0${operation}`)
          .digest('base64url')
          .slice(0, 32);
        const requestedContextId = message.contextId;
        const contextId =
          typeof requestedContextId === 'string' &&
          requestedContextId.length > 0 &&
          requestedContextId.length <= 200
            ? requestedContextId
            : `ctx_${createHash('sha256')
                .update(`${principal.tenantRef}\0${message.messageId}`)
                .digest('base64url')
                .slice(0, 32)}`;
        // A skill's outcome is the agent's reply, success or not — the same contract as an MCP
        // `isError` result, so the calling agent reads `{"error":{"code":…}}` and can act on it.
        return json(
          200,
          rpcResult(id, {
            message: {
              messageId: `reply_${replyId}`,
              contextId,
              role: 'ROLE_AGENT',
              parts: [
                {
                  data: outcome.ok ? outcome.data : { error: { code: outcome.code } },
                  mediaType: 'application/json',
                },
              ],
            },
          }),
        );
      } catch {
        return json(200, rpcError(id, -32603, 'Internal error'));
      }
    },
  };
}
