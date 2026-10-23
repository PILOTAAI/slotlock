// The application API: what an application, rather than an agent, does over HTTP that the TypeScript
// store does in process. It creates resources and sets their bookable hours, holds and reserves time,
// records how much of an external calendar it has read, and runs maintenance. Any language can call it.
//
// The agent server serves these operations as REST under /v1, beside the agent tools, when it is
// given an `application` backend and `rest` is on, and describes them in the same OpenAPI document.
// They need the `admin` scope. They are never MCP tools or A2A skills: no agent is offered them.
//
// This module holds only the contract (names, schemas, routes); it imports nothing from the agent
// server at runtime. The store-backed implementation is createSlotlockStoreApplicationBackend.
import { z } from 'zod';
import type { SlotlockAgentPrincipal } from './agent-server.js';
import type { SlotlockTraceContext } from './mcp-modern.js';

export type SlotlockApplicationOperation =
  | 'slotlock_create_resource'
  | 'slotlock_get_resource'
  | 'slotlock_set_resource_availability'
  | 'slotlock_set_tenant_availability'
  | 'slotlock_acquire_hold'
  | 'slotlock_confirm_hold'
  | 'slotlock_release_hold'
  | 'slotlock_put_reservation'
  | 'slotlock_cancel_reservation'
  | 'slotlock_record_coverage'
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
  setResourceAvailability: Handler;
  setTenantAvailability: Handler;
  acquireHold: Handler;
  confirmHold: Handler;
  releaseHold: Handler;
  putReservation: Handler;
  cancelReservation: Handler;
  recordCoverage: Handler;
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

const EXAMPLE_RESOURCE_ID = '0f8b6c1e-2d4a-4c7e-9b1a-3e5f7a9c2d4b';
const EXAMPLE_HOLD_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const EXAMPLE_RULES = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', start_minutes: 540, duration_minutes: 480 },
];

export const SLOTLOCK_APPLICATION_OPERATIONS: readonly SlotlockApplicationOperationDefinition[] =
  Object.freeze([
    {
      name: 'slotlock_create_resource',
      title: 'Create or update a resource',
      description:
        'Create the resource with this external reference, or update its time zone if the tenant already has it. Repeating the call changes nothing more.',
      method: 'POST',
      path: '/v1/resources',
      input: z.object({ external_ref: IDENTITY, timezone: TIMEZONE.default('UTC') }).strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: false, destructive: false, idempotent: true },
      invoke: 'createResource',
      example: { external_ref: 'vehicle-42', timezone: 'Europe/London' },
    },
    {
      name: 'slotlock_get_resource',
      title: 'Get a resource',
      description: 'One resource of the tenant, with its own weekly bookable hours.',
      method: 'GET',
      path: '/v1/resources/{resource_id}',
      input: z.object({ resource_id: RESOURCE_ID }).strict(),
      output: z.object({ resource: RESOURCE }).strict(),
      risk: { readOnly: true, destructive: false, idempotent: true },
      invoke: 'getResource',
      example: { resource_id: EXAMPLE_RESOURCE_ID },
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
        'Occupy a window without booking it, for example while a customer pays. The hold blocks every other booking until it expires (the database clock, ttl_seconds from now), is confirmed, or is released. A taken window answers 409 overlap.',
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
      },
    },
    {
      name: 'slotlock_confirm_hold',
      title: 'Confirm a hold',
      description:
        'Turn an unexpired hold into a confirmed reservation. Confirming it again answers the same reservation, so a retry is safe. An expired hold answers 409 hold_expired; a released or unknown one, 404 hold_not_found.',
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
          buffer_after_minutes: z
            .number()
            .int()
            .min(0)
            .max(30 * 24 * 60)
            .default(0),
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
