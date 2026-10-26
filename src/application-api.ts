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
  | 'slotlock_acquire_hold'
  | 'slotlock_get_hold'
  | 'slotlock_list_holds'
  | 'slotlock_confirm_hold'
  | 'slotlock_release_hold'
  | 'slotlock_get_reservation'
  | 'slotlock_list_reservations'
  | 'slotlock_put_reservation'
  | 'slotlock_cancel_reservation'
  | 'slotlock_record_coverage'
  | 'slotlock_list_tenant_events'
  | 'slotlock_get_tenant_event'
  | 'slotlock_cancel_tenant_event'
  | 'slotlock_get_tenant'
  | 'slotlock_erase_tenant'
  | 'slotlock_run_maintenance';

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
  acquireHold: Handler;
  getHold: Handler;
  listHolds: Handler;
  confirmHold: Handler;
  releaseHold: Handler;
  getReservation: Handler;
  listReservations: Handler;
  putReservation: Handler;
  cancelReservation: Handler;
  recordCoverage: Handler;
  listTenantEvents: Handler;
  getTenantEvent: Handler;
  cancelTenantEvent: Handler;
  getTenant: Handler;
  eraseTenant: Handler;
  runMaintenance: Handler;
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
 * request is 409 idempotency_conflict.
 */
const IDEMPOTENCY_KEY = IDENTITY.describe(
  'A retry identity, also accepted as the Idempotency-Key header: the same key with the same request answers what the first did; with another request, 409 idempotency_conflict.',
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

const RESOURCE = z
  .object({
    id: RESOURCE_ID,
    external_ref: z.string().max(500).nullable(),
    timezone: TIMEZONE,
    /** The resource's own weekly hours; `null` when it uses the default. */
    availability: AVAILABILITY_RULES.nullable(),
    /** `private` resources are never shown to agents; fixed when the resource is created. */
    visibility: VISIBILITY,
    /** When it was archived; `null` while it is in use. */
    archived_at: DATE_TIME.nullable(),
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
        'Occupy a window without booking it, for example while a customer pays. The hold blocks every other booking until it expires (the database clock, ttl_seconds from now), is confirmed, or is released. buffer_after_minutes keeps the time after it busy as well, and a confirmed hold keeps it. A taken window answers 409 overlap. With an idempotency key (the Idempotency-Key header or idempotency_key), a retry answers the hold the first request made, until that hold would have expired, is released or is confirmed; the same key with another request is 409 idempotency_conflict.',
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
          capped: z.boolean(),
        })
        .strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'runMaintenance',
      example: {},
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
