import type { SlotlockWebhookEndpoint } from './event-feed.js';
import { slotlockCloudEvent } from './webhooks.js';
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
import { type SlotlockBookingRule, type SlotlockBookingRules, bookingSearch } from './booking-rules.js';
import { findNextAvailable } from './engine.js';
import { expandRules } from './rules.js';
import { emitVAvailability, parseVAvailability, toJSCalendarEvent } from './interop.js';
import {
  type SlotlockStore,
  type SlotlockTenantStore,
  type SlotlockWaitlistEntry,
  calendarEventRollingHorizon,
} from './store.js';
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
  hold_id?: string;
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
  principal: { tenantRef: string; subject?: string };
  signal: AbortSignal;
}

/** Who a call's changes are recorded as in the history: the principal's subject, kept short. */
function actorOf(context: TenantCallContext): string | undefined {
  const subject = context.principal.subject;
  if (typeof subject !== 'string' || subject.length === 0) return undefined;
  const clean = subject.replace(/[\u0000-\u001f\u007f]/g, '');
  return clean.length === 0 ? undefined : clean.slice(0, 200);
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
    const actor = actorOf(context);
    value = await store.withTenant(context.principal.tenantRef, callback, {
      ...options,
      signal: context.signal,
      ...(actor !== undefined ? { actor } : {}),
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    // A suspended tenant may read; a write it asks for is forbidden, not a server failure.
    if (code === 'tenant_suspended') throw new SlotlockAgentOperationError('tenant_suspended', 403);
    // Waited past the store's lock timeout behind the tenant's own writes: retry later.
    if (code === 'lock_timeout') throw new SlotlockAgentOperationError('server_busy', 503);
    assertActive(context);
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

/**
 * Bookable windows one search may expand from its resources' availability rules in all: five
 * resources of 50 daily rules over a year, or a hundred of two. Without it, a search of 100 such
 * resources over a year expanded 1.8 million windows and held the process for seven seconds.
 */
const MAX_REQUEST_RULE_WINDOWS = 100_000;

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

/** A version-4-shaped UUID from a digest: a stable id for a value that names one thing. */
function uuidFromDigest(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  const variant = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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

/**
 * The HTTP status a store refusal answers with on every agent surface: a missing or foreign
 * record 404, a malformed request 400, a full agent quota 429, and any other conflict with what is
 * stored 409. rest-api.ts declares the 404 and 409 each route can answer from this.
 */
export function slotlockAgentErrorStatus(code: string): 400 | 404 | 409 | 429 {
  if (code === 'resource_tenant_mismatch' || code.endsWith('_not_found')) return 404;
  if (code.startsWith('invalid_')) return 400;
  if (code === 'owner_event_quota_exceeded' || code === 'owner_command_quota_exceeded') return 429;
  return 409;
}

/** The code an agent's error carries for each booking rule a write breaks. */
const BOOKING_RULE_CODES: Readonly<Record<SlotlockBookingRule, string>> = Object.freeze({
  min_notice: 'booking_rule_min_notice',
  max_advance: 'booking_rule_max_advance',
  slot_step: 'booking_rule_slot_step',
  outside_hours: 'booking_rule_outside_hours',
});

function operationError(
  refusal: string | { code: string; rule?: string },
): SlotlockAgentOperationError {
  // A broken booking rule is named in the code, which is all an agent's error carries.
  const code =
    typeof refusal === 'string'
      ? refusal
      : refusal.code === 'booking_rule_violated' && refusal.rule
        ? (BOOKING_RULE_CODES[refusal.rule as SlotlockBookingRule] ?? refusal.code)
        : refusal.code;
  const status = slotlockAgentErrorStatus(code);
  // A gone hold is named, so the agent holds again; it covers expired and another holder's alike.
  return new SlotlockAgentOperationError(
    status === 404 && code !== 'hold_not_found' ? 'not_found' : code,
    status,
  );
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
    async holdSlots(context, input) {
      const slots = input.slots as { resource_id: string; start: string; end: string }[];
      const key = input.idempotency_key as string;
      const holderRef = agentOwnerRef(context);
      // One group per agent and key, so a retry answers with the same holds and group.
      const groupId = uuidFromDigest(`slotlock-hold-group\0${holderRef}\0${key}`);
      return withTenant(store, context, async (tenantStore) => {
        const holds: Record<string, unknown>[] = [];
        const refused: { index: number; code: string }[] = [];
        for (const [index, slot] of slots.entries()) {
          try {
            await requireAgentResource(tenantStore, context.principal.tenantRef, slot.resource_id);
          } catch (error) {
            if (!(error instanceof SlotlockAgentOperationError)) throw error;
            refused.push({ index, code: error.code });
            continue;
          }
          const result = await tenantStore.acquireHold({
            tenantRef: context.principal.tenantRef,
            principalRef: holderRef,
            holderRef,
            idempotencyKey: agentCommandIdempotencyKey(context, `${key}\0${index}`),
            groupId,
            resourceId: slot.resource_id,
            start: new Date(slot.start),
            end: new Date(slot.end),
            ttlMs: (input.ttl_seconds as number) * 1_000,
            source: 'agent-server',
          });
          if (result.ok) {
            holds.push({
              hold_id: result.hold.id,
              resource_id: result.hold.resourceId,
              start: result.hold.start.toISOString(),
              end: result.hold.end.toISOString(),
              expires_at: result.hold.expiresAt.toISOString(),
            });
          } else {
            refused.push({ index, code: operationError(result).code });
          }
        }
        return { group_id: groupId, holds, refused };
      });
    },

    async bookPool(context, rawInput) {
      const input = rawInput as {
        pool: string;
        starts_at: string;
        ends_at: string;
        timezone: string;
        title?: string;
        idempotency_key: string;
      };
      const content: CalendarEventContent = {
        start: new Date(input.starts_at),
        end: new Date(input.ends_at),
        timezone: input.timezone,
        summary: eventSummary(input.title),
        status: 'confirmed',
        transparency: 'opaque',
        attendees: [],
        reminders: [],
      };
      const tenantRef = context.principal.tenantRef;
      const ownerRef = agentOwnerRef(context);
      const externalRef = agentExternalRef(context, input.idempotency_key);
      return withTenant(store, context, async (tenantStore) => {
        const put = (resourceId: string) =>
          tenantStore.putCalendarEvent({
            tenantRef,
            ownerRef,
            externalRef,
            resourceId,
            expectedRevision: 0,
            idempotencyKey: agentCommandIdempotencyKey(context, input.idempotency_key),
            source: 'agent-server',
            ...content,
            materializationWindow: materializationWindow(content),
            enforceBookingRules: true,
          });
        const answer = async (result: { externalRef: string; idempotent: boolean }) => {
          const created = await tenantStore.getCalendarEvent({ tenantRef, ownerRef, externalRef: result.externalRef });
          if (!created) throw new SlotlockAgentOperationError('store_inconsistent', 503);
          return { event: projectSlotlockCalendarEvent(created), replayed: result.idempotent };
        };
        // A retry answers the member the first call booked, whichever it was.
        const earlier = await tenantStore.getCalendarEvent({ tenantRef, ownerRef, externalRef });
        if (earlier) {
          const replay = await put(earlier.resourceId);
          if (!replay.ok) throw operationError(replay);
          return answer(replay);
        }
        const members = await tenantStore.listPoolMembers({ tenantRef, pool: input.pool, visibility: 'shared' });
        if (members.length === 0) throw new SlotlockAgentOperationError('pool_not_found', 404);
        // Each member in turn, each try its own savepoint: a member that is taken or that the
        // booking's rules refuse is passed over; the exclusion constraint still decides each one.
        for (const member of members) {
          const result = await put(member.id);
          if (result.ok) return answer(result);
          if (result.code !== 'overlap' && result.code !== 'booking_rule_violated') {
            throw operationError(result);
          }
        }
        throw new SlotlockAgentOperationError('pool_full', 409);
      }, WRITE);
    },

    async bookTogether(context, rawInput) {
      const input = rawInput as {
        resource_ids: string[];
        starts_at: string;
        ends_at: string;
        timezone: string;
        title?: string;
        idempotency_key: string;
      };
      // In one order for every bundle, so two over the same resources wait on each other in turn
      // and never deadlock.
      const resourceIds = [...new Set(input.resource_ids)].sort();
      if (resourceIds.length < 2) throw new SlotlockAgentOperationError('invalid_arguments', 400);
      const content: CalendarEventContent = {
        start: new Date(input.starts_at),
        end: new Date(input.ends_at),
        timezone: input.timezone,
        summary: eventSummary(input.title),
        status: 'confirmed',
        transparency: 'opaque',
        attendees: [],
        reminders: [],
      };
      return withTenant(store, context, async (tenantStore) => {
        for (const resourceId of resourceIds) {
          try {
            await requireAgentResource(tenantStore, context.principal.tenantRef, resourceId);
          } catch (error) {
            if (!(error instanceof SlotlockAgentOperationError)) throw error;
            throw new SlotlockAgentOperationError(error.code, error.status, { resource_id: resourceId });
          }
        }
        const events: Record<string, unknown>[] = [];
        let replayed = true;
        for (const resourceId of resourceIds) {
          const key = `${input.idempotency_key}\0${resourceId}`;
          const result = await tenantStore.putCalendarEvent({
            tenantRef: context.principal.tenantRef,
            ownerRef: agentOwnerRef(context),
            externalRef: agentExternalRef(context, key),
            resourceId,
            expectedRevision: 0,
            idempotencyKey: agentCommandIdempotencyKey(context, key),
            source: 'agent-server',
            ...content,
            materializationWindow: materializationWindow(content),
            enforceBookingRules: true,
          });
          // Thrown, so the whole transaction rolls back: the events already put go with it.
          if (!result.ok) {
            const refusal = operationError(result);
            throw new SlotlockAgentOperationError(refusal.code, refusal.status, { resource_id: resourceId });
          }
          const created = await tenantStore.getCalendarEvent({
            tenantRef: context.principal.tenantRef,
            ownerRef: agentOwnerRef(context),
            externalRef: result.externalRef,
          });
          if (!created) throw new SlotlockAgentOperationError('store_inconsistent', 503);
          events.push(projectSlotlockCalendarEvent(created));
          replayed &&= result.idempotent;
        }
        return { events, replayed };
      }, WRITE);
    },

    async releaseSlots(context, input) {
      const id = input.hold_id as string;
      if (!STORE_ID_PATTERN.test(id)) return { released: false };
      return withTenant(store, context, async (tenantStore) =>
        tenantStore.releaseHold(id, {
          tenantRef: context.principal.tenantRef,
          holderRef: agentOwnerRef(context),
        }).then(({ released }) => ({ released })),
      );
    },

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
      const output = (resource: SlotlockResource) => ({
        id: resource.id,
        external_ref: resource.externalRef,
        timezone: resource.timezone,
        ...(resource.pool !== undefined ? { pool: resource.pool } : {}),
      });
      if (typeof input.pool === 'string') {
        // A pool's members, in the order a pool booking tries them; at most 100, one page.
        return withTenant(store, context, async (tenantStore) => ({
          resources: (
            await tenantStore.listPoolMembers({
              tenantRef: context.principal.tenantRef,
              pool: input.pool as string,
              visibility: 'shared',
            })
          ).map(output),
          next_cursor: null,
        }));
      }
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
          resources: page.map(output),
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
      let windowsLeft = MAX_REQUEST_RULE_WINDOWS;
      return withTenant(store, context, async (tenantStore) => {
        let best: { resourceId: string; interval: Interval } | null = null;
        let incomplete = false;
        for (const resourceId of resourceIds) {
          const resource = await requireAgentResource(
            tenantStore,
            context.principal.tenantRef,
            resourceId,
          );
          // Only what a booking made now may take: the resource's booking rules bound the search,
          // as they bound the write that follows it.
          const search = bookingSearch({
            rules: resource.bookingRules,
            timezone: resource.timezone,
            window,
            now: new Date(),
          });
          const sources = await requiredSources(options, context, resource);
          const freeBusy = await readFreeBusy(tenantStore, {
            tenantRef: context.principal.tenantRef,
            resourceId,
            // A slot's turnaround may run past the window: what it reaches must be free too.
            window: {
              start: window.start,
              end: new Date(window.end.getTime() + (search?.bufferAfterMs ?? 0)),
            },
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
          if (!search) continue;
          const rules =
            resource.availabilityRules ?? (await options.availabilityRules(context, resource));
          const windows = expandRules(rules, search.window, resource.timezone);
          windowsLeft -= windows.length;
          if (windowsLeft < 0) throw new SlotlockAgentOperationError('calendar_work_limit', 400);
          // A slot [s, s + d) with its turnaround meets busy [b, e) when [s, s + d) meets [b - t, e).
          const candidate = findNextAvailable({
            busy: freeBusy.busy.map((busy) => ({
              start: new Date(busy.start.getTime() - search.bufferAfterMs),
              end: busy.end,
            })),
            windows,
            durationMs,
            ...(search.align ? { align: search.align } : {}),
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
          // An agent's event is a booking made now: the resource's booking rules apply.
          enforceBookingRules: true,
          // Booking a held time: only this agent's hold, which gives way in the same transaction.
          ...(typeof input.hold_id === 'string'
            ? { fromHold: { holdId: input.hold_id, holderRef: agentOwnerRef(context) } }
            : {}),
        });
        if (!result.ok) throw operationError(result);
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
          // An agent's event is a booking made now: the resource's booking rules apply.
          enforceBookingRules: true,
        });
        if (!result.ok) throw operationError(result);
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
        if (!result.ok) throw operationError(result);
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

function waitlistOutput(entry: SlotlockWaitlistEntry) {
  return {
    id: entry.id,
    resource_id: entry.resourceId,
    pool: entry.pool,
    start: entry.start.toISOString(),
    end: entry.end.toISOString(),
    holder_ref: entry.holderRef,
    offer_ttl_seconds: Math.round(entry.offerTtlMs / 1000),
    status: entry.status,
    hold_id: entry.holdId,
    offered_resource_id: entry.offeredResourceId,
    offered_at: entry.offeredAt?.toISOString() ?? null,
    created_at: entry.createdAt.toISOString(),
  };
}

/**
 * Offer what a cancel or release just freed to the tenant's waitlist now, rather than at the next
 * maintenance pass. Best effort, after the freeing transaction committed: maintenance offers
 * whatever this misses.
 */
async function offerFreedTime(store: SlotlockStore, tenantRef: string): Promise<void> {
  try {
    await store.withTenant(tenantRef, (tenant) => tenant.offerWaitlist({ tenantRef, limit: 20 }));
  } catch {
    // Left to maintenance.
  }
}

function webhookOutput(endpoint: SlotlockWebhookEndpoint) {
  return {
    id: endpoint.id,
    url: endpoint.url,
    event_types: endpoint.eventTypes,
    created_at: endpoint.createdAt.toISOString(),
    attempts: endpoint.attempts,
    failing_since: endpoint.failingSince?.toISOString() ?? null,
    last_status: endpoint.lastStatus,
    last_error: endpoint.lastError,
    disabled_at: endpoint.disabledAt?.toISOString() ?? null,
    disabled_reason: endpoint.disabledReason as 'gone' | 'failing' | null,
  };
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

/** Booking rules as the application API writes them, snake_case; `null` for none. */
function bookingRulesOutput(rules: SlotlockBookingRules | undefined) {
  if (!rules) return null;
  return {
    ...(rules.minNoticeMinutes !== undefined ? { min_notice_minutes: rules.minNoticeMinutes } : {}),
    ...(rules.maxAdvanceDays !== undefined ? { max_advance_days: rules.maxAdvanceDays } : {}),
    ...(rules.slotStepMinutes !== undefined ? { slot_step_minutes: rules.slotStepMinutes } : {}),
    ...(rules.turnaroundMinutes !== undefined ? { turnaround_minutes: rules.turnaroundMinutes } : {}),
    ...(rules.enforceHours !== undefined ? { enforce_hours: rules.enforceHours } : {}),
    ...(rules.checkInMinutes !== undefined ? { check_in_minutes: rules.checkInMinutes } : {}),
  };
}

function bookingRulesInput(value: unknown): SlotlockBookingRules | null {
  if (value === null || value === undefined) return null;
  const input = value as Record<string, unknown>;
  const rules: SlotlockBookingRules = {};
  if (input.min_notice_minutes !== undefined) rules.minNoticeMinutes = input.min_notice_minutes as number;
  if (input.max_advance_days !== undefined) rules.maxAdvanceDays = input.max_advance_days as number;
  if (input.slot_step_minutes !== undefined) rules.slotStepMinutes = input.slot_step_minutes as number;
  if (input.turnaround_minutes !== undefined) rules.turnaroundMinutes = input.turnaround_minutes as number;
  if (input.enforce_hours !== undefined) rules.enforceHours = input.enforce_hours as boolean;
  if (input.check_in_minutes !== undefined) rules.checkInMinutes = input.check_in_minutes as number;
  return rules;
}

function resourceOutput(resource: SlotlockResource) {
  return {
    id: resource.id,
    external_ref: resource.externalRef,
    timezone: resource.timezone,
    availability: rulesOutput(resource.availabilityRules),
    booking_rules: bookingRulesOutput(resource.bookingRules),
    visibility: resource.visibility ?? 'shared',
    archived_at: resource.archivedAt?.toISOString() ?? null,
    pool: resource.pool ?? null,
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

  async function history(context: SlotlockApplicationInvocationContext, input: Record<string, unknown>) {
    const page = {
      tenantRef: tenantOf(context),
      limit: input.limit as number,
      ...(input.before !== undefined ? { before: input.before as string } : {}),
    };
    return withTenant(store, context, async (tenant) => {
      let entries;
      if (typeof input.resource_id === 'string') {
        await requireResource(tenant, tenantOf(context), input.resource_id);
        entries = await tenant.listHistory({ ...page, resourceId: input.resource_id });
      } else {
        const subject = (input.reservation_ref ?? input.event_id) as string;
        entries = await tenant.listHistory({ ...page, subject });
      }
      const limit = input.limit as number;
      return {
        history: entries.map((entry) => ({
          id: entry.id,
          type: entry.type,
          time: entry.occurredAt.toISOString(),
          actor: entry.actor,
          data: entry.data,
        })),
        next_before: entries.length === limit ? (entries.at(-1)?.id ?? null) : null,
      };
    });
  }

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
        // One row past the cap is enough to refuse: the rest is never read.
        const busy = await tenant.listBusy(resource.id, interval(input as { start: string; end: string }), {
          tenantRef: tenantOf(context),
          limit: MAX_LISTED_BUSY + 1,
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

    async exportResourceAvailability(context, input) {
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        if (resource.availabilityRules === undefined) return { icalendar: null };
        return {
          icalendar: emitVAvailability({
            rules: resource.availabilityRules,
            timezone: resource.timezone,
            uid: `${resource.id}-hours`,
          }),
        };
      });
    },

    async importResourceAvailability(context, input) {
      let parsed: ReturnType<typeof parseVAvailability>;
      try {
        parsed = parseVAvailability(input.icalendar as string);
      } catch (error) {
        throw storeRefusal(error);
      }
      const id = input.resource_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('resource_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        const current = await requireResource(tenant, tenantOf(context), id);
        // Rules are read in the resource's zone: times written in another would land elsewhere.
        if (parsed.timezone !== null && parsed.timezone !== current.timezone) {
          throw new SlotlockAgentOperationError('invalid_availability', 400, {
            timezone: parsed.timezone,
            resource_timezone: current.timezone,
          });
        }
        let resource: SlotlockResource | null;
        try {
          resource = await tenant.setResourceAvailability({
            tenantRef: tenantOf(context),
            id,
            rules: parsed.rules,
          });
        } catch (error) {
          throw storeRefusal(error);
        }
        if (!resource) throw new SlotlockAgentOperationError('resource_not_found', 404);
        return { resource: resourceOutput(resource) };
      });
    },

    async setResourceBookingRules(context, input) {
      const rules = bookingRulesInput(input.rules);
      const id = input.resource_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('resource_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        let resource: SlotlockResource | null;
        try {
          resource = await tenant.setResourceBookingRules({ tenantRef: tenantOf(context), id, rules });
        } catch (error) {
          throw storeRefusal(error);
        }
        if (!resource) throw new SlotlockAgentOperationError('resource_not_found', 404);
        return { resource: resourceOutput(resource) };
      });
    },

    async setResourcePool(context, input) {
      const id = input.resource_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('resource_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        let resource: SlotlockResource | null;
        try {
          resource = await tenant.setResourcePool({ tenantRef: tenantOf(context), id, pool: input.pool as string | null });
        } catch (error) {
          throw storeRefusal(error);
        }
        if (!resource) throw new SlotlockAgentOperationError('resource_not_found', 404);
        return { resource: resourceOutput(resource) };
      }, WRITE);
    },

    async getResourceHistory(context, input) {
      return history(context, input);
    },

    async getReservationHistory(context, input) {
      return history(context, input);
    },

    async getTenantEventHistory(context, input) {
      return history(context, input);
    },

    async listPools(context) {
      return withTenant(store, context, async (tenant) => ({
        pools: await tenant.listPools({ tenantRef: tenantOf(context) }),
      }));
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
      const released = await withTenant(store, context, async (tenant) => ({
        released: (await tenant.releaseHold(id, { tenantRef: tenantOf(context) })).released,
      }));
      if (released.released) await offerFreedTime(store, tenantOf(context));
      return released;
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
      const cancelled = await withTenant(store, context, async (tenant) => {
        const result = await tenant.cancelExternalReservation({
          tenantRef: tenantOf(context),
          externalRef: input.reservation_ref as string,
          revision: input.revision as number,
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { cancelled: result.cancelled, revision: result.revision };
      }, WRITE);
      if (cancelled.cancelled) await offerFreedTime(store, tenantOf(context));
      return cancelled;
    },

    async checkInReservation(context, input) {
      return withTenant(store, context, async (tenant) => {
        const result = await tenant.checkInReservation({
          tenantRef: tenantOf(context),
          externalRef: input.reservation_ref as string,
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { reference: result.reference, checked_in_at: result.checkedInAt.toISOString() };
      });
    },

    async joinWaitlist(context, input) {
      const ttl = input.offer_ttl_seconds as number | undefined;
      return withTenant(store, context, async (tenant) => {
        const result = await tenant.joinWaitlist({
          tenantRef: tenantOf(context),
          ...(input.resource_id !== undefined ? { resourceId: input.resource_id as string } : {}),
          ...(input.pool !== undefined ? { pool: input.pool as string } : {}),
          start: new Date(input.start as string),
          end: new Date(input.end as string),
          holderRef: input.holder_ref as string,
          ...(ttl !== undefined ? { offerTtlMs: ttl * 1000 } : {}),
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { entry: waitlistOutput(result.entry) };
      });
    },

    async listWaitlist(context, input) {
      return withTenant(store, context, async (tenant) => ({
        entries: (
          await tenant.listWaitlist({
            tenantRef: tenantOf(context),
            limit: input.limit as number,
            ...(input.resource_id !== undefined ? { resourceId: input.resource_id as string } : {}),
            ...(input.pool !== undefined ? { pool: input.pool as string } : {}),
            ...(input.holder_ref !== undefined ? { holderRef: input.holder_ref as string } : {}),
          })
        ).map(waitlistOutput),
      }));
    },

    async leaveWaitlist(context, input) {
      const left = await withTenant(store, context, async (tenant) => ({
        left: await tenant.leaveWaitlist({ tenantRef: tenantOf(context), id: input.entry_id as string }),
      }));
      if (left.left) await offerFreedTime(store, tenantOf(context));
      return left;
    },

    async getCoverage(context, input) {
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const sources = await tenant.listCoverage({ tenantRef: tenantOf(context), resourceId: resource.id });
        return {
          sources: sources.map((source) => ({
            source: source.source,
            start: source.start.toISOString(),
            end: source.end.toISOString(),
            revision: source.revision,
            observed_at: source.observedAt.toISOString(),
            last_error: source.lastError,
            last_error_at: source.lastErrorAt?.toISOString() ?? null,
            stale: source.stale,
          })),
        };
      });
    },

    async recordCoverageFailure(context, input) {
      return withTenant(store, context, async (tenant) => {
        const resource = await requireResource(tenant, tenantOf(context), input.resource_id as string);
        const result = await tenant.recordCoverageFailure({
          tenantRef: tenantOf(context),
          resourceId: resource.id,
          source: input.source as string,
          error: input.error as string,
        });
        if (!result.ok) throw applicationRefusal(result.code);
        return { recorded: true };
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

    async exportTenantEvent(context, input) {
      const id = input.event_id as string;
      if (!STORE_ID_PATTERN.test(id)) throw new SlotlockAgentOperationError('event_not_found', 404);
      return withTenant(store, context, async (tenant) => {
        const event = await tenant.getCalendarEventById({ tenantRef: tenantOf(context), eventId: id });
        if (!event) throw new SlotlockAgentOperationError('event_not_found', 404);
        return { event: toJSCalendarEvent(event) };
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
      const cancelled = await withTenant(store, context, async (tenant) => {
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
      if (!cancelled.replayed) await offerFreedTime(store, tenantOf(context));
      return cancelled;
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

    async listChanges(context, input) {
      return withTenant(store, context, async (tenant) => {
        const page = await tenant.listChanges({
          tenantRef: tenantOf(context),
          limit: input.limit as number,
          ...(input.cursor !== undefined ? { after: input.cursor as string } : {}),
        });
        if (!page.ok) {
          throw new SlotlockAgentOperationError(page.code, page.code === 'cursor_expired' ? 410 : 400);
        }
        return { changes: page.changes.map(slotlockCloudEvent), next_cursor: page.next };
      });
    },

    async createWebhook(context, input) {
      return withTenant(store, context, async (tenant) => {
        const created = await tenant.createWebhookEndpoint({
          tenantRef: tenantOf(context),
          url: input.url as string,
          ...(input.event_types !== undefined ? { eventTypes: input.event_types as string[] } : {}),
        });
        if (!created.ok) {
          throw new SlotlockAgentOperationError(
            created.code,
            created.code === 'webhook_limit_reached' ? 409 : 400,
          );
        }
        return { webhook: webhookOutput(created.endpoint), secret: created.secret };
      }, WRITE);
    },

    async listWebhooks(context) {
      return withTenant(store, context, async (tenant) => ({
        webhooks: (await tenant.listWebhookEndpoints({ tenantRef: tenantOf(context) })).map(webhookOutput),
      }));
    },

    async deleteWebhook(context, input) {
      return withTenant(store, context, async (tenant) =>
        tenant.deleteWebhookEndpoint({ tenantRef: tenantOf(context), id: input.webhook_id as string }),
      WRITE);
    },

    async enableWebhook(context, input) {
      return withTenant(store, context, async (tenant) => {
        const enabled = await tenant.enableWebhookEndpoint({
          tenantRef: tenantOf(context),
          id: input.webhook_id as string,
        });
        if (!enabled) throw new SlotlockAgentOperationError('webhook_not_found', 404);
        if ('code' in enabled) throw new SlotlockAgentOperationError(enabled.code, 409);
        return { webhook: webhookOutput(enabled) };
      }, WRITE);
    },

    async runMaintenance(context) {
      assertActive(context);
      try {
        // A caller goes round again while `capped`; when to do so at once is the scheduler's.
        const { rollPending: _, zoneShifts, staleSources, noShows, waitlistOffers, ...result } = await maintainSlotlockTenant(store, tenantOf(context), {
          batches,
          signal: context.signal,
        });
        return {
          ...result,
          zone_shifts: zoneShifts,
          stale_sources: staleSources,
          no_shows: noShows,
          waitlist_offers: waitlistOffers,
        };
      } catch (error) {
        if (context.signal.aborted) throw new SlotlockAgentOperationError('request_aborted', 503);
        throw error;
      }
    },
  };
}
