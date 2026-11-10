// The application API: what an application, rather than an agent, does over HTTP that the
// TypeScript store does in process (resources and hours, holds and reservations, coverage, any of
// the tenant's events, erasure when allowed, maintenance), for any language.
//
// Served as REST under /v1 beside the agent tools when the agent server has an `application`
// backend and `rest` is on, in the same OpenAPI document. Needs the `admin` scope; never MCP tools
// or A2A skills, so no agent is offered them.
//
// Contract only (names, schemas, routes); nothing from the agent server at runtime. The
// store-backed implementation is createSlotlockStoreApplicationBackend.
import {
  SLOTLOCK_CHANGE_ORIGINS,
  SLOTLOCK_CHANGE_TYPES,
  SLOTLOCK_WEBHOOK_FILTER_REFS,
  SLOTLOCK_WEBHOOK_FILTER_RESOURCES,
  type SlotlockChangeOrigin,
  SLOTLOCK_MAX_WEBHOOK_ENDPOINTS,
} from './event-feed.js';
import { z } from 'zod';
import { SLOTLOCK_PARTNER_ACCOUNT, SLOTLOCK_PARTNER_PLAN } from './partner-names.js';
import type { SlotlockAgentPrincipal } from './agent-server.js';
import { SLOTLOCK_EVENT_OUTPUT } from './event-schema.js';
import type { SlotlockTraceContext } from './mcp-modern.js';
import { SLOTLOCK_CALENDAR_HORIZON_DAYS } from './rules.js';
import {
  SLOTLOCK_GROUPING_REF,
  SLOTLOCK_MAX_GROUPS_PER_RESOURCE,
  SLOTLOCK_MAX_LOCATION_DEPTH,
  SLOTLOCK_MAX_LOCATIONS,
  SLOTLOCK_MAX_RESOURCE_GROUPS,
  SLOTLOCK_POOL_ORDERS,
  SLOTLOCK_RESOURCE_KINDS,
  SLOTLOCK_RESOURCE_LABEL,
  SLOTLOCK_RESOURCE_PROFILE_LIMITS,
} from './resource-profile.js';

export type SlotlockApplicationOperation =
  | 'slotlock_create_resource'
  | 'slotlock_update_resource'
  | 'slotlock_list_locations'
  | 'slotlock_create_location'
  | 'slotlock_update_location'
  | 'slotlock_delete_location'
  | 'slotlock_list_groups'
  | 'slotlock_create_group'
  | 'slotlock_delete_group'
  | 'slotlock_add_group_member'
  | 'slotlock_remove_group_member'
  | 'slotlock_get_resource'
  | 'slotlock_archive_resource'
  | 'slotlock_restore_resource'
  | 'slotlock_delete_resource'
  | 'slotlock_list_busy'
  | 'slotlock_set_resource_availability'
  | 'slotlock_set_tenant_availability'
  | 'slotlock_export_resource_availability'
  | 'slotlock_import_resource_availability'
  | 'slotlock_set_resource_booking_rules'
  | 'slotlock_set_resource_pool'
  | 'slotlock_set_resource_parent'
  | 'slotlock_list_pools'
  | 'slotlock_set_pool_order'
  | 'slotlock_get_booking_rule_defaults'
  | 'slotlock_set_tenant_booking_rules'
  | 'slotlock_set_pool_booking_rules'
  | 'slotlock_get_resource_history'
  | 'slotlock_get_coverage'
  | 'slotlock_record_coverage_failure'
  | 'slotlock_delete_coverage'
  | 'slotlock_get_reservation_history'
  | 'slotlock_get_tenant_event_history'
  | 'slotlock_acquire_hold'
  | 'slotlock_get_hold'
  | 'slotlock_list_holds'
  | 'slotlock_confirm_hold'
  | 'slotlock_release_hold'
  | 'slotlock_get_reservation'
  | 'slotlock_list_reservations'
  | 'slotlock_put_reservation'
  | 'slotlock_cancel_reservation'
  | 'slotlock_check_in_reservation'
  | 'slotlock_join_waitlist'
  | 'slotlock_list_waitlist'
  | 'slotlock_leave_waitlist'
  | 'slotlock_record_coverage'
  | 'slotlock_list_tenant_events'
  | 'slotlock_get_tenant_event'
  | 'slotlock_export_tenant_event'
  | 'slotlock_cancel_tenant_event'
  | 'slotlock_get_tenant'
  | 'slotlock_erase_tenant'
  | 'slotlock_run_maintenance'
  | 'slotlock_list_changes'
  | 'slotlock_create_webhook'
  | 'slotlock_list_webhooks'
  | 'slotlock_delete_webhook'
  | 'slotlock_enable_webhook'
  | 'slotlock_get_usage'
  | 'slotlock_partner_put_account'
  | 'slotlock_partner_list_accounts'
  | 'slotlock_partner_get_account'
  | 'slotlock_partner_list_keys'
  | 'slotlock_partner_create_key'
  | 'slotlock_partner_rotate_key'
  | 'slotlock_partner_revoke_key'
  | 'slotlock_partner_suspend_account'
  | 'slotlock_partner_unsuspend_account'
  | 'slotlock_partner_erase_account'
  | 'slotlock_partner_get_usage'
  | 'slotlock_partner_reconcile_usage';

/** The scope an application operation needs, but the partner API's (`slotlockApplicationScope`). */
export const SLOTLOCK_APPLICATION_SCOPE = 'admin';

/** The scope one application operation needs: `partner` for the partner API's, else `admin`. */
export function slotlockApplicationScope(definition: { scope?: 'partner' }): string {
  return definition.scope ?? SLOTLOCK_APPLICATION_SCOPE;
}

export interface SlotlockApplicationInvocationContext {
  principal: SlotlockAgentPrincipal;
  operation: SlotlockApplicationOperation;
  signal: AbortSignal;
  /** W3C trace context the caller sent, already validated. */
  trace?: SlotlockTraceContext;
  /** The surface the call came through: `application` when the agent server dispatches it. */
  origin?: SlotlockChangeOrigin;
}

type Handler = (
  context: SlotlockApplicationInvocationContext,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * What serves the application operations: each method gets schema-valid input and returns what its
 * output schema describes; refusals throw `SlotlockAgentOperationError`. The tenant is the
 * principal's, never an argument.
 */
export interface SlotlockApplicationBackend {
  createResource: Handler;
  updateResource: Handler;
  listLocations: Handler;
  createLocation: Handler;
  updateLocation: Handler;
  deleteLocation: Handler;
  listGroups: Handler;
  createGroup: Handler;
  deleteGroup: Handler;
  addGroupMember: Handler;
  removeGroupMember: Handler;
  getResource: Handler;
  archiveResource: Handler;
  restoreResource: Handler;
  deleteResource: Handler;
  listBusy: Handler;
  setResourceAvailability: Handler;
  setTenantAvailability: Handler;
  exportResourceAvailability: Handler;
  importResourceAvailability: Handler;
  setResourceBookingRules: Handler;
  setResourcePool: Handler;
  setResourceParent: Handler;
  listPools: Handler;
  setPoolOrder: Handler;
  getBookingRuleDefaults: Handler;
  setTenantBookingRules: Handler;
  setPoolBookingRules: Handler;
  getResourceHistory: Handler;
  getCoverage: Handler;
  recordCoverageFailure: Handler;
  deleteCoverage: Handler;
  getReservationHistory: Handler;
  getTenantEventHistory: Handler;
  acquireHold: Handler;
  getHold: Handler;
  listHolds: Handler;
  confirmHold: Handler;
  releaseHold: Handler;
  getReservation: Handler;
  listReservations: Handler;
  putReservation: Handler;
  cancelReservation: Handler;
  checkInReservation: Handler;
  joinWaitlist: Handler;
  listWaitlist: Handler;
  leaveWaitlist: Handler;
  recordCoverage: Handler;
  listTenantEvents: Handler;
  getTenantEvent: Handler;
  exportTenantEvent: Handler;
  cancelTenantEvent: Handler;
  getTenant: Handler;
  eraseTenant: Handler;
  runMaintenance: Handler;
  listChanges: Handler;
  createWebhook: Handler;
  listWebhooks: Handler;
  deleteWebhook: Handler;
  enableWebhook: Handler;
  getUsage: Handler;
  partnerPutAccount: Handler;
  partnerListAccounts: Handler;
  partnerGetAccount: Handler;
  partnerListKeys: Handler;
  partnerCreateKey: Handler;
  partnerRotateKey: Handler;
  partnerRevokeKey: Handler;
  partnerSuspendAccount: Handler;
  partnerUnsuspendAccount: Handler;
  partnerEraseAccount: Handler;
  partnerGetUsage: Handler;
  partnerReconcileUsage: Handler;
}

export interface SlotlockApplicationOperationDefinition {
  name: SlotlockApplicationOperation;
  title: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative to the server's base URL; `{name}` is one path segment, an input of that name. */
  path: string;
  input: z.ZodType<Record<string, unknown>>;
  output: z.ZodType<Record<string, unknown>>;
  risk: { readOnly: boolean; destructive: boolean; idempotent: boolean };
  invoke: keyof SlotlockApplicationBackend;
  /**
   * The scope the operation needs: `admin` (SLOTLOCK_APPLICATION_SCOPE) unless it is the partner
   * API's, which needs a partner key's `partner` (RFC 0003 P3) and nothing else reaches.
   */
  scope?: 'partner';
  /** Valid input, path parameters included (a test runs each against the schema). */
  example: Record<string, unknown>;
}

const DATE_TIME = z.string().datetime({ offset: true });
/** A UTC day, `YYYY-MM-DD`, that is a real date. */
const USAGE_DAY = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((day) => new Date(`${day}T00:00:00Z`).toISOString().startsWith(day), 'not a date');
const USAGE_COUNT = z.number().int().min(0);
const USAGE_TOTALS = {
  operations: USAGE_COUNT,
  bookings: USAGE_COUNT,
  holds: USAGE_COUNT,
  webhook_deliveries: USAGE_COUNT,
  assistant_messages: USAGE_COUNT,
  resources: USAGE_COUNT,
};
const PARTNER_ACCOUNT = z.string().regex(SLOTLOCK_PARTNER_ACCOUNT);
const PARTNER_PLAN_NAME = z.string().regex(SLOTLOCK_PARTNER_PLAN);
const PARTNER_ACCOUNT_OUTPUT = z
  .object({
    account: PARTNER_ACCOUNT,
    plan: PARTNER_PLAN_NAME,
    status: z.enum(['active', 'suspended']),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    resources: z.number().int().min(0).optional(),
    api_keys: z.number().int().min(0).optional(),
  })
  .strict();
/**
 * Which of an account's environments a key call acts in (RFC 0003 G9): `live`, the default, or
 * `test`, the account's test environment, whose keys start `slk_test_` and are never billed.
 */
const PARTNER_ENVIRONMENT = z.enum(['live', 'test']).optional();
const ACCOUNT_KEY = z.string().regex(/^slk_(test_)?[0-9A-Za-z]{46}$/);

const PARTNER_KEY_OUTPUT = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(100),
    prefix: z.string().min(1).max(20),
    scopes: z.array(z.enum(['read', 'write', 'admin'])),
    created_at: z.string().datetime(),
    expires_at: z.string().datetime().nullable(),
    last_used_at: z.string().datetime().nullable(),
    revoked_at: z.string().datetime().nullable(),
  })
  .strict();
const RESOURCE_ID = z.string().trim().min(1).max(200);
const HOLD_ID = z.string().trim().min(1).max(200);
const EVENT_ID = z.string().trim().min(1).max(200);
/** Matches the store's identities: not blank, at most 500 UTF-8 bytes, no control characters. */
const IDENTITY = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      Buffer.byteLength(value, 'utf8') <= 500 &&
      !/[\u0000-\u001f\u007f]/.test(value),
    { message: 'must be 1-500 UTF-8 bytes, not blank, without control characters' },
  );
const SOURCE = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'must not be blank or hold control characters',
  });
const TIMEZONE = z.string().min(1).max(100);
const REVISION = z.number().int().positive();
/** The longest span one hold or reservation may cover: the longest event Slotlock stores. */
const MAX_SPAN_MS = 3_660 * 24 * 60 * 60 * 1_000;
const boundedSpan = (value: { start: string; end: string }) => {
  const span = Date.parse(value.end) - Date.parse(value.start);
  return span > 0 && span <= MAX_SPAN_MS;
};
const SPAN_MESSAGE = { message: 'end must be after start, by at most 3,660 days' };

/** The longest window one list or busy read covers: the store's calendar horizon. */
const MAX_WINDOW_MS = SLOTLOCK_CALENDAR_HORIZON_DAYS * 24 * 60 * 60 * 1_000;
const boundedWindow = (value: { start: string; end: string }) => {
  const span = Date.parse(value.end) - Date.parse(value.start);
  return span > 0 && span <= MAX_WINDOW_MS;
};
const WINDOW_MESSAGE = {
  message: `end must be after start, by at most ${SLOTLOCK_CALENDAR_HORIZON_DAYS} days`,
};
const PAGE_LIMIT = z.number().int().min(1).max(100).default(50);
/** The `next_cursor` of the page before; opaque. */
const CURSOR = z.string().min(1).max(500);
const NEXT_CURSOR = z.string().max(500).nullable();
const VISIBILITY = z.enum(['shared', 'private']);
/**
 * A retry identity, as the `Idempotency-Key` header or this field (the same value if both): the
 * same key and request answer what the first did; another request is 422 idempotency_conflict.
 */
const IDEMPOTENCY_KEY = IDENTITY.describe(
  'A retry identity, also accepted as the Idempotency-Key header: the same key with the same request answers what the first did; with another request, 422 idempotency_conflict.',
);

/** Minutes after the end kept busy as well, for turnaround: at most 30 days. */
const BUFFER_AFTER_MINUTES = z
  .number()
  .int()
  .min(0)
  .max(30 * 24 * 60);

const AVAILABILITY_RULE = z
  .object({
    rrule: z.string().min(1).max(500),
    start_minutes: z.number().int().min(0).max(1_439),
    duration_minutes: z.number().int().min(1).max(10_080),
  })
  .strict();
const AVAILABILITY_RULES = z.array(AVAILABILITY_RULE).max(50);

/** What a booking on a resource must satisfy; each rule optional (`SlotlockBookingRules`). */
const BOOKING_RULES = z
  .object({
    min_notice_minutes: z.number().int().min(0).max(525_600).optional(),
    max_advance_days: z.number().int().min(1).max(3_660).optional(),
    slot_step_minutes: z.number().int().min(1).max(1_440).optional(),
    step_offset_minutes: z.number().int().min(0).max(1_439).optional(),
    buffer_before_minutes: z.number().int().min(0).max(1_440).optional(),
    turnaround_minutes: z.number().int().min(0).max(1_440).optional(),
    enforce_hours: z.boolean().optional(),
    check_in_minutes: z.number().int().min(1).max(1_440).optional(),
    require_certain: z.boolean().optional(),
  })
  .strict();

/** Default booking rules for the tenant or a pool: a resource's own rules but check-in. */
const DEFAULT_BOOKING_RULES = BOOKING_RULES.omit({ check_in_minutes: true }).strict();

const POOL = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
/** The order slotlock_book_pool tries a pool's members in (RFC 0003 G7). */
const POOL_ORDER = z.enum(SLOTLOCK_POOL_ORDERS);

const PROFILE = SLOTLOCK_RESOURCE_PROFILE_LIMITS;
/** What a resource is: a hint for filtering and display that changes no booking. */
const RESOURCE_KIND = z.enum(SLOTLOCK_RESOURCE_KINDS);
const RESOURCE_LABEL = z.string().regex(SLOTLOCK_RESOURCE_LABEL);
const RESOURCE_ATTRIBUTES = z.record(
  z.string().min(1).max(PROFILE.attributeKey),
  z.union([z.string().max(PROFILE.attributeValue), z.number(), z.boolean()]),
);
/**
 * A resource's profile, each field optional (resource-profile.ts): a field left out is kept, `null`
 * clears a name, description or capacity, and `[]` and `{}` clear labels and attributes. The store
 * also refuses attributes over 4 KiB, or with more than 50 keys (400 invalid_resource_profile).
 */
const PROFILE_INPUT = {
  /** Shown to agents and people instead of the reference. */
  name: z.string().min(1).max(PROFILE.name).nullable().optional(),
  description: z.string().min(1).max(PROFILE.description).nullable().optional(),
  kind: RESOURCE_KIND.optional(),
  /** People or seats it holds: informational, never enforced as bookings at once. */
  capacity: z.number().int().min(1).max(PROFILE.capacity).nullable().optional(),
  /** Replaces its labels; sorted and without repeats when stored. */
  labels: z.array(RESOURCE_LABEL).max(PROFILE.labels).optional(),
  /** Replaces its attributes: text, numbers and true or false. */
  attributes: RESOURCE_ATTRIBUTES.optional(),
};

/** A location's or a group's reference: as a pool's. */
const GROUPING_REF = z.string().regex(SLOTLOCK_GROUPING_REF);

/** A place a tenant's resources are at (RFC 0003 G2). */
const LOCATION = z
  .object({
    ref: GROUPING_REF,
    name: z.string().max(PROFILE.name),
    /** The location it is in; `null` at the top. */
    parent_ref: GROUPING_REF.nullable(),
    /** What a resource created here without a time zone takes; `null` to take its parent's. */
    timezone: TIMEZONE.nullable(),
    /** Resources at it, not counting those under it. */
    resources: z.number().int().min(0),
  })
  .strict();

/** A set of a tenant's resources (RFC 0003 G3). */
const GROUP = z
  .object({
    ref: GROUPING_REF,
    name: z.string().max(PROFILE.name),
    description: z.string().max(PROFILE.description).nullable(),
    /** Resources in it. */
    members: z.number().int().min(0),
  })
  .strict();

const RESOURCE = z
  .object({
    id: RESOURCE_ID,
    external_ref: z.string().max(500).nullable(),
    timezone: TIMEZONE,
    /** The resource's own weekly hours; `null` when it uses the default. */
    availability: AVAILABILITY_RULES.nullable(),
    /** Its own booking rules; `null` when it has none. */
    booking_rules: BOOKING_RULES.nullable(),
    /**
     * Tenant defaults, overlaid by its pool's, overlaid by its own; `null` when no rule applies.
     */
    effective_booking_rules: BOOKING_RULES.nullable(),
    /** `private` resources are never shown to agents; fixed when the resource is created. */
    visibility: VISIBILITY,
    /** When it was archived; `null` while it is in use. */
    archived_at: DATE_TIME.nullable(),
    /** The pool it is a member of (a vehicle class, a room type); `null` when none. */
    pool: POOL.nullable(),
    /** Its name; `null` when it has none, and agents and people see the reference. */
    name: z.string().max(PROFILE.name).nullable(),
    description: z.string().max(PROFILE.description).nullable(),
    /** What it is; `other` when not said. */
    kind: RESOURCE_KIND,
    /** People or seats it holds; `null` when not said. */
    capacity: z.number().int().nullable(),
    labels: z.array(RESOURCE_LABEL).max(PROFILE.labels),
    attributes: RESOURCE_ATTRIBUTES,
    /** The location it is at; `null` when not said. */
    location: GROUPING_REF.nullable(),
    /** The groups it is in, by reference. */
    groups: z.array(GROUPING_REF).max(SLOTLOCK_MAX_GROUPS_PER_RESOURCE),
    /** The composite it is a part of (a room of a hall), by id; `null` when it is no part. */
    parent_id: z.string().uuid().nullable(),
    /** Its place among its parent's parts, from 0; `null` when it is no part. */
    part_index: z.number().int().min(0).nullable(),
  })
  .strict();

const HISTORY_ENTRY = z
  .object({
    id: z.string().max(40),
    type: z.string().max(100),
    time: DATE_TIME,
    /** Who made it: an API key, an agent's subject; `null` when not recorded. */
    actor: z.string().max(200).nullable(),
    /** Where it came from (mcp, a2a, rest, application, dashboard, ...); `null` when not recorded. */
    origin: z.enum(SLOTLOCK_CHANGE_ORIGINS).nullable(),
    /** The API key that made it, by id; `null` when no key did. */
    key_id: z.string().uuid().nullable(),
    /** The record as the change left it, with `before` for a change of an existing one. */
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

const HISTORY_OUTPUT = z
  .object({ history: z.array(HISTORY_ENTRY).max(100), next_before: z.string().max(40).nullable() })
  .strict();

const HISTORY_PAGE = {
  limit: z.number().int().min(1).max(100).default(50),
  before: z.string().regex(/^msg_[0-9]{1,19}$/).optional(),
};

const CHANGE = z
  .object({
    specversion: z.literal('1.0'),
    id: z.string().max(40),
    source: z.string().max(300),
    type: z.string().max(100),
    subject: z.string().max(500),
    time: DATE_TIME,
    datacontenttype: z.literal('application/json'),
    /** Extension attribute: where the change came from, when recorded (mcp, rest, dashboard, ...). */
    slotlockorigin: z.enum(SLOTLOCK_CHANGE_ORIGINS).optional(),
    /** Extension attribute: the id of the API key that made it, when one did. */
    slotlockkeyid: z.string().uuid().optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

const WEBHOOK = z
  .object({
    id: z.string().uuid(),
    url: z.string().max(2048),
    event_types: z.array(z.enum(SLOTLOCK_CHANGE_TYPES)).nullable(),
    created_at: DATE_TIME,
    attempts: z.number().int().min(0),
    failing_since: DATE_TIME.nullable(),
    last_status: z.number().int().nullable(),
    last_error: z.string().max(500).nullable(),
    disabled_at: DATE_TIME.nullable(),
    disabled_reason: z.enum(['gone', 'failing']).nullable(),
    /** Only changes about these resources; `null` when it has no such filter. */
    filter: z
      .object({
        resource_ids: z.array(z.string().uuid()).max(SLOTLOCK_WEBHOOK_FILTER_RESOURCES).optional(),
        pools: z.array(GROUPING_REF).max(SLOTLOCK_WEBHOOK_FILTER_REFS).optional(),
        locations: z.array(GROUPING_REF).max(SLOTLOCK_WEBHOOK_FILTER_REFS).optional(),
        groups: z.array(GROUPING_REF).max(SLOTLOCK_WEBHOOK_FILTER_REFS).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const WAITLIST_ENTRY = z
  .object({
    id: z.string().uuid(),
    /** The resource it waits on; `null` when it waits on a pool. */
    resource_id: RESOURCE_ID.nullable(),
    pool: POOL.nullable(),
    start: DATE_TIME,
    end: DATE_TIME,
    holder_ref: z.string().min(1).max(500),
    offer_ttl_seconds: z.number().int().min(60).max(86_400),
    /** waiting; offered (hold_id holds the window on offered_resource_id); expired (it started first). */
    status: z.enum(['waiting', 'offered', 'expired']),
    hold_id: z.string().uuid().nullable(),
    offered_resource_id: RESOURCE_ID.nullable(),
    offered_at: DATE_TIME.nullable(),
    created_at: DATE_TIME,
  })
  .strict();

const HOLD = z
  .object({
    id: HOLD_ID,
    resource_id: RESOURCE_ID,
    start: DATE_TIME,
    end: DATE_TIME,
    expires_at: DATE_TIME,
    source: z.string().max(200).nullable(),
  })
  .strict();

const RESERVATION = z
  .object({
    id: z.string().max(200),
    resource_id: RESOURCE_ID,
    reservation_ref: z.string().max(500).nullable(),
    start: DATE_TIME,
    end: DATE_TIME,
    buffer_after_minutes: z.number().int().min(0),
    revision: REVISION,
    source: z.string().max(200).nullable(),
  })
  .strict();

/** A JSCalendar Event (RFC 8984 §5.1); interop.ts's JSCalendarEvent names every property. */
const JSCALENDAR_EVENT = z
  .object({
    '@type': z.literal('Event'),
    uid: z.string().max(200),
    updated: DATE_TIME,
    sequence: z.number().int().min(0),
    title: z.string(),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
    timeZone: TIMEZONE,
    duration: z.string().regex(/^PT/),
    status: z.enum(['confirmed', 'tentative']),
    freeBusyStatus: z.enum(['free', 'busy']),
  })
  .passthrough();

const TENANT_EVENT = SLOTLOCK_EVENT_OUTPUT.extend({
  event_ref: z.string().max(500),
  owner_ref: z.string().max(500),
}).strict();

const BUSY_INTERVAL = z.object({ start: DATE_TIME, end: DATE_TIME }).strict();

const EXAMPLE_RESOURCE_ID = '0f8b6c1e-2d4a-4c7e-9b1a-3e5f7a9c2d4b';
const EXAMPLE_HOLD_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const EXAMPLE_EVENT_ID = '3d6f0a2b-8c4e-4f1a-9b7d-5e2c8a1f4b6d';
const EXAMPLE_WINDOW = { start: '2027-03-01T00:00:00Z', end: '2027-04-01T00:00:00Z' };
const EXAMPLE_RULES = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', start_minutes: 540, duration_minutes: 480 },
];

export const SLOTLOCK_APPLICATION_OPERATIONS: readonly SlotlockApplicationOperationDefinition[] =
  Object.freeze([
    {
      name: 'slotlock_create_resource',
      title: 'Create or update a resource',
      description:
        'Create the resource with this external reference, or update its time zone, and the profile fields and location given, if the tenant already has it. Without a time zone, a new resource takes the nearest one its location, or a location above it, has, else UTC; a location the tenant does not have answers 404 location_not_found. Repeating the call changes nothing more. visibility is shared (the default: agents list and book it) or private (agents never see it), fixed at creation: naming another for an existing resource answers 409 resource_visibility_conflict. Its profile is optional: a name agents and people see instead of the reference, a description, its kind (person, room, desk, space, vehicle, machine, equipment, service or other: a hint, never a rule), its capacity (informational), up to 20 labels to find it by, and attributes you want back.',
      method: 'POST',
      path: '/v1/resources',
      input: z
        .object({
          external_ref: IDENTITY,
          /** UTC, or its location's, when not given. */
          timezone: TIMEZONE.optional(),
          visibility: VISIBILITY.optional(),
          ...PROFILE_INPUT,
          /** The location it is at, by reference. */
          location: GROUPING_REF.optional(),
        })
        .strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'createResource',
      example: {
        external_ref: 'room-3',
        timezone: 'Europe/London',
        name: 'Room 3',
        kind: 'room',
        capacity: 10,
        labels: ['video', 'whiteboard'],
      },
    },
    {
      name: 'slotlock_update_resource',
      title: "Change a resource's profile",
      description:
        "Change a resource's name, description, kind, capacity, labels, attributes or location: the fields given, keeping the rest. null clears a name, description, capacity or location; [] and {} clear labels and attributes. A location the tenant does not have answers 404 location_not_found. The feed's resource.updated names the fields that changed (profile_changed), never their values. 400 invalid_resource_profile outside the bounds, naming the field.",
      method: 'PATCH',
      path: '/v1/resources/{resource_id}',
      input: z
        .object({ resource_id: RESOURCE_ID, ...PROFILE_INPUT, location: GROUPING_REF.nullable().optional() })
        .strict()
        .refine(
          (input) => Object.keys(input).some((key) => key !== 'resource_id'),
          'Give at least one profile field to change',
        ),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'updateResource',
      example: { resource_id: EXAMPLE_RESOURCE_ID, name: 'Board room', labels: ['video'] },
    },
    {
      name: 'slotlock_list_locations',
      title: 'List locations',
      description: `The tenant's locations, each after the one it is in (depth first), with how many resources are at each. A tree of at most ${SLOTLOCK_MAX_LOCATION_DEPTH} levels and ${SLOTLOCK_MAX_LOCATIONS} locations: a region, a site, a building, a floor, a zone, or whatever yours are.`,
      method: 'GET',
      path: '/v1/locations',
      input: z.object({}).strict(),
      output: z.object({ locations: z.array(LOCATION).max(SLOTLOCK_MAX_LOCATIONS) }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'listLocations',
      example: {},
    },
    {
      name: 'slotlock_create_location',
      title: 'Create or update a location',
      description: `Create the location with this reference, or change its name, and the parent and time zone given. 404 location_not_found for a parent the tenant does not have; 409 location_too_deep past ${SLOTLOCK_MAX_LOCATION_DEPTH} levels, location_cycle under itself, location_limit_reached past ${SLOTLOCK_MAX_LOCATIONS}.`,
      method: 'POST',
      path: '/v1/locations',
      input: z
        .object({
          ref: GROUPING_REF,
          name: z.string().min(1).max(PROFILE.name),
          parent_ref: GROUPING_REF.nullable().optional(),
          timezone: TIMEZONE.nullable().optional(),
        })
        .strict(),
      output: z.object({ location: LOCATION }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'createLocation',
      example: { ref: 'leeds', name: 'Leeds clinic', timezone: 'Europe/London' },
    },
    {
      name: 'slotlock_update_location',
      title: 'Change a location',
      description: "Change a location's name, parent or time zone: the fields given. Refused as creating one is.",
      method: 'PATCH',
      path: '/v1/locations/{location_ref}',
      input: z
        .object({
          location_ref: GROUPING_REF,
          name: z.string().min(1).max(PROFILE.name).optional(),
          parent_ref: GROUPING_REF.nullable().optional(),
          timezone: TIMEZONE.nullable().optional(),
        })
        .strict()
        .refine(
          (input) => Object.keys(input).some((key) => key !== 'location_ref'),
          'Give at least one field to change',
        ),
      output: z.object({ location: LOCATION }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'updateLocation',
      example: { location_ref: 'leeds', name: 'Leeds city clinic' },
    },
    {
      name: 'slotlock_delete_location',
      title: 'Delete a location',
      description:
        'Delete a location. Refused with 409 location_in_use while a resource is at it or a location is in it: move them first. deleted is false when the tenant has no such location.',
      method: 'DELETE',
      path: '/v1/locations/{location_ref}',
      input: z.object({ location_ref: GROUPING_REF }).strict(),
      output: z.object({ deleted: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'deleteLocation',
      example: { location_ref: 'leeds' },
    },
    {
      name: 'slotlock_list_groups',
      title: 'List groups',
      description: `The tenant's groups, by reference, with how many resources are in each: any sets you want (a team, a department, a contract), at most ${SLOTLOCK_MAX_RESOURCE_GROUPS}. A group changes nothing about how its resources are booked; a pool does that.`,
      method: 'GET',
      path: '/v1/groups',
      input: z.object({}).strict(),
      output: z.object({ groups: z.array(GROUP).max(SLOTLOCK_MAX_RESOURCE_GROUPS) }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'listGroups',
      example: {},
    },
    {
      name: 'slotlock_create_group',
      title: 'Create or update a group',
      description: `Create the group with this reference, or change its name, and its description when given. 409 group_limit_reached past ${SLOTLOCK_MAX_RESOURCE_GROUPS}.`,
      method: 'POST',
      path: '/v1/groups',
      input: z
        .object({
          ref: GROUPING_REF,
          name: z.string().min(1).max(PROFILE.name),
          description: z.string().min(1).max(PROFILE.description).nullable().optional(),
        })
        .strict(),
      output: z.object({ group: GROUP }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'createGroup',
      example: { ref: 'physio', name: 'Physiotherapy team' },
    },
    {
      name: 'slotlock_delete_group',
      title: 'Delete a group',
      description: 'Delete a group; its resources stay as they are. deleted is false when the tenant has no such group.',
      method: 'DELETE',
      path: '/v1/groups/{group_ref}',
      input: z.object({ group_ref: GROUPING_REF }).strict(),
      output: z.object({ deleted: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'deleteGroup',
      example: { group_ref: 'physio' },
    },
    {
      name: 'slotlock_add_group_member',
      title: 'Put a resource in a group',
      description: `Put one of the tenant's resources in a group. added is false when it was in it already. 404 group_not_found or resource_not_found; 409 resource_group_limit_reached past ${SLOTLOCK_MAX_GROUPS_PER_RESOURCE} groups a resource.`,
      method: 'PUT',
      path: '/v1/groups/{group_ref}/members/{resource_id}',
      input: z.object({ group_ref: GROUPING_REF, resource_id: RESOURCE_ID }).strict(),
      output: z.object({ added: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'addGroupMember',
      example: { group_ref: 'physio', resource_id: EXAMPLE_RESOURCE_ID },
    },
    {
      name: 'slotlock_remove_group_member',
      title: 'Take a resource out of a group',
      description: 'Take a resource out of a group. removed is false when it was not in it.',
      method: 'DELETE',
      path: '/v1/groups/{group_ref}/members/{resource_id}',
      input: z.object({ group_ref: GROUPING_REF, resource_id: RESOURCE_ID }).strict(),
      output: z.object({ removed: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'removeGroupMember',
      example: { group_ref: 'physio', resource_id: EXAMPLE_RESOURCE_ID },
    },
    {
      name: 'slotlock_get_resource',
      title: 'Get a resource',
      description:
        'One resource of the tenant, archived or not, with its own weekly bookable hours and its visibility.',
      method: 'GET',
      path: '/v1/resources/{resource_id}',
      input: z.object({ resource_id: RESOURCE_ID }).strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getResource',
      example: { resource_id: EXAMPLE_RESOURCE_ID },
    },
    {
      name: 'slotlock_archive_resource',
      title: 'Archive a resource',
      description:
        'Take a resource out of use: no list shows it and it takes no new booking, hold or event (409 resource_archived), while what is on it stays and can still be cancelled or released. Archiving it again keeps the first time.',
      method: 'POST',
      path: '/v1/resources/{resource_id}/archive',
      input: z.object({ resource_id: RESOURCE_ID }).strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'archiveResource',
      example: { resource_id: EXAMPLE_RESOURCE_ID },
    },
    {
      name: 'slotlock_restore_resource',
      title: 'Restore a resource',
      description: 'Put an archived resource back in use. Restoring one in use changes nothing.',
      method: 'POST',
      path: '/v1/resources/{resource_id}/restore',
      input: z.object({ resource_id: RESOURCE_ID }).strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'restoreResource',
      example: { resource_id: EXAMPLE_RESOURCE_ID },
    },
    {
      name: 'slotlock_delete_resource',
      title: 'Delete a resource',
      description:
        "Delete a resource with its history (past bookings, coverage, cancelled events), freeing its place under the tenant's resource limit. Refused with 409 resource_in_use while a booking on it has not ended, a hold on it is live, or a calendar event is on it: cancel or move those first. deleted is false when the tenant has no such resource, deleted already, say.",
      method: 'DELETE',
      path: '/v1/resources/{resource_id}',
      input: z.object({ resource_id: RESOURCE_ID }).strict(),
      output: z.object({ deleted: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'deleteResource',
      example: { resource_id: EXAMPLE_RESOURCE_ID },
    },
    {
      name: 'slotlock_list_busy',
      title: "List a resource's busy time",
      description: `The time a resource of the tenant, private ones included, is occupied in a window of at most ${SLOTLOCK_CALENDAR_HORIZON_DAYS} days, by start: bookings with their turnaround, live holds, and calendar events. Adjacent intervals are not merged. More than 10,000 answers 400 calendar_work_limit: narrow the window. Free/busy with coverage, for the resources agents see, is slotlock_get_free_busy.`,
      method: 'GET',
      path: '/v1/resources/{resource_id}/busy',
      input: z
        .object({ resource_id: RESOURCE_ID, start: DATE_TIME, end: DATE_TIME })
        .strict()
        .refine(boundedWindow, WINDOW_MESSAGE),
      output: z.object({ busy: z.array(BUSY_INTERVAL).max(10_000) }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'listBusy',
      example: { resource_id: EXAMPLE_RESOURCE_ID, ...EXAMPLE_WINDOW },
    },
    {
      name: 'slotlock_set_resource_availability',
      title: "Set a resource's bookable hours",
      description:
        "Give one resource its own weekly bookable hours. `null` makes it use the server's default; `[]` makes it never bookable. Each rule is weekly with BYDAY, in the resource's time zone: start_minutes after midnight, lasting duration_minutes.",
      method: 'PUT',
      path: '/v1/resources/{resource_id}/availability',
      input: z.object({ resource_id: RESOURCE_ID, rules: AVAILABILITY_RULES.nullable() }).strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'setResourceAvailability',
      example: { resource_id: EXAMPLE_RESOURCE_ID, rules: EXAMPLE_RULES },
    },
    {
      name: 'slotlock_export_resource_availability',
      title: "Export a resource's bookable hours as iCalendar",
      description:
        "One resource's own weekly bookable hours as an iCalendar VAVAILABILITY (RFC 7953) for a calendar or scheduling tool: an AVAILABLE per rule, its DTSTART's TZID the resource's IANA time zone. `null` when the resource uses the server's default.",
      method: 'GET',
      path: '/v1/resources/{resource_id}/availability/ical',
      input: z.object({ resource_id: RESOURCE_ID }).strict(),
      output: z.object({ icalendar: z.string().max(200_000).nullable() }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'exportResourceAvailability',
      example: { resource_id: EXAMPLE_RESOURCE_ID },
    },
    {
      name: 'slotlock_import_resource_availability',
      title: "Import a resource's bookable hours from iCalendar",
      description:
        "Set one resource's own weekly bookable hours from an iCalendar VAVAILABILITY (RFC 7953), as slotlock_set_resource_availability does from rules: each AVAILABLE a weekly RRULE with a start time and DTEND or DURATION. Times must be in the resource's time zone (its TZID) or floating. 400 invalid_availability names what weekly hours cannot say: a bounded VAVAILABILITY, RDATE, EXDATE, a single window, another zone.",
      method: 'PUT',
      path: '/v1/resources/{resource_id}/availability/ical',
      input: z
        .object({ resource_id: RESOURCE_ID, icalendar: z.string().min(1).max(65_536) })
        .strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'importResourceAvailability',
      example: {
        resource_id: EXAMPLE_RESOURCE_ID,
        icalendar:
          'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//EN\r\nBEGIN:VAVAILABILITY\r\nUID:hours-1\r\nDTSTAMP:20260101T000000Z\r\nBEGIN:AVAILABLE\r\nUID:hours-1-0\r\nDTSTAMP:20260101T000000Z\r\nDTSTART;TZID=Europe/London:20260105T090000\r\nDTEND;TZID=Europe/London:20260105T170000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR\r\nEND:AVAILABLE\r\nEND:VAVAILABILITY\r\nEND:VCALENDAR\r\n',
      },
    },
    {
      name: 'slotlock_set_resource_booking_rules',
      title: "Set a resource's booking rules",
      description:
        "Set what a booking on one resource must satisfy from now on: minimum notice, how far ahead, the step starts fall on (from local midnight in the resource's time zone, offset by step_offset_minutes), the time kept free before and after each booking, and whether bookings must lie inside its hours. `null` clears them. A rule it does not set comes from its pool's or the tenant's defaults (slotlock_set_pool_booking_rules, slotlock_set_tenant_booking_rules). Holds, reservations, moves and agents' events are refused with the rule they break; searches offer only what they allow.",
      method: 'PUT',
      path: '/v1/resources/{resource_id}/booking-rules',
      input: z.object({ resource_id: RESOURCE_ID, rules: BOOKING_RULES.nullable() }).strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'setResourceBookingRules',
      example: {
        resource_id: EXAMPLE_RESOURCE_ID,
        rules: { min_notice_minutes: 120, slot_step_minutes: 30, turnaround_minutes: 30, enforce_hours: true },
      },
    },
    {
      name: 'slotlock_set_resource_pool',
      title: "Set a resource's pool",
      description:
        "Make a resource a member of a pool, a class of interchangeable resources such as a vehicle class or a room type, or take it out (`null`). Agents book the class with slotlock_book_pool, which takes the first member free; the class's capacity is its number of members. A resource is in one pool at most; pool names are 1-100 of a-z, 0-9, '.', '_' and '-'.",
      method: 'PUT',
      path: '/v1/resources/{resource_id}/pool',
      input: z.object({ resource_id: RESOURCE_ID, pool: POOL.nullable() }).strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'setResourcePool',
      example: { resource_id: EXAMPLE_RESOURCE_ID, pool: 'van' },
    },
    {
      name: 'slotlock_set_resource_parent',
      title: "Make a resource part of another",
      description:
        "Make a resource a part of a composite (a room of a hall, a half of a court), or no part (`null`). A booking of the composite as a whole then conflicts with a booking of any of its parts, and two parts never conflict with each other; each part's free/busy shows the whole's bookings, and the whole's shows its parts'. One level deep, at most 50 parts; refused while either side has a booking or live hold still to come (`composite_busy`).",
      method: 'PUT',
      path: '/v1/resources/{resource_id}/parent',
      input: z.object({ resource_id: RESOURCE_ID, parent_id: RESOURCE_ID.nullable() }).strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'setResourceParent',
      example: { resource_id: EXAMPLE_RESOURCE_ID, parent_id: '0e7c1f9a-3b5d-4c2e-9f81-6a4b2d8c7e10' },
    },
    {
      name: 'slotlock_list_pools',
      title: 'List pools',
      description:
        "The tenant's pools by name, each with its capacity (how many members it has that are not archived) and the order slotlock_book_pool tries them in.",
      method: 'GET',
      path: '/v1/pools',
      input: z.object({}).strict(),
      output: z
        .object({
          pools: z
            .array(z.object({ pool: POOL, capacity: z.number().int().min(1), order: POOL_ORDER }).strict())
            .max(1000),
        })
        .strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'listPools',
      example: {},
    },
    {
      name: 'slotlock_set_pool_order',
      title: "Set a pool's order",
      description:
        "The order slotlock_book_pool tries a pool's members in: stable (by id, the default), least_booked (fewest bookings made on each in the last 30 days first, to share them out) or round_robin (from the member after the one booked last). At most 1,000 pools have one: one more is 409 pool_order_limit_reached.",
      method: 'PUT',
      path: '/v1/pools/{pool}/order',
      input: z.object({ pool: POOL, order: POOL_ORDER }).strict(),
      output: z.object({ pool: POOL, order: POOL_ORDER }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'setPoolOrder',
      example: { pool: 'van', order: 'least_booked' },
    },
    {
      name: 'slotlock_get_booking_rule_defaults',
      title: 'Get default booking rules',
      description:
        "The tenant's default booking rules, and each pool's that has them. A resource's rules as they apply (effective_booking_rules) are the tenant's defaults, overlaid by its pool's, overlaid by its own: a rule set at a narrower level wins.",
      method: 'GET',
      path: '/v1/booking-rules',
      input: z.object({}).strict(),
      output: z
        .object({
          tenant: DEFAULT_BOOKING_RULES.nullable(),
          pools: z.array(z.object({ pool: POOL, rules: DEFAULT_BOOKING_RULES }).strict()).max(1000),
        })
        .strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getBookingRuleDefaults',
      example: {},
    },
    {
      name: 'slotlock_set_tenant_booking_rules',
      title: 'Set default booking rules',
      description:
        "Set the booking rules every resource of the tenant has unless its pool or its own rules set the same rule, from now on; `null` clears them. They take any resource rule but check_in_minutes, which only a resource sets.",
      method: 'PUT',
      path: '/v1/booking-rules',
      input: z.object({ rules: DEFAULT_BOOKING_RULES.nullable() }).strict(),
      output: z.object({ rules: DEFAULT_BOOKING_RULES.nullable() }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'setTenantBookingRules',
      example: { rules: { min_notice_minutes: 120, buffer_before_minutes: 15, turnaround_minutes: 15 } },
    },
    {
      name: 'slotlock_set_pool_booking_rules',
      title: "Set a pool's booking rules",
      description:
        "Set the booking rules every member of one pool has unless its own rules set the same rule, over the tenant's defaults, from now on; `null` clears them. They take any resource rule but check_in_minutes. At most 1,000 pools have them: one more is 409 pool_rules_limit_reached.",
      method: 'PUT',
      path: '/v1/pools/{pool}/booking-rules',
      input: z.object({ pool: POOL, rules: DEFAULT_BOOKING_RULES.nullable() }).strict(),
      output: z.object({ pool: POOL, rules: DEFAULT_BOOKING_RULES.nullable() }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'setPoolBookingRules',
      example: { pool: 'van', rules: { slot_step_minutes: 30, step_offset_minutes: 15 } },
    },
    {
      name: 'slotlock_get_resource_history',
      title: "A resource's history",
      description:
        "What happened on one of the tenant's resources, newest first: each hold, booking and event made, moved, confirmed, released or cancelled, and each change to the resource itself (created, rules, pool or hours changed, archived, restored, coverage recorded or deleted), when, by whom (the actor and API key), from where (origin), and for a change what it was before. Kept 30 days. Pass next_before as before for older entries.",
      method: 'GET',
      path: '/v1/resources/{resource_id}/history',
      input: z.object({ resource_id: RESOURCE_ID, ...HISTORY_PAGE }).strict(),
      output: HISTORY_OUTPUT,
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getResourceHistory',
      example: { resource_id: EXAMPLE_RESOURCE_ID, limit: 20 },
    },
    {
      name: 'slotlock_get_reservation_history',
      title: "A booking's history",
      description:
        'What happened to one booking, by its reference, newest first: made, moved, cancelled, when and by whom, as slotlock_get_resource_history.',
      method: 'GET',
      path: '/v1/reservations/{reservation_ref}/history',
      input: z.object({ reservation_ref: z.string().min(1).max(500), ...HISTORY_PAGE }).strict(),
      output: HISTORY_OUTPUT,
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getReservationHistory',
      example: { reservation_ref: 'BK-42', limit: 20 },
    },
    {
      name: 'slotlock_get_tenant_event_history',
      title: "An event's history",
      description:
        'What happened to one calendar event of the tenant, by its id, newest first: created, changed, cancelled, when and by whom, as slotlock_get_resource_history.',
      method: 'GET',
      path: '/v1/tenant/events/{event_id}/history',
      input: z.object({ event_id: z.string().uuid(), ...HISTORY_PAGE }).strict(),
      output: HISTORY_OUTPUT,
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getTenantEventHistory',
      example: { event_id: '5e8ff9bf-55ba-4508-9d22-e984129be6b5', limit: 20 },
    },
    {
      name: 'slotlock_set_tenant_availability',
      title: "Set every resource's bookable hours",
      description:
        "Set the weekly bookable hours of every resource the tenant has, as slotlock_set_resource_availability does for one. `null` makes them all use the server's default. Returns how many resources changed.",
      method: 'PUT',
      path: '/v1/availability',
      input: z.object({ rules: AVAILABILITY_RULES.nullable() }).strict(),
      output: z.object({ resources_updated: z.number().int().min(0) }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'setTenantAvailability',
      example: { rules: EXAMPLE_RULES },
    },
    {
      name: 'slotlock_acquire_hold',
      title: 'Hold time',
      description:
        'Occupy a window without booking it, for example while a customer pays. The hold blocks every other booking until it expires (the database clock, ttl_seconds from now), is confirmed, or is released. buffer_after_minutes keeps the time after it busy as well, and a confirmed hold keeps it. A taken window answers 409 overlap. With an idempotency key (the Idempotency-Key header or idempotency_key), a retry answers the hold the first request made, until that hold would have expired, is released or is confirmed; the same key with another request is 422 idempotency_conflict.',
      method: 'POST',
      path: '/v1/holds',
      input: z
        .object({
          resource_id: RESOURCE_ID,
          start: DATE_TIME,
          end: DATE_TIME,
          ttl_seconds: z
            .number()
            .int()
            .min(1)
            .max(7 * 24 * 60 * 60),
          source: SOURCE.optional(),
          idempotency_key: IDEMPOTENCY_KEY.optional(),
          // Last, so a generated 0.2.0 client's positional arguments keep their places.
          buffer_after_minutes: BUFFER_AFTER_MINUTES.optional(),
        })
        .strict()
        .refine(boundedSpan, SPAN_MESSAGE),
      output: z.object({ hold: HOLD }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: false },
      invoke: 'acquireHold',
      example: {
        resource_id: EXAMPLE_RESOURCE_ID,
        start: '2027-03-29T09:00:00Z',
        end: '2027-03-29T10:00:00Z',
        ttl_seconds: 600,
        source: 'checkout',
        idempotency_key: 'checkout-7f3a9c',
      },
    },
    {
      name: 'slotlock_get_hold',
      title: 'Get a hold',
      description:
        'One of the tenant\'s live holds. An expired, confirmed, released or unknown one answers 404 hold_not_found; a confirmed one is a reservation whose reference is the hold\'s id.',
      method: 'GET',
      path: '/v1/holds/{hold_id}',
      input: z.object({ hold_id: HOLD_ID }).strict(),
      output: z.object({ hold: HOLD }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getHold',
      example: { hold_id: EXAMPLE_HOLD_ID },
    },
    {
      name: 'slotlock_list_holds',
      title: "List a resource's holds",
      description:
        "The live holds on one of the tenant's resources, by start then id, a page at a time: pass next_cursor as cursor for the next page, until it is null.",
      method: 'GET',
      path: '/v1/resources/{resource_id}/holds',
      input: z
        .object({ resource_id: RESOURCE_ID, limit: PAGE_LIMIT, cursor: CURSOR.optional() })
        .strict(),
      output: z.object({ holds: z.array(HOLD).max(100), next_cursor: NEXT_CURSOR }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'listHolds',
      example: { resource_id: EXAMPLE_RESOURCE_ID, limit: 50 },
    },
    {
      name: 'slotlock_confirm_hold',
      title: 'Confirm a hold',
      description:
        "Turn an unexpired hold into a confirmed reservation, whose reference is the hold's id at revision 1: move or cancel it with the reservation routes by that reference (DELETE /v1/reservations/{hold_id}?revision=2 cancels it). Confirming it again answers the same reservation, so a retry is safe. An expired hold answers 409 hold_expired; a released or unknown one, 404 hold_not_found.",
      method: 'POST',
      path: '/v1/holds/{hold_id}/confirm',
      input: z.object({ hold_id: HOLD_ID }).strict(),
      output: z.object({ reservation: RESERVATION }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: false },
      invoke: 'confirmHold',
      example: { hold_id: EXAMPLE_HOLD_ID },
    },
    {
      name: 'slotlock_release_hold',
      title: 'Release a hold',
      description:
        'Free a held window. released is false when the hold was already gone: expired, confirmed or released.',
      method: 'DELETE',
      path: '/v1/holds/{hold_id}',
      input: z.object({ hold_id: HOLD_ID }).strict(),
      output: z.object({ released: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'releaseHold',
      example: { hold_id: EXAMPLE_HOLD_ID },
    },
    {
      name: 'slotlock_get_reservation',
      title: 'Get a reservation',
      description:
        "The tenant's booking with this reference as it now is, at its current revision: move it at that revision plus 1. A cancelled or unknown reference, or a calendar event's time, answers 404 reservation_not_found.",
      method: 'GET',
      path: '/v1/reservations/{reservation_ref}',
      input: z.object({ reservation_ref: IDENTITY }).strict(),
      output: z.object({ reservation: RESERVATION }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getReservation',
      example: { reservation_ref: 'booking-BK-42' },
    },
    {
      name: 'slotlock_list_reservations',
      title: "List a resource's reservations",
      description: `The tenant's bookings on one resource whose time, turnaround included, meets a window of at most ${SLOTLOCK_CALENDAR_HORIZON_DAYS} days, by start then id, a page at a time: pass next_cursor as cursor for the next page, until it is null. Calendar events are not bookings; slotlock_list_tenant_events lists them.`,
      method: 'GET',
      path: '/v1/resources/{resource_id}/reservations',
      input: z
        .object({
          resource_id: RESOURCE_ID,
          start: DATE_TIME,
          end: DATE_TIME,
          limit: PAGE_LIMIT,
          cursor: CURSOR.optional(),
        })
        .strict()
        .refine(boundedWindow, WINDOW_MESSAGE),
      output: z
        .object({ reservations: z.array(RESERVATION).max(100), next_cursor: NEXT_CURSOR })
        .strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'listReservations',
      example: { resource_id: EXAMPLE_RESOURCE_ID, ...EXAMPLE_WINDOW, limit: 50 },
    },
    {
      name: 'slotlock_put_reservation',
      title: 'Book or move a reservation',
      description:
        'Book the reservation with this reference (revision 1), or move it (the next revision: the current one plus 1). Sending the same reservation at its current revision again changes nothing (replayed: true). A taken window answers 409 overlap and leaves a moved reservation where it was. buffer_after_minutes keeps the time after it busy as well.',
      method: 'PUT',
      path: '/v1/reservations/{reservation_ref}',
      input: z
        .object({
          reservation_ref: IDENTITY,
          resource_id: RESOURCE_ID,
          start: DATE_TIME,
          end: DATE_TIME,
          buffer_after_minutes: BUFFER_AFTER_MINUTES.default(0),
          revision: REVISION,
          source: SOURCE.optional(),
        })
        .strict()
        .refine(boundedSpan, SPAN_MESSAGE),
      output: z.object({ reservation: RESERVATION, replayed: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'putReservation',
      example: {
        reservation_ref: 'booking-BK-42',
        resource_id: EXAMPLE_RESOURCE_ID,
        start: '2027-03-29T09:00:00Z',
        end: '2027-03-31T09:00:00Z',
        buffer_after_minutes: 60,
        revision: 1,
      },
    },
    {
      name: 'slotlock_cancel_reservation',
      title: 'Cancel a reservation',
      description:
        'Cancel the reservation with this reference at the next revision (the current one plus 1). Cancelling leaves a tombstone, so a delayed booking cannot bring it back; repeating the cancel answers cancelled: false. Use a new reference for a new reservation.',
      method: 'DELETE',
      path: '/v1/reservations/{reservation_ref}',
      input: z.object({ reservation_ref: IDENTITY, revision: REVISION }).strict(),
      output: z.object({ cancelled: z.boolean(), revision: REVISION }).strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'cancelReservation',
      example: { reservation_ref: 'booking-BK-42', revision: 2 },
    },
    {
      name: 'slotlock_check_in_reservation',
      title: 'Check in a booking',
      description:
        "Claim a booking by its reference: the customer has arrived or picked up. On a resource whose booking rules set check_in_minutes, a booking not checked in that long after its start is released by maintenance (reservation.no_show on the feed) and offered to the waitlist. Check-in opens an hour before the start (409 check_in_not_open before then) and moving the booking to another start clears it. Checking in again keeps the first time; a booking that has ended answers 409 reservation_ended.",
      method: 'POST',
      path: '/v1/reservations/{reservation_ref}/check-in',
      input: z.object({ reservation_ref: IDENTITY }).strict(),
      output: z.object({ reference: IDENTITY, checked_in_at: DATE_TIME }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'checkInReservation',
      example: { reservation_ref: 'booking-BK-42' },
    },
    {
      name: 'slotlock_join_waitlist',
      title: 'Join the waitlist',
      description:
        "Wait for a window on one resource (resource_id) or on any member of a pool (pool) that is taken now. When it comes free (a booking cancelled, a hold released or expired, a no-show), the entries waiting for it are offered in the order they joined: the first gets a hold of it for holder_ref, for offer_ttl_seconds (default 900), and the feed says so (waitlist.offered, with hold_id): confirm the hold to book it. An entry whose window starts first expires (waitlist.expired). A holder may wait for 20 windows at once (409 waitlist_limit_reached); a window is at most 31 days. With an idempotency key (the Idempotency-Key header or idempotency_key), a retry answers the entry the first request made (replayed: true) for as long as it is kept; the same key with another request is 422 idempotency_conflict.",
      method: 'POST',
      path: '/v1/waitlist',
      input: z
        .object({
          resource_id: RESOURCE_ID.optional(),
          pool: POOL.optional(),
          start: DATE_TIME,
          end: DATE_TIME,
          holder_ref: z.string().trim().min(1).max(500),
          offer_ttl_seconds: z.number().int().min(60).max(86_400).optional(),
          idempotency_key: IDEMPOTENCY_KEY.optional(),
        })
        .strict()
        .refine((input) => (input.resource_id === undefined) !== (input.pool === undefined), {
          message: 'Name resource_id or pool, not both',
        }),
      output: z.object({ entry: WAITLIST_ENTRY, replayed: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'joinWaitlist',
      example: {
        pool: 'van',
        start: '2027-03-29T09:00:00Z',
        end: '2027-03-29T17:00:00Z',
        holder_ref: 'customer-42',
      },
    },
    {
      name: 'slotlock_list_waitlist',
      title: 'List the waitlist',
      description:
        "The tenant's waitlist entries in the order they are offered (oldest first), with what each was offered: optionally only those of one resource, pool or holder.",
      method: 'GET',
      path: '/v1/waitlist',
      input: z
        .object({
          resource_id: RESOURCE_ID.optional(),
          pool: POOL.optional(),
          holder_ref: z.string().trim().min(1).max(500).optional(),
          limit: z.number().int().min(1).max(1_000).default(100),
        })
        .strict(),
      output: z.object({ entries: z.array(WAITLIST_ENTRY).max(1_000) }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'listWaitlist',
      example: { pool: 'van' },
    },
    {
      name: 'slotlock_leave_waitlist',
      title: 'Leave the waitlist',
      description:
        'Stop waiting. A hold offered and not yet confirmed is released with the entry, and the time offered to the next who waits; one confirmed is a booking and stays. left is false when there was no such entry.',
      method: 'DELETE',
      path: '/v1/waitlist/{entry_id}',
      input: z.object({ entry_id: z.string().uuid() }).strict(),
      output: z.object({ left: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'leaveWaitlist',
      example: { entry_id: '1b4e28ba-2fa1-41d2-883f-0016d3cca427' },
    },
    {
      name: 'slotlock_record_coverage',
      title: 'Record calendar coverage',
      description:
        "Record that the events of an external calendar (source) are complete for a window of a resource, at that source's revision. Free/busy calls time unproven, not free, until every source a resource requires covers it. Revisions only go forward; repeating one changes nothing.",
      method: 'PUT',
      path: '/v1/resources/{resource_id}/coverage/{source}',
      input: z
        .object({
          resource_id: RESOURCE_ID,
          source: SOURCE,
          start: DATE_TIME,
          end: DATE_TIME,
          revision: REVISION,
        })
        .strict()
        .refine((value) => Date.parse(value.end) > Date.parse(value.start), SPAN_MESSAGE),
      output: z.object({ revision: REVISION, replayed: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'recordCoverage',
      example: {
        resource_id: EXAMPLE_RESOURCE_ID,
        source: 'google:fleet@example.com',
        start: '2027-03-01T00:00:00Z',
        end: '2027-06-01T00:00:00Z',
        revision: 7,
      },
    },
    {
      name: 'slotlock_get_coverage',
      title: "A resource's coverage and its health",
      description:
        "Each external calendar (source) that records coverage of a resource: the window it covers, when it was last read, its last error, and whether it is stale (not read for a day, so the time it covers is unproven, not free). A source that goes stale is also put on the change feed once, as coverage.stale, until it is read again. The feed names a source by its source_id (random, made when the source is first recorded for the resource and kept until it is deleted), never the source itself.",
      method: 'GET',
      path: '/v1/resources/{resource_id}/coverage',
      input: z.object({ resource_id: RESOURCE_ID }).strict(),
      output: z
        .object({
          sources: z
            .array(
              z
                .object({
                  source: SOURCE,
                  /**
                   * How the change feed names the source: random, made when first recorded for the
                   * resource, kept until deleted.
                   */
                  source_id: z.string().regex(/^src_[0-9a-f]{32}$/),
                  start: DATE_TIME,
                  end: DATE_TIME,
                  revision: REVISION,
                  observed_at: DATE_TIME,
                  last_error: z.string().max(500).nullable(),
                  last_error_at: DATE_TIME.nullable(),
                  stale: z.boolean(),
                })
                .strict(),
            )
            .max(100),
        })
        .strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getCoverage',
      example: { resource_id: EXAMPLE_RESOURCE_ID },
    },
    {
      name: 'slotlock_record_coverage_failure',
      title: 'Record a failed read of a source',
      description:
        "Record that reading an external calendar failed (it answered 500, a token expired): kept as the source's last error, shown by slotlock_get_coverage, while its coverage stays as it was. 404 coverage_not_found for a source that has never recorded coverage of the resource.",
      method: 'POST',
      path: '/v1/resources/{resource_id}/coverage/{source}/failure',
      input: z.object({ resource_id: RESOURCE_ID, source: SOURCE, error: z.string().min(1).max(500) }).strict(),
      output: z.object({ recorded: z.literal(true) }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'recordCoverageFailure',
      example: { resource_id: EXAMPLE_RESOURCE_ID, source: 'google:fleet@example.com', error: 'HTTP 401 from the calendar API' },
    },
    {
      name: 'slotlock_delete_coverage',
      title: 'Retire a source',
      description:
        "Forget a source's coverage of the resource, for a calendar sync that is disconnected or replaced: free/busy and a resource whose booking rules require certainty stop waiting on it. 404 coverage_not_found for a source with no coverage of the resource.",
      method: 'DELETE',
      path: '/v1/resources/{resource_id}/coverage/{source}',
      input: z.object({ resource_id: RESOURCE_ID, source: SOURCE }).strict(),
      output: z.object({ deleted: z.literal(true) }).strict(),
      risk: { readOnly: false, destructive: true, idempotent: false },
      invoke: 'deleteCoverage',
      example: { resource_id: EXAMPLE_RESOURCE_ID, source: 'google:fleet@example.com' },
    },
    {
      name: 'slotlock_list_tenant_events',
      title: "List a resource's events, every key's",
      description: `The calendar events on one of the tenant's resources with an occurrence in a window of at most ${SLOTLOCK_CALENDAR_HORIZON_DAYS} days, whichever key wrote them (a revoked one's included), by start then id, a page at a time: pass next_cursor as cursor for the next page, until it is null.`,
      method: 'GET',
      path: '/v1/tenant/events',
      input: z
        .object({
          resource_id: RESOURCE_ID,
          start: DATE_TIME,
          end: DATE_TIME,
          limit: PAGE_LIMIT,
          cursor: CURSOR.optional(),
        })
        .strict()
        .refine(boundedWindow, WINDOW_MESSAGE),
      output: z
        .object({ events: z.array(TENANT_EVENT).max(100), next_cursor: NEXT_CURSOR })
        .strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'listTenantEvents',
      example: { resource_id: EXAMPLE_RESOURCE_ID, ...EXAMPLE_WINDOW, limit: 50 },
    },
    {
      name: 'slotlock_get_tenant_event',
      title: 'Get any event of the tenant',
      description:
        "One of the tenant's events by its id (the id slotlock_list_tenant_events gives), whichever key wrote it. A cancelled or unknown one answers 404 event_not_found.",
      method: 'GET',
      path: '/v1/tenant/events/{event_id}',
      input: z.object({ event_id: EVENT_ID }).strict(),
      output: z.object({ event: TENANT_EVENT }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getTenantEvent',
      example: { event_id: EXAMPLE_EVENT_ID },
    },
    {
      name: 'slotlock_export_tenant_event',
      title: 'Export an event as JSCalendar',
      description:
        "One of the tenant's events as a JSCalendar Event (RFC 8984), the JSON form of a calendar event: uid is its id, sequence its revision, start a local time in timeZone with an exact duration, its people participants, its reminders alerts, its recurrence recurrenceRules and recurrenceOverrides (and the RRULE verbatim as slotlock.pylota.io:rrule). A cancelled or unknown one answers 404 event_not_found.",
      method: 'GET',
      path: '/v1/tenant/events/{event_id}/jscalendar',
      input: z.object({ event_id: EVENT_ID }).strict(),
      output: z.object({ event: JSCALENDAR_EVENT }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'exportTenantEvent',
      example: { event_id: EXAMPLE_EVENT_ID },
    },
    {
      name: 'slotlock_cancel_tenant_event',
      title: 'Cancel any event of the tenant',
      description:
        "Cancel one of the tenant's events by its id, whichever key wrote it (a revoked key's included, without charging its quota), at the revision you last read (expected_revision). Its owner cannot create it again. With expected_resource_id, an event since moved to another resource answers 404 event_not_found. Needs an idempotency key (the Idempotency-Key header or idempotency_key): a retry with it answers the first cancellation (replayed: true).",
      method: 'DELETE',
      path: '/v1/tenant/events/{event_id}',
      input: z
        .object({
          event_id: EVENT_ID,
          expected_revision: REVISION,
          expected_resource_id: RESOURCE_ID.optional(),
          // Required, so clients always send it; the Idempotency-Key header may stand in, since the
          // server copies it in before validation.
          idempotency_key: IDEMPOTENCY_KEY,
        })
        .strict(),
      output: z
        .object({
          event_id: EVENT_ID,
          revision: REVISION,
          cancelled: z.literal(true),
          replayed: z.boolean(),
        })
        .strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'cancelTenantEvent',
      example: {
        event_id: EXAMPLE_EVENT_ID,
        expected_revision: 2,
        idempotency_key: 'cancel-3d6f0a2b',
      },
    },
    {
      name: 'slotlock_get_tenant',
      title: 'Get the tenant',
      description:
        "The key's tenant: its reference, and whether it is suspended. A suspended tenant may read and writes nothing (403 tenant_suspended); only the server's operator suspends a tenant or lifts a suspension (slotlock tenant suspend).",
      method: 'GET',
      path: '/v1/tenant',
      input: z.object({}).strict(),
      output: z
        .object({ tenant: z.object({ ref: IDENTITY, suspended: z.boolean() }).strict() })
        .strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getTenant',
      example: {},
    },
    {
      name: 'slotlock_erase_tenant',
      title: 'Erase the tenant',
      description:
        "Delete everything the key's tenant has, at once and for good: resources, holds, bookings, events, coverage and every API key, this one included. confirm_tenant_ref must be the tenant's reference (slotlock_get_tenant), or it answers 400 invalid_confirmation. Off unless the server allows it (403 tenant_erasure_disabled; slotlock serve does not: its operator runs slotlock tenant erase). A suspended tenant cannot erase itself (403 tenant_suspended), nor can one whose hosted plan is still paid for until it is cancelled (409 billing_active). Erasing again deletes nothing.",
      method: 'POST',
      path: '/v1/tenant/erase',
      input: z.object({ confirm_tenant_ref: IDENTITY }).strict(),
      output: z
        .object({
          total: z.number().int().min(0),
          /** Rows deleted, by table. */
          rows: z.record(z.string(), z.number().int().min(0)),
        })
        .strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'eraseTenant',
      example: { confirm_tenant_ref: 'fleet-ops' },
    },
    {
      name: 'slotlock_run_maintenance',
      title: 'Run maintenance',
      description:
        "Extend recurring events to the rolling horizon and prune what the retention window no longer needs, for the caller's tenant. Run it at least daily (slotlock serve does). capped is true when there was more than one call does: call again.",
      method: 'POST',
      path: '/v1/maintenance',
      input: z.object({}).strict(),
      output: z
        .object({
          extended: z.number().int().min(0),
          conflicts: z.number().int().min(0),
          refused: z.number().int().min(0),
          pruned: z.number().int().min(0),
          zone_shifts: z.number().int().min(0),
          stale_sources: z.number().int().min(0),
          no_shows: z.number().int().min(0),
          waitlist_offers: z.number().int().min(0),
          capped: z.boolean(),
        })
        .strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'runMaintenance',
      example: {},
    },
    {
      name: 'slotlock_list_changes',
      title: 'List changes',
      description:
        "What changed in the tenant, oldest first, as CloudEvents: holds made, confirmed, released or expired; bookings made, moved or cancelled; calendar events created, changed or cancelled; resources created, changed (rules, pool, hours), archived, restored or deleted; coverage sources recorded or deleted; webhooks added, enabled or deleted; API keys created, rotated or revoked (ids, times and states, never titles, attendees, URLs or secrets). Each names where it came from (slotlockorigin) and the API key that made it (slotlockkeyid) when recorded. Pass next_cursor as cursor to read on; it is returned even when nothing is new, so poll with it. Only changes of transactions that have ended are listed, so following the cursor never skips one. Changes are kept 30 days: an older cursor answers 410 cursor_expired, so start again without one.",
      method: 'GET',
      path: '/v1/changes',
      input: z
        .object({ cursor: CURSOR.optional(), limit: z.number().int().min(1).max(500).default(100) })
        .strict(),
      output: z.object({ changes: z.array(CHANGE).max(500), next_cursor: z.string().max(500) }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'listChanges',
      example: { limit: 100 },
    },
    {
      name: 'slotlock_create_webhook',
      title: 'Add a webhook',
      description:
        `Send the changes slotlock_list_changes lists from now on to an https URL, each as a CloudEvent signed as Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature), in order, until a 2xx. A failure is retried with backoff; after 24 hours of failures, or a 410, the webhook is disabled and the feed records webhook.disabled. The secret is returned here only. At most ${SLOTLOCK_MAX_WEBHOOK_ENDPOINTS} per tenant, or fewer on a plan (409 webhook_limit_reached). With resource_ids, pools, locations (each with every location in it) or groups, only changes about a resource that matches one of them, as it is when the change is delivered: a change about no resource (a key, a webhook, a usage notice) is not sent. At most ${SLOTLOCK_WEBHOOK_FILTER_RESOURCES} resource ids and ${SLOTLOCK_WEBHOOK_FILTER_REFS} of each other kind (400 invalid_webhook_filter). With an idempotency key (the Idempotency-Key header or idempotency_key), a retry answers the webhook and secret the first request made (replayed: true) for as long as the webhook is kept; the same key with another request is 422 idempotency_conflict.`,
      method: 'POST',
      path: '/v1/webhooks',
      input: z
        .object({
          url: z.string().url().max(2048),
          event_types: z.array(z.enum(SLOTLOCK_CHANGE_TYPES)).min(1).max(SLOTLOCK_CHANGE_TYPES.length).optional(),
          resource_ids: z.array(z.string().uuid()).min(1).max(SLOTLOCK_WEBHOOK_FILTER_RESOURCES).optional(),
          pools: z.array(GROUPING_REF).min(1).max(SLOTLOCK_WEBHOOK_FILTER_REFS).optional(),
          locations: z.array(GROUPING_REF).min(1).max(SLOTLOCK_WEBHOOK_FILTER_REFS).optional(),
          groups: z.array(GROUPING_REF).min(1).max(SLOTLOCK_WEBHOOK_FILTER_REFS).optional(),
          idempotency_key: IDEMPOTENCY_KEY.optional(),
        })
        .strict(),
      output: z.object({ webhook: WEBHOOK, secret: z.string().regex(/^whsec_/), replayed: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'createWebhook',
      example: { url: 'https://example.com/slotlock-webhook', event_types: ['reservation.created'] },
    },
    {
      name: 'slotlock_list_webhooks',
      title: 'List webhooks',
      description: "The tenant's webhooks with how delivery is going: failed attempts, the last status, and whether and why one is disabled.",
      method: 'GET',
      path: '/v1/webhooks',
      input: z.object({}).strict(),
      output: z.object({ webhooks: z.array(WEBHOOK).max(SLOTLOCK_MAX_WEBHOOK_ENDPOINTS) }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'listWebhooks',
      example: {},
    },
    {
      name: 'slotlock_delete_webhook',
      title: 'Delete a webhook',
      description: 'Stop sending to a webhook. deleted is false when the tenant has no such webhook.',
      method: 'DELETE',
      path: '/v1/webhooks/{webhook_id}',
      input: z.object({ webhook_id: z.string().uuid() }).strict(),
      output: z.object({ deleted: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'deleteWebhook',
      example: { webhook_id: '9b2f4c1e-6d3a-4e8b-a1c7-5f0e2d4b6a8c' },
    },
    {
      name: 'slotlock_enable_webhook',
      title: 'Enable a webhook',
      description: 'Send to a disabled webhook again, from the first change it did not accept. 404 webhook_not_found when the tenant has no such webhook; 409 changes_pruned when what it missed is older than the 30 days the feed keeps, since it would skip those unseen: delete it, add it again, and read what it missed from slotlock_list_changes.',
      method: 'POST',
      path: '/v1/webhooks/{webhook_id}/enable',
      input: z.object({ webhook_id: z.string().uuid() }).strict(),
      output: z.object({ webhook: WEBHOOK }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'enableWebhook',
      example: { webhook_id: '9b2f4c1e-6d3a-4e8b-a1c7-5f0e2d4b6a8c' },
    },
    {
      name: 'slotlock_get_usage',
      title: 'Read usage',
      description:
        "How much the tenant used the service from one UTC day to another (inclusive, at most 400 days apart; by default the first of this month to today): operations its keys and the dashboard assistant ran (each call that reached its operation, whatever it returned), bookings (bookings, events and confirmed holds) and holds it made, webhook deliveries its endpoints accepted, messages to the dashboard assistant, and the resources it held (each day's count, archived ones included; in totals, the last day's, not a sum). Totals, then by day, by API key (key_id null for none) and by surface (mcp, a2a, rest, application, dashboard-assistant, webhooks); resources are by day only. Counts only, never what was asked. Empty unless the server meters usage (SLOTLOCK_USAGE=on); operations, deliveries and messages appear within 15 seconds; bookings, holds and resources within the hour. 400 invalid_usage_range when to is before from, the range is longer than 400 days, or to is after today.",
      method: 'GET',
      path: '/v1/usage',
      input: z.object({ from: USAGE_DAY.optional(), to: USAGE_DAY.optional() }).strict(),
      output: z
        .object({
          from: USAGE_DAY,
          to: USAGE_DAY,
          totals: z.object(USAGE_TOTALS).strict(),
          days: z.array(z.object({ day: USAGE_DAY, ...USAGE_TOTALS }).strict()).max(401),
          keys: z
            .array(z.object({ key_id: z.string().uuid().nullable(), ...USAGE_TOTALS }).strict())
            .max(1001),
          surfaces: z.array(z.object({ origin: z.string().min(1).max(40), ...USAGE_TOTALS }).strict()).max(20),
        })
        .strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getUsage',
      example: { from: '2026-11-01', to: '2026-11-30' },
    },
    // The partner API (RFC 0003 P3): a partner key's, for that partner's own accounts only.
    {
      name: 'slotlock_partner_put_account',
      title: 'Create or update an account',
      description:
        "Create the partner's account with this id (your own id for your user, 1-128 letters, digits, dots, dashes or underscores), or put it on another plan: one of your contract's, whose limits and monthly quotas the account then has. Its tenant is partner:<partner>:<account>, an ordinary Slotlock tenant of its own. Repeating the call changes nothing more. 400 invalid_partner_plan for a plan your contract does not have.",
      method: 'PUT',
      path: '/v1/partner/accounts/{account}',
      input: z.object({ account: PARTNER_ACCOUNT, plan: PARTNER_PLAN_NAME }).strict(),
      output: z.object({ account: PARTNER_ACCOUNT_OUTPUT, created: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'partnerPutAccount',
      scope: 'partner',
      example: { account: 'user-4821', plan: 'partner_pro' },
    },
    {
      name: 'slotlock_partner_list_accounts',
      title: 'List accounts',
      description: "The partner's accounts, by id: plan, whether suspended, and when made and last changed.",
      method: 'GET',
      path: '/v1/partner/accounts',
      input: z.object({}).strict(),
      output: z.object({ accounts: z.array(PARTNER_ACCOUNT_OUTPUT).max(10000) }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'partnerListAccounts',
      scope: 'partner',
      example: {},
    },
    {
      name: 'slotlock_partner_get_account',
      title: 'Read an account',
      description:
        'One of the partner\'s accounts, with how many resources (archived ones included) and active API keys it holds. 404 account_not_found for an account the partner does not have.',
      method: 'GET',
      path: '/v1/partner/accounts/{account}',
      input: z.object({ account: PARTNER_ACCOUNT }).strict(),
      output: z.object({ account: PARTNER_ACCOUNT_OUTPUT }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'partnerGetAccount',
      scope: 'partner',
      example: { account: 'user-4821' },
    },
    {
      name: 'slotlock_partner_list_keys',
      title: "List an account's keys",
      description: "The account's API keys, revoked and expired ones included, newest first; never the keys themselves.",
      method: 'GET',
      path: '/v1/partner/accounts/{account}/keys',
      input: z.object({ account: PARTNER_ACCOUNT, environment: PARTNER_ENVIRONMENT }).strict(),
      output: z.object({ keys: z.array(PARTNER_KEY_OUTPUT).max(1000) }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'partnerListKeys',
      scope: 'partner',
      example: { account: 'user-4821' },
    },
    {
      name: 'slotlock_partner_create_key',
      title: 'Create a key for an account',
      description:
        "An API key for the account, shown once in key and never again; only its SHA-256 is kept. Give it to your user's calls: it acts in the account's tenant, over MCP, A2A and REST, as any key. environment: test makes it in the account's test environment instead (a tenant of its own, on the same plan, never billed; its keys start slk_test_). scopes: some of the ones your contract allows (read and write unless it says), by default all of them; expires_in_days: 1-3650, or none. 403 scope_not_in_contract for another scope; 409 api_key_limit_reached past the account plan's keys.",
      method: 'POST',
      path: '/v1/partner/accounts/{account}/keys',
      input: z
        .object({
          account: PARTNER_ACCOUNT,
          name: z.string().trim().min(1).max(100),
          scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1).max(3).optional(),
          expires_in_days: z.number().int().min(1).max(3650).optional(),
          environment: PARTNER_ENVIRONMENT,
        })
        .strict(),
      output: z.object({ key: ACCOUNT_KEY, api_key: PARTNER_KEY_OUTPUT }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: false },
      invoke: 'partnerCreateKey',
      scope: 'partner',
      example: { account: 'user-4821', name: 'Booking agent' },
    },
    {
      name: 'slotlock_partner_rotate_key',
      title: "Rotate an account's key",
      description:
        'A new secret for one of the account\'s active keys, shown once; the old one stops at once. The key keeps its id and what it booked. 404 key_not_found otherwise.',
      method: 'POST',
      path: '/v1/partner/accounts/{account}/keys/{key_id}/rotate',
      input: z.object({ account: PARTNER_ACCOUNT, key_id: z.string().uuid(), environment: PARTNER_ENVIRONMENT }).strict(),
      output: z.object({ key: ACCOUNT_KEY, api_key: PARTNER_KEY_OUTPUT }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: false },
      invoke: 'partnerRotateKey',
      scope: 'partner',
      example: { account: 'user-4821', key_id: '7d1e4f8a-2b3c-4d5e-8f90-123456789abc' },
    },
    {
      name: 'slotlock_partner_revoke_key',
      title: "Revoke an account's key",
      description: "Revoke one of the account's keys at once; revoking it again changes nothing. 404 key_not_found otherwise.",
      method: 'DELETE',
      path: '/v1/partner/accounts/{account}/keys/{key_id}',
      input: z.object({ account: PARTNER_ACCOUNT, key_id: z.string().uuid(), environment: PARTNER_ENVIRONMENT }).strict(),
      output: z.object({ api_key: PARTNER_KEY_OUTPUT }).strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'partnerRevokeKey',
      scope: 'partner',
      example: { account: 'user-4821', key_id: '7d1e4f8a-2b3c-4d5e-8f90-123456789abc' },
    },
    {
      name: 'slotlock_partner_suspend_account',
      title: 'Suspend an account',
      description:
        'Suspend the account, as slotlock tenant suspend: it may read, and writes nothing; its keys get no new secret. suspended says whether it was not suspended already.',
      method: 'POST',
      path: '/v1/partner/accounts/{account}/suspend',
      input: z.object({ account: PARTNER_ACCOUNT, reason: z.string().trim().min(1).max(200).optional() }).strict(),
      output: z.object({ suspended: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'partnerSuspendAccount',
      scope: 'partner',
      example: { account: 'user-4821', reason: 'unpaid' },
    },
    {
      name: 'slotlock_partner_unsuspend_account',
      title: 'Lift a suspension',
      description:
        'Lift a suspension the partner made. One Pylota made stays: unsuspended is false then, as when the account was not suspended.',
      method: 'POST',
      path: '/v1/partner/accounts/{account}/unsuspend',
      input: z.object({ account: PARTNER_ACCOUNT }).strict(),
      output: z.object({ unsuspended: z.boolean() }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'partnerUnsuspendAccount',
      scope: 'partner',
      example: { account: 'user-4821' },
    },
    {
      name: 'slotlock_partner_erase_account',
      title: 'Erase an account',
      description:
        "Erase the account's tenant, every row it owns, as /v1/tenant/erase, and the partner's record of it. confirm repeats the account. Cannot be undone.",
      method: 'POST',
      path: '/v1/partner/accounts/{account}/erase',
      input: z.object({ account: PARTNER_ACCOUNT, confirm: PARTNER_ACCOUNT }).strict(),
      output: z.object({ erased: z.boolean(), rows: z.number().int().min(0) }).strict(),
      risk: { readOnly: false, destructive: true, idempotent: true },
      invoke: 'partnerEraseAccount',
      scope: 'partner',
      example: { account: 'user-4821', confirm: 'user-4821' },
    },
    {
      name: 'slotlock_partner_get_usage',
      title: "Read the accounts' usage",
      description:
        "The partner's accounts' usage, the counts Pylota invoices from, by account, UTC day and metric (operations, bookings, holds, webhook_deliveries, resources: each day's count), from one UTC day to another (inclusive, at most 400 days apart; by default this month); one account, or all. 400 invalid_usage_range otherwise.",
      method: 'GET',
      path: '/v1/partner/usage',
      input: z.object({ from: USAGE_DAY.optional(), to: USAGE_DAY.optional(), account: PARTNER_ACCOUNT.optional() }).strict(),
      output: z
        .object({
          from: USAGE_DAY,
          to: USAGE_DAY,
          usage: z
            .array(z.object({ account: PARTNER_ACCOUNT, day: USAGE_DAY, metric: z.string().min(1).max(40), count: USAGE_COUNT }).strict())
            .max(500000),
        })
        .strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'partnerGetUsage',
      scope: 'partner',
      example: { from: '2026-11-01', to: '2026-11-30' },
    },
    {
      name: 'slotlock_partner_reconcile_usage',
      title: 'Compare your counts with ours',
      description:
        "Send your count of each account's operations (and, if you keep them, bookings) on one ended UTC day, as your daily cross-check: the answer gives ours beside yours for every account either of us counted, the difference in percent, and whether every one is within 0.5%. A day outside that is recorded as a mismatch, which Pylota looks into. Sending the same day again replaces its record.",
      method: 'POST',
      path: '/v1/partner/usage/reconcile',
      input: z
        .object({
          day: USAGE_DAY,
          accounts: z
            .array(z.object({ account: PARTNER_ACCOUNT, operations: USAGE_COUNT, bookings: USAGE_COUNT.optional() }).strict())
            .max(10000),
        })
        .strict(),
      output: z
        .object({
          day: USAGE_DAY,
          within_tolerance: z.boolean(),
          tolerance_percent: z.number(),
          accounts: z
            .array(
              z
                .object({
                  account: PARTNER_ACCOUNT,
                  metric: z.enum(['operations', 'bookings']),
                  ours: USAGE_COUNT,
                  theirs: USAGE_COUNT.nullable(),
                  difference_percent: z.number().nullable(),
                })
                .strict(),
            )
            .max(20000),
        })
        .strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'partnerReconcileUsage',
      scope: 'partner',
      example: { day: '2026-11-09', accounts: [{ account: 'user-4821', operations: 1204 }] },
    },
  ]);

const BY_NAME = new Map(
  SLOTLOCK_APPLICATION_OPERATIONS.map((operation) => [operation.name, operation]),
);

export function isSlotlockApplicationOperation(
  name: unknown,
): name is SlotlockApplicationOperation {
  return typeof name === 'string' && BY_NAME.has(name as SlotlockApplicationOperation);
}

export function slotlockApplicationOperation(
  name: SlotlockApplicationOperation,
): SlotlockApplicationOperationDefinition {
  return BY_NAME.get(name) as SlotlockApplicationOperationDefinition;
}
