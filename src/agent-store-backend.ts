import { createHash } from 'node:crypto';
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentInvocationContext,
  SlotlockAgentOperationError,
} from './agent-server.js';
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
  SlotlockResource,
  WeeklyAvailabilityRule,
} from './types.js';

export interface SlotlockStoreAgentBackendOptions {
  /** Business-authored availability. Omitting/invalid rules returns no slot; it never means 24x7. */
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

function assertActive(context: SlotlockAgentInvocationContext): void {
  if (context.signal.aborted) throw new SlotlockAgentOperationError('request_aborted', 503);
}

async function withTenant<T>(
  store: SlotlockStore,
  context: SlotlockAgentInvocationContext,
  callback: (tenantStore: SlotlockTenantStore) => Promise<T>,
): Promise<T> {
  assertActive(context);
  const value = await store.withTenant(context.principal.tenantRef, callback);
  assertActive(context);
  return value;
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

function eventProjection(event: SlotlockCalendarEvent): Record<string, unknown> {
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

function encodeEventCursor(event: SlotlockCalendarEvent): string {
  return Buffer.from(
    JSON.stringify({ start: event.start.toISOString(), id: event.id }),
    'utf8',
  ).toString('base64url');
}

async function requireResource(
  tenantStore: SlotlockTenantStore,
  tenantRef: string,
  resourceId: string,
): Promise<SlotlockResource> {
  const resource = await tenantStore.getResource({ tenantRef, id: resourceId });
  if (!resource) throw new SlotlockAgentOperationError('resource_not_found', 404);
  return resource;
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
        });
        return resource?.externalRef ?? null;
      });
    },

    async listResources(context, input) {
      const cursor = parseResourceCursor(input.cursor);
      return withTenant(store, context, async (tenantStore) => {
        const limit = input.limit as number;
        const resources = await tenantStore.listResources({
          tenantRef: context.principal.tenantRef,
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
      const resourceIds = input.resource_ids as string[];
      return withTenant(store, context, async (tenantStore) => {
        const resources = [];
        for (const resourceId of resourceIds) {
          const resource = await requireResource(
            tenantStore,
            context.principal.tenantRef,
            resourceId,
          );
          const sources = await requiredSources(options, context, resource);
          const result = await tenantStore.getFreeBusy({
            tenantRef: context.principal.tenantRef,
            resourceId,
            window,
            requiredSources: [...sources],
            ...(options.coverageMaxAgeMs !== undefined
              ? { coverageMaxAgeMs: options.coverageMaxAgeMs }
              : {}),
          });
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
      const resourceIds = input.resource_ids as string[];
      const durationMs = (input.duration_minutes as number) * 60_000;
      return withTenant(store, context, async (tenantStore) => {
        let best: { resourceId: string; interval: Interval } | null = null;
        let incomplete = false;
        for (const resourceId of resourceIds) {
          const resource = await requireResource(
            tenantStore,
            context.principal.tenantRef,
            resourceId,
          );
          const sources = await requiredSources(options, context, resource);
          const freeBusy = await tenantStore.getFreeBusy({
            tenantRef: context.principal.tenantRef,
            resourceId,
            window,
            requiredSources: [...sources],
            ...(options.coverageMaxAgeMs !== undefined
              ? { coverageMaxAgeMs: options.coverageMaxAgeMs }
              : {}),
          });
          if (freeBusy.coverage.state !== 'complete') {
            incomplete = true;
            continue;
          }
          const rules = await options.availabilityRules(context, resource);
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
        await requireResource(tenantStore, context.principal.tenantRef, input.resource_id);
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
        return { event: eventProjection(created), replayed: result.idempotent };
      });
    },

    async getEvent(context, input) {
      return withTenant(store, context, async (tenantStore) => {
        const found = await tenantStore.getCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef: input.event_id as string,
        });
        if (!found) throw new SlotlockAgentOperationError('event_not_found', 404);
        return { event: eventProjection(found) };
      });
    },

    async listEvents(context, input) {
      const window = interval(input as { start: string; end: string });
      const resourceIds = input.resource_ids as string[];
      const limit = input.limit as number;
      const after = parseEventCursor(input.cursor);
      return withTenant(store, context, async (tenantStore) => {
        const combined: SlotlockCalendarEvent[] = [];
        for (const resourceId of resourceIds) {
          await requireResource(tenantStore, context.principal.tenantRef, resourceId);
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
          events: page.map(eventProjection),
          next_cursor: combined.length > limit && last ? encodeEventCursor(last) : null,
        };
      });
    },

    async updateEvent(context, rawInput) {
      const input = rawInput as unknown as AgentEventInput & {
        event_id: string;
        expected_revision: number;
      };
      return withTenant(store, context, async (tenantStore) => {
        const current = await tenantStore.getCalendarEvent({
          tenantRef: context.principal.tenantRef,
          ownerRef: agentOwnerRef(context),
          externalRef: input.event_id,
        });
        if (!current) throw new SlotlockAgentOperationError('event_not_found', 404);
        const resourceId = input.resource_id ?? current.resourceId;
        if (resourceId !== current.resourceId) {
          await requireResource(tenantStore, context.principal.tenantRef, resourceId);
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
        return { event: eventProjection(updated), replayed: result.idempotent };
      });
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
      });
    },
  };
}
