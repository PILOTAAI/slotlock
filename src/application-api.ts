// The application API: what an application, rather than an agent, does over HTTP that the TypeScript
// store does in process. It creates resources and sets their bookable hours, holds and reserves time,
// records how much of an external calendar it has read, reaches any of the tenant's events whichever
// key wrote them, erases the tenant when allowed, and runs maintenance. Any language can call it.
//
// The agent server serves these operations as REST under /v1, beside the agent tools, when it is
// given an `application` backend and `rest` is on, and describes them in the same OpenAPI document.
// They need the `admin` scope. They are never MCP tools or A2A skills: no agent is offered them.
//
// This module holds only the contract (names, schemas, routes); it imports nothing from the agent
// server at runtime. The store-backed implementation is createSlotlockStoreApplicationBackend.
import { SLOTLOCK_CHANGE_TYPES } from './event-feed.js';
import { z } from 'zod';
import type { SlotlockAgentPrincipal } from './agent-server.js';
import { SLOTLOCK_EVENT_OUTPUT } from './event-schema.js';
import type { SlotlockTraceContext } from './mcp-modern.js';
import { SLOTLOCK_CALENDAR_HORIZON_DAYS } from './rules.js';

export type SlotlockApplicationOperation =
  | 'slotlock_create_resource'
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
  | 'slotlock_list_pools'
  | 'slotlock_get_resource_history'
  | 'slotlock_get_coverage'
  | 'slotlock_record_coverage_failure'
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
  | 'slotlock_enable_webhook';

/** The scope an application operation needs, whichever operation it is. */
export const SLOTLOCK_APPLICATION_SCOPE = 'admin';

export interface SlotlockApplicationInvocationContext {
  principal: SlotlockAgentPrincipal;
  operation: SlotlockApplicationOperation;
  signal: AbortSignal;
  /** W3C trace context the caller sent, already validated. */
  trace?: SlotlockTraceContext;
}

type Handler = (
  context: SlotlockApplicationInvocationContext,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * What serves the application operations. Every method receives the input its operation's schema
 * accepted, and returns what its output schema describes; a refusal is a thrown
 * `SlotlockAgentOperationError`. The tenant is the principal's, never an argument.
 */
export interface SlotlockApplicationBackend {
  createResource: Handler;
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
  listPools: Handler;
  getResourceHistory: Handler;
  getCoverage: Handler;
  recordCoverageFailure: Handler;
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
}

export interface SlotlockApplicationOperationDefinition {
  name: SlotlockApplicationOperation;
  title: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Relative to the server's base URL; `{name}` is one path segment, an input of that name. */
  path: string;
  input: z.ZodType<Record<string, unknown>>;
  output: z.ZodType<Record<string, unknown>>;
  risk: { readOnly: boolean; destructive: boolean; idempotent: boolean };
  invoke: keyof SlotlockApplicationBackend;
  /** Valid input, path parameters included (a test runs each against the schema). */
  example: Record<string, unknown>;
}

const DATE_TIME = z.string().datetime({ offset: true });
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
 * A retry identity, as the `Idempotency-Key` request header or this field (the same value, if both
 * are sent): the same key with the same request answers what the first did, and with another
 * request is 422 idempotency_conflict.
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
    turnaround_minutes: z.number().int().min(0).max(1_440).optional(),
    enforce_hours: z.boolean().optional(),
    check_in_minutes: z.number().int().min(1).max(1_440).optional(),
  })
  .strict();

const POOL = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);

const RESOURCE = z
  .object({
    id: RESOURCE_ID,
    external_ref: z.string().max(500).nullable(),
    timezone: TIMEZONE,
    /** The resource's own weekly hours; `null` when it uses the default. */
    availability: AVAILABILITY_RULES.nullable(),
    /** What a booking on it must satisfy; `null` when it has no rules. */
    booking_rules: BOOKING_RULES.nullable(),
    /** `private` resources are never shown to agents; fixed when the resource is created. */
    visibility: VISIBILITY,
    /** When it was archived; `null` while it is in use. */
    archived_at: DATE_TIME.nullable(),
    /** The pool it is a member of (a vehicle class, a room type); `null` when none. */
    pool: POOL.nullable(),
  })
  .strict();

const HISTORY_ENTRY = z
  .object({
    id: z.string().max(40),
    type: z.string().max(100),
    time: DATE_TIME,
    /** Who made it: an API key, an agent's subject; `null` when not recorded. */
    actor: z.string().max(200).nullable(),
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

/**
 * Any of the tenant's events, whichever key wrote it: `id` is the store's id for it, which the
 * tenant-event routes take, `event_ref` the id its owner reads it by, and `owner_ref` who that is
 * (`internal` for the tenant's own code, `agent:<digest>` for an API key).
 */
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
        'Create the resource with this external reference, or update its time zone if the tenant already has it. Repeating the call changes nothing more. visibility is shared (the default: agents list and book it) or private (agents never see it), fixed at creation: naming another for an existing resource answers 409 resource_visibility_conflict.',
      method: 'POST',
      path: '/v1/resources',
      input: z
        .object({
          external_ref: IDENTITY,
          timezone: TIMEZONE.default('UTC'),
          visibility: VISIBILITY.optional(),
        })
        .strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'createResource',
      example: { external_ref: 'vehicle-42', timezone: 'Europe/London' },
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
        "Set what a booking on one resource must satisfy from now on: minimum notice, how far ahead, the step starts fall on (from local midnight in the resource's time zone), the turnaround kept free after each booking, and whether bookings must lie inside its hours. `null` clears them. Holds, reservations, moves and agents' events are refused with the rule they break; searches offer only what they allow.",
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
      name: 'slotlock_list_pools',
      title: 'List pools',
      description: "The tenant's pools by name, each with its capacity: how many members it has that are not archived.",
      method: 'GET',
      path: '/v1/pools',
      input: z.object({}).strict(),
      output: z
        .object({ pools: z.array(z.object({ pool: POOL, capacity: z.number().int().min(1) }).strict()).max(1000) })
        .strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'listPools',
      example: {},
    },
    {
      name: 'slotlock_get_resource_history',
      title: "A resource's history",
      description:
        "What happened on one of the tenant's resources, newest first: each hold, booking and event made, moved, confirmed, released or cancelled, when, by whom (the API key or agent), and for a change what it was before. Kept 30 days. Pass next_before as before for older entries.",
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
          // Last: a generated client's 0.2.0 positional arguments keep their places.
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
        "Wait for a window on one resource (resource_id) or on any member of a pool (pool) that is taken now. When it comes free (a booking cancelled, a hold released or expired, a no-show), the entries waiting for it are offered in the order they joined: the first gets a hold of it for holder_ref, for offer_ttl_seconds (default 900), and the feed says so (waitlist.offered, with hold_id): confirm the hold to book it. An entry whose window starts first expires (waitlist.expired). A holder may wait for 20 windows at once (409 waitlist_limit_reached); a window is at most 31 days.",
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
        })
        .strict()
        .refine((input) => (input.resource_id === undefined) !== (input.pool === undefined), {
          message: 'Name resource_id or pool, not both',
        }),
      output: z.object({ entry: WAITLIST_ENTRY }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: false },
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
        "Each external calendar (source) that records coverage of a resource: the window it covers, when it was last read, its last error, and whether it is stale (not read for a day, so the time it covers is unproven, not free). A source that goes stale is also put on the change feed once, as coverage.stale, until it is read again.",
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
          // Required, so a client always sends it; the Idempotency-Key header may stand in for
          // it, since the server reads the header into it before the schema checks the request.
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
        "Delete everything the key's tenant has, at once and for good: resources, holds, bookings, events, coverage and every API key, this one included. confirm_tenant_ref must be the tenant's reference (slotlock_get_tenant), or it answers 400 invalid_confirmation. Off unless the server allows it (403 tenant_erasure_disabled; slotlock serve does not: its operator runs slotlock tenant erase). A suspended tenant cannot erase itself (403 tenant_suspended). Erasing again deletes nothing.",
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
        "What changed in the tenant, oldest first, as CloudEvents: holds made, confirmed, released or expired; bookings made, moved or cancelled; calendar events created, changed or cancelled (ids, times and states, never titles or attendees). Pass next_cursor as cursor to read on; it is returned even when nothing is new, so poll with it. Only changes of transactions that have ended are listed, so following the cursor never skips one. Changes are kept 30 days: an older cursor answers 410 cursor_expired, so start again without one.",
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
        'Send the changes slotlock_list_changes lists from now on to an https URL, each as a CloudEvent signed as Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature), in order, until a 2xx. A failure is retried with backoff; after 24 hours of failures, or a 410, the webhook is disabled and the feed records webhook.disabled. The secret is returned here only. At most 10 per tenant.',
      method: 'POST',
      path: '/v1/webhooks',
      input: z
        .object({
          url: z.string().url().max(2048),
          event_types: z.array(z.enum(SLOTLOCK_CHANGE_TYPES)).min(1).max(20).optional(),
        })
        .strict(),
      output: z.object({ webhook: WEBHOOK, secret: z.string().regex(/^whsec_/) }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: false },
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
      output: z.object({ webhooks: z.array(WEBHOOK).max(10) }).strict(),
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
