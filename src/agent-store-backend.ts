import { createHash } from 'node:crypto';
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentInvocationContext,
  SlotlockAgentOperationError,
} from './agent-server.js';
import type {
  SlotlockApplicationBackend,
  SlotlockApplicationInvocationContext,
} from './application-api.js';
import { findNextAvailable } from './engine.js';
import { expandRules } from './rules.js';
import { type SlotlockStore, type SlotlockTenantStore, calendarEventRollingHorizon } from './store.js';
import type {
  CalendarAttendee,
  CalendarEventContent,
  CalendarRecurrence,
  CalendarRecurrenceException,
  CalendarReminder,
  Interval,
  SlotlockCalendarEvent,
  SlotlockHold,
  SlotlockReservation,
  SlotlockResource,
  WeeklyAvailabilityRule,
} from './types.js';
import { maintainSlotlockTenant } from './maintenance.js';
import { parseAvailabilityRules } from './weekly-hours.js';

export interface SlotlockStoreAgentBackendOptions {
  /**
   * The default bookable hours, for resources without hours of their own
   * (`SlotlockResource.availabilityRules`, which win). No rules means no slot, never 24x7.
   */
  availabilityRules(
    context: SlotlockAgentInvocationContext,
    resource: SlotlockResource,
  ): Promise<WeeklyAvailabilityRule[]>;
  /** Provider sources that must prove complete coverage before availability is called certain. */
  requiredCoverageSources?(
    context: SlotlockAgentInvocationContext,
    resource: SlotlockResource,
  ): Promise<readonly string[]>;
  coverageMaxAgeMs?: number;
}

interface AgentAttendeeInput {
  address: string;
  name?: string;
  role: CalendarAttendee['role'];
  participation_status: CalendarAttendee['participationStatus'];
  rsvp?: boolean;
}

interface AgentReminderInput {
  minutes_before: number;
  channel: CalendarReminder['action'];
}

interface AgentRecurrenceExceptionInput {
  recurrence_id: string;
  cancelled?: boolean;
  starts_at?: string;
  ends_at?: string;
}

interface AgentEventInput {
  resource_id: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  title?: string | null;
  description?: string | null;
  location?: string | null;
  organizer?: { address: string; name?: string } | null;
  attendees?: AgentAttendeeInput[];
  reminders?: AgentReminderInput[];
  transparency?: CalendarEventContent['transparency'];
  status?: CalendarEventContent['status'];
  recurrence_rule?: string | null;
  recurrence_exceptions?: AgentRecurrenceExceptionInput[];
  idempotency_key: string;
}

/**
 * A write runs under READ COMMITTED whatever the role's default: a store given tenant limits (as
 * `slotlock serve`'s is) counts it against them under the tenant's lock, which needs that level,
 * and refuses it otherwise.
 */
const WRITE = { isolation: 'read committed' } as const;

/** What tenant scoping needs of an agent or application call. */
interface TenantCallContext {
  principal: { tenantRef: string };
  signal: AbortSignal;
}

function assertActive(context: TenantCallContext): void {
  if (context.signal.aborted) throw new SlotlockAgentOperationError('request_aborted', 503);
}

async function withTenant<T>(
  store: SlotlockStore,
  context: TenantCallContext,
  callback: (tenantStore: SlotlockTenantStore) => Promise<T>,
  options?: { isolation?: 'read committed' },
): Promise<T> {
  assertActive(context);
  let value: T;
  try {
    value =
      options === undefined
        ? await store.withTenant(context.principal.tenantRef, callback)
        : await store.withTenant(context.principal.tenantRef, callback, options);
  } catch (error) {
    // A suspended tenant may read; a write it asks for is forbidden, not a server failure.
    if ((error as { code?: unknown } | null)?.code === 'tenant_suspended') {
      throw new SlotlockAgentOperationError('tenant_suspended', 403);
    }
    throw error;
  }
  assertActive(context);
  return value;
}

/**
 * Busy intervals one free/busy read or search may gather across all the resources it names: as many
 * as the store reads for one resource. Without it, a request naming 100 resources at that limit, or
 * one resource 100 times, did 100 times the work of one.
 */
const MAX_REQUEST_BUSY_INTERVALS = 10_000;

/** The resources a request names, each once, in the order first named. */
function distinctResourceIds(input: Record<string, unknown>): string[] {
  return [...new Set(input.resource_ids as string[])];
}

/** Counts a request's busy intervals against MAX_REQUEST_BUSY_INTERVALS, refusing past it. */
function busyBudget(): (intervals: number) => void {
  let left = MAX_REQUEST_BUSY_INTERVALS;
  return (intervals) => {
    left -= intervals;
    if (left < 0) throw new SlotlockAgentOperationError('calendar_work_limit', 400);
  };
}

/** The store's free/busy read, its refusal to read past its limit answered as the caller's to narrow. */
async function readFreeBusy(
  tenantStore: SlotlockTenantStore,
  params: Parameters<SlotlockTenantStore['getFreeBusy']>[0],
): Promise<Awaited<ReturnType<SlotlockTenantStore['getFreeBusy']>>> {
  try {
    return await tenantStore.getFreeBusy(params);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'calendar_work_limit') {
      throw new SlotlockAgentOperationError('calendar_work_limit', 400);
    }
    throw error;
  }
}

function interval(input: { start: string; end: string }): Interval {
  return { start: new Date(input.start), end: new Date(input.end) };
}

function requiredSources(
  options: SlotlockStoreAgentBackendOptions,
  context: SlotlockAgentInvocationContext,
  resource: SlotlockResource,
): Promise<readonly string[]> {
  return options.requiredCoverageSources?.(context, resource) ?? Promise.resolve([]);
}

function coverageProjection(window: Interval, complete: boolean) {
  return {
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    certainty: complete ? ('certain' as const) : ('uncertain' as const),
    reason: complete ? null : 'coverage_incomplete',
  };
}

function attendeesFromInput(value: AgentAttendeeInput[] | undefined): CalendarAttendee[] {
  return (value ?? []).map((attendee) => ({
    email: attendee.address,
    ...(attendee.name !== undefined ? { name: attendee.name } : {}),
    ...(attendee.role !== undefined ? { role: attendee.role } : {}),
    ...(attendee.participation_status !== undefined
      ? { participationStatus: attendee.participation_status }
      : {}),
    ...(attendee.rsvp !== undefined ? { rsvp: attendee.rsvp } : {}),
  }));
}

function remindersFromInput(value: AgentReminderInput[] | undefined): CalendarReminder[] {
  return (value ?? []).map((reminder) => ({
    action: reminder.channel,
    minutesBeforeStart: reminder.minutes_before,
  }));
}

function exceptionsFromInput(
  value: AgentRecurrenceExceptionInput[] | undefined,
): CalendarRecurrenceException[] {
  return (value ?? []).map((exception) => ({
    recurrenceId: new Date(exception.recurrence_id),
    ...(exception.cancelled !== undefined ? { cancelled: exception.cancelled } : {}),
    ...(exception.starts_at !== undefined ? { start: new Date(exception.starts_at) } : {}),
    ...(exception.ends_at !== undefined ? { end: new Date(exception.ends_at) } : {}),
  }));
}

function recurrenceFromInput(
  rule: string | null | undefined,
  exceptions: AgentRecurrenceExceptionInput[] | undefined,
): CalendarRecurrence | undefined {
  if (rule === undefined || rule === null) return undefined;
  return {
    rrule: rule,
    ...(exceptions !== undefined ? { exceptions: exceptionsFromInput(exceptions) } : {}),
  };
}

function materializationWindow(
  content: Pick<CalendarEventContent, 'start' | 'end' | 'recurrence'>,
) {
  if (!content.recurrence) return { start: content.start, end: content.end };
  return calendarEventRollingHorizon();
}

function eventSummary(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : 'Busy';
}

function agentPrincipalDigest(
  context: SlotlockAgentInvocationContext,
  idempotencyKey: string,
): string {
  return createHash('sha256')
    .update(`${context.principal.tenantRef}\0${context.principal.subject}\0${idempotencyKey}`)
    .digest('hex');
}

function agentOwnerRef(context: SlotlockAgentInvocationContext): string {
  return `agent:${createHash('sha256')
    .update(`${context.principal.tenantRef}\0${context.principal.subject}`)
    .digest('hex')}`;
}

function agentExternalRef(context: SlotlockAgentInvocationContext, idempotencyKey: string): string {
  // This format is already a stable client-visible identity; keep it unchanged.
  return `agent:${agentPrincipalDigest(context, idempotencyKey)}`;
}

function agentCommandIdempotencyKey(
  context: SlotlockAgentInvocationContext,
  idempotencyKey: string,
): string {
  // Keep the principal in the digest too so this remains safe with older tenant-only stores.
  // Hashing keeps the authenticated subject and caller's raw retry key out of durable command rows.
  return `agent-command:${agentPrincipalDigest(context, idempotencyKey)}`;
}

function attendeeProjection(attendee: CalendarAttendee) {
  return {
    address: attendee.email,
    name: attendee.name ?? null,
    role: attendee.role ?? 'required',
    participation_status: attendee.participationStatus ?? 'needs_action',
    rsvp: attendee.rsvp ?? false,
  };
}

/**
 * A stored calendar event in the shape the event tools return. Exported for an application that
 * writes events through the store itself and shows them to agents beside the tools' own results.
 */
export function projectSlotlockCalendarEvent(event: SlotlockCalendarEvent): Record<string, unknown> {
  return {
    // External references are the stable tenant-visible identity. Internal UUIDs never become an
    // unscoped lookup capability at the protocol boundary.
    id: event.externalRef,
    resource_id: event.resourceId,
    starts_at: event.start.toISOString(),
    ends_at: event.end.toISOString(),
    timezone: event.timezone,
    title: event.summary || null,
    description: event.description ?? null,
    location: event.location ?? null,
    organizer: event.organizer
      ? { address: event.organizer.email, name: event.organizer.name ?? null }
      : null,
    attendees: (event.attendees ?? []).map(attendeeProjection),
    reminders: (event.reminders ?? []).map((reminder) => ({
      minutes_before: reminder.minutesBeforeStart,
      channel: reminder.action,
    })),
    status: event.status ?? 'confirmed',
    transparency: event.transparency ?? 'opaque',
    sequence: event.revision,
    revision: event.revision,
    recurrence_rule: event.recurrence?.rrule ?? null,
    recurrence_exceptions: (event.recurrence?.exceptions ?? []).map((exception) => ({
      recurrence_id: exception.recurrenceId.toISOString(),
      cancelled: exception.cancelled ?? false,
      starts_at: exception.start?.toISOString() ?? null,
      ends_at: exception.end?.toISOString() ?? null,
    })),
    recurrence_id: null,
  };
}

function operationError(code: string): SlotlockAgentOperationError {
  if (code === 'resource_tenant_mismatch' || code.endsWith('_not_found')) {
    return new SlotlockAgentOperationError('not_found', 404);
  }
  if (code.startsWith('invalid_')) return new SlotlockAgentOperationError(code, 400);
  if (code === 'owner_event_quota_exceeded' || code === 'owner_command_quota_exceeded') {
    return new SlotlockAgentOperationError(code, 429);
  }
  return new SlotlockAgentOperationError(code, 409);
}

/** Resource and event ids: the UUIDs the store issues and validates. */
const STORE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A resource page's cursor is the last resource id of the previous page. */
function parseResourceCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !STORE_ID_PATTERN.test(value)) {
    throw new SlotlockAgentOperationError('invalid_cursor', 400);
  }
  return value;
}

function parseEventCursor(value: unknown): { start: Date; id: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
    throw new SlotlockAgentOperationError('invalid_cursor', 400);
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      start?: unknown;
      id?: unknown;
    };
    const start = typeof parsed.start === 'string' ? new Date(parsed.start) : new Date(Number.NaN);
    if (
      !Number.isFinite(start.getTime()) ||
      typeof parsed.id !== 'string' ||
      !STORE_ID_PATTERN.test(parsed.id)
    ) {
      throw new Error('invalid');
    }
    return { start, id: parsed.id };
  } catch {
    throw new SlotlockAgentOperationError('invalid_cursor', 400);
  }
}

/** The cursor after one row of a page ordered by start then id: an event, a hold or a booking. */
function encodeEventCursor(row: { start: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ start: row.start.toISOString(), id: row.id }),
    'utf8',
  ).toString('base64url');
}

/** One page of rows read with one more than `limit`, and the cursor to the next when there is one. */
function page<T extends { start: Date; id: string }>(rows: T[], limit: number) {
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return { shown, next: rows.length > limit && last ? encodeEventCursor(last) : null };
}

/**
 * The caller's resource with this id, or `resource_not_found`. The tools accept any id an agent may
 * send (an external reference such as `vehicle-42`, the nil UUID, a version 7 UUID). The store
 * issues version 4 UUIDs (gen_random_uuid) and refuses an id that is not a version 1 to 5 UUID as an
 * invalid identity, so such an id names no resource: it is not found, like a well-formed id that
 * names nothing or another tenant's resource. With `visibility`, a resource of the other is not
 * found either: agents ask for `shared`, so a private resource is invisible to them.
 */
async function requireResource(
  tenantStore: SlotlockTenantStore,
  tenantRef: string,
  resourceId: string,
  visibility?: 'shared',
): Promise<SlotlockResource> {
  if (!STORE_ID_PATTERN.test(resourceId)) {
    throw new SlotlockAgentOperationError('resource_not_found', 404);
  }
  const resource = await tenantStore.getResource({
    tenantRef,
    id: resourceId,
    ...(visibility !== undefined ? { visibility } : {}),
  });
  if (!resource) throw new SlotlockAgentOperationError('resource_not_found', 404);
  return resource;
}

/** The caller's shared resource with this id: what an agent may see and book. */
function requireAgentResource(
  tenantStore: SlotlockTenantStore,
  tenantRef: string,
  resourceId: string,
): Promise<SlotlockResource> {
  return requireResource(tenantStore, tenantRef, resourceId, 'shared');
}

/** Bind the protocol server to the production store without giving a request control of tenancy. */
export function createSlotlockStoreAgentBackend(
  store: SlotlockStore,
  options: SlotlockStoreAgentBackendOptions,
): SlotlockAgentCalendarBackend {
  return {
    async describeResource(context, resourceId) {
      if (!STORE_ID_PATTERN.test(resourceId)) return null;
      return withTenant(store, context, async (tenantStore) => {
        const resource = await tenantStore.getResource({
          tenantRef: context.principal.tenantRef,
          id: resourceId,
          visibility: 'shared',
        });
        return resource
          ? { name: resource.externalRef ?? null, timezone: resource.timezone }
          : null;
      });
    },

    async listResources(context, input) {
      const cursor = parseResourceCursor(input.cursor);
      return withTenant(store, context, async (tenantStore) => {
        const limit = input.limit as number;
        const resources = await tenantStore.listResources({
          tenantRef: context.principal.tenantRef,
          visibility: 'shared',
          limit: limit + 1,
          ...(cursor !== undefined ? { after: cursor } : {}),
        });
        const page = resources.slice(0, limit);
        return {
          resources: page.map((resource) => ({
            id: resource.id,
            external_ref: resource.externalRef,
            timezone: resource.timezone,
          })),
          next_cursor: resources.length > limit ? (page.at(-1)?.id ?? null) : null,
        };
      });
    },

    async getFreeBusy(context, input) {
      const window = interval(input as { start: string; end: string });
      const resourceIds = distinctResourceIds(input);
      const charge = busyBudget();
      return withTenant(store, context, async (tenantStore) => {
        const resources = [];
        for (const resourceId of resourceIds) {
          const resource = await requireAgentResource(
            tenantStore,
            context.principal.tenantRef,
            resourceId,
          );
          const sources = await requiredSources(options, context, resource);
          const result = await readFreeBusy(tenantStore, {
            tenantRef: context.principal.tenantRef,
            resourceId,
            window,
            requiredSources: [...sources],
            ...(options.coverageMaxAgeMs !== undefined
              ? { coverageMaxAgeMs: options.coverageMaxAgeMs }
              : {}),
          });
          charge(result.busy.length);
          resources.push({
            resource_id: resourceId,
            busy: result.busy.map((busy) => ({
              start: busy.start.toISOString(),
              end: busy.end.toISOString(),
            })),
            coverage: coverageProjection(window, result.coverage.state === 'complete'),
          });
        }
        return { resources };
      });
    },

    async findNextAvailable(context, input) {
      const window = interval(input as { start: string; end: string });
      const resourceIds = distinctResourceIds(input);
      const durationMs = (input.duration_minutes as number) * 60_000;
      const charge = busyBudget();
      return withTenant(store, context, async (tenantStore) => {
        let best: { resourceId: string; interval: Interval } | null = null;
        let incomplete = false;
        for (const resourceId of resourceIds) {
          const resource = await requireAgentResource(
            tenantStore,
            context.principal.tenantRef,
            resourceId,
          );
          const sources = await requiredSources(options, context, resource);
          const freeBusy = await readFreeBusy(tenantStore, {
            tenantRef: context.principal.tenantRef,
            resourceId,
            window,
            requiredSources: [...sources],
            ...(options.coverageMaxAgeMs !== undefined
              ? { coverageMaxAgeMs: options.coverageMaxAgeMs }
              : {}),
          });
          charge(freeBusy.busy.length);
          if (freeBusy.coverage.state !== 'complete') {
            incomplete = true;
            continue;
          }
          const rules =
            resource.availabilityRules ?? (await options.availabilityRules(context, resource));
          const candidate = findNextAvailable({
            busy: freeBusy.busy,
            windows: expandRules(rules, window, resource.timezone),
            durationMs,
          });
          if (
            candidate &&
            (!best ||
              candidate.start.getTime() < best.interval.start.getTime() ||
              (candidate.start.getTime() === best.interval.start.getTime() &&
                resourceId.localeCompare(best.resourceId) < 0))
          ) {
            best = { resourceId, interval: candidate };
          }
        }
        // A cross-resource answer is only certain when every requested resource is certain. A slot
        // from one healthy calendar must not mask a stale provider or recurrence horizon on another.
        const complete = !incomplete;
        const certainBest = complete ? best : null;
        return {
          resource_id: certainBest?.resourceId ?? null,
          start: certainBest?.interval.start.toISOString() ?? null,
          end: certainBest?.interval.end.toISOString() ?? null,
          coverage: coverageProjection(window, complete),
        };
      });
    },

    async createEvent(context, rawInput) {
      const input = rawInput as unknown as AgentEventInput;
      return withTenant(store, context, async (tenantStore) => {
        await requireAgentResource(tenantStore, context.principal.tenantRef, input.resource_id);
        const recurrence = recurrenceFromInput(input.recurrence_rule, input.recurrence_exceptions);
        const content: CalendarEventContent = {
          start: new Date(input.starts_at),
          end: new Date(input.ends_at),
          timezone: input.timezone,
          summary: eventSummary(input.title),
          ...(input.description !== undefined ? { description: input.description ?? '' } : {}),
          ...(input.location !== undefined ? { location: input.location ?? '' } : {}),
          ...(input.organizer
            ? {
                organizer: {
                  email: input.organizer.address,
                  ...(input.organizer.name !== undefined ? { name: input.organizer.name } : {}),
                },
              }
            : {}),
          status: input.status ?? 'confirmed',
          transparency: input.transparency ?? 'opaque',
          attendees: attendeesFromInput(input.attendees),
          reminders: remindersFromInput(input.reminders),
          ...(recurrence ? { recurrence } : {}),
        };
        const result = await tenantStore.putCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef: agentExternalRef(context, input.idempotency_key),
          resourceId: input.resource_id,
          expectedRevision: 0,
          idempotencyKey: agentCommandIdempotencyKey(context, input.idempotency_key),
          source: 'agent-server',
          ...content,
          materializationWindow: materializationWindow(content),
        });
        if (!result.ok) throw operationError(result.code);
        const created = await tenantStore.getCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef: result.externalRef,
        });
        if (!created) throw new SlotlockAgentOperationError('store_inconsistent', 503);
        return { event: projectSlotlockCalendarEvent(created), replayed: result.idempotent };
      }, WRITE);
    },

    async getEvent(context, input) {
      return withTenant(store, context, async (tenantStore) => {
        const found = await tenantStore.getCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef: input.event_id as string,
        });
        if (!found) throw new SlotlockAgentOperationError('event_not_found', 404);
        return { event: projectSlotlockCalendarEvent(found) };
      });
    },

    async listEvents(context, input) {
      const window = interval(input as { start: string; end: string });
      const resourceIds = distinctResourceIds(input);
      const limit = input.limit as number;
      const after = parseEventCursor(input.cursor);
      return withTenant(store, context, async (tenantStore) => {
        const combined: SlotlockCalendarEvent[] = [];
        for (const resourceId of resourceIds) {
          await requireAgentResource(tenantStore, context.principal.tenantRef, resourceId);
          combined.push(
            ...(await tenantStore.listCalendarEvents({
              tenantRef: context.principal.tenantRef,
              ownerRef: agentOwnerRef(context),
              resourceId,
              window,
              limit: limit + 1,
              ...(after ? { after } : {}),
            })),
          );
        }
        combined.sort(
          (left, right) =>
            left.start.getTime() - right.start.getTime() || left.id.localeCompare(right.id),
        );
        const page = combined.slice(0, limit);
        const last = page.at(-1);
        return {
          events: page.map(projectSlotlockCalendarEvent),
          next_cursor: combined.length > limit && last ? encodeEventCursor(last) : null,
        };
      });
    },

    async updateEvent(context, rawInput) {
      const input = rawInput as unknown as AgentEventInput & {
        event_id: string;
        expected_revision: number;
        expected_resource_id?: string;
      };
      // No event is on a resource the store never issued (an external reference, say).
      if (
        input.expected_resource_id !== undefined &&
        !STORE_ID_PATTERN.test(input.expected_resource_id)
      ) {
        throw new SlotlockAgentOperationError('event_not_found', 404);
      }
      return withTenant(store, context, async (tenantStore) => {
        const current = await tenantStore.getCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef: input.event_id,
        });
        if (!current) throw new SlotlockAgentOperationError('event_not_found', 404);
        const resourceId = input.resource_id ?? current.resourceId;
        if (resourceId !== current.resourceId) {
          await requireAgentResource(tenantStore, context.principal.tenantRef, resourceId);
        }
        const recurrence: CalendarRecurrence | undefined =
          input.recurrence_rule === null
            ? undefined
            : input.recurrence_rule !== undefined
              ? recurrenceFromInput(input.recurrence_rule, input.recurrence_exceptions)
              : input.recurrence_exceptions !== undefined
                ? current.recurrence
                  ? {
                      rrule: current.recurrence.rrule,
                      exceptions: exceptionsFromInput(input.recurrence_exceptions),
                    }
                  : undefined
                : current.recurrence;
        const content: CalendarEventContent = {
          start: input.starts_at ? new Date(input.starts_at) : current.start,
          end: input.ends_at ? new Date(input.ends_at) : current.end,
          timezone: input.timezone ?? current.timezone,
          summary: input.title === undefined ? current.summary : eventSummary(input.title),
          ...(input.description === null
            ? {}
            : input.description !== undefined
              ? { description: input.description }
              : current.description !== undefined
                ? { description: current.description }
                : {}),
          ...(input.location === null
            ? {}
            : input.location !== undefined
              ? { location: input.location }
              : current.location !== undefined
                ? { location: current.location }
                : {}),
          ...(input.organizer === null
            ? {}
            : input.organizer !== undefined
              ? {
                  organizer: {
                    email: input.organizer.address,
                    ...(input.organizer.name !== undefined ? { name: input.organizer.name } : {}),
                  },
                }
              : current.organizer
                ? { organizer: current.organizer }
                : {}),
          attendees:
            input.attendees !== undefined
              ? attendeesFromInput(input.attendees)
              : (current.attendees ?? []),
          reminders:
            input.reminders !== undefined
              ? remindersFromInput(input.reminders)
              : (current.reminders ?? []),
          status: input.status ?? current.status ?? 'confirmed',
          transparency: input.transparency ?? current.transparency ?? 'opaque',
          ...(recurrence ? { recurrence } : {}),
        };
        const result = await tenantStore.putCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef: current.externalRef,
          // The caller's fence when it sent one, checked under the event's lock; otherwise the
          // resource just read, so a move between that read and the write is not overwritten.
          expectedResourceId: input.expected_resource_id ?? current.resourceId,
          resourceId,
          expectedRevision: input.expected_revision,
          idempotencyKey: agentCommandIdempotencyKey(context, input.idempotency_key),
          source: current.source ?? 'agent-server',
          ...content,
          materializationWindow: materializationWindow(content),
        });
        if (!result.ok) throw operationError(result.code);
        const updated = await tenantStore.getCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef: result.externalRef,
        });
        if (!updated) throw new SlotlockAgentOperationError('store_inconsistent', 503);
        return { event: projectSlotlockCalendarEvent(updated), replayed: result.idempotent };
      }, WRITE);
    },

    async deleteEvent(context, input) {
      return withTenant(store, context, async (tenantStore) => {
        const externalRef = input.event_id as string;
        const current = await tenantStore.getCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef,
        });
        if (!current) throw new SlotlockAgentOperationError('event_not_found', 404);
        const result = await tenantStore.cancelCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef,
          expectedResourceId: current.resourceId,
          idempotencyKey: agentCommandIdempotencyKey(context, input.idempotency_key as string),
          expectedRevision: input.expected_revision as number,
        });
        if (!result.ok) throw operationError(result.code);
        return {
          event_id: externalRef,
          revision: result.revision,
          deleted: true,
          replayed: result.idempotent,
        };
      }, WRITE);
    },
  };
}

export interface SlotlockStoreApplicationBackendOptions {
  /**
   * Refuse a new resource (409 `resource_limit_reached`) once the tenant has this many, 1-100,000.
   * An existing external reference is still updated. Unset: no limit.
   */
  maxTenantResources?: number;
  /** Batches of each maintenance task one `slotlock_run_maintenance` call runs, 1-100 (default 10). */
  maintenanceBatches?: number;
  /**
   * Let an admin key erase its own tenant (`slotlock_erase_tenant`), everything it has and every
   * key it holds, with its tenant reference as confirmation. Off unless true: erasure cannot be
   * undone, and an operator may owe a tenant's data a retention or review first.
   */
  tenantErasure?: boolean;
}

/** A store failure thrown with a `code` the caller may see, or the error itself to report. */
function storeRefusal(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return error;
  if (code === 'resource_limit_reached' || code === 'resource_visibility_conflict') {
    return new SlotlockAgentOperationError(code, 409);
  }
  if (code.startsWith('invalid_') && code !== 'invalid_transaction_isolation') {
    return new SlotlockAgentOperationError(code, 400);
  }
  return error;
}

/** The status an application refusal answers with; the resource of another tenant is not found. */
function applicationRefusal(code: string): SlotlockAgentOperationError {
  if (code === 'resource_tenant_mismatch') {
    return new SlotlockAgentOperationError('resource_not_found', 404);
  }
  if (code.endsWith('_not_found')) return new SlotlockAgentOperationError(code, 404);
  if (code.startsWith('invalid_')) return new SlotlockAgentOperationError(code, 400);
  return new SlotlockAgentOperationError(code, 409);
}

function rulesOutput(rules: readonly WeeklyAvailabilityRule[] | undefined | null) {
  if (!rules) return null;
  return rules.map((rule) => ({
    rrule: rule.rrule,
    start_minutes: rule.startMinutes,
    duration_minutes: rule.durationMinutes,
  }));
}

function rulesInput(value: unknown): WeeklyAvailabilityRule[] | null {
  if (value === null) return null;
  const rules = (value as { rrule: string; start_minutes: number; duration_minutes: number }[]).map(
    (rule) => ({
      rrule: rule.rrule,
      startMinutes: rule.start_minutes,
      durationMinutes: rule.duration_minutes,
    }),
  );
  try {
    return parseAvailabilityRules(rules);
  } catch (error) {
    throw storeRefusal(error);
  }
}

function resourceOutput(resource: SlotlockResource) {
  return {
    id: resource.id,
    external_ref: resource.externalRef,
    timezone: resource.timezone,
    availability: rulesOutput(resource.availabilityRules),
    visibility: resource.visibility ?? 'shared',
    archived_at: resource.archivedAt?.toISOString() ?? null,
  };
}

/** Any of a tenant's events: the store's id, which the tenant-event routes take, and its owner's. */
function tenantEventOutput(event: SlotlockCalendarEvent) {
  return {
    ...projectSlotlockCalendarEvent(event),
    id: event.id,
    event_ref: event.externalRef,
    owner_ref: event.ownerRef,
  };
}

function holdOutput(hold: SlotlockHold) {
  return {
    id: hold.id,
    resource_id: hold.resourceId,
    start: hold.start.toISOString(),
    end: hold.end.toISOString(),
    expires_at: hold.expiresAt.toISOString(),
    source: hold.source,
  };
}

function reservationOutput(reservation: SlotlockReservation) {
  return {
    id: reservation.id,
    resource_id: reservation.resourceId,
    reservation_ref: reservation.externalRef,
    start: reservation.start.toISOString(),
    end: reservation.end.toISOString(),
    // The store keeps milliseconds; a buffer set in seconds through the library still shows as busy.
    buffer_after_minutes: Math.ceil(reservation.bufferAfterMs / 60_000),
    revision: reservation.revision,
    source: reservation.source,
  };
}

/**
 * The namespace an application caller's idempotency keys live in: a digest of its tenant and
 * subject, so the authenticated subject never lands in a durable row.
 */
function applicationPrincipalRef(context: SlotlockApplicationInvocationContext): string {
  return `application:${createHash('sha256')
    .update(`${context.principal.tenantRef}\0${context.principal.subject}`)
    .digest('hex')}`;
}

/**
 * An application caller's event command key: its tenant, subject and own key, digested, so one
 * caller's key never replays another's command and neither the subject nor the raw key is stored.
 */
function applicationCommandKey(
  context: SlotlockApplicationInvocationContext,
  idempotencyKey: string,
): string {
  return `application-command:${createHash('sha256')
    .update(`${context.principal.tenantRef}\0${context.principal.subject}\0${idempotencyKey}`)
    .digest('hex')}`;
}

/** The most busy intervals one slotlock_list_busy answers, as one free/busy request reads. */
const MAX_LISTED_BUSY = MAX_REQUEST_BUSY_INTERVALS;

/**
 * Serve the application API (application-api.ts) from the production store, in the principal's
 * tenant. Every resource an operation names must be the tenant's, or it is not found; holds are
 * reservations under the tenant's row-level security, so another tenant's hold is not found either.
 */
export function createSlotlockStoreApplicationBackend(
  store: SlotlockStore,
  options: SlotlockStoreApplicationBackendOptions = {},
): SlotlockApplicationBackend {
  const max = options.maxTenantResources;
  if (max !== undefined && !(Number.isSafeInteger(max) && max >= 1 && max <= 100_000)) {
    throw new RangeError('maxTenantResources must be a whole number from 1 to 100,000');
  }
  const batches = options.maintenanceBatches ?? 10;
  if (!(Number.isSafeInteger(batches) && batches >= 1 && batches <= 100)) {
    throw new RangeError('maintenanceBatches must be a whole number from 1 to 100');
  }
  const tenantErasure = options.tenantErasure === true;
  const tenantOf = (context: SlotlockApplicationInvocationContext) => context.principal.tenantRef;

  return {
    async createResource(context, input) {
      // A capped create counts under READ COMMITTED; withTenant opens it for the call.
      return withTenant(
        store,
        context,
        async (tenant) => {
          try {
            const resource = await tenant.createResource({
              tenantRef: tenantOf(context),
              externalRef: input.external_ref as string,
              timezone: input.timezone as string,
              ...(input.visibility !== undefined
                ? { visibility: input.visibility as 'shared' | 'private' }
                : {}),
              ...(max !== undefined ? { maxTenantResources: max } : {}),
            });
            return { resource: resourceOutput(resource) };
          } catch (error) {
            throw storeRefusal(error);
          }
        },
        max !== undefined ? { isolation: 'read committed' } : undefined,
      );
    },

    async getResource(context, input) {
      return withTenant(store, context, async (tenant) => ({
        resource: resourceOutput(
          await requireResource(tenant, tenantOf(context), input.resource_id as string),
        ),
      }));
    },

    async archiveResource(context, input) {
      const id = input.resource_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('resource_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        const resource = await tenant.archiveResource({ tenantRef: tenantOf(context), id });
        if (!resource) throw new SlotlockAgentOperationError('resource_not_found', 404);
        return { resource: resourceOutput(resource) };
      }, WRITE);
    },

    async restoreResource(context, input) {
      const id = input.resource_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('resource_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        const resource = await tenant.restoreResource({ tenantRef: tenantOf(context), id });
        if (!resource) throw new SlotlockAgentOperationError('resource_not_found', 404);
        return { resource: resourceOutput(resource) };
      }, WRITE);
    },

    async deleteResource(context, input) {
      const id = input.resource_id as string;
      // An id the store never issues names no resource: there is nothing to delete.
      if (!STORE_ID_PATTERN.test(id)) return { deleted: false };
      return withTenant(store, context, async (tenant) => {
        const result = await tenant.deleteResource({ tenantRef: tenantOf(context), id });
        if (!result.ok) throw applicationRefusal(result.code);
        return { deleted: result.deleted };
      }, WRITE);
    },

    async listBusy(context, input) {
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const busy = await tenant.listBusy(resource.id, interval(input as { start: string; end: string }), {
          tenantRef: tenantOf(context),
        });
        if (busy.length > MAX_LISTED_BUSY) {
          throw new SlotlockAgentOperationError('calendar_work_limit', 400);
        }
        return {
          busy: busy.map((occupied) => ({
            start: occupied.start.toISOString(),
            end: occupied.end.toISOString(),
          })),
        };
      });
    },

    async setResourceAvailability(context, input) {
      const rules = rulesInput(input.rules);
      const id = input.resource_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('resource_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        let resource: SlotlockResource | null;
        try {
          resource = await tenant.setResourceAvailability({ tenantRef: tenantOf(context), id, rules });
        } catch (error) {
          throw storeRefusal(error);
        }
        if (!resource) throw new SlotlockAgentOperationError('resource_not_found', 404);
        return { resource: resourceOutput(resource) };
      });
    },

    async setTenantAvailability(context, input) {
      const rules = rulesInput(input.rules);
      return withTenant(store, context, async (tenant) => {
        try {
          return {
            resources_updated: await tenant.setTenantAvailability({
              tenantRef: tenantOf(context),
              rules,
            }),
          };
        } catch (error) {
          throw storeRefusal(error);
        }
      });
    },

    async acquireHold(context, input) {
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const result = await tenant.acquireHold({
          tenantRef: tenantOf(context),
          resourceId: resource.id,
          start: new Date(input.start as string),
          end: new Date(input.end as string),
          ttlMs: (input.ttl_seconds as number) * 1_000,
          ...(input.source !== undefined ? { source: input.source as string } : {}),
          ...(input.buffer_after_minutes !== undefined
            ? { bufferAfterMs: (input.buffer_after_minutes as number) * 60_000 }
            : {}),
          // A retried request with the caller's key answers the hold the first one made.
          ...(input.idempotency_key !== undefined
            ? {
                idempotencyKey: input.idempotency_key as string,
                principalRef: applicationPrincipalRef(context),
              }
            : {}),
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { hold: holdOutput(result.hold) };
      }, WRITE);
    },

    async getHold(context, input) {
      const id = input.hold_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('hold_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        const hold = await tenant.getHold({ tenantRef: tenantOf(context), holdId: id });
        if (!hold) throw new SlotlockAgentOperationError('hold_not_found', 404);
        return { hold: holdOutput(hold) };
      });
    },

    async listHolds(context, input) {
      const limit = input.limit as number;
      const after = parseEventCursor(input.cursor);
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const { shown, next } = page(
          await tenant.listHolds({
            tenantRef: tenantOf(context),
            resourceId: resource.id,
            limit: limit + 1,
            ...(after ? { after } : {}),
          }),
          limit,
        );
        return { holds: shown.map(holdOutput), next_cursor: next };
      });
    },

    async confirmHold(context, input) {
      const id = input.hold_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('hold_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        const result = await tenant.confirmHold(id, { tenantRef: tenantOf(context) });
        if (!result.ok) throw applicationRefusal(result.code);
        return { reservation: reservationOutput(result.reservation) };
      }, WRITE);
    },

    async releaseHold(context, input) {
      const id = input.hold_id as string;
      // An id that is not one the store issues names no hold: there is nothing to release.
      if (!STORE_ID_PATTERN.test(id)) return { released: false };
      return withTenant(store, context, async (tenant) => ({
        released: (await tenant.releaseHold(id, { tenantRef: tenantOf(context) })).released,
      }));
    },

    async getReservation(context, input) {
      return withTenant(store, context, async (tenant) => {
        const reservation = await tenant.getReservation({
          tenantRef: tenantOf(context),
          externalRef: input.reservation_ref as string,
        });
        if (!reservation) throw new SlotlockAgentOperationError('reservation_not_found', 404);
        return { reservation: reservationOutput(reservation) };
      });
    },

    async listReservations(context, input) {
      const limit = input.limit as number;
      const after = parseEventCursor(input.cursor);
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const { shown, next } = page(
          await tenant.listReservations({
            tenantRef: tenantOf(context),
            resourceId: resource.id,
            window: interval(input as { start: string; end: string }),
            limit: limit + 1,
            ...(after ? { after } : {}),
          }),
          limit,
        );
        return { reservations: shown.map(reservationOutput), next_cursor: next };
      });
    },

    async putReservation(context, input) {
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const command = {
          tenantRef: tenantOf(context),
          externalRef: input.reservation_ref as string,
          resourceId: resource.id,
          start: new Date(input.start as string),
          end: new Date(input.end as string),
          bufferAfterMs: (input.buffer_after_minutes as number) * 60_000,
          revision: input.revision as number,
          ...(input.source !== undefined ? { source: input.source as string } : {}),
        };
        const result =
          command.revision === 1
            ? await tenant.createExternalReservation(command)
            : await tenant.rescheduleExternalReservation(command);
        if (!result.ok) throw applicationRefusal(result.code);
        return { reservation: reservationOutput(result.reservation), replayed: result.idempotent };
      }, WRITE);
    },

    async cancelReservation(context, input) {
      return withTenant(store, context, async (tenant) => {
        const result = await tenant.cancelExternalReservation({
          tenantRef: tenantOf(context),
          externalRef: input.reservation_ref as string,
          revision: input.revision as number,
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { cancelled: result.cancelled, revision: result.revision };
      }, WRITE);
    },

    async recordCoverage(context, input) {
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const result = await tenant.recordCalendarCoverage({
          tenantRef: tenantOf(context),
          resourceId: resource.id,
          source: input.source as string,
          window: interval(input as { start: string; end: string }),
          revision: input.revision as number,
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { revision: result.revision, replayed: result.idempotent };
      }, WRITE);
    },

    async listTenantEvents(context, input) {
      const limit = input.limit as number;
      const after = parseEventCursor(input.cursor);
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const { shown, next } = page(
          await tenant.listCalendarEvents({
            tenantRef: tenantOf(context),
            allOwners: true,
            resourceId: resource.id,
            window: interval(input as { start: string; end: string }),
            limit: limit + 1,
            ...(after ? { after } : {}),
          }),
          limit,
        );
        return { events: shown.map(tenantEventOutput), next_cursor: next };
      });
    },

    async getTenantEvent(context, input) {
      const id = input.event_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('event_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        const event = await tenant.getCalendarEventById({ tenantRef: tenantOf(context), eventId: id });
        if (!event) throw new SlotlockAgentOperationError('event_not_found', 404);
        return { event: tenantEventOutput(event) };
      });
    },

    async cancelTenantEvent(context, input) {
      const id = input.event_id as string;
      const expectedResourceId = input.expected_resource_id as string | undefined;
      // An id the store never issues names no event, and no event is on a resource it never issued.
      if (
        !STORE_ID_PATTERN.test(id) ||
        (expectedResourceId !== undefined && !STORE_ID_PATTERN.test(expectedResourceId))
      ) {
        throw new SlotlockAgentOperationError('event_not_found', 404);
      }
      return withTenant(store, context, async (tenant) => {
        const result = await tenant.cancelCalendarEventById({
          tenantRef: tenantOf(context),
          eventId: id,
          idempotencyKey: applicationCommandKey(context, input.idempotency_key as string),
          expectedRevision: input.expected_revision as number,
          ...(expectedResourceId !== undefined ? { expectedResourceId } : {}),
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return {
          event_id: result.eventId,
          revision: result.revision,
          cancelled: true,
          replayed: result.idempotent,
        };
      }, WRITE);
    },

    async getTenant(context) {
      return withTenant(store, context, async (tenant) => ({
        tenant: {
          ref: tenantOf(context),
          suspended: await tenant.isTenantSuspended({ tenantRef: tenantOf(context) }),
        },
      }));
    },

    async eraseTenant(context, input) {
      if (!tenantErasure) throw new SlotlockAgentOperationError('tenant_erasure_disabled', 403);
      // The reference, not a yes: a key of another tenant than the caller believes cannot erase it.
      if (input.confirm_tenant_ref !== tenantOf(context)) {
        throw new SlotlockAgentOperationError('invalid_confirmation', 400);
      }
      return withTenant(store, context, async (tenant) => {
        // Read under the tenant's lock, which a suspension waits for: a suspended tenant's data is
        // kept for its operator, who erases it (slotlock tenant erase) when they decide to.
        if (await tenant.isTenantSuspended({ tenantRef: tenantOf(context) })) {
          throw new SlotlockAgentOperationError('tenant_suspended', 403);
        }
        const erased = await tenant.eraseTenant({ tenantRef: tenantOf(context) });
        return { total: erased.total, rows: erased.rows };
      }, WRITE);
    },

    async runMaintenance(context) {
      assertActive(context);
      try {
        // A caller goes round again while `capped`; when to do so at once is the scheduler's.
        const { rollPending: _, ...result } = await maintainSlotlockTenant(store, tenantOf(context), {
          batches,
          signal: context.signal,
        });
        return result;
      } catch (error) {
        if (context.signal.aborted) throw new SlotlockAgentOperationError('request_aborted', 503);
        throw error;
      }
    },
  };
}
